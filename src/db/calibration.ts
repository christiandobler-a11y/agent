import type { DbClient } from "./client.js";
import type { Company } from "./companies.js";

/** Kalibrier-Bewertungen (ARCHITECTURE.md 7.4): Christians A/B/C je Firma, X = übersprungen. */

export const GRADES = ["A", "B", "C", "X"] as const;
export type Grade = (typeof GRADES)[number];

export interface CalibrationRating {
  company_id: string;
  grade: Grade;
  note: string | null;
  rated_at: Date;
}

export async function setRating(
  db: DbClient,
  r: { companyId: string; grade: Grade; note?: string | null; chatId?: number | null },
): Promise<void> {
  await db.query(
    `insert into calibration_ratings (company_id, grade, note, chat_id) values ($1, $2, $3, $4)
     on conflict (company_id) do update
       set grade = excluded.grade, note = coalesce(excluded.note, calibration_ratings.note),
           chat_id = excluded.chat_id, rated_at = now()`,
    [r.companyId, r.grade, r.note ?? null, r.chatId ?? null],
  );
}

/** Alle bewerteten Firmen (ohne X), bestbewertete Note zuerst. */
export async function ratedCompanies(db: DbClient): Promise<(Company & { grade: "A" | "B" | "C" })[]> {
  const { rows } = await db.query<Company & { grade: "A" | "B" | "C" }>(
    `select c.*, r.grade from calibration_ratings r join companies c on c.id = r.company_id
      where r.grade <> 'X' order by r.grade, c.name`,
  );
  return rows;
}

export async function ratingCounts(db: DbClient): Promise<Record<Grade, number>> {
  const { rows } = await db.query<{ grade: Grade; n: string }>(
    "select grade, count(*) as n from calibration_ratings group by grade",
  );
  const counts: Record<Grade, number> = { A: 0, B: 0, C: 0, X: 0 };
  for (const r of rows) counts[r.grade] = Number(r.n);
  return counts;
}

/**
 * Nächste Firma zum Bewerten: hat einen Score, ist noch nicht bewertet. Für eine gute Mischung kommt zuerst die
 * Branche mit den wenigsten Bewertungen dran, innerhalb der Branche zufällig.
 */
export async function nextToRate(db: DbClient): Promise<Company | null> {
  const { rows } = await db.query<Company>(
    `with per_branch as (
       select coalesce(c.branch_key, '') as branch, count(*) as n
         from calibration_ratings r join companies c on c.id = r.company_id group by 1
     )
     select c.* from companies c
       left join per_branch p on p.branch = coalesce(c.branch_key, '')
      where c.current_score_id is not null
        and not exists (select 1 from calibration_ratings r where r.company_id = c.id)
      order by coalesce(p.n, 0), random()
      limit 1`,
  );
  return rows[0] ?? null;
}
