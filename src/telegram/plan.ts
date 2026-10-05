import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InputFile, type Api, type Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { getState, setState } from "../db/appState.js";
import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { setSalesStatus } from "../db/crm.js";
import {
  countPlan,
  planItem,
  planItems,
  setPlanDraft,
  setPlanStatus,
  type PlanCounts,
  type PlanItemWithCompany,
} from "../db/plan.js";
import { berlinDate, berlinTime } from "../autopilot/plan.js";
import { draftEmail, type OutreachDeps } from "../outreach/draft.js";
import { draftLetter, type LetterDeps } from "../outreach/letter.js";
import type { MailConfig, Mailbox } from "../outreach/mail.js";
import { createConfirmDraft, icsInvite, terminLabel } from "../outreach/confirm.js";
import { queuePlanMails } from "../outreach/queue.js";
import { sendDraft } from "../outreach/send.js";
import { gameState } from "../game/xp.js";
import { callbackData, escapeHtml, websiteButton } from "./format.js";
import { teaserPath } from "../prototype/teaser.js";
import { missedCalls, parseConsentInput, recordCall } from "../outreach/call.js";
import { levelLine, reportProgress, xpSuffix } from "./game.js";

/**
 * Morgen-Paket in Telegram: Kopf mit Zähler ("Mails 3/15"), darunter eine Karte nach der anderen. Je Karte ein Knopf
 * zum Senden (über Christians Postfach), neu schreiben, später oder aussortieren. Gesendet wird nur auf Knopfdruck.
 */

export type PlanCallback =
  | { kind: "next" }
  | { kind: "restore" }
  | {
      kind:
        | "send"
        | "redo"
        | "later"
        | "drop"
        | "done"
        | "undo"
        // Anruf-Liste: Ja (Mail erwünscht), lieber Post, nicht erreicht, kein Interesse; Adresse aus dem Impressum
        // bzw. andere Adresse eintippen.
        | "yes"
        | "post"
        | "missed"
        | "nope"
        | "impressum"
        | "other";
      id: string;
    };

const UUID = "[0-9a-f-]{36}";
const CODES = {
  send: "ps",
  redo: "pr",
  later: "pz",
  drop: "pd",
  done: "pm",
  undo: "pu",
  yes: "py",
  post: "pp",
  missed: "pn",
  nope: "px",
  impressum: "pa",
  other: "pe",
} as const;

export function planCallback(c: PlanCallback): string {
  if (c.kind === "next") return "pl:n";
  if (c.kind === "restore") return "pl:u";
  return `${CODES[c.kind]}:${c.id}`;
}

export function parsePlanCallback(data: string): PlanCallback | null {
  if (data === "pl:n") return { kind: "next" };
  if (data === "pl:u") return { kind: "restore" };
  const m = new RegExp(`^(${Object.values(CODES).join("|")}):(${UUID})$`).exec(data);
  if (!m) return null;
  const kind = Object.entries(CODES).find(([, v]) => v === m[1])![0] as Exclude<
    PlanCallback["kind"],
    "next" | "restore"
  >;
  return { kind, id: m[2]! };
}

const WEEKDAY = new Intl.DateTimeFormat("de-DE", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "Europe/Berlin",
});

export function planHeaderText(
  date: string,
  counts: PlanCounts,
  night: readonly string[] = [],
  game: string | null = null,
): string {
  const line = (emoji: string, label: string, c: { done: number; total: number }) =>
    c.total > 0 ? `${emoji} ${label}: <b>${c.done}/${c.total}</b>${c.done === c.total ? " ✅" : ""}` : null;
  const lines = [
    line("📞", "Anrufe", counts.phone),
    line("📧", "Neue Mails", counts.email),
    line("🖨️", "Befund-Seiten", counts.letter),
    line("🔁", "Nachfassen", counts.followup),
  ].filter(Boolean);
  const total = counts.phone.total + counts.email.total + counts.letter.total + counts.followup.total;
  const done = counts.phone.done + counts.email.done + counts.letter.done + counts.followup.done;
  const title = `☀️ <b>Morgen-Paket</b> · ${escapeHtml(WEEKDAY.format(new Date(`${date}T12:00:00Z`)))}`;
  const nightBlock = night.length > 0 ? ["", "🌙 <b>Heute Nacht:</b>", ...night.map(escapeHtml)] : [];
  const gameBlock = game ? ["", game] : [];
  if (total === 0)
    return [title, "", "Heute ist nichts vorbereitet.", ...nightBlock, ...gameBlock].join("\n");
  return [
    title,
    "",
    ...lines,
    "",
    done === total
      ? "🎉 Alles erledigt für heute."
      : "Alles ist vorbereitet. Einmal drüberlesen, dann ein Knopf.",
    ...nightBlock,
    ...gameBlock,
  ].join("\n");
}

