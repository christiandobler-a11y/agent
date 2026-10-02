import { describe, expect, it } from "vitest";
import { evaluateGate, loadGateRules, type GateInput } from "../src/pipeline/research/gate.js";

const rules = { min_rating: 4.0, min_reviews: 15, required_business_status: "OPERATIONAL" };
const chains = ["fahrrad xxl", "boc"];
const ok: GateInput = { name: "Radl Meier", businessStatus: "OPERATIONAL", rating: 4.7, reviewCount: 181 };

describe("evaluateGate", () => {
  it("lässt starke, geöffnete Betriebe durch", () => {
    expect(evaluateGate(ok, rules, chains)).toEqual({ pass: true });
    expect(evaluateGate({ ...ok, rating: 4.0, reviewCount: 15 }, rules, chains)).toEqual({ pass: true });
  });

  it("sortiert geschlossene Betriebe aus", () => {
    expect(evaluateGate({ ...ok, businessStatus: "CLOSED_PERMANENTLY" }, rules, chains)).toEqual({
      pass: false,
      reason: "closed",
      detail: "Google-Status CLOSED_PERMANENTLY",
    });
    expect(evaluateGate({ ...ok, businessStatus: null }, rules, chains)).toMatchObject({ reason: "closed" });
  });

  it("sortiert schwache Reputation aus und nennt die Zahlen", () => {
    expect(evaluateGate({ ...ok, rating: 3.6, reviewCount: 81 }, rules, chains)).toEqual({
      pass: false,
      reason: "reputation",
      detail: "Bewertung zu schwach (3,6★, mindestens 4,0★)",
    });
    expect(evaluateGate({ ...ok, rating: 5, reviewCount: 2 }, rules, chains)).toEqual({
      pass: false,
      reason: "reputation",
      detail: "zu wenige Bewertungen (2, mindestens 15)",
    });
    expect(evaluateGate({ ...ok, rating: null, reviewCount: null }, rules, chains)).toMatchObject({
      reason: "reputation",
    });
  });

  it("erkennt Ketten über ganze Wörter im normalisierten Namen", () => {
    expect(evaluateGate({ ...ok, name: "Fahrrad XXL Feucht GmbH" }, rules, chains)).toMatchObject({
      pass: false,
      reason: "chain",
    });
    expect(evaluateGate({ ...ok, name: "B.O.C. Rosenheim" }, rules, chains)).toMatchObject({
      reason: "chain",
    });
    expect(evaluateGate({ ...ok, name: "Radhaus Bocholt" }, rules, chains)).toEqual({ pass: true });
  });

  it("die Konfiguration in config/gate.yaml ist gültig", () => {
    expect(loadGateRules()).toEqual(rules);
  });
});
