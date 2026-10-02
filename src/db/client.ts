import pg from "pg";

export type Db = pg.Pool;
export type DbClient = pg.Pool | pg.PoolClient;

export interface DbOptions {
  /** Optionaler Schema-Name (nur für Tests: jede Testdatei bekommt ein eigenes Schema). */
  schema?: string;
  max?: number;
}

export function createDb(connectionString: string, options: DbOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    ...(options.schema ? { options: `-c search_path=${options.schema},public` } : {}),
  });
  // Ohne Listener beendet ein Verbindungsabbruch im Leerlauf den ganzen Prozess.
  pool.on("error", (err) => {
    console.error(
      JSON.stringify({ level: "error", msg: "Postgres-Verbindung verloren", error: err.message }),
    );
  });
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
