import { describe, expect, it } from "vitest";
import {
  distanceKm,
  isInRegion,
  loadRegion,
  splitQuery,
  tileQueries,
  type Region,
} from "../src/pipeline/research/tiling.js";

const region: Region = {
  key: "test",
  name: "Testkreis",
  admin_areas: ["Rosenheim"],
  search_radius_km: 5,
  fallback_max_km: 8,
  tiles: [
    { name: "Rosenheim", lat: 47.8561, lng: 12.1289 },
    { name: "Bad Aibling", lat: 47.8638, lng: 12.01 },
  ],
};

describe("loadRegion", () => {
  it("lädt den Landkreis Rosenheim aus config/regions", () => {
    const r = loadRegion("Rosenheim");
    expect(r.key).toBe("rosenheim");
    expect(r.admin_areas).toEqual(["Rosenheim", "Kreisfreie Stadt Rosenheim"]);
    expect(r.tiles.length).toBeGreaterThan(20);
    expect(r.tiles[0]!.name).toBe("Rosenheim");
  });

  it("lehnt unbekannte Regionen und Pfade ab", () => {
    expect(() => loadRegion("atlantis")).toThrow(/Unbekannte Region/);
    expect(() => loadRegion("../gate")).toThrow(/Unbekannte Region/);
  });
});

describe("distanceKm", () => {
  it("Rosenheim – Bad Aibling sind rund 9 km", () => {
    const d = distanceKm(region.tiles[0]!, region.tiles[1]!);
    expect(d).toBeGreaterThan(8.5);
    expect(d).toBeLessThan(9.5);
  });

  it("ist 0 für denselben Punkt", () => {
    expect(distanceKm({ lat: 48, lng: 12 }, { lat: 48, lng: 12 })).toBe(0);
  });
});

describe("isInRegion", () => {
  it("entscheidet über den Landkreis aus der Google-Adresse", () => {
    expect(isInRegion(region, { adminArea: "Rosenheim", location: null })).toBe(true);
    expect(isInRegion(region, { adminArea: "rosenheim", location: null })).toBe(true);
    // Landkreis gewinnt auch dann, wenn der Ort nah an einer Kachel liegt.
    expect(isInRegion(region, { adminArea: "Traunstein", location: { lat: 47.86, lng: 12.12 } })).toBe(false);
  });

  it("fällt ohne Landkreis auf die Entfernung zur nächsten Ortsmitte zurück", () => {
    expect(isInRegion(region, { adminArea: null, location: { lat: 47.87, lng: 12.05 } })).toBe(true);
    expect(isInRegion(region, { adminArea: null, location: { lat: 48.14, lng: 11.58 } })).toBe(false); // München
    expect(isInRegion(region, { adminArea: null, location: null })).toBe(false);
  });
});

describe("tileQueries", () => {
  it("baut je Ort eine Anfrage mit Standort-Bias", () => {
    expect(tileQueries(region, "  Fahrradladen ")).toEqual([
      {
        tile: region.tiles[0],
        key: "Rosenheim",
        depth: 0,
        textQuery: "Fahrradladen in Rosenheim",
        center: { lat: 47.8561, lng: 12.1289 },
        radiusMeters: 5000,
      },
      expect.objectContaining({ textQuery: "Fahrradladen in Bad Aibling" }),
    ]);
  });

  it("teilt ein volles Gebiet in vier Rechtecke, die zusammen das Gebiet abdecken", () => {
    const [q] = tileQueries(region, "Hotel");
    const parts = splitQuery(q!, "Hotel");
    expect(parts.map((p) => p.key)).toEqual(["Rosenheim#NW", "Rosenheim#NO", "Rosenheim#SW", "Rosenheim#SO"]);
    expect(parts.every((p) => p.depth === 1 && p.textQuery === "Hotel" && p.rect)).toBe(true);
    const lats = parts.flatMap((p) => [p.rect!.low.lat, p.rect!.high.lat]);
    const lngs = parts.flatMap((p) => [p.rect!.low.lng, p.rect!.high.lng]);
    // Quadrat ±5 km um die Ortsmitte
    expect(Math.max(...lats) - Math.min(...lats)).toBeCloseTo(10 / 111.32, 4);
    expect((Math.min(...lngs) + Math.max(...lngs)) / 2).toBeCloseTo(q!.center.lng, 6);
    const deeper = splitQuery(parts[0]!, "Hotel");
    expect(deeper[3]!.key).toBe("Rosenheim#NW.SO");
    expect(deeper[3]!.rect!.high.lat).toBeCloseTo(parts[0]!.center.lat, 6);
  });

  it("verlangt einen Suchbegriff", () => {
    expect(() => tileQueries(region, "  ")).toThrow(/Leerer Suchbegriff/);
  });
});
