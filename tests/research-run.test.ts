import { expect, it, vi } from "vitest";
import type { Company } from "../src/db/companies.js";
import type { SearchRun } from "../src/db/searchRuns.js";
import { BudgetExceededError, NO_BUDGET, type BudgetGuard } from "../src/llm/budget.js";
import { LlmError } from "../src/llm/gateway.js";
import { loadBranches } from "../src/pipeline/research/branches.js";
import type { Place, PlacesClient, PlacesPage } from "../src/pipeline/research/places.js";
import type { PrefilterDecision } from "../src/pipeline/research/prefilter.js";
import { runResearch, type ResearchDeps } from "../src/pipeline/research/run.js";
import type { Region } from "../src/pipeline/research/tiling.js";
import { describeDb, useTestDb } from "./helpers/db.js";
import { makePlace } from "./helpers/places.js";

const region: Region = {
  key: "test",
  name: "Landkreis Rosenheim",
  admin_areas: ["Rosenheim"],
  search_radius_km: 5,
  fallback_max_km: 8,
  tiles: [
    { name: "Rosenheim", lat: 47.8561, lng: 12.1289 },
    { name: "Bad Aibling", lat: 47.8638, lng: 12.01 },
  ],
};

const traunstein = makePlace({ id: "e", name: "Rad Traunstein" });
traunstein.addressComponents = traunstein.addressComponents.map((c) =>
  c.types.includes("administrative_area_level_3") ? { ...c, longText: "Traunstein" } : c,
);

const a = makePlace({ id: "a", name: "Radl Meier", websiteUri: "https://www.radlmeier.com/" });
/** Seiten je Anfrage: "<textQuery>|<pageToken>". */
const PAGES: Record<string, PlacesPage> = {
  "Fahrradladen in Rosenheim|": {
    places: [
      a,
      makePlace({ id: "b", name: "Zweirad Schwach", rating: 3.5, userRatingCount: 40 }),
      makePlace({ id: "c", name: "Radl Zu", businessStatus: "CLOSED_PERMANENTLY" }),
      makePlace({ id: "d", name: "Fahrrad XXL Rosenheim" }),
      traunstein,
      makePlace({ id: "f", name: "Radfahrverein Rosenheim" }),
    ],
    invalid: 1,
    nextPageToken: "p2",
  },
  "Fahrradladen in Rosenheim|p2": {
    places: [makePlace({ id: "g", name: "Bike Point" }), a],
    invalid: 0,
    nextPageToken: null,
  },
  "Fahrradladen in Bad Aibling|": {
    places: [
      makePlace({ id: "h", name: "Radsport Hofstetter" }),
      // anderer Google-Eintrag derselben Firma (gleiche Domain wie "a")
      makePlace({ id: "i", name: "Radl Meier Verleih", websiteUri: "https://www.radlmeier.com/verleih/" }),
    ],
    invalid: 0,
    nextPageToken: null,
  },
};

function fakePlaces(pages = PAGES) {
  const searchText = vi.fn((q: { textQuery: string }, token?: string) =>
    Promise.resolve(
      pages[`${q.textQuery}|${token ?? ""}`] ?? { places: [], invalid: 0, nextPageToken: null },
    ),
  );
  return { client: { searchText } as unknown as PlacesClient, searchText };
}

