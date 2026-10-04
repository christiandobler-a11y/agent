import { claimState, getState, setState } from "../db/appState.js";
import { countPlan, planItems, type PlanCounts } from "../db/plan.js";
import { gameState, gameStats, loadGameConfig, xpOf, type GameState } from "../game/xp.js";
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
    time >= z.abends &&
    ctx.notifier.eveningSummary &&
    (await claimState(ctx.db, `plan-evening:${date}`, true))
  ) {
    const items = await planItems(ctx.db, date);
    if (items.length > 0) await ctx.notifier.eveningSummary(await eveningSummary(ctx, date, items));
  }
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
