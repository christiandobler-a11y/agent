import type { DbClient } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { domainIdentity } from "../pipeline/research/identity.js";

/**
 * Lead über eine Angabe aus dem Chat finden: ID (auch die ersten 8 Zeichen), Domain oder Namensteil.
 * Mehrdeutig → Kandidaten zurückgeben, damit der Manager nachfragen kann statt zu raten.
 */
export type LeadLookup =
  { kind: "found"; company: Company } | { kind: "ambiguous"; candidates: Company[] } | { kind: "none" };

export async function findLead(db: DbClient, ref: string): Promise<LeadLookup> {
  const r = ref.trim();
  if (!r) return { kind: "none" };
  if (/^[0-9a-f]{8}(-[0-9a-f-]{0,28})?$/i.test(r)) {
    const { rows } = await db.query<Company>("select * from companies where id::text like $1 limit 5", [
      `${r.toLowerCase()}%`,
    ]);
    if (rows.length === 1) return { kind: "found", company: rows[0]! };
    if (rows.length > 1) return { kind: "ambiguous", candidates: rows };
  }
  const domain = r.includes(".") ? domainIdentity(r) : null;
  if (domain) {
    const { rows } = await db.query<Company>("select * from companies where domain = $1", [domain]);
    if (rows[0]) return { kind: "found", company: rows[0] };
  }
  const { rows } = await db.query<Company>(
    `select * from companies where name ilike $1 or name_normalized ilike $2
      order by current_score desc nulls last limit 6`,
    [`%${r}%`, `%${r.toLowerCase()}%`],
  );
  const exact = rows.filter((c) => c.name.toLowerCase() === r.toLowerCase());
  if (exact.length === 1) return { kind: "found", company: exact[0]! };
  if (rows.length === 1) return { kind: "found", company: rows[0]! };
  if (rows.length > 1) return { kind: "ambiguous", candidates: rows };
  return { kind: "none" };
}

export const shortId = (id: string) => id.slice(0, 8);
