import { describe, expect, it } from "vitest";
import { upsertCoverage } from "../src/db/coverage.js";
import { createSearchRun, finishSearchRun } from "../src/db/searchRuns.js";
import { upsertCompany } from "../src/db/companies.js";
import { loadBranches } from "../src/pipeline/research/branches.js";
import {
  coverageSubject,
  formatCoverage,
  formatRegionCoverage,
  legacyTilesSearched,
  regionCoverage,
  summarize,
  tileState,
  type TileStatusInput,
} from "../src/pipeline/research/coverage.js";
import { splitQuery, tileQueries, type Region } from "../src/pipeline/research/tiling.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const branches = loadBranches();
const NOW = new Date("2026-10-03T12:00:00Z");
const DAY = 86_400_000;
const region: Region = {
  key: "test",
  name: "Landkreis Test",
  admin_areas: ["Test"],
  search_radius_km: 5,
  fallback_max_km: 8,
  tiles: [
    { name: "A-Stadt", lat: 47.8, lng: 12.1 },
    { name: "B-Dorf", lat: 47.9, lng: 12.2 },
    { name: "C-Dorf", lat: 48.0, lng: 12.3 },
  ],
};
const row = (saturated: boolean, daysAgo = 1) => ({
  saturated,
  searched_at: new Date(NOW.getTime() - daysAgo * DAY),
});
const input = (rows: [string, ReturnType<typeof row>][], legacy: string[] = []): TileStatusInput => ({
  rows: new Map(rows),
  legacy: new Set(legacy),
  now: NOW,
  validDays: 180,
});
const noFirms = { found: 0, open: 0, qualified: 0, skipped: 0, failed: 0 };

describe("Abdeckung (rein)", () => {
  const [a, b, c] = tileQueries(region, "Hotel");

  it("Branche aus dem Suchbegriff, sonst normalisierter Begriff", () => {
    expect(coverageSubject("Hotels", branches)).toBe("hotel");
    expect(coverageSubject("Hotel", branches)).toBe("hotel");
    expect(coverageSubject("Fahrradladen", branches)).toBe("fahrrad");
    expect(coverageSubject("Bäckerei", branches)).toBe("term:baeckerei");
  });

  it("Ort: offen, erledigt, veraltet, voll mit und ohne fertige Teilgebiete, ältere Suche", () => {
    expect(tileState(a!, input([]))).toBe("open");
    expect(tileState(a!, input([["A-Stadt", row(false)]]))).toBe("done");
    expect(tileState(a!, input([["A-Stadt", row(false, 200)]]))).toBe("open");
    expect(tileState(a!, input([["A-Stadt", row(true)]]))).toBe("searched");
    const subs = splitQuery(a!, "Hotel").map((q): [string, ReturnType<typeof row>] => [q.key, row(false)]);
    expect(tileState(a!, input([["A-Stadt", row(true)], ...subs]))).toBe("done");
    expect(tileState(a!, input([["A-Stadt", row(true)], ...subs.slice(1)]))).toBe("searched");
    expect(tileState(b!, input([], ["B-Dorf"]))).toBe("searched");
    expect(tileState(c!, input([], ["B-Dorf"]))).toBe("open");
  });

  it("vollständig nur mit allen Orten erledigt und keiner Firma mehr in Prüfung", () => {
    const allDone = input(region.tiles.map((t) => [t.name, row(false)]));
    expect(summarize(region, "hotel", "Hotel", allDone, noFirms, NOW).complete).toBe(true);
    const pending = { ...noFirms, found: 5, open: 1 };
    expect(summarize(region, "hotel", "Hotel", allDone, pending, NOW).complete).toBe(false);
    const partial = summarize(
      region,
      "hotel",
      "Hotel",
      input([["A-Stadt", row(false)]], ["B-Dorf"]),
      noFirms,
      NOW,
    );
    expect(partial).toMatchObject({ tilesTotal: 3, tilesDone: 1, tilesSearched: 2, complete: false });
    expect(formatCoverage(region, partial, "Hotels")).toBe(
      "◐ Hotel: 1/3 Orte vollständig (33 %), 1 weitere angesucht, aber nicht sicher vollständig – Rest: „Such alle Hotels in Landkreis Test“",
    );
  });

  it("ältere Läufe: Abbruch mitten im Ort zählt nicht", () => {
    expect(legacyTilesSearched({ tiles_searched: 5, stopped_because: "goal_reached" })).toBe(4);
    expect(legacyTilesSearched({ tiles_searched: 5, stopped_because: "tiles_exhausted" })).toBe(5);
    expect(legacyTilesSearched({})).toBe(0);
  });
});

describeDb("Abdeckung je Region (Datenbank)", () => {
  const db = useTestDb();

  it("verbindet Abdeckungs-Tabelle, ältere Läufe und Firmen", async () => {
    // Älterer Lauf (ohne Abdeckungs-Protokoll): Fahrradläden, Ziel erreicht im 2. Ort → 1 Ort gilt als angesucht.
    const old = await createSearchRun(db(), {
      requestedBy: "test",
      query: { term: "Fahrradladen", region: "test" },
      targetCount: 5,
    });
    await finishSearchRun(db(), old.id, "COMPLETED", { tiles_searched: 2, stopped_because: "goal_reached" });
    const { company } = await upsertCompany(db(), {
      name: "Radl Test",
      placeId: "p1",
      region: "Landkreis Test",
      searchRunId: old.id,
    });
    await db().query("update companies set status = 'QUALIFIED', branch_key = 'fahrrad' where id = $1", [
      company.id,
    ]);
    // Neuer Komplett-Lauf: Hotels in allen drei Orten erledigt.
    const run = await createSearchRun(db(), {
      requestedBy: "test",
      query: { term: "Hotel", region: "test", complete: true },
      targetCount: 1,
    });
    await finishSearchRun(db(), run.id, "COMPLETED", { coverage: true });
    for (const t of region.tiles) {
      await upsertCoverage(db(), {
        regionKey: "test",
        subject: "hotel",
        tileKey: t.name,
        searchRunId: run.id,
        results: 4,
        pages: 1,
        saturated: false,
        searchedAt: NOW,
      });
    }

    const list = await regionCoverage(db(), region, branches, { validDays: 180, now: NOW });
    const hotel = list.find((c) => c.subject === "hotel")!;
    const bike = list.find((c) => c.subject === "fahrrad")!;
    expect(hotel).toMatchObject({ complete: true, tilesDone: 3 });
    expect(bike).toMatchObject({
      complete: false,
      tilesDone: 0,
      tilesSearched: 1,
      firms: { found: 1, qualified: 1 },
    });
    expect(list[0]!.subject).toBe("hotel"); // vollständige zuerst
    const text = formatRegionCoverage(region, list);
    expect(text).toContain("✔ Hotel, Pension, Gasthof: vollständig (3/3 Orte)");
    expect(text).toContain("◐ Fahrradhandel und -werkstatt: 0/3 Orte vollständig");
    expect(text).toMatch(/○ Noch nie gesucht: .*Friseur/);

    const only = await regionCoverage(db(), region, branches, { validDays: 180, now: NOW, term: "Hotel" });
    expect(only.map((c) => c.subject)).toEqual(["hotel"]);
  });
});
