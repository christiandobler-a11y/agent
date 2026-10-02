import { z } from "zod";
import { loadYamlConfig } from "../../config/files.js";
import type { Db } from "../../db/client.js";
import { setResearchOutcome, upsertCompany, type Company } from "../../db/companies.js";
import { insertPlacesSnapshot } from "../../db/placesSnapshots.js";
import {
  createSearchRun,
  finishSearchRun,
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
import { isInRegion, tileQueries, type Region } from "./tiling.js";

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
  now?: () => Date;
  onProgress?: (message: string) => void;
}

export interface ResearchRequest {
  term: string;
  region: Region;
  /** Gewünschte Zahl an Leads; gesucht wird bis Ziel × oversearch_factor Firmen Gate und Prefilter bestehen. */
  target: number;
  requestedBy: string;
}

export type StopReason = "goal_reached" | "tiles_exhausted" | "request_limit" | "budget_exceeded";

export interface ResearchStats {
  goal: number;
  tiles_total: number;
  tiles_searched: number;
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

/** Verarbeitet Elemente mit begrenzter Parallelität, Ergebnisse in Eingabe-Reihenfolge. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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

  const run = await createSearchRun(db, {
    requestedBy: req.requestedBy,
    query: { term: req.term, region: req.region.key, branch_key: branch?.key ?? null },
    targetCount: req.target,
  });

  const stats: ResearchStats = {
    goal,
    tiles_total: queries.length,
    tiles_searched: 0,
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
  const passed: Company[] = [];
  const seenPlaces = new Set<string>();
  const seenCompanies = new Set<string>();

  async function processPlace(place: Place): Promise<PlaceOutcome> {
    const { company, created } = await upsertCompany(db, placeToCandidate(place, req.region.name, run.id));
    // Zwei Google-Einträge derselben Firma (z. B. gleiche Domain) nur einmal verarbeiten.
    if (seenCompanies.has(company.id)) return { kind: "duplicate" };
    seenCompanies.add(company.id);

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
      // Firma bleibt NEW und wird beim nächsten Lauf erneut geprüft; der Fehler steht in agent_runs.
      if (err instanceof LlmError) return { kind: "prefilter_error" };
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

  try {
    tiles: for (const query of queries) {
      stats.tiles_searched++;
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        if (stats.places_requests >= config.max_places_requests) {
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
        await updateSearchRunStats(db, run.id, stats);
        progress(
          `${query.tile.name} (Seite ${page + 1}): ${result.places.length} Treffer, ` +
            `${stats.passed}/${goal} bestanden`,
        );

        if (halt.budget) throw halt.budget;
        if (stats.passed >= goal) {
          stats.stopped_because = "goal_reached";
          break tiles;
        }
        if (!result.nextPageToken) break;
        pageToken = result.nextPageToken;
      }
    }
    stats.stopped_because ??= "tiles_exhausted";
    await finishSearchRun(db, run.id, "COMPLETED", stats);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // Kein Fehler des Laufs: sauber anhalten, Ergebnisse bis hierhin bleiben gültig.
      stats.stopped_because = "budget_exceeded";
      stats.error = err.message;
      await finishSearchRun(db, run.id, "COMPLETED", stats);
      return { run: { ...run, status: "COMPLETED", stats: { ...stats } }, stats, passed };
    }
    stats.error = err instanceof Error ? err.message : String(err);
    await finishSearchRun(db, run.id, "FAILED", stats);
    throw err;
  }

  return { run: { ...run, status: "COMPLETED", stats: { ...stats } }, stats, passed };
}
