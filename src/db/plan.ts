import type { DbClient } from "./client.js";

/** Tagesplan des Morgen-Pakets (migrations/013). */

export type PlanKind = "new" | "followup";
export type PlanChannel = "email" | "letter" | "phone";
export type PlanStatus = "ready" | "queued" | "done" | "later" | "dropped";

export interface PlanItem {
  id: string;
  plan_date: string;
  company_id: string;
  kind: PlanKind;
  channel: PlanChannel;
  draft_id: string | null;
  status: PlanStatus;
  position: number;
  done_at: Date | null;
  send_after: Date | null;
}

export interface PlanItemWithCompany extends PlanItem {
  company_name: string;
  current_score: number | null;
  website_url: string | null;
}

export async function addPlanItem(
  db: DbClient,
  item: { date: string; companyId: string; kind: PlanKind; channel: PlanChannel; draftId: string | null },
): Promise<PlanItem | null> {
  const { rows } = await db.query<PlanItem>(
    `insert into outreach_plan (plan_date, company_id, kind, channel, draft_id, position)
     values ($1, $2, $3, $4, $5, (select coalesce(max(position), 0) + 1 from outreach_plan where plan_date = $1))
     on conflict (plan_date, company_id) do nothing
     returning *`,
    [item.date, item.companyId, item.kind, item.channel, item.draftId],
  );
  return rows[0] ?? null;
}

export async function planItems(db: DbClient, date: string): Promise<PlanItemWithCompany[]> {
  const { rows } = await db.query<PlanItemWithCompany>(
    `select p.*, p.plan_date::text as plan_date, c.name as company_name, c.current_score, c.website_url
       from outreach_plan p join companies c on c.id = p.company_id
      where p.plan_date = $1 order by p.position`,
    [date],
  );
  return rows;
}

export async function planItem(db: DbClient, id: string): Promise<PlanItemWithCompany | null> {
  const { rows } = await db.query<PlanItemWithCompany>(
    `select p.*, p.plan_date::text as plan_date, c.name as company_name, c.current_score, c.website_url
       from outreach_plan p join companies c on c.id = p.company_id where p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function setPlanStatus(db: DbClient, id: string, status: PlanStatus, now: Date): Promise<void> {
  await db.query("update outreach_plan set status = $2, done_at = $3 where id = $1", [
    id,
    status,
    status === "ready" ? null : now,
  ]);
}

export async function setPlanDraft(db: DbClient, id: string, draftId: string): Promise<void> {
  await db.query("update outreach_plan set draft_id = $2 where id = $1", [id, draftId]);
}

export interface PlanCounts {
  phone: { done: number; total: number };
  email: { done: number; total: number };
  letter: { done: number; total: number };
  followup: { done: number; total: number };
}

/** Fortschritt für den Kopf der Nachricht ("3/12 Mails …"); Späterlegte und Aussortierte zählen nicht mit. */
export function countPlan(items: readonly PlanItem[]): PlanCounts {
  const bucket = (pred: (i: PlanItem) => boolean) => {
    const all = items.filter((i) => pred(i) && i.status !== "dropped" && i.status !== "later");
    return { done: all.filter((i) => i.status === "done").length, total: all.length };
  };
  return {
    phone: bucket((i) => i.channel === "phone"),
    email: bucket((i) => i.kind === "new" && i.channel === "email"),
    letter: bucket((i) => i.kind === "new" && i.channel === "letter"),
    followup: bucket((i) => i.kind === "followup"),
  };
}
