import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { upsertCompany, type Company } from "../src/db/companies.js";
import { insertPlacesSnapshot } from "../src/db/placesSnapshots.js";
import { replaceImpressumContacts } from "../src/db/contacts.js";
import { insertWebsiteSnapshot } from "../src/db/websiteSnapshots.js";
import type { LlmGateway, StructuredRequest } from "../src/llm/gateway.js";
import { explainStoredLead } from "../src/pipeline/audit/explainStored.js";
import { fitScale, prepareAuditImages } from "../src/pipeline/audit/images.js";
import {
  auditCompany,
  auditFacts,
  pitchCompany,
  scoreCompany,
  type LeadDeps,
} from "../src/pipeline/audit/run.js";
import type { AuditOutput } from "../src/pipeline/audit/schema.js";
import type { CrawlConfig } from "../src/pipeline/crawl/config.js";
import { loadBranches } from "../src/pipeline/research/branches.js";
import { loadScoringConfig } from "../src/pipeline/scoring/config.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const dir = mkdtempSync(join(tmpdir(), "avelio-audit-"));
const desktop = join(dir, "d.jpg");
const mobile = join(dir, "m.jpg");

beforeAll(async () => {
  const solid = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: "#c0ffee" } });
  await solid(1440, 2700).jpeg().toFile(desktop);
  await solid(780, 5064).jpeg().toFile(mobile);
});

const crawl = {
  desktop: { width: 1440, height: 900, scale: 1 },
  mobile: { width: 390, height: 844, scale: 2 },
} as CrawlConfig;

