import { describe, expect, it } from "vitest";
import { computeRecheckAfter, loadRecheckRules, shouldReprocess } from "../src/pipeline/research/recheck.js";

const now = new Date("2026-10-01T12:00:00Z");
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);
const rules = loadRecheckRules();

describe("computeRecheckAfter", () => {
  it("liest die Fristen aus config/recheck.yaml", () => {
    expect(computeRecheckAfter(rules, "QUALIFIED", null, now)).toEqual(inDays(90));
    expect(computeRecheckAfter(rules, "FAILED", null, now)).toEqual(inDays(7));
  });

  it("unterscheidet Skip-Gründe und fällt auf den Standard zurück", () => {
    expect(computeRecheckAfter(rules, "SKIPPED", "reputation", now)).toEqual(inDays(365));
    expect(computeRecheckAfter(rules, "SKIPPED", "website_good", now)).toEqual(inDays(180));
    expect(computeRecheckAfter(rules, "SKIPPED", "unbekannt", now)).toEqual(inDays(180));
    expect(computeRecheckAfter(rules, "SKIPPED", "chain", now)).toBeNull();
  });

  it("prüft Vertriebsstatus nie automatisch neu", () => {
    expect(computeRecheckAfter(rules, "LOST", null, now)).toBeNull();
    expect(computeRecheckAfter(rules, "CONTACTED", null, now)).toBeNull();
  });
});

describe("shouldReprocess", () => {
  it("verarbeitet erst nach Ablauf der Frist erneut", () => {
    expect(shouldReprocess({ status: "QUALIFIED", recheck_after: inDays(1) }, now)).toEqual({
      reprocess: false,
      reason: "not_due",
    });
    expect(shouldReprocess({ status: "SKIPPED", recheck_after: inDays(-1) }, now)).toEqual({
      reprocess: true,
    });
  });

  it("fasst laufende, vertriebliche und nie zu prüfende Firmen nicht an", () => {
    expect(shouldReprocess({ status: "AUDITED", recheck_after: null }, now)).toMatchObject({
      reason: "in_pipeline",
    });
    expect(shouldReprocess({ status: "INTERESTED", recheck_after: inDays(-1) }, now)).toMatchObject({
      reason: "in_sales",
    });
    expect(shouldReprocess({ status: "SKIPPED", recheck_after: null }, now)).toMatchObject({
      reason: "never",
    });
  });
});
