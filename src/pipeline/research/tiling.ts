import { existsSync } from "node:fs";
import { z } from "zod";
import { CONFIG_DIR, loadYamlConfig } from "../../config/files.js";

/**
 * Orts-Kachelung (ARCHITECTURE.md 5.2): Eine Places-Text-Suche liefert höchstens 60 Treffer, deshalb
 * wird eine Region als Liste von Orten abgesucht ("<Begriff> in <Ort>", mit Standort-Bias).
 */

const tileSchema = z.object({
  name: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const regionSchema = z.object({
  name: z.string().min(1),
  admin_areas: z.array(z.string().min(1)).default([]),
  search_radius_km: z.number().positive().max(50),
  fallback_max_km: z.number().positive(),
  tiles: z.array(tileSchema).min(1),
});

export type Tile = z.infer<typeof tileSchema>;
export type Region = z.infer<typeof regionSchema> & { key: string };

const REGION_KEY = /^[a-z0-9-]+$/;

export function loadRegion(key: string, dir = CONFIG_DIR): Region {
  const normalized = key.trim().toLowerCase();
  if (!REGION_KEY.test(normalized) || !existsSync(`${dir}regions/${normalized}.yaml`)) {
    throw new Error(`Unbekannte Region "${key}" (erwartet: Datei config/regions/<name>.yaml)`);
  }
  return { key: normalized, ...loadYamlConfig(`regions/${normalized}.yaml`, regionSchema, dir) };
}

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Großkreis-Entfernung in km (Haversine). */
export function distanceKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface RegionProbe {
  /** Google-Adressbestandteil administrative_area_level_3 (in Deutschland: Landkreis). */
  adminArea: string | null;
  location: LatLng | null;
}

/**
 * Liegt ein Treffer in der Region? Maßgeblich ist der Landkreis aus der Google-Adresse; nur wenn Google
 * keinen liefert, entscheidet die Entfernung zur nächsten Ortsmitte.
 */
export function isInRegion(region: Region, probe: RegionProbe): boolean {
  if (probe.adminArea && region.admin_areas.length > 0) {
    const area = probe.adminArea.trim().toLowerCase();
    return region.admin_areas.some((a) => a.toLowerCase() === area);
  }
  if (!probe.location) return false;
  const location = probe.location;
  return region.tiles.some((t) => distanceKm(t, location) <= region.fallback_max_km);
}

export interface TileQuery {
  tile: Tile;
  textQuery: string;
  center: LatLng;
  radiusMeters: number;
}

/** Suchanfragen in Kachel-Reihenfolge. */
export function tileQueries(region: Region, term: string): TileQuery[] {
  const cleanTerm = term.trim().replace(/\s+/g, " ");
  if (!cleanTerm) throw new Error("Leerer Suchbegriff");
  return region.tiles.map((tile) => ({
    tile,
    textQuery: `${cleanTerm} in ${tile.name}`,
    center: { lat: tile.lat, lng: tile.lng },
    radiusMeters: Math.round(region.search_radius_km * 1000),
  }));
}
