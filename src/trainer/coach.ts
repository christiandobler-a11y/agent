import { z } from "zod";
import { berlinWeekday } from "../advisor/job.js";
import { berlinDate, berlinTime } from "../autopilot/plan.js";
import { claimState, getState, setState } from "../db/appState.js";
import type { Db } from "../db/client.js";
import { loadPrompt } from "../llm/config.js";
import { isoWeek } from "../shop/pick.js";
import type { PipelineContext } from "../queue/pipeline.js";
import {
  pickScenario,
  playedScenarios,
  type CoachFeedback,
  type TrainerConfig,
  type TrainerDeps,
} from "./session.js";

/**
 * Der Trainer meldet sich von selbst (09.10.2026, Christian: "vollkommen selbstständig, regelmäßig mit Sales-Dingern
 * leicht erklärt"): Sales-Häppchen (Rolle `trainer_tip`), Einladung zur Mittagspause und Wochenbilanz (beide ohne
 * LLM). Jede Meldung höchstens einmal je Tag bzw. Woche über `claimState`.
 */

export const TIP_PROMPT = "v1";
const RECENT_KEY = "trainer:tips";
const KEEP = 20;

const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"] as const;

export const tipSchema = z.object({
  aufhaenger: z.string().min(1).max(200),
  erklaerung: z.string().min(1).max(900),
  so_klingts: z.string().min(1).max(300),
  uebung: z.string().min(1).max(300),
  szenario: z.string(),
});
export type Tip = z.infer<typeof tipSchema>;

/** Knopf in einer Meldung (Telegram-unabhängig). */
export interface CoachButton {
  text: string;
  callback_data: string;
}
export interface CoachMessage {
  text: string;
  buttons: CoachButton[];
}

export const CRITERIA = {
  zuhoeren: "Zuhören",
  nutzen: "Nutzen",
  ruhe: "Ruhe",
  abschluss: "Abschluss",
} as const;
export type Criterion = keyof typeof CRITERIA;

// ---------------------------------------------------------------------------------------------------------------
// Rein

/** Schnitt je Punkt über die Bewertungen. Leer = null. */
export function criterionAverages(feedbacks: readonly CoachFeedback[]): Record<Criterion, number> | null {
  if (feedbacks.length === 0) return null;
  const avg = (k: Criterion) => feedbacks.reduce((sum, f) => sum + f[k].punkte, 0) / feedbacks.length;
  return { zuhoeren: avg("zuhoeren"), nutzen: avg("nutzen"), ruhe: avg("ruhe"), abschluss: avg("abschluss") };
}

export function weakest(avg: Record<Criterion, number>): Criterion {
  return (Object.keys(avg) as Criterion[]).reduce((a, b) => (avg[b] < avg[a] ? b : a));
}
export function strongest(avg: Record<Criterion, number>): Criterion {
  return (Object.keys(avg) as Criterion[]).reduce((a, b) => (avg[b] > avg[a] ? b : a));
}

/** Nächstes Thema: das erste, das nicht unter den zuletzt behandelten ist, sonst das am längsten zurückliegende. */
export function nextTopic(topics: readonly string[], recentTopics: readonly string[]): string | null {
  if (topics.length === 0) return null;
  const fresh = topics.find((t) => !recentTopics.includes(t));
  if (fresh) return fresh;
  return [...topics].sort((a, b) => recentTopics.indexOf(b) - recentTopics.indexOf(a))[0]!;
}

const comma = (n: number) => n.toFixed(1).replace(".", ",");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function tipMessage(tip: Tip, config: TrainerConfig): CoachMessage {
  const sc = config.szenarien[tip.szenario];
  return {
    text: [
      `🧠 <b>${esc(tip.aufhaenger)}</b>`,
      "",
      esc(tip.erklaerung),
      "",
      `🗣️ <i>So klingt's bei dir:</i> „${esc(tip.so_klingts)}“`,
      `✏️ <i>Heute:</i> ${esc(tip.uebung)}`,
    ].join("\n"),
    buttons: [
      sc
        ? { text: `🎭 Gleich üben: ${sc.titel}`.slice(0, 60), callback_data: `tr:r:${tip.szenario}` }
        : { text: "🎭 Eine Runde üben", callback_data: "tr:n" },
    ],
  };
}

