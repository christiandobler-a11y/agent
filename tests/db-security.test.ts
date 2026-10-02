import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { dbStatus } from "../src/db/status.js";
import { describeDb, TEST_DATABASE_URL } from "./helpers/db.js";

/**
 * Nachbau der Supabase-Ausgangslage: Rollen anon/authenticated mit Standardrechten auf neue Tabellen.
 * Danach muss Migration 002 den Zugriff über die Data API sperren.
 */
describeDb("Migration 002 sperrt die Supabase-Data-API", () => {
  const schema = `test_sec_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  let db: Db;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    for (const role of ["anon", "authenticated"]) {
      // Rollen gelten für den ganzen Cluster; parallele Testläufe dürfen sich nicht stören.
      await admin.query(`create role ${role} nologin`).catch((err: { code?: string }) => {
        if (err.code !== "42710" && err.code !== "23505") throw err;
      });
    }
    await admin.query(`create schema ${schema}`);
    await admin.query(`grant usage on schema ${schema} to anon, authenticated`);
    await admin.query(
      `alter default privileges in schema ${schema} grant all on tables to anon, authenticated`,
    );
    await admin.end();
    db = createDb(TEST_DATABASE_URL!, { schema, max: 2 });
    await migrate(db);
  });

  afterAll(async () => {
    await db?.end();
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  });

  it("alle Tabellen haben RLS, anon darf nichts lesen", async () => {
    const status = await dbStatus(db);
    expect(status.schema).toBe(schema);
    expect(status.migrations.map((m) => m.version)).toEqual(
      expect.arrayContaining([
        "001_init",
        "002_lock_down_data_api",
        "003_api_usage_and_costs",
        "005_pitches",
      ]),
    );
    expect(status.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "companies",
        "search_runs",
        "agent_runs",
        "places_snapshots",
        "schema_migrations",
      ]),
    );
    for (const t of status.tables) {
      expect(t, t.name).toMatchObject({ rls: true, anonCanRead: false, rows: expect.any(Number) as number });
    }
  });

  it("auch die Kostenansicht ist für anon gesperrt", async () => {
    const { rows } = await db.query<{ ok: boolean }>(
      "select has_table_privilege('anon', 'v_costs_daily', 'select') as ok",
    );
    expect(rows[0]!.ok).toBe(false);
  });

  it("auch später angelegte Tabellen sind für anon gesperrt", async () => {
    await db.query("create table later_table (id int)");
    const { rows } = await db.query<{ ok: boolean }>(
      "select has_table_privilege('anon', 'later_table', 'select') as ok",
    );
    expect(rows[0]!.ok).toBe(false);
  });

  it("die App (Tabellen-Eigentümer) kann trotz RLS lesen und schreiben", async () => {
    await db.query("insert into search_runs (requested_by, query, target_count) values ('test', '{}', 1)");
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from search_runs");
    expect(rows[0]!.n).toBe(1);
  });
});
