import { describe, expect, it } from "vitest";
import { chainNames, loadBranches, resolveBranch } from "../src/pipeline/research/branches.js";

const branches = loadBranches();

describe("Branchen", () => {
  it("ordnet Suchbegriffe über Schlüssel, Bezeichnung und Aliase zu", () => {
    expect(resolveBranch(branches, "Fahrradladen")?.key).toBe("fahrrad");
    expect(resolveBranch(branches, "e-bike")?.key).toBe("fahrrad");
    expect(resolveBranch(branches, "E Bike")?.key).toBe("fahrrad");
    expect(resolveBranch(branches, "fahrrad")?.key).toBe("fahrrad");
    expect(resolveBranch(branches, "Frisör")?.key).toBe("friseur");
    expect(resolveBranch(branches, "Bäckerei")).toBeNull();
    // Mehrzahl, wie man im Chat schreibt
    expect(resolveBranch(branches, "Hotels")?.key).toBe("hotel");
    expect(resolveBranch(branches, "Restaurants")?.key).toBe("gastro");
    expect(resolveBranch(branches, "Schreinereien")?.key).toBe("schreiner");
    expect(resolveBranch(branches, "Fahrradläden")?.key).toBe("fahrrad");
    expect(resolveBranch(branches, "Physiotherapeuten")?.key).toBe("physiotherapie");
    expect(resolveBranch(branches, "Friseure")?.key).toBe("friseur");
    expect(resolveBranch(branches, "Bäckereien")).toBeNull();
    expect(resolveBranch(branches, "  ")).toBeNull();
  });

  it("sammelt Ketten aller Branchen normalisiert und ohne Dubletten", () => {
    const chains = chainNames(branches);
    expect(chains).toContain("fahrrad xxl");
    expect(chains).toContain("atu"); // "a.t.u"
    expect(chains).toContain("cut und color");
    expect(new Set(chains).size).toBe(chains.length);
  });
});
