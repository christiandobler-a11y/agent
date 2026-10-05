import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";
import { describeDb, useTestDb } from "./helpers/db.js";

describeDb("migrate", () => {
  const db = useTestDb();

  it("legt alle Tabellen aus dem Plan an", async () => {
    const { rows } = await db().query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = current_schema() order by 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "advisor_reports",
      "advisor_suggestions",
      "agent_runs",
      "api_usage",
      "app_state",
      "audits",
      "calibration_ratings",
      "companies",
      "contacts",
      "design_notes",
      "interactions",
      "lead_scores",
      "messages",
      "outreach_plan",
      "pitches",
      "places_snapshots",
      "prototypes",
      "schema_migrations",
      "search_coverage",
      "search_runs",
      "v_costs_daily",
      "website_snapshots",
    ]);
  });

  it("ist idempotent", async () => {
    expect(await migrate(db())).toEqual([]);
  });

  it("verweigert nachträglich geänderte Migrationen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "avelio-mig-"));
    const { readFile } = await import("node:fs/promises");
    const original = await readFile(join(MIGRATIONS_DIR, "001_init.sql"), "utf8");
    await writeFile(join(dir, "001_init.sql"), `${original}\n-- geändert`);
    await expect(migrate(db(), dir)).rejects.toThrow(/001_init wurde nach dem Anwenden geändert/);
  });

  it("erzwingt einen Grund bei SKIPPED", async () => {
    await expect(
      db().query("insert into companies (name, name_normalized, status) values ('X', 'x', 'SKIPPED')"),
    ).rejects.toThrow(/check constraint/);
  });
});
