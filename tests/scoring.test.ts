import { describe, expect, it } from "vitest";
import type { AuditOutput } from "../src/pipeline/audit/schema.js";
import { loadScoringConfig } from "../src/pipeline/scoring/config.js";
import { explainFull, explainScore } from "../src/pipeline/scoring/explain.js";
import { scoreLead, type ScoreInput } from "../src/pipeline/scoring/score.js";

const config = loadScoringConfig("v1"); // Briefing-Beispiele sind mit den Startgewichten (v1) gerechnet
const NOW = new Date("2026-10-02T12:00:00Z");

const rubric = (score: number) => ({ score, evidence: `Beleg ${score}` });
function audit(score: number, overrides: Partial<AuditOutput> = {}): AuditOutput {
  return {
    summary: "Zusammenfassung",
    design_era: "ca. 2014",
    rubric: {
      design_age: rubric(score),
      mobile_ux: rubric(score),
      cta_clarity: rubric(score),
      services_visibility: rubric(score),
      trust_signals: rubric(score),
      hero_message: rubric(score),
    },
    findings: [],
    commercial: { services: [], high_value_services: [], size_signals: [], team_size: "unknown" },
    ...overrides,
  };
}
const finding = (severity: "high" | "medium" | "low") => ({
  title: "Problem",
  detail: "Detail",
  evidence: "Screenshot",
  severity,
  category: "design" as const,
});

/** Firma A aus dem Briefing: 4,8★ bei 170 Bewertungen, Website ~2014, mobil schwach, kein CTA. */
const firmaA: ScoreInput = {
  segment: "WEBSITE",
  branchValue: 4,
  places: { rating: 4.8, reviewCount: 170, businessStatus: "OPERATIONAL", photoCount: 10 },
  site: {
    https: true,
    tls_valid: true,
    has_viewport_meta: false,
    mobile_too_wide: true,
    tel_links: [],
    has_contact_form: false,
    copyright_year: 2014,
    layout_tables: 1,
    cms: "IONOS MyWebsite",
  },
  psiPerformance: 21,
  audit: audit(1, {
    rubric: {
      design_age: rubric(1),
      mobile_ux: rubric(2),
      cta_clarity: rubric(2),
      services_visibility: rubric(1),
      trust_signals: rubric(3),
      hero_message: rubric(2),
    },
    findings: [finding("high"), finding("high"), finding("medium"), finding("low")],
    commercial: {
      services: ["Verkauf", "Werkstatt"],
      high_value_services: ["E-Bike-Leasing"],
      size_signals: ["4 Mitarbeiter im Team-Bereich"],
      team_size: "small",
    },
  }),
  contacts: { ownerNamed: true, email: true, phone: true },
  now: NOW,
};

describe("scoreLead", () => {
  it("Firma A aus dem Briefing landet bei ≈ 85–91 und ist QUALIFIED", () => {
    const r = scoreLead(firmaA, config);
    expect(r.knockout).toBeNull();
    expect(r.qualified).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(85);
    expect(r.total).toBeLessThanOrEqual(91);
    const by = Object.fromEntries(r.dimensions.map((d) => [d.key, d.points]));
    expect(by.business).toBeGreaterThanOrEqual(23);
    expect(by.website).toBeCloseTo(26.4, 1); // 12 objektiv (gekappt) + 14,4 Rubrik (je Position gerundet), Plan: B ≈ 26
    expect(by.reach).toBe(9); // ohne Kontaktformular
  });

  it("Firma B (2,2★) fällt per Knock-out raus, mit Grund", () => {
    const r = scoreLead({ ...firmaA, places: { ...firmaA.places, rating: 2.2, reviewCount: 40 } }, config);
    expect(r.knockout).toEqual({
      reason: "reputation",
      detail: "Reputation zu schwach (2,2★ bei 40 Bewertungen)",
    });
    expect(r.qualified).toBe(false);
  });

  it("weitere Knock-outs: geschlossen, zu wenige Bewertungen, Website bereits gut", () => {
    expect(
      scoreLead({ ...firmaA, places: { ...firmaA.places, businessStatus: "CLOSED_TEMPORARILY" } }, config)
        .knockout?.reason,
    ).toBe("closed");
    expect(
      scoreLead({ ...firmaA, places: { ...firmaA.places, reviewCount: 3 } }, config).knockout?.reason,
    ).toBe("reputation");

    const goodSite: ScoreInput = {
      ...firmaA,
      site: {
        ...firmaA.site!,
        has_viewport_meta: true,
        mobile_too_wide: false,
        tel_links: ["+49"],
        has_contact_form: true,
        copyright_year: 2026,
        layout_tables: 0,
        cms: "WordPress",
      },
      psiPerformance: 85,
      audit: audit(5),
    };
    const r = scoreLead(goodSite, config);
    expect(r.knockout?.reason).toBe("website_good");
    expect(r.dimensions.find((d) => d.key === "website")!.points).toBe(0);
  });

  it("die Rubrik wirkt linear: 1 = volle Chance, 3 = halbe, 5 = keine", () => {
    const b = (score: number) =>
      scoreLead({ ...firmaA, psiPerformance: null, site: null, audit: audit(score) }, config).dimensions.find(
        (d) => d.key === "website",
      )!.points;
    expect(b(1)).toBe(18);
    expect(b(3)).toBe(9);
    expect(b(5)).toBe(0);
  });

  it("ohne Website: volle Website-Chance, Lücke erklärbar, kein Audit nötig", () => {
    const r = scoreLead(
      { ...firmaA, segment: "NO_WEBSITE", site: null, psiPerformance: null, audit: null },
      config,
    );
    const by = Object.fromEntries(r.dimensions.map((d) => [d.key, d.points]));
    expect(by.website).toBe(30);
    expect(by.gap).toBeGreaterThanOrEqual(14);
    expect(r.knockout).toBeNull();
  });

  it("Summe der Positionen = Dimension = Gesamt (gerundet)", () => {
    for (const input of [
      firmaA,
      { ...firmaA, audit: audit(3) },
      { ...firmaA, segment: "NO_WEBSITE" as const, audit: null, site: null },
    ]) {
      const r = scoreLead(input, config);
      for (const d of r.dimensions) {
        const sum = d.items.reduce((s, i) => s + i.points, 0);
        expect(Math.min(d.max, sum)).toBeCloseTo(d.points, 0);
        expect(d.points).toBeLessThanOrEqual(d.max);
      }
      expect(r.total).toBe(Math.round(r.dimensions.reduce((s, d) => s + d.points, 0)));
      expect(r.total).toBeLessThanOrEqual(100);
    }
  });

  it("unbekannte Branche bekommt einen mittleren Startwert", () => {
    const c = (v: number | null) =>
      scoreLead({ ...firmaA, branchValue: v }, config).dimensions.find((d) => d.key === "potential")!
        .items[0]!.points;
    expect(c(5)).toBe(10);
    expect(c(1)).toBe(2);
    expect(c(null)).toBe(3);
  });
});

