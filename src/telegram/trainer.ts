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
  type Mode,
  type TrainingSession,
  liveHint,
  MODES,
} from "../trainer/session.js";
import { drillAnswer, phraseBoxes, startDrill, type DrillMode, type DrillStep } from "../trainer/drill.js";
import { fullSentence, loadPhrases, withGap, type Phrase, type Phrases } from "../trainer/phrases.js";
import { getState, setState } from "../db/appState.js";
import { escapeHtml } from "./format.js";
import { reportProgress } from "./game.js";

/**
 * Sales-Trainer in Telegram (/training) in drei Stufen (09.10.2026): 🟢 leicht = Lückentext, 🟡 mittel = Satz aus dem
 * Kopf, 🔴 schwer = Rollenspiel mit Tipp, Aufgeben, Bewertung. Die zuletzt gewählte Stufe merkt sich app_state.
 */

export type TrainerCallback =
  | { kind: "hint" | "quit" | "skip"; id: string }
  | { kind: "again"; scenario: string }
  | { kind: "next" }
  | { kind: "mode"; mode: Mode };

export function trainerCallback(c: TrainerCallback): string {
  switch (c.kind) {
    case "hint":
      return `tr:h:${c.id}`;
    case "quit":
      return `tr:x:${c.id}`;
    case "again":
      return `tr:r:${c.scenario}`;
    case "skip":
      return `tr:k:${c.id}`;
    case "next":
      return "tr:n";
    case "mode":
      return `tr:m:${c.mode}`;
  }
}

export function parseTrainerCallback(data: string): TrainerCallback | null {
  if (data === "tr:n") return { kind: "next" };
  const mode = /^tr:m:(leicht|mittel|schwer)$/.exec(data);
  if (mode) return { kind: "mode", mode: mode[1] as Mode };
  const m = /^tr:(h|x|k):([0-9a-f-]{36})$/.exec(data);
  if (m) return { kind: m[1] === "h" ? "hint" : m[1] === "k" ? "skip" : "quit", id: m[2]! };
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
    "👉 Handlungen in eckige Klammern, z. B. <i>[zeige ihm die Seite auf dem Tablet]</i>. Die Seite musst du nicht beschreiben, er sieht sie.",
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
    [
      {
        text: "⬇️ Leichter: Sätze aus dem Kopf",
        callback_data: trainerCallback({ kind: "mode", mode: "mittel" }),
      },
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
// Stufen leicht und mittel

export const MODE_LABEL: Record<Mode, string> = {
  leicht: "🟢 Leicht: Lückentext",
  mittel: "🟡 Mittel: Satz aus dem Kopf",
  schwer: "🔴 Schwer: Rollenspiel",
};

/** Die ersten Wörter als Starthilfe für „mittel“. */
export function opening(p: Phrase, words = 2): string {
  return fullSentence(p).split(" ").slice(0, words).join(" ");
}

export function drillIntro(mode: DrillMode, total: number): string {
  return mode === "leicht"
    ? `🟢 <b>Lückentext</b> · ${total} Sätze\nJeder Satz passt auf viele Einwände. Schreib nur das fehlende Wort, so brennt er sich ein.`
    : `🟡 <b>Aus dem Kopf</b> · ${total} Sätze\nDu siehst den Einwand und den Anfang. Schreib den ganzen Satz, eigene Worte sind okay, die Kernwörter müssen rein.`;
}

export function drillPrompt(mode: DrillMode, p: Phrase, position: number, total: number): string {
  const head = `${mode === "leicht" ? "🟢" : "🟡"} <b>Satz ${position}/${total}</b> · ${escapeHtml(p.kategorie)}\n🗣️ Inhaber: <i>${escapeHtml(p.einwand)}</i>`;
  return mode === "leicht"
    ? `${head}\n\nDu: „${escapeHtml(withGap(p))}“\n<i>Welches Wort fehlt?</i>`
    : `${head}\n\nDu: „${escapeHtml(opening(p))} …“\n<i>Schreib den ganzen Satz.</i>`;
}

export function drillKeyboard(id: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "🤷 Weiß nicht", callback_data: trainerCallback({ kind: "skip", id }) },
      { text: "🏳️ Aufhören", callback_data: trainerCallback({ kind: "quit", id }) },
    ],
  ];
}

export function drillFeedback(step: DrillStep): string {
  return [
    step.correct ? "✅ <b>Richtig!</b>" : "❌ <b>So geht er:</b>",
    `„${escapeHtml(fullSentence(step.phrase))}“`,
    ...(step.missed.length > 0 && !step.correct
      ? [`<i>Gefehlt: ${step.missed.map(escapeHtml).join(", ")}</i>`]
      : []),
    `💡 <i>${escapeHtml(step.phrase.wann)}</i>`,
  ].join("\n");
}

