import { Bot, InputFile, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { setRating } from "../db/calibration.js";
import { findCompany, type Company } from "../db/companies.js";
import {
  addReminder,
  companyHistory,
  completeReminder,
  openReminders,
  salesPipeline,
  setSalesStatus,
  snoozeReminder,
} from "../db/crm.js";
import { loadCrmConfig, SALES_LABELS } from "../crm/status.js";
import type { OutreachConfig } from "../outreach/config.js";
import { draftEmail, mailtoLink, type OutreachDeps } from "../outreach/draft.js";
import { draftLetter } from "../outreach/letter.js";
import { chromiumLetterRenderer, type LetterRenderer } from "../outreach/letterPdf.js";
import { raiseBudgetToday } from "../llm/budget.js";
import { askManager, type ManagerDeps } from "../manager/agent.js";
import { findLead } from "../manager/leads.js";
import { runTool } from "../manager/tools.js";
import { explainStoredLead } from "../pipeline/audit/explainStored.js";
import { loadGoldenEntries, nextRatingCard } from "../pipeline/calibration.js";
import { evaluateGoldenSet, formatCalibrationReport } from "../pipeline/scoring/calibration.js";
import { releaseBudgetDeferredJobs } from "../queue/pipeline.js";
import {
  callbackData,
  chunk,
  HELP_TEXT,
  markdownToTelegramHtml,
  emailDraftMessages,
  letterMessages,
  leadButtons,
  topLeadsText,
  leadCrmCard,
  parseCallback,
  parseCrmCallback,
  parseGradeCallback,
  pipelineMessage,
  ratingCardMessage,
} from "./format.js";

/**
 * Telegram-Bot (ARCHITECTURE.md 5.1, 12.1): Long Polling, reagiert nur auf erlaubte Chat-IDs. Freitext geht an den
 * Manager-Agenten, Schnellbefehle und Buttons laufen ohne LLM direkt über die Werkzeuge.
 */

export interface BotOptions {
  token: string;
  allowedChatIds: readonly number[];
  manager: ManagerDeps;
  /** Für Tests: Bot-Infos vorgeben (kein getMe-Aufruf). */
  botInfo?: UserFromGetMe;
  fetch?: typeof globalThis.fetch;
  /** Kontakt-Entwürfe (Phase 2). Ohne Angabe zeigt der Button einen Hinweis. */
  outreach?: {
    config: OutreachConfig;
    contact: OutreachDeps["contact"];
    /** Befund-Seite als PDF; ohne Angabe Chromium (CHROMIUM_PATH). */
    renderLetter?: LetterRenderer;
  };
}

const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  console[level === "info" ? "log" : level](JSON.stringify({ level, msg, ...extra }));

async function replyLong(ctx: Context, text: string) {
  for (const part of chunk(text)) await ctx.reply(part, { link_preview_options: { is_disabled: true } });
}

/** Antwort des Managers mit Fettdruck; lehnt Telegram das Markup ab, als reiner Text. */
async function replyFormatted(ctx: Context, text: string) {
  for (const part of chunk(text)) {
    await ctx
      .reply(markdownToTelegramHtml(part), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      })
      .catch(() => ctx.reply(part, { link_preview_options: { is_disabled: true } }));
  }
}

