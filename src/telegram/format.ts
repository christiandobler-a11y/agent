import type { InlineKeyboardButton } from "grammy/types";
import type { Grade } from "../db/calibration.js";
import type { RatingCard } from "../pipeline/calibration.js";
import type { RunSummary } from "../queue/notifier.js";

/** Texte und Buttons für Telegram (HTML-Modus). Alles Fremde wird escaped. */

export const TELEGRAM_MAX = 4000; // Telegram erlaubt 4096 Zeichen

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Antwort des Managers (leichtes Markdown) → Telegram-HTML: erst alles escapen, dann nur **fett** und `code`
 * zulassen. So kann weder das Modell noch ein Firmenname kaputtes oder fremdes Markup einschleusen.
 */
export function markdownToTelegramHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`\n]+?)`/g, "<code>$1</code>")
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
}

/** Lange Texte an Zeilengrenzen in Telegram-taugliche Stücke teilen. */
export function chunk(text: string, max = TELEGRAM_MAX): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > max && current) {
      parts.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + (line.length > max ? line.slice(0, max) : line);
  }
  if (current) parts.push(current);
  return parts;
}

/** callback_data (max. 64 Byte): Aktion + volle Firmen-ID. */
export type LeadAction = "d" | "s" | "sy" | "sn" | "c" | "p";
export const callbackData = (action: LeadAction, companyId: string) => `${action}:${companyId}`;

export function parseCallback(data: string): { action: LeadAction; companyId: string } | null {
  const m = /^(d|s|sy|sn|c|p):([0-9a-f-]{36})$/.exec(data);
  return m ? { action: m[1] as LeadAction, companyId: m[2]! } : null;
}

/** Kalibrier-Buttons: Note + Firmen-ID (z. B. "gA:<uuid>"). */
export const gradeCallback = (grade: Grade, companyId: string) => `g${grade}:${companyId}`;

export function parseGradeCallback(data: string): { grade: Grade; companyId: string } | null {
  const m = /^g([ABCX]):([0-9a-f-]{36})$/.exec(data);
  return m ? { grade: m[1] as Grade, companyId: m[2]! } : null;
}

const decimal = (n: number) => n.toFixed(1).replace(".", ",");

/** Karte zum Bewerten: bewusst ohne Score, damit das Bauchgefühl unbeeinflusst bleibt. */
export function ratingCardMessage(
  card: RatingCard,
  branchLabel: string | null,
): { text: string; keyboard: InlineKeyboardButton[][] } {
  const { company: c, places: p, counts } = card;
  const rated = counts.A + counts.B + counts.C;
  const where = [branchLabel ?? c.category, c.city].filter(Boolean).join(" · ");
  const google =
    p?.rating != null
      ? `Google: ${decimal(p.rating)}★ (${p.review_count ?? 0} Bewertungen)`
      : "Google: keine Bewertung";
  const lines = [
    `<i>Kalibrierung · ${rated} bewertet (A ${counts.A} · B ${counts.B} · C ${counts.C})</i>`,
    "",
    `<b>${escapeHtml(c.name)}</b>`,
    ...(where ? [escapeHtml(where)] : []),
    google,
    c.website_url ? escapeHtml(c.website_url) : "keine Website",
    "",
    "Würdest du die Firma als Kunden ansprechen?",
    "A = ja, sofort · B = vielleicht · C = eher nicht",
  ];
  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: "A", callback_data: gradeCallback("A", c.id) },
        { text: "B", callback_data: gradeCallback("B", c.id) },
        { text: "C", callback_data: gradeCallback("C", c.id) },
        { text: "Weiß nicht", callback_data: gradeCallback("X", c.id) },
      ],
    ],
  };
}

const STATUS_LABEL: Record<string, string> = {
  QUALIFIED: "qualifiziert",
  SKIPPED: "aussortiert",
  FAILED: "fehlgeschlagen",
};

export function runCompletedMessage(s: RunSummary): { text: string; keyboard: InlineKeyboardButton[][] } {
  const q = s.run.query as { term?: string; region?: string };
  const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
  const counts = Object.entries(s.counts)
    .map(([k, v]) => `${v} ${STATUS_LABEL[k] ?? k}`)
    .join(", ");
  const lines = [
    `<b>Suche fertig: ${escapeHtml(q.term ?? "?")} in ${escapeHtml(q.region ?? "?")}</b>`,
    `${total} Firmen geprüft: ${escapeHtml(counts || "keine")} · Kosten ${s.costUsd.toFixed(2).replace(".", ",")} $`,
  ];
  if (s.coverage) lines.push(`Abdeckung: ${escapeHtml(s.coverage)}`);
  if (s.topLeads.length === 0) lines.push("", "Diesmal kein qualifizierter Lead.");
  const keyboard: InlineKeyboardButton[][] = [];
  s.topLeads.forEach((l, i) => {
    const n = i + 1;
    const noSite = l.segment === "NO_WEBSITE" ? " · ohne Website" : "";
    lines.push(
      "",
      `<b>${n}. ${escapeHtml(l.name)}</b> (${escapeHtml(l.city ?? "?")}) – <b>${l.score}</b>/100${noSite}`,
    );
    if (l.mainOpportunity) lines.push(escapeHtml(l.mainOpportunity));
    keyboard.push([
      { text: `${n} Details`, callback_data: callbackData("d", l.companyId) },
      { text: `${n} Skip`, callback_data: callbackData("s", l.companyId) },
      { text: `${n} Kontakt`, callback_data: callbackData("c", l.companyId) },
      { text: `${n} Prototyp`, callback_data: callbackData("p", l.companyId) },
    ]);
  });
  return { text: lines.join("\n"), keyboard };
}

export const HELP_TEXT = [
  "Hallo Christian! Schreib mir einfach, z. B.:",
  "• Such mir 20 Fahrradläden im Landkreis Rosenheim",
  "• Zeig mir die besten Leads",
  "• Warum hat Radl Meier 72 Punkte?",
  "• Was hat das diese Woche gekostet?",
  "• Such alle Hotels in Rosenheim (komplett, bis die Region vollständig ist)",
  "• Ist Rosenheim durch?",
  "",
  "Schnellbefehle: /status · /abdeckung · /kosten · /fehler · /budget (z. B. /budget +5)",
  "Kalibrierung: /kalibrieren (Firmen mit A/B/C bewerten) · /auswertung",
].join("\n");
