import type { DbClient } from "./client.js";

/** Abdeckung je Region × Branche × Suchgebiet (migrations/008_search_coverage.sql). */

export interface CoverageRow {
  region_key: string;
  subject: string;
  tile_key: string;
  search_run_id: string | null;
  results: number;
  pages: number;
  saturated: boolean;
  searched_at: Date;
}

export async function upsertCoverage(
  db: DbClient,
  c: {
    regionKey: string;
    subject: string;
    tileKey: string;
    searchRunId: string | null;
    results: number;
    pages: number;
    saturated: boolean;
    searchedAt: Date;
  },
): Promise<void> {
  await db.query(
    `insert into search_coverage (region_key, subject, tile_key, search_run_id, results, pages, saturated, searched_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (region_key, subject, tile_key) do update set
       search_run_id = excluded.search_run_id, results = excluded.results, pages = excluded.pages,
       saturated = excluded.saturated, searched_at = excluded.searched_at`,
    [c.regionKey, c.subject, c.tileKey, c.searchRunId, c.results, c.pages, c.saturated, c.searchedAt],
  );
}

export async function coverageRows(
  db: DbClient,
  regionKey: string,
  subject?: string,
): Promise<CoverageRow[]> {
  const { rows } = await db.query<CoverageRow>(
    `select * from search_coverage where region_key = $1 and ($2::text is null or subject = $2)`,
    [regionKey, subject ?? null],
  );
  return rows;
}
