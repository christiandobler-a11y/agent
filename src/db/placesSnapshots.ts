import type { DbClient } from "./client.js";

export interface PlacesSnapshotInput {
  companyId: string;
  rating: number | null;
  reviewCount: number | null;
  businessStatus: string | null;
  photoCount: number | null;
  raw: unknown;
}

/** Zeitgestempelte Momentaufnahme der Google-Daten (ARCHITECTURE.md 12.4), getrennt von eigenen Daten. */
export async function insertPlacesSnapshot(db: DbClient, s: PlacesSnapshotInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into places_snapshots (company_id, rating, review_count, business_status, photo_count, raw)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [s.companyId, s.rating, s.reviewCount, s.businessStatus, s.photoCount, JSON.stringify(s.raw)],
  );
  return rows[0]!.id;
}
