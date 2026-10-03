import { z } from "zod";
import { loadYamlConfig } from "../../config/files.js";
import type { Db } from "../../db/client.js";
import { setFailed, setResearchOutcome, upsertCompany, type Company } from "../../db/companies.js";
import { insertPlacesSnapshot } from "../../db/placesSnapshots.js";
import {
  createSearchRun,
  finishSearchRun,
  getSearchRun,
  updateSearchRunStats,
  type SearchRun,
} from "../../db/searchRuns.js";
import { recordApiUsage } from "../../db/apiUsage.js";
import { BudgetExceededError, type BudgetGuard } from "../../llm/budget.js";
import { LlmError } from "../../llm/gateway.js";
import type { Branches } from "./branches.js";
import { chainNames, resolveBranch } from "./branches.js";
import { evaluateGate, type GateRules } from "./gate.js";
import { MAX_PAGES, placeToCandidate, regionProbe, type Place, type PlacesClient } from "./places.js";
import type { Prefilter } from "./prefilter.js";
import { computeRecheckAfter, shouldReprocess, type RecheckRules } from "./recheck.js";
import { mapLimit } from "../../util/mapLimit.js";
import { coverageRows, upsertCoverage } from "../../db/coverage.js";
import { coverageSubject, tileState, type TileStatusInput } from "./coverage.js";
import { PAGE_SIZE } from "./places.js";
import {
  isInRegion,
  MAX_SPLIT_DEPTH,
  splitQuery,
  tileQueries,
  type Region,
  type TileQuery,
} from "./tiling.js";

/**
 * Recherche-Lauf (ARCHITECTURE.md 5.2 Schritte 2–6): Places-Suche Kachel für Kachel → Dubletten-Abgleich
 * → Gate (Code) → Prefilter (LLM). Das Gate läuft vor dem Prefilter, weil es nichts kostet und dasselbe
 * aussortiert (11.1: "Objektives Gate vor jedem teuren Call").
 *
 * Bis die Queue kommt (Schritt 7), läuft alles in einem Prozess; jede Firma wird aber schon einzeln und
 * idempotent verarbeitet, sodass daraus später ein Job je Firma × Schritt wird.
 */

export const researchConfigSchema = z.object({
  oversearch_factor: z.number().min(1).max(10),
  max_places_requests: z.number().int().positive(),
  places_cost_per_request_usd: z.number().min(0),
  prefilter_concurrency: z.number().int().positive().max(16),
  /** Komplett-Suche ("alle …"): eigene, höhere Kostenbremse, weil jeder Ort ganz abgesucht wird. */
  max_places_requests_complete: z.number().int().positive(),
  /** So lange gilt ein abgesuchter Ort als aktuell; danach zählt er wieder als offen. */
  coverage_valid_days: z.number().int().positive(),
});

export type ResearchConfig = z.infer<typeof researchConfigSchema>;

export function loadResearchConfig(): ResearchConfig {
  return loadYamlConfig("research.yaml", researchConfigSchema);
}

export interface ResearchDeps {
  db: Db;
  places: PlacesClient;
  prefilter: Prefilter;
  branches: Branches;
  gate: GateRules;
  recheck: RecheckRules;
  config: ResearchConfig;
  /** Wird vor jeder Places-Anfrage geprüft; der Prefilter prüft über das LLM-Gateway selbst. */
  budget: BudgetGuard;
  /** Wird für jede Firma aufgerufen, die Gate und Prefilter bestanden hat (Queue: nächsten Job anlegen). */
  onPassed?: (company: Company) => Promise<void>;
  now?: () => Date;
  onProgress?: (message: string) => void;
}

export interface ResearchRequest {
  term: string;
  region: Region;
  /** Gewünschte Zahl an Leads; gesucht wird bis Ziel × oversearch_factor Firmen Gate und Prefilter bestehen. */
  target: number;
  requestedBy: string;
  /** Bestehenden Lauf fortsetzen (Queue nach Neustart), statt einen neuen anzulegen. */
  searchRunId?: string;
  /**
   * Komplett-Suche: jeden Ort ganz absuchen (keine Zielzahl), bereits vollständig abgesuchte Orte überspringen,
   * volle Gebiete (60 Treffer) in Teilgebiete teilen.
   */
  complete?: boolean;
  /**
   * `true` (Standard, CLI): Lauf am Ende abschließen. `false` (Queue): nur Statistik schreiben; abgeschlossen
   * wird der Lauf, wenn alle Folge-Jobs fertig sind.
   */
  finish?: boolean;
}

