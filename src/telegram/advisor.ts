import type { InlineKeyboardButton } from "grammy/types";
import type { AdvisorReport, AdvisorSuggestion, SuggestionStatus } from "../advisor/run.js";
import { escapeHtml } from "./format.js";

/**
 * Berater-Runde in Telegram: Kopf mit Lage, danach je Vorschlag eine Karte mit Knöpfen. Alle Texte kommen vom LLM
 * (teils aus fremder Recherche) und werden escaped; Quellen nur als https-Links.
 */

const AREA = { prozess: "🔧 Prozess", wachstum: "📈 Wachstum" } as const;
const EFFORT = { klein: "klein", mittel: "mittel", gross: "groß" } as const;

const eur = (usd: number) => `${(usd * 0.92).toFixed(2).replace(".", ",")} €`;

export function advisorHeader(r: AdvisorReport): string {
  const lines = [
    `🧠 <b>Berater-Runde${r.trigger === "woche" ? " der Woche" : ""}</b>`,
    "",
    escapeHtml(r.lage),
  ];
  if (r.rueckblick) lines.push("", `🔁 <b>Rückblick:</b> ${escapeHtml(r.rueckblick)}`);
  lines.push("", `🧐 <b>Gegenprüfer:</b> ${escapeHtml(r.fazit)}`);
  const n = r.suggestions.length;
  lines.push(
    "",
    n === 0
      ? "Diesmal hat kein Vorschlag die Gegenprüfung überstanden. Heißt: weiter so und Daten sammeln 👍"
      : `${n === 1 ? "1 Vorschlag folgt" : `${n} Vorschläge folgen`}${r.dropped > 0 ? ` (${r.dropped} hat der Gegenprüfer aussortiert)` : ""}. Du entscheidest per Knopf, nichts ändert sich von selbst.`,
    `<i>${r.searches} Websuchen, Kosten ca. ${eur(r.costUsd)}</i>`,
  );
  return lines.join("\n");
}

const safeUrl = (u: string) => (/^https:\/\/[^\s"<>]+$/i.test(u) ? u : null);

export function suggestionCard(s: AdvisorSuggestion): { text: string; keyboard: InlineKeyboardButton[][] } {
  const links = s.sources
    .map(safeUrl)
    .filter((u): u is string => u !== null)
    .map((u, i) => `<a href="${escapeHtml(u)}">${i + 1}</a>`);
  const text = [
    `${AREA[s.area]} · Sicherheit: ${s.confidence} · Aufwand: ${EFFORT[s.effort]}`,
    `<b>${escapeHtml(s.title)}</b>`,
    "",
    `👀 ${escapeHtml(s.observation)}`,
    `📊 <b>Beleg:</b> ${escapeHtml(s.evidence)}`,
    `💡 <b>Vorschlag:</b> ${escapeHtml(s.proposal)}`,
    `🎯 <b>Wirkung:</b> ${escapeHtml(s.impact)}`,
    `⚠️ <b>Risiko:</b> ${escapeHtml(s.risk)}`,
    ...(s.critique ? [`🧐 <b>Gegenprüfer:</b> ${escapeHtml(s.critique)}`] : []),
    ...(links.length > 0 ? [`🔗 Quellen: ${links.join(" · ")}`] : []),
  ].join("\n");
  return { text, keyboard: decisionKeyboard(s.id, s.status) };
}

const CODES: Record<SuggestionStatus, string> = {
  umsetzen: "u",
  verworfen: "v",
  spaeter: "s",
  erledigt: "e",
};

export function advisorCallback(status: SuggestionStatus, id: string): string {
  return `av:${CODES[status]}:${id}`;
}

export function parseAdvisorCallback(data: string): { status: SuggestionStatus; id: string } | null {
  const m = /^av:([uvse]):([0-9a-f-]{36})$/.exec(data);
  if (!m) return null;
  const status = (Object.keys(CODES) as SuggestionStatus[]).find((k) => CODES[k] === m[1])!;
  return { status, id: m[2]! };
}

export function decisionKeyboard(id: string, status: string): InlineKeyboardButton[][] {
  if (status === "umsetzen")
    return [[{ text: "✅ Ist umgesetzt", callback_data: advisorCallback("erledigt", id) }]];
  if (status === "offen" || status === "spaeter")
    return [
      [
        { text: "👍 Umsetzen", callback_data: advisorCallback("umsetzen", id) },
        { text: "👎 Verwerfen", callback_data: advisorCallback("verworfen", id) },
      ],
      ...(status === "offen" ? [[{ text: "💬 Später", callback_data: advisorCallback("spaeter", id) }]] : []),
    ];
  return [];
}

export const DECISION_TEXT: Record<SuggestionStatus, string> = {
  umsetzen: "👍 Notiert. Bring ihn in die nächste Session mit Claude Code mit (/vorschlaege zeigt alle).",
  verworfen: "👎 Verworfen. Kommt nicht wieder, außer es gibt neue Belege.",
  spaeter: "💬 Liegt auf später, steht in /vorschlaege.",
  erledigt: "✅ Als umgesetzt vermerkt. Die Berater prüfen in den nächsten Runden, ob es etwas bringt.",
};

/** Übersicht für /vorschlaege: was umgesetzt werden soll und was auf später liegt. */
export function suggestionList(list: readonly AdvisorSuggestion[]): string {
  if (list.length === 0) return "Gerade liegt nichts an. Mit /berater startest du eine neue Runde.";
  const group = (status: string, title: string) => {
    const items = list.filter((s) => s.status === status);
    if (items.length === 0) return [];
    return [
      `<b>${title}</b>`,
      ...items.map(
        (s) => `• ${AREA[s.area].split(" ")[0]} <b>${escapeHtml(s.title)}</b>: ${escapeHtml(s.proposal)}`,
      ),
      "",
    ];
  };
  return [...group("umsetzen", "👍 Umsetzen"), ...group("spaeter", "💬 Später")].join("\n").trim();
}
