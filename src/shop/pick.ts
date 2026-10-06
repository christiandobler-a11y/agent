import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";
import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";

/**
 * Laden der Woche (06.10.2026, Christian): ein Laden in der Nähe mit schwacher Website und guten Google-Bewertungen,
 * den Christian besucht. Vorschläge stehen in `shop_picks`; ein Laden kommt nie zweimal.
 */

const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"] as const;

export const shopConfigSchema = z.object({
  aktiv: z.boolean().default(true),
  tag: z.enum(WEEKDAYS),
  ab: z.string().regex(/^\d\d:\d\d$/),
  branchen: z.array(z.string()).min(1),
  umkreis_km: z.number().positive(),
  min_bewertung: z.number().min(0).max(5),
  min_bewertungen: z.number().int().min(0),
});

export type ShopConfig = z.infer<typeof shopConfigSchema>;

export const loadShopConfig = (): ShopConfig => loadYamlConfig("laden.yaml", shopConfigSchema);

/** Ist jetzt (deutsche Zeit) der Tag für den Vorschlag und die Uhrzeit erreicht? Rein. */
export function shopDue(c: ShopConfig, weekday: number, time: string): boolean {
  return c.aktiv && WEEKDAYS[weekday] === c.tag && time >= c.ab;
}

/** Kalenderwoche nach ISO ("2026-W41"), für einen Vorschlag je Woche. Rein. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export interface ShopCandidate extends Company {
  rating: number | null;
  review_count: number | null;
  distance_km: number | null;
}

/**
 * Bester noch nie vorgeschlagener Laden: qualifiziert (schwache Website), passende Branche, im Umkreis, gut bewertet.
 * Reihenfolge: höchster Score (größte Chance), dann Bewertungen.
 */
export async function pickShop(
  db: Db,
  c: ShopConfig,
  home: { lat: number; lng: number },
): Promise<ShopCandidate | null> {
  const { rows } = await db.query<ShopCandidate>(
    `with p as (
       select distinct on (company_id) company_id, rating, review_count from places_snapshots
        order by company_id, fetched_at desc
     ), d as (
       select c.*, p.rating, p.review_count,
              111.32 * sqrt(power(c.lat::float - $2, 2) + power(cos(radians($2)) * (c.lng::float - $3), 2))
                as distance_km
         from companies c left join p on p.company_id = c.id
        where c.status in ('QUALIFIED', 'READY_FOR_CONTACT') and c.branch_key = any($1)
          and c.website_url is not null and c.lat is not null
          and not exists (select 1 from shop_picks s where s.company_id = c.id)
     )
     select * from d
      where distance_km <= $4 and coalesce(rating, 0) >= $5 and coalesce(review_count, 0) >= $6
      order by current_score desc nulls last, review_count desc nulls last
      limit 1`,
    [c.branchen, home.lat, home.lng, c.umkreis_km, c.min_bewertung, c.min_bewertungen],
  );
  return rows[0] ?? null;
}

export interface ShopPick {
  id: string;
  company_id: string;
  week: string;
  status: "vorgeschlagen" | "genommen" | "abgelehnt" | "besucht";
  briefing: unknown;
  chosen: number | null;
}

export async function insertPick(db: Db, companyId: string, week: string): Promise<ShopPick> {
  const { rows } = await db.query<ShopPick>(
    "insert into shop_picks (company_id, week) values ($1, $2) returning *",
    [companyId, week],
  );
  return rows[0]!;
}

export async function getPick(db: Db, id: string): Promise<ShopPick | null> {
  const { rows } = await db.query<ShopPick>("select * from shop_picks where id = $1", [id]);
  return rows[0] ?? null;
}

export async function setPick(
  db: Db,
  id: string,
  patch: { status?: ShopPick["status"]; briefing?: unknown; chosen?: number },
  now: Date,
): Promise<void> {
  await db.query(
    `update shop_picks set status = coalesce($2, status), briefing = coalesce($3, briefing),
            chosen = coalesce($4, chosen), decided_at = $5 where id = $1`,
    [
      id,
      patch.status ?? null,
      patch.briefing === undefined ? null : JSON.stringify(patch.briefing),
      patch.chosen ?? null,
      now,
    ],
  );
}

/** Zuletzt gewählte Designrichtungen (Name und Idee), damit neue Briefings sich davon absetzen. */
export async function usedDirections(db: Db, limit = 20): Promise<{ name: string; idee: string }[]> {
  const { rows } = await db.query<{ d: { name: string; idee: string } | null }>(
    `select briefing->'richtungen'->chosen as d from shop_picks
      where chosen is not null and briefing is not null order by decided_at desc limit $1`,
    [limit],
  );
  return rows.flatMap((r) => (r.d ? [{ name: r.d.name, idee: r.d.idee }] : []));
}