export type StopReason = "goal_reached" | "tiles_exhausted" | "request_limit" | "budget_exceeded";

export interface ResearchStats {
  goal: number;
  /** Komplett-Suche (siehe ResearchRequest.complete). */
  complete: boolean;
  /** Lauf schreibt seine Orte in search_coverage (ältere Läufe nicht). */
  coverage: true;
  tiles_total: number;
  tiles_searched: number;
  /** Komplett-Suche: Orte bzw. Teilgebiete, die schon vollständig abgesucht waren. */
  tiles_skipped: number;
  /** Teilgebiete, die wegen voller Orte (60 Treffer) zusätzlich abgesucht wurden. */
  subtiles_searched: number;
  /** Orte bzw. Teilgebiete, in denen Google das Maximum geliefert hat. */
  tiles_saturated: number;
  places_requests: number;
  places_cost_usd: number;
  results: number;
  invalid_results: number;
  out_of_region: number;
  duplicates_in_run: number;
  new_companies: number;
  known_companies: number;
  known_not_due: number;
  gate_skipped: Record<string, number>;
  prefilter_skipped: Record<string, number>;
  prefilter_errors: number;
  llm_cost_usd: number;
  passed: number;
  stopped_because: StopReason | null;
  /** Recherche fertig (Folge-Jobs können noch laufen). */
  research_done?: boolean;
  error?: string;
}

export interface ResearchResult {
  run: SearchRun;
  stats: ResearchStats;
  /** Firmen, die in diesem Lauf Gate und Prefilter bestanden haben (Status RESEARCHED). */
  passed: Company[];
}

type PlaceOutcome =
  | { kind: "duplicate" }
  | { kind: "not_due" }
  | { kind: "gate_skipped"; reason: string }
  | { kind: "prefilter_skipped"; reason: string; costUsd: number }
  | { kind: "prefilter_error" }
  | { kind: "budget_exceeded"; error: BudgetExceededError }
  | { kind: "passed"; company: Company; costUsd: number };

const increment = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const roundUsd = (n: number) => Math.round(n * 100_000) / 100_000;

