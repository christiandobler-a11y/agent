import { withTransaction, type Db, type DbClient } from "./client.js";
import type { Company, CompanyStatus } from "./companies.js";
import type { SalesStatus } from "../crm/status.js";

/** Mini-CRM: Statuswechsel, Notizen, Erinnerungen (Tabelle interactions, migrations/009). */

export type InteractionType = "status" | "note" | "reminder" | "draft";
export type Channel = "email" | "letter" | "phone" | "visit" | "other";

export interface Interaction {
  id: string;
  company_id: string;
  type: InteractionType;
  channel: Channel | null;
  body: string | null;
  from_status: CompanyStatus | null;
  to_status: CompanyStatus | null;
  due_at: Date | null;
  done_at: Date | null;
  notified_at: Date | null;
  created_by: string;
  created_at: Date;
}

const DAY = 86_400_000;

/**
 * Vertriebsstatus setzen und protokollieren (eine Transaktion). Bei "kontaktiert" wird eine Nachfass-Erinnerung
 * angelegt, falls noch keine offen ist. Rückgabe: Firma nach dem Wechsel und ggf. die neue Erinnerung.
 */
export async function setSalesStatus(
  db: Db,
  companyId: string,
  status: SalesStatus,
  opts: { by: string; note?: string | null; channel?: Channel | null; now: Date; followUpDays: number },
): Promise<{ company: Company; reminder: Interaction | null }> {
  return withTransaction(db, async (tx) => {
    const { rows: before } = await tx.query<Company>("select * from companies where id = $1 for update", [
      companyId,
    ]);
    if (!before[0]) throw new Error("Firma nicht gefunden");
    const { rows } = await tx.query<Company>(
      `update companies set status = $2, skip_reason = null, skip_detail = null, recheck_after = null, updated_at = now()
        where id = $1 returning *`,
      [companyId, status],
    );
    await tx.query(
      `insert into interactions (company_id, type, channel, body, from_status, to_status, created_by, created_at)
       values ($1, 'status', $2, $3, $4, $5, $6, $7)`,
      [companyId, opts.channel ?? null, opts.note ?? null, before[0].status, status, opts.by, opts.now],
    );
    let reminder: Interaction | null = null;
    if (status === "CONTACTED" && opts.followUpDays > 0 && !(await hasOpenReminder(tx, companyId))) {
      reminder = await insertReminder(tx, companyId, {
        dueAt: new Date(opts.now.getTime() + opts.followUpDays * DAY),
        text: "Nachfassen: noch keine Antwort?",
        by: "system",
        now: opts.now,
      });
    }
    // Abgeschlossene Leads brauchen keine offenen Erinnerungen mehr.
    if (status === "WON" || status === "LOST") {
      await tx.query(
        "update interactions set done_at = $2 where company_id = $1 and type = 'reminder' and done_at is null",
        [companyId, opts.now],
      );
    }
    return { company: rows[0]!, reminder };
  });
}

async function hasOpenReminder(db: DbClient, companyId: string): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from interactions where company_id = $1 and type = 'reminder' and done_at is null limit 1",
    [companyId],
  );
  return rows.length > 0;
}

async function insertReminder(
  db: DbClient,
  companyId: string,
  r: { dueAt: Date; text: string; by: string; now: Date },
): Promise<Interaction> {
  const { rows } = await db.query<Interaction>(
    `insert into interactions (company_id, type, body, due_at, created_by, created_at)
     values ($1, 'reminder', $2, $3, $4, $5) returning *`,
    [companyId, r.text, r.dueAt, r.by, r.now],
  );
  return rows[0]!;
}

export async function addReminder(
  db: DbClient,
  companyId: string,
  r: { dueAt: Date; text: string; by: string; now: Date },
): Promise<Interaction> {
  return insertReminder(db, companyId, r);
}

export async function addNote(
  db: DbClient,
  companyId: string,
  n: { text: string; by: string; now: Date; channel?: Channel | null },
): Promise<Interaction> {
  const { rows } = await db.query<Interaction>(
    `insert into interactions (company_id, type, channel, body, created_by, created_at)
     values ($1, 'note', $2, $3, $4, $5) returning *`,
    [companyId, n.channel ?? null, n.text, n.by, n.now],
  );
  return rows[0]!;
}

/** Fällige, noch nicht zugestellte Erinnerungen samt Firma. */
export async function dueReminders(
  db: DbClient,
  now: Date,
): Promise<(Interaction & { company_name: string })[]> {
  const { rows } = await db.query<Interaction & { company_name: string }>(
    `select i.*, c.name as company_name from interactions i join companies c on c.id = i.company_id
      where i.type = 'reminder' and i.done_at is null and i.notified_at is null and i.due_at <= $1
      order by i.due_at`,
    [now],
  );
  return rows;
}

export async function markNotified(db: DbClient, ids: string[], now: Date): Promise<void> {
  if (ids.length > 0)
    await db.query("update interactions set notified_at = $2 where id = any($1::uuid[])", [ids, now]);
}

export async function completeReminder(db: DbClient, id: string, now: Date): Promise<Interaction | null> {
  const { rows } = await db.query<Interaction>(
    "update interactions set done_at = $2 where id = $1 and type = 'reminder' returning *",
    [id, now],
  );
  return rows[0] ?? null;
}

/** Erinnerung verschieben: neuer Termin, wird erneut zugestellt. */
export async function snoozeReminder(
  db: DbClient,
  id: string,
  days: number,
  now: Date,
): Promise<Interaction | null> {
  const { rows } = await db.query<Interaction>(
    `update interactions set due_at = $2, notified_at = null, done_at = null
      where id = $1 and type = 'reminder' returning *`,
    [id, new Date(now.getTime() + days * DAY)],
  );
  return rows[0] ?? null;
}

export async function interactionById(db: DbClient, id: string): Promise<Interaction | null> {
  const { rows } = await db.query<Interaction>("select * from interactions where id = $1", [id]);
  return rows[0] ?? null;
}

export async function companyHistory(db: DbClient, companyId: string, limit = 10): Promise<Interaction[]> {
  const { rows } = await db.query<Interaction>(
    "select * from interactions where company_id = $1 order by created_at desc limit $2",
    [companyId, limit],
  );
  return rows;
}

export async function openReminders(
  db: DbClient,
  companyId?: string,
): Promise<(Interaction & { company_name: string })[]> {
  const { rows } = await db.query<Interaction & { company_name: string }>(
    `select i.*, c.name as company_name from interactions i join companies c on c.id = i.company_id
      where i.type = 'reminder' and i.done_at is null and ($1::uuid is null or i.company_id = $1)
      order by i.due_at`,
    [companyId ?? null],
  );
  return rows;
}

/** Firmen im Vertrieb je Status (für /pipeline). */
export async function salesPipeline(db: DbClient): Promise<Company[]> {
  const { rows } = await db.query<Company>(
    `select * from companies
      where status in ('READY_FOR_CONTACT', 'CONTACTED', 'REPLIED', 'INTERESTED', 'PROTOTYPE', 'WON', 'LOST')
      order by updated_at desc`,
  );
  return rows;
}
