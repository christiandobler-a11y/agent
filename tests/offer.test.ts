import { describe, expect, it, vi } from "vitest";
import { upsertCompany } from "../src/db/companies.js";
import {
  createLexwareQuotation,
  createOffer,
  grossSplit,
  LexwareError,
  lexwareArticles,
  offerCopyParts,
  loadOfferConfig,
  offerSalutation,
  quotationBody,
} from "../src/outreach/offer.js";
import {
  crmCallback,
  lexwareSetupMessage,
  offerCopyMessage,
  parseCrmCallback,
} from "../src/telegram/format.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const c = loadOfferConfig();
const input = {
  paket: "onepager",
  now: new Date("2026-10-04T10:00:00Z"),
  company: { name: "Physio Test", street: "Hauptstr. 1", postalCode: "82362", city: "Weilheim" },
  salutation: "Sehr geehrte Frau Heider,",
};

describe("Angebot (rein)", () => {
  it("Preise sind Endpreise inkl. 19 % MwSt.", () => {
    expect(c.pakete.onepager!.preis_brutto).toBe(990);
    expect(c.pakete.mehrseitig!.preis_brutto).toBe(1290);
    expect(c.hosting.preis_monat_brutto).toBe(29.9);
    expect(grossSplit(990, 19)).toEqual({ net: 831.93, vat: 158.07 });
  });

  it("Anrede förmlich, Geschlecht nur wenn angegeben", () => {
    expect(offerSalutation({ name: "Christina Heider", salutation: "Frau" })).toBe(
      "Sehr geehrte Frau Heider,",
    );
    expect(offerSalutation({ name: "Max Huber", salutation: null })).toBe("Guten Tag Max Huber,");
    expect(offerSalutation({ name: null, salutation: null })).toBe("Sehr geehrtes Praxisteam,");
  });

  it("Lexware-Entwurf: Brutto-Preis, Leistungen einzeln, Hosting/Fotos/Option als Text, Gültigkeit", () => {
    const body = quotationBody(c, input) as {
      voucherDate: string;
      expirationDate: string;
      address: Record<string, string>;
      lineItems: { type: string; name: string; description?: string; unitPrice?: Record<string, unknown> }[];
      taxConditions: { taxType: string };
      introduction: string;
      remark: string;
    };
    expect(body.taxConditions.taxType).toBe("gross");
    expect(body.voucherDate).toBe("2026-10-04T00:00:00.000+02:00");
    expect(body.expirationDate).toBe("2026-11-03T00:00:00.000+01:00");
    expect(body.address).toEqual({
      name: "Physio Test",
      street: "Hauptstr. 1",
      zip: "82362",
      city: "Weilheim",
      countryCode: "DE",
    });
    const [main, ...texts] = body.lineItems;
    expect(main).toMatchObject({
      type: "custom",
      name: "Neue Website (Onepager)",
      unitPrice: { currency: "EUR", grossAmount: 990, taxRatePercentage: 19 },
    });
    expect(main!.description).toContain("• SEO-Grundoptimierung");
    expect(texts.every((t) => t.type === "text")).toBe(true);
    expect(texts[0]!.name).toContain("29,90");
    expect(texts[0]!.description).toContain("erste Monat nach dem Livegang ist kostenlos");
    expect(texts.map((t) => t.name)).toContain("Was ich von Ihnen brauche");
    expect(texts.at(-1)!.description).toContain("KI-Telefonassistent");
    expect(body.introduction.startsWith("Sehr geehrte Frau Heider,")).toBe(true);
    expect(body.remark).toContain("50 % bei Auftrag, 50 % beim Livegang");
    expect(() => quotationBody(c, { ...input, paket: "gibtsnicht" })).toThrow();
  });

  it("API: Bearer-Schlüssel, Entwurf, verständliche Fehler", async () => {
    const ok = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ id: "q-1", resourceUri: "x" }), { status: 200 })),
    );
    expect(await createLexwareQuotation(ok as unknown as typeof fetch, "key", { a: 1 })).toBe("q-1");
    const [url, init] = ok.mock.calls[0]!;
    expect(url).toBe("https://api.lexware.io/v1/quotations");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key");
    const denied = () => Promise.resolve(new Response('{"message":"no"}', { status: 401 }));
    await expect(createLexwareQuotation(denied as unknown as typeof fetch, "key", {})).rejects.toThrow(
      LexwareError,
    );
    await expect(createLexwareQuotation(denied as unknown as typeof fetch, "key", {})).rejects.toThrow(
      /Schlüssel ungültig/,
    );
  });

  it("Ohne API: Artikel zur Einrichtung und Teile zum Kopieren, escaped", () => {
    const articles = lexwareArticles(c);
    expect(articles.map((a) => a.name)).toEqual([
      "Neue Website (Onepager)",
      "Neue Website (mehrseitig)",
      "Hosting und Pflege (monatlich)",
    ]);
    expect(articles[0]!.description).toContain("• SEO-Grundoptimierung");
    const parts = offerCopyParts(c, { ...input, company: { ...input.company, name: "Physio <A&B>" } });
    expect(parts.address).toBe("Physio <A&B>\nHauptstr. 1\n82362 Weilheim");
    expect(parts.introduction.startsWith("Sehr geehrte Frau Heider,\nvielen Dank")).toBe(true);
    expect(parts.article).toBe("Neue Website (Onepager)");
    expect(parts.remark).toContain("Fotos der Praxis");
    expect(parts.remark).toContain("KI-Telefonassistent");
    const msg = offerCopyMessage("Physio <A&B>", parts);
    expect(msg).toContain("Physio &lt;A&amp;B&gt;");
    expect(msg).not.toContain("<A&B>");
    expect(lexwareSetupMessage(articles)).toContain("<pre>");
  });

  it("Knöpfe auf der Lead-Karte", () => {
    const id = "0b9a3f0e-1111-4222-8333-444455556666";
    const cb = crmCallback({ kind: "offer", paket: "mehrseitig", companyId: id });
    expect(parseCrmCallback(cb)).toEqual({ kind: "offer", paket: "mehrseitig", companyId: id });
  });
});

describeDb("Angebot mit Datenbank", () => {
  const db = useTestDb();

  it("legt den Entwurf an, gibt den Lexware-Link zurück und vermerkt es im Verlauf", async () => {
    const { company } = await upsertCompany(db(), {
      name: "Christina Heider Physiotherapeutin",
      placeId: "offer-1",
    });
    const fetchFn = vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { introduction: string };
      expect(body.introduction.startsWith("Sehr geehrte Frau Heider,")).toBe(true);
      return Promise.resolve(new Response(JSON.stringify({ id: "abc-123" }), { status: 200 }));
    });
    const r = await createOffer(
      {
        db: db(),
        config: c,
        apiKey: "key",
        fetch: fetchFn as unknown as typeof fetch,
        now: () => new Date("2026-10-04T10:00:00Z"),
      },
      company,
      "mehrseitig",
      "test",
    );
    expect(r).toEqual({
      id: "abc-123",
      url: "https://app.lexware.de/permalink/quotations/edit/abc-123",
      gross: 1290,
    });
    const { rows } = await db().query<{ body: string }>(
      "select body from interactions where company_id = $1 and type = 'note'",
      [company.id],
    );
    expect(rows.map((x) => x.body.replace(/\u00a0/g, " "))).toEqual([
      "Angebot in Lexware angelegt (Entwurf): Neue Website (mehrseitig), 1.290,00 €",
    ]);
  });
});