export function planHeaderKeyboard(
  counts: PlanCounts,
  canSend = false,
  /** Heute zurückgestellt ("Später"). */
  later = 0,
): InlineKeyboardButton[][] {
  const open =
    counts.phone.total -
    counts.phone.done +
    counts.email.total -
    counts.email.done +
    counts.letter.total -
    counts.letter.done +
    counts.followup.total -
    counts.followup.done;
  const mails = counts.email.total - counts.email.done + counts.followup.total - counts.followup.done;
  const rows: InlineKeyboardButton[][] = [];
  if (open > 0) rows.push([{ text: "▶️ Weiter", callback_data: planCallback({ kind: "next" }) }]);
  if (canSend && mails > 1)
    rows.push([{ text: `📤 Alle ${mails} Mails verteilt senden`, callback_data: "pl:a" }]);
  if (later > 0)
    rows.push([
      { text: `↩️ ${later} zurückgestellte zurückholen`, callback_data: planCallback({ kind: "restore" }) },
    ]);
  return rows;
}

interface DraftRow {
  body: string | null;
  meta: {
    subject?: string;
    to?: string | null;
    preview_url?: string | null;
    teaser?: string;
    pdf?: string;
    png?: string;
    envelope?: string[];
    // Anruf-Liste (src/outreach/call.ts)
    phone?: string;
    person?: string | null;
    email?: string | null;
    befund?: string | null;
    bewertung?: string | null;
    opener?: string;
    pitch?: string;
    hook?: string | null;
    objections?: string[];
  };
}

export function planEmailCard(
  item: PlanItemWithCompany,
  draft: DraftRow,
  pos: { n: number; total: number },
  canSend: boolean,
): { text: string; keyboard: InlineKeyboardButton[][] } {
  const label = item.kind === "followup" ? "🔁 Nachfassen" : "📧 Neue Mail";
  const text = [
    `${label} <b>${pos.n}/${pos.total}</b> · <b>${escapeHtml(item.company_name)}</b>${item.current_score !== null ? ` (${item.current_score})` : ""}`,
    `<b>An:</b> <code>${escapeHtml(draft.meta.to ?? "?")}</code>`,
    `<b>Betreff:</b> ${escapeHtml(draft.meta.subject ?? "")}`,
    "",
    `<blockquote expandable>${escapeHtml(draft.body ?? "")}</blockquote>`,
  ].join("\n");
  const first: InlineKeyboardButton[] = canSend
    ? [{ text: "📤 Senden", callback_data: planCallback({ kind: "send", id: item.id }) }]
    : [{ text: "✅ Selbst gesendet", callback_data: planCallback({ kind: "done", id: item.id }) }];
  if (item.kind === "new")
    first.push({ text: "🔄 Neu schreiben", callback_data: planCallback({ kind: "redo", id: item.id }) });
  const keyboard: InlineKeyboardButton[][] = [
    first,
    [
      { text: "⏭️ Später", callback_data: planCallback({ kind: "later", id: item.id }) },
      { text: "🗑️ Nicht anschreiben", callback_data: planCallback({ kind: "drop", id: item.id }) },
    ],
  ];
  const extra: InlineKeyboardButton[] = [];
  if (draft.meta.preview_url) extra.push({ text: "🎨 Entwurf ansehen", url: draft.meta.preview_url });
  const site = websiteButton(item.website_url);
  if (site) extra.push(site);
  extra.push({ text: "🗂 Lead", callback_data: callbackData("c", item.company_id) });
  keyboard.push(extra);
  keyboard.push([{ text: "▶️ Nächste ansehen", callback_data: planCallback({ kind: "next" }) }]);
  return { text, keyboard };
}

export function planLetterCard(
  item: PlanItemWithCompany,
  draft: DraftRow,
  pos: { n: number; total: number },
): { caption: string; keyboard: InlineKeyboardButton[][] } {
  const caption = [
    `🖨️ Befund-Seite <b>${pos.n}/${pos.total}</b> · <b>${escapeHtml(item.company_name)}</b>`,
    "",
    "<b>Umschlag:</b>",
    `<pre>${escapeHtml((draft.meta.envelope ?? []).join("\n"))}</pre>`,
    "Ausdrucken, Umschlag von Hand, einwerfen.",
  ].join("\n");
  return {
    caption,
    keyboard: [
      [
        { text: "📮 Eingeworfen", callback_data: planCallback({ kind: "done", id: item.id }) },
        { text: "🔄 Neu erstellen", callback_data: planCallback({ kind: "redo", id: item.id }) },
      ],
      [
        { text: "⏭️ Später", callback_data: planCallback({ kind: "later", id: item.id }) },
        { text: "🗑️ Nicht anschreiben", callback_data: planCallback({ kind: "drop", id: item.id }) },
      ],
      ...[websiteButton(item.website_url)].filter((b) => b !== null).map((b) => [b]),
    ],
  };
}

