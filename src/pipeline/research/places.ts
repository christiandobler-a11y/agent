import { z } from "zod";
import type { CompanyCandidate } from "../../db/companies.js";
import type { RegionProbe, TileQuery } from "./tiling.js";

/** Google Places API (New), Text Search. https://developers.google.com/maps/documentation/places/web-service/text-search */

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

/** Nur diese Felder werden abgerufen (Kosten hängen am teuersten Feld: Website/Bewertungen = Enterprise). */
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.photos.name",
  "nextPageToken",
].join(",");

/** Höchstwert der API je Seite; maximal 3 Seiten (60 Treffer) je Anfrage. */
export const PAGE_SIZE = 20;
export const MAX_PAGES = 3;

const localizedText = z.object({ text: z.string() }).partial();

export const placeSchema = z.object({
  id: z.string().min(1),
  displayName: localizedText.optional(),
  formattedAddress: z.string().optional(),
  addressComponents: z
    .array(z.object({ longText: z.string().optional(), types: z.array(z.string()).default([]) }))
    .default([]),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  types: z.array(z.string()).default([]),
  primaryType: z.string().optional(),
  primaryTypeDisplayName: localizedText.optional(),
  websiteUri: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().int().optional(),
  businessStatus: z.string().optional(),
  photos: z.array(z.unknown()).optional(),
});

export type Place = z.infer<typeof placeSchema>;

const responseSchema = z.object({
  places: z.array(z.unknown()).default([]),
  nextPageToken: z.string().optional(),
});

export interface PlacesPage {
  places: Place[];
  /** Einträge, die nicht ins Schema passten (z. B. ohne ID); werden übersprungen. */
  invalid: number;
  nextPageToken: string | null;
}

export interface PlacesClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Wiederholungen bei 429/5xx/Netzwerkfehler (exponentielles Backoff ab 1 s). */
  retries?: number;
  timeoutMs?: number;
}

export class PlacesError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "PlacesError";
  }
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

export function createPlacesClient(options: PlacesClientOptions) {
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function post(body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchFn(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": options.apiKey,
            "X-Goog-FieldMask": FIELD_MASK,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new PlacesError(
          `Places nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`,
          null,
        );
      }
      if (res.ok) return res.json();
      if (RETRYABLE(res.status) && attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const detail = (await res.text()).slice(0, 300);
      throw new PlacesError(`Places: HTTP ${res.status} ${detail}`, res.status);
    }
  }

  return {
    /** Eine Ergebnisseite für eine Kachel. `pageToken` aus der vorigen Seite für die nächste. */
    async searchText(query: TileQuery, pageToken?: string): Promise<PlacesPage> {
      const raw = await post({
        textQuery: query.textQuery,
        languageCode: "de",
        regionCode: "de",
        pageSize: PAGE_SIZE,
        locationBias: {
          circle: {
            center: { latitude: query.center.lat, longitude: query.center.lng },
            radius: query.radiusMeters,
          },
        },
        ...(pageToken ? { pageToken } : {}),
      });
      const parsed = responseSchema.parse(raw);
      const places: Place[] = [];
      let invalid = 0;
      for (const p of parsed.places) {
        const result = placeSchema.safeParse(p);
        if (result.success) places.push(result.data);
        else invalid++;
      }
      return { places, invalid, nextPageToken: parsed.nextPageToken ?? null };
    },
  };
}

export type PlacesClient = ReturnType<typeof createPlacesClient>;

function component(place: Place, type: string): string | null {
  return place.addressComponents.find((c) => c.types.includes(type))?.longText?.trim() || null;
}

export function regionProbe(place: Place): RegionProbe {
  return {
    adminArea: component(place, "administrative_area_level_3"),
    location: place.location ? { lat: place.location.latitude, lng: place.location.longitude } : null,
  };
}

/** Places-Treffer → Firmen-Kandidat für den Dubletten-Abgleich. */
export function placeToCandidate(
  place: Place,
  regionName: string,
  searchRunId: string | null,
): CompanyCandidate {
  const route = component(place, "route");
  const number = component(place, "street_number");
  return {
    name: place.displayName?.text?.trim() || place.formattedAddress || place.id,
    placeId: place.id,
    websiteUrl: place.websiteUri ?? null,
    street: route ? [route, number].filter(Boolean).join(" ") : null,
    postalCode: component(place, "postal_code"),
    city: component(place, "locality") ?? component(place, "postal_town"),
    region: regionName,
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    category: place.primaryTypeDisplayName?.text ?? place.primaryType ?? null,
    phone: place.nationalPhoneNumber ?? null,
    searchRunId,
  };
}
