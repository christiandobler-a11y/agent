import type { DbClient } from "./client.js";

export type SearchRunStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface SearchRun {
  id: string;
  requested_by: string;
  query: Record<string, unknown>;
  target_count: number;
  status: SearchRunStatus;
  stats: Record<string, unknown>;
  created_at: Date;
  finished_at: Date | null;
}

export async function createSearchRun(
  db: DbClient,
  run: { requestedBy: string; query: Record<string, unknown>; targetCount: number },
): Promise<SearchRun> {
  const { rows } = await db.query<SearchRun>(
    `insert into search_runs (requested_by, query, target_count) values ($1, $2, $3) returning *`,
    [run.requestedBy, JSON.stringify(run.query), run.targetCount],
  );
  return rows[0]!;
}

/** Zwischenstand speichern (läuft weiter). */
export async function updateSearchRunStats(db: DbClient, id: string, stats: object): Promise<void> {
  await db.query(`update search_runs set stats = $2 where id = $1`, [id, JSON.stringify(stats)]);
}

export async function finishSearchRun(
  db: DbClient,
  id: string,
  status: Exclude<SearchRunStatus, "RUNNING">,
  stats: object,
): Promise<void> {
  await db.query(`update search_runs set status = $2, stats = $3, finished_at = now() where id = $1`, [
    id,
    status,
    JSON.stringify(stats),
  ]);
}
