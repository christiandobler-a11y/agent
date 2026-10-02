import type pg from "pg";
import { domainIdentity, normalizeName, normalizePostalCode } from "../pipeline/research/identity.js";
import { withTransaction, type Db, type DbClient } from "./client.js";

export const COMPANY_STATUSES = [
  "NEW",
  "RESEARCHED",
  "AUDITED",
  "QUALIFIED",
  "SKIPPED",
  "FAILED",
  "READY_FOR_CONTACT",
  "CONTACTED",
  "REPLIED",
  "INTERESTED",
  "PROTOTYPE",
  "WON",
  "LOST",
] as const;

export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export interface Company {
  id: string;
  name: string;
  name_normalized: string;
  place_id: string | null;
  domain: string | null;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  region: string | null;
  category: string | null;
  phone: string | null;
  website_url: string | null;
  segment: "WEBSITE" | "NO_WEBSITE" | null;
  status: CompanyStatus;
  skip_reason: string | null;
  recheck_after: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  first_search_run_id: string | null;
}

/** Eine Firma, wie sie aus der Recherche (z. B. Google Places) kommt. */
export interface CompanyCandidate {
  name: string;
  placeId?: string | null;
  websiteUrl?: string | null;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  region?: string | null;
  lat?: number | null;
  lng?: number | null;
  category?: string | null;
  phone?: string | null;
  searchRunId?: string | null;
}

export type MatchedBy = "place_id" | "domain" | "name_postal";

export interface UpsertResult {
  company: Company;
  created: boolean;
  matchedBy: MatchedBy | null;
}

/** Mindest-Ähnlichkeit (pg_trgm) für den Abgleich über Name + PLZ. */
export const NAME_SIMILARITY_THRESHOLD = 0.8;

interface IdentityKeys {
  placeId: string | null;
  domain: string | null;
  nameNormalized: string;
  postalCode: string | null;
}

export function identityKeys(c: CompanyCandidate): IdentityKeys {
  return {
    placeId: c.placeId?.trim() || null,
    domain: domainIdentity(c.websiteUrl),
    nameNormalized: normalizeName(c.name),
    postalCode: normalizePostalCode(c.postalCode),
  };
}

/**
 * Sucht eine bekannte Firma in fester Reihenfolge: Place-ID → Domain → Name + PLZ (unscharf).
 * Beim Namensabgleich zählen Firmen mit einer *anderen* Place-ID nicht als Treffer, denn Google führt
 * sie dann als getrennte Orte.
 */
export async function findMatch(
  db: DbClient,
  keys: IdentityKeys,
): Promise<{ company: Company; matchedBy: MatchedBy } | null> {
  if (keys.placeId) {
    const { rows } = await db.query<Company>("select * from companies where place_id = $1", [keys.placeId]);
    if (rows[0]) return { company: rows[0], matchedBy: "place_id" };
  }
  if (keys.domain) {
    const { rows } = await db.query<Company>("select * from companies where domain = $1", [keys.domain]);
    if (rows[0]) return { company: rows[0], matchedBy: "domain" };
  }
  if (keys.postalCode) {
    const { rows } = await db.query<Company>(
      `select * from companies
        where postal_code = $2
          and similarity(name_normalized, $1) >= $3
          and ($4::text is null or place_id is null or place_id = $4)
        order by similarity(name_normalized, $1) desc
        limit 1`,
      [keys.nameNormalized, keys.postalCode, NAME_SIMILARITY_THRESHOLD, keys.placeId],
    );
    if (rows[0]) return { company: rows[0], matchedBy: "name_postal" };
  }
  return null;
}

async function insertCompany(tx: pg.PoolClient, c: CompanyCandidate, keys: IdentityKeys): Promise<Company> {
  const { rows } = await tx.query<Company>(
    `insert into companies (
       name, name_normalized, place_id, domain, street, postal_code, city, region, lat, lng,
       category, phone, website_url, segment, first_search_run_id
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning *`,
    [
      c.name.trim(),
      keys.nameNormalized,
      keys.placeId,
      keys.domain,
      c.street ?? null,
      keys.postalCode,
      c.city ?? null,
      c.region ?? null,
      c.lat ?? null,
      c.lng ?? null,
      c.category ?? null,
      c.phone ?? null,
      c.websiteUrl?.trim() || null,
      c.websiteUrl?.trim() ? "WEBSITE" : "NO_WEBSITE",
      c.searchRunId ?? null,
    ],
  );
  return rows[0]!;
}

/**
 * Bekannte Firma: nur `last_seen_at` aktualisieren und fehlende Schlüssel/Stammdaten ergänzen.
 * Vorhandene Werte werden nie überschrieben. Ein Schlüssel, der schon zu einer anderen Firma gehört,
 * wird nicht übernommen.
 */
async function touchCompany(tx: pg.PoolClient, existing: Company, c: CompanyCandidate, keys: IdentityKeys) {
  const { rows } = await tx.query<Company>(
    `update companies set
       last_seen_at = now(),
       updated_at = now(),
       place_id = coalesce(place_id,
         (select $2::text where not exists (select 1 from companies where place_id = $2))),
       domain = coalesce(domain,
         (select $3::text where not exists (select 1 from companies where domain = $3))),
       website_url = coalesce(website_url, $4),
       segment = case when website_url is null and $4::text is not null then 'WEBSITE' else segment end,
       postal_code = coalesce(postal_code, $5),
       street = coalesce(street, $6),
       city = coalesce(city, $7),
       phone = coalesce(phone, $8),
       category = coalesce(category, $9)
     where id = $1
     returning *`,
    [
      existing.id,
      keys.placeId,
      keys.domain,
      c.websiteUrl?.trim() || null,
      keys.postalCode,
      c.street ?? null,
      c.city ?? null,
      c.phone ?? null,
      c.category ?? null,
    ],
  );
  return rows[0]!;
}

const UNIQUE_VIOLATION = "23505";

/**
 * Legt eine Firma an oder erkennt sie als bekannt. Idempotent und sicher bei parallelen Jobs:
 * Verliert ein Insert das Rennen gegen einen parallelen Job (Unique-Index), wird erneut abgeglichen.
 */
export async function upsertCompany(db: Db, candidate: CompanyCandidate): Promise<UpsertResult> {
  if (!candidate.name.trim()) throw new Error("Firma ohne Namen");
  const keys = identityKeys(candidate);

  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(db, async (tx) => {
        const match = await findMatch(tx, keys);
        if (match) {
          const company = await touchCompany(tx, match.company, candidate, keys);
          return { company, created: false, matchedBy: match.matchedBy };
        }
        return { company: await insertCompany(tx, candidate, keys), created: true, matchedBy: null };
      });
    } catch (err) {
      if (attempt === 0 && (err as { code?: string }).code === UNIQUE_VIOLATION) continue;
      throw err;
    }
  }
}
