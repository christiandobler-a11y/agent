import { describe, expect, it, vi } from "vitest";
import { createPageSpeedClient, PageSpeedError, parsePsi } from "../src/pipeline/crawl/pagespeed.js";

const LIGHTHOUSE = {
  lighthouseResult: {
    finalDisplayedUrl: "https://radl.de/",
    categories: {
      performance: { score: 0.23 },
      seo: { score: 0.8 },
      "best-practices": { score: 0.96 },
      accessibility: { score: null },
    },
    audits: {
      "largest-contentful-paint": { numericValue: 8123.4 },
      "first-contentful-paint": { numericValue: 2400 },
      "total-blocking-time": { numericValue: 950.2 },
      "cumulative-layout-shift": { numericValue: 0.1234 },
      "speed-index": { numericValue: 6100 },
    },
  },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const mockFetch = (next: () => Response) => vi.fn<typeof fetch>(() => Promise.resolve().then(next));

describe("PageSpeed", () => {
  it("rechnet Lighthouse-Werte auf 0–100 und Millisekunden um", () => {
    expect(parsePsi(LIGHTHOUSE)).toEqual({
      strategy: "mobile",
      performance: 23,
      seo: 80,
      best_practices: 96,
      accessibility: null,
      lcp_ms: 8123,
      fcp_ms: 2400,
      tbt_ms: 950,
      cls: 0.123,
      speed_index_ms: 6100,
      final_url: "https://radl.de/",
    });
  });

  it("fragt mobil mit allen vier Kategorien ab", async () => {
    const fetchFn = mockFetch(() => json(LIGHTHOUSE));
    await createPageSpeedClient({ apiKey: "geheim", fetch: fetchFn }).run("https://radl.de/");
    const url = fetchFn.mock.calls[0]![0] as URL;
    expect(url.searchParams.get("url")).toBe("https://radl.de/");
    expect(url.searchParams.get("strategy")).toBe("mobile");
    expect(url.searchParams.getAll("category")).toEqual([
      "performance",
      "seo",
      "best-practices",
      "accessibility",
    ]);
  });

  it("wiederholt 429/5xx, gibt bei 4xx sofort auf und verrät den Key nicht", async () => {
    const answers = [() => json({}, 503), () => json(LIGHTHOUSE)];
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const ok = createPageSpeedClient({ apiKey: "k", fetch: mockFetch(() => answers.shift()!()), sleep });
    expect((await ok.run("https://radl.de/")).performance).toBe(23);
    expect(sleep).toHaveBeenCalledTimes(1);

    const bad = createPageSpeedClient({
      apiKey: "geheim-123",
      fetch: mockFetch(
        () =>
          new Response("Lighthouse returned error: FAILED_DOCUMENT_REQUEST key=geheim-123", { status: 400 }),
      ),
      sleep,
    });
    const err = await bad.run("https://kaputt.de/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PageSpeedError);
    expect((err as Error).message).toContain("FAILED_DOCUMENT_REQUEST");
    expect((err as Error).message).not.toContain("geheim-123");
  });
});
