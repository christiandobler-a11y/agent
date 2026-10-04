import { describe, expect, it, vi } from "vitest";
import { upsertCompany } from "../src/db/companies.js";
import { insertAudit } from "../src/db/leads.js";
import { insertPlacesSnapshot } from "../src/db/placesSnapshots.js";
import type { LlmGateway, StructuredRequest } from "../src/llm/gateway.js";
import { loadOutreachConfig } from "../src/outreach/config.js";
import {
  complimentFact,
  draftEmail,
  mailtoLink,
  pickFindings,
  salutationLine,
  shortCompanyName,
  sanitizeDraftText,
  whatsappLink,
} from "../src/outreach/draft.js";
import { personFromCompanyName } from "../src/outreach/names.js";
import { duToIhr, lowerFirst, subjectFor } from "../src/outreach/form.js";
import { loadBranches } from "../src/pipeline/research/branches.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const outreach = loadOutreachConfig();
const finding = (
  severity: "high" | "medium" | "low",
  category: "mobile" | "design" | "technical",
  title: string,
) => ({
  title,
  detail: `${title} Detail`,
  evidence: "Screenshot mobil",
  severity,
  category,
});

describe("Entwurf (rein)", () => {
  it("ein starker Befund allein, sonst bis zu drei; Gesamteindruck vor Handy-Mängeln", () => {
    expect(
      pickFindings([
        finding("medium", "mobile", "a"),
        finding("high", "mobile", "b"),
        finding("high", "design", "c"),
      ]).map((f) => f.title),
    ).toEqual(["c"]);
    expect(
      pickFindings([
        finding("medium", "mobile", "a"),
        finding("medium", "design", "b"),
        finding("low", "technical", "c"),
        finding("low", "design", "d"),
      ]).map((f) => f.title),
    ).toEqual(["b", "a", "d"]);
    expect(pickFindings([])).toEqual([]);
  });

  it("Grußzeile aus dem Impressum, ohne Namen an das Team", () => {
    expect(salutationLine("sie", { name: "Monika Späth", salutation: "Frau" }, "x")).toBe(
      "Hallo Frau Späth,",
    );
    expect(salutationLine("sie", { name: "Kai Ernst", salutation: null }, "x")).toBe("Hallo Kai Ernst,");
    expect(salutationLine("du", { name: "Josef Kerscher", salutation: "Herr" }, "x")).toBe("Hallo Josef,");
    // Inhaberin im Firmennamen (ohne Geschlecht zu raten), Vorname auch hinten; sonst Team bzw. Team-Anrede der Branche.
    expect(
      salutationLine("sie", { name: null, salutation: null }, "Christina Heider Physiotherapeutin"),
    ).toBe("Hallo Christina Heider,");
    expect(salutationLine("sie", { name: null, salutation: null }, "Physiotherapie Pickelmann Mike")).toBe(
      "Hallo Mike Pickelmann,",
    );
    expect(
      salutationLine("sie", { name: null, salutation: null }, "Physio Vital", "Liebes Praxisteam,"),
    ).toBe("Liebes Praxisteam,");
    expect(personFromCompanyName("Franz Physio Murnau")).toBeNull();
    expect(personFromCompanyName("Salzmann am Salzstadel")).toBeNull();
    expect(personFromCompanyName("PHYSIOteam Rosenheim")).toBeNull();
    expect(salutationLine("sie", { name: null, salutation: null }, "Hotel Ariadne GmbH | Rosenheim")).toBe(
      "Hallo Team Hotel Ariadne,",
    );
    expect(shortCompanyName("Physio Aicher | Rosenheim")).toBe("Physio Aicher");
    expect(shortCompanyName("RADsyndikat GmbH")).toBe("RADsyndikat");
    expect(shortCompanyName('Gasthof - Hotel "Alt- Fürstätt"')).toBe("Gasthof Hotel Alt- Fürstätt");
    expect(shortCompanyName("Hotel Ariadne")).toBe("Hotel Ariadne");
  });

  it("Kompliment nur bei wirklich guter Bewertung", () => {
    expect(complimentFact({ rating: 4.8, review_count: 170, business_status: null, photo_count: null })).toBe(
      "4,8 Sterne bei 170 Google-Bewertungen",
    );
    expect(
      complimentFact({ rating: 4.1, review_count: 170, business_status: null, photo_count: null }),
    ).toBeNull();
    expect(
      complimentFact({ rating: 4.9, review_count: 5, business_status: null, photo_count: null }),
    ).toBeNull();
  });

  it("entfernt Gedankenstriche und Links, meldet Spam-Wörter", () => {
    const r = sanitizeDraftText(
      "Ihre Seite – ehrlich gesagt — ist alt, siehe https://x.de. Kostenloses Angebot!",
    );
    expect(r.text).toBe("Ihre Seite, ehrlich gesagt, ist alt, siehe. Kostenloses Angebot!");
    expect(r.warnings).toEqual(["Link entfernt", "Spam-Wort „Kostenloses“"]);
  });

  it("WhatsApp- und Mail-Links", () => {
    expect(whatsappLink("+49 151 1234 5678", "Hallo Christian")).toBe(
      "https://wa.me/4915112345678?text=Hallo%20Christian",
    );
    expect(whatsappLink("0151 12345678", "x")).toBe("https://wa.me/4915112345678?text=x");
    expect(mailtoLink("a@b.de", "Betreff ä", "Zeile 1\nZeile 2")).toBe(
      "mailto:a@b.de?subject=Betreff%20%C3%A4&body=Zeile%201%0AZeile%202",
    );
  });

  it("Ihr-Form aus Du-Texten, Betreff in der Du-Form, kleiner Anfang nach der Anrede", () => {
    for (const t of [
      ...outreach.kontaktweg.vorbereitet_du,
      outreach.kontaktweg.email_cta_du,
      ...outreach.termine.formulierungen_du,
    ]) {
      expect(duToIhr(t)).not.toMatch(/\b(du|dir|dich|dein)\b/);
    }
    expect(duToIhr("Hättest du Dienstag kurz Zeit?")).toBe("Hättet ihr Dienstag kurz Zeit?");
    expect(subjectFor("Kurze Frage zu Ihrer Website", "du")).toBe("Kurze Frage zu Eurer Website");
    expect(subjectFor("Ihr erster Eindruck online", "sie")).toBe("Ihr erster Eindruck online");
    expect(subjectFor("Ein Gedanke zu Ihrem Online-Auftritt", "ihr")).toBe(
      "Ein Gedanke zu Eurem Online-Auftritt",
    );
    expect(lowerFirst("Ich heiße Christian")).toBe("ich heiße Christian");
    expect(lowerFirst("Sie haben")).toBe("Sie haben");
  });
});

