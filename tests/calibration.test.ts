import { describe, expect, it } from "vitest";
import type { AuditOutput } from "../src/pipeline/audit/schema.js";
import {
  evaluateGoldenSet,
  formatCalibrationReport,
  parseGoldenFile,
  toGoldenFile,
  type GoldenEntry,
  type GoldenGrade,
} from "../src/pipeline/scoring/calibration.js";
import { loadScoringConfig } from "../src/pipeline/scoring/config.js";
import type { ScoreInput } from "../src/pipeline/scoring/score.js";

const config = loadScoringConfig();
const NOW = new Date("2026-10-03T12:00:00Z");

/** Score-Eingabe, deren Website umso schwächer ist, je kleiner `rubricScore` (1 = sehr schwach). */
function input(rubricScore: number, rating = 4.7, reviews = 120): ScoreInput {
  const r = { score: rubricScore, evidence: "Beleg" };
  const audit: AuditOutput = {
    summary: "s",
    design_era: null,
    rubric: {
      design_age: r,
      mobile_ux: r,
      cta_clarity: r,
      services_visibility: r,
      trust_signals: r,
      hero_message: r,
    },
    findings: [],
    commercial: { services: [], high_value_services: [], size_signals: [], team_size: "small" },
  };
  return {
    segment: "WEBSITE",
    branchValue: 4,
    places: { rating, reviewCount: reviews, businessStatus: "OPERATIONAL", photoCount: 10 },
    site: {
      https: true,
      tls_valid: true,
      has_viewport_meta: rubricScore > 2,
      mobile_too_wide: false,
      tel_links: ["+49"],
      has_contact_form: true,
      copyright_year: 2025,
      layout_tables: 0,
      cms: null,
    },
    psiPerformance: 70,
    audit,
    contacts: { ownerNamed: true, email: true, phone: true },
    now: NOW,
  };
}

let n = 0;
const entry = (grade: GoldenGrade, i: ScoreInput): GoldenEntry => {
  n++;
  return {
    company_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Firma ${n}`,
    branch_key: "fahrrad",
    city: "Rosenheim",
    website: null,
    grade,
    input: i,
  };
};

/** 20 Firmen: schwache Websites = A, mittlere = B, gute = C (so wie der Score es sieht). */
function consistentSet(): GoldenEntry[] {
  return [
    ...Array.from({ length: 5 }, () => entry("A", input(1))),
    ...Array.from({ length: 8 }, () => entry("B", input(3))),
    ...Array.from({ length: 7 }, () => entry("C", input(5))),
  ];
}

describe("Kalibrierung", () => {
  it("passt der Score zum Bauchgefühl, ist Kriterium 10 erfüllt", () => {
    const r = evaluateGoldenSet(consistentSet(), config);
    expect(r.enough).toBe(true);
    expect(r.topA).toMatchObject({ needed: 5, window: 8, found: 5, pass: true });
    expect(r.cHigh.pass).toBe(true);
    expect(r.concordance).toBe(1);
    expect(r.pass).toBe(true);
    expect(r.byGrade.A.n).toBe(5);
    expect(r.byGrade.A.avg!).toBeGreaterThan(r.byGrade.C.avg!);
  });

  it("meldet A-Firmen zu weit hinten und C-Firmen über der Pitch-Schwelle", () => {
    const set = consistentSet();
    set[0] = { ...set[0]!, grade: "C" }; // sehr schwache Website, aber Christian sagt C
    set.at(-1)!.grade = "A"; // gute Website, aber Christian sagt A
    const r = evaluateGoldenSet(set, config);
    expect(r.topA.pass).toBe(false);
    expect(r.topA.missed.map((m) => m.entry.name)).toContain(set.at(-1)!.name);
    const scoreOfC = r.ranked.find((x) => x.entry.name === set[0]!.name)!.result.total;
    expect(r.cHigh.pass).toBe(scoreOfC < config.pitch_min_total);
    expect(r.concordance!).toBeLessThan(1);
    expect(r.pass).toBe(false);
    const text = formatCalibrationReport(r, config.version);
    expect(text).toMatch(/\d+ A-Firmen in den System-Top-8 \(nötig: 5\)/);
    expect(text).toContain("noch nicht bestanden");
  });

  it("Knock-outs stehen hinten, unter 20 Firmen gilt das Set als zu klein", () => {
    const set = [entry("A", input(1)), entry("C", input(1, 3.0, 40))]; // C: schlechte Bewertung → Knock-out
    const r = evaluateGoldenSet(set, config);
    expect(r.ranked.at(-1)!.entry.grade).toBe("C");
    expect(r.ranked.at(-1)!.result.knockout?.reason).toBe("reputation");
    expect(r.enough).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("Datei-Export und -Import ergeben dieselbe Auswertung", () => {
    const set = consistentSet();
    const file = JSON.parse(JSON.stringify(toGoldenFile(set, NOW))) as unknown;
    const back = parseGoldenFile(file);
    expect(back[0]!.input.now).toEqual(NOW);
    expect(evaluateGoldenSet(back, config).ranked.map((r) => r.result.total)).toEqual(
      evaluateGoldenSet(set, config).ranked.map((r) => r.result.total),
    );
  });
});
