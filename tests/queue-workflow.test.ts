import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { getSearchRun } from "../src/db/searchRuns.js";
import { BudgetExceededError, NO_BUDGET } from "../src/llm/budget.js";
import type { LlmGateway, StructuredRequest } from "../src/llm/gateway.js";
import type { AuditOutput } from "../src/pipeline/audit/schema.js";
import type { BrowserCrawler, SiteCapture } from "../src/pipeline/crawl/browser.js";
import { CrawlError } from "../src/pipeline/crawl/classify.js";
import type { CrawlConfig } from "../src/pipeline/crawl/config.js";
import { loadBranches } from "../src/pipeline/research/branches.js";
import type { Place, PlacesPage } from "../src/pipeline/research/places.js";
import type { Region } from "../src/pipeline/research/tiling.js";
import { loadScoringConfig } from "../src/pipeline/scoring/config.js";
import { createBoss, ensureQueues, type QueueConfig } from "../src/queue/boss.js";
import type { Notifier, RunSummary } from "../src/queue/notifier.js";
import { nextStep, startSearch, type PipelineContext } from "../src/queue/pipeline.js";
import { budgetResumeAt, startWorkers } from "../src/queue/workers.js";
import { describeDb, TEST_DATABASE_URL, useTestDb } from "./helpers/db.js";
import { makePlace } from "./helpers/places.js";

/** Echter pg-boss gegen die Test-DB; alles Externe (Places, LLM, Browser) ist gefälscht. */

const dir = mkdtempSync(join(tmpdir(), "avelio-queue-"));
const desktop = join(dir, "d.jpg");
const mobile = join(dir, "m.jpg");

const region: Region = {
  key: "test",
  name: "Landkreis Rosenheim",
  admin_areas: ["Rosenheim"],
  search_radius_km: 5,
  fallback_max_km: 8,
  tiles: [{ name: "Rosenheim", lat: 47.8561, lng: 12.1289 }],
};

const PLACES: Place[] = [
  makePlace({ id: "a", name: "Radhaus Alt", websiteUri: "https://radhaus-alt.de/" }),
  makePlace({ id: "b", name: "Radl Ohne", websiteUri: undefined }),
  makePlace({ id: "c", name: "Rad Kaputt", websiteUri: "https://kaputt.example.de/" }),
];

const queueConfig: QueueConfig = {
  queues: {
    research: {
      retry_limit: 1,
      retry_delay_s: 1,
      retry_backoff: false,
      retry_delay_max_s: 1,
      heartbeat_s: 10,
      expire_s: 120,
      concurrency: 1,
    },
    crawl: {
      retry_limit: 1,
      retry_delay_s: 1,
      retry_backoff: false,
      retry_delay_max_s: 1,
      heartbeat_s: 10,
      expire_s: 120,
      concurrency: 2,
    },
    audit: {
      retry_limit: 1,
      retry_delay_s: 1,
      retry_backoff: false,
      retry_delay_max_s: 1,
      heartbeat_s: 10,
      expire_s: 120,
      concurrency: 2,
    },
    pitch: {
      retry_limit: 1,
      retry_delay_s: 1,
      retry_backoff: false,
      retry_delay_max_s: 1,
      heartbeat_s: 10,
      expire_s: 120,
      concurrency: 1,
    },
  },
  sweep_every_minutes: 1,
  budget_resume_time: "06:00",
};

const rubric = (score: number) => ({ score, evidence: "Screenshot" });
const AUDIT: AuditOutput = {
  summary: "Veraltet.",
  design_era: "ca. 2012",
  rubric: {
    design_age: rubric(1),
    mobile_ux: rubric(1),
    cta_clarity: rubric(1),
    services_visibility: rubric(2),
    trust_signals: rubric(2),
    hero_message: rubric(1),
  },
  findings: [1, 2, 3].map((i) => ({
    title: `P${i}`,
    detail: "d",
    evidence: "e",
    severity: "high" as const,
    category: "design" as const,
  })),
  commercial: {
    services: [],
    high_value_services: ["E-Bike-Leasing", "E-Bikes"],
    size_signals: [],
    team_size: "medium",
  },
};

