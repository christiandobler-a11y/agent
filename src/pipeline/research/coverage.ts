import type { Db } from "../../db/client.js";
import { coverageRows, type CoverageRow } from "../../db/coverage.js";
import { resolveBranch, type Branches } from "./branches.js";
import { normalizeName } from "./identity.js";
import { MAX_SPLIT_DEPTH, splitQuery, tileQueries, type Region, type TileQuery } from "./tiling.js";

/**
 * Abdeckung: Ist eine Region für eine Branche wirklich vollständig abgesucht? Ein Ort gilt als erledigt, wenn er
 * innerhalb von `validDays` komplett durchsucht wurde und Google dort nicht das Maximum geliefert hat, oder, falls
 * doch, alle seine Teilgebiete erledigt sind. Vollständig ist die Region, wenn alle Orte erledigt sind und jede
 * gefundene Firma fertig geprüft ist.
 */

/** Branchenschlüssel, sonst der normalisierte Suchbegriff ("term:…"). */
export function coverageSubject(term: string, branches: Branches): string {
  return resolveBranch(branches, term)?.key ?? `term:${normalizeName(term)}`;
}

/** done = erledigt; searched = durchsucht, aber nicht sicher vollständig (volles Gebiet oder ältere Suche); open = fehlt. */
export type TileState = "done" | "searched" | "open";

export interface TileStatusInput {
  rows: ReadonlyMap<string, Pick<CoverageRow, "saturated" | "searched_at">>;
  /** Orte, die ältere Suchen (vor der Abdeckungs-Buchhaltung) durchsucht haben, Ergebnis unbekannt. */
  legacy: ReadonlySet<string>;
  now: Date;
  validDays: number;
}

export function tileState(q: TileQuery, input: TileStatusInput): TileState {
  const row = input.rows.get(q.key);
  const fresh = row && input.now.getTime() - row.searched_at.getTime() <= input.validDays * 86_400_000;
  if (!row || !fresh) return q.depth === 0 && input.legacy.has(q.key) ? "searched" : "open";
  if (!row.saturated || q.depth >= MAX_SPLIT_DEPTH) return "done";
  const children = splitQuery(q, "x").map((c) => tileState(c, input));
  return children.every((s) => s === "done") ? "done" : "searched";
}

export interface FirmCounts {
  found: number;
  /** Noch in Prüfung (NEW, RESEARCHED, AUDITED). */
  open: number;
  qualified: number;
  skipped: number;
  failed: number;
}

export interface SubjectCoverage {
  subject: string;
  label: string;
  tilesTotal: number;
  tilesDone: number;
  tilesSearched: number;
  everSearched: boolean;
  lastSearchedAt: Date | null;
  firms: FirmCounts;
  complete: boolean;
}

export function summarize(
  region: Region,
  subject: string,
  label: string,
  input: TileStatusInput,
  firms: FirmCounts,
  lastSearchedAt: Date | null,
): SubjectCoverage {
  const states = tileQueries(region, "x").map((q) => tileState(q, input));
  const tilesDone = states.filter((s) => s === "done").length;
  const tilesSearched = states.filter((s) => s !== "open").length;
  return {
    subject,
    label,
    tilesTotal: states.length,
    tilesDone,
    tilesSearched,
    everSearched: tilesSearched > 0 || firms.found > 0,
    lastSearchedAt,
    firms,
    complete: tilesDone === states.length && firms.open === 0,
  };
}

/** Wie viele Orte hat ein älterer Lauf vollständig durchsucht? (Abbruch mitten in einem Ort zählt nicht.) */
export function legacyTilesSearched(stats: Record<string, unknown>): number {
  const searched = typeof stats.tiles_searched === "number" ? stats.tiles_searched : 0;
  return stats.stopped_because === "tiles_exhausted" ? searched : Math.max(0, searched - 1);
}

interface RunRow {
  id: string;
  query: { term?: string; region?: string };
  stats: Record<string, unknown>;
  created_at: Date;
}

export interface CoverageOptions {
  validDays: number;
  now: Date;
  /** Nur diese Branche (Schlüssel oder Suchbegriff). */
  term?: string;
}

