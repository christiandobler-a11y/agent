import { getState, setState } from "../db/appState.js";
import { regionCoverage } from "../pipeline/research/coverage.js";
import { startSearch, type PipelineContext } from "../queue/pipeline.js";
import { berlinDate, berlinTime } from "./plan.js";

/**
 * Nachtsuche (Autopilot): ab `suche.ab` die nächste noch nicht vollständig abgesuchte Kombination aus Region × Branche
 * als Komplett-Suche starten, höchstens `pro_nacht` je Nacht und nie zwei gleichzeitig. "Vollständig" heißt hier: alle
 * Orte durchsucht (offene Prüfungen der gefundenen Firmen laufen ohnehin weiter).
 */

export interface NextSearch {
  regionKey: string;
  branchKey: string;
  term: string;
}

/** Erste Kombination in Prioritäts-Reihenfolge, deren Orte noch nicht alle erledigt sind; `null` = alles abgesucht. */
export async function pickNextSearch(
  ctx: PipelineContext,
  regions: readonly string[],
  branchKeys: readonly string[],
): Promise<NextSearch | null> {
  const branches = ctx.research.branches;
  for (const regionKey of regions) {
    const region = ctx.loadRegion(regionKey);
    const coverage = await regionCoverage(ctx.db, region, branches, {
      validDays: ctx.research.config.coverage_valid_days,
      now: ctx.now(),
    });
    for (const branchKey of branchKeys) {
      const branch = branches[branchKey];
      if (!branch) continue;
      const c = coverage.find((x) => x.subject === branchKey);
      if (c && c.tilesDone >= c.tilesTotal) continue;
      const term = branch.aliases[0] ?? branch.label;
      // Zweimal hintereinander gescheitert (z. B. Google-Fehler): erst einmal überspringen statt jede Nacht festhängen.
      const { rows } = await ctx.db.query<{ status: string }>(
        `select status from search_runs
          where requested_by = 'autopilot' and query->>'region' = $1 and query->>'term' = $2
          order by created_at desc limit 2`,
        [regionKey, term],
      );
      if (rows.length === 2 && rows.every((r) => r.status === "FAILED")) continue;
      return { regionKey, branchKey, term };
    }
  }
  return null;
}

/** Zu welcher Nacht gehört der Zeitpunkt? Nach Mitternacht zählt noch der Vorabend. */
export function nightOf(now: Date, start: string): string | null {
  const time = berlinTime(now);
  if (time >= start) return berlinDate(now);
  if (time < "06:00") return berlinDate(new Date(now.getTime() - 12 * 3600_000));
  return null;
}

export async function searchTick(ctx: PipelineContext): Promise<NextSearch | null> {
  const cfg = ctx.autopilot?.config.suche;
  if (!cfg?.aktiv) return null;
  const now = ctx.now();
  const night = nightOf(now, cfg.ab);
  if (!night) return null;
  const { rows } = await ctx.db.query<{ n: number }>(
    "select count(*)::int as n from search_runs where requested_by = 'autopilot' and status = 'RUNNING'",
  );
  if ((rows[0]?.n ?? 0) > 0) return null;
  const key = `autosearch:${night}`;
  const started = (await getState<number>(ctx.db, key)) ?? 0;
  if (started >= cfg.pro_nacht) return null;
  const next = await pickNextSearch(ctx, cfg.regionen, cfg.branchen);
  if (!next) return null;
  await setState(ctx.db, key, started + 1);
  await startSearch(ctx, {
    term: next.term,
    regionKey: next.regionKey,
    target: 1,
    requestedBy: "autopilot",
    complete: true,
  });
  return next;
}

/** Nachtbericht fürs Morgen-Paket: Suchläufe des Autopiloten seit gestern Mittag. */
export async function nightReport(ctx: PipelineContext): Promise<string[]> {
  const { rows } = await ctx.db.query<{
    id: string;
    query: { term?: string; region?: string };
    status: string;
    stats: { stopped_because?: string | null };
    found: number;
    qualified: number;
    open: number;
  }>(
    `select r.id, r.query, r.status, r.stats,
            count(c.id)::int as found,
            count(c.id) filter (where c.status = 'QUALIFIED' or c.status = 'READY_FOR_CONTACT')::int as qualified,
            count(c.id) filter (where c.status in ('NEW', 'RESEARCHED', 'AUDITED'))::int as open
       from search_runs r left join companies c on c.first_search_run_id = r.id
      where r.requested_by = 'autopilot' and r.created_at > $1::timestamptz - interval '20 hours'
      group by r.id order by r.created_at`,
    [ctx.now()],
  );
  return rows.map((r) => {
    let region = r.query.region ?? "?";
    try {
      region = ctx.loadRegion(region).name;
    } catch {
      // Region-Datei fehlt: Schlüssel anzeigen
    }
    const state =
      r.status === "RUNNING"
        ? "läuft noch"
        : r.stats.stopped_because === "tiles_exhausted"
          ? "Region komplett"
          : "geht nächste Nacht weiter";
    return `${r.query.term ?? "?"} · ${region}: ${r.found} neue Betriebe, ${r.qualified} gute Leads${r.open > 0 ? `, ${r.open} noch in Prüfung` : ""} (${state})`;
  });
}