function capture(url: string): SiteCapture {
  return {
    requestedUrl: url,
    finalUrl: url,
    httpStatus: 200,
    html: "<html><head><title>Radhaus</title></head><body><h1>Willkommen</h1><p>Fahrräder und Werkstatt seit 1990 in Rosenheim, Reparatur aller Marken.</p></body></html>",
    title: "Radhaus",
    tlsValid: true,
    cookieBannerClicked: false,
    mobileOverflowPx: 200,
    desktopScreenshot: desktop,
    mobileScreenshot: mobile,
    impressum: { url, html: "<p>Inhaber: Max Rad<br>Telefon: 08031 1<br>E-Mail: max@radhaus-alt.de</p>" },
    services: null,
  };
}

interface Harness {
  ctx: PipelineContext;
  boss: PgBoss;
  notified: RunSummary[];
  budgetMessages: string[];
  llm: ReturnType<typeof vi.fn>;
  crawl: ReturnType<typeof vi.fn>;
}

describeDb("Workflow über pg-boss", () => {
  const db = useTestDb();
  const bossSchema = `boss_${Math.random().toString(36).slice(2, 10)}`;
  const bosses: PgBoss[] = [];

  beforeAll(async () => {
    const solid = (w: number, h: number) =>
      sharp({ create: { width: w, height: h, channels: 3, background: "#f0f0f0" } });
    await solid(1440, 2700).jpeg().toFile(desktop);
    await solid(780, 5064).jpeg().toFile(mobile);
  });

  // Auch wenn ein Test scheitert: keine Worker in den nächsten Test mitnehmen.
  afterEach(async () => {
    for (const b of bosses.splice(0)) await b.stop({ graceful: false, close: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await db().query(`drop schema if exists ${bossSchema} cascade`);
  });

  async function harness(
    over: { crawl?: BrowserCrawler["crawl"]; llm?: (req: StructuredRequest<never>) => Promise<unknown> } = {},
  ): Promise<Harness> {
    const boss = createBoss(TEST_DATABASE_URL!, {
      schema: bossSchema,
      superviseIntervalSeconds: 1,
      schedule: false,
      max: 3,
    });
    bosses.push(boss);
    await boss.start();
    await ensureQueues(boss, queueConfig);
    const notified: RunSummary[] = [];
    const budgetMessages: string[] = [];
    const notifier: Notifier = {
      runCompleted: (s) => (notified.push(s), Promise.resolve()),
      runFailed: () => Promise.resolve(),
      budgetExceeded: (m) => (budgetMessages.push(m), Promise.resolve()),
    };
    const llm = vi.fn(
      over.llm ??
        ((req: StructuredRequest<never>) =>
          Promise.resolve({
            output:
              req.role === "audit"
                ? AUDIT
                : { main_opportunity: "Chance", arguments: ["1", "2", "3"], opening_line: "Hallo" },
            agentRunId: null,
            costUsd: 0.01,
            model: req.role === "audit" ? "claude-sonnet-5-5" : "claude-opus-5-5",
          })),
    );
    const crawl = vi.fn<BrowserCrawler["crawl"]>(
      over.crawl ??
        ((url) =>
          url.includes("kaputt")
            ? Promise.reject(new CrawlError("unreachable", "net::ERR_NAME_NOT_RESOLVED"))
            : Promise.resolve(capture(url))),
    );
    const pages: PlacesPage = { places: PLACES, invalid: 0, nextPageToken: null };
    const recheck = { qualified: 90, failed: 7, skipped: { default: 180, low_score: 180, reputation: 365 } };
    const ctx: PipelineContext = {
      db: db(),
      boss,
      bossSchema,
      queueConfig,
      research: {
        places: { searchText: () => Promise.resolve(pages) },
        prefilter: () =>
          Promise.resolve({
            pass: true,
            branchKey: "fahrrad",
            reason: "passt",
            agentRunId: "00000000-0000-0000-0000-000000000000",
            costUsd: 0.001,
          }),
        branches: loadBranches(),
        gate: { min_rating: 4, min_reviews: 15, required_business_status: "OPERATIONAL" },
        recheck,
        config: {
          oversearch_factor: 3,
          max_places_requests: 5,
          places_cost_per_request_usd: 0.035,
          prefilter_concurrency: 2,
          max_places_requests_complete: 100,
          coverage_valid_days: 180,
        },
        budget: NO_BUDGET,
      },
      loadRegion: () => region,
      lead: {
        llm: { structured: llm } as unknown as LlmGateway,
        crawl: {
          desktop: { width: 1440, height: 900, scale: 1 },
          mobile: { width: 390, height: 844, scale: 2 },
        } as CrawlConfig,
        scoring: loadScoringConfig(),
        branches: loadBranches(),
        recheck,
      },
      crawl: {
        config: {
          mobile: { width: 390, height: 844, scale: 2 },
          screenshot_dir: dir,
          text_max_words: 500,
        } as CrawlConfig,
        crawler: () => Promise.resolve({ crawl, close: () => Promise.resolve() }),
        pagespeed: {
          run: () =>
            Promise.resolve({
              strategy: "mobile",
              performance: 25,
              seo: 70,
              best_practices: 80,
              accessibility: 70,
              lcp_ms: 1,
              fcp_ms: 1,
              tbt_ms: 1,
              cls: 0,
              speed_index_ms: 1,
              final_url: null,
            }),
        },
      },
      budget: NO_BUDGET,
      notifier,
      now: () => new Date(),
    };
    return { ctx, boss, notified, budgetMessages, llm, crawl };
  }

  async function waitFor(check: () => Promise<boolean>, ms = 45_000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("Zeitüberschreitung");
  }
  const companies = async () =>
    (
      await db().query<{ place_id: string; status: string; skip_detail: string | null }>(
        "select place_id, status, skip_detail from companies order by place_id",
      )
    ).rows;
  const count = async (table: string) =>
    Number((await db().query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]!.n);

  it("Suche läuft komplett durch: jede Firma im Endzustand, eine Meldung mit Top-Leads (Kriterien 2 und 7)", async () => {
    const h = await harness();
    await startWorkers(h.ctx);
    const run = await startSearch(h.ctx, {
      term: "Fahrradladen",
      regionKey: "test",
      target: 1,
      requestedBy: "test",
    });
    await waitFor(async () => (await getSearchRun(db(), run.id))!.status === "COMPLETED");

    const all = await companies();
    expect(all.map((c) => c.place_id)).toEqual(["a", "b", "c"]);
    expect(all[0]!.status).toBe("QUALIFIED");
    expect(["QUALIFIED", "SKIPPED"]).toContain(all[1]!.status); // ohne Website: Score ohne Audit
    expect(all[2]!.status).toBe("FAILED");
    expect((await companies())[2]!.skip_detail).toContain("unreachable");
    // c: erster Versuch + 1 Wiederholung (retry_limit 1), danach endgültig FAILED – der Lauf läuft trotzdem durch.
    expect(h.crawl.mock.calls.filter(([url]) => String(url).includes("kaputt"))).toHaveLength(2);
    expect(await count("pitches")).toBe(2); // a und b (ohne Website, volle Website-Chance) erreichen die Pitch-Schwelle
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]!.topLeads[0]).toMatchObject({ name: "Radhaus Alt", mainOpportunity: "Chance" });
    expect(h.notified[0]!.counts.FAILED).toBe(1);
    await h.boss.stop({ graceful: true, close: true });
  }, 60_000);

  it("gleiche Suche erneut: 0 neue Firmen, 0 neue Audits (Kriterium 3)", async () => {
    const h = await harness();
    await startWorkers(h.ctx);
    const audits = await count("audits");
    const firms = await count("companies");
    const run = await startSearch(h.ctx, {
      term: "Fahrradladen",
      regionKey: "test",
      target: 1,
      requestedBy: "test",
    });
    await waitFor(async () => (await getSearchRun(db(), run.id))!.status === "COMPLETED");
    expect(await count("companies")).toBe(firms);
    expect(await count("audits")).toBe(audits);
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.notified).toHaveLength(1);
    await h.boss.stop({ graceful: true, close: true });
  }, 60_000);

  it("Prozess bricht mitten im Crawl ab → nach Neustart läuft der Lauf weiter, ohne doppelte Arbeit (Kriterium 6)", async () => {
    await db().query("truncate companies, search_runs, agent_runs, api_usage cascade");
    // Prozess A: der Crawl hängt (wie ein abgestürzter Worker), dann wird A hart beendet.
    let releaseA: (err: Error) => void = () => undefined;
    const hung = new Promise<SiteCapture>((_, reject) => (releaseA = reject));
    const a = await harness({ crawl: () => hung });
    await startWorkers(a.ctx);
    const run = await startSearch(a.ctx, {
      term: "Fahrradladen",
      regionKey: "test",
      target: 1,
      requestedBy: "test",
    });
    await waitFor(() => Promise.resolve(a.crawl.mock.calls.length > 0));
    await a.boss.stop({ graceful: false, close: true });

    // Prozess B übernimmt nach Ablauf des Heartbeats (10 s) den liegengebliebenen Job.
    const b = await harness();
    await startWorkers(b.ctx);
    await waitFor(async () => (await getSearchRun(db(), run.id))!.status === "COMPLETED", 50_000);
    releaseA(new Error("Prozess A ist tot"));

    expect((await companies()).map((c) => c.status)).toEqual([
      "QUALIFIED",
      expect.stringMatching(/QUALIFIED|SKIPPED/) as string,
      "FAILED",
    ]);
    const snapshots = await db().query<{ n: number }>(
      "select count(*)::int as n from website_snapshots w join companies c on c.id = w.company_id where c.place_id = 'a'",
    );
    expect(snapshots.rows[0]!.n).toBe(1); // A hat nichts geschrieben, B genau einmal
    expect(await count("audits")).toBe(1);
    expect(b.notified).toHaveLength(1);
    await b.boss.stop({ graceful: true, close: true });
  }, 90_000);

  it("Budget erschöpft: Jobs werden auf morgen verschoben, genau eine Meldung, Lauf bleibt offen (Kriterium 8)", async () => {
    await db().query("truncate companies, search_runs, agent_runs, api_usage, app_state cascade");
    const h = await harness({ llm: () => Promise.reject(new BudgetExceededError("Tag", 5.2, 5)) });
    await startWorkers(h.ctx);
    const run = await startSearch(h.ctx, {
      term: "Fahrradladen",
      regionKey: "test",
      target: 1,
      requestedBy: "test",
    });
    await waitFor(async () => {
      const { rows } = await db().query<{ n: number }>(
        `select count(*)::int as n from ${bossSchema}.job where name = 'audit' and state = 'created' and start_after > now() + interval '1 hour'`,
      );
      return rows[0]!.n === 1; // a wartet auf morgen; b (ohne Website) braucht kein LLM
    });
    expect(h.budgetMessages).toHaveLength(1);
    expect(h.budgetMessages[0]).toMatch(
      /Budget für heute erreicht: 5\.20 \$ von 5\.00 \$.*läuft am .* weiter/,
    );
    expect((await getSearchRun(db(), run.id))!.status).toBe("RUNNING");
    expect((await companies()).find((c) => c.place_id === "a")!.status).toBe("RESEARCHED"); // nicht FAILED
    expect(h.notified).toHaveLength(0);
    await h.boss.stop({ graceful: false, close: true });
  }, 60_000);
});

