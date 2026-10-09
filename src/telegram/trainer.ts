import type { Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import {
  abortSession,
  answer,
  christianTurns,
  getSession,
  openSession,
  playedScenarios,
  startSession,
  useHint,
  type CoachFeedback,
  type Decision,
  type PlayedScenario,
  type Scenario,
  type TrainerConfig,
  type TrainerDeps,
} from "../trainer/session.js";
import { escapeHtml } from "./format.js";
import { reportProgress } from "./game.js";

/** Sales-Trainer in Telegram (/training): Rollenspiel, Tipp, Aufgeben, Bewertung mit XP. */

export type TrainerCallback =
  { kind: "hint" | "quit"; id: string } | { kind: "again"; scenario: string } | { kind: "next" };

export function trainerCallback(c: TrainerCallback): string {
  switch (c.kind) {
    case "hint":
      return `tr:h:${c.id}`;
    case "quit":
      return `tr:x:${c.id}`;
    case "again":
      return `tr:r:${c.scenario}`;
    case "next":
      return "tr:n";
  }
}

export function parseTrainerCallback(data: string): TrainerCallback | null {
  if (data === "tr:n") return { kind: "next" };
  const m = /^tr:(h|x):([0-9a-f-]{36})$/.exec(data);
  if (m) return { kind: m[1] === "h" ? "hint" : "quit", id: m[2]! };
  const r = /^tr:r:([a-z0-9_]{1,40})$/.exec(data);
  return r ? { kind: "again", scenario: r[1]! } : null;
}

const MOOD = ["😠", "🙄", "😐", "🙂", "😄"];
export const moodEmoji = (mood: number) => MOOD[Math.max(-2, Math.min(2, mood)) + 2]!;
const stars = (n: number) => "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n));
const difficulty = (d: number) => "🔥".repeat(d);
const ownerName = (s: Scenario) => s.person.split(",")[0]!.trim();

export function introText(sc: Scenario, rounds: number): string {
  return [
    `🎭 <b>Training: ${escapeHtml(sc.titel)}</b> · ${difficulty(sc.schwierigkeit)}`,
    "",
    `📍 ${escapeHtml(sc.lage)}`,
    "",
    `🎯 Kläre den Einwand und vereinbare einen konkreten nächsten Schritt. Du hast ${rounds} Antworten, schreib einfach, was du sagen würdest.`,
  ].join("\n");
}

export function ownerLine(sc: Scenario, text: string, mood: number, turn: number, rounds: number): string {
  return `${moodEmoji(mood)} <b>${escapeHtml(ownerName(sc))}:</b> „${escapeHtml(text)}“\n<i>Deine Antwort ${turn}/${rounds}</i>`;
}

export function turnKeyboard(id: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "💡 Tipp (−3 XP)", callback_data: trainerCallback({ kind: "hint", id }) },
      { text: "🏳️ Aufgeben", callback_data: trainerCallback({ kind: "quit", id }) },
    ],
  ];
}

const DECISION: Record<Decision, string> = {
  ja: "✅ <b>Er ist dabei!</b>",
  nein: "❌ <b>Abgeblitzt.</b>",
  offen: "⏸ <b>Noch offen.</b>",
};

export function resultText(
  sc: Scenario,
  r: { decision: Decision; feedback: CoachFeedback; score: number; xp: number },
): string {
  const f = r.feedback;
  const row = (label: string, p: { punkte: number; satz: string }) =>
    `${stars(p.punkte)} <b>${label}</b>\n<i>${escapeHtml(p.satz)}</i>`;
  return [
    `${DECISION[r.decision].replace("Er ist", `${escapeHtml(ownerName(sc))} ist`)} Schnitt <b>${r.score.toFixed(1).replace(".", ",")}</b> · <b>+${r.xp} XP</b>`,
    "",
    row("Zuhören", f.zuhoeren),
    row("Nutzen", f.nutzen),
    row("Ruhe", f.ruhe),
    row("Abschluss", f.abschluss),
    "",
    `💪 ${escapeHtml(f.gut)}`,
    `🎯 ${escapeHtml(f.besser)}`,
    "",
    `🗣️ <b>So hätte es klingen können:</b>\n„${escapeHtml(f.beispiel)}“`,
  ].join("\n");
}

export function resultKeyboard(scenario: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "🔁 Nochmal", callback_data: trainerCallback({ kind: "again", scenario }) },
      { text: "▶️ Nächster Einwand", callback_data: trainerCallback({ kind: "next" }) },
    ],
  ];
}