describe("Bilder fürs Audit", () => {
  it("drei Ausschnitte, jeweils höchstens 1.568 px Kante und ~1,15 MP", async () => {
    const images = await prepareAuditImages({
      desktopPath: desktop,
      mobilePath: mobile,
      desktopScreenPx: 900,
      mobileScreenPx: 1688,
    });
    expect(images.map((i) => i.label)).toEqual([
      "Desktop, erster Bildschirm",
      "Desktop, Seite bis zu drei Bildschirmhöhen",
      "Smartphone, erste zwei Bildschirme",
    ]);
    for (const img of images) {
      expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1568);
      expect(img.width * img.height).toBeLessThanOrEqual(1_160_000);
      expect(Buffer.from(img.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    }
    expect(images[0]!.width / images[0]!.height).toBeCloseTo(1440 / 900, 1); // erster Bildschirm, nur verkleinert
  });

  it("fitScale vergrößert nie", () => {
    expect(fitScale(400, 300)).toBe(1);
    expect(fitScale(3000, 1000)).toBeCloseTo(1568 / 3000);
  });
});

const rubric = (score: number) => ({ score, evidence: "sichtbar im Screenshot" });
const AUDIT: AuditOutput = {
  summary: "Veraltete Seite, starke Firma.",
  design_era: "ca. 2013",
  rubric: {
    design_age: rubric(1),
    mobile_ux: rubric(1),
    cta_clarity: rubric(2),
    services_visibility: rubric(2),
    trust_signals: rubric(2),
    hero_message: rubric(1),
  },
  findings: [1, 2, 3].map((i) => ({
    title: `Problem ${i}`,
    detail: "kostet Anfragen",
    evidence: "Screenshot",
    severity: "high" as const,
    category: "mobile" as const,
  })),
  commercial: {
    services: ["Verkauf", "Werkstatt"],
    high_value_services: ["E-Bike-Leasing", "E-Bike-Verkauf"],
    size_signals: ["Team mit 6 Personen"],
    team_size: "medium",
  },
};
const PITCH = {
  main_opportunity: "Starke Bewertungen, schwache Website.",
  arguments: ["a", "b", "c"],
  opening_line: "Hallo",
};

function fakeLlm() {
  const structured = vi.fn((req: StructuredRequest<never>) =>
    Promise.resolve({
      output: (req.role === "audit" ? AUDIT : PITCH) as never,
      agentRunId: null as unknown as string,
      costUsd: req.role === "audit" ? 0.04 : 0.03,
      model: req.role === "audit" ? "claude-sonnet-5-5" : "claude-opus-5-5",
    }),
  );
  return { llm: { structured } as unknown as LlmGateway, structured };
}

describeDb("Audit → Score → Pitch", () => {
  const db = useTestDb();
  const deps = (llm: LlmGateway): LeadDeps => ({
    db: db(),
    llm,
    crawl,
    scoring: loadScoringConfig(),
    branches: loadBranches(),
    recheck: {
      qualified: 90,
      failed: 7,
      skipped: { default: 180, reputation: 365, website_good: 180, low_score: 180 },
    },
    now: () => new Date("2026-10-02T12:00:00Z"),
  });

  let n = 0;
  async function lead(
    opts: { website?: boolean; rating?: number; reviews?: number; hash?: string } = {},
  ): Promise<Company> {
    n++;
    const { company } = await upsertCompany(db(), {
      name: `Radhaus ${n}`,
      placeId: `p-${n}`,
      websiteUrl: opts.website === false ? null : `https://radhaus-${n}.de/`,
      postalCode: "83022",
      city: "Rosenheim",
    });
    await db().query("update companies set status = 'RESEARCHED', branch_key = 'fahrrad' where id = $1", [
      company.id,
    ]);
    await insertPlacesSnapshot(db(), {
      companyId: company.id,
      rating: opts.rating ?? 4.8,
      reviewCount: opts.reviews ?? 170,
      businessStatus: "OPERATIONAL",
      photoCount: 10,
      raw: {},
    });
    if (opts.website !== false) {
      await insertWebsiteSnapshot(db(), {
        companyId: company.id,
        url: `https://radhaus-${n}.de/`,
        finalUrl: `https://radhaus-${n}.de/`,
        httpStatus: 200,
        https: true,
        facts: {
          https: true,
          tls_valid: true,
          has_viewport_meta: false,
          tel_links: [],
          has_contact_form: false,
          copyright_year: 2014,
          layout_tables: 1,
          cms: "IONOS MyWebsite",
          impressum: { person: "Max Rad" },
        },
        psi: { performance: 21 },
        screenshotDesktop: desktop,
        screenshotMobile: mobile,
        contentHash: opts.hash ?? `hash-${n}`,
        textExcerpt: "Willkommen beim Radhaus",
      });
      await replaceImpressumContacts(db(), company.id, [
        { name: "Max Rad", role: "Inhaber", email: "max@radhaus.de", phone: "08031 1" },
      ]);
    }
    return (await db().query<Company>("select * from companies where id = $1", [company.id])).rows[0]!;
  }
  const row = async (id: string) =>
    (await db().query<Company>("select * from companies where id = $1", [id])).rows[0]!;

  it("auditiert mit Bildern und Fakten, scort hoch, erstellt Pitch und setzt QUALIFIED", async () => {
    const { llm, structured } = fakeLlm();
    const c = await lead();
    const a = await auditCompany(deps(llm), c);
    expect(a.kind).toBe("audited");
    const req = structured.mock.calls[0]![0];
    expect(req.role).toBe("audit");
    const blocks = req.input as { type: string; text?: string }[];
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(3);
    const facts = blocks.find((b) => b.text?.startsWith("<fakten>"))!.text!;
    expect(facts).toContain('"pagespeed_mobil":{"performance":21}');
    expect(facts).not.toContain("Max Rad"); // keine Personendaten ans Audit
    expect((await row(c.id)).status).toBe("AUDITED");

    const scored = await scoreCompany(deps(llm), c);
    expect(scored.result.total).toBeGreaterThanOrEqual(80);
    expect(await row(c.id)).toMatchObject({
      status: "QUALIFIED",
      current_score: scored.result.total,
      skip_reason: null,
    });
    const pitch = await pitchCompany(deps(llm), c, scored);
    expect(pitch).toMatchObject({
      main_opportunity: PITCH.main_opportunity,
      arguments: ["a", "b", "c"],
      model: "claude-opus-5-5",
    });

    const text = await explainStoredLead(db(), await row(c.id));
    expect(text).toMatch(/^Radhaus \d+ – \d+\/100 \(Scoring v2/);
    expect(text).toContain("audit (claude-sonnet-5-5");
    expect(text).toContain("Hauptchance (claude-opus-5-5): Starke Bewertungen, schwache Website.");
  });

  it("gleicher Inhalts-Hash → Audit wird wiederverwendet (kein LLM-Aufruf)", async () => {
    const { llm, structured } = fakeLlm();
    const c = await lead({ hash: "gleich" });
    await auditCompany(deps(llm), c);
    await insertWebsiteSnapshot(db(), {
      companyId: c.id,
      url: "x",
      screenshotDesktop: desktop,
      screenshotMobile: mobile,
      contentHash: "gleich",
      facts: {},
    });
    const again = await auditCompany(deps(llm), c);
    expect(again.kind).toBe("reused");
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it("Knock-out speichert Grund und Recheck; Vertriebsstatus wird nie überschrieben", async () => {
    const { llm } = fakeLlm();
    const weak = await lead({ rating: 2.2, reviews: 40 });
    await auditCompany(deps(llm), weak);
    const r = await scoreCompany(deps(llm), weak);
    expect(r.result.knockout?.reason).toBe("reputation");
    expect(await row(weak.id)).toMatchObject({
      status: "SKIPPED",
      skip_reason: "reputation",
      skip_detail: "Reputation zu schwach (2,2★ bei 40 Bewertungen)",
    });
    expect((await row(weak.id)).recheck_after).toBeInstanceOf(Date);
    expect(await pitchCompany(deps(llm), weak, r)).toBeNull();

    const sales = await lead();
    await auditCompany(deps(llm), sales);
    await db().query("update companies set status = 'CONTACTED' where id = $1", [sales.id]);
    const s = await scoreCompany(deps(llm), await row(sales.id));
    expect(await row(sales.id)).toMatchObject({ status: "CONTACTED", current_score: s.result.total });
  });

  it("ohne Website: kein Audit, Score mit voller Website-Chance", async () => {
    const { llm, structured } = fakeLlm();
    const c = await lead({ website: false });
    await db().query("update companies set segment = 'NO_WEBSITE' where id = $1", [c.id]);
    const nw = await row(c.id);
    expect(await auditCompany(deps(llm), nw)).toEqual({ kind: "no_website" });
    const r = await scoreCompany(deps(llm), nw);
    expect(r.result.dimensions.find((d) => d.key === "website")!.points).toBe(45); // v2: volle Website-Chance
    expect(structured).not.toHaveBeenCalled();
  });

  it("Score ohne Audit (Website vorhanden) ist ein Fehler, nicht stillschweigend 0", async () => {
    const { llm } = fakeLlm();
    const c = await lead();
    await expect(scoreCompany(deps(llm), c)).rejects.toThrow(/kein Audit/);
  });

  it("auditFacts gibt keine Impressum-Personendaten weiter", () => {
    const f = auditFacts({
      url: "u",
      final_url: null,
      facts: { title: "T", impressum: { person: "X" }, mailto_links: ["a@b.de"] },
      psi: null,
    } as never);
    expect(f).toMatchObject({ title: "T", impressum_gefunden: true, mailto_vorhanden: true });
    expect(JSON.stringify(f)).not.toContain("a@b.de");
  });
});
