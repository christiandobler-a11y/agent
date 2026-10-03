import { describe, expect, it, vi } from "vitest";
import {
  createPlacesClient,
  placeToCandidate,
  PlacesError,
  regionProbe,
} from "../src/pipeline/research/places.js";
import type { TileQuery } from "../src/pipeline/research/tiling.js";
import { makePlace } from "./helpers/places.js";

const query: TileQuery = {
  tile: { name: "Bad Aibling", lat: 47.8638, lng: 12.01 },
  key: "Bad Aibling",
  depth: 0,
  textQuery: "Fahrradladen in Bad Aibling",
  center: { lat: 47.8638, lng: 12.01 },
  radiusMeters: 5000,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** fetch-Mock, der bei jedem Aufruf die Antwort aus `next` liefert (oder deren Fehler wirft). */
const mockFetch = (next: () => Response) => vi.fn<typeof fetch>(() => Promise.resolve().then(next));
const noSleep = () => vi.fn((_ms: number) => Promise.resolve());
const bodyOf = (init: RequestInit | undefined) => JSON.parse(init?.body as string) as Record<string, unknown>;

describe("createPlacesClient", () => {
  it("schickt Begriff, Standort-Bias, Feldmaske und Key im Header", async () => {
    const fetchFn = mockFetch(() => json({ places: [makePlace({ id: "a" })], nextPageToken: "next" }));
    const client = createPlacesClient({ apiKey: "secret", fetch: fetchFn });

    const page = await client.searchText(query);

    expect(page.places.map((p) => p.id)).toEqual(["a"]);
    expect(page.nextPageToken).toBe("next");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("secret");
    expect(headers["X-Goog-FieldMask"]).toContain("places.websiteUri");
    expect(headers["X-Goog-FieldMask"]).toContain("nextPageToken");
    expect(url).not.toContain("secret");
    expect(bodyOf(init)).toEqual({
      textQuery: "Fahrradladen in Bad Aibling",
      languageCode: "de",
      regionCode: "de",
      pageSize: 20,
      locationBias: { circle: { center: { latitude: 47.8638, longitude: 12.01 }, radius: 5000 } },
    });
  });

  it("reicht den Seiten-Token weiter und zählt ungültige Einträge", async () => {
    const fetchFn = mockFetch(() =>
      json({ places: [makePlace({ id: "b" }), { displayName: { text: "ohne ID" } }] }),
    );
    const client = createPlacesClient({ apiKey: "k", fetch: fetchFn });

    const page = await client.searchText(query, "token-2");

    expect(page).toMatchObject({ invalid: 1, nextPageToken: null });
    expect(page.places).toHaveLength(1);
    expect(bodyOf(fetchFn.mock.calls[0]![1]).pageToken).toBe("token-2");
  });

  it("liefert eine leere Seite, wenn Google nichts findet", async () => {
    const client = createPlacesClient({ apiKey: "k", fetch: mockFetch(() => json({})) });
    expect(await client.searchText(query)).toEqual({ places: [], invalid: 0, nextPageToken: null });
  });

  it("wiederholt 429/5xx und Netzwerkfehler mit Backoff", async () => {
    const responses = [
      () => json({ error: "rate" }, 429),
      () => {
        throw new TypeError("fetch failed");
      },
      () => json({ error: "oops" }, 503),
      () => json({ places: [makePlace({ id: "c" })] }),
    ];
    const fetchFn = mockFetch(() => responses.shift()!());
    const sleep = noSleep();
    const client = createPlacesClient({ apiKey: "k", fetch: fetchFn, sleep });

    const page = await client.searchText(query);

    expect(page.places).toHaveLength(1);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
  });

  it("gibt nach den Wiederholungen bzw. bei 4xx sofort auf", async () => {
    const sleep = noSleep();
    const always503 = createPlacesClient({
      apiKey: "k",
      fetch: mockFetch(() => json({}, 503)),
      sleep,
      retries: 2,
    });
    await expect(always503.searchText(query)).rejects.toThrow(/HTTP 503/);
    expect(sleep).toHaveBeenCalledTimes(2);

    const fetch400 = mockFetch(() => json({ error: { message: "API key not valid" } }, 400));
    const bad = createPlacesClient({ apiKey: "k", fetch: fetch400, sleep });
    const err = await bad.searchText(query).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlacesError);
    expect((err as PlacesError).status).toBe(400);
    expect(fetch400).toHaveBeenCalledTimes(1);
  });
});

describe("placeToCandidate / regionProbe", () => {
  it("übernimmt Adresse, Kategorie und Kontakt aus dem Treffer", () => {
    const place = makePlace({ id: "radl", name: "Radl Meier" });
    expect(placeToCandidate(place, "Landkreis Rosenheim", "run-1")).toEqual({
      name: "Radl Meier",
      placeId: "radl",
      websiteUrl: "https://www.radl.de/",
      street: "Hauptstraße 1",
      postalCode: "83043",
      city: "Bad Aibling",
      region: "Landkreis Rosenheim",
      lat: 47.86,
      lng: 12.01,
      category: "Fahrradgeschäft",
      phone: "08061 12345",
      searchRunId: "run-1",
    });
    expect(regionProbe(place)).toEqual({ adminArea: "Rosenheim", location: { lat: 47.86, lng: 12.01 } });
  });

  it("kommt mit spärlichen Treffern zurecht", () => {
    const place = { id: "x", addressComponents: [], types: [] };
    expect(placeToCandidate(place, "R", null)).toMatchObject({
      name: "x",
      websiteUrl: null,
      street: null,
      postalCode: null,
      category: null,
    });
    expect(regionProbe(place)).toEqual({ adminArea: null, location: null });
  });
});
