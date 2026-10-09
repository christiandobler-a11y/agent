import { terminShort } from "../outreach/confirm.js";
import type { EveningSummary } from "../autopilot/schedule.js";
import type { MailEvent } from "../queue/notifier.js";
import type { InlineKeyboardButton } from "grammy/types";
import type { Grade } from "../db/calibration.js";
import type { RatingCard } from "../pipeline/calibration.js";
import type { Company } from "../db/companies.js";
import type { Interaction } from "../db/crm.js";
import {
  isSalesStatus,
  SALES_CODES,
  SALES_EMOJI,
  SALES_LABELS,
  SALES_STATUSES,
  salesStatusFromCode,
  type SalesStatus,
} from "../crm/status.js";
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

/** Vorbild-Knopf auf der Kalibrier-Karte ("iv:<uuid>"). */
export const inspoCallback = (companyId: string) => `iv:${companyId}`;

export function parseInspoCallback(data: string): { companyId: string } | null {
  const m = /^iv:([0-9a-f-]{36})$/.exec(data);
  return m ? { companyId: m[1]! } : null;
}

/** Gemerkte Vorbild-Websites mit Christians Notiz. */
export function designNotesMessage(
  notes: readonly { name: string; url: string | null; note: string; created_at: Date }[],
  branch: string | null,
): string {
  if (notes.length === 0)
    return `Noch keine Vorbilder${branch ? ` für ${escapeHtml(branch)}` : ""}. Beim /kalibrieren auf „💡 Als Vorbild merken“ tippen.`;
  const lines = [`<b>Vorbilder${branch ? ` · ${escapeHtml(branch)}` : ""} (${notes.length})</b>`];
  for (const n of notes)
    lines.push(
      "",
      `<b>${escapeHtml(n.name)}</b> · ${n.created_at.toISOString().slice(0, 10)}`,
      ...(n.url ? [escapeHtml(n.url)] : []),
      escapeHtml(n.note),
    );
  return lines.join("\n");
}

const decimal = (n: number) => n.toFixed(1).replace(".", ",");

/**
 * Knopf zur jetzigen Website eines Betriebs (Christian, 04.10.2026: bei jeder Praxis gleich anklickbar). `null` bei
 * fehlender oder ungültiger Adresse, denn Telegram lehnt die ganze Nachricht ab, wenn ein Knopf-Link nicht passt.
 */
export function websiteButton(
  url: string | null | undefined,
  text = "🌐 Jetzige Website",
): InlineKeyboardButton | null {
  const raw = url?.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes(".")) return null;
    return { text, url: u.href };
  } catch {
    return null;
  }
}

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
    ...(c.website_url ? ["Gefällt dir die Seite selbst? 💡 merken, dann lernt der Prototyp davon."] : []),
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
      ...(c.website_url
        ? [
            [
              ...[websiteButton(c.website_url, "🌐 Website ansehen")].filter((b) => b !== null),
              { text: "💡 Als Vorbild merken", callback_data: inspoCallback(c.id) },
            ],
          ]
        : []),
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
  "• Notiz zu Radl Sepp: hat zurückgerufen, will Angebot",
  "• Erinner mich Freitag an Hotel Ariadne",
  "",
  "Leads öffnen: /leads (Top 10 mit Buttons) · /lead Name (z. B. /lead Ariadne)",
  "Schnellbefehle: /heute · /nachlegen · /zahlen · /probelauf (/probelauf3) · /level · /status · /pipeline · /abdeckung · /kosten · /fehler · /budget (z. B. /budget +5)",
  "Kalibrierung: /kalibrieren (Firmen mit A/B/C bewerten, 💡 Vorbild merken) · /vorbilder · /auswertung",
  "Laden der Woche: /laden (sonst montags von selbst, mit Design-Briefing und drei Richtungen)",
  "Sales-Trainer: /training (ein Inhaber mit Einwand, du antwortest, am Ende Bewertung und XP) · /training liste · /haeppchen (Sales-Tipp sofort; sonst meldet sich der Trainer morgens, mittags und abends von selbst)",
  "Berater: /berater (Runde jetzt starten, sonst sonntags von selbst) · /vorschlaege (was umgesetzt werden soll) · /fundstueck (was Lustiges oder Spannendes aus dem Netz, sonst dienstags und donnerstags)",
].join("\n");