export function planCallCard(
  item: PlanItemWithCompany,
  draft: DraftRow,
  pos: { n: number; total: number },
): { text: string; keyboard: InlineKeyboardButton[][] } {
  const m = draft.meta;
  const text = [
    `📞 Anruf <b>${pos.n}/${pos.total}</b> · <b>${escapeHtml(item.company_name)}</b>${item.current_score !== null ? ` (${item.current_score})` : ""}`,
    `☎️ <b>${escapeHtml(m.phone ?? "?")}</b>`,
    ...(m.person ? [`👤 ${escapeHtml(m.person)}`] : []),
    ...(m.bewertung ? [`⭐ ${escapeHtml(m.bewertung)}`] : []),
    ...(m.befund ? [`🔎 ${escapeHtml(m.befund)}`] : []),
    "",
    `🗣 <i>${escapeHtml(m.opener ?? "")}</i>`,
    `<blockquote>${escapeHtml(m.pitch ?? "")}</blockquote>`,
    ...(m.objections && m.objections.length > 0
      ? [
          `<blockquote expandable>${escapeHtml([...(m.hook ? [m.hook, ""] : []), ...m.objections.map((o) => `• ${o}`)].join("\n"))}</blockquote>`,
        ]
      : []),
  ].join("\n");
  const keyboard: InlineKeyboardButton[][] = [
    [
      { text: "✅ Ja, Mail erwünscht", callback_data: planCallback({ kind: "yes", id: item.id }) },
      { text: "📮 Lieber per Post", callback_data: planCallback({ kind: "post", id: item.id }) },
    ],
    [
      { text: "📵 Nicht erreicht", callback_data: planCallback({ kind: "missed", id: item.id }) },
      { text: "❌ Kein Interesse", callback_data: planCallback({ kind: "nope", id: item.id }) },
    ],
  ];
  const extra: InlineKeyboardButton[] = [];
  const site = websiteButton(item.website_url);
  if (site) extra.push(site);
  extra.push({ text: "🗂 Lead", callback_data: callbackData("c", item.company_id) });
  keyboard.push(extra);
  keyboard.push([{ text: "▶️ Nächste ansehen", callback_data: planCallback({ kind: "next" }) }]);
  return { text, keyboard };
}

export interface PlanBotDeps {
  db: Db;
  now: () => Date;
  mailbox: Mailbox | null;
  mail: MailConfig;
  outreach: OutreachDeps;
  letter: LetterDeps | null;
  followUpDays: number;
  /** Link für Video-Gespräche in der Termin-Bestätigung (OUTREACH_MEETING_URL). */
  meetingUrl?: string | null;
}

const HEADER_KEY = (date: string) => `plan-header:${date}`;
const NIGHT_KEY = (date: string) => `plan-night:${date}`;
type HeaderRef = { chatId: number; messageId: number }[];

/** Level-Zeile für den Kopf (fehlt die Spiel-Konfiguration o. Ä., einfach ohne). */
async function gameLine(db: Db): Promise<string | null> {
  try {
    return levelLine(await gameState(db, new Date()));
  } catch {
    return null;
  }
}

/** Kopf-Nachricht schicken und merken (für spätere Zähler-Updates). */
export async function sendPlanHeader(
  api: Api,
  db: Db,
  chatIds: readonly number[],
  date: string,
  nightReport?: string[],
  canSend = false,
): Promise<void> {
  if (nightReport) await setState(db, NIGHT_KEY(date), nightReport);
  const night = (await getState<string[]>(db, NIGHT_KEY(date))) ?? [];
  const items = await planItems(db, date);
  const counts = countPlan(items);
  const later = items.filter((i) => i.status === "later").length;
  const game = await gameLine(db);
  const refs: HeaderRef = [];
  for (const chatId of chatIds) {
    const m = await api.sendMessage(chatId, planHeaderText(date, counts, night, game), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: planHeaderKeyboard(counts, canSend, later) },
    });
    refs.push({ chatId, messageId: m.message_id });
  }
  await setState(db, HEADER_KEY(date), refs);
}

async function refreshHeader(api: Api, db: Db, date: string, canSend: boolean): Promise<void> {
  const refs = (await getState<HeaderRef>(db, HEADER_KEY(date))) ?? [];
  const night = (await getState<string[]>(db, NIGHT_KEY(date))) ?? [];
  const items = await planItems(db, date);
  const counts = countPlan(items);
  const later = items.filter((i) => i.status === "later").length;
  const game = await gameLine(db);
  for (const r of refs) {
    await api
      .editMessageText(r.chatId, r.messageId, planHeaderText(date, counts, night, game), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: planHeaderKeyboard(counts, canSend, later) },
      })
      .catch(() => undefined); // "message is not modified" o. ä.
  }
}

async function draftOf(db: Db, id: string | null): Promise<DraftRow | null> {
  if (!id) return null;
  const { rows } = await db.query<DraftRow>("select body, meta from interactions where id = $1", [id]);
  return rows[0] ?? null;
}

