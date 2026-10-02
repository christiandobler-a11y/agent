import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import pg from "pg";

export type Db = pg.Pool;
export type DbClient = pg.Pool | pg.PoolClient;

export interface DbOptions {
  /** Optionaler Schema-Name (nur für Tests: jede Testdatei bekommt ein eigenes Schema). */
  schema?: string;
  max?: number;
  /** TLS-Einstellung; Standard: `tlsFor(connectionString)`. */
  ssl?: ConnectionOptions;
}

/** Öffentliches Root-Zertifikat von Supabase ("Supabase Root 2021 CA", gültig bis 2031). */
export const SUPABASE_CA_PATH = new URL("../../config/certs/supabase-prod-ca-2021.crt", import.meta.url)
  .pathname;

const SUPABASE_HOST = /(^|\.)supabase\.(co|com)$/i;

/**
 * TLS-Einstellung für eine Verbindungs-URL. Ohne Angabe verbindet `pg` unverschlüsselt; für Supabase
 * erzwingen wir deshalb TLS mit Zertifikatsprüfung gegen die Supabase-CA. Steht `sslmode` (oder `ssl`)
 * in der URL, gilt diese Angabe und wir mischen uns nicht ein.
 */
export function tlsFor(connectionString: string): ConnectionOptions | undefined {
  const url = new URL(connectionString);
  if (url.searchParams.has("sslmode") || url.searchParams.has("ssl")) return undefined;
  if (!SUPABASE_HOST.test(url.hostname)) return undefined;
  return { ca: readFileSync(SUPABASE_CA_PATH, "utf8"), rejectUnauthorized: true };
}

export function createDb(connectionString: string, options: DbOptions = {}): Db {
  const ssl = options.ssl ?? tlsFor(connectionString);
  const pool = new pg.Pool({
    connectionString,
    ...(ssl ? { ssl } : {}),
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