// ---------------------------------------------------------------------------------------------------------------
// Mini-CRM (Phase 2)

export type CrmCallback =
  | { kind: "status"; status: SalesStatus; companyId: string }
  | { kind: "email"; companyId: string }
  | { kind: "letter"; companyId: string }
  | { kind: "prototype"; companyId: string }
  | { kind: "offer"; paket: "onepager" | "mehrseitig"; companyId: string }
  | { kind: "remind"; days: number; companyId: string }
  | { kind: "done"; interactionId: string }
  | { kind: "snooze"; interactionId: string };

const UUID = "[0-9a-f-]{36}";

export function crmCallback(c: CrmCallback): string {
  switch (c.kind) {
    case "status":
      return `ss:${SALES_CODES[c.status]}:${c.companyId}`;
    case "email":
      return `dm:${c.companyId}`;
    case "letter":
      return `bl:${c.companyId}`;
    case "prototype":
      return `pt:${c.companyId}`;
    case "offer":
      return `ao:${c.paket === "onepager" ? "o" : "m"}:${c.companyId}`;
    case "remind":
      return `sr:${c.days}:${c.companyId}`;
    case "done":
      return `rd:${c.interactionId}`;
    case "snooze":
      return `rz:${c.interactionId}`;
  }
}

export function parseCrmCallback(data: string): CrmCallback | null {
  let m = new RegExp(`^ss:([a-z]):(${UUID})$`).exec(data);
  if (m) {
    const status = salesStatusFromCode(m[1]!);
    return status ? { kind: "status", status, companyId: m[2]! } : null;
  }
  m = new RegExp(`^dm:(${UUID})$`).exec(data);
  if (m) return { kind: "email", companyId: m[1]! };
  m = new RegExp(`^bl:(${UUID})$`).exec(data);
  if (m) return { kind: "letter", companyId: m[1]! };
  m = new RegExp(`^pt:(${UUID})$`).exec(data);
  if (m) return { kind: "prototype", companyId: m[1]! };
  m = new RegExp(`^ao:([om]):(${UUID})$`).exec(data);
  if (m) return { kind: "offer", paket: m[1] === "o" ? "onepager" : "mehrseitig", companyId: m[2]! };
  m = new RegExp(`^sr:(\\d{1,2}):(${UUID})$`).exec(data);
  if (m) return { kind: "remind", days: Number(m[1]), companyId: m[2]! };
  m = new RegExp(`^r([dz]):(${UUID})$`).exec(data);
  if (m)
    return m[1] === "d" ? { kind: "done", interactionId: m[2]! } : { kind: "snooze", interactionId: m[2]! };
  return null;
}

const shortDate = (d: Date) =>
  d.toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });

function historyLine(i: Interaction): string {
  const when = shortDate(i.created_at);
  if (i.type === "status" && i.to_status && isSalesStatus(i.to_status))
    return `${when}: ${SALES_EMOJI[i.to_status]} ${SALES_LABELS[i.to_status]}${i.body ? ` – ${i.body}` : ""}`;
  if (i.type === "note") return `${when}: 📝 ${i.body ?? ""}`;
  if (i.type === "reminder")
    return `${when}: ⏰ ${i.body ?? "Erinnerung"} (fällig ${i.due_at ? shortDate(i.due_at) : "?"}${i.done_at ? ", erledigt" : ""})`;
  return `${when}: ${i.type}`;
}

