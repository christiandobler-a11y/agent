import { expect, it, describe } from "vitest";
import { createDb, tlsFor } from "../src/db/client.js";
import { describeDb, TEST_DATABASE_URL } from "./helpers/db.js";

const SUPABASE = "postgresql://postgres.abc:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres";

describe("tlsFor", () => {
  it("erzwingt für Supabase TLS mit Prüfung gegen die Supabase-CA", () => {
    const tls = tlsFor(SUPABASE);
    expect(tls?.rejectUnauthorized).toBe(true);
    expect(tls?.ca).toContain("BEGIN CERTIFICATE");
    expect(tlsFor("postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres")).toBeDefined();
  });

  it("lässt lokale Verbindungen und ausdrückliche sslmode-Angaben unverändert", () => {
    expect(tlsFor("postgres://avelio:avelio@localhost:5432/avelio")).toBeUndefined();
    expect(tlsFor(`${SUPABASE}?sslmode=disable`)).toBeUndefined();
    expect(tlsFor("postgres://u:p@evil-supabase.com.example.org/db")).toBeUndefined();
  });
});

describeDb("createDb mit TLS", () => {
  it("reicht die TLS-Einstellung an pg weiter (lokaler Server ohne TLS lehnt ab)", async () => {
    // Gleiche Datenbank, aber mit Supabase-TLS-Einstellung: muss am fehlenden TLS scheitern statt unverschlüsselt zu verbinden.
    const db = createDb(TEST_DATABASE_URL!, { max: 1, ssl: tlsFor(SUPABASE)! });
    await expect(db.query("select 1")).rejects.toThrow(/SSL/i);
    await db.end();
  });
});
