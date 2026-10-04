import { claimState, getState, setState } from "../db/appState.js";
import { countPlan, planItems, type PlanCounts } from "../db/plan.js";
import { gameState, gameStats, loadGameConfig, xpOf, type GameState } from "../game/xp.js";
import { loadCrmConfig } from "../crm/status.js";
import { sendNextQueued } from "../outreach/queue.js";
import { seedTick } from "../outreach/seed.js";
import { statsTick } from "../outreach/stats.js";
import { checkReplies } from "../outreach/send.js";
import { PLAN_QUEUE } from "../queue/boss.js";
import type { PipelineContext } from "../queue/pipeline.js";
import { berlinDate, berlinTime, buildDailyPlan, type PlanBuildResult } from "./plan.js";

export { berlinTime };
import { nightReport, searchTick } from "./search.js";

/**
 * Takt des Morgen-Pakets (aus dem Sweep): Plan bauen ab `vorbereiten` (als eigener Job, darf lange dauern), Telegram
 * ab `morgens`, sobald der Plan fertig ist, Bilanz ab `abends`. Jeder Schritt höchstens einmal am Tag (app_state).
 */

export interface EveningSummary {
  date: string;
  counts: PlanCounts;
  replies: string[];
  bounces: string[];
  /** Spielstand und XP von heute (fehlt, wenn die Spiel-Konfiguration nicht lesbar ist). */
  game?: { gained: number; state: GameState } | null;
}

export async function autopilotTick(ctx: PipelineContext): Promise<void> {
  const ap = ctx.autopilot;
  if (!ap) return;
  await searchTick(ctx);
  const now = ctx.now();
  const date = berlinDate(now);
  const time = berlinTime(now);
  const z = ap.config.zeiten;

  // Nach dem Abend (z. B. Neustart am späten Abend) nicht mehr für heute planen.
  if (
    time >= z.vorbereiten &&
    time < z.abends &&
    (await claimState(ctx.db, `plan-build:${date}`, now.toISOString()))
  )
    await ctx.boss.send(PLAN_QUEUE, { date }, { singletonKey: date });

  const built = await getState<PlanBuildResult>(ctx.db, `plan-built:${date}`);
  if (
    built &&
    time >= z.morgens &&
    ctx.notifier.planReady &&
    (await claimState(ctx.db, `plan-sent:${date}`, true))
  )
    await ctx.notifier.planReady(date, built, await nightReport(ctx));

  if (
    built &&
    z.mittags &&
    time >= z.mittags &&
    time < z.abends &&
    ctx.notifier.info &&
    (await claimState(ctx.db, `plan-midday:${date}`, true))
  ) {
    const text = middayText(await middayStatus(ctx, date), date);
    if (text) await ctx.notifier.info(text);
  }

  if (
    built &&
    time >= z.abends &&
    ctx.notifier.eveningSummary &&
    (await claimState(ctx.db, `plan-evening:${date}`, true))
  ) {
    const items = await planItems(ctx.db, date);
    if (items.length > 0) await ctx.notifier.eveningSummary(await eveningSummary(ctx, date, items));
  }
}

export interface MiddayStatus {
  /** Neue Mails aus dem Plan: gesendet, gesamt. */
  sent: number;
  total: number;
  /** Davon eingeplant (verteilt senden) und bis wann. */
  queued: number;
  lastAt: string | null;
  followDone: number;
  followTotal: number;
  /** Firmen, die heute geantwortet haben. */
  replies: string[];
}

async function middayStatus(ctx: PipelineContext, date: string): Promise<MiddayStatus> {
  const items = await planItems(ctx.db, date);
  const counts = countPlan(items);
  const { rows } = await ctx.db.query<{ n: number; last: Date | null }>(
    "select count(*)::int as n, max(send_after) as last from outreach_plan where plan_date = $1 and status = 'queued'",
    [date],
  );
  const { rows: replies } = await ctx.db.query<{ name: string }>(
    `select distinct c.name from interactions i join companies c on c.id = i.company_id
      where i.type = 'note' and i.created_by = 'mail' and i.body like 'Antwort%'
        and (i.created_at at time zone 'Europe/Berlin')::date = $1::date`,
    [date],
  );
  const last = rows[0]?.last ?? null;
  return {
    sent: counts.email.done,
    total: counts.email.total,
    queued: rows[0]?.n ?? 0,
    lastAt: last ? berlinTime(last) : null,
    followDone: counts.followup.done,
    followTotal: counts.followup.total,
    replies: replies.map((r) => r.name),
  };
}

