import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { addReminder, setSalesStatus } from "../db/crm.js";
import { insertDraft } from "../db/drafts.js";
import type { OutreachConfig } from "./config.js";
import { pick, recipient, salutationLine } from "./draft.js";
import { duToIhr, type Form } from "./form.js";
import { personFromCompanyName } from "./names.js";
import { seedOf } from "./slots.js";

/**
 * Termin bestätigen (04.10.2026, Christian): Ein Lead antwortet auf die Terminvorschläge. Avelio liest die Antwort
 * nicht (fremder Inhalt), Christian tippt den genannten Termin an. Code schreibt daraus die Bestätigungs-Mail im selben
 * Verlauf, mit Kalender-Einladung; gesendet wird wie immer nur per Knopf. Nach dem Senden: Status "interessiert",
 * Erinnerung vor dem Gespräch, der Termin ist für andere Leads belegt.
 */

/** "Dienstag, 13.10., um 12:30 Uhr" */
export function terminLabel(iso: string): string {
  const d = new Date(iso);
  const weekday = d.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", weekday: "long" });
  const date = d.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "numeric", month: "numeric" });
  const time = d
    .toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" })
    .replace(/^0/, "");
  return `${weekday}, ${date}, um ${time.replace(/:00$/, "")} Uhr`;
}

/** Kurz für Knöpfe: "Di 13.10. 12:30" */
export function terminShort(iso: string): string {
  const d = new Date(iso);
  const wd = d.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", weekday: "short" }).replace(".", "");
  const date = d.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "numeric", month: "numeric" });
  const time = d.toLocaleTimeString("de-DE", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${wd} ${date} ${time}`;
}

const icsDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
const icsText = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/([,;])/g, "\\$1");

/** Kalender-Einladung (.ics, zum Hinzufügen), rein. */
export function icsInvite(e: {
  uid: string;
  start: Date;
  minutes: number;
  summary: string;
  description: string;
  now: Date;
}): string {
  const end = new Date(e.start.getTime() + e.minutes * 60_000);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Avelio//Termin//DE",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${icsDate(e.now)}`,
    `DTSTART:${icsDate(e.start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(e.summary)}`,
    `DESCRIPTION:${icsText(e.description)}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(e.summary)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

export interface ConfirmDeps {
  db: Db;
  outreach: OutreachConfig;
  contact: { phone: string | null };
  /** Link für ein kurzes Video-Gespräch (OUTREACH_MEETING_URL), sonst Telefon. */
  meetingUrl?: string | null;
  now: Date;
}

/** Entwurf der Bestätigung zu Termin Nr. `index` aus dem gesendeten Erstkontakt `draftId`. */
export async function createConfirmDraft(
  deps: ConfirmDeps,
  draftId: string,
  index: number,
  by: string,
): Promise<{ draftId: string; body: string; subject: string; termin: string; company: Company } | null> {
  const { db, outreach: o } = deps;
  const { rows } = await db.query<{
    company_id: string;
    meta: { slots?: string[]; subject?: string; to?: string; message_id?: string };
  }>("select company_id, meta from interactions where id = $1 and type = 'draft'", [draftId]);
  const first = rows[0];
  const termin = first?.meta.slots?.[index];
  if (!first || !termin || !first.meta.to) return null;
  const { rows: companies } = await db.query<Company>("select * from companies where id = $1", [
    first.company_id,
  ]);
  const company = companies[0]!;
  // Auf die Antwort des Leads antworten (falls bekannt), sonst auf die eigene erste Mail.
  const { rows: replies } = await db.query<{ message_id: string | null }>(
    `select meta->>'message_id' as message_id from interactions
      where company_id = $1 and type = 'note' and created_by = 'mail' and meta ? 'message_id'
      order by created_at desc limit 1`,
    [company.id],
  );
  const inReplyTo = replies[0]?.message_id ?? first.meta.message_id ?? null;

  const person = await recipient(db, company.id);
  const duBranch = company.branch_key !== null && o.du_branchen.includes(company.branch_key);
  const named = person.name ?? personFromCompanyName(company.name);
  const form: Form = !duBranch ? "sie" : named ? "du" : "ihr";
  const inForm = (sie: string, du: string) => (form === "sie" ? sie : form === "du" ? du : duToIhr(du));
  const b = o.bestaetigung;
  const ablauf = deps.meetingUrl
    ? inForm(b.ablauf_link, b.ablauf_link_du).replace("{link}", deps.meetingUrl)
    : inForm(b.ablauf_telefon, b.ablauf_telefon_du);
  const seed = seedOf(company.id);
  const body = [
    salutationLine(form, person, company.name, o.team_anrede[company.branch_key ?? ""]?.anrede),
    inForm(b.text, b.text_du).replace("{termin}", terminLabel(termin)).replace("{ablauf}", ablauf),
    `${pick(o.spamschutz.gruesse, seed, 13, 1)}\n${[o.absender_name, o.absender_zusatz, deps.contact.phone].filter(Boolean).join("\n")}`,
  ].join("\n\n");
  const subject = /^re:/i.test(first.meta.subject ?? "")
    ? first.meta.subject!
    : `Re: ${first.meta.subject ?? ""}`;
  const draft = await insertDraft(db, company.id, {
    channel: "email",
    body,
    meta: { subject, to: first.meta.to, in_reply_to: inReplyTo, follow_up: true, termin, slots: [termin] },
    by,
    now: deps.now,
  });
  return { draftId: draft.id, body, subject, termin, company };
}

/** Nach dem Senden einer Bestätigung: Status, Erinnerung vor dem Gespräch. */
export async function afterConfirmSent(
  db: Db,
  company: Company,
  termin: string,
  opts: { by: string; now: Date; reminderMinutes: number },
): Promise<void> {
  if (["READY_FOR_CONTACT", "QUALIFIED", "CONTACTED", "REPLIED"].includes(company.status))
    await setSalesStatus(db, company.id, "INTERESTED", {
      by: opts.by,
      channel: "email",
      note: `Termin bestätigt: ${terminLabel(termin)}`,
      now: opts.now,
      followUpDays: 0,
    });
  await addReminder(db, company.id, {
    dueAt: new Date(Date.parse(termin) - opts.reminderMinutes * 60_000),
    text: `Gespräch mit ${company.name} um ${terminLabel(termin).split(" um ")[1]}${company.phone ? `, Tel. ${company.phone}` : ""}`,
    by: opts.by,
    now: opts.now,
  });
}
