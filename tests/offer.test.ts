import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upsertCompany } from "../src/db/companies.js";
import {
  createOffer,
  loadOfferConfig,
  offerSalutation,
  offerTotals,
  renderOfferHtml,
} from "../src/outreach/offer.js";
import { crmCallback, parseCrmCallback } from "../src/telegram/format.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const c = loadOfferConfig();
const data = {
  number: "A-2026-001",
  date: new Date("2026-10-04T10:00:00Z"),
  paket: "onepager",
  company: { name: "Physio <Test>", street: "Hauptstr. 1", postalCode: "82362", city: "Weilheim" },
  salutation: "Sehr geehrte Frau Heider,",
  sender: {
    name: "Christian Dobler",
    line: "Avelio, Peißenberg",
    address: null,
    phone: "0151 1",
    email: null,
  },
};

describe("Angebot (rein)", () => {
  it("Preise netto plus 19 % MwSt., Pakete wie besprochen", () => {
    expect(offerTotals(c, "onepager")).toEqual({ net: 990, vat: 188.1, gross: 1178.1 });
    expect(offerTotals(c, "mehrseitig").net).toBe(1290);
    expect(c.hosting.preis_monat_netto).toBe(29.9);
  });

  it("Anrede förmlich, Geschlecht nur wenn angegeben", () => {
    expect(offerSalutation({ name: "Christina Heider", salutation: "Frau" })).toBe(
      "Sehr geehrte Frau Heider,",
    );
    expect(offerSalutation({ name: "Max Huber", salutation: null })).toBe("Guten Tag Max Huber,");
    expect(offerSalutation({ name: null, salutation: null })).toBe("Sehr geehrtes Praxisteam,");
  });

  it("Seite: Leistungen einzeln, Summen, Hosting, Fotos, Option, alles escaped", () => {
    const html = renderOfferHtml(data, c);
    expect(html).toContain("Physio &lt;Test&gt;");
    expect(html).toContain("SEO-Grundoptimierung");
    expect(html).toContain("990,00");
    expect(html).toContain("1.178,10");
    expect(html).toContain("29,90");
    expect(html).toContain("Der erste Monat nach dem Livegang ist kostenlos");
    expect(html).toContain("Fotos der Praxis und des Teams");
    expect(html).toContain("KI-Telefonassistent");
    expect(html).toContain("50 % bei Auftrag, 50 % beim Livegang");
    expect(html).toContain("Gültig bis: 03.11.2026");
    expect(html).not.toContain("<script");
    expect(() => renderOfferHtml({ ...data, paket: "gibtsnicht" }, c)).toThrow();
  });

  it("Knöpfe auf der Lead-Karte", () => {
    const id = "0b9a3f0e-1111-4222-8333-444455556666";
    const cb = crmCallback({ kind: "offer", paket: "mehrseitig", companyId: id });
    expect(parseCrmCallback(cb)).toEqual({ kind: "offer", paket: "mehrseitig", companyId: id });
  });
});

describeDb("Angebot mit Datenbank", () => {
  const db = useTestDb();

  it("legt PDF ab, nummeriert je Jahr fortlaufend und vermerkt es im Verlauf", async () => {
    const { company } = await upsertCompany(db(), {
      name: "Christina Heider Physiotherapeutin",
      placeId: "offer-1",
    });
    const dir = mkdtempSync(join(tmpdir(), "avelio-offer-"));
    const deps = {
      db: db(),
      render: (html: string) =>
        Promise.resolve({ pdf: Buffer.from(`%PDF ${html.length}`), png: Buffer.from("png") }),
      config: c,
      sender: data.sender,
      dir,
      now: () => new Date("2026-10-04T10:00:00Z"),
    };
    const a = await createOffer(deps, company, "onepager", "test");
    const b = await createOffer(deps, company, "mehrseitig", "test");
    expect([a.number, b.number]).toEqual(["A-2026-001", "A-2026-002"]);
    expect(existsSync(a.pdf)).toBe(true);
    expect(a.filename).toBe("Angebot-A-2026-001-christina-heider-physiotherapeutin.pdf");
    const { rows } = await db().query<{ body: string }>(
      "select body from interactions where company_id = $1 and type = 'note' order by created_at, body",
      [company.id],
    );
    expect(rows.map((r) => r.body.replace(/\u00a0/g, " "))).toEqual([
      "Angebot A-2026-001 erstellt: Neue Website (Onepager), 1.178,10 € brutto",
      "Angebot A-2026-002 erstellt: Neue Website (mehrseitig), 1.535,10 € brutto",
    ]);
  });
});
