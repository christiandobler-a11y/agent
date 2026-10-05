import type { JobWithMetadata } from "pg-boss";
import { claimState } from "../db/appState.js";
import { setFailed } from "../db/companies.js";
import { finishSearchRun, getSearchRun } from "../db/searchRuns.js";
import { BudgetExceededError } from "../llm/budget.js";
import { computeRecheckAfter } from "../pipeline/research/recheck.js";
import { ADVISOR_QUEUE, PLAN_QUEUE, QUEUES, SWEEP_QUEUE, type QueueName } from "./boss.js";
import { runAdvisorJob } from "../advisor/job.js";
import { runPlanJob } from "../autopilot/schedule.js";
import {
  enqueue,
  handleAudit,
  handleCrawl,
  handlePitch,
  handleResearch,
  maybeCompleteRun,
  sweep,
  type CompanyJob,
  type PipelineContext,
  type ResearchJob,
} from "./pipeline.js";

/**
 * Worker je Queue. Gemeinsame Regeln:
 * - Fehler → pg-boss wiederholt (Backoff). Beim letzten Versuch wird die Firma FAILED (mit Grund) bzw. der Lauf
 *   FAILED, danach landet der Job im Dead-Letter (Kriterium 2 und 7: nur dieser Lead scheitert).
 * - Budget erschöpft → kein Fehler: Job auf den nächsten Morgen verschieben, einmal am Tag melden (Kriterium 8).
 * - Nach jedem Job: Ist der Suchlauf damit fertig? Dann abschließen und melden.
 */

const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  console[level === "info" ? "log" : level](JSON.stringify({ level, msg, ...extra }));

/** Versatz der deutschen Zeit gegenüber UTC zu einem Zeitpunkt (Sommer-/Winterzeit), in Millisekunden. */
function berlinOffsetMs(at: Date): number {
  const wall = new Date(at.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  return wall.getTime() - utc.getTime();
}

/** Nächster Fortsetzungszeitpunkt nach Budget-Stopp: morgen (bzw. am Monatsersten) zur konfigurierten Uhrzeit. */
export function budgetResumeAt(now: Date, period: "Tag" | "Monat", time: string): Date {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const today = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }); // JJJJ-MM-TT
  const [y, mo, d] = today.split("-").map(Number) as [number, number, number];
  // Gewünschte Wanduhrzeit in Berlin, zunächst als wäre sie UTC …
  const wallAsUtc = period === "Monat" ? Date.UTC(y, mo, 1, h, m) : Date.UTC(y, mo - 1, d + 1, h, m);
  // … dann um den an diesem Tag gültigen Versatz korrigieren (zweimal, falls die Umstellung dazwischen liegt).
  const first = wallAsUtc - berlinOffsetMs(new Date(wallAsUtc));
  return new Date(wallAsUtc - berlinOffsetMs(new Date(first)));
}

async function onBudgetExceeded(ctx: PipelineContext, err: BudgetExceededError): Promise<Date> {
  const now = ctx.now();
  const day = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const key = err.period === "Monat" ? `budget_notified:${day.slice(0, 7)}` : `budget_notified:${day}`;
  const resumeAt = budgetResumeAt(now, err.period, ctx.queueConfig.budget_resume_time);
  if (await claimState(ctx.db, key, { at: now.toISOString(), message: err.message })) {
    const when = resumeAt.toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      dateStyle: "short",
      timeStyle: "short",
    });
    await ctx.notifier
      .budgetExceeded(
        `${err.message}. Offene Arbeit läuft am ${when} weiter (oder Budget in config/models.yaml erhöhen).`,
      )
      .catch(() => undefined);
  }
  return resumeAt;
}

type Handler = (job: JobWithMetadata<ResearchJob & CompanyJob>, final: boolean) => Promise<void>;

function handlers(ctx: PipelineContext): Record<QueueName, Handler> {
  return {
    research: async (job) => {
      const { budgetExceeded } = await handleResearch(ctx, job.data);
      if (budgetExceeded) {
        const resumeAt = await onBudgetExceeded(ctx, new BudgetExceededError("Tag", 0, 0));
        // Neuer Schlüssel, weil der aktuelle Job noch aktiv ist (exclusive-Policy).
        await enqueue(
          ctx,
          "research",
          job.data,
          `${job.data.searchRunId}:budget:${resumeAt.toISOString()}`,
          resumeAt,
        );
      }
    },
    crawl: (job, final) => handleCrawl(ctx, job.data, { final }),
    audit: (job) => handleAudit(ctx, job.data, job.id),
    pitch: (job) => handlePitch(ctx, job.data, job.id),
  };
}

