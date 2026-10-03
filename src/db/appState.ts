import type { DbClient } from "./client.js";

export async function getState<T>(db: DbClient, key: string): Promise<T | null> {
  const { rows } = await db.query<{ value: T }>("select value from app_state where key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setState(db: DbClient, key: string, value: unknown): Promise<void> {
  await db.query(
    `insert into app_state (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/** Setzt den Schlüssel nur, wenn er noch nicht existiert. `true` = dieser Aufrufer war der erste. */
export async function claimState(db: DbClient, key: string, value: unknown): Promise<boolean> {
  const { rowCount } = await db.query(
    "insert into app_state (key, value) values ($1, $2) on conflict (key) do nothing",
    [key, JSON.stringify(value)],
  );
  return rowCount === 1;
}