export function drillDoneText(mode: DrillMode, d: { correct: number; total: number; xp: number }): string {
  const praise =
    d.correct === d.total
      ? "Alle richtig, stark! 🔥"
      : d.correct >= d.total / 2
        ? "Gut dabei 💪"
        : "Dranbleiben, das sitzt bald 🙂";
  return `🏁 <b>Runde fertig:</b> ${d.correct}/${d.total} richtig · <b>+${d.xp} XP</b>\n${praise}${
    mode === "leicht" && d.correct === d.total
      ? "\nBereit für die nächste Stufe? Dann ohne Lücke, aus dem Kopf."
      : ""
  }`;
}

export function drillDoneKeyboard(mode: DrillMode): InlineKeyboardButton[][] {
  const again = { text: "🔁 Nochmal", callback_data: trainerCallback({ kind: "mode", mode }) };
  return mode === "leicht"
    ? [[again, { text: "⬆️ Mittel", callback_data: trainerCallback({ kind: "mode", mode: "mittel" }) }]]
    : [
        [
          again,
          {
            text: "⬆️ Schwer: Rollenspiel",
            callback_data: trainerCallback({ kind: "mode", mode: "schwer" }),
          },
        ],
        [{ text: "⬇️ Leicht", callback_data: trainerCallback({ kind: "mode", mode: "leicht" }) }],
      ];
}

/** /saetze: alle Sätze nach Kategorie mit Lernstand (Fach 0 bis 4). */
export function phraseList(phrases: Phrases, boxes: Map<string, number>): string {
  const byCat = new Map<string, [string, Phrase][]>();
  for (const [k, p] of Object.entries(phrases))
    byCat.set(p.kategorie, [...(byCat.get(p.kategorie) ?? []), [k, p]]);
  const mark = (k: string) => {
    const b = boxes.get(k);
    return b === undefined ? "▫️" : b >= 3 ? "🧠" : b >= 1 ? "🟢" : "🔸";
  };
  const learned = [...boxes.values()].filter((b) => b >= 3).length;
  return [
    `📚 <b>Deine Sätze</b> · ${learned}/${Object.keys(phrases).length} sitzen 🧠`,
    "",
    ...[...byCat.entries()].flatMap(([cat, list]) => [
      `<b>${escapeHtml(cat)}</b>`,
      ...list.map(([k, p]) => `${mark(k)} „${escapeHtml(fullSentence(p))}“`),
      "",
    ]),
    "▫️ neu · 🔸 geübt · 🟢 sitzt fast · 🧠 sitzt",
    "Üben: /training leicht, dann /training mittel",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Ablauf im Chat

const busy = new Set<number>();
const modeKey = (chatId: number) => `trainer:mode:${chatId}`;

export async function currentMode(deps: TrainerDeps, chatId: number): Promise<Mode> {
  const m = await getState<Mode>(deps.db, modeKey(chatId));
  return m && MODES.includes(m) ? m : "leicht";
}

async function beginRoleplay(
  ctx: Context,
  deps: TrainerDeps,
  chatId: number,
  scenario?: string,
): Promise<void> {
  await ctx.replyWithChatAction("typing").catch(() => undefined);
  const { session, scenario: sc } = await startSession(deps, chatId, scenario);
  const first = session.turns[0]!;
  await ctx.reply(introText(sc, deps.config.runden), { parse_mode: "HTML" });
  await ctx.reply(ownerLine(sc, first.text, first.mood ?? 0, 1, deps.config.runden), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: turnKeyboard(session.id) },
  });
}

async function beginDrill(ctx: Context, deps: TrainerDeps, chatId: number, mode: DrillMode): Promise<void> {
  const { session, phrase } = await startDrill(deps, loadPhrases(), chatId, mode);
  const total = session.drill!.items.length;
  await ctx.reply(drillIntro(mode, total), { parse_mode: "HTML" });
  await ctx.reply(drillPrompt(mode, phrase, 1, total), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: drillKeyboard(session.id) },
  });
}

/** Runde in der Stufe starten und die Stufe merken. */
async function begin(
  ctx: Context,
  deps: TrainerDeps,
  chatId: number,
  mode: Mode,
  scenario?: string,
): Promise<void> {
  await setState(deps.db, modeKey(chatId), mode);
  if (mode === "schwer") await beginRoleplay(ctx, deps, chatId, scenario);
  else await beginDrill(ctx, deps, chatId, mode);
}

