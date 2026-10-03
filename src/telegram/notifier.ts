import type { Api } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { SearchRun } from "../db/searchRuns.js";
import type { Notifier, RunSummary } from "../queue/notifier.js";
import type { Db } from "../db/client.js";
import {
  eveningSummaryText,
  escapeHtml,
  mailEventMessage,
  reminderMessage,
  runCompletedMessage,
} from "./format.js";
import { sendPlanHeader } from "./plan.js";

/**
 * Meldungen per Telegram. Ziel: der Chat, aus dem die Suche kam (`requested_by = telegram:<id>`), sonst alle
 * erlaubten Chats (z. B. Suchen aus der CLI, Budget-Meldungen).
 */
export function telegramNotifier(
  api: Api,
  allowedChatIds: readonly number[],
  opts: { db?: Db; morning?: (date: string, nightReport: string[]) => Promise<void> } = {},
): Notifier {
  const targets = (run?: SearchRun): number[] => {
    const m = run ? /^telegram:(-?\d+)$/.exec(run.requested_by) : null;
    const id = m ? Number(m[1]) : null;
    return id !== null && allowedChatIds.includes(id) ? [id] : [...allowedChatIds];
  };
  const sendAll = async (ids: number[], text: string, keyboard?: InlineKeyboardButton[][]) => {
    for (const id of ids) {
      await api.sendMessage(id, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(keyboard && keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    }
  };
  return {
    async runCompleted(summary: RunSummary) {
      // Nachtsuchen des Autopiloten stehen gesammelt im Morgen-Paket, nicht als Einzelmeldung in der Nacht.
      if (summary.run.requested_by === "autopilot") return;
      const { text, keyboard } = runCompletedMessage(summary);
      await sendAll(targets(summary.run), text, keyboard);
    },
    async runFailed(run, error) {
      const q = run.query as { term?: string; region?: string };
      await sendAll(
        targets(run),
        `⚠️ Suche „${escapeHtml(q.term ?? "?")}“ in ${escapeHtml(q.region ?? "?")} ist fehlgeschlagen:\n${escapeHtml(error.slice(0, 500))}`,
      );
    },
    async budgetExceeded(message) {
      await sendAll(
        targets(),
        `⚠️ ${escapeHtml(message)}\nMit /budget +5 gebe ich für heute 5 $ mehr frei und mache sofort weiter.`,
      );
    },
    async remindersDue(reminders) {
      for (const r of reminders) {
        const { text, keyboard } = reminderMessage(r);
        await sendAll(targets(), text, keyboard);
      }
    },
    async planReady(date, result, nightReport = []) {
      if (opts.morning) await opts.morning(date, nightReport);
      else if (opts.db) await sendPlanHeader(api, opts.db, targets(), date, nightReport);
      if (result.stoppedByBudget)
        await sendAll(
          targets(),
          "⚠️ Das Tagesbudget hat nicht für alle Kontakte gereicht. Mit /budget +5 und /heute geht es weiter.",
        );
    },
    async eveningSummary(s) {
      await sendAll(targets(), eveningSummaryText(s));
    },
    async mailEvent(e) {
      const { text, keyboard } = mailEventMessage(e);
      await sendAll(targets(), text, keyboard);
    },
  };
}
