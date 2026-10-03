import type { PgBoss } from "pg-boss";
import type { Db } from "../db/client.js";
import { setFailed, type Company } from "../db/companies.js";
import { latestLeadScore, latestOkSnapshotId, latestPitch } from "../db/leads.js";
import { createSearchRun, getSearchRun, type SearchRun } from "../db/searchRuns.js";
import type { BudgetGuard } from "../llm/budget.js";
import { auditCompany, pitchCompany, scoreCompany, type LeadDeps } from "../pipeline/audit/run.js";
import type { BrowserCrawler } from "../pipeline/crawl/browser.js";
import { crawlCompany } from "../pipeline/crawl/run.js";
import type { PageSpeedClient } from "../pipeline/crawl/pagespeed.js";
import type { CrawlConfig } from "../pipeline/crawl/config.js";
import { computeRecheckAfter } from "../pipeline/research/recheck.js";
import { runResearch, type ResearchDeps } from "../pipeline/research/run.js";
import type { Region } from "../pipeline/research/tiling.js";
import type { ScoreResult } from "../pipeline/scoring/score.js";
import type { QueueConfig, QueueName } from "./boss.js";
import type { Notifier, RunSummary, TopLead } from "./notifier.js";

/**
 * Workflow (ARCHITECTURE.md 5.2): research → crawl → audit(+score) → pitch, je Firma ein Job.
 * Ein Suchlauf ist fertig, wenn die Recherche abgeschlossen ist und keine Jobs des Laufs mehr offen sind;
 * dann wird gemeldet (notify). Ein Sweeper holt liegengebliebene Firmen nach (z. B. nach Absturz).
 */

export interface ResearchJob {
  searchRunId: string;
  term: string;
  regionKey: string;
  target: number;
  requestedBy: string;
}

export interface CompanyJob {
  companyId: string;
  searchRunId: string | null;
}

export interface PipelineContext {
  db: Db;
  boss: PgBoss;
  /** Schema der pg-boss-Tabellen (Standard "pgboss"). */
  bossSchema: string;
  queueConfig: QueueConfig;
  research: Omit<ResearchDeps, "db" | "onPassed" | "now">;
  loadRegion: (key: string) => Region;
  lead: Omit<LeadDeps, "db" | "jobId" | "now">;
  crawl: {
    config: CrawlConfig;
    /** Browser erst beim ersten Crawl starten. */
    crawler: () => Promise<BrowserCrawler>;
    pagespeed: PageSpeedClient | null;
  };
  budget: BudgetGuard;
  notifier: Notifier;
  now: () => Date;
}

export async function enqueue(
  ctx: PipelineContext,
  queue: QueueName,
  data: ResearchJob | CompanyJob,
  key: string,
  startAfter?: Date,
): Promise<string | null> {
  return ctx.boss.send(queue, data as object, { singletonKey: key, ...(startAfter ? { startAfter } : {}) });
}

/** Neuen Suchlauf anlegen und den Recherche-Job einreihen. Antwortet sofort (Kriterium 1: < 10 s). */
export async function startSearch(
  ctx: PipelineContext,
  req: { term: string; regionKey: string; target: number; requestedBy: string },
): Promise<SearchRun> {
  const region = ctx.loadRegion(req.regionKey); // wirft bei unbekannter Region, bevor etwas angelegt wird
  if (!req.term.trim()) throw new Error("Leerer Suchbegriff");
  const run = await createSearchRun(ctx.db, {
    requestedBy: req.requestedBy,
    query: { term: req.term.trim(), region: region.key },
    targetCount: req.target,
  });
  await enqueue(
    ctx,
    "research",
    {
      searchRunId: run.id,
      term: req.term.trim(),
      regionKey: region.key,
      target: req.target,
      requestedBy: req.requestedBy,
    },
    run.id,
  );
  return run;
}

export type NextStep = "crawl" | "audit" | "pitch" | "incomplete" | null;

/** Nächster Schritt einer Firma aus ihrem gespeicherten Zustand (rein). `null` = Endzustand erreicht. */
export function nextStep(state: {
  status: Company["status"];
  segment: Company["segment"];
  hasOkSnapshot: boolean;
  score: { total: number; qualified: boolean } | null;
  hasPitch: boolean;
  pitchMinTotal: number;
}): NextStep {
  switch (state.status) {
    case "NEW":
      return "incomplete";
    case "RESEARCHED":
      return state.segment === "NO_WEBSITE" || state.hasOkSnapshot ? "audit" : "crawl";
    case "AUDITED":
      return "audit";
    case "QUALIFIED":
      return state.score && state.score.total >= state.pitchMinTotal && !state.hasPitch ? "pitch" : null;
    default:
      return null;
  }
}

