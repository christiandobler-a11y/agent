import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe } from "vitest";
import pg from "pg";
import { createDb, type Db } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL && process.env.CI) {
  throw new Error("TEST_DATABASE_URL muss in der CI gesetzt sein, sonst laufen die DB-Tests nicht.");
}

/** `describe` für Tests, die eine echte Postgres-Datenbank brauchen. Lokal ohne DB übersprungen. */
export const describeDb = describe.skipIf(!TEST_DATABASE_URL);

/**
 * Legt für die aufrufende Testdatei ein frisches Schema an, migriert es und räumt danach auf.
 * Gibt einen Getter zurück, weil die Verbindung erst in `beforeAll` entsteht.
 */
export function useTestDb(): () => Db {
  const schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let db: Db | undefined;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await admin.end();
    db = createDb(TEST_DATABASE_URL!, { schema, max: 5 });
    await migrate(db);
  });

  afterAll(async () => {
    await db?.end();
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  });

  return () => {
    if (!db) throw new Error("Test-DB noch nicht bereit");
    return db;
  };
}
