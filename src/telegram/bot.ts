import { Bot, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { setRating } from "../db/calibration.js";
import { findCompany } from "../db/companies.js";
import { raiseBudgetToday } from "../llm/budget.js";
import { askManager, type ManagerDeps } from "../manager/agent.js";
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
  parseCallback,
  parseGradeCallback,
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

  bot.on("callback_query:data", async (ctx) => {
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
        await ctx.answerCallbackQuery({ text: "Kontakt-Vorbereitung kommt in Phase 2", show_alert: true });
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