describeDb("E-Mail-Entwurf (Datenbank)", () => {
  const db = useTestDb();
  const NOW = new Date("2026-10-03T10:00:00Z");

  async function lead(name: string, branch: string, contactName: string | null) {
    const { company } = await upsertCompany(db(), {
      name,
      placeId: `d-${name}`,
      city: "Rosenheim",
      websiteUrl: `https://${name.replace(/\W/g, "").toLowerCase()}.de`,
    });
    const { rows: updated } = await db().query<typeof company>(
      "update companies set status = 'QUALIFIED', branch_key = $2 where id = $1 returning *",
      [company.id, branch],
    );
    await insertPlacesSnapshot(db(), {
      companyId: company.id,
      rating: 4.8,
      reviewCount: 170,
      businessStatus: "OPERATIONAL",
      photoCount: 5,
      raw: {},
    });
    await db().query(
      "insert into contacts (company_id, name, email, source) values ($1, $2, $3, 'impressum')",
      [company.id, contactName, `info@${company.id.slice(0, 6)}.de`],
    );
    await insertAudit(db(), {
      companyId: company.id,
      snapshotId: null,
      agentRunId: null,
      promptVersion: "v1",
      model: "test",
      findings: [
        finding("high", "mobile", "Telefonnummer nicht antippbar"),
        finding("low", "design", "Farben"),
      ],
      rubric: {},
      commercial: {},
      summary: "alt",
    });
    return updated[0]!;
  }

  const fakeLlm = (absatz: string) => {
    const structured = vi.fn((_req: StructuredRequest<never>) =>
      Promise.resolve({
        output: { absatz },
        agentRunId: "r",
        costUsd: 0.004,
        model: "m",
      }),
    );
    return { llm: { structured } as unknown as LlmGateway, structured };
  };
  const deps = (llm: LlmGateway, whatsapp: string | null = "+49 151 12345678") => ({
    db: db(),
    llm,
    outreach,
    branches: loadBranches(),
    now: () => NOW,
    contact: { whatsapp, phone: "0151 12345678" },
  });

  it("Sie-Form: Code setzt Betreff, Termine, WhatsApp, Gruß und Signatur; Befund und Kompliment gehen ans Modell", async () => {
    const c = await lead("Physio Kagerer", "physiotherapie", "Elisabeth Kagerer");
    const { llm, structured } = fakeLlm(
      "Ich heiße Christian und mache Online-Auftritte zeitgemäß. Auf dem Handy ist Ihre Nummer nicht antippbar – schade. Dabei haben Sie 4,8 Sterne.",
    );
    const d = await draftEmail(deps(llm), c, "test");
    if ("kind" in d) throw new Error("kein Entwurf");
    const input = JSON.parse(structured.mock.calls[0]![0].input as string) as Record<string, unknown>;
    expect(input).toMatchObject({
      anrede: "sie",
      befunde: [{ titel: "Telefonnummer nicht antippbar", schwere: "high" }],
      kompliment_fakt: "4,8 Sterne bei 170 Google-Bewertungen",
      einstiegssatz: outreach.einstieg,
    });
    expect(structured.mock.calls[0]![0].role).toBe("contact");
    expect(d.to).toMatch(/^info@/);
    expect(outreach.spamschutz.betreffe.map((b) => b.replace("{firma}", c.name))).toContain(d.subject);
    expect(d.body).toMatch(/^Hallo Elisabeth Kagerer,\n\nich heiße Christian/);
    expect(d.body).not.toMatch(/[–—]/);
    expect(d.body).toMatch(/(Hätten Sie|Passt Ihnen) \w+/);
    expect(d.body).toContain("https://wa.me/4915112345678?text=");
    expect(d.body).toMatch(/Christian Dobler\nAvelio, Peißenberg\n0151 12345678$/);
    expect(d.slots).toHaveLength(4);
    expect(d.warnings).toEqual([]);
    const { rows } = await db().query<{ type: string; meta: { slots: string[]; subject: string } }>(
      "select type, meta from interactions where company_id = $1",
      [c.id],
    );
    expect(rows[0]).toMatchObject({ type: "draft", meta: { subject: d.subject } });
    expect(rows[0]!.meta.slots).toEqual(d.slots);
  });

  it("Du-Branche ohne Ansprechpartner → Ihr-Form; fehlende WhatsApp-Nummer wird gemeldet", async () => {
    const c = await lead("Radl Team", "fahrrad", null);
    const { llm, structured } = fakeLlm(
      "Ich bin Christian und bring Websites auf den Stand von heute. Bei euch fehlt X. Dabei habt ihr 4,8 Sterne.",
    );
    const d = await draftEmail(deps(llm, null), c, "test");
    if ("kind" in d) throw new Error("kein Entwurf");
    const sent = JSON.parse(structured.mock.calls[0]![0].input as string) as Record<string, unknown>;
    expect(sent, JSON.stringify(sent)).toMatchObject({ anrede: "ihr" });
    expect(d.body).toMatch(/(Hättet ihr|Passt euch)/);
    expect(d.body).toContain("Am einfachsten antwortet ihr kurz auf diese Mail.");
    expect(d.body).not.toMatch(/\b(dir|du)\b/);
    expect(d.warnings).toContain("WhatsApp-Nummer fehlt (OUTREACH_WHATSAPP in der .env)");
  });

  it("ein Termin geht nie an mehr Leads als erlaubt (hier: höchstens 2)", async () => {
    const leads = [
      await lead("Praxis A", "physiotherapie", "A A"),
      await lead("Praxis B", "physiotherapie", "B B"),
      await lead("Praxis C", "physiotherapie", "C C"),
    ];
    const counts = new Map<string, number>();
    for (const c of leads) {
      const d = await draftEmail(
        {
          ...deps(fakeLlm("Ich heiße Christian. Befund. Kompliment mit Fakt und mehr Text.").llm),
          outreach: { ...outreach, termine: { ...outreach.termine, max_leads_je_termin: 2 } },
        },
        c,
        "test",
      );
      if ("kind" in d) throw new Error("kein Entwurf");
      for (const s of d.slots) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    // Die Praxis aus dem ersten Test zählt mit; trotzdem nie mehr als 2 offene Leads je Termin.
    const { rows } = await db().query<{ slot: string; n: number }>(
      `select s as slot, count(distinct company_id)::int as n from interactions, jsonb_array_elements_text(meta->'slots') s
        where type = 'draft' group by s`,
    );
    expect(Math.max(...rows.map((r) => r.n))).toBeLessThanOrEqual(2);
  });
});