/** CRM-Karte eines Leads: Status, letzte Einträge, offene Erinnerung und Status-Buttons. */
export function leadCrmCard(
  c: Company,
  history: Interaction[],
  open: Interaction[],
): { text: string; keyboard: InlineKeyboardButton[][] } {
  const status = isSalesStatus(c.status)
    ? `${SALES_EMOJI[c.status]} ${SALES_LABELS[c.status]}`
    : `noch nicht im Vertrieb (${c.status})`;
  const lines = [
    `<b>${escapeHtml(c.name)}</b>${c.city ? ` (${escapeHtml(c.city)})` : ""}${c.current_score !== null ? ` – ${c.current_score}/100` : ""}`,
    `Status: ${status}`,
  ];
  if (c.website_url) lines.push(escapeHtml(c.website_url));
  if (c.phone) lines.push(`☎️ ${escapeHtml(c.phone)}`);
  for (const r of open)
    lines.push(`⏰ ${escapeHtml(r.body ?? "Erinnerung")} – fällig ${r.due_at ? shortDate(r.due_at) : "?"}`);
  if (history.length > 0) {
    lines.push("", "<i>Verlauf</i>");
    for (const h of history.slice(0, 6)) lines.push(escapeHtml(historyLine(h)));
  }
  const btn = (s: SalesStatus): InlineKeyboardButton => ({
    text: `${SALES_EMOJI[s]} ${SALES_LABELS[s]}`,
    callback_data: crmCallback({ kind: "status", status: s, companyId: c.id }),
  });
  return {
    text: lines.join("\n"),
    keyboard: [
      [btn("CONTACTED"), btn("REPLIED")],
      [btn("INTERESTED"), btn("PROTOTYPE")],
      [btn("WON"), btn("LOST")],
      [btn("READY_FOR_CONTACT")],
      [
        { text: "✍️ E-Mail-Entwurf", callback_data: crmCallback({ kind: "email", companyId: c.id }) },
        { text: "🖨️ Befund-Seite", callback_data: crmCallback({ kind: "letter", companyId: c.id }) },
      ],
      [
        {
          text: "📄 Angebot Onepager",
          callback_data: crmCallback({ kind: "offer", paket: "onepager", companyId: c.id }),
        },
        {
          text: "📄 Angebot mehrseitig",
          callback_data: crmCallback({ kind: "offer", paket: "mehrseitig", companyId: c.id }),
        },
      ],
      [
        ...[websiteButton(c.website_url)].filter((b) => b !== null),
        { text: "🎨 Prototyp bauen", callback_data: crmCallback({ kind: "prototype", companyId: c.id }) },
      ],
      [
        { text: "⏰ in 3 Tagen", callback_data: crmCallback({ kind: "remind", days: 3, companyId: c.id }) },
        { text: "⏰ in 7 Tagen", callback_data: crmCallback({ kind: "remind", days: 7, companyId: c.id }) },
      ],
    ],
  };
}

/** Fällige Erinnerung mit Buttons Erledigt / +2 Tage / Lead öffnen. */
export function reminderMessage(r: Interaction & { company_name: string }): {
  text: string;
  keyboard: InlineKeyboardButton[][];
} {
  return {
    text: `⏰ <b>${escapeHtml(r.company_name)}</b>: ${escapeHtml(r.body ?? "Erinnerung")}`,
    keyboard: [
      [
        { text: "✅ Erledigt", callback_data: crmCallback({ kind: "done", interactionId: r.id }) },
        { text: "⏰ +2 Tage", callback_data: crmCallback({ kind: "snooze", interactionId: r.id }) },
        { text: "📋 Lead", callback_data: callbackData("c", r.company_id) },
      ],
    ],
  };
}

