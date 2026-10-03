import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { insertDraft, takenSlots } from "../db/drafts.js";
import { latestAudit, latestOkSnapshotId, latestPlacesSnapshot, type LatestPlaces } from "../db/leads.js";
import { loadPrompt } from "../llm/config.js";
import type { LlmGateway } from "../llm/gateway.js";
import type { Finding } from "../pipeline/audit/schema.js";
import type { Branches } from "../pipeline/research/branches.js";
import type { OutreachConfig } from "./config.js";
import { proposeSlots, seedOf } from "./slots.js";
import { duToIhr, lowerFirst, subjectFor, type Form } from "./form.js";

/**
 * Kontakt-Entwurf per E-Mail (Phase 2, Stufe 2): Das LLM schreibt nur den Mittelteil (Einstieg, ein starker oder
 * zwei bis drei auffallende Befunde, Kompliment). Grußzeile (aus dem Impressum), Betreff, Terminvorschläge,
 * Kontaktweg, Gruß und Signatur setzt der Code, damit sie stimmen und gegen Spamfilter abwechseln. Avelio verschickt
 * nichts; Christian sendet selbst.
 */

export const CONTACT_PROMPT_VERSION = "v3";

export const contactOutputSchema = z.object({
  absatz: z.string().min(40).max(1000),
});

export interface OutreachDeps {
  db: Db;
  llm: LlmGateway;
  outreach: OutreachConfig;
  branches: Branches;
  now: () => Date;
  contact: { whatsapp: string | null; phone: string | null };
}

export interface EmailDraft {
  to: string | null;
  emailSource: "impressum" | "website" | "google" | null;
  contactName: string | null;
  /** 1 = erster Entwurf, 2 = nach einmal "Neu schreiben" … */
  variant: number;
  subject: string;
  body: string;
  slots: string[];
  du: boolean;
  costUsd: number;
  warnings: string[];
  draftId: string;
}

const SEVERITY = { high: 0, medium: 1, low: 2 } as const;
// Christian überzeugt vor allem über den Gesamteindruck (Desktop); Handy-Mängel zählen, stehen aber nicht vorne.
const CATEGORY = { design: 0, conversion: 1, content: 2, trust: 3, mobile: 4, technical: 5 } as const;

/** Schwere zuerst, bei Gleichstand das, was den ersten Eindruck am meisten prägt. */
export const byImpact = (a: Finding, b: Finding): number =>
  SEVERITY[a.severity] - SEVERITY[b.severity] || CATEGORY[a.category] - CATEGORY[b.category];

/**
 * Befunde für die Mail: ein wirklich starker (schwer) oder sonst die zwei bis drei auffälligsten. Sortiert nach
 * Schwere, bei Gleichstand nach dem, was den ersten Eindruck am meisten prägt.
 */
export function pickFindings(findings: readonly Finding[]): Finding[] {
  const sorted = [...findings].sort(byImpact);
  return sorted[0]?.severity === "high" ? sorted.slice(0, 1) : sorted.slice(0, 3);
}

/** Wie der Betrieb im Alltag heißt: "Hotel Ariadne GmbH | Rosenheim" → "Hotel Ariadne". */
export function shortCompanyName(name: string): string {
  const parts = name
    .replace(/["„“”]/g, "")
    .split(/\s+[|–—-]\s+|\s*\|\s*|,|:/)
    .map((p) => p.trim())
    .filter(Boolean);
  // Nur ein Gattungswort vorne ("Gasthof - Hotel Alt-Fürstätt") → den nächsten Teil dazunehmen.
  let n = parts[0] ?? name.trim();
  if (!/\s/.test(n) && parts[1]) n = `${n} ${parts[1]}`;
  n = n
    .replace(
      /\s+(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|UG(?:\s*\(haftungsbeschränkt\))?|KG|OHG|AG|e\.\s?K\.|GbR)\.?$/i,
      "",
    )
    .trim();
  const words = n.split(/\s+/);
  return words.length > 4 ? words.slice(0, 4).join(" ") : n;
}

/** Grußzeile aus den Impressum-Daten; das Geschlecht wird nie geraten. */
export function salutationLine(
  form: Form,
  contact: { name: string | null; salutation: "Herr" | "Frau" | null },
  companyName: string,
): string {
  const name = contact.name?.trim();
  if (!name) return `Hallo Team ${shortCompanyName(companyName)},`;
  const parts = name.split(/\s+/);
  if (form === "du") return `Hallo ${parts[0]},`;
  if (contact.salutation) return `Hallo ${contact.salutation} ${parts.at(-1)},`;
  return `Hallo ${name},`;
}

/** Kompliment mit Fakt, nur wenn die Bewertung wirklich gut ist. */
export function complimentFact(places: LatestPlaces | null): string | null {
  if (!places?.rating || (places.review_count ?? 0) < 15 || places.rating < 4.3) return null;
  return `${places.rating.toFixed(1).replace(".", ",")} Sterne bei ${places.review_count} Google-Bewertungen`;
}

const SPAM_WORDS = /\b(kostenlos|gratis|angebot|rabatt|garantiert|sofort|exklusiv)\w*/i;

/** Gedankenstriche, Links und Doppel-Leerzeichen entfernen; gefundene Regelverstöße melden. */
export function sanitizeDraftText(text: string): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let t = text.replace(/\s*[–—]\s*/g, ", ").replace(/,\s*,/g, ",");
  if (/https?:\/\/|www\./i.test(t)) {
    t = t.replace(/\s*(https?:\/\/|www\.)\S*?(?=[.,;:!?)]*(\s|$))/gi, "");
    warnings.push("Link entfernt");
  }
  const spam = SPAM_WORDS.exec(t);
  if (spam) warnings.push(`Spam-Wort „${spam[0]}“`);
  return { text: t.replace(/[ \t]{2,}/g, " ").trim(), warnings };
}