it("nextStep: nächster Schritt aus dem gespeicherten Zustand", () => {
  const base = {
    segment: "WEBSITE" as const,
    hasOkSnapshot: false,
    score: null,
    hasPitch: false,
    pitchMinTotal: 80,
  };
  expect(nextStep({ ...base, status: "RESEARCHED" })).toBe("crawl");
  expect(nextStep({ ...base, status: "RESEARCHED", hasOkSnapshot: true })).toBe("audit");
  expect(nextStep({ ...base, status: "RESEARCHED", segment: "NO_WEBSITE" })).toBe("audit");
  expect(nextStep({ ...base, status: "AUDITED" })).toBe("audit");
  expect(nextStep({ ...base, status: "QUALIFIED", score: { total: 85, qualified: true } })).toBe("pitch");
  expect(
    nextStep({ ...base, status: "QUALIFIED", score: { total: 85, qualified: true }, hasPitch: true }),
  ).toBeNull();
  expect(nextStep({ ...base, status: "QUALIFIED", score: { total: 70, qualified: true } })).toBeNull();
  expect(nextStep({ ...base, status: "NEW" })).toBe("incomplete");
  for (const s of ["SKIPPED", "FAILED", "CONTACTED"] as const)
    expect(nextStep({ ...base, status: s })).toBeNull();
});

it("budgetResumeAt: nächster Morgen bzw. Monatserster, deutsche Zeit", () => {
  // 2. Oktober 2026, 23:30 Berlin (21:30 UTC) → 3. Oktober 06:00 Berlin = 04:00 UTC
  expect(budgetResumeAt(new Date("2026-10-02T21:30:00Z"), "Tag", "06:00").toISOString()).toBe(
    "2026-10-03T04:00:00.000Z",
  );
  // Monatslimit am 15. Oktober → 1. November 06:00 Berlin (Winterzeit, UTC+1) = 05:00 UTC
  expect(budgetResumeAt(new Date("2026-10-15T10:00:00Z"), "Monat", "06:00").toISOString()).toBe(
    "2026-11-01T05:00:00.000Z",
  );
});
