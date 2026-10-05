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

const DAY_ORDER = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/**
 * Öffnungszeiten für einen Wochentag aus den zusammengefassten Zeilen ("Mo–Fr: 08:00–12:00", "Sa, So: geschlossen").
 * `weekday`: 0 = Sonntag (Date.getDay). `null`, wenn der Tag nicht vorkommt. Rein.
 */
export function hoursOn(hours: readonly string[], weekday: number): string | null {
  const want = DAY_ORDER[(weekday + 6) % 7]!;
  for (const line of hours) {
    const m = /^([^:]+):\s*(.+)$/.exec(line);
    if (!m) continue;
    const days = new Set<string>();
    for (const part of m[1]!.split(",").map((x) => x.trim())) {
      const range = /^(\p{L}{2})[–-](\p{L}{2})$/u.exec(part);
      if (range) {
        const from = DAY_ORDER.indexOf(range[1]!);
        const to = DAY_ORDER.indexOf(range[2]!);
        for (let i = from; i >= 0 && i <= to; i++) days.add(DAY_ORDER[i]!);
      } else days.add(part);
    }
    if (days.has(want)) return m[2]!.trim();
  }
  return null;
}

export const OPENING_HOURS_COST_USD = 0.02;

/**
 * Öffnungszeiten je Firma (Anruf-Liste): aus der letzten Places-Suche, sonst einmal nur dieses Feld abrufen und in
 * app_state merken. Ohne Schlüssel oder bei Fehlern: leere Liste.
 */
export function cachedOpeningHours(deps: {
  db: Db;
  budget: BudgetGuard;
  apiKey: string | null | undefined;
  fetchFn?: typeof fetch;
}): (company: { id: string; place_id: string | null }) => Promise<string[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  return async (company) => {
    const key = `place-hours:${company.id}`;
    const cached = await getState<string[]>(deps.db, key);
    if (cached) return cached;
    const { rows } = await deps.db.query<{ lines: string[] | null }>(
      `select raw->'regularOpeningHours'->'weekdayDescriptions' as lines from places_snapshots
        where company_id = $1 order by fetched_at desc limit 1`,
      [company.id],
    );
    let lines = rows[0]?.lines ?? null;
    if (!lines && deps.apiKey && company.place_id) {
      try {
        await deps.budget.assertAvailable();
        const res = await fetchFn(
          `https://places.googleapis.com/v1/places/${encodeURIComponent(company.place_id)}?languageCode=de`,
          {
            headers: {
              "X-Goog-Api-Key": deps.apiKey,
              "X-Goog-FieldMask": "regularOpeningHours.weekdayDescriptions",
            },
            signal: AbortSignal.timeout(20_000),
          },
        );
        await recordApiUsage(deps.db, {
          service: "google_places",
          operation: "opening_hours",
          costUsd: OPENING_HOURS_COST_USD,
          companyId: company.id,
        });
        if (res.ok)
          lines = detailsSchema.parse(await res.json()).regularOpeningHours?.weekdayDescriptions ?? [];
      } catch {
        return [];
      }
    }
    const hours = compressHours(lines ?? []);
    if (lines) await setState(deps.db, key, hours);
    return hours;
  };
}

/**
 * Ist die Praxis zur Uhrzeit `time` ("HH:MM") offen? Aus der Zeile für heute ("08:00–12:00, 14:00–19:00",
 * "geschlossen", "24 Stunden geöffnet"). `open: null`, wenn sich die Zeile nicht lesen lässt; `next` = nächste
 * Öffnung heute. Rein.
 */
export function openAt(today: string | null, time: string): { open: boolean | null; next: string | null } {
  if (!today) return { open: null, next: null };
  if (/geschlossen/i.test(today)) return { open: false, next: null };
  if (/24\s*Stunden/i.test(today)) return { open: true, next: null };
  const ranges = [...today.matchAll(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/g)].map((m) => ({
    from: `${m[1]!.padStart(2, "0")}:${m[2]}`,
    to: `${m[3]!.padStart(2, "0")}:${m[4]}`,
  }));
  if (ranges.length === 0) return { open: null, next: null };
  if (ranges.some((r) => time >= r.from && time < r.to)) return { open: true, next: null };
  return { open: false, next: ranges.find((r) => r.from > time)?.from ?? null };
}