function fakePrefilter() {
  return vi.fn((place: Place): Promise<PrefilterDecision> => {
    const ids = { agentRunId: "00000000-0000-0000-0000-000000000000", costUsd: 0.001 };
    if (place.displayName?.text?.includes("verein")) {
      return Promise.resolve({
        pass: false,
        reason: "off_target",
        detail: "Prefilter: Verein",
        branchKey: null,
        ...ids,
      });
    }
    return Promise.resolve({ pass: true, branchKey: "fahrrad", reason: "passt", ...ids });
  });
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-01T10:00:00Z");

describeDb("runResearch", () => {
  const db = useTestDb();
  const deps = (over: Partial<ResearchDeps> = {}): ResearchDeps => ({
    db: db(),
    places: fakePlaces().client,
    prefilter: fakePrefilter(),
    branches: loadBranches(),
    gate: { min_rating: 4, min_reviews: 15, required_business_status: "OPERATIONAL" },
    recheck: {
      qualified: 90,
      failed: 7,
      skipped: { default: 180, reputation: 365, closed: 365, chain: null, off_target: 30 },
    },
    config: {
      oversearch_factor: 3,
      max_places_requests: 40,
      places_cost_per_request_usd: 0.035,
      prefilter_concurrency: 3,
    },
    budget: NO_BUDGET,
    now: () => T0,
    ...over,
  });
  const request = { term: "Fahrradladen", region, target: 1, requestedBy: "test" };
  const companies = async () => (await db().query<Company>("select * from companies order by place_id")).rows;
  const count = async (table: string) =>
    Number((await db().query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]!.n);

  it("sucht Kachel für Kachel bis zum Ziel und sortiert per Gate und Prefilter aus", async () => {
    const places = fakePlaces();
    const prefilter = fakePrefilter();
    const result = await runResearch(deps({ places: places.client, prefilter: prefilter }), request);

    expect(result.passed.map((c) => c.place_id).sort()).toEqual(["a", "g", "h"]);
    expect(result.stats).toMatchObject({
      goal: 3,
      tiles_total: 2,
      tiles_searched: 2,
      places_requests: 3,
      places_cost_usd: 0.105,
      results: 10,
      invalid_results: 1,
      out_of_region: 1,
      duplicates_in_run: 2, // "a" erneut auf Seite 2, "i" = gleiche Domain wie "a"
      new_companies: 7,
      known_companies: 0,
      gate_skipped: { reputation: 1, closed: 1, chain: 1 },
      prefilter_skipped: { off_target: 1 },
      prefilter_errors: 0,
      llm_cost_usd: 0.004,
      passed: 3,
      stopped_because: "goal_reached",
    });
    // Gate läuft vor dem Prefilter: nur a, f, g, h kosten einen LLM-Aufruf.
    expect(prefilter).toHaveBeenCalledTimes(4);
    expect(places.searchText).toHaveBeenCalledTimes(3);

    const rows = await companies();
    expect(rows.map((r) => [r.place_id, r.status, r.skip_reason])).toEqual([
      ["a", "RESEARCHED", null],
      ["b", "SKIPPED", "reputation"],
      ["c", "SKIPPED", "closed"],
      ["d", "SKIPPED", "chain"],
      ["f", "SKIPPED", "off_target"],
      ["g", "RESEARCHED", null],
      ["h", "RESEARCHED", null],
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.place_id, r])) as Record<string, Company>;
    expect(byId.a).toMatchObject({
      branch_key: "fahrrad",
      first_search_run_id: result.run.id,
      region: "Landkreis Rosenheim",
    });
    expect(byId.b!.skip_detail).toBe("Bewertung zu schwach (3,5★, mindestens 4,0★)");
    expect(byId.b!.recheck_after).toEqual(new Date(T0.getTime() + 365 * DAY));
    expect(byId.d!.recheck_after).toBeNull();
    expect(byId.f!.recheck_after).toEqual(new Date(T0.getTime() + 30 * DAY));
    expect(await count("places_snapshots")).toBe(7);
    // Jede Places-Anfrage zählt mit ihren Kosten für den Budget-Wächter.
    const usage = await db().query<{ n: number; cost: string }>(
      "select count(*)::int as n, sum(cost_usd) as cost from api_usage where search_run_id = $1 and service = 'places'",
      [result.run.id],
    );
    expect(usage.rows[0]).toEqual({ n: 3, cost: "0.10500" });

    const run = (await db().query<SearchRun>("select * from search_runs where id = $1", [result.run.id]))
      .rows[0]!;
    expect(run).toMatchObject({ status: "COMPLETED", target_count: 1, requested_by: "test" });
    expect(run.query).toEqual({ term: "Fahrradladen", region: "test", branch_key: "fahrrad" });
    expect(run.stats.passed).toBe(3);
    expect(run.finished_at).toBeInstanceOf(Date);
  });

  it("Doppellauf: bekannte Firmen werden erkannt und nicht erneut geprüft", async () => {
    const prefilter = fakePrefilter();
    const result = await runResearch(deps({ prefilter: prefilter }), request);

    expect(result.stats).toMatchObject({
      new_companies: 0,
      known_companies: 7,
      known_not_due: 7,
      passed: 0,
      gate_skipped: {},
      stopped_because: "tiles_exhausted",
    });
    expect(prefilter).not.toHaveBeenCalled();
    expect(await count("companies")).toBe(7);
    // Bekannte Firmen bekommen eine neue Places-Momentaufnahme.
    expect(await count("places_snapshots")).toBe(14);
  });

  it("prüft übersprungene Firmen erneut, sobald recheck_after erreicht ist", async () => {
    const prefilter = fakePrefilter();
    const later = new Date(T0.getTime() + 400 * DAY);
    const result = await runResearch(deps({ prefilter: prefilter, now: () => later }), request);

    // b/c (365 Tage) und f (30 Tage) sind fällig, d (Kette) nie, a/g/h sind noch in der Pipeline.
    expect(result.stats).toMatchObject({
      known_not_due: 4,
      gate_skipped: { reputation: 1, closed: 1 },
      prefilter_skipped: { off_target: 1 },
    });
    expect(prefilter).toHaveBeenCalledTimes(1);
  });

  it("Prefilter-Fehler: Firma bleibt NEW und wird beim nächsten Lauf fertig geprüft", async () => {
    await db().query("truncate companies, search_runs cascade");
    const only = {
      "Fahrradladen in Rosenheim|": { places: [makePlace({ id: "z" })], invalid: 0, nextPageToken: null },
    };
    const failing = vi.fn(() =>
      Promise.reject(new LlmError("prefilter: overloaded", "00000000-0000-0000-0000-000000000000")),
    );

    const first = await runResearch(deps({ places: fakePlaces(only).client, prefilter: failing }), request);
    expect(first.stats).toMatchObject({ prefilter_errors: 1, passed: 0 });
    expect((await companies())[0]).toMatchObject({ place_id: "z", status: "NEW" });

    const second = await runResearch(deps({ places: fakePlaces(only).client }), request);
    expect(second.stats).toMatchObject({ known_companies: 1, known_not_due: 0, passed: 1 });
    expect((await companies())[0]).toMatchObject({ status: "RESEARCHED" });
  });

  it("hält die Obergrenze für Places-Anfragen ein", async () => {
    const places = fakePlaces();
    const result = await runResearch(
      deps({
        places: places.client,
        config: {
          oversearch_factor: 3,
          max_places_requests: 1,
          places_cost_per_request_usd: 0.035,
          prefilter_concurrency: 1,
        },
      }),
      { ...request, target: 50 },
    );
    expect(places.searchText).toHaveBeenCalledTimes(1);
    expect(result.stats.stopped_because).toBe("request_limit");
  });

  it("markiert den Lauf als FAILED, wenn Places ausfällt", async () => {
    const searchText = vi.fn(() => Promise.reject(new Error("Places: HTTP 403")));
    await expect(
      runResearch(deps({ places: { searchText } as unknown as PlacesClient }), request),
    ).rejects.toThrow(/403/);
    const { rows } = await db().query(
      "select status, stats from search_runs order by created_at desc limit 1",
    );
    expect(rows[0]).toMatchObject({ status: "FAILED", stats: { error: "Places: HTTP 403" } });
  });
  it("hält bei erschöpftem Budget sauber an; offene Firmen bleiben NEW", async () => {
    await db().query("truncate companies, search_runs, api_usage cascade");
    // Budget reicht für genau eine Places-Anfrage; der Prefilter scheitert danach am Budget.
    let checks = 0;
    const budget: BudgetGuard = {
      limits: { daily_usd: 1, monthly_usd: 1 },
      assertAvailable: () =>
        ++checks <= 1 ? Promise.resolve() : Promise.reject(new BudgetExceededError("Tag", 1, 1)),
    };
    const prefilter = vi.fn(() => Promise.reject(new BudgetExceededError("Tag", 1, 1)));
    const places = fakePlaces();

    const result = await runResearch(deps({ places: places.client, prefilter, budget }), request);

    expect(places.searchText).toHaveBeenCalledTimes(1);
    expect(result.stats).toMatchObject({
      places_requests: 1,
      passed: 0,
      stopped_because: "budget_exceeded",
      error: "Budget für heute erreicht: 1.00 $ von 1.00 $ (config/models.yaml → budget)",
    });
    const run = (await db().query<SearchRun>("select * from search_runs where id = $1", [result.run.id]))
      .rows[0]!;
    expect(run.status).toBe("COMPLETED");
    // a und f haben das Gate bestanden, sind aber noch nicht geprüft → bleiben NEW für den nächsten Lauf.
    const open = (await companies()).filter((c) => c.status === "NEW").map((c) => c.place_id);
    expect(open.sort()).toEqual(["a", "f"]);
  });

  it("prüft das Budget vor jeder Places-Anfrage", async () => {
    const places = fakePlaces();
    const budget: BudgetGuard = {
      limits: { daily_usd: 1, monthly_usd: 1 },
      assertAvailable: () => Promise.reject(new BudgetExceededError("Monat", 1, 1)),
    };
    const result = await runResearch(deps({ places: places.client, budget }), request);
    expect(places.searchText).not.toHaveBeenCalled();
    expect(result.stats).toMatchObject({ places_requests: 0, stopped_because: "budget_exceeded" });
  });
});
