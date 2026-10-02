import { describe, expect, it } from "vitest";
import { parseResearchArgs } from "../src/cli-args.js";

describe("parseResearchArgs", () => {
  it("liest Begriff, Region und Ziel", () => {
    expect(parseResearchArgs(["Fahrradladen", "rosenheim", "-n", "5"])).toEqual({
      term: "Fahrradladen",
      region: "rosenheim",
      target: 5,
    });
    expect(parseResearchArgs(["-n", "3", "Fahrradladen", "rosenheim"]).target).toBe(3);
    expect(parseResearchArgs(["Fahrradladen", "rosenheim"]).target).toBe(20);
  });

  it("lehnt fehlerhafte Aufrufe ab", () => {
    expect(() => parseResearchArgs(["Fahrradladen"])).toThrow(/Verwendung/);
    expect(() => parseResearchArgs(["a", "b", "c"])).toThrow(/Verwendung/);
    expect(() => parseResearchArgs(["a", "b", "-n", "0"])).toThrow(/-n/);
    expect(() => parseResearchArgs(["a", "b", "-n"])).toThrow(/-n/);
    expect(() => parseResearchArgs(["a", "b", "--x"])).toThrow(/Unbekannte Option/);
  });
});