/** Überblick Vertrieb: Firmen je Status und offene Erinnerungen (für /pipeline). */
export function pipelineMessage(
  companies: Company[],
  reminders: (Interaction & { company_name: string })[],
): string {
  if (companies.length === 0 && reminders.length === 0)
    return "Noch kein Lead im Vertrieb. Tipp: In der Ergebnismeldung auf „Kontakt“ tippen und den Status setzen.";
  const lines: string[] = [];
  for (const s of SALES_STATUSES) {
    const list = companies.filter((c) => c.status === s);
    if (list.length === 0) continue;
    lines.push(
      `${SALES_EMOJI[s]} ${SALES_LABELS[s]} (${list.length}): ${list
        .slice(0, 8)
        .map((c) => c.name)
        .join(", ")}${list.length > 8 ? " …" : ""}`,
    );
  }
  if (reminders.length > 0) {
    lines.push("", "Offene Erinnerungen:");
    for (const r of reminders.slice(0, 10))
      lines.push(`⏰ ${r.due_at ? shortDate(r.due_at) : "?"} ${r.company_name}: ${r.body ?? ""}`);
  }
  return lines.join("\n");
}

/**
 * E-Mail-Entwurf in zwei Nachrichten: erst alle Angaben (Empfänger mit Herkunft, Betreff, Ansprechpartner, Kontakt
 * des Betriebs), dann nur der Text. Antippen kopiert jeweils genau ein Feld bzw. den ganzen Text.
 */
export function emailDraftMessages(
  company: Company,
  d: {
    to: string | null;
    emailSource: "impressum" | "website" | "google" | null;
    contactName: string | null;
    subject: string;
    body: string;
    warnings: string[];
    variant: number;
    draftId?: string;
  },
  mailto: string | null,
  /** Postfach eingerichtet: "Jetzt senden" statt "Gesendet, kontaktiert". */
  canSend = false,
): { info: string; body: string; keyboard: InlineKeyboardButton[][] } {
  const source = {
    impressum: "aus dem Impressum",
    website: "von der Website",
    google: "aus Google",
  } as const;
  const info = [
    `✍️ <b>E-Mail an ${escapeHtml(company.name)}</b>${d.variant > 1 ? ` (Variante ${d.variant})` : ""}`,
    "",
    `<b>An:</b> ${d.to ? `<code>${escapeHtml(d.to)}</code>${d.emailSource ? ` <i>(${source[d.emailSource]})</i>` : ""}` : "keine Adresse gefunden, bitte auf der Website nachsehen"}`,
    `<b>Betreff:</b> <code>${escapeHtml(d.subject)}</code>`,
    `<b>Ansprechpartner:</b> ${d.contactName ? escapeHtml(d.contactName) : "keiner im Impressum, Anrede ans Team"}`,
  ];
  if (company.phone) info.push(`<b>Telefon Betrieb:</b> <code>${escapeHtml(company.phone)}</code>`);
  if (company.website_url) info.push(`<b>Website:</b> ${escapeHtml(company.website_url)}`);
  if (d.warnings.length > 0) info.push("", `⚠️ ${escapeHtml(d.warnings.join(" · "))}`);
  info.push("", "<i>Text kommt in der nächsten Nachricht. Antippen kopiert ihn.</i>");

  const body = [`<pre>${escapeHtml(d.body)}</pre>`];
  if (mailto) body.push(`<a href="${escapeHtml(mailto)}">✉️ In Mail-App öffnen</a>`);
  body.push(
    canSend && d.draftId
      ? "<i>„Jetzt senden“ schickt die Mail über dein Postfach.</i>"
      : "<i>Nach dem Senden auf „Gesendet, kontaktiert“ tippen.</i>",
  );
  return {
    info: info.join("\n"),
    body: body.join("\n"),
    keyboard: [
      [
        canSend && d.draftId
          ? { text: "📤 Jetzt senden", callback_data: `sd:${d.draftId}` }
          : {
              text: "📤 Gesendet, kontaktiert",
              callback_data: crmCallback({ kind: "status", status: "CONTACTED", companyId: company.id }),
            },
        { text: "🔄 Neu schreiben", callback_data: crmCallback({ kind: "email", companyId: company.id }) },
      ],
      ...[websiteButton(company.website_url)].filter((b) => b !== null).map((b) => [b]),
    ],
  };
}

