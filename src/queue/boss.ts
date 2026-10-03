import { PgBoss } from "pg-boss";
import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";
import { tlsFor } from "../db/client.js";

/** pg-boss: Queue, Retries mit Backoff, Heartbeats, Dead-Letter, Cron (ARCHITECTURE.md 6). */

export const QUEUES = ["research", "crawl", "audit", "pitch"] as const;
export type QueueName = (typeof QUEUES)[number];
export const SWEEP_QUEUE = "sweep";
/** Endgültig gescheiterte Jobs landen hier (Ansicht: CLI `failed`). */
export const DEAD_QUEUE = "dead";

const queueSchema = z.object({
  retry_limit: z.number().int().min(0).max(10),
  retry_delay_s: z.number().int().min(0),
  retry_backoff: z.boolean(),
  retry_delay_max_s: z.number().int().min(1),
  heartbeat_s: z.number().int().min(10),
  expire_s: z.number().int().min(1),
  concurrency: z.number().int().min(1).max(20),
});

export const queueConfigSchema = z.object({
  queues: z.object({ research: queueSchema, crawl: queueSchema, audit: queueSchema, pitch: queueSchema }),
  sweep_every_minutes: z.number().int().min(1).max(60),
  budget_resume_time: z.string().regex(/^\d{2}:\d{2}$/),
});

export type QueueConfig = z.infer<typeof queueConfigSchema>;

export function loadQueueConfig(): QueueConfig {
  return loadYamlConfig("queue.yaml", queueConfigSchema);
}

export interface BossOptions {
  /** Eigenes Schema (Tests); Standard "pgboss". */
  schema?: string;
  /** Takt der Überwachung (abgestürzte Worker, Ablauf); Tests kürzer. */
  superviseIntervalSeconds?: number;
  /** Cron-Jobs ausführen (nur im Worker-Prozess). */
  schedule?: boolean;
  max?: number;
}

export function createBoss(databaseUrl: string, options: BossOptions = {}): PgBoss {
  const ssl = tlsFor(databaseUrl);
  const boss = new PgBoss({
    connectionString: databaseUrl,
    ...(ssl ? { ssl } : {}),
    schema: options.schema ?? "pgboss",
    max: options.max ?? 4,
    application_name: "avelio-queue",
    superviseIntervalSeconds: options.superviseIntervalSeconds ?? 30,
    schedule: options.schedule ?? false,
  });
  boss.on("error", (err: Error) => {
    console.error(JSON.stringify({ level: "error", msg: "Queue-Fehler", error: err.message }));
  });
  return boss;
}

/** Queues anlegen bzw. Optionen aktualisieren (idempotent). */
export async function ensureQueues(boss: PgBoss, config: QueueConfig): Promise<void> {
  const existing = new Set((await boss.getQueues()).map((q) => q.name));
  const upsert = async (name: string, options: NonNullable<Parameters<PgBoss["createQueue"]>[1]>) => {
    if (!existing.has(name)) return boss.createQueue(name, options);
    // Die Policy einer bestehenden Queue lässt sich nicht ändern; alles andere wird nachgeführt.
    const rest = { ...options };
    delete rest.policy;
    delete rest.partition;
    return boss.updateQueue(name, rest);
  };
  await upsert(DEAD_QUEUE, { policy: "standard", retentionSeconds: 30 * 24 * 3600 });
  await upsert(SWEEP_QUEUE, { policy: "exclusive", retryLimit: 0, expireInSeconds: 120 });
  for (const name of QUEUES) {
    const q = config.queues[name];
    await upsert(name, {
      // exclusive: höchstens ein offener Job je Schlüssel (Firma bzw. Suchlauf) → keine doppelten Jobs.
      policy: "exclusive",
      retryLimit: q.retry_limit,
      retryDelay: q.retry_delay_s,
      retryBackoff: q.retry_backoff,
      ...(q.retry_backoff ? { retryDelayMax: q.retry_delay_max_s } : {}),
      heartbeatSeconds: q.heartbeat_s,
      expireInSeconds: q.expire_s,
      deadLetter: DEAD_QUEUE,
    });
  }
}