/** wa.me-Link mit vorausgefülltem Text. Nummer international (+49 …), führende 0 wird zu 49. */
export function whatsappLink(number: string, text: string): string {
  let digits = number.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `49${digits.slice(1)}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export function mailtoLink(to: string | null, subject: string, body: string): string {
  return `mailto:${to ?? ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Baustein wählen: Startpunkt je Firma aus dem Seed, jede neue Variante ("Neu schreiben") rückt einen weiter. So
 * unterscheidet sich jede Variante sicher von der vorigen, sobald es mehr als eine Auswahl gibt.
 */
export const pick = <T>(list: readonly T[], seed: number, shift: number, variant: number): T =>
  list[((seed >>> shift) + variant) % list.length]!;

export interface Recipient {
  email: string | null;
  /** Woher die Adresse stammt. */
  emailSource: "impressum" | "website" | "google" | null;
  name: string | null;
  salutation: "Herr" | "Frau" | null;
}

export async function recipient(db: Db, companyId: string): Promise<Recipient> {
  const { rows: contacts } = await db.query<{
    name: string | null;
    salutation: "Herr" | "Frau" | null;
    email: string | null;
    source: string;
  }>("select name, salutation, email, source from contacts where company_id = $1 order by created_at", [
    companyId,
  ]);
  const email =
    contacts.find((c) => c.email && c.source === "impressum")?.email ??
    contacts.find((c) => c.email)?.email ??
    null;
  const person = contacts.find((c) => c.name && c.source === "impressum");
  const name = person?.name ?? null;
  const salutation = person?.salutation ?? null;
  if (email) {
    const source = contacts.find((c) => c.email === email)?.source;
    return { email, emailSource: source === "impressum" ? "impressum" : "google", name, salutation };
  }
  // Notfalls die erste mailto-Adresse der Website.
  const snapshotId = await latestOkSnapshotId(db, companyId);
  if (snapshotId) {
    const { rows } = await db.query<{ facts: { mailto_links?: string[] } | null }>(
      "select facts from website_snapshots where id = $1",
      [snapshotId],
    );
    const mail = rows[0]?.facts?.mailto_links?.[0]?.replace(/^mailto:/i, "").split("?")[0] ?? null;
    return { email: mail || null, emailSource: mail ? "website" : null, name, salutation };
  }
  return { email: null, emailSource: null, name, salutation };
}

export async function draftEmail(
  deps: OutreachDeps,
  company: Company,
  by: string,
): Promise<EmailDraft | { kind: "no_audit" }> {
  const { db, outreach: o } = deps;
  const now = deps.now();
  const audit = await latestAudit(db, company.id);
  const findings = pickFindings((audit?.findings as Finding[] | undefined) ?? []);
  if (!audit && company.segment !== "NO_WEBSITE") return { kind: "no_audit" };

  const places = await latestPlacesSnapshot(db, company.id);
  const { email, emailSource, name, salutation } = await recipient(db, company.id);
  const duBranch = company.branch_key !== null && o.du_branchen.includes(company.branch_key);
  const form: Form = !duBranch ? "sie" : name ? "du" : "ihr";
  const du = form !== "sie";
  const inForm = (sieText: string, duText: string) =>
    form === "sie" ? sieText : form === "du" ? duText : duToIhr(duText);
  const { rows: prior } = await db.query<{ body: string | null }>(
    `select body from interactions
      where company_id = $1 and type = 'draft' and channel = 'email' order by created_at desc`,
    [company.id],
  );
  const variant = prior.length;
  const seed = seedOf(company.id);
  // Mittelteil des letzten Entwurfs (Absatz nach der Grußzeile), damit "Neu schreiben" anders formuliert.
  const previous = prior[0]?.body?.split("\n\n")[1] ?? null;

  const intros = [o.einstieg, ...o.einstiege_abwechslung];
  const intro = intros[variant % intros.length]!;
  const branch = company.branch_key ? deps.branches[company.branch_key] : undefined;
  const input = {
    betrieb: { name: company.name, ort: company.city, branche: branch?.label ?? company.category },
    anrede: form,
    einstiegssatz: intro,
    befunde:
      findings.length > 0
        ? findings.map((f) => ({ titel: f.title, detail: f.detail, beleg: f.evidence, schwere: f.severity }))
        : company.segment === "NO_WEBSITE"
          ? [
              {
                titel: "Keine eigene Website",
                detail: "Wer den Betrieb googelt, findet nur den Maps-Eintrag.",
                beleg: "",
                schwere: "high",
              },
            ]
          : [],
    kompliment_fakt: complimentFact(places),
    ...(previous ? { vorheriger_text: previous } : {}),
  };

  const system = loadPrompt("contact", CONTACT_PROMPT_VERSION);
  const run = async () =>
    deps.llm.structured({
      role: "contact",
      promptVersion: CONTACT_PROMPT_VERSION,
      system,
      input: JSON.stringify(input),
      schema: contactOutputSchema,
      companyId: company.id,
      inputSummary: `E-Mail-Entwurf ${company.name}`,
    });
  let result = await run();
  let cost = result.costUsd;
  let clean = sanitizeDraftText(result.output.absatz);
  if (clean.warnings.some((w) => w.startsWith("Spam-Wort"))) {
    result = await run(); // einmal neu schreiben lassen
    cost += result.costUsd;
    clean = sanitizeDraftText(result.output.absatz);
  }

  const slots = proposeSlots({
    now,
    config: o.termine,
    branchKey: company.branch_key,
    du,
    taken: await takenSlots(db, now),
    seed,
    variant,
  });
  const k = o.kontaktweg;
  const slotSentence = slots ? (form === "ihr" ? duToIhr(slots.sentence) : slots.sentence) : null;
  const prepared = inForm(pick(k.vorbereitet, seed, 7, variant), pick(k.vorbereitet_du, seed, 7, variant));
  const cta = deps.contact.whatsapp
    ? inForm(k.email_cta, k.email_cta_du).replace(
        "{whatsapp}",
        whatsappLink(deps.contact.whatsapp, form === "sie" ? k.whatsapp_text_sie : k.whatsapp_text),
      )
    : inForm(k.email_cta_ohne_whatsapp, k.email_cta_ohne_whatsapp_du);
  const subject = subjectFor(
    pick(o.spamschutz.betreffe, seed, 11, variant).replace("{firma}", shortCompanyName(company.name)),
    form,
  );
  const greeting = pick(o.spamschutz.gruesse, seed, 13, variant);
  const signature = [o.absender_name, o.absender_zusatz, deps.contact.phone].filter(Boolean).join("\n");

  const body = [
    salutationLine(form, { name, salutation }, company.name),
    lowerFirst(clean.text),
    [prepared, slotSentence].filter(Boolean).join(" "),
    cta,
    `${greeting}\n${signature}`,
  ].join("\n\n");

  const warnings = [...clean.warnings];
  if (!email) warnings.push("Keine E-Mail-Adresse im Impressum gefunden");
  if (!slots) warnings.push("Keine freien Termine in den nächsten Tagen (config/outreach.yaml → termine)");
  if (!deps.contact.whatsapp) warnings.push("WhatsApp-Nummer fehlt (OUTREACH_WHATSAPP in der .env)");

  const draft = await insertDraft(db, company.id, {
    channel: "email",
    body,
    meta: { subject, to: email, slots: slots?.slots ?? [], prompt: CONTACT_PROMPT_VERSION, variant },
    by,
    now,
  });
  return {
    to: email,
    emailSource,
    contactName: name,
    variant: variant + 1,
    subject,
    body,
    slots: slots?.slots ?? [],
    du,
    costUsd: Math.round(cost * 1000) / 1000,
    warnings,
    draftId: draft.id,
  };
}
