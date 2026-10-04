import type { DbClient } from "./client.js";
import type { Channel, Interaction } from "./crm.js";

/** Kontakt-Entwürfe (interactions.type = 'draft', Zusatzdaten in meta, migrations/010). */

export interface DraftMeta {
  subject?: string;
  to?: string | null;
  /** Angebotene Termine (ISO, UTC). */
  slots?: string[];
  [key: string]: unknown;
}

export async function insertDraft(
  db: DbClient,
  companyId: string,
  d: { channel: Channel; body: string; meta: DraftMeta; by: string; now: Date },
): Promise<Interaction & { meta: DraftMeta }> {
  const { rows } = await db.query<Interaction & { meta: DraftMeta }>(
    `insert into interactions (company_id, type, channel, body, meta, created_by, created_at)
     values ($1, 'draft', $2, $3, $4, $5, $6) returning *`,
    [companyId, d.channel, d.body, JSON.stringify(d.meta), d.by, d.now],
  );
  return rows[0]!;
}

/**
 * Wie vielen offenen Leads ist ein künftiger Termin gerade angeboten? Zählt Entwürfe der letzten 14 Tage von Firmen,
 * die noch nicht gewonnen oder verloren sind; mehrere Entwürfe derselben Firma zählen einmal.
 */
export async function takenSlots(db: DbClient, now: Date): Promise<Map<string, number>> {
  const { rows } = await db.query<{ slot: string; n: number }>(
    // Bestätigte Termine (gesendete Bestätigung) sind für alle belegt.
    `select s.slot,
            (count(distinct i.company_id) + 1000 * count(*) filter (where i.meta ? 'termin' and i.meta ? 'sent_at'))::int as n
       from interactions i
       join companies c on c.id = i.company_id
       cross join lateral jsonb_array_elements_text(coalesce(i.meta->'slots', '[]'::jsonb)) as s(slot)
      where i.type = 'draft' and i.created_at > $1::timestamptz - interval '14 days'
        and c.status not in ('WON', 'LOST') and s.slot::timestamptz > $1
      group by s.slot`,
    [now],
  );
  return new Map(rows.map((r) => [new Date(r.slot).toISOString(), r.n]));
}