/** Befund-Seite: Vorschau-Text (Umschlag zum Kopieren, Notizen, Hinweise) und Buttons unter dem PDF. */
export function letterMessages(
  company: Company,
  d: { envelope: string[]; notes: string[]; warnings: string[]; variant: number },
): { caption: string; pdfCaption: string; keyboard: InlineKeyboardButton[][] } {
  const caption = [
    `🖨️ <b>Befund-Seite für ${escapeHtml(company.name)}</b>${d.variant > 1 ? ` (Variante ${d.variant})` : ""}`,
    "",
    "<b>Umschlag (von Hand schreiben):</b>",
    d.envelope.length > 0 ? `<pre>${escapeHtml(d.envelope.join("\n"))}</pre>` : "keine Anschrift gefunden",
    "",
    "<b>Markiert:</b>",
    ...(d.notes.length > 0 ? d.notes.map(escapeHtml) : ["nichts"]),
  ];
  if (d.warnings.length > 0) caption.push("", `⚠️ ${escapeHtml(d.warnings.join(" · "))}`);
  return {
    caption: caption.join("\n"),
    pdfCaption: "Zum Ausdrucken (A4). Nach dem Einwerfen auf „Verschickt, kontaktiert“ tippen.",
    keyboard: [
      [
        {
          text: "📮 Verschickt, kontaktiert",
          callback_data: crmCallback({ kind: "status", status: "CONTACTED", companyId: company.id }),
        },
        { text: "🔄 Neu erstellen", callback_data: crmCallback({ kind: "letter", companyId: company.id }) },
      ],
    ],
  };
}

/** Prototyp fertig: Link, Hinweise, Buttons (Öffnen, Neu bauen). */
export function prototypeMessage(
  company: Company,
  p: { url: string | null; dir: string; warnings: string[]; costUsd: number },
): { caption: string; keyboard: InlineKeyboardButton[][] } {
  const lines = [
    `🎨 <b>Prototyp für ${escapeHtml(company.name)}</b>`,
    "",
    p.url
      ? `<b>Vorschau:</b> ${escapeHtml(p.url)}`
      : "Noch keine Vorschau-Adresse eingerichtet (PREVIEW_BASE_URL), die Seite liegt nur auf dem Server.",
    "Nicht öffentlich auffindbar, nur mit dem Link.",
  ];
  if (p.warnings.length > 0) lines.push("", `⚠️ ${escapeHtml(p.warnings.join(" · "))}`);
  lines.push("", `<i>Kosten ${p.costUsd.toFixed(3).replace(".", ",")} $</i>`);
  const row: InlineKeyboardButton[] = [];
  if (p.url) row.push({ text: "🌐 Öffnen", url: p.url });
  row.push({
    text: "🔄 Neu bauen",
    callback_data: crmCallback({ kind: "prototype", companyId: company.id }),
  });
  return { caption: lines.join("\n"), keyboard: [row] };
}

