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
import { berlinDate } from "../autopilot/plan.js";
import { draftEmail, type OutreachDeps } from "../outreach/draft.js";
import { draftLetter, type LetterDeps } from "../outreach/letter.js";
import type { MailConfig, Mailbox } from "../outreach/mail.js";
import { createConfirmDraft, icsInvite, terminLabel } from "../outreach/confirm.js";
import { sendDraft } from "../outreach/send.js";
import { gameState } from "../game/xp.js";
import { callbackData, escapeHtml } from "./format.js";
import { levelLine, reportProgress, xpSuffix } from "./game.js";

/**
 * Morgen-Paket in Telegram: Kopf mit Zähler ("Mails 3/15"), darunter eine Karte nach der anderen. Je Karte ein Knopf
 * zum Senden (über Christians Postfach), neu schreiben, später oder aussortieren. Gesendet wird nur auf Knopfdruck.
 */

export type PlanCallback =
  { kind: "next" } | { kind: "send" | "redo" | "later" | "drop" | "done"; id: string };

const UUID = "[0-9a-f-]{36}";
const CODES = { send: "ps", redo: "pr", later: "pz", drop: "pd", done: "pm" } as const;

export function planCallback(c: PlanCallback): string {
  return c.kind === "next" ? "pl:n" : `${CODES[c.kind]}:${c.id}`;
}

export function parsePlanCallback(data: string): PlanCallback | null {
  if (data === "pl:n") return { kind: "next" };
  const m = new RegExp(`^(ps|pr|pz|pd|pm):(${UUID})$`).exec(data);
  if (!m) return null;
  const kind = Object.entries(CODES).find(([, v]) => v === m[1])![0] as Exclude<PlanCallback["kind"], "next">;
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
    line("📧", "Neue Mails", counts.email),
    line("🖨️", "Befund-Seiten", counts.letter),
    line("🔁", "Nachfassen", counts.followup),
  ].filter(Boolean);
  const total = counts.email.total + counts.letter.total + counts.followup.total;
  const done = counts.email.done + counts.letter.done + counts.followup.done;
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

export function planHeaderKeyboard(counts: PlanCounts, canSend = false): InlineKeyboardButton[][] {
  const open =
    counts.email.total -
    counts.email.done +
    counts.letter.total -
    counts.letter.done +
    counts.followup.total -
    counts.followup.done;
  const mails = counts.email.total - counts.email.done + counts.followup.total - counts.followup.done;
  const rows: InlineKeyboardButton[][] = [];
  if (open > 0) rows.push([{ text: "▶️ Weiter", callback_data: planCallback({ kind: "next" }) }]);
  if (canSend && mails > 1) rows.push([{ text: `📤 Alle ${mails} Mails senden`, callback_data: "pl:a" }]);
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
  extra.push({ text: "🗂 Lead", callback_data: callbackData("c", item.company_id) });
  keyboard.push(extra);
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
    ],
  };
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
  const counts = countPlan(await planItems(db, date));
  const game = await gameLine(db);
  const refs: HeaderRef = [];
  for (const chatId of chatIds) {
    const m = await api.sendMessage(chatId, planHeaderText(date, counts, night, game), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: planHeaderKeyboard(counts, canSend) },
    });
    refs.push({ chatId, messageId: m.message_id });
  }
  await setState(db, HEADER_KEY(date), refs);
}

async function refreshHeader(api: Api, db: Db, date: string, canSend: boolean): Promise<void> {
  const refs = (await getState<HeaderRef>(db, HEADER_KEY(date))) ?? [];
  const night = (await getState<string[]>(db, NIGHT_KEY(date))) ?? [];
  const counts = countPlan(await planItems(db, date));
  const game = await gameLine(db);
  for (const r of refs) {
    await api
      .editMessageText(r.chatId, r.messageId, planHeaderText(date, counts, night, game), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: planHeaderKeyboard(counts, canSend) },
      })
      .catch(() => undefined); // "message is not modified" o. ä.
  }
}

async function draftOf(db: Db, id: string | null): Promise<DraftRow | null> {
  if (!id) return null;
  const { rows } = await db.query<DraftRow>("select body, meta from interactions where id = $1", [id]);
  return rows[0] ?? null;
}

