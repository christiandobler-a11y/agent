import { z } from "zod";

/** PageSpeed Insights (Lighthouse, mobil): kostenlose, objektive Kennzahlen (ARCHITECTURE.md 6). */

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CATEGORIES = ["performance", "seo", "best-practices", "accessibility"] as const;

const category = z.object({ score: z.number().nullable().optional() }).optional();
const audit = z.object({ numericValue: z.number().optional() }).optional();

const responseSchema = z.object({
  lighthouseResult: z.object({
    finalUrl: z.string().optional(),
    finalDisplayedUrl: z.string().optional(),
    categories: z.object({
      performance: category,
      seo: category,
      "best-practices": category,
      accessibility: category,
    }),
    audits: z.record(z.string(), audit).default({}),
  }),
});

export interface PsiResult {
  strategy: "mobile";
  /** Lighthouse-Werte 0–100 (null, wenn Lighthouse keinen Wert liefert). */
  performance: number | null;
  seo: number | null;
  best_practices: number | null;
  accessibility: number | null;
  lcp_ms: number | null;
  fcp_ms: number | null;
  tbt_ms: number | null;
  cls: number | null;
  speed_index_ms: number | null;
  final_url: string | null;
}

export class PageSpeedError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "PageSpeedError";
  }
}

const score = (c: { score?: number | null | undefined } | undefined) =>
  typeof c?.score === "number" ? Math.round(c.score * 100) : null;

export function parsePsi(raw: unknown): PsiResult {
  const { lighthouseResult: lh } = responseSchema.parse(raw);
  const num = (id: string, round = true) => {
    const v = lh.audits[id]?.numericValue;
    return typeof v === "number" ? (round ? Math.round(v) : Math.round(v * 1000) / 1000) : null;
  };
  return {
    strategy: "mobile",
    performance: score(lh.categories.performance),
    seo: score(lh.categories.seo),
    best_practices: score(lh.categories["best-practices"]),
    accessibility: score(lh.categories.accessibility),
    lcp_ms: num("largest-contentful-paint"),
    fcp_ms: num("first-contentful-paint"),
    tbt_ms: num("total-blocking-time"),
    cls: num("cumulative-layout-shift", false),
    speed_index_ms: num("speed-index"),
    final_url: lh.finalDisplayedUrl ?? lh.finalUrl ?? null,
  };
}

export interface PageSpeedOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
  timeoutMs?: number;
}

export function createPageSpeedClient(options: PageSpeedOptions) {
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // Lighthouse braucht für langsame Seiten oft 30–60 s; mehr als ~3 Minuten insgesamt lohnt nicht.
  const retries = options.retries ?? 1;
  const timeoutMs = options.timeoutMs ?? 90_000;

  return {
    async run(siteUrl: string): Promise<PsiResult> {
      const url = new URL(ENDPOINT);
      url.searchParams.set("url", siteUrl);
      url.searchParams.set("strategy", "mobile");
      url.searchParams.set("locale", "de");
      for (const c of CATEGORIES) url.searchParams.append("category", c);
      url.searchParams.set("key", options.apiKey); // PSI erwartet den Key in der URL; URL nie loggen

      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
          if (attempt < retries) {
            await sleep(2000 * 2 ** attempt);
            continue;
          }
          const reason = err instanceof Error ? err.name : "Netzwerkfehler";
          throw new PageSpeedError(`PageSpeed nicht erreichbar (${reason})`, null);
        }
        if (res.ok) return parsePsi(await res.json());
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        // Google meldet z. B. "Lighthouse returned error: FAILED_DOCUMENT_REQUEST" für nicht ladbare Seiten.
        const body = (await res.text()).replaceAll(options.apiKey, "***").slice(0, 300);
        throw new PageSpeedError(`PageSpeed: HTTP ${res.status} ${body}`, res.status);
      }
    },
  };
}

export type PageSpeedClient = ReturnType<typeof createPageSpeedClient>;
