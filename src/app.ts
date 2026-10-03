import { loadEnv, requireKeys } from "./config/env.js";
import { createDb, type Db } from "./db/client.js";
import { createBudgetGuard } from "./llm/budget.js";
import { loadModelsConfig } from "./llm/config.js";
import { createAnthropicMessages, createLlmGateway, type LlmGateway } from "./llm/gateway.js";
import { createBrowserCrawler, type BrowserCrawler } from "./pipeline/crawl/browser.js";
import { loadCrawlConfig } from "./pipeline/crawl/config.js";
import { createPageSpeedClient } from "./pipeline/crawl/pagespeed.js";
import { loadBranches } from "./pipeline/research/branches.js";
import { loadGateRules } from "./pipeline/research/gate.js";
import { createPlacesClient } from "./pipeline/research/places.js";
import { createPrefilter } from "./pipeline/research/prefilter.js";
import { loadRecheckRules } from "./pipeline/research/recheck.js";
import { loadResearchConfig } from "./pipeline/research/run.js";
import { loadRegion } from "./pipeline/research/tiling.js";
import { loadScoringConfig } from "./pipeline/scoring/config.js";
import { createBoss, ensureQueues, loadQueueConfig } from "./queue/boss.js";
import { logNotifier, type Notifier } from "./queue/notifier.js";
import { loadCrmConfig } from "./crm/status.js";
import type { PipelineContext } from "./queue/pipeline.js";

/**
 * Baut den Kontext für Worker, Bot und CLI aus Umgebung und config/. Jedes Modul bekommt nur die Keys, die es
 * braucht (ARCHITECTURE.md 12.1): Der Crawler kennt keinen Anthropic-Key, das Gateway keinen Google-Key.
 */

export interface App {
  ctx: PipelineContext;
  db: Db;
  llm: LlmGateway;
  close(): Promise<void>;
}

export async function createApp(options: { notifier?: Notifier; worker?: boolean } = {}): Promise<App> {
  const env = loadEnv();
  const keys = requireKeys(env, ["DATABASE_URL", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY"]);
  const db = createDb(keys.DATABASE_URL, { max: 10 });
  const models = loadModelsConfig();
  const budget = createBudgetGuard(db, models.budget);
  const llm = createLlmGateway({
    db,
    messages: createAnthropicMessages(keys.ANTHROPIC_API_KEY),
    models,
    budget,
  });
  const queueConfig = loadQueueConfig();
  const boss = createBoss(keys.DATABASE_URL, { schedule: options.worker ?? false });
  await boss.start();
  await ensureQueues(boss, queueConfig);

  const crawlConfig = loadCrawlConfig();
  let crawler: Promise<BrowserCrawler> | null = null;
  const branches = loadBranches();
  const recheck = loadRecheckRules();

  const ctx: PipelineContext = {
    db,
    boss,
    bossSchema: "pgboss",
    queueConfig,
    research: {
      places: createPlacesClient({ apiKey: keys.GOOGLE_API_KEY }),
      prefilter: createPrefilter(llm),
      branches,
      gate: loadGateRules(),
      recheck,
      config: loadResearchConfig(),
      budget,
    },
    loadRegion,
    lead: { llm, crawl: crawlConfig, scoring: loadScoringConfig(), branches, recheck },
    crawl: {
      config: crawlConfig,
      crawler: () =>
        (crawler ??= createBrowserCrawler({
          config: crawlConfig,
          executablePath: process.env.CHROMIUM_PATH,
          proxy: process.env.HTTPS_PROXY,
        })),
      pagespeed: createPageSpeedClient({ apiKey: keys.GOOGLE_API_KEY }),
    },
    budget,
    notifier: options.notifier ?? logNotifier,
    now: () => new Date(),
    crm: loadCrmConfig(),
  };

  return {
    ctx,
    db,
    llm,
    async close() {
      await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
      if (crawler) await (await crawler).close().catch(() => undefined);
      await db.end();
    },
  };
}