/** Zwischenstand am Mittag im lockeren Ton (reiner Text); `null`, wenn heute nichts ansteht. */
export function middayText(m: MiddayStatus, date: string): string | null {
  if (m.total === 0 && m.followTotal === 0) return null;
  const hello = [
    "🍽️ Mahlzeit, Chef!",
    "🥨 Mahlzeit!",
    "☀️ Halbzeit, Chef!",
    "🍝 Mahlzeit, kurzer Zwischenstand:",
  ];
  const lines = [hello[Number(date.slice(-2)) % hello.length]!];
  const follow = m.followTotal > 0 ? ` (+ ${m.followDone}/${m.followTotal} Nachfass-Mails)` : "";
  if (m.sent === 0 && m.queued === 0)
    lines.push(
      `Das Morgen-Paket wartet noch auf dich: ${m.total} Mails liegen bereit${follow}. Ein Tipp auf /heute genügt 😉`,
    );
  else {
    lines.push(
      `Bis jetzt ${m.sent === 1 ? "ist 1 gutes Ding" : `sind ${m.sent} gute Dinger`} raus${follow} 📤`,
    );
    if (m.queued > 0)
      lines.push(
        `${m.queued} weitere gehen automatisch raus${m.lastAt ? `, die letzte gegen ${m.lastAt} Uhr` : ""}.`,
      );
    const open = m.total - m.sent - m.queued;
    if (open > 0) lines.push(`${open} warten noch auf deinen Knopfdruck (/heute).`);
  }
  if (m.replies.length > 0)
    lines.push(
      `💬 ${m.replies.length === 1 ? "Gemeldet hat sich schon" : `${m.replies.length} haben sich schon gemeldet:`} ${m.replies.join(", ")} 🎉`,
    );
  else if (m.sent > 0)
    lines.push(
      "Gemeldet hat sich noch keiner. Ganz normal, die meisten antworten abends oder am nächsten Tag ☕",
    );
  return lines.join("\n");
}

async function eveningSummary(
  ctx: PipelineContext,
  date: string,
  items: Awaited<ReturnType<typeof planItems>>,
): Promise<EveningSummary> {
  const { rows } = await ctx.db.query<{ name: string; body: string }>(
    `select c.name, i.body from interactions i join companies c on c.id = i.company_id
      where i.type = 'note' and i.created_by = 'mail'
        and (i.created_at at time zone 'Europe/Berlin')::date = $1::date`,
    [date],
  );
  let game: EveningSummary["game"] = null;
  try {
    const c = loadGameConfig();
    const now = ctx.now();
    const state = await gameState(ctx.db, now, c);
    const { rows: start } = await ctx.db.query<{ t: Date }>(
      "select ($1::date::timestamp at time zone 'Europe/Berlin') as t",
      [date],
    );
    const before = xpOf(await gameStats(ctx.db, now, start[0]!.t), c);
    game = { gained: state.xp - before, state };
  } catch {
    // ohne Spielstand
  }
  return {
    game,
    date,
    counts: countPlan(items),
    replies: rows.filter((r) => r.body.startsWith("Antwort")).map((r) => r.name),
    bounces: rows.filter((r) => r.body.startsWith("Unzustellbar")).map((r) => r.name),
  };
}

/** Job: Tagesplan bauen und als fertig vermerken (der nächste Sweep meldet ihn ab `morgens`). */
export async function runPlanJob(ctx: PipelineContext): Promise<PlanBuildResult | null> {
  if (!ctx.autopilot) return null;
  let result: PlanBuildResult;
  try {
    result = await buildDailyPlan(ctx.autopilot.planDeps());
  } catch (err) {
    // Nicht still scheitern: morgens kommt trotzdem eine Nachricht mit dem Grund (und was schon fertig ist).
    const message = err instanceof Error ? err.message : String(err);
    result = {
      date: berlinDate(ctx.now()),
      followups: 0,
      emails: 0,
      letters: 0,
      prototypes: 0,
      skipped: [],
      stoppedByBudget: false,
      warnings: [`Vorbereitung abgebrochen: ${message.slice(0, 200)}`],
    };
  }
  await setState(ctx.db, `plan-built:${result.date}`, result);
  return result;
}

const MAIL_CHECK_KEY = "mail:last-check";
const MAIL_CHECK_EVERY_MS = 4 * 60_000;

/** Posteingang prüfen, höchstens alle paar Minuten (IMAP-Verbindung kostet Zeit). */
export async function mailTick(ctx: PipelineContext): Promise<void> {
  if (!ctx.mailbox || !ctx.mail) return;
  const now = ctx.now();
  const last = await getState<string>(ctx.db, MAIL_CHECK_KEY);
  if (last && now.getTime() - new Date(last).getTime() < MAIL_CHECK_EVERY_MS) return;
  await setState(ctx.db, MAIL_CHECK_KEY, now.toISOString());
  const notify = ctx.notifier.mailEvent?.bind(ctx.notifier);
  await checkReplies({
    db: ctx.db,
    mailbox: ctx.mailbox,
    mail: ctx.mail,
    now: ctx.now,
    ...(notify ? { notify } : {}),
  });
}

/** Verteilt senden: die nächste fällige eingeplante Mail verschicken (src/outreach/queue.ts). */
export async function queueTick(ctx: PipelineContext): Promise<void> {
  if (!ctx.mailbox || !ctx.mail) return;
  const notify = ctx.notifier.info?.bind(ctx.notifier);
  await sendNextQueued({
    db: ctx.db,
    mailbox: ctx.mailbox,
    mail: ctx.mail,
    now: ctx.now,
    followUpDays: (ctx.crm ?? loadCrmConfig()).follow_up_days,
    ...(notify ? { notify } : {}),
  });
}

/** Kontrollmail (Spam-Check) und Zahlen der Testphase (Meilensteine, Warnung ohne Antworten). */
export async function monitorTick(ctx: PipelineContext): Promise<void> {
  const notify = ctx.notifier.info?.bind(ctx.notifier);
  if (ctx.mailbox && ctx.seedBoxes && ctx.seedBoxes.length > 0)
    await seedTick({
      db: ctx.db,
      mailbox: ctx.mailbox,
      boxes: ctx.seedBoxes,
      now: ctx.now,
      date: berlinDate(ctx.now()),
      ...(notify ? { notify } : {}),
    });
  if (ctx.mailbox) await statsTick(ctx.db, notify);
}