const cursorKey = (date: string, chatId: number) => `plan-cursor:${date}:${chatId}`;

/**
 * Nächste offene Karte in den Chat schicken; gibt `false` zurück, wenn nichts mehr offen ist. Ohne `after` geht es
 * hinter der zuletzt gezeigten Karte weiter (05.10.2026, Christian: "Weiter" zeigte immer dieselbe Mail), am Ende
 * wieder von vorn; `after: 0` fängt vorn an (Morgen-Paket, /heute).
 */
export async function sendNextCard(
  api: Api,
  chatId: number,
  deps: PlanBotDeps,
  after?: number,
): Promise<boolean> {
  const date = berlinDate(deps.now());
  const items = await planItems(deps.db, date);
  const active = items.filter((i) => i.status !== "dropped" && i.status !== "later");
  const ready = active.filter((i) => i.status === "ready");
  const from = after ?? (await getState<number>(deps.db, cursorKey(date, chatId))) ?? 0;
  const next = ready.find((i) => i.position > from) ?? ready[0];
  if (!next) {
    await api.sendMessage(
      chatId,
      items.length === 0
        ? "Für heute ist kein Morgen-Paket vorbereitet."
        : "🎉 Alles erledigt für heute. Antworten melde ich dir sofort.",
    );
    return false;
  }
  await setState(deps.db, cursorKey(date, chatId), next.position);
  const pos = { n: active.indexOf(next) + 1, total: active.length };
  const draft = await draftOf(deps.db, next.draft_id);
  if (!draft) {
    await setPlanStatus(deps.db, next.id, "later", deps.now());
    return sendNextCard(api, chatId, deps, next.position);
  }
  if (next.channel === "phone") {
    const card = planCallCard(next, draft, pos);
    // Das Vorschau-Bild, von dem am Telefon die Rede ist.
    const teaser = deps.outreach.teaserDir ? teaserPath(deps.outreach.teaserDir, next.company_id) : null;
    if (teaser && existsSync(teaser))
      await api.sendPhoto(chatId, new InputFile(teaser), { disable_notification: true });
    await api.sendMessage(chatId, card.text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: card.keyboard },
    });
  } else if (next.channel === "letter") {
    const card = planLetterCard(next, draft, pos);
    if (draft.meta.pdf && existsSync(draft.meta.pdf)) {
      await api.sendDocument(chatId, new InputFile(draft.meta.pdf), {
        caption: card.caption,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: card.keyboard },
      });
    } else {
      await api.sendMessage(chatId, `${card.caption}\n\n⚠️ PDF fehlt, bitte „Neu erstellen“.`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: card.keyboard },
      });
    }
  } else {
    const card = planEmailCard(next, draft, pos, deps.mailbox !== null);
    // Vorschau-Bild, das in der Mail steht, direkt über der Karte zeigen.
    if (draft.meta.teaser && existsSync(draft.meta.teaser))
      await api.sendPhoto(chatId, new InputFile(draft.meta.teaser), { disable_notification: true });
    await api.sendMessage(chatId, card.text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: card.keyboard },
    });
  }
  return true;
}

const showNext = (ctx: Context, deps: PlanBotDeps, after?: number) =>
  ctx.chat ? sendNextCard(ctx.api, ctx.chat.id, deps, after) : Promise.resolve(false);

/**
 * Morgens ohne Zutun: Kopf (mit Nachtbericht) und gleich die erste Karte. Danach führt jeder Knopf zur nächsten.
 */
export async function sendMorningPackage(
  api: Api,
  chatIds: readonly number[],
  deps: PlanBotDeps,
  date: string,
  nightReport: string[] = [],
): Promise<void> {
  await sendPlanHeader(api, deps.db, chatIds, date, nightReport, deps.mailbox !== null);
  for (const chatId of chatIds) await sendNextCard(api, chatId, deps, 0);
}

/** Karte nach einer Aktion abschließen: Knöpfe weg, Ergebnis dazu. */
async function closeCard(ctx: Context, note: string, keyboard: InlineKeyboardButton[][] = []): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  if ("caption" in msg && msg.caption !== undefined) {
    await ctx
      .editMessageCaption({
        caption: `${msg.caption}\n\n${note}`,
        reply_markup: { inline_keyboard: keyboard },
      })
      .catch(() => undefined);
  } else if ("text" in msg && msg.text !== undefined) {
    await ctx
      .editMessageText(`${escapeHtml(msg.text.split("\n")[0] ?? "")}\n${escapeHtml(note)}`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      })
      .catch(() => undefined);
  }
}

/** XP prüfen und neue Level/Abzeichen in diesem Chat feiern. */
const progress = (ctx: Context, deps: PlanBotDeps) =>
  ctx.chat ? reportProgress(ctx.api, [ctx.chat.id], deps.db, deps.now()) : Promise.resolve(null);

