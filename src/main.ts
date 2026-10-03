import { createApp } from "./app.js";
import { createHeartbeat } from "./health.js";
import { loadOutreachConfig } from "./outreach/config.js";
import { loadPrototypeConfig } from "./prototype/run.js";
import { loadDotEnv, loadEnv } from "./config/env.js";
import { combineNotifiers, logNotifier } from "./queue/notifier.js";
import { startWorkers } from "./queue/workers.js";
import { BOT_COMMANDS, createBot } from "./telegram/bot.js";
import { telegramNotifier } from "./telegram/notifier.js";

/**
 * Startpunkt im Betrieb (`npm start`): Worker für alle Queues, Sweeper und Telegram-Bot (Long Polling, keine
 * öffentliche URL nötig). Läuft dauerhaft bis SIGINT/SIGTERM; abgebrochene Jobs übernimmt der nächste Start.
 */
loadDotEnv();
const env = loadEnv();
const app = await createApp({ worker: true });

let bot: ReturnType<typeof createBot> | null = null;
if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_CHAT_IDS.length > 0) {
  bot = createBot({
    token: env.TELEGRAM_BOT_TOKEN,
    allowedChatIds: env.TELEGRAM_ALLOWED_CHAT_IDS,
    manager: { ctx: app.ctx, llm: app.llm },
    outreach: {
      config: loadOutreachConfig(),
      contact: { whatsapp: env.OUTREACH_WHATSAPP ?? null, phone: env.OUTREACH_PHONE ?? null },
    },
    mail: { mailbox: app.mailbox, config: app.mail },
    prototype: {
      config: loadPrototypeConfig(),
      duBranches: loadOutreachConfig().du_branchen,
      googleApiKey: env.GOOGLE_API_KEY ?? null,
      baseUrl: env.PREVIEW_BASE_URL?.replace(/\/$/, "") ?? null,
    },
  });
  app.ctx.notifier = combineNotifiers(
    logNotifier,
    telegramNotifier(bot.api, env.TELEGRAM_ALLOWED_CHAT_IDS, app.ctx.db),
  );
} else if (env.TELEGRAM_BOT_TOKEN) {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "Telegram-Bot nicht gestartet: TELEGRAM_ALLOWED_CHAT_IDS fehlt (Allowlist ist Pflicht)",
    }),
  );
}

await startWorkers(app.ctx);
const heartbeat = createHeartbeat({ db: app.ctx.db, pingUrl: env.HEALTHCHECK_URL });
if (bot) {
  console.log(JSON.stringify({ level: "info", msg: "Telegram-Bot verbindet sich …" }));
  bot
    .start({
      onStart: (info) => {
        console.log(JSON.stringify({ level: "info", msg: "Telegram-Bot läuft", bot: `@${info.username}` }));
        // Befehlsmenü in Telegram (Schaltfläche "/" bzw. "Menü").
        void bot.api.setMyCommands(BOT_COMMANDS).catch(() => undefined);
      },
    })
    .catch((err: unknown) => {
      // Z. B. 401 (Token falsch) oder 409 (Bot läuft schon woanders). Beenden, damit es auffällt bzw. Docker neu startet.
      const error = err instanceof Error ? err.message : String(err);
      const hint = error.includes("409")
        ? "Der Bot läuft bereits in einem anderen Prozess (z. B. auf dem Server oder in einem zweiten Terminal)."
        : error.includes("401")
          ? "TELEGRAM_BOT_TOKEN ist ungültig."
          : undefined;
      console.error(JSON.stringify({ level: "error", msg: "Telegram-Bot gestoppt", error, hint }));
      void shutdown("telegram-error", 1);
    });
}
console.log(
  JSON.stringify({ level: "info", msg: "avelio gestartet", env: env.NODE_ENV, telegram: bot !== null }),
);

let stopping = false;
async function shutdown(signal: string, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "avelio wird beendet", signal }));
  heartbeat.stop();
  await bot?.stop().catch(() => undefined);
  await app.close();
  process.exit(exitCode);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