async function companyById(db: Db, id: string): Promise<Company | null> {
  const { rows } = await db.query<Company>("select * from companies where id = $1", [id]);
  return rows[0] ?? null;
}

/** Nächsten Job für eine Firma einreihen (oder unvollständige Firmen abschließen). `true` = Job angelegt. */
export async function advance(
  ctx: PipelineContext,
  company: Company,
  searchRunId: string | null,
): Promise<boolean> {
  const score = await latestLeadScore(ctx.db, company.id);
  const step = nextStep({
    status: company.status,
    segment: company.segment,
    hasOkSnapshot: (await latestOkSnapshotId(ctx.db, company.id)) !== null,
    score: score
      ? { total: score.total, qualified: !score.knocked_out && company.status === "QUALIFIED" }
      : null,
    hasPitch: (await latestPitch(ctx.db, company.id)) !== null,
    pitchMinTotal: ctx.lead.scoring.pitch_min_total,
  });
  if (step === null) return false;
  if (step === "incomplete") {
    await setFailed(
      ctx.db,
      company.id,
      "Recherche nicht abgeschlossen (Vorprüfung fehlt)",
      computeRecheckAfter(ctx.lead.recheck, "FAILED", null, ctx.now()),
    );
    return false;
  }
  return (await enqueue(ctx, step, { companyId: company.id, searchRunId }, company.id)) !== null;
}

// ---------------------------------------------------------------- Handler (je Queue)

export async function handleResearch(
  ctx: PipelineContext,
  data: ResearchJob,
): Promise<{ budgetExceeded: boolean }> {
  const result = await runResearch(
    {
      ...ctx.research,
      db: ctx.db,
      now: ctx.now,
      onPassed: async (company) => {
        await advance(ctx, company, data.searchRunId);
      },
    },
    {
      term: data.term,
      region: ctx.loadRegion(data.regionKey),
      target: data.target,
      requestedBy: data.requestedBy,
      searchRunId: data.searchRunId,
      finish: false,
    },
  );
  return { budgetExceeded: result.stats.stopped_because === "budget_exceeded" };
}

/** Diese Fehlerarten sind oft vorübergehend: Job wiederholen (5 min, 1 h), danach bleibt die Firma FAILED. */
const TRANSIENT_CRAWL_ERRORS = new Set(["unreachable", "timeout", "blocked", "empty"]);

export class RetryableError extends Error {}

export async function handleCrawl(
  ctx: PipelineContext,
  data: CompanyJob,
  attempt: { final: boolean },
): Promise<void> {
  const company = await companyById(ctx.db, data.companyId);
  if (!company || !["RESEARCHED", "FAILED"].includes(company.status)) return; // inzwischen anders entschieden
  const outcome = await crawlCompany(
    {
      db: ctx.db,
      crawler: await ctx.crawl.crawler(),
      pagespeed: ctx.crawl.pagespeed,
      config: ctx.crawl.config,
      recheck: ctx.lead.recheck,
      now: ctx.now,
    },
    company,
  );
  if (outcome.kind === "failed") {
    if (TRANSIENT_CRAWL_ERRORS.has(outcome.errorKind) && !attempt.final) {
      throw new RetryableError(`Crawl ${outcome.errorKind}: ${outcome.error}`);
    }
    return; // Firma bleibt FAILED (Endzustand)
  }
  const updated = await companyById(ctx.db, company.id);
  if (updated) await advance(ctx, updated, data.searchRunId);
}

export async function handleAudit(ctx: PipelineContext, data: CompanyJob, jobId: string): Promise<void> {
  const company = await companyById(ctx.db, data.companyId);
  if (!company || !["RESEARCHED", "AUDITED", "QUALIFIED", "SKIPPED"].includes(company.status)) return;
  const deps: LeadDeps = { ...ctx.lead, db: ctx.db, jobId, now: ctx.now };
  const audited = await auditCompany(deps, company);
  if (audited.kind === "no_snapshot") {
    await advance(ctx, company, data.searchRunId); // erst crawlen
    return;
  }
  await scoreCompany(deps, (await companyById(ctx.db, company.id))!);
  const updated = await companyById(ctx.db, company.id);
  if (updated) await advance(ctx, updated, data.searchRunId);
}

export async function handlePitch(ctx: PipelineContext, data: CompanyJob, jobId: string): Promise<void> {
  const company = await companyById(ctx.db, data.companyId);
  const score = company ? await latestLeadScore(ctx.db, company.id) : null;
  if (!company || !score || (await latestPitch(ctx.db, company.id))) return;
  await pitchCompany({ ...ctx.lead, db: ctx.db, jobId, now: ctx.now }, company, {
    result: score.breakdown as ScoreResult,
    score,
  });
}