/** Callback des Morgen-Pakets verarbeiten; `false`, wenn es keiner war. */
export async function handlePlanCallback(ctx: Context, deps: PlanBotDeps, by: string): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  const { db } = deps;
  const now = deps.now();
  // Termin aus einer Antwort bestätigen: Bestätigung schreiben und zum Senden zeigen.
  const confirm = data ? new RegExp(`^tb:(${UUID}):(\\d)$`).exec(data) : null;
  if (confirm) {
    await ctx.answerCallbackQuery({ text: "Schreibe die Bestätigung …" });
    const r = await createConfirmDraft(
      {
        db,
        outreach: deps.outreach.outreach,
        contact: deps.outreach.contact,
        meetingUrl: deps.meetingUrl ?? null,
        now,
      },
      confirm[1]!,
      Number(confirm[2]),
      by,
    );
    if (!r) {
      await ctx.reply("Den Termin finde ich nicht mehr (oder es fehlt die Empfänger-Adresse).");
      return true;
    }
    await ctx.reply(
      [
        `📅 <b>Bestätigung an ${escapeHtml(r.company.name)}</b> · ${escapeHtml(terminLabel(r.termin))}`,
        `<b>Betreff:</b> ${escapeHtml(r.subject)}`,
        "",
        `<blockquote expandable>${escapeHtml(r.body)}</blockquote>`,
        "Mit Kalender-Einladung im Anhang. Nach dem Senden: Status „interessiert“ und eine Erinnerung vor dem Gespräch.",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: deps.mailbox
            ? [[{ text: "📤 Bestätigung senden", callback_data: `sd:${r.draftId}` }]]
            : [],
        },
      },
    );
    return true;
  }
  // Einzelner Entwurf aus der Lead-Karte: "Jetzt senden".
  const single = data ? new RegExp(`^sd:(${UUID})$`).exec(data) : null;
  if (single) {
    if (!deps.mailbox) {
      await ctx.answerCallbackQuery({ text: "Versand ist nicht eingerichtet", show_alert: true });
      return true;
    }
    const r = await sendDraft(
      { db, mailbox: deps.mailbox, mail: deps.mail, now: deps.now, followUpDays: deps.followUpDays },
      single[1]!,
      by,
    ).catch((err: unknown) => ({
      kind: "error" as const,
      message: err instanceof Error ? err.message : String(err),
    }));
    const text =
      r.kind === "sent"
        ? `Gesendet an ${r.to}`
        : r.kind === "already_sent"
          ? "War schon gesendet"
          : r.kind === "limit"
            ? `Tageslimit erreicht (${r.max} neue Mails)`
            : r.kind === "error"
              ? `Senden fehlgeschlagen: ${r.message.slice(0, 150)}`
              : "Keine Empfänger-Adresse";
    const p = r.kind === "sent" ? await progress(ctx, deps) : null;
    await ctx.answerCallbackQuery({
      text: text + xpSuffix(p),
      show_alert: r.kind !== "sent" && r.kind !== "already_sent",
    });
    if (r.kind === "sent" || r.kind === "already_sent") await closeCard(ctx, `✅ ${text}${xpSuffix(p)}`);
    // Termin-Bestätigung: Einladung auch für Christians Kalender.
    if (r.kind === "sent") {
      const { rows } = await db.query<{ termin: string | null }>(
        "select meta->>'termin' as termin from interactions where id = $1",
        [single[1]],
      );
      const termin = rows[0]?.termin;
      if (termin)
        await ctx.replyWithDocument(
          new InputFile(
            Buffer.from(
              icsInvite({
                uid: `${single[1]}-christian@avelio.digital`,
                start: new Date(termin),
                minutes: deps.outreach.outreach.bestaetigung.dauer_minuten,
                summary: `Gespräch ${r.company.name}`,
                description: [r.company.phone ? `Tel. ${r.company.phone}` : null, r.to]
                  .filter(Boolean)
                  .join("\n"),
                now,
              }),
            ),
            "termin.ics",
          ),
          { caption: `📅 ${terminLabel(termin)} · für deinen Kalender (antippen)` },
        );
    }
    return true;
  }
  // Alle offenen Mails freigeben (mit Rückfrage); Avelio verschickt sie verteilt über den Tag (src/outreach/queue.ts).
  if (data === "pl:a" || data === "pl:A" || data === "pl:x") {
    await ctx.answerCallbackQuery();
    const date = berlinDate(now);
    const open = (await planItems(db, date)).filter((i) => i.status === "ready" && i.channel === "email");
    if (data === "pl:x") {
      await ctx.editMessageText("Abgebrochen, nichts gesendet.").catch(() => undefined);
      return true;
    }
    const w = deps.mail.verteilt;
    if (data === "pl:a") {
      await ctx.reply(
        `Alle ${open.length} Mails freigeben? Avelio schickt sie einzeln über dein Postfach, verteilt über den Tag (alle ${w.abstand_min} bis ${w.abstand_max} Minuten, Mo bis Fr ${w.von} bis ${w.bis} Uhr). Befund-Seiten bleiben offen.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: `✅ Ja, alle ${open.length} freigeben`, callback_data: "pl:A" },
                { text: "Abbrechen", callback_data: "pl:x" },
              ],
            ],
          },
        },
      );
      return true;
    }
    if (!deps.mailbox) return true;
    const q = await queuePlanMails(db, date, now, w);
    if (q.count === 0) {
      await ctx
        .editMessageText("Keine offenen Mails mehr, alles schon eingeplant oder gesendet.")
        .catch(() => undefined);
      return true;
    }
    const hm = (d: Date) => berlinTime(d);
    const sameDay = berlinDate(q.last!) === date;
    await ctx
      .editMessageText(
        `📤 ${q.count} Mails eingeplant. Die erste geht um ${hm(q.first!)} Uhr raus, die letzte ${sameDay ? "" : "am nächsten Werktag "}gegen ${hm(q.last!)} Uhr. Ich melde mich, wenn alle raus sind.`,
      )
      .catch(() => undefined);
    await refreshHeader(ctx.api, db, date, true);
    return true;
  }
  const cb = data ? parsePlanCallback(data) : null;
  if (!cb) return false;
  if (cb.kind === "next") {
    await ctx.answerCallbackQuery();
    await showNext(ctx, deps);
    return true;
  }
  // Zurückgestellte ("Später") von heute wieder in den Stapel, z. B. nach einem Fehlklick (05.10.2026).
  if (cb.kind === "restore" || cb.kind === "undo") {
    const date = berlinDate(now);
    const { rows } = await db.query<{ position: number }>(
      `update outreach_plan set status = 'ready', done_at = null
        where plan_date = $1 and status = 'later' and ($2::uuid is null or id = $2) returning position`,
      [date, cb.kind === "undo" ? cb.id : null],
    );
    await ctx.answerCallbackQuery({
      text: rows.length > 0 ? `↩️ ${rows.length} zurückgeholt` : "Nichts zurückgestellt",
    });
    if (rows.length === 0) return true;
    if (cb.kind === "undo") await closeCard(ctx, "↩️ Zurückgeholt, siehe unten");
    await refreshHeader(ctx.api, db, date, deps.mailbox !== null);
    await showNext(ctx, deps, Math.min(...rows.map((r) => r.position)) - 1);
    return true;
  }
  const item = await planItem(db, cb.id);
  if (!item) {
    await ctx.answerCallbackQuery({ text: "Eintrag nicht gefunden" });
    return true;
  }
  if (item.status !== "ready" && cb.kind !== "redo") {
    await ctx.answerCallbackQuery({ text: "Schon erledigt" });
    return true;
  }
  if (
    cb.kind === "yes" ||
    cb.kind === "post" ||
    cb.kind === "missed" ||
    cb.kind === "nope" ||
    cb.kind === "impressum" ||
    cb.kind === "other"
  )
    return handleCallOutcome(ctx, deps, item, cb.kind, by);

  if (cb.kind === "send") {
    if (!deps.mailbox || !item.draft_id) {
      await ctx.answerCallbackQuery({ text: "Versand ist nicht eingerichtet", show_alert: true });
      return true;
    }
    const r = await sendDraft(
      { db, mailbox: deps.mailbox, mail: deps.mail, now: deps.now, followUpDays: deps.followUpDays },
      item.draft_id,
      by,
    ).catch((err: unknown) => ({
      kind: "error" as const,
      message: err instanceof Error ? err.message : String(err),
    }));
    if (r.kind === "limit") {
      await ctx.answerCallbackQuery({
        text: `Tageslimit erreicht (${r.max} neue Mails). Der Rest morgen.`,
        show_alert: true,
      });
      return true;
    }
    if (r.kind === "no_address" || r.kind === "not_found") {
      await ctx.answerCallbackQuery({
        text: "Keine Empfänger-Adresse, bitte überspringen",
        show_alert: true,
      });
      return true;
    }
    if (r.kind === "error") {
      await ctx.answerCallbackQuery({
        text: `Senden fehlgeschlagen: ${r.message.slice(0, 150)}`,
        show_alert: true,
      });
      return true;
    }
    await setPlanStatus(db, item.id, "done", now);
    const p = await progress(ctx, deps);
    await ctx.answerCallbackQuery({
      text: r.kind === "sent" ? `Gesendet an ${r.to}${xpSuffix(p)}` : "War schon gesendet",
    });
    await closeCard(
      ctx,
      r.kind === "sent" ? `✅ Gesendet an ${r.to}${xpSuffix(p)}` : "✅ War schon gesendet",
    );
  } else if (cb.kind === "done") {
    await setPlanStatus(db, item.id, "done", now);
    if (item.kind === "new") {
      await setSalesStatus(db, item.company_id, "CONTACTED", {
        by,
        channel: item.channel,
        note: item.channel === "letter" ? "Befund-Seite per Post" : "E-Mail selbst gesendet",
        now,
        followUpDays: deps.followUpDays,
      });
    }
    const p = await progress(ctx, deps);
    await ctx.answerCallbackQuery({ text: `Vermerkt${xpSuffix(p)}` });
    await closeCard(ctx, `${item.channel === "letter" ? "📮 Eingeworfen" : "✅ Gesendet"}${xpSuffix(p)}`);
  } else if (cb.kind === "later") {
    await setPlanStatus(db, item.id, "later", now);
    await ctx.answerCallbackQuery({ text: "Kommt an einem anderen Tag wieder" });
    await closeCard(ctx, "⏭️ Später", [
      [{ text: "↩️ Rückgängig", callback_data: planCallback({ kind: "undo", id: item.id }) }],
    ]);
  } else if (cb.kind === "drop") {
    await setPlanStatus(db, item.id, "dropped", now);
    await setSalesStatus(db, item.company_id, "LOST", {
      by,
      note: "Im Morgen-Paket aussortiert",
      now,
      followUpDays: 0,
    });
    await ctx.answerCallbackQuery({ text: "Aussortiert, kommt nicht wieder" });
    await closeCard(ctx, "🗑️ Aussortiert");
  } else if (cb.kind === "redo") {
    await ctx.answerCallbackQuery({ text: "Schreibe neu …" });
    const { rows } = await db.query<Company>("select * from companies where id = $1", [item.company_id]);
    const company = rows[0]!;
    if (item.channel === "email") {
      const mail = await draftEmail(deps.outreach, company, by);
      if (!("kind" in mail)) await setPlanDraft(db, item.id, mail.draftId);
    } else if (deps.letter) {
      const letter = await draftLetter(deps.letter, company, by);
      if (!("kind" in letter)) {
        const dir = join("data", "letters", item.plan_date);
        await mkdir(dir, { recursive: true });
        const pdf = join(dir, letter.filename);
        await writeFile(pdf, letter.pdf);
        await db.query(
          `update interactions set meta = meta || jsonb_build_object('pdf', $2::text) where id = $1`,
          [letter.draftId, pdf],
        );
        await setPlanDraft(db, item.id, letter.draftId);
      }
    }
    await closeCard(ctx, "🔄 Neu geschrieben, siehe unten");
    // Dieselbe Karte neu zeigen.
    await showNext(ctx, deps, item.position - 1);
    return true;
  }
  await refreshHeader(ctx.api, db, item.plan_date, deps.mailbox !== null);
  await showNext(ctx, deps);
  return true;
}

const consentKey = (chatId: number) => `call-consent:${chatId}`;

/** Ergebnis eines Anrufs aus der Karte. */
async function handleCallOutcome(
  ctx: Context,
  deps: PlanBotDeps,
  item: PlanItemWithCompany,
  kind: "yes" | "post" | "missed" | "nope" | "impressum" | "other",
  by: string,
): Promise<boolean> {
  const { db } = deps;
  const now = deps.now();
  const draft = await draftOf(db, item.draft_id);
  const known = draft?.meta.email ?? null;
  if (kind === "yes") {
    await ctx.answerCallbackQuery({ text: "Super! 🎉" });
    await closeCard(ctx, "✅ Ja! Wohin soll der Entwurf? ↓");
    if (known) {
      await ctx.reply(`📧 Entwurf für <b>${escapeHtml(item.company_name)}</b> an welche Adresse?`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: `📧 ${known}`, callback_data: planCallback({ kind: "impressum", id: item.id }) }],
            [
              {
                text: "✏️ Andere Adresse / Name",
                callback_data: planCallback({ kind: "other", id: item.id }),
              },
            ],
          ],
        },
      });
      return true;
    }
    return askConsentInput(ctx, deps, item);
  }
  if (kind === "other") {
    await ctx.answerCallbackQuery();
    return askConsentInput(ctx, deps, item);
  }
  if (kind === "impressum") {
    if (!known) {
      await ctx.answerCallbackQuery({ text: "Keine Adresse bekannt" });
      return askConsentInput(ctx, deps, item);
    }
    await ctx.answerCallbackQuery({ text: "Schreibe die Mail …" });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    await finishConsent(ctx, deps, item, { email: known, name: null, salutation: null }, by);
    return true;
  }
  if (kind === "post") {
    await recordCall(db, item.company_id, "brief", { by, now });
    await setPlanStatus(db, item.id, "done", now);
    await ctx.answerCallbackQuery({ text: "Kommt per Brief" });
    await closeCard(ctx, "📮 Lieber per Post: Der Brief liegt im nächsten Morgen-Paket");
  } else if (kind === "nope") {
    await recordCall(db, item.company_id, "kein_interesse", { by, now });
    await setPlanStatus(db, item.id, "done", now);
    await ctx.answerCallbackQuery({ text: "Alles klar, kommt nie wieder" });
    await closeCard(ctx, "❌ Kein Interesse. Abgehakt, die Praxis kommt nicht wieder");
  } else {
    await recordCall(db, item.company_id, "nicht_erreicht", { by, now });
    const n = await missedCalls(db, item.company_id);
    const max = deps.outreach.outreach.anruf?.versuche ?? 3;
    if (n >= max) {
      await setPlanStatus(db, item.id, "done", now);
      await ctx.answerCallbackQuery({ text: `${n}× nicht erreicht, kommt per Brief` });
      await closeCard(ctx, `📵 ${n}× nicht erreicht: Der Brief liegt im nächsten Morgen-Paket`);
    } else {
      await setPlanStatus(db, item.id, "later", now);
      await ctx.answerCallbackQuery({ text: `Nicht erreicht (${n}/${max})` });
      await closeCard(ctx, `📵 Nicht erreicht (${n}/${max}), kommt am nächsten Werktag wieder`, [
        [{ text: "↩️ Heute nochmal versuchen", callback_data: planCallback({ kind: "undo", id: item.id }) }],
      ]);
    }
  }
  await refreshHeader(ctx.api, db, item.plan_date, deps.mailbox !== null);
  await showNext(ctx, deps);
  return true;
}

async function askConsentInput(ctx: Context, deps: PlanBotDeps, item: PlanItemWithCompany): Promise<boolean> {
  if (!ctx.chat) return true;
  await setState(deps.db, consentKey(ctx.chat.id), { itemId: item.id, at: deps.now().toISOString() });
  await ctx.reply(
    `✏️ Schreib mir die Mail-Adresse für <b>${escapeHtml(item.company_name)}</b>, gern mit Namen, z. B. „Frau Huber huber@praxis.de“.`,
    { parse_mode: "HTML" },
  );
  return true;
}

/** Nach dem Ja: Einwilligung festhalten, Mail mit Entwurf schreiben und zum Senden zeigen. */
async function finishConsent(
  ctx: Context,
  deps: PlanBotDeps,
  item: PlanItemWithCompany,
  who: { email: string; name: string | null; salutation: "Herr" | "Frau" | null },
  by: string,
): Promise<void> {
  const { db } = deps;
  const now = deps.now();
  const person = who.name ? `${who.salutation ?? ""} ${who.name}`.trim() : null;
  await recordCall(db, item.company_id, "ja", { by, now, to: who.email, person });
  await setPlanStatus(db, item.id, "done", now);
  const { rows } = await db.query<Company>("select * from companies where id = $1", [item.company_id]);
  const company = rows[0]!;
  await ctx.replyWithChatAction("typing").catch(() => undefined);
  const mail = await draftEmail(deps.outreach, company, by, {
    to: who.email,
    name: who.name,
    salutation: who.salutation,
  }).catch(() => null);
  if (!mail || "kind" in mail) {
    await ctx.reply(
      "Die Mail hat gerade nicht geklappt. Öffne den Lead und schreib sie über „✉️ Mail-Entwurf“.",
    );
    return;
  }
  if (mail.teaser && existsSync(mail.teaser))
    await ctx.replyWithPhoto(new InputFile(mail.teaser), { disable_notification: true });
  await ctx.reply(
    [
      `📧 <b>Mail an ${escapeHtml(company.name)}</b> (Einwilligung am Telefon ist vermerkt)`,
      `<b>An:</b> <code>${escapeHtml(who.email)}</code>`,
      `<b>Betreff:</b> ${escapeHtml(mail.subject)}`,
      "",
      `<blockquote expandable>${escapeHtml(mail.body)}</blockquote>`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: deps.mailbox
          ? [[{ text: "📤 Jetzt senden", callback_data: `sd:${mail.draftId}` }]]
          : [],
      },
    },
  );
  const p = await progress(ctx, deps);
  if (p) await refreshHeader(ctx.api, db, item.plan_date, deps.mailbox !== null);
}

/**
 * Freitext nach "✏️ Andere Adresse": Adresse (und Name) übernehmen. `false`, wenn gerade keine Adresse erwartet wird.
 */
export async function handleCallText(ctx: Context, deps: PlanBotDeps, by: string): Promise<boolean> {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text;
  if (chatId === undefined || !text) return false;
  const pending = await getState<{ itemId: string; at: string } | null>(deps.db, consentKey(chatId));
  if (!pending || deps.now().getTime() - Date.parse(pending.at) > 30 * 60_000) return false;
  const parsed = parseConsentInput(text);
  if (!parsed.email) {
    await ctx.reply("Da finde ich keine Mail-Adresse. Nochmal bitte, z. B. „Frau Huber huber@praxis.de“.");
    return true;
  }
  await setState(deps.db, consentKey(chatId), null);
  const item = await planItem(deps.db, pending.itemId);
  if (!item) return true;
  await finishConsent(
    ctx,
    deps,
    item,
    { email: parsed.email, name: parsed.name, salutation: parsed.salutation },
    by,
  );
  return true;
}