describe("explain", () => {
  it("kurze Erklärung wie in ARCHITECTURE.md 7.5", () => {
    const text = explainScore(scoreLead(firmaA, config), {
      companyName: "Fahrrad Müller",
      scoredAt: NOW,
      auditBy: "audit (claude-sonnet-5-5, Lauf 1a2b3c4d)",
    });
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^Fahrrad Müller – \d+\/100 \(Scoring v1, 02\.10\.\)$/);
    expect(lines.slice(1, 6).map((l) => l.slice(0, 11).trim())).toEqual([
      "A Business",
      "B Website",
      "C Potenzial",
      "D Lücke",
      "E Kontakt",
    ]);
    expect(text).toContain("Google-Bewertung: 4,8★");
    expect(lines.at(-1)).toBe("Bewertet von: audit (claude-sonnet-5-5, Lauf 1a2b3c4d), score (Code)");
  });

  it("nennt den Knock-out-Grund", () => {
    const r = scoreLead({ ...firmaA, places: { ...firmaA.places, rating: 2.2, reviewCount: 40 } }, config);
    expect(explainScore(r, { companyName: "B", scoredAt: NOW, auditBy: null })).toContain(
      "Aussortiert: Reputation zu schwach (2,2★ bei 40 Bewertungen)",
    );
  });

  it("volle Aufschlüsselung listet jede Position mit Quelle", () => {
    const full = explainFull(scoreLead(firmaA, config));
    expect(full).toContain("[rubrik]");
    expect(full).toContain("[objektiv]");
    expect(full).toContain("Kappung objektive Punkte");
  });
});

describe("Score v2 (kalibriert)", () => {
  const v2 = loadScoringConfig("v2");

  it("vergibt 100 Punkte; v3 (aktiv) unterscheidet sich nur in der Schwelle", () => {
    expect(v2.version).toBe("v2");
    const v3 = loadScoringConfig();
    expect(v3.version).toBe("v3");
    expect(v3.qualify_min_total).toBe(50);
    expect({ ...v3, version: "v2", qualify_min_total: 55 }).toEqual(v2);
    const max = v2.dimensions;
    expect(max.business.max + max.website.max + max.potential.max + max.gap.max + max.reach.max).toBe(100);
  });

  it("gewichtet die Rubrik je Kriterium: altes Design zählt mehr als eine schwache Hero-Botschaft", () => {
    const only = (key: keyof AuditOutput["rubric"]) => {
      const a = audit(5);
      a.rubric[key] = rubric(1);
      return scoreLead({ ...firmaA, audit: a }, v2);
    };
    const rubricPoints = (r: ReturnType<typeof scoreLead>) =>
      r.dimensions[1]!.items.filter((i) => i.source === "rubrik").reduce((s, i) => s + i.points, 0);
    expect(rubricPoints(only("design_age"))).toBeCloseTo((33 * 3) / 6.5, 0);
    expect(rubricPoints(only("hero_message"))).toBeCloseTo((33 * 0.5) / 6.5, 0);
  });

  it("kleine Betriebe vor großen Häusern", () => {
    const withTeam = (team_size: AuditOutput["commercial"]["team_size"]) =>
      scoreLead(
        { ...firmaA, audit: { ...firmaA.audit!, commercial: { ...firmaA.audit!.commercial, team_size } } },
        v2,
      ).total;
    expect(withTeam("small")).toBeGreaterThan(withTeam("large"));
  });

  it("Firma A aus dem Briefing bleibt ein Top-Lead (Pitch-Schwelle)", () => {
    const r = scoreLead(firmaA, v2);
    expect(r.qualified).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(v2.pitch_min_total);
  });
});