export function invitationMessage(
  config: TrainerConfig,
  scenarioKey: string,
  streakDays: number,
): CoachMessage {
  const sc = config.szenarien[scenarioKey]!;
  return {
    text: [
      "🥪 <b>Mittagspause? Fünf Minuten Sparring.</b>",
      "",
      `Heute wartet: <b>${esc(sc.titel)}</b> ${"🔥".repeat(sc.schwierigkeit)}`,
      `<i>${esc(sc.lage)}</i>`,
      ...(streakDays > 1 ? ["", `⚡ ${streakDays} Tage in Folge trainiert, nicht abreißen lassen!`] : []),
    ].join("\n"),
    buttons: [
      { text: "▶️ Los geht's", callback_data: `tr:r:${scenarioKey}` },
      { text: "🎲 Anderer Einwand", callback_data: "tr:n" },
    ],
  };
}

export interface WeekStats {
  sessions: number;
  xp: number;
  yes: number;
  avg: Record<Criterion, number> | null;
  /** Schnitt der Woche davor (für den Vergleich). */
  prevAvg: number | null;
}

export function weeklyMessage(w: WeekStats): CoachMessage {
  if (w.sessions === 0)
    return {
      text: "📅 <b>Deine Trainingswoche</b>\n\nDiese Woche keine Runde. Zehn Minuten am Montag, und du bist wieder drin 💪",
      buttons: [{ text: "🎭 Jetzt eine Runde", callback_data: "tr:n" }],
    };
  const avg = w.avg!;
  const total = (avg.zuhoeren + avg.nutzen + avg.ruhe + avg.abschluss) / 4;
  const trend =
    w.prevAvg === null
      ? ""
      : total > w.prevAvg + 0.05
        ? ` (📈 von ${comma(w.prevAvg)})`
        : total < w.prevAvg - 0.05
          ? ` (📉 von ${comma(w.prevAvg)})`
          : " (➡️ wie letzte Woche)";
  const weak = weakest(avg);
  return {
    text: [
      "📅 <b>Deine Trainingswoche</b>",
      "",
      `🎭 ${w.sessions} Gespräche · ✅ ${w.yes}× Ja · ⭐ +${w.xp} XP`,
      `Schnitt <b>${comma(total)}</b>${trend}`,
      "",
      ...(Object.keys(CRITERIA) as Criterion[]).map((k) => `${CRITERIA[k]}: ${comma(avg[k])}`),
      "",
      `💪 Stärkster Punkt: <b>${CRITERIA[strongest(avg)]}</b>`,
      `🎯 Nächste Woche drauf achten: <b>${CRITERIA[weak]}</b>`,
    ].join("\n"),
    buttons: [{ text: "🎭 Gleich eine Runde", callback_data: "tr:n" }],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Datenbank und LLM

async function recentFeedback(db: Db, limit = 10): Promise<CoachFeedback[]> {
  const { rows } = await db.query<{ feedback: CoachFeedback }>(
    `select feedback from training_sessions where status = 'fertig' and feedback is not null
      order by finished_at desc limit $1`,
    [limit],
  );
  return rows.map((r) => r.feedback);
}

export async function buildTip(deps: TrainerDeps): Promise<Tip> {
  const { db, config } = deps;
  const recent = (await getState<{ topic: string; hook: string }[]>(db, RECENT_KEY)) ?? [];
  const topic = nextTopic(
    config.themen,
    recent.map((r) => r.topic),
  );
  const avg = criterionAverages(await recentFeedback(db));
  const r = await deps.llm.structured({
    role: "trainer_tip",
    promptVersion: TIP_PROMPT,
    system: loadPrompt("trainer_tip", TIP_PROMPT),
    input: [
      `<thema>${topic ?? "frei wählen"}</thema>`,
      `<schwaechster_punkt>${avg ? `${CRITERIA[weakest(avg)]} (Schnitt ${comma(avg[weakest(avg)])} von 5)` : "noch keine Trainings"}</schwaechster_punkt>`,
      `<einwaende>\n${Object.entries(config.szenarien)
        .map(([k, s]) => `${k}: ${s.titel}`)
        .join("\n")}\n</einwaende>`,
      `<zuletzt>\n${recent.length > 0 ? recent.map((x) => `- ${x.hook}`).join("\n") : "(noch keine)"}\n</zuletzt>`,
    ].join("\n"),
    schema: tipSchema,
    inputSummary: `Sales-Häppchen ${topic ?? ""}`.trim(),
  });
  await setState(
    db,
    RECENT_KEY,
    [{ topic: topic ?? "", hook: r.output.aufhaenger }, ...recent].slice(0, KEEP),
  );
  return r.output;
}

/** Trainiert heute? Tage in Folge mit mindestens einem fertigen Gespräch bis gestern bzw. heute. */
async function trainingDays(db: Db, now: Date): Promise<{ today: boolean; streak: number }> {
  const { rows } = await db.query<{ d: string }>(
    `select distinct to_char((finished_at at time zone 'Europe/Berlin')::date, 'YYYY-MM-DD') as d
       from training_sessions where status = 'fertig' order by d desc limit 60`,
  );
  const days = new Set(rows.map((r) => r.d));
  const today = berlinDate(now);
  let streak = 0;
  const cursor = new Date(now);
  if (!days.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (days.has(berlinDate(cursor))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return { today: days.has(today), streak };
}

export async function weekStats(db: Db, now: Date): Promise<WeekStats> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const before = new Date(now.getTime() - 14 * 86_400_000);
  const { rows } = await db.query<{ feedback: CoachFeedback; xp: number; decision: string }>(
    `select feedback, xp, decision from training_sessions
      where status = 'fertig' and feedback is not null and finished_at > $1 and finished_at <= $2`,
    [since, now],
  );
  const { rows: prev } = await db.query<{ avg: string | null }>(
    `select avg(score) as avg from training_sessions where status = 'fertig' and finished_at > $1 and finished_at <= $2`,
    [before, since],
  );
  return {
    sessions: rows.length,
    xp: rows.reduce((s, r) => s + r.xp, 0),
    yes: rows.filter((r) => r.decision === "ja").length,
    avg: criterionAverages(rows.map((r) => r.feedback)),
    prevAvg: prev[0]?.avg != null ? Number(prev[0].avg) : null,
  };
}

/** Sweep: Häppchen, Einladung und Wochenbilanz zur eingestellten Zeit, je einmal. */
export async function coachTick(ctx: PipelineContext): Promise<void> {
  const trainer = ctx.trainer;
  const send = ctx.notifier.coachMessage?.bind(ctx.notifier);
  if (!trainer || !send) return;
  const deps = trainer();
  const m = deps.config.melden;
  if (!m.aktiv) return;
  const now = ctx.now();
  const weekday = WEEKDAYS[berlinWeekday(now)]!;
  const time = berlinTime(now);
  const date = berlinDate(now);
  const today = m.tage.includes(weekday);

  if (today) {
    // Nur das letzte fällige Häppchen (nach einem Neustart am Abend nicht beide auf einmal).
    const due = m.haeppchen.filter((t) => time >= t).sort();
    const slot = due.at(-1);
    if (slot && (await claimState(ctx.db, `coach-tip:${date}:${slot}`, now.toISOString()))) {
      for (const t of due.slice(0, -1)) await claimState(ctx.db, `coach-tip:${date}:${t}`, "übersprungen");
      await send(tipMessage(await buildTip(deps), deps.config));
    }
    if (m.einladung && time >= m.einladung && (await claimState(ctx.db, `coach-invite:${date}`, true))) {
      const days = await trainingDays(ctx.db, now);
      if (!days.today) {
        const key = pickScenario(deps.config, await playedScenarios(ctx.db));
        await send(invitationMessage(deps.config, key, days.streak));
      }
    }
  }
  const w = m.wochenbilanz;
  if (
    w &&
    weekday === w.tag &&
    time >= w.ab &&
    (await claimState(ctx.db, `coach-week:${isoWeek(now)}`, true))
  )
    await send(weeklyMessage(await weekStats(ctx.db, now)));
}
