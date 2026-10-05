import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { setSalesStatus } from "../db/crm.js";
import type { OutreachConfig } from "./config.js";
import { recipient } from "./draft.js";
import { insertDraft } from "../db/drafts.js";

/**
 * Anruf-Liste (06.10.2026, Christian): Erstkontakt per Telefon statt Kaltmail. Ziel des Anrufs ist nur das Ja zur Mail
 * mit dem Entwurf; mit dieser Einwilligung ist die Mail erlaubt. Der Anruf steht als Entwurf (`channel = 'phone'`) mit
 * Leitfaden im Tagesplan, das Ergebnis als Notiz mit `meta.call` im Verlauf.
 */

export type CallOutcome = "ja" | "brief" | "nicht_erreicht" | "kein_interesse";

/** Telefonnummer international, damit Telegram sie zum Antippen erkennt ("08031 1234" → "+49 8031 1234"). Rein. */
export function dialable(phone: string): string {
  const p = phone.trim();
  if (p.startsWith("+")) return p;
  if (p.startsWith("00")) return `+${p.slice(2)}`;
  if (p.startsWith("0")) return `+49 ${p.slice(1)}`;
  return p;
}

/**
 * Anruf vorbereiten (für die Karte im Morgen-Paket): Nummer, Öffnungszeiten, Adresse aus dem Impressum (für das Ja)
 * und der kurze Satz. `null` ohne Telefonnummer.
 */
export async function prepareCall(
  db: Db,
  o: OutreachConfig,
  company: Company,
  by: string,
  now: Date,
  hours?: ((company: Company) => Promise<string[]>) | null,
): Promise<{ draftId: string } | null> {
  if (!company.phone || !o.anruf) return null;
  const person = await recipient(db, company.id);
  const draft = await insertDraft(db, company.id, {
    channel: "phone",
    body: o.anruf.pitch.trim(),
    meta: {
      phone: dialable(company.phone),
      hours: hours ? await hours(company).catch(() => []) : [],
      person: person.name ? `${person.salutation ?? ""} ${person.name}`.trim() : null,
      email: person.email,
      pitch: o.anruf.pitch.trim(),
    },
    by,
    now,
  });
  return { draftId: draft.id };
}

/** Nur Ziffern mit Ländervorwahl ("+49 881 12345" → "4988112345"), für den Wähl-Link. Rein. */
export function phoneDigits(phone: string): string {
  return dialable(phone).replace(/\D/g, "");
}

/** Wie oft die Praxis schon nicht erreicht wurde. */
export async function missedCalls(db: Db, companyId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from interactions
      where company_id = $1 and type = 'note' and meta->>'call' = 'nicht_erreicht'`,
    [companyId],
  );
  return rows[0]?.n ?? 0;
}

const OUTCOME_TEXT: Record<CallOutcome, string> = {
  ja: "📞 Telefonisch eingewilligt: Entwurf per Mail erwünscht",
  brief: "📞 Telefon: lieber per Post",
  nicht_erreicht: "📞 Telefon: nicht erreicht",
  kein_interesse: "📞 Telefon: kein Interesse",
};

/**
 * Ergebnis des Anrufs festhalten. "Ja" ist die Einwilligung für die Mail: mit Zeitpunkt, Adresse und Ansprechpartner
 * im Verlauf (Nachweis). "Kein Interesse" setzt den Lead auf verloren, damit er nie wieder drankommt.
 */
export async function recordCall(
  db: Db,
  companyId: string,
  outcome: CallOutcome,
  r: { by: string; now: Date; to?: string | null; person?: string | null; note?: string | null },
): Promise<void> {
  const detail = [
    r.to ? `an ${r.to}` : null,
    r.person ? `Ansprechpartner: ${r.person}` : null,
    r.note ?? null,
  ].filter(Boolean);
  await db.query(
    `insert into interactions (company_id, type, channel, body, meta, created_by, created_at)
     values ($1, 'note', 'phone', $2, $3, $4, $5)`,
    [
      companyId,
      [OUTCOME_TEXT[outcome], ...detail].join(", "),
      JSON.stringify({
        call: outcome,
        ...(outcome === "ja"
          ? { consent: { at: r.now.toISOString(), to: r.to ?? null, person: r.person ?? null } }
          : {}),
      }),
      r.by,
      r.now,
    ],
  );
  if (outcome === "kein_interesse")
    await setSalesStatus(db, companyId, "LOST", {
      by: r.by,
      note: "Telefon: kein Interesse",
      now: r.now,
      followUpDays: 0,
    });
  if (outcome === "ja")
    await setSalesStatus(db, companyId, "CONTACTED", {
      by: r.by,
      channel: "phone",
      note: "Telefon: Mail mit Entwurf erwünscht",
      now: r.now,
      followUpDays: 0,
    });
}

/**
 * Praxen, die nach dem Anruf einen Brief bekommen sollen: "lieber per Post" oder `versuche`-mal nicht erreicht, und
 * noch kein Brief seitdem. Nie verlorene oder schon weiter fortgeschrittene.
 */
export async function dueCallLetters(db: Db, attempts: number, limit: number): Promise<Company[]> {
  const { rows } = await db.query<Company>(
    `select c.* from companies c
      where c.status in ('QUALIFIED', 'READY_FOR_CONTACT', 'CONTACTED')
        and (exists (select 1 from interactions n where n.company_id = c.id and n.meta->>'call' = 'brief')
             or (select count(*) from interactions n
                  where n.company_id = c.id and n.meta->>'call' = 'nicht_erreicht') >= $1)
        and not exists (select 1 from interactions n where n.company_id = c.id
                         and n.meta->>'call' in ('ja', 'kein_interesse'))
        and not exists (select 1 from interactions l where l.company_id = c.id and l.type = 'draft'
                         and l.channel = 'letter')
        and c.street is not null and c.postal_code is not null
      order by c.current_score desc nulls last
      limit $2`,
    [attempts, limit],
  );
  return rows;
}

/** Name aus Christians Eingabe nach dem Ja ("Frau Huber huber@praxis.de"): Anrede, Name, Mail-Adresse. Rein. */
export function parseConsentInput(text: string): {
  email: string | null;
  name: string | null;
  salutation: "Herr" | "Frau" | null;
} {
  const raw = /[^\s<>,;]+@[^\s<>,;]+\.[a-z]{2,}/i.exec(text)?.[0] ?? null;
  const email = raw?.toLowerCase() ?? null;
  const rest = (raw ? text.replace(raw, " ") : text).replace(/[,;]/g, " ").replace(/\s+/g, " ").trim();
  const m = /^(Frau|Herr)\s+(.+)$/i.exec(rest);
  if (m)
    return {
      email,
      name: m[2]!.trim(),
      salutation: m[1]!.toLowerCase() === "frau" ? "Frau" : "Herr",
    };
  return { email, name: rest || null, salutation: null };
}
