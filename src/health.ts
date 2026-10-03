import { writeFileSync } from "node:fs";
import type { DbClient } from "./db/client.js";

/**
 * Lebenszeichen im Betrieb (ARCHITECTURE.md 11): Jede Minute prüft der Prozess die Datenbank und schreibt bei Erfolg
 * die Uhrzeit in eine Datei (Docker-HEALTHCHECK liest sie). Ist HEALTHCHECK_URL gesetzt, meldet er sich dort alle
 * 5 Minuten (bzw. sofort mit /fail bei einem Fehler). Bleibt das aus, alarmiert der Uptime-Dienst per Mail.
 */

export const HEALTH_FILE = process.env.AVELIO_HEALTH_FILE ?? "/tmp/avelio-heartbeat";
/** Älter als das gilt der Prozess als ungesund (siehe Dockerfile). */
export const HEALTH_MAX_AGE_MS = 3 * 60_000;

export interface HeartbeatOptions {
  db: DbClient;
  pingUrl?: string | undefined;
  fetch?: typeof globalThis.fetch;
  file?: string;
  intervalMs?: number;
  pingEveryMs?: number;
  now?: () => Date;
}

export interface Heartbeat {
  /** Ein Durchlauf (für Tests direkt aufrufbar). */
  beat(): Promise<boolean>;
  stop(): void;
}

const log = (level: "info" | "warn", msg: string, extra: Record<string, unknown> = {}) =>
  console[level === "info" ? "log" : "warn"](JSON.stringify({ level, msg, ...extra }));

export function createHeartbeat(o: HeartbeatOptions): Heartbeat {
  const fetchFn = o.fetch ?? globalThis.fetch;
  const file = o.file ?? HEALTH_FILE;
  const now = o.now ?? (() => new Date());
  const pingEvery = o.pingEveryMs ?? 5 * 60_000;
  let lastPing = 0;
  let lastOk: boolean | null = null;

  const ping = async (ok: boolean) => {
    if (!o.pingUrl) return;
    const t = now().getTime();
    // Erfolg nur alle paar Minuten melden, einen Wechsel (ok ↔ Fehler) sofort.
    if (ok && lastOk === true && t - lastPing < pingEvery) return;
    lastPing = t;
    try {
      await fetchFn(ok ? o.pingUrl : `${o.pingUrl.replace(/\/$/, "")}/fail`, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      log("warn", "Healthcheck-Ping fehlgeschlagen"); // URL enthält ein Token, daher nicht ausgeben
    }
  };

  const beat = async () => {
    let ok = true;
    try {
      await o.db.query("select 1");
      writeFileSync(file, now().toISOString());
    } catch (err) {
      ok = false;
      log("warn", "Lebenszeichen: Datenbank nicht erreichbar", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await ping(ok);
    lastOk = ok;
    return ok;
  };

  void beat();
  const timer = setInterval(() => void beat(), o.intervalMs ?? 60_000);
  timer.unref();
  return { beat, stop: () => clearInterval(timer) };
}