/** Antwort erkannt bzw. Mail unzustellbar (aus dem Posteingang). */
export function mailEventMessage(e: MailEvent): { text: string; keyboard: InlineKeyboardButton[][] } {
  const open = [
    [
      ...[websiteButton(e.website)].filter((b) => b !== null),
      { text: "🗂 Lead öffnen", callback_data: callbackData("c", e.companyId) },
    ],
  ];
  if (e.kind === "bounce") {
    return {
      text: `⚠️ <b>Unzustellbar:</b> ${escapeHtml(e.companyName)}\nDie Mail an <code>${escapeHtml(e.address)}</code> kam zurück. Vielleicht per Brief?`,
      keyboard: open,
    };
  }
  if (e.kind === "auto_reply") {
    return {
      text: [
        `🏖️ <b>Automatische Antwort von ${escapeHtml(e.companyName)}</b>`,
        e.subject ? `Betreff: ${escapeHtml(e.subject)}` : null,
        e.excerpt ? `<blockquote expandable>${escapeHtml(e.excerpt)}</blockquote>` : null,
        "Zählt nicht als Antwort, das Nachfassen bleibt geplant. 👍",
      ]
        .filter((l) => l !== null)
        .join("\n"),
      keyboard: open,
    };
  }
  // Angebotene Termine zum Bestätigen (Christian liest die Antwort und tippt den genannten Termin an).
  const slotButtons: InlineKeyboardButton[][] = [];
  const slots = e.offer?.slots ?? [];
  for (let i = 0; i < slots.length; i += 2)
    slotButtons.push(
      slots.slice(i, i + 2).map((s, k) => ({
        text: `✅ ${terminShort(s)}`,
        callback_data: `tb:${e.offer!.draftId}:${i + k}`,
      })),
    );
  return {
    text: [
      `💬 <b>Antwort von ${escapeHtml(e.companyName)}!</b>`,
      e.from ? `Von: ${escapeHtml(e.from)}` : null,
      e.subject ? `Betreff: ${escapeHtml(e.subject)}` : null,
      "",
      e.excerpt ? `<blockquote>${escapeHtml(e.excerpt)}</blockquote>` : "",
      "Status steht jetzt auf „geantwortet“, Nachfassen ist gestoppt.",
      slots.length
        ? "Nennt die Antwort einen der Termine? Dann antippen, ich schreibe die Bestätigung:"
        : null,
    ]
      .filter((l) => l !== null)
      .join("\n"),
    keyboard: [...slotButtons, ...open],
  };
}

export function eveningSummaryText(s: EveningSummary): string {
  const c = s.counts;
  const part = (label: string, x: { done: number; total: number }) =>
    x.total > 0 ? `${label} ${x.done}/${x.total}` : null;
  const parts = [
    part("Mails", c.email),
    part("Befund-Seiten", c.letter),
    part("Nachfassen", c.followup),
  ].filter(Boolean);
  const lines = [`🌙 <b>Bilanz heute:</b> ${parts.join(" · ") || "nichts geplant"}`];
  if (s.replies.length > 0) lines.push(`💬 Antworten: ${s.replies.map(escapeHtml).join(", ")}`);
  if (s.bounces.length > 0) lines.push(`⚠️ Unzustellbar: ${s.bounces.map(escapeHtml).join(", ")}`);
  const open =
    c.email.total - c.email.done + c.letter.total - c.letter.done + c.followup.total - c.followup.done;
  if (open > 0)
    lines.push(`Noch offen: ${open}. Mit /heute weitermachen, sonst kommen sie in einen der nächsten Tage.`);
  lines.push("Morgen früh kommt das nächste Paket.");
  return lines.join("\n");
}

/** Liste der Top-Leads (Nummer, Name, Ort, Score, Vertriebsstatus). */
export function topLeadsText(companies: Company[]): string {
  const lines = ["<b>Deine besten Leads</b> (antippen öffnet die Karte):", ""];
  companies.forEach((c, i) => {
    const sales = isSalesStatus(c.status) ? ` · ${SALES_EMOJI[c.status]} ${SALES_LABELS[c.status]}` : "";
    const site = c.segment === "NO_WEBSITE" ? " · ohne Website" : "";
    lines.push(
      `${i + 1}. ${escapeHtml(c.name)}${c.city ? ` (${escapeHtml(c.city)})` : ""} – ${c.current_score ?? "?"}${site}${sales}`,
    );
  });
  return lines.join("\n");
}

