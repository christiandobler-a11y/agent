import { z } from "zod";
import { recordApiUsage } from "../db/apiUsage.js";
import type { Db } from "../db/client.js";
import type { BudgetGuard } from "../llm/budget.js";

/**
 * Fotos aus dem Google-Profil der Praxis als zweite Quelle fürs Hero-Foto (05.10.2026, Christian: viele Praxen haben
 * auf der Website keine brauchbaren Fotos, im Google-Profil aber schon). Nur Fotos, die die Praxis selbst hochgeladen
 * hat (Urheber = Name der Praxis), nie Fotos von Patienten. Sie gehen danach durch dieselben Regeln und dieselbe
 * Prüfung wie die Website-Fotos (heroPhoto.ts) und erscheinen nur im Entwurf, den die Praxis selbst bekommt.
 */

/** Place Details nur mit dem Feld "photos" (günstigste Stufe) und je Foto ein Abruf (Place Photo). */
export const PHOTO_LIST_COST_USD = 0.005;
export const PHOTO_MEDIA_COST_USD = 0.007;

const photosSchema = z.object({
  photos: z
    .array(
      z.object({
        name: z.string(),
        widthPx: z.number().optional(),
        heightPx: z.number().optional(),
        authorAttributions: z.array(z.object({ displayName: z.string().optional() })).optional(),
      }),
    )
    .optional(),
});

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !GENERIC.has(w));

const GENERIC = new Set([
  "praxis",
  "fuer",
  "physiotherapie",
  "physio",
  "krankengymnastik",
  "therapie",
  "und",
  "gmbh",
  "zentrum",
  "der",
  "die",
  "das",
]);

/**
 * Hat die Praxis das Foto selbst hochgeladen? Urheber-Name und Firmenname teilen ein prägendes Wort (z. B. "Lorre"
 * in "Physiotherapie Lorre" und "Physio Lorre"). Rein.
 */
export function isOwnerPhoto(author: string | undefined, companyName: string): boolean {
  if (!author) return false;
  const a = new Set(words(author));
  if (a.size === 0) return false;
  return words(companyName).some((w) => a.has(w));
}

export interface PhotoRef {
  name: string;
  width: number;
  height: number;
}

/** Eigene Fotos der Praxis aus der Liste, groß genug und nicht zu schmal. Rein. */
export function ownerPhotos(raw: unknown, companyName: string, max = 3): PhotoRef[] {
  const list = photosSchema.parse(raw).photos ?? [];
  return list
    .filter((p) => (p.authorAttributions ?? []).some((a) => isOwnerPhoto(a.displayName, companyName)))
    .map((p) => ({ name: p.name, width: p.widthPx ?? 0, height: p.heightPx ?? 0 }))
    .filter((p) => p.width >= 800 && p.height > 0 && p.width / p.height >= 0.75)
    .slice(0, max);
}

export interface GooglePhotoDeps {
  db: Db;
  budget: BudgetGuard;
  apiKey: string | null | undefined;
  fetchFn?: typeof fetch;
}

/** Bis zu `max` eigene Fotos aus dem Google-Profil laden. Fehler oder kein Schlüssel: leere Liste. */
export function googleOwnerPhotos(
  deps: GooglePhotoDeps,
  max = 3,
): (company: { id: string; name: string; place_id: string | null }) => Promise<Buffer[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  return async (company) => {
    if (!deps.apiKey || !company.place_id) return [];
    try {
      await deps.budget.assertAvailable();
      const res = await fetchFn(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(company.place_id)}`,
        {
          headers: { "X-Goog-Api-Key": deps.apiKey, "X-Goog-FieldMask": "photos" },
          signal: AbortSignal.timeout(20_000),
        },
      );
      await recordApiUsage(deps.db, {
        service: "google_places",
        operation: "place_photos_list",
        costUsd: PHOTO_LIST_COST_USD,
        companyId: company.id,
      });
      if (!res.ok) return [];
      const refs = ownerPhotos(await res.json(), company.name, max);
      const out: Buffer[] = [];
      for (const ref of refs) {
        await deps.budget.assertAvailable();
        const media = await fetchFn(
          `https://places.googleapis.com/v1/${ref.name}/media?maxWidthPx=1600&skipHttpRedirect=true`,
          { headers: { "X-Goog-Api-Key": deps.apiKey }, signal: AbortSignal.timeout(20_000) },
        );
        await recordApiUsage(deps.db, {
          service: "google_places",
          operation: "place_photo",
          costUsd: PHOTO_MEDIA_COST_USD,
          companyId: company.id,
        });
        if (!media.ok) continue;
        const { photoUri } = z.object({ photoUri: z.string().url() }).parse(await media.json());
        // Die Bild-Adresse liefert Google selbst (googleusercontent.com), nur dorthin.
        if (!/^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(photoUri)) continue;
        const img = await fetchFn(photoUri, { signal: AbortSignal.timeout(20_000) });
        if (img.ok) out.push(Buffer.from(await img.arrayBuffer()));
      }
      return out;
    } catch {
      return [];
    }
  };
}