/** Fehlerursache ohne URL (die URL enthält den Bot-Token). */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${err.message} (${detail})` : err.message;
}

/**
 * grammY erzeugt Signale mit dem Paket "abort-controller". Das fetch von Node 24 akzeptiert nur echte AbortSignal
 * ("Expected signal to be an instance of AbortSignal"), daher wird der Abbruch auf ein eingebautes Signal übertragen.
 */
function nativeSignal(signal: AbortSignal | Pick<AbortSignal, "aborted" | "addEventListener">): AbortSignal {
  if (signal instanceof AbortSignal) return signal;
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller.signal;
}

/**
 * fetch für grammY: das eingebaute fetch von Node (nutzt wie check-env die Netzwerk-Einstellungen der Umgebung).
 * grammY gibt node-fetch-Optionen mit (agent, compress), die hier entfernt werden, und Signale aus einem Polyfill. Netzwerkfehler wiederholt grammY
 * still; deshalb werden sie hier protokolliert (ohne URL, sie enthält den Token).
 */
export function telegramFetch(fetchFn: typeof globalThis.fetch) {
  return async (url: string | URL, init?: RequestInit & { agent?: unknown; compress?: unknown }) => {
    const { agent: _agent, compress: _compress, signal, ...rest } = init ?? {};
    try {
      return await fetchFn(url, { ...rest, ...(signal ? { signal: nativeSignal(signal) } : {}) });
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        log("warn", "Telegram nicht erreichbar, neuer Versuch folgt", { error: describeFetchError(err) });
      }
      throw err;
    }
  };
}

/** Befehlsmenü in Telegram (setMyCommands). */
export const BOT_COMMANDS = [
  { command: "leads", description: "Beste Leads mit Buttons" },
  { command: "lead", description: "Lead-Karte öffnen, z. B. /lead Ariadne" },
  { command: "pipeline", description: "Vertrieb und offene Erinnerungen" },
  { command: "abdeckung", description: "Wie vollständig sind die Regionen?" },
  { command: "status", description: "Stand der Suchen" },
  { command: "kosten", description: "Ausgaben und Budget" },
  { command: "kalibrieren", description: "Firmen mit A/B/C bewerten" },
  { command: "hilfe", description: "Was ich kann" },
];

export function createBot(options: BotOptions): Bot {
  const bot = new Bot(options.token, {
    ...(options.botInfo ? { botInfo: options.botInfo } : {}),
    client: { fetch: telegramFetch(options.fetch ?? globalThis.fetch) as never },
  });
  const { ctx: pipeline } = options.manager;
  const tool = (name: string, input: unknown, chatId: number) =>
    runTool(name, input, { ctx: pipeline, chatId });

  // Allowlist (Kriterium 9): fremde Chats bekommen keine Antwort, werden aber protokolliert.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !options.allowedChatIds.includes(chatId)) {
      log("warn", "Nachricht aus fremdem Chat ignoriert", {
        chat_id: chatId ?? null,
        from: ctx.from?.username ?? null,
      });
      return;
    }
    await next();
  });

  bot.command(["start", "hilfe", "help"], (ctx) => ctx.reply(HELP_TEXT));

  bot.command(["status", "stats"], async (ctx) => {
    await replyLong(ctx, (await tool("stats", {}, ctx.chat.id)).text);
  });
  bot.command(["kosten", "costs"], async (ctx) => {
    await replyLong(ctx, (await tool("costs", {}, ctx.chat.id)).text);
  });
  bot.command(["fehler", "failed"], async (ctx) => {
    await replyLong(ctx, (await tool("failed_leads", {}, ctx.chat.id)).text);
  });
  bot.command("budget", async (ctx) => {
    const m = /^\+?\s*(\d+(?:[.,]\d+)?)$/.exec(ctx.match.trim());
    if (!m) {
      await replyLong(
        ctx,
        `${(await tool("costs", { tage: 1 }, ctx.chat.id)).text}\n\nMehr Budget für heute: /budget +5`,
      );
      return;
    }
    const usd = Number(m[1]!.replace(",", "."));
    if (!(usd > 0 && usd <= 50)) {
      await ctx.reply("Bitte einen Betrag zwischen 0 und 50 $ angeben, z. B. /budget +5");
      return;
    }
    const extra = await raiseBudgetToday(pipeline.db, pipeline.now(), usd);
    const released = await releaseBudgetDeferredJobs(pipeline);
    log("info", "Budget erhöht", { usd, extra_today: extra, released });
    await ctx.reply(
      `Okay, heute ${extra.toFixed(2).replace(".", ",")} $ zusätzlich freigegeben.${released > 0 ? ` ${released} wartende Jobs laufen jetzt weiter.` : ""}`,
    );
  });

  // Kalibrierung (ARCHITECTURE.md 7.4): eine Firma nach der anderen mit A/B/C bewerten, ohne den Score zu sehen.
  const sendRatingCard = async (ctx: Context) => {
    const card = await nextRatingCard(pipeline.db);
    if (!card) {
      await ctx.reply(
        "Keine unbewertete Firma mit Score mehr. Neue Firmen kommen mit der nächsten Suche dazu. Auswertung: /auswertung",
      );
      return;
    }
    const branch = card.company.branch_key ? pipeline.lead.branches[card.company.branch_key] : undefined;
    const { text, keyboard } = ratingCardMessage(card, branch?.label ?? null);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
  };

  bot.command(["abdeckung", "coverage"], async (ctx) => {
    const region = ctx.match.trim().split(/\s+/)[0] || undefined;
    await replyLong(ctx, (await tool("coverage", region ? { region } : {}, ctx.chat.id)).text);
  });

  bot.command(["kalibrieren", "bewerten"], sendRatingCard);
  bot.command(["auswertung", "kalibrierung"], async (ctx) => {
    const entries = await loadGoldenEntries({ ...pipeline.lead, db: pipeline.db, now: pipeline.now });
    if (entries.length === 0) {
      await ctx.reply("Noch keine Firma bewertet. Los geht's mit /kalibrieren");
      return;
    }
    const report = evaluateGoldenSet(entries, pipeline.lead.scoring);
    await replyLong(ctx, formatCalibrationReport(report, pipeline.lead.scoring.version));
  });

  // Mini-CRM (Phase 2): Karte mit Status-Buttons, Erinnerungen, Überblick.
  const crmConfig = () => pipeline.crm ?? loadCrmConfig();
  const crmCard = async (company: Company) => {
    const fresh = (await findCompany(pipeline.db, company.id)) ?? company;
    return leadCrmCard(
      fresh,
      await companyHistory(pipeline.db, company.id, 6),
      await openReminders(pipeline.db, company.id),
    );
  };
  const by = (chatId: number | undefined) => `telegram:${chatId ?? "?"}`;

  bot.command("pipeline", async (ctx) => {
    await replyLong(ctx, pipelineMessage(await salesPipeline(pipeline.db), await openReminders(pipeline.db)));
  });

  const sendCard = async (ctx: Context, company: Company) => {
    const card = await crmCard(company);
    await ctx.reply(card.text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: card.keyboard },
    });
  };

  // Karte eines Leads per Name, Domain oder Kurz-ID: /lead Ariadne
  bot.command(["lead", "kontakt"], async (ctx) => {
    const ref = ctx.match.trim();
    if (!ref) {
      await ctx.reply("Welcher Lead? Zum Beispiel: /lead Ariadne (oder /leads für die besten mit Buttons)");
      return;
    }
    const found = await findLead(pipeline.db, ref);
    if (found.kind === "found") await sendCard(ctx, found.company);
    else if (found.kind === "none") await ctx.reply(`Keinen Lead gefunden für „${ref}“.`);
    else
      await ctx.reply("Mehrere Treffer, welcher ist gemeint?", {
        reply_markup: { inline_keyboard: leadButtons(found.candidates) },
      });
  });

  // Die besten Leads (qualifiziert oder im Vertrieb) mit je einem Button zur Karte.
  bot.command(["leads", "top"], async (ctx) => {
    const { rows } = await pipeline.db.query<Company>(
      `select * from companies
        where status in ('QUALIFIED', 'READY_FOR_CONTACT', 'CONTACTED', 'REPLIED', 'INTERESTED', 'PROTOTYPE')
        order by current_score desc nulls last limit 10`,
    );
    if (rows.length === 0) {
      await ctx.reply("Noch keine qualifizierten Leads.");
      return;
    }
    await ctx.reply(topLeadsText(rows), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: leadButtons(rows) },
    });
  });

  bot.on("callback_query:data", async (ctx) => {
    const crm = parseCrmCallback(ctx.callbackQuery.data);
    if (crm) {
      const now = pipeline.now();
      if (crm.kind === "done" || crm.kind === "snooze") {
        const r =
          crm.kind === "done"
            ? await completeReminder(pipeline.db, crm.interactionId, now)
            : await snoozeReminder(pipeline.db, crm.interactionId, 2, now);
        await ctx.answerCallbackQuery({
          text: !r ? "Erinnerung nicht gefunden" : crm.kind === "done" ? "Erledigt" : "In 2 Tagen wieder",
        });
        if (r)
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
        return;
      }
      const company = await findCompany(pipeline.db, crm.companyId);
      if (!company) {
        await ctx.answerCallbackQuery({ text: "Lead nicht gefunden" });
        return;
      }
      if (crm.kind === "email") {
        if (!options.outreach) {
          await ctx.answerCallbackQuery({ text: "Entwürfe sind noch nicht eingerichtet", show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({ text: "Schreibe Entwurf …" });
        await ctx.replyWithChatAction("typing").catch(() => undefined);
        const draft = await draftEmail(
          {
            db: pipeline.db,
            llm: options.manager.llm,
            outreach: options.outreach.config,
            branches: pipeline.lead.branches,
            now: pipeline.now,
            contact: options.outreach.contact,
          },
          company,
          by(ctx.chat?.id),
        ).catch((err: unknown) => {
          log("error", "Entwurf fehlgeschlagen", { error: err instanceof Error ? err.message : String(err) });
          return null;
        });
        if (!draft) {
          await ctx.reply("Der Entwurf hat gerade nicht geklappt. Versuch es bitte gleich noch einmal.");
          return;
        }
        if ("kind" in draft) {
          await ctx.reply(`${company.name} ist noch nicht auditiert, dafür fehlt mir der Befund.`);
          return;
        }
        const parts = (mailto: string | null) => emailDraftMessages(company, draft, mailto);
        await ctx.reply(parts(null).info, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        const sendBody = (mailto: string | null) => {
          const m = parts(mailto);
          return ctx.reply(m.body, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: m.keyboard },
          });
        };
        // mailto-Links akzeptiert nicht jede Telegram-Version; dann ohne Link senden.
        await sendBody(mailtoLink(draft.to, draft.subject, draft.body)).catch(() => sendBody(null));
        return;
      }
      if (crm.kind === "letter") {
        if (!options.outreach) {
          await ctx.answerCallbackQuery({ text: "Entwürfe sind noch nicht eingerichtet", show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({ text: "Erstelle Befund-Seite, dauert etwa 30 Sekunden …" });
        await ctx.replyWithChatAction("upload_document").catch(() => undefined);
        const crawl = pipeline.crawl.config;
        const letter = await draftLetter(
          {
            db: pipeline.db,
            llm: options.manager.llm,
            outreach: options.outreach.config,
            branches: pipeline.lead.branches,
            now: pipeline.now,
            contact: options.outreach.contact,
            render: options.outreach.renderLetter ?? chromiumLetterRenderer(process.env.CHROMIUM_PATH),
            desktopScreenPx: crawl.desktop.height * crawl.desktop.scale,
          },
          company,
          by(ctx.chat?.id),
        ).catch((err: unknown) => {
          log("error", "Befund-Seite fehlgeschlagen", {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
        if (!letter) {
          await ctx.reply("Die Befund-Seite hat gerade nicht geklappt. Versuch es bitte gleich noch einmal.");
          return;
        }
        if ("kind" in letter) {
          await ctx.reply(
            letter.kind === "no_audit"
              ? `${company.name} ist noch nicht auditiert, dafür fehlt mir der Befund.`
              : `Für ${company.name} gibt es keinen Screenshot der Website. Erst neu crawlen, dann noch einmal.`,
          );
          return;
        }
        const m = letterMessages(company, letter);
        await ctx.replyWithPhoto(new InputFile(letter.png, "vorschau.png"), {
          caption: m.caption,
          parse_mode: "HTML",
        });
        await ctx.replyWithDocument(new InputFile(letter.pdf, letter.filename), {
          caption: m.pdfCaption,
          reply_markup: { inline_keyboard: m.keyboard },
        });
        return;
      }
      if (crm.kind === "status") {
        const { reminder } = await setSalesStatus(pipeline.db, company.id, crm.status, {
          by: by(ctx.chat?.id),
          now,
          followUpDays: crmConfig().follow_up_days,
        });
        await ctx.answerCallbackQuery({
          text: `Vermerkt: ${SALES_LABELS[crm.status]} (es wurde nichts verschickt)${reminder ? ` · Nachfassen in ${crmConfig().follow_up_days} Tagen` : ""}`,
        });
      } else if (crm.kind === "remind") {
        await addReminder(pipeline.db, company.id, {
          dueAt: new Date(now.getTime() + crm.days * 86_400_000),
          text: "Melden",
          by: by(ctx.chat?.id),
          now,
        });
        await ctx.answerCallbackQuery({ text: `Erinnerung in ${crm.days} Tagen` });
      }
      const card = await crmCard(company);
      await ctx
        .editMessageText(card.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: card.keyboard } })
        .catch(() => undefined);
      return;
    }

    const graded = parseGradeCallback(ctx.callbackQuery.data);
    if (graded) {
      const company = await findCompany(pipeline.db, graded.companyId);
      if (!company) {
        await ctx.answerCallbackQuery({ text: "Firma nicht gefunden" });
        return;
      }
      await setRating(pipeline.db, {
        companyId: company.id,
        grade: graded.grade,
        chatId: ctx.chat?.id ?? null,
      });
      const label = graded.grade === "X" ? "übersprungen" : graded.grade;
      await ctx.answerCallbackQuery({ text: `${label} gespeichert` });
      await ctx.editMessageText(`${company.name}: ${label}`).catch(() => undefined);
      await sendRatingCard(ctx);
      return;
    }
    const cb = parseCallback(ctx.callbackQuery.data);
    const chatId = ctx.chat?.id;
    if (!cb || chatId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const company = await findCompany(pipeline.db, cb.companyId);
    if (!company) {
      await ctx.answerCallbackQuery({ text: "Lead nicht gefunden" });
      return;
    }
    switch (cb.action) {
      case "d":
        await ctx.answerCallbackQuery();
        await replyLong(ctx, await explainStoredLead(pipeline.db, company));
        return;
      case "s":
        await ctx.answerCallbackQuery();
        await ctx.reply(`${company.name} wirklich aussortieren?`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Ja, aussortieren", callback_data: callbackData("sy", company.id) },
                { text: "Nein", callback_data: callbackData("sn", company.id) },
              ],
            ],
          },
        });
        return;
      case "sy": {
        const r = await tool("skip_lead", { lead: company.id, grund: "per Button in Telegram" }, chatId);
        await ctx.answerCallbackQuery({ text: "Aussortiert" });
        await ctx.editMessageText(r.text).catch(() => ctx.reply(r.text));
        return;
      }
      case "sn":
        await ctx.answerCallbackQuery({ text: "Bleibt drin" });
        await ctx.editMessageText(`${company.name} bleibt in der Liste.`).catch(() => undefined);
        return;
      case "c":
        await ctx.answerCallbackQuery();
        await sendCard(ctx, company);
        return;
      case "p":
        await ctx.answerCallbackQuery({ text: "Prototypen kommen in Phase 3", show_alert: true });
        return;
    }
  });

  bot.on("message:text", async (ctx) => {
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const reply = await askManager(options.manager, ctx.chat.id, ctx.message.text);
    await replyFormatted(ctx, reply.text);
  });

  bot.catch((err) => {
    log("error", "Telegram-Fehler", {
      error: err.error instanceof Error ? err.error.message : String(err.error),
    });
    void err.ctx.reply("Da ist etwas schiefgegangen. Versuch es bitte noch einmal.").catch(() => undefined);
  });

  return bot;
}