/** Ein Button je Lead (öffnet die CRM-Karte), zwei pro Zeile. */
export function leadButtons(companies: Company[]): InlineKeyboardButton[][] {
  const buttons = companies.map((c, i) => ({
    text: `${i + 1}. ${c.name.length > 24 ? `${c.name.slice(0, 23)}…` : c.name}`,
    callback_data: callbackData("c", c.id),
  }));
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

/** Ergebnis des Probelaufs (Mail an Christian selbst). */
export function probeText(r: {
  company: { name: string };
  leadAddress: string | null;
  subject: string;
  body: string;
  sentTo: string | null;
  costUsd: number;
  warnings: string[];
  look?: {
    foto: string;
    quelle?: string | null;
    motiv: string | null;
    farbe: string;
    logo: boolean;
    schrift: string;
    grund: string | null;
  } | null;
}): string {
  const l = r.look;
  const COLOR_SOURCE: Record<string, string> = {
    logo: "aus dem Logo",
    foto: "aus dem Foto",
    website: "wie die bisherige Website",
    warm: "warm (die Praxis wirkt warm)",
  };
  const colors = l ? `Farben ${COLOR_SOURCE[l.farbe] ?? escapeHtml(l.farbe)}` : "";
  const look = l
    ? l.foto === "praxis"
      ? `📷 Eigenes Foto der Praxis${l.quelle === "google" ? " aus dem Google-Profil" : ""}${l.motiv ? ` (${escapeHtml(l.motiv)})` : ""}, ${colors}${l.logo ? ", Logo ✓" : ""} · Schrift ${escapeHtml(l.schrift)}`
      : `📷 Ohne eigenes Foto, weil: ${escapeHtml(l.grund ?? "?")} · ${colors}${l.logo ? " · Logo ✓" : ""} · Schrift ${escapeHtml(l.schrift)}`
    : null;
  return [
    `🧪 <b>Probelauf</b> · ${escapeHtml(r.company.name)}`,
    ...(look ? [look] : []),
    r.sentTo
      ? `📬 Die Probe ging an <code>${escapeHtml(r.sentTo)}</code> (Betreff mit „[Probe]“). Schau sie dir in deiner Mail-App an.`
      : "📭 Postfach nicht eingerichtet: die Mail steht nur hier (App-Passwort, DEPLOY.md Abschnitt 12).",
    `Echter Empfänger wäre: <code>${escapeHtml(r.leadAddress ?? "keine Adresse gefunden")}</code>`,
    `<b>Betreff:</b> ${escapeHtml(r.subject)}`,
    "",
    `<blockquote expandable>${escapeHtml(r.body)}</blockquote>`,
    ...(r.warnings.length ? [`⚠️ ${r.warnings.map(escapeHtml).join(" · ")}`] : []),
    `Nichts wurde an den Lead geschickt, kein Status, keine XP. Kosten ${r.costUsd.toFixed(3).replace(".", ",")} $`,
  ].join("\n");
}

/** Angebot zum Kopieren in Lexware (ohne Public API): je Feld ein Block, in Telegram mit Kopier-Knopf. */
export function offerCopyMessage(
  companyName: string,
  parts: { address: string; introduction: string; article: string; price: string; remark: string },
): string {
  const block = (label: string, text: string) => `<b>${label}</b>\n<pre>${escapeHtml(text)}</pre>`;
  return [
    `📄 <b>Angebot für ${escapeHtml(companyName)}</b> · in Lexware: Angebot erstellen, dann die Teile einfügen`,
    "",
    block("1. Kunde (neu anlegen)", parts.address),
    block("2. Einleitung", parts.introduction),
    `<b>3. Position:</b> Artikel „${escapeHtml(parts.article)}“ (${escapeHtml(parts.price)} inkl. MwSt.), dazu „Hosting und Pflege (monatlich)“ als Info oder eigene Position`,
    "",
    block("4. Bemerkung", parts.remark),
    "Die Artikel legst du einmalig mit /lexware an.",
  ].join("\n");
}

/** Einmalige Einrichtung der Artikel in Lexware. */
export function lexwareSetupMessage(
  articles: { name: string; price: string; description: string }[],
): string {
  return [
    "🧾 <b>Lexware einrichten (einmalig)</b>",
    "Unter Artikel → Neuer Artikel je einen anlegen: Bezeichnung, Bruttopreis (Steuersatz 19 %), Einheit „Pauschal“, Beschreibung einfügen.",
    "",
    ...articles.flatMap((a, i) => [
      `<b>${i + 1}. ${escapeHtml(a.name)}</b> · ${escapeHtml(a.price)} brutto`,
      `<pre>${escapeHtml(a.description)}</pre>`,
    ]),
  ].join("\n");
}
