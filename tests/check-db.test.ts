import { expect, it } from "vitest";
import { checkDatabase } from "../src/config/check.js";
import { describeDb, TEST_DATABASE_URL } from "./helpers/db.js";

describeDb("checkDatabase", () => {
  it("funktioniert auch auf einer Datenbank ohne schema_migrations (vor dem ersten migrate)", async () => {
    // Die Tests migrieren nur eigene Schemas; im public-Schema der Test-DB fehlt die Tabelle.
    expect(await checkDatabase(TEST_DATABASE_URL!)).toMatch(
      /^Postgres \d+[\d.]*.*, \d+ Migration\(en\) angewendet$/,
    );
  });
});