/** Übersicht für /training liste: alle Szenarien mit bestem Ergebnis. */
export function scenarioList(config: TrainerConfig, played: readonly PlayedScenario[]): string {
  const lines = Object.entries(config.szenarien).map(([key, sc]) => {
    const p = played.find((x) => x.scenario === key);
    const result = p
      ? `${p.best >= config.gemeistert_ab ? "🧠" : "▫️"} bestes ${p.best.toFixed(1).replace(".", ",")} (${p.plays}×)`
      : "🆕";
    return `${difficulty(sc.schwierigkeit)} ${escapeHtml(sc.titel)} · ${result}\n<code>/training ${key}</code>`;
  });
  return [
    "🎭 <b>Einwände zum Üben</b>",
    "",
    ...lines,
    "",
    "Ohne Angabe wählt /training den, der am meisten bringt.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Ablauf im Chat

const busy = new Set<number>();

async function begin(ctx: Context, deps: TrainerDeps, chatId: number, scenario?: string): Promise<void> {
  await ctx.replyWithChatAction("typing").catch(() => undefined);
  const { session, scenario: sc } = await startSession(deps, chatId, scenario);
  const first = session.turns[0]!;
  await ctx.reply(introText(sc, deps.config.runden), { parse_mode: "HTML" });
  await ctx.reply(ownerLine(sc, first.text, first.mood ?? 0, 1, deps.config.runden), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: turnKeyboard(session.id) },
  });
}

/** /training [szenario|liste] */
export async function trainingCommand(ctx: Context, deps: TrainerDeps, arg: string): Promise<void> {
  const chatId = ctx.chat!.id;
  const key = arg.trim().toLowerCase();
  if (key === "liste" || key === "alle") {
    await ctx.reply(scenarioList(deps.config, await playedScenarios(deps.db)), { parse_mode: "HTML" });
    return;
  }
  if (key && !deps.config.szenarien[key]) {
    await ctx.reply(`Den Einwand „${key}“ kenne ich nicht. /training liste zeigt alle.`);
    return;
  }
  await begin(ctx, deps, chatId, key || undefined);
}

/** Textnachricht während eines offenen Gesprächs; `false`, wenn keins läuft. */
export async function handleTrainerText(ctx: Context, deps: TrainerDeps, text: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const session = await openSession(deps.db, chatId, deps.now(), deps.config);
  if (!session) return false;
  if (busy.has(chatId)) {
    await ctx.reply("Moment, dein Gegenüber denkt noch nach …");
    return true;
  }
  const sc = deps.config.szenarien[session.scenario];
  if (!sc) return false;
  busy.add(chatId);
  try {
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const r = await answer(deps, session, text);
    if (!r.done) {
      const turn = christianTurns(session.turns) + 2;
      await ctx.reply(ownerLine(sc, r.reply, r.mood, turn, deps.config.runden), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: turnKeyboard(session.id) },
      });
      return true;
    }
    await ctx.reply(`${moodEmoji(r.mood)} <b>${escapeHtml(ownerName(sc))}:</b> „${escapeHtml(r.reply)}“`, {
      parse_mode: "HTML",
    });
    await ctx.reply(resultText(sc, r.done), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: resultKeyboard(session.scenario) },
    });
    await reportProgress(ctx.api, [chatId], deps.db, deps.now());
    return true;
  } finally {
    busy.delete(chatId);
  }
}

/** Knöpfe des Trainers; `false`, wenn es keiner war. */
export async function handleTrainerCallback(ctx: Context, deps: TrainerDeps): Promise<boolean> {
  const cb = parseTrainerCallback(ctx.callbackQuery?.data ?? "");
  if (!cb) return false;
  const chatId = ctx.chat!.id;
  if (cb.kind === "next" || cb.kind === "again") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    await begin(ctx, deps, chatId, cb.kind === "again" ? cb.scenario : undefined);
    return true;
  }
  const session = await getSession(deps.db, cb.id);
  if (!session || session.status !== "offen") {
    await ctx.answerCallbackQuery({ text: "Das Gespräch ist schon vorbei." });
    return true;
  }
  const sc = deps.config.szenarien[session.scenario];
  if (cb.kind === "hint") {
    await useHint(deps.db, session.id, deps.now());
    await ctx.answerCallbackQuery();
    await ctx.reply(`💡 ${escapeHtml(sc?.tipp ?? "Hör zu, frag nach, schlag einen nächsten Schritt vor.")}`, {
      parse_mode: "HTML",
    });
    return true;
  }
  await abortSession(deps.db, session.id, deps.now());
  await ctx.answerCallbackQuery({ text: "Abgebrochen" });
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  await ctx.reply(`🏳️ Abgebrochen, ohne XP. ${sc ? `Tipp für nächstes Mal: ${escapeHtml(sc.tipp)}` : ""}`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: resultKeyboard(session.scenario) },
  });
  return true;
}
