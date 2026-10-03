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
  branch_key: string | null;
  phone: string | null;
  website_url: string | null;
  segment: "WEBSITE" | "NO_WEBSITE" | null;
  status: CompanyStatus;
  skip_reason: string | null;
  skip_detail: string | null;
  current_score: number | null;
  current_score_id: string | null;
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

export type ResearchOutcome =
  | { status: "RESEARCHED"; branchKey: string | null }
  | { status: "SKIPPED"; skipReason: string; skipDetail: string; branchKey?: string | null };

/**
 * Ergebnis von Gate/Prefilter festhalten. `recheckAfter` kommt aus den Recheck-Regeln.
 * Ein vorhandener Branchen-Schlüssel wird nur durch einen neuen, bekannten Schlüssel ersetzt.
 */
export async function setResearchOutcome(
  db: DbClient,
  companyId: string,
  outcome: ResearchOutcome,
  recheckAfter: Date | null,
): Promise<Company> {
  const skipped = outcome.status === "SKIPPED";
  const { rows } = await db.query<Company>(
    `update companies set
       status = $2,
       skip_reason = $3,
       skip_detail = $4,
       branch_key = coalesce($5, branch_key),
       recheck_after = $6,
       updated_at = now()
     where id = $1
     returning *`,
    [
      companyId,
      outcome.status,
      skipped ? outcome.skipReason : null,
      skipped ? outcome.skipDetail : null,
      outcome.branchKey ?? null,
      recheckAfter,
    ],
  );
  if (!rows[0]) throw new Error(`Firma ${companyId} nicht gefunden`);
  return rows[0];
}

/** Schritt fehlgeschlagen: FAILED mit Meldung, erneuter Versuch ab `recheckAfter` (config/recheck.yaml → failed). */
export async function setFailed(
  db: DbClient,
  companyId: string,
  detail: string,
  recheckAfter: Date | null,
): Promise<void> {
  // Qualifizierte Leads und Leads im Vertrieb bleiben, was sie sind (z. B. Website beim Neu-Crawlen kurz weg).
  await db.query(
    `update companies set status = 'FAILED', skip_detail = $2, recheck_after = $3, updated_at = now()
      where id = $1 and status in ('NEW', 'RESEARCHED', 'AUDITED', 'SKIPPED', 'FAILED')`,
    [companyId, detail, recheckAfter],
  );
}

/** Die "Website" ist nur ein Social-Media-Profil: für Avelio gilt die Firma als ohne Website. */
export async function markNoWebsite(db: DbClient, companyId: string): Promise<void> {
  await db.query(`update companies set segment = 'NO_WEBSITE', updated_at = now() where id = $1`, [
    companyId,
  ]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Firma über ID, Place-ID oder Domain finden (für die CLI). */
export async function findCompany(db: DbClient, ref: string): Promise<Company | null> {
  const r = ref.trim();
  if (UUID.test(r)) {
    const { rows } = await db.query<Company>("select * from companies where id = $1", [r]);
    return rows[0] ?? null;
  }
  const domain = domainIdentity(r);
  const { rows } = await db.query<Company>(
    "select * from companies where place_id = $1 or ($2::text is not null and domain = $2) limit 1",
    [r, domain],
  );
  return rows[0] ?? null;
}

/** Firmen, die Gate und Prefilter bestanden haben, eine Website haben und noch nie gecrawlt wurden. */
export async function companiesToCrawl(db: DbClient, limit: number): Promise<Company[]> {
  const { rows } = await db.query<Company>(
    `select c.* from companies c
      where c.status = 'RESEARCHED' and c.segment = 'WEBSITE' and c.website_url is not null
        and not exists (select 1 from website_snapshots w where w.company_id = c.id)
      order by c.first_seen_at
      limit $1`,
    [limit],
  );
  return rows;
}

/** Erfolgreicher Crawl nach früherem Fehlschlag: zurück in die Pipeline. */
export async function clearCrawlFailure(db: DbClient, companyId: string): Promise<void> {
  await db.query(
    `update companies set status = 'RESEARCHED', skip_detail = null, recheck_after = null, updated_at = now()
      where id = $1 and status = 'FAILED'`,
    [companyId],
  );
}

/** Firmen, die gecrawlt (oder ohne Website) und noch nicht bewertet sind. */
export async function companiesToAudit(db: DbClient, limit: number): Promise<Company[]> {
  const { rows } = await db.query<Company>(
    `select c.* from companies c
      where c.status in ('RESEARCHED', 'AUDITED')
        and (c.segment = 'NO_WEBSITE'
             or exists (select 1 from website_snapshots w where w.company_id = c.id and w.error is null))
      order by c.first_seen_at
      limit $1`,
    [limit],
  );
  return rows;
}

/** Alle Firmen mit gespeichertem Score (für erneutes Scoren nach Gewichtsänderung). */
export async function companiesWithScore(db: DbClient): Promise<Company[]> {
  const { rows } = await db.query<Company>(
    "select * from companies where current_score_id is not null order by current_score desc nulls last",
  );
  return rows;
}
