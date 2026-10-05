import { claimState } from "../db/appState.js";
import { berlinDate, berlinTime } from "../autopilot/plan.js";
import { ADVISOR_QUEUE } from "../queue/boss.js";
import type { PipelineContext } from "../queue/pipeline.js";
import type { LlmGateway } from "../llm/gateway.js";
import { regionCoverage } from "../pipeline/research/coverage.js";
import {
  advisorDue,
  findDue,
  loadAdvisorConfig,
  runAdvisor,
  type AdvisorConfig,
  type AdvisorDeps,
  type AdvisorReport,
} from "./run.js";
import type { CoverageLine } from "./snapshot.js";
import { findSomething } from "./finds.js";

/** Auftrag der Berater-Queue: Wochen-Runde bzw. /berater, oder ein Fundstück zwischendurch. */
export const FIND_TRIGGER = "fundstueck";

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wochentag in Deutschland (0 = Sonntag). */
export function berlinWeekday(d: Date): number {
  const short = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "Europe/Berlin" }).format(d);
  return DAY_INDEX[short] ?? 0;
}

/** Sweep: einmal die Woche (Tag und Uhrzeit aus config/advisor.yaml) die Berater-Runde als Job anstoßen. */
export async function advisorTick(ctx: PipelineContext): Promise<boolean> {
  if (!ctx.advisor) return false;
  const now = ctx.now();
  const day = berlinWeekday(now);
  const time = berlinTime(now);
  if (
    findDue(ctx.advisor.config, day, time) &&
    (await claimState(ctx.db, `advisor-find:${berlinDate(now)}`, now.toISOString()))
  )
    await ctx.boss.send(ADVISOR_QUEUE, { trigger: FIND_TRIGGER }, { singletonKey: "advisor-find" });
  if (!advisorDue(ctx.advisor.config, day, time)) return false;
  if (!(await claimState(ctx.db, `advisor:${berlinDate(now)}`, now.toISOString()))) return false;
  await startAdvisor(ctx, "woche");
  return true;
}

/** Job: Fundstück suchen und melden. Klappt es nicht, bleibt es still (es ist nur ein Extra). */
export async function runFindJob(ctx: PipelineContext): Promise<string | null> {
  if (!ctx.advisor) return null;
  const deps = ctx.advisor.deps();
  try {
    const { text } = await findSomething({
      db: deps.db,
      llm: deps.llm,
      maxSearches: deps.config.zwischendurch?.websuchen ?? 3,
    });
    await ctx.notifier.info?.(`🔎 Fundstück aus dem Berater-Büro\n\n${text}`);
    return text;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "Fundstück fehlgeschlagen",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/** Runde einreihen (Sweep oder /berater). Läuft schon eine, kommt keine zweite dazu. */
export async function startAdvisor(ctx: PipelineContext, trigger: string): Promise<boolean> {
  const id = await ctx.boss.send(ADVISOR_QUEUE, { trigger }, { singletonKey: "advisor" });
  return id !== null;
}

/** Job: Runde ausführen und den Bericht melden. Fehler meldet sie als kurze Info statt still zu scheitern. */
export async function runAdvisorJob(ctx: PipelineContext, trigger: string): Promise<AdvisorReport | null> {
  if (!ctx.advisor) return null;
  try {
    const report = await runAdvisor(ctx.advisor.deps(), trigger);
    await ctx.notifier.advisorReport?.(report);
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.notifier.info?.(`⚠️ Die Berater-Runde hat nicht geklappt: ${message.slice(0, 300)}`);
    return null;
  }
}

/** Abdeckung der Nachtsuche (Regionen × Branchen aus config/autopilot.yaml) fürs Lagebild. */
async function searchCoverage(ctx: PipelineContext): Promise<CoverageLine[]> {
  const suche = ctx.autopilot?.config.suche;
  if (!suche) return [];
  const out: CoverageLine[] = [];
  for (const key of suche.regionen) {
    const list = await regionCoverage(ctx.db, ctx.loadRegion(key), ctx.research.branches, {
      validDays: ctx.research.config.coverage_valid_days,
      now: ctx.now(),
    });
    for (const c of list)
      if (suche.branchen.includes(c.subject))
        out.push({ region: key, branche: c.subject, orte_erledigt: c.tilesDone, orte_gesamt: c.tilesTotal });
  }
  return out;
}

/** Berater im Kontext einhängen (Worker und CLI); die Konfiguration wird je Runde neu gelesen. */
export function advisorContext(
  ctx: PipelineContext,
  llm: LlmGateway,
): { config: AdvisorConfig; deps: () => AdvisorDeps } {
  return {
    config: loadAdvisorConfig(),
    deps: () => {
      const ap = ctx.autopilot?.config;
      return {
        db: ctx.db,
        llm,
        config: loadAdvisorConfig(),
        now: ctx.now,
        snapshot: {
          coverage: () => searchCoverage(ctx),
          branches: ap?.neue_kontakte.branchen ?? ap?.suche.branchen ?? [],
          settings: ap
            ? {
                neue_kontakte_stufen: ap.neue_kontakte.stufen,
                nur_werktags: ap.neue_kontakte.nur_werktags,
                heimat: ap.neue_kontakte.heimat ?? null,
                bremse: ap.neue_kontakte.bremse,
                nachfassen: ap.nachfassen,
                briefe: ap.briefe,
                nachtsuche: {
                  regionen: ap.suche.regionen,
                  branchen: ap.suche.branchen,
                  pro_nacht: ap.suche.pro_nacht,
                },
              }
            : {},
        },
      };
    },
  };
}