export async function runResearch(deps: ResearchDeps, req: ResearchRequest): Promise<ResearchResult> {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const progress = deps.onProgress ?? (() => undefined);
  if (!Number.isInteger(req.target) || req.target < 1)
    throw new Error("Ziel muss eine positive ganze Zahl sein");

  const branch = resolveBranch(deps.branches, req.term);
  const chains = chainNames(deps.branches);
  const queries = tileQueries(req.region, req.term);
  const goal = Math.ceil(req.target * config.oversearch_factor);
  const complete = req.complete ?? false;
  const subject = coverageSubject(req.term, deps.branches);
  const requestLimit = complete ? config.max_places_requests_complete : config.max_places_requests;

  const existing = req.searchRunId ? await getSearchRun(db, req.searchRunId) : null;
  if (req.searchRunId && !existing) throw new Error(`Suchlauf ${req.searchRunId} nicht gefunden`);
  const run =
    existing ??
    (await createSearchRun(db, {
      requestedBy: req.requestedBy,
      query: { term: req.term, region: req.region.key, branch_key: branch?.key ?? null, complete },
      targetCount: req.target,
    }));
  const finish = req.finish ?? true;

  const stats: ResearchStats = {
    goal,
    complete,
    coverage: true,
    tiles_total: queries.length,
    tiles_searched: 0,
    tiles_skipped: 0,
    subtiles_searched: 0,
    tiles_saturated: 0,
    places_requests: 0,
    places_cost_usd: 0,
    results: 0,
    invalid_results: 0,
    out_of_region: 0,
    duplicates_in_run: 0,
    new_companies: 0,
    known_companies: 0,
    known_not_due: 0,
    gate_skipped: {},
    prefilter_skipped: {},
    prefilter_errors: 0,
    llm_cost_usd: 0,
    passed: 0,
    stopped_because: null,
  };
  if (existing) {
    // Wiederaufnahme: Was vor dem Abbruch schon bestanden hat, zählt weiter.
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from companies
        where first_search_run_id = $1 and status in ('RESEARCHED', 'AUDITED', 'QUALIFIED')`,
      [run.id],
    );
    stats.passed = rows[0]!.n;
  }
  const passed: Company[] = [];
  const seenPlaces = new Set<string>();
  const seenCompanies = new Set<string>();

  async function processPlace(place: Place): Promise<PlaceOutcome> {
    const { company, created } = await upsertCompany(db, placeToCandidate(place, req.region.name, run.id));
    // Zwei Google-Einträge derselben Firma (z. B. gleiche Domain) nur einmal verarbeiten.
    if (seenCompanies.has(company.id)) return { kind: "duplicate" };
    seenCompanies.add(company.id);
    // In diesem Lauf vor einem Abbruch schon verarbeitet.
    if (!created && company.first_search_run_id === run.id && company.status !== "NEW")
      return { kind: "duplicate" };

    await insertPlacesSnapshot(db, {
      companyId: company.id,
      rating: place.rating ?? null,
      reviewCount: place.userRatingCount ?? null,
      businessStatus: place.businessStatus ?? null,
      photoCount: place.photos?.length ?? null,
      raw: place,
    });

    if (created) stats.new_companies++;
    else stats.known_companies++;
    // NEW bei einer bekannten Firma heißt: ein früherer Lauf wurde unterbrochen → jetzt fertig verarbeiten.
    if (!created && company.status !== "NEW" && !shouldReprocess(company, now()).reprocess) {
      return { kind: "not_due" };
    }

    const gate = evaluateGate(
      {
        name: company.name,
        businessStatus: place.businessStatus ?? null,
        rating: place.rating ?? null,
        reviewCount: place.userRatingCount ?? null,
      },
      deps.gate,
      chains,
    );
    if (!gate.pass) {
      await setResearchOutcome(
        db,
        company.id,
        { status: "SKIPPED", skipReason: gate.reason, skipDetail: gate.detail },
        computeRecheckAfter(deps.recheck, "SKIPPED", gate.reason, now()),
      );
      return { kind: "gate_skipped", reason: gate.reason };
    }

    let decision;
    try {
      decision = await deps.prefilter(
        place,
        { term: req.term, branch, branches: deps.branches },
        {
          companyId: company.id,
          searchRunId: run.id,
        },
      );
    } catch (err) {
      // Endzustand FAILED (ARCHITECTURE.md 18, Kriterium 2); erneuter Versuch nach recheck.failed Tagen.
      if (err instanceof LlmError) {
        await setFailed(
          db,
          company.id,
          `Vorfilter: ${err.message.slice(0, 200)}`,
          computeRecheckAfter(deps.recheck, "FAILED", null, now()),
        );
        return { kind: "prefilter_error" };
      }
      if (err instanceof BudgetExceededError) return { kind: "budget_exceeded", error: err };
      throw err;
    }
    if (!decision.pass) {
      await setResearchOutcome(
        db,
        company.id,
        {
          status: "SKIPPED",
          skipReason: decision.reason,
          skipDetail: decision.detail,
          branchKey: decision.branchKey,
        },
        computeRecheckAfter(deps.recheck, "SKIPPED", decision.reason, now()),
      );
      return { kind: "prefilter_skipped", reason: decision.reason, costUsd: decision.costUsd };
    }
    const updated = await setResearchOutcome(
      db,
      company.id,
      { status: "RESEARCHED", branchKey: decision.branchKey ?? branch?.key ?? null },
      null,
    );
    await deps.onPassed?.(updated);
    return { kind: "passed", company: updated, costUsd: decision.costUsd };
  }

  function record(outcome: PlaceOutcome) {
    switch (outcome.kind) {
      case "duplicate":
        stats.duplicates_in_run++;
        break;
      case "not_due":
        stats.known_not_due++;
        break;
      case "gate_skipped":
        increment(stats.gate_skipped, outcome.reason);
        break;
      case "prefilter_skipped":
        increment(stats.prefilter_skipped, outcome.reason);
        stats.llm_cost_usd = roundUsd(stats.llm_cost_usd + outcome.costUsd);
        break;
      case "prefilter_error":
        stats.prefilter_errors++;
        break;
      case "budget_exceeded":
        // Firma bleibt NEW und wird beim nächsten Lauf fertig geprüft.
        halt.budget = outcome.error;
        break;
      case "passed":
        stats.passed++;
        stats.llm_cost_usd = roundUsd(stats.llm_cost_usd + outcome.costUsd);
        passed.push(outcome.company);
        break;
    }
  }

  // Objekt statt let: wird in record() gesetzt, TypeScript würde eine Variable hier fälschlich auf null festlegen.
  const halt: { budget: BudgetExceededError | null } = { budget: null };

  // Bisherige Abdeckung (nur Komplett-Suche): vollständig abgesuchte Orte werden übersprungen.
  const rows = new Map<string, { saturated: boolean; searched_at: Date }>();
  if (complete) {
    for (const r of await coverageRows(db, req.region.key, subject)) rows.set(r.tile_key, r);
  }
  const coverage: TileStatusInput = {
    rows,
    legacy: new Set(),
    now: now(),
    validDays: config.coverage_valid_days,
  };
  const isFresh = (key: string) => {
    const r = rows.get(key);
    return (
      r !== undefined && now().getTime() - r.searched_at.getTime() <= config.coverage_valid_days * 86_400_000
    );
  };

  try {
    const pending: TileQuery[] = [...queries];
    tiles: while (pending.length > 0) {
      const query = pending.shift()!;
      if (complete) {
        if (tileState(query, coverage) === "done") {
          stats.tiles_skipped++;
          continue;
        }
        // Voller Ort, schon abgesucht: nur die noch fehlenden Teilgebiete.
        if (isFresh(query.key) && rows.get(query.key)!.saturated && query.depth < MAX_SPLIT_DEPTH) {
          pending.unshift(...splitQuery(query, req.term));
          continue;
        }
      }
      if (query.depth === 0) stats.tiles_searched++;
      else stats.subtiles_searched++;
      let pageToken: string | undefined;
      let tileResults = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        if (stats.places_requests >= requestLimit) {
          stats.stopped_because = "request_limit";
          break tiles;
        }
        await deps.budget.assertAvailable();
        const result = await deps.places.searchText(query, pageToken);
        stats.places_requests++;
        stats.places_cost_usd = roundUsd(stats.places_requests * config.places_cost_per_request_usd);
        await recordApiUsage(db, {
          service: "places",
          operation: "searchText",
          costUsd: config.places_cost_per_request_usd,
          searchRunId: run.id,
        });
        stats.results += result.places.length;
        stats.invalid_results += result.invalid;
        tileResults += result.places.length + result.invalid;

        const fresh = result.places.filter((p) => {
          if (seenPlaces.has(p.id)) {
            stats.duplicates_in_run++;
            return false;
          }
          seenPlaces.add(p.id);
          if (!isInRegion(req.region, regionProbe(p))) {
            stats.out_of_region++;
            return false;
          }
          return true;
        });
        for (const outcome of await mapLimit(fresh, config.prefilter_concurrency, processPlace))
          record(outcome);
        if (halt.budget) {
          await updateSearchRunStats(db, run.id, stats);
          throw halt.budget;
        }

        // Ort fertig: alle Seiten geholt. Gesättigt, wenn Google das Maximum (3 × 20) geliefert hat.
        const lastPage = !result.nextPageToken || page === MAX_PAGES - 1;
        if (lastPage) {
          const saturated = tileResults >= MAX_PAGES * PAGE_SIZE;
          if (saturated) stats.tiles_saturated++;
          const searchedAt = now();
          await upsertCoverage(db, {
            regionKey: req.region.key,
            subject,
            tileKey: query.key,
            searchRunId: run.id,
            results: tileResults,
            pages: page + 1,
            saturated,
            searchedAt,
          });
          rows.set(query.key, { saturated, searched_at: searchedAt });
          if (complete && saturated && query.depth < MAX_SPLIT_DEPTH) {
            pending.unshift(...splitQuery(query, req.term));
          }
        }
        await updateSearchRunStats(db, run.id, stats);
        progress(
          `${query.key} (Seite ${page + 1}): ${result.places.length} Treffer, ` +
            (complete ? `${stats.passed} bestanden` : `${stats.passed}/${goal} bestanden`),
        );

        if (!complete && stats.passed >= goal) {
          stats.stopped_because = "goal_reached";
          break tiles;
        }
        if (lastPage) break;
        pageToken = result.nextPageToken!;
      }
    }
    stats.stopped_because ??= "tiles_exhausted";
    stats.research_done = true;
    if (finish) await finishSearchRun(db, run.id, "COMPLETED", stats);
    else await updateSearchRunStats(db, run.id, stats);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // Kein Fehler des Laufs: sauber anhalten, Ergebnisse bis hierhin bleiben gültig.
      stats.stopped_because = "budget_exceeded";
      stats.error = err.message;
      if (finish) await finishSearchRun(db, run.id, "COMPLETED", stats);
      else await updateSearchRunStats(db, run.id, stats);
      return { run: { ...run, status: "COMPLETED", stats: { ...stats } }, stats, passed };
    }
    stats.error = err instanceof Error ? err.message : String(err);
    // Queue: Der Job wird wiederholt; als FAILED markiert erst der letzte Versuch (src/queue/workers.ts).
    if (finish) await finishSearchRun(db, run.id, "FAILED", stats);
    else await updateSearchRunStats(db, run.id, stats);
    throw err;
  }

  return { run: { ...run, status: "COMPLETED", stats: { ...stats } }, stats, passed };
}