/** Nächste offene Karte schicken; gibt `false` zurück, wenn nichts mehr offen ist. */
/** Nächste offene Karte in den Chat schicken; gibt `false` zurück, wenn nichts mehr offen ist. */
export async function sendNextCard(api: Api, chatId: number, deps: PlanBotDeps): Promise<boolean> {
  const date = berlinDate(deps.now());
  const items = await planItems(deps.db, date);
  const active = items.filter((i) => i.status !== "dropped" && i.status !== "later");
  const next = active.find((i) => i.status === "ready");
  if (!next) {
    await api.sendMessage(
      chatId,
      items.length === 0
        ? "Für heute ist kein Morgen-Paket vorbereitet."
        : "🎉 Alles erledigt für heute. Antworten melde ich dir sofort.",
    );
    return false;
  }
  const pos = { n: active.indexOf(next) + 1, total: active.length };
  const draft = await draftOf(deps.db, next.draft_id);
  if (!draft) {
    await setPlanStatus(deps.db, next.id, "later", deps.now());
    return sendNextCard(api, chatId, deps);
  }
  if (next.channel === "letter") {
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

const showNext = (ctx: Context, deps: PlanBotDeps) =>
  ctx.chat ? sendNextCard(ctx.api, ctx.chat.id, deps) : Promise.resolve(false);

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
  for (const chatId of chatIds) await sendNextCard(api, chatId, deps);
}

/** Karte nach einer Aktion abschließen: Knöpfe weg, Ergebnis dazu. */
async function closeCard(ctx: Context, note: string): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  if ("caption" in msg && msg.caption !== undefined) {
    await ctx
      .editMessageCaption({ caption: `${msg.caption}\n\n${note}`, reply_markup: { inline_keyboard: [] } })
      .catch(() => undefined);
  } else if ("text" in msg && msg.text !== undefined) {
    await ctx
      .editMessageText(`${escapeHtml(msg.text.split("\n")[0] ?? "")}\n${escapeHtml(note)}`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
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
        contact: { phone: deps.outreach.contact.phone },
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
  // Alle offenen Mails auf einmal (mit Rückfrage).
  if (data === "pl:a" || data === "pl:A" || data === "pl:x") {
    await ctx.answerCallbackQuery();
    const date = berlinDate(now);
    const open = (await planItems(db, date)).filter((i) => i.status === "ready" && i.channel === "email");
    if (data === "pl:x") {
      await ctx.editMessageText("Abgebrochen, nichts gesendet.").catch(() => undefined);
      return true;
    }
    if (data === "pl:a") {
      await ctx.reply(
        `Wirklich alle ${open.length} Mails jetzt senden? Jede geht einzeln über dein Postfach raus, Befund-Seiten bleiben offen.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: `✅ Ja, alle ${open.length} senden`, callback_data: "pl:A" },
                { text: "Abbrechen", callback_data: "pl:x" },
              ],
            ],
          },
        },
      );
      return true;
    }
    if (!deps.mailbox) return true;
    let sent = 0;
    const problems: string[] = [];
    for (const item of open) {
      if (!item.draft_id) continue;
      const r = await sendDraft(
        { db, mailbox: deps.mailbox, mail: deps.mail, now: deps.now, followUpDays: deps.followUpDays },
        item.draft_id,
        by,
      ).catch((err: unknown) => ({
        kind: "error" as const,
        message: err instanceof Error ? err.message : String(err),
      }));
      if (r.kind === "sent" || r.kind === "already_sent") {
        await setPlanStatus(db, item.id, "done", now);
        if (r.kind === "sent") sent++;
      } else if (r.kind === "limit") {
        problems.push(`Tageslimit erreicht (${r.max}), Rest bleibt offen`);
        break;
      } else {
        problems.push(
          `${item.company_name}: ${r.kind === "error" ? r.message.slice(0, 80) : "keine Adresse"}`,
        );
      }
    }
    const p = sent > 0 ? await progress(ctx, deps) : null;
    await ctx
      .editMessageText(
        `📤 ${sent} Mails gesendet${xpSuffix(p)}.${problems.length ? `\n⚠️ ${problems.join("\n⚠️ ")}` : ""}`,
      )
      .catch(() => undefined);
    await refreshHeader(ctx.api, db, date, true);
    await showNext(ctx, deps);
    return true;
  }
  const cb = data ? parsePlanCallback(data) : null;
  if (!cb) return false;
  if (cb.kind === "next") {
    await ctx.answerCallbackQuery();
    await showNext(ctx, deps);
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
    await closeCard(ctx, "⏭️ Später");
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
    await showNext(ctx, deps);
    return true;
  }
  await refreshHeader(ctx.api, db, item.plan_date, deps.mailbox !== null);
  await showNext(ctx, deps);
  return true;
}