/** Abdeckung einer Region für alle Branchen (bzw. eine), aus Abdeckungs-Tabelle, Suchläufen und Firmen. */
export async function regionCoverage(
  db: Db,
  region: Region,
  branches: Branches,
  opts: CoverageOptions,
): Promise<SubjectCoverage[]> {
  const rows = await coverageRows(db, region.key);
  const { rows: runs } = await db.query<RunRow>(
    `select id, query, stats, created_at from search_runs where query->>'region' = $1 order by created_at`,
    [region.key],
  );
  const runSubject = (r: RunRow) => coverageSubject(r.query.term ?? "", branches);
  const only = opts.term ? coverageSubject(opts.term, branches) : null;

  const subjects = new Set<string>(only ? [only] : Object.keys(branches));
  if (!only) {
    for (const r of rows) subjects.add(r.subject);
    for (const r of runs) subjects.add(runSubject(r));
  }

  const result: SubjectCoverage[] = [];
  for (const subject of subjects) {
    const subjectRows = rows.filter((r) => r.subject === subject);
    const subjectRuns = runs.filter((r) => runSubject(r) === subject);
    const legacy = new Set<string>();
    for (const r of subjectRuns) {
      if (r.stats.coverage === true) continue; // neuere Läufe schreiben ihre Orte selbst in search_coverage
      for (const t of region.tiles.slice(0, legacyTilesSearched(r.stats))) legacy.add(t.name);
    }
    const { rows: counts } = await db.query<FirmCounts>(
      `select count(*)::int as found,
              count(*) filter (where status in ('NEW', 'RESEARCHED', 'AUDITED'))::int as open,
              count(*) filter (where status = 'QUALIFIED')::int as qualified,
              count(*) filter (where status = 'SKIPPED')::int as skipped,
              count(*) filter (where status = 'FAILED')::int as failed
         from companies
        where region = $1 and (branch_key = $2 or first_search_run_id = any($3::uuid[]))`,
      [region.name, subject, subjectRuns.map((r) => r.id)],
    );
    const dates = [...subjectRows.map((r) => r.searched_at), ...subjectRuns.map((r) => r.created_at)];
    const last = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    const label = subject.startsWith("term:") ? subject.slice(5) : (branches[subject]?.label ?? subject);
    result.push(
      summarize(
        region,
        subject,
        label,
        {
          rows: new Map(subjectRows.map((r) => [r.tile_key, r])),
          legacy,
          now: opts.now,
          validDays: opts.validDays,
        },
        counts[0]!,
        last,
      ),
    );
  }
  // Vollständige und angefangene zuerst, nie gesuchte zuletzt.
  const rank = (c: SubjectCoverage) => (c.complete ? 0 : c.everSearched ? 1 : 2);
  return result.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 100));

/** Eine Zeile je Branche, ohne HTML (Telegram escaped beim Senden). */
export function formatCoverage(region: Region, c: SubjectCoverage, searchTerm?: string): string {
  const f = c.firms;
  const firms =
    f.found === 0
      ? ""
      : ` · ${f.found} Betriebe gefunden, ${f.open > 0 ? `${f.open} noch in Prüfung` : "alle geprüft"}, ${f.qualified} Leads`;
  if (c.complete) return `✔ ${c.label}: vollständig (${c.tilesTotal}/${c.tilesTotal} Orte)${firms}`;
  if (!c.everSearched) return `○ ${c.label}: noch nie gesucht`;
  const uncertain = c.tilesSearched - c.tilesDone;
  const parts = [
    `◐ ${c.label}: ${c.tilesDone}/${c.tilesTotal} Orte vollständig (${pct(c.tilesDone, c.tilesTotal)} %)`,
  ];
  if (uncertain > 0) parts.push(`${uncertain} weitere angesucht, aber nicht sicher vollständig`);
  const tail =
    c.tilesDone === c.tilesTotal
      ? " – fertig, sobald alle Firmen geprüft sind"
      : ` – Rest: „Such alle ${searchTerm ?? c.label} in ${region.name}“`;
  return `${parts.join(", ")}${firms}${tail}`;
}

/** Abdeckung einer Region als Text: begonnene bzw. vollständige Branchen einzeln, nie gesuchte in einer Zeile. */
export function formatRegionCoverage(region: Region, list: SubjectCoverage[]): string {
  const searched = list.filter((c) => c.everSearched);
  const never = list.filter((c) => !c.everSearched).map((c) => c.label);
  const lines = [`${region.name} (${region.tiles.length} Orte):`];
  for (const c of searched) lines.push(formatCoverage(region, c));
  if (never.length > 0) lines.push(`○ Noch nie gesucht: ${never.join(", ")}`);
  if (searched.length === 0 && never.length === 0) lines.push("Keine Daten.");
  return lines.join("\n");
}