// ---------------------------------------------------------------- Abschluss eines Suchlaufs

/** Offene Jobs (wartend, Wiederholung, aktiv) eines Suchlaufs, optional ohne den gerade laufenden Job. */
export async function pendingJobs(
  ctx: PipelineContext,
  searchRunId: string,
  exceptJobId?: string,
): Promise<number> {
  const { rows } = await ctx.db.query<{ n: number }>(
    `select count(*)::int as n from ${ctx.bossSchema}.job
      where data->>'searchRunId' = $1::text and state in ('created', 'retry', 'active')
        and ($2::uuid is null or id <> $2::uuid)`,
    [searchRunId, exceptJobId ?? null],
  );
  return rows[0]!.n;
}

/** Firmen eines Laufs: dort zuerst gefunden oder von einem Job des Laufs bearbeitet. */
async function runCompanyIds(ctx: PipelineContext, searchRunId: string): Promise<string[]> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `select id from companies where first_search_run_id = $1::uuid
     union
     select (data->>'companyId')::uuid from ${ctx.bossSchema}.job
      where data->>'searchRunId' = $1::text and data ? 'companyId'`,
    [searchRunId],
  );
  return rows.map((r) => r.id);
}

export async function runSummary(ctx: PipelineContext, run: SearchRun): Promise<RunSummary> {
  const ids = await runCompanyIds(ctx, run.id);
  const { rows: counts } = await ctx.db.query<{ status: string; n: number }>(
    "select status, count(*)::int as n from companies where id = any($1::uuid[]) group by status",
    [ids],
  );
  const { rows: top } = await ctx.db.query<{
    id: string;
    name: string;
    city: string | null;
    current_score: number;
    segment: string | null;
    main_opportunity: string | null;
  }>(
    `select c.id, c.name, c.city, c.current_score, c.segment,
            (select p.main_opportunity from pitches p where p.company_id = c.id order by p.created_at desc limit 1)
              as main_opportunity
       from companies c
      where c.id = any($1::uuid[]) and c.status = 'QUALIFIED'
      order by c.current_score desc nulls last limit 5`,
    [ids],
  );
  const { rows: cost } = await ctx.db.query<{ usd: string | null }>(
    `select (select coalesce(sum(cost_usd), 0) from agent_runs
              where search_run_id = $1 or (company_id = any($2::uuid[]) and started_at >= $3))
          + (select coalesce(sum(cost_usd), 0) from api_usage where search_run_id = $1) as usd`,
    [run.id, ids, run.created_at],
  );
  const topLeads: TopLead[] = top.map((t) => ({
    companyId: t.id,
    name: t.name,
    city: t.city,
    score: t.current_score,
    segment: t.segment,
    mainOpportunity: t.main_opportunity,
  }));
  return {
    run,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    topLeads,
    costUsd: Math.round(Number(cost[0]?.usd ?? 0) * 1000) / 1000,
  };
}

/**
 * Lauf abschließen, wenn die Recherche fertig ist und nichts mehr offen ist. Vorher werden liegengebliebene Firmen
 * nachgeholt (z. B. Absturz zwischen zwei Schritten). Genau ein Aufrufer gewinnt (Update mit Bedingung).
 */
export async function maybeCompleteRun(
  ctx: PipelineContext,
  searchRunId: string,
  exceptJobId?: string,
): Promise<boolean> {
  const run = await getSearchRun(ctx.db, searchRunId);
  if (!run || run.status !== "RUNNING" || run.stats.research_done !== true) return false;
  if ((await pendingJobs(ctx, searchRunId, exceptJobId)) > 0) return false;

  let advanced = false;
  for (const id of await runCompanyIds(ctx, searchRunId)) {
    const company = await companyById(ctx.db, id);
    if (company && (await advance(ctx, company, searchRunId))) advanced = true;
  }
  if (advanced) return false;

  const { rows } = await ctx.db.query<SearchRun>(
    `update search_runs set status = 'COMPLETED', finished_at = now() where id = $1 and status = 'RUNNING' returning *`,
    [searchRunId],
  );
  if (!rows[0]) return false;
  await ctx.notifier.runCompleted(await runSummary(ctx, rows[0]));
  return true;
}

/** Alle offenen Läufe prüfen (Cron). */
export async function sweep(ctx: PipelineContext): Promise<void> {
  const { rows } = await ctx.db.query<{ id: string }>("select id from search_runs where status = 'RUNNING'");
  for (const r of rows) await maybeCompleteRun(ctx, r.id);
}