/** /training [leicht|mittel|schwer] [einwand] | liste */
export async function trainingCommand(ctx: Context, deps: TrainerDeps, arg: string): Promise<void> {
  const chatId = ctx.chat!.id;
  const parts = arg.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts[0] === "liste" || parts[0] === "alle") {
    await ctx.reply(scenarioList(deps.config, await playedScenarios(deps.db)), { parse_mode: "HTML" });
    return;
  }
  let mode: Mode | null = null;
  if (parts[0] && MODES.includes(parts[0] as Mode)) mode = parts.shift() as Mode;
  const key = parts[0];
  if (key && !deps.config.szenarien[key]) {
    await ctx.reply(`Den Einwand „${key}“ kenne ich nicht. /training liste zeigt alle.`);
    return;
  }
  await begin(ctx, deps, chatId, key ? "schwer" : (mode ?? (await currentMode(deps, chatId))), key);
}

/** /saetze */
export async function phrasesCommand(ctx: Context, deps: TrainerDeps): Promise<void> {
  await ctx.reply(phraseList(loadPhrases(), await phraseBoxes(deps.db)), { parse_mode: "HTML" });
}

async function stepDrill(ctx: Context, deps: TrainerDeps, session: TrainingSession, input: string | null) {
  const mode = session.mode as DrillMode;
  const step = await drillAnswer(deps, loadPhrases(), session, input);
  await ctx.reply(drillFeedback(step), { parse_mode: "HTML" });
  if (step.next) {
    await ctx.reply(drillPrompt(mode, step.next.phrase, step.next.position, step.next.total), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: drillKeyboard(session.id) },
    });
    return;
  }
  await ctx.reply(drillDoneText(mode, step.done!), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: drillDoneKeyboard(mode) },
  });
  await reportProgress(ctx.api, [ctx.chat!.id], deps.db, deps.now());
}

/** Textnachricht während einer offenen Runde; `false`, wenn keine läuft. */
export async function handleTrainerText(ctx: Context, deps: TrainerDeps, text: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const session = await openSession(deps.db, chatId, deps.now(), deps.config);
  if (!session) return false;
  if (busy.has(chatId)) {
    await ctx.reply("Moment, dein Gegenüber denkt noch nach …");
    return true;
  }
  busy.add(chatId);
  try {
    if (session.mode !== "schwer") {
      await stepDrill(ctx, deps, session, text);
      return true;
    }
    const sc = deps.config.szenarien[session.scenario];
    if (!sc) return false;
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
  if (cb.kind === "next" || cb.kind === "again" || cb.kind === "mode") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    if (cb.kind === "mode") await begin(ctx, deps, chatId, cb.mode);
    else await begin(ctx, deps, chatId, "schwer", cb.kind === "again" ? cb.scenario : undefined);
    return true;
  }
  const session = await getSession(deps.db, cb.id);
  if (!session || session.status !== "offen") {
    await ctx.answerCallbackQuery({ text: "Die Runde ist schon vorbei." });
    return true;
  }
  if (cb.kind === "skip") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    if (session.mode !== "schwer") await stepDrill(ctx, deps, session, null);
    return true;
  }
  const sc = deps.config.szenarien[session.scenario];
  if (cb.kind === "hint") {
    await ctx.answerCallbackQuery({ text: "Ich überleg kurz …" });
    await useHint(deps.db, session.id, deps.now());
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const phrases = Object.values(loadPhrases());
    const hint = await liveHint(deps, session, phrases).catch(() => null);
    await ctx.reply(
      hint
        ? `💡 ${escapeHtml(hint.hinweis)}\n🗣️ <i>Zum Beispiel:</i> „${escapeHtml(hint.satz)}“`
        : `💡 ${escapeHtml(sc?.tipp ?? "Hör zu, frag nach, schlag einen nächsten Schritt vor.")}`,
      { parse_mode: "HTML" },
    );
    return true;
  }
  await abortSession(deps.db, session.id, deps.now());
  await ctx.answerCallbackQuery({ text: "Abgebrochen" });
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  if (session.mode !== "schwer") {
    await ctx.reply("🏳️ Runde beendet, ohne XP.", {
      reply_markup: { inline_keyboard: drillDoneKeyboard(session.mode) },
    });
    return true;
  }
  await ctx.reply(`🏳️ Abgebrochen, ohne XP. ${sc ? `Tipp für nächstes Mal: ${escapeHtml(sc.tipp)}` : ""}`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: resultKeyboard(session.scenario) },
  });
  return true;
}
