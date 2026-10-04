import { z } from "zod";
import { recordApiUsage } from "../db/apiUsage.js";
import { getState, setState } from "../db/appState.js";
import type { Db } from "../db/client.js";
import type { BudgetGuard } from "../llm/budget.js";

/**
 * Google-Details für einen Prototyp (einmal je Lead): Bewertungen, Öffnungszeiten, Maps-Link. Reviews gehören zur
 * teureren Places-Stufe, deshalb nur hier und nicht bei der Suche. Bewertungstexte sind fremder Inhalt: nur gekürzt
 * angezeigt, nie an Werkzeuge weitergereicht.
 */

export const PLACE_DETAILS_COST_USD = 0.025;

const detailsSchema = z.object({
  googleMapsUri: z.string().optional(),
  regularOpeningHours: z.object({ weekdayDescriptions: z.array(z.string()).optional() }).optional(),
  reviews: z
    .array(
      z.object({
        rating: z.number().optional(),
        text: z.object({ text: z.string() }).optional(),
        originalText: z.object({ text: z.string() }).optional(),
        authorAttribution: z.object({ displayName: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

export interface PlaceDetails {
  mapsUrl: string | null;
  hours: string[];
  quotes: { text: string; author: string }[];
}

/** "Anna Maier" → "Anna M." (weniger persönliche Daten auf der Vorschau). */
export function shortAuthor(name: string | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || !/^\p{L}{2,}/u.test(parts[0]!)) return "Google-Bewertung";
  return parts.length === 1 ? parts[0]! : `${parts[0]} ${parts.at(-1)![0]}.`;
}

/** An einer Satzgrenze kürzen, höchstens `max` Zeichen. */
export function shortenQuote(text: string, max = 220): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > 80 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))} …`;
}

const DAY_SHORT: Record<string, string> = {
  montag: "Mo",
  dienstag: "Di",
  mittwoch: "Mi",
  donnerstag: "Do",
  freitag: "Fr",
  samstag: "Sa",
  sonntag: "So",
};

/** "Montag: 09:00–18:00 Uhr" × 7 → ["Mo–Fr: 09:00–18:00 Uhr", "Sa–So: geschlossen"] (gleiche Zeiten zusammen). */
export function compressHours(lines: readonly string[]): string[] {
  const days = lines
    .map((l) => /^([^:]+):\s*(.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      day: DAY_SHORT[m[1]!.toLowerCase()] ?? m[1]!,
      value: m[2]!.replace(/^Geschlossen$/i, "geschlossen"),
    }));
  const out: string[] = [];
  for (let i = 0; i < days.length;) {
    let j = i;
    while (j + 1 < days.length && days[j + 1]!.value === days[i]!.value) j++;
    const label = i === j ? days[i]!.day : `${days[i]!.day}${j === i + 1 ? ", " : "–"}${days[j]!.day}`;
    out.push(`${label}: ${days[i]!.value}`);
    i = j + 1;
  }
  return out;
}

export function parseDetails(raw: unknown): PlaceDetails {
  const d = detailsSchema.parse(raw);
  const quotes = (d.reviews ?? [])
    .filter((r) => (r.rating ?? 0) >= 4)
    .map((r) => ({
      text: (r.originalText ?? r.text)?.text ?? "",
      author: shortAuthor(r.authorAttribution?.displayName),
    }))
    .filter((q) => q.text.trim().length >= 40)
    .slice(0, 3)
    .map((q) => ({ ...q, text: shortenQuote(q.text) }));
  return {
    mapsUrl: d.googleMapsUri ?? null,
    hours: compressHours(d.regularOpeningHours?.weekdayDescriptions ?? []),
    quotes,
  };
}

export async function fetchPlaceDetails(
  apiKey: string,
  placeId: string,
  fetchFn: typeof fetch = fetch,
): Promise<PlaceDetails> {
  const res = await fetchFn(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=de`,
    {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "googleMapsUri,regularOpeningHours.weekdayDescriptions,reviews",
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) throw new Error(`Places-Details: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return parseDetails(await res.json());
}

/**
 * Google-Details je Firma einmal holen und merken (app_state), für das Vorschau-Bild (echte Bewertung,
 * Öffnungszeiten). Fehler oder kein Schlüssel: `null`, das Bild kommt dann ohne.
 */
export function cachedPlaceDetails(deps: {
  db: Db;
  budget: BudgetGuard;
  apiKey: string | null | undefined;
  fetchFn?: typeof fetch;
}): (company: { id: string; place_id: string | null }) => Promise<PlaceDetails | null> {
  return async (company) => {
    const key = `place-details:${company.id}`;
    const cached = await getState<PlaceDetails>(deps.db, key);
    if (cached) return cached;
    if (!deps.apiKey || !company.place_id) return null;
    try {
      await deps.budget.assertAvailable();
      const details = await fetchPlaceDetails(deps.apiKey, company.place_id, deps.fetchFn);
      await recordApiUsage(deps.db, {
        service: "google_places",
        operation: "place_details_teaser",
        costUsd: PLACE_DETAILS_COST_USD,
        companyId: company.id,
      });
      await setState(deps.db, key, details);
      return details;
    } catch {
      return null;
    }
  };
}
