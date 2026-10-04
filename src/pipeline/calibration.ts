import type { Db } from "../db/client.js";
import { nextToRate, ratedCompanies, ratingCounts, type Grade } from "../db/calibration.js";
import type { Company } from "../db/companies.js";
import { latestPlacesSnapshot, type LatestPlaces } from "../db/leads.js";
import { scoreInputFor, type LeadDeps } from "./audit/run.js";
import type { GoldenEntry } from "./scoring/calibration.js";

/** Golden Set aus der Datenbank: bewertete Firmen mit ihrer aktuellen Score-Eingabe. */
export async function loadGoldenEntries(deps: LeadDeps): Promise<GoldenEntry[]> {
  const entries: GoldenEntry[] = [];
  for (const c of await ratedCompanies(deps.db)) {
    const { input } = await scoreInputFor(deps, c);
    if (input.segment === "WEBSITE" && !input.audit) continue; // ohne Audit kein vergleichbarer Score
    entries.push({
      company_id: c.id,
      name: c.name,
      branch_key: c.branch_key,
      city: c.city,
      website: c.website_url,
      grade: c.grade,
      input,
    });
  }
  return entries;
}

export interface RatingCard {
  company: Company;
  places: LatestPlaces | null;
  counts: Record<Grade, number>;
}

/** Nächste Firma für die Bewertung samt Google-Daten und Fortschritt, `null` wenn alle bewertet sind. */
export async function nextRatingCard(
  db: Db,
  branches?: readonly string[] | null,
): Promise<RatingCard | null> {
  const company = await nextToRate(db, branches);
  if (!company) return null;
  return { company, places: await latestPlacesSnapshot(db, company.id), counts: await ratingCounts(db) };
}