async function onFinalFailure(
  ctx: PipelineContext,
  queue: QueueName,
  job: JobWithMetadata<ResearchJob & CompanyJob>,
  err: unknown,
) {
  const message = err instanceof Error ? err.message : String(err);
  if (queue === "research") {
    const run = await getSearchRun(ctx.db, job.data.searchRunId);
    if (run && run.status === "RUNNING") {
      await finishSearchRun(ctx.db, run.id, "FAILED", { ...run.stats, error: message.slice(0, 300) });
      await ctx.notifier.runFailed(run, message).catch(() => undefined);
    }
    return;
  }
  await setFailed(
    ctx.db,
    job.data.companyId,
    `${queue}: ${message.slice(0, 250)}`,
    computeRecheckAfter(ctx.lead.recheck, "FAILED", null, ctx.now()),
  );
}

/** Führt einen Job aus; gemeinsame Fehler-, Budget- und Abschlusslogik. */
export async function runJob(
  ctx: PipelineContext,
  queue: QueueName,
  job: JobWithMetadata<ResearchJob & CompanyJob>,
  handler: Handler,
): Promise<void> {
  const final = job.retryCount >= job.retryLimit;
  const started = Date.now();
  try {
    await handler(job, final);
    log("info", "Job fertig", { queue, job: job.id, ms: Date.now() - started });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      const resumeAt = await onBudgetExceeded(ctx, err);
      const key = queue === "research" ? job.data.searchRunId : job.data.companyId;
      await enqueue(ctx, queue, job.data, `${key}:budget:${resumeAt.toISOString()}`, resumeAt);
      log("warn", "Budget erreicht, Job verschoben", { queue, job: job.id, until: resumeAt.toISOString() });
    } else {
      log(
        final ? "error" : "warn",
        final ? "Job endgültig fehlgeschlagen" : "Job fehlgeschlagen, wird wiederholt",
        {
          queue,
          job: job.id,
          attempt: job.retryCount + 1,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      if (final) await onFinalFailure(ctx, queue, job, err);
      throw err; // pg-boss: Wiederholung bzw. Dead-Letter
    }
  }
  if (job.data.searchRunId) {
    await maybeCompleteRun(ctx, job.data.searchRunId, job.id).catch((err: unknown) =>
      log("error", "Abschlussprüfung fehlgeschlagen", { error: String(err) }),
    );
  }
}

export async function startWorkers(ctx: PipelineContext): Promise<void> {
  const all = handlers(ctx);
  for (const queue of QUEUES) {
    const q = ctx.queueConfig.queues[queue];
    await ctx.boss.work<ResearchJob & CompanyJob>(
      queue,
      { includeMetadata: true, batchSize: 1, localConcurrency: q.concurrency, pollingIntervalSeconds: 2 },
      async ([job]) => {
        // includeMetadata: true liefert retryCount/retryLimit; der Typ der Überladung kennt das hier nicht.
        if (job) await runJob(ctx, queue, job as JobWithMetadata<ResearchJob & CompanyJob>, all[queue]);
      },
    );
  }
  await ctx.boss.work(PLAN_QUEUE, { pollingIntervalSeconds: 30 }, async () => {
    const result = await runPlanJob(ctx);
    if (result) console.log(JSON.stringify({ level: "info", msg: "Morgen-Paket vorbereitet", ...result }));
  });
  await ctx.boss.work<{ trigger?: string }>(ADVISOR_QUEUE, { pollingIntervalSeconds: 10 }, async ([job]) => {
    const report = await runAdvisorJob(ctx, job?.data.trigger ?? "woche");
    if (report)
      console.log(
        JSON.stringify({
          level: "info",
          msg: "Berater-Runde fertig",
          vorschlaege: report.suggestions.length,
          verworfen: report.dropped,
          suchen: report.searches,
          cost_usd: Math.round(report.costUsd * 1000) / 1000,
        }),
      );
  });
  await ctx.boss.work(SWEEP_QUEUE, { pollingIntervalSeconds: 10 }, async () => {
    await sweep(ctx);
  });
  await ctx.boss.schedule(SWEEP_QUEUE, `*/${ctx.queueConfig.sweep_every_minutes} * * * *`, null, {
    tz: "Europe/Berlin",
  });
}
