import { createApp } from "./app.js";
import { loadDotEnv, loadEnv } from "./config/env.js";
import { startWorkers } from "./queue/workers.js";

/**
 * Startpunkt im Betrieb (`npm start`): Worker für alle Queues und den Sweeper. Ab Schritt 8 zusätzlich der
 * Telegram-Bot. Läuft dauerhaft, bis SIGINT/SIGTERM; laufende Jobs dürfen fertig werden, abgebrochene Jobs
 * übernimmt pg-boss nach dem Neustart (Heartbeat).
 */
loadDotEnv();
const env = loadEnv();
const app = await createApp({ worker: true });
await startWorkers(app.ctx);
console.log(JSON.stringify({ level: "info", msg: "avelio gestartet", env: env.NODE_ENV, worker: true }));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "avelio wird beendet", signal }));
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
