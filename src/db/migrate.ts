import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withTransaction, type Db } from "./client.js";

export const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url).pathname;

// Beliebige, feste Zahl: verhindert, dass zwei Prozesse gleichzeitig migrieren.
const LOCK_ID = 4_711_001;

interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(dir, file), "utf8");
      return {
        version: file.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

/**
 * Wendet alle noch nicht angewendeten Migrationen in Reihenfolge an, jede in eigener Transaktion.
 * Bereits angewendete Migrationen dürfen nicht nachträglich geändert werden (Prüfsumme).
 * Gibt die neu angewendeten Versionen zurück.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  const lock = await db.connect();
  try {
    await lock.query("select pg_advisory_lock($1)", [LOCK_ID]);
    await lock.query(`
      create table if not exists schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await lock.query<{ version: string; checksum: string }>(
      "select version, checksum from schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    const newlyApplied: string[] = [];
    for (const m of migrations) {
      const existing = applied.get(m.version);
      if (existing !== undefined) {
        if (existing !== m.checksum) {
          throw new Error(`Migration ${m.version} wurde nach dem Anwenden geändert. Neue Migration anlegen.`);
        }
        continue;
      }
      await withTransaction(db, async (tx) => {
        await tx.query(m.sql);
        await tx.query("insert into schema_migrations (version, checksum) values ($1, $2)", [
          m.version,
          m.checksum,
        ]);
      });
      newlyApplied.push(m.version);
    }
    return newlyApplied;
  } finally {
    await lock.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    lock.release();
  }
}
