import { describe, expect, it } from "vitest";
import { loadBranches } from "../src/pipeline/research/branches.js";
import { loadInspiration } from "../src/pipeline/inspiration.js";

describe("Inspiration", () => {
  it('ist gültig und nutzt nur bekannte Branchen (plus "alle" für branchenübergreifende Elemente)', () => {
    const inspiration = loadInspiration();
    const branches = loadBranches();
    for (const key of Object.keys(inspiration)) if (key !== "alle") expect(branches).toHaveProperty(key);
    expect(inspiration.gastro?.[0]?.url).toBe("https://www.zum-augustiner.de/");
  });
});
