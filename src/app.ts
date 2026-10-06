import { loadEnv, requireKeys } from "./config/env.js";
import { googleOwnerPhotos } from "./prototype/googlePhotos.js";
import { collectCandidates, heroForCompany } from "./prototype/heroPhoto.js";
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
import { loadAutopilotConfig } from "./autopilot/plan.js";
import { advisorContext } from "./advisor/job.js";
import { loadShopConfig } from "./shop/pick.js";
import { loadOutreachConfig } from "./outreach/config.js";
import { chromiumLetterRenderer } from "./outreach/letterPdf.js";
import { cachedOpeningHours, cachedPlaceDetails } from "./prototype/placeDetails.js";
import { loadMailConfig, mailboxFromEnv, type MailConfig, type Mailbox } from "./outreach/mail.js";
import { seedBoxesFromEnv } from "./outreach/seed.js";
import { createMxCheck } from "./outreach/mx.js";
import { loadPrototypeConfig } from "./prototype/run.js";
import { chromiumTeaserShooter } from "./prototype/teaser.js";
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
  /** Christians Postfach (Versand per Knopf, Antwort-Erkennung); `null`, wenn nicht eingerichtet. */
  mailbox: Mailbox | null;
  mail: MailConfig;
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

  // Morgen-Paket und Postfach (Phase 2).
  const outreach = loadOutreachConfig();
  const mail = loadMailConfig();
  const mailbox = mailboxFromEnv(env, mail, outreach.absender_name);
  const baseUrl = env.PREVIEW_BASE_URL?.replace(/\/$/, "") ?? null;
  const prototypeConfig = loadPrototypeConfig();
  const contact = {
    whatsapp: env.OUTREACH_WHATSAPP ?? null,
    phone: env.OUTREACH_PHONE ?? null,
    address: env.OUTREACH_ADDRESS ?? null,
    privacyUrl: env.OUTREACH_PRIVACY_URL ?? null,
  };
  const desktopScreenPx = crawlConfig.desktop.height * crawlConfig.desktop.scale;
  ctx.mailbox = mailbox;
  ctx.seedBoxes = seedBoxesFromEnv(env, mail);
  ctx.mail = mail;
  ctx.advisor = advisorContext(ctx, llm);
  // Laden der Woche (src/shop/): Vorschlag montags, Briefing mit drei Richtungen auf Knopfdruck.
  const home = loadAutopilotConfig().neue_kontakte.heimat;
  ctx.shop = {
    config: loadShopConfig(),
    home: home ? { lat: home.lat, lng: home.lng } : null,
    briefing: () => ({
      db,
      llm,
      collect: (url) => collectCandidates(url, process.env.CHROMIUM_PATH, process.env.HTTPS_PROXY),
      hours: cachedOpeningHours({ db, budget, apiKey: keys.GOOGLE_API_KEY }),
      details: cachedPlaceDetails({ db, budget, apiKey: keys.GOOGLE_API_KEY }),
      desktopScreenPx: crawlConfig.desktop.height * crawlConfig.desktop.scale,
      branchLabel: (key) => (key ? (branches[key]?.label ?? key) : null),
    }),
  };
  ctx.autopilot = {
    config: loadAutopilotConfig(),
    planDeps: () => ({
      db,
      now: ctx.now,
      config: loadAutopilotConfig(),
      letter: {
        db,
        llm,
        outreach,
        branches,
        now: ctx.now,
        contact,
        previewBaseUrl: baseUrl,
        teaserDir: prototypeConfig.teaser.dir,
        render: chromiumLetterRenderer(process.env.CHROMIUM_PATH),
        prototype: { shotsDir: prototypeConfig.shots_dir, baseUrl },
        desktopScreenPx,
      },
      prototype: {
        db,
        llm,
        budget,
        branches,
        config: prototypeConfig,
        duBranches: outreach.du_branchen,
        now: ctx.now,
        googleApiKey: keys.GOOGLE_API_KEY,
        baseUrl,
        desktopScreenPx,
      },
      teaser: {
        dir: prototypeConfig.teaser.dir,
        branches: prototypeConfig.teaser.branchen,
        style: prototypeConfig.teaser.stil,
        devices: prototypeConfig.teaser.geraete,
        shoot: chromiumTeaserShooter(process.env.CHROMIUM_PATH),
        photo: prototypeConfig.teaser.foto,
        palette: prototypeConfig.teaser.farbe,
        details: prototypeConfig.teaser.google_details
          ? cachedPlaceDetails({ db, budget, apiKey: keys.GOOGLE_API_KEY })
          : null,
        font: prototypeConfig.teaser.schrift,
        photos: prototypeConfig.teaser.fotos,
        withoutPhoto: prototypeConfig.teaser.ohne_foto,
        hero: prototypeConfig.teaser.eigenes_foto
          ? (company) =>
              heroForCompany(
                {
                  db,
                  llm,
                  dir: prototypeConfig.teaser.foto_dir,
                  googlePhotos: prototypeConfig.teaser.google_fotos
                    ? googleOwnerPhotos({ db, budget, apiKey: keys.GOOGLE_API_KEY })
                    : null,
                },
                company,
              )
          : null,
      },
      mx: createMxCheck(),
      openingHours: cachedOpeningHours({ db, budget, apiKey: keys.GOOGLE_API_KEY }),
      lettersDir: "data/letters",
      senderAddress: mailbox?.address ?? null,
    }),
  };

  return {
    ctx,
    db,
    llm,
    mailbox,
    mail,
    async close() {
      await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
      if (crawler) await (await crawler).close().catch(() => undefined);
      await db.end();
    },
  };
}
