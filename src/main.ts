import { createApp } from "./app.js";
import { loadDotEnv, loadEnv } from "./config/env.js";
import { combineNotifiers, logNotifier } from "./queue/notifier.js";
import { startWorkers } from "./queue/workers.js";
import { createBot } from "./telegram/bot.js";
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
  });
  app.ctx.notifier = combineNotifiers(logNotifier, telegramNotifier(bot.api, env.TELEGRAM_ALLOWED_CHAT_IDS));
} else if (env.TELEGRAM_BOT_TOKEN) {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "Telegram-Bot nicht gestartet: TELEGRAM_ALLOWED_CHAT_IDS fehlt (Allowlist ist Pflicht)",
    }),
  );
}

await startWorkers(app.ctx);
if (bot) {
  void bot.start({
    onStart: (info) =>
      console.log(JSON.stringify({ level: "info", msg: "Telegram-Bot läuft", bot: `@${info.username}` })),
  });
}
console.log(
  JSON.stringify({ level: "info", msg: "avelio gestartet", env: env.NODE_ENV, telegram: bot !== null }),
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "avelio wird beendet", signal }));
  await bot?.stop().catch(() => undefined);
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
