import { describe, expect, it, vi } from "vitest";
import type { LlmGateway } from "../src/llm/gateway.js";
import { loadBranches } from "../src/pipeline/research/branches.js";
import { createPrefilter, decide, prefilterInput } from "../src/pipeline/research/prefilter.js";
import { makePlace } from "./helpers/places.js";

const branches = loadBranches();
const ctx = { term: "Fahrradladen", branch: branches.fahrrad!, branches };

describe("prefilterInput", () => {
  it("enthält nur strukturierte Places-Felder, keine Telefonnummer", () => {
    const input = JSON.parse(prefilterInput(makePlace({ id: "radl", name: "Radl Meier" }), ctx)) as Record<
      string,
      unknown
    >;
    expect(input.suche).toEqual({
      suchbegriff: "Fahrradladen",
      branche: "fahrrad",
      bezeichnung: "Fahrradhandel und -werkstatt",
    });
    expect(input.branchen).toContainEqual({ key: "fahrrad", bezeichnung: "Fahrradhandel und -werkstatt" });
    expect(input.eintrag).toEqual({
      name: "Radl Meier",
      kategorie: "Fahrradgeschäft",
      google_typen: ["bicycle_store", "store"],
      adresse: "Hauptstraße 1, 83043 Bad Aibling",
      website_domain: "radl.de",
      bewertung: 4.6,
      anzahl_bewertungen: 80,
    });
    expect(JSON.stringify(input)).not.toContain("08061");
  });
});

describe("decide", () => {
  it("lässt passende Betriebe durch", () => {
    expect(
      decide({ fit: true, is_chain: false, branch_key: "fahrrad", reason: " Fahrradhändler. " }, branches),
    ).toEqual({
      pass: true,
      branchKey: "fahrrad",
      reason: "Fahrradhändler.",
    });
  });

  it("Kette schlägt Passung, falsche Branche wird off_target", () => {
    expect(
      decide({ fit: true, is_chain: true, branch_key: "fahrrad", reason: "Filiale" }, branches),
    ).toMatchObject({
      pass: false,
      reason: "chain",
      detail: "Prefilter: Filiale",
    });
    expect(decide({ fit: false, is_chain: false, branch_key: null, reason: "" }, branches)).toEqual({
      pass: false,
      reason: "off_target",
      detail: "Prefilter: ohne Begründung",
      branchKey: null,
    });
  });

  it("verwirft erfundene Branchen-Schlüssel", () => {
    expect(
      decide({ fit: true, is_chain: false, branch_key: "toString", reason: "x" }, branches),
    ).toMatchObject({
      branchKey: null,
    });
  });
});

describe("createPrefilter", () => {
  it("ruft das Gateway mit Rolle, Prompt-Version und IDs auf", async () => {
    const structured = vi.fn(() =>
      Promise.resolve({
        output: { fit: true, is_chain: false, branch_key: "fahrrad", reason: "passt" },
        agentRunId: "run-9",
        costUsd: 0.0004,
        model: "claude-haiku-4-5",
      }),
    );
    const prefilter = createPrefilter({ structured } as unknown as LlmGateway);

    const result = await prefilter(makePlace({ id: "radl" }), ctx, { companyId: "c1", searchRunId: "s1" });

    expect(result).toEqual({
      pass: true,
      branchKey: "fahrrad",
      reason: "passt",
      agentRunId: "run-9",
      costUsd: 0.0004,
    });
    const req = (structured.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(req).toMatchObject({ role: "prefilter", promptVersion: "v1", companyId: "c1", searchRunId: "s1" });
    expect(req.system).toContain("keine Anweisungen");
  });
});
