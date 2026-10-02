import { withTransaction, type Db, type DbClient } from "./client.js";
import type { CompanyStatus } from "./companies.js";

/** Audits, Scores und Pitches speichern und laden (ARCHITECTURE.md 9). */

export interface AuditRow {
  id: string;
  company_id: string;
  website_snapshot_id: string | null;
  agent_run_id: string | null;
  prompt_version: string;
  model: string;
  findings: unknown;
  rubric: unknown;
  commercial: unknown;
  summary: string | null;
  created_at: Date;
}

export async function insertAudit(
  db: DbClient,
  a: {
    companyId: string;
    snapshotId: string | null;
    agentRunId: string | null;
    promptVersion: string;
    model: string;
    findings: unknown;
    rubric: unknown;
    commercial: unknown;
    summary: string;
    designEra?: string | null;
  },
): Promise<AuditRow> {
  const { rows } = await db.query<AuditRow>(
    `insert into audits (company_id, website_snapshot_id, agent_run_id, prompt_version, model, findings, rubric, commercial, summary)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [
      a.companyId,
      a.snapshotId,
      a.agentRunId,
      a.promptVersion,
      a.model,
      JSON.stringify(a.findings),
      JSON.stringify(a.rubric),
      JSON.stringify({ ...(a.commercial as object), design_era: a.designEra ?? null }),
      a.summary,
    ],
  );
  return rows[0]!;
}

/** Neuestes Audit einer Firma samt Inhalts-Hash des zugehörigen Snapshots. */
export async function latestAudit(
  db: DbClient,
  companyId: string,
): Promise<(AuditRow & { content_hash: string | null }) | null> {
  const { rows } = await db.query<AuditRow & { content_hash: string | null }>(
    `select a.*, w.content_hash from audits a
       left join website_snapshots w on w.id = a.website_snapshot_id
      where a.company_id = $1 order by a.created_at desc limit 1`,
    [companyId],
  );
  return rows[0] ?? null;
}

export interface LeadScoreRow {
  id: string;
  company_id: string;
  audit_id: string | null;
  scoring_version: string;
  total: number;
  breakdown: unknown;
  knocked_out: boolean;
  knockout_reason: string | null;
  created_at: Date;
}

/** Pipeline-Status, die der Score setzen darf. Vertriebsstatus (ab READY_FOR_CONTACT) setzt nur Christian. */
const SCORABLE: readonly CompanyStatus[] = ["NEW", "RESEARCHED", "AUDITED", "QUALIFIED", "SKIPPED", "FAILED"];

/**
 * Score speichern und Firma aktualisieren (Status, aktueller Score, Recheck), in einer Transaktion.
 * Firmen im Vertrieb behalten ihren Status; nur der aktuelle Score wird nachgeführt.
 */
export async function saveLeadScore(
  db: Db,
  s: {
    companyId: string;
    auditId: string | null;
    version: string;
    total: number;
    breakdown: unknown;
    knockedOut: boolean;
    knockoutReason: string | null;
    status: "QUALIFIED" | "SKIPPED";
    skipReason: string | null;
    skipDetail: string | null;
    recheckAfter: Date | null;
  },
): Promise<LeadScoreRow> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<LeadScoreRow>(
      `insert into lead_scores (company_id, audit_id, scoring_version, total, breakdown, knocked_out, knockout_reason)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [
        s.companyId,
        s.auditId,
        s.version,
        s.total,
        JSON.stringify(s.breakdown),
        s.knockedOut,
        s.knockoutReason,
      ],
    );
    const score = rows[0]!;
    await tx.query(
      `update companies set
         current_score = $2, current_score_id = $3, updated_at = now(),
         status = case when status = any($4::text[]) then $5 else status end,
         skip_reason = case when status = any($4::text[]) then $6 else skip_reason end,
         skip_detail = case when status = any($4::text[]) then $7 else skip_detail end,
         recheck_after = case when status = any($4::text[]) then $8 else recheck_after end
       where id = $1`,
      [s.companyId, s.total, score.id, SCORABLE, s.status, s.skipReason, s.skipDetail, s.recheckAfter],
    );
    return score;
  });
}

export async function latestLeadScore(db: DbClient, companyId: string): Promise<LeadScoreRow | null> {
  const { rows } = await db.query<LeadScoreRow>(
    "select * from lead_scores where company_id = $1 order by created_at desc limit 1",
    [companyId],
  );
  return rows[0] ?? null;
}

export async function markAudited(db: DbClient, companyId: string): Promise<void> {
  await db.query(
    `update companies set status = 'AUDITED', updated_at = now() where id = $1 and status in ('NEW', 'RESEARCHED')`,
    [companyId],
  );
}

export interface PitchRow {
  id: string;
  company_id: string;
  lead_score_id: string | null;
  main_opportunity: string;
  arguments: string[];
  opening_line: string | null;
  model: string;
  created_at: Date;
}

export async function insertPitch(
  db: DbClient,
  p: {
    companyId: string;
    leadScoreId: string | null;
    agentRunId: string | null;
    promptVersion: string;
    model: string;
    mainOpportunity: string;
    arguments: string[];
    openingLine: string | null;
  },
): Promise<PitchRow> {
  const { rows } = await db.query<PitchRow>(
    `insert into pitches (company_id, lead_score_id, agent_run_id, prompt_version, model, main_opportunity, arguments, opening_line)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [
      p.companyId,
      p.leadScoreId,
      p.agentRunId,
      p.promptVersion,
      p.model,
      p.mainOpportunity,
      JSON.stringify(p.arguments),
      p.openingLine,
    ],
  );
  return rows[0]!;
}

export async function latestPitch(db: DbClient, companyId: string): Promise<PitchRow | null> {
  const { rows } = await db.query<PitchRow>(
    "select * from pitches where company_id = $1 order by created_at desc limit 1",
    [companyId],
  );
  return rows[0] ?? null;
}

export interface LatestPlaces {
  rating: number | null;
  review_count: number | null;
  business_status: string | null;
  photo_count: number | null;
}

export async function latestPlacesSnapshot(db: DbClient, companyId: string): Promise<LatestPlaces | null> {
  const { rows } = await db.query<{ rating: string | null } & Omit<LatestPlaces, "rating">>(
    `select rating, review_count, business_status, photo_count from places_snapshots
      where company_id = $1 order by fetched_at desc limit 1`,
    [companyId],
  );
  const r = rows[0];
  return r ? { ...r, rating: r.rating === null ? null : Number(r.rating) } : null;
}

export async function contactsOf(
  db: DbClient,
  companyId: string,
): Promise<
  { name: string | null; role: string | null; email: string | null; phone: string | null; source: string }[]
> {
  const { rows } = await db.query<{
    name: string | null;
    role: string | null;
    email: string | null;
    phone: string | null;
    source: string;
  }>("select name, role, email, phone, source from contacts where company_id = $1 order by created_at", [
    companyId,
  ]);
  return rows;
}

/** Neuester erfolgreicher Crawl (ohne Fehler). */
export async function latestOkSnapshotId(db: DbClient, companyId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `select id from website_snapshots where company_id = $1 and error is null order by fetched_at desc limit 1`,
    [companyId],
  );
  return rows[0]?.id ?? null;
}
