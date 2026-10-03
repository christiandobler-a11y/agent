import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { insertDraft, takenSlots } from "../db/drafts.js";
import {
  contactsOf,
  latestAudit,
  latestOkSnapshotId,
  latestPlacesSnapshot,
  type LatestPlaces,
} from "../db/leads.js";
import { loadPrompt } from "../llm/config.js";
import type { LlmGateway } from "../llm/gateway.js";
import type { Finding } from "../pipeline/audit/schema.js";
import type { Branches } from "../pipeline/research/branches.js";
import type { OutreachConfig } from "./config.js";
import { proposeSlots, seedOf } from "./slots.js";
import { duToIhr, lowerFirst, subjectFor, type Form } from "./form.js";

/**
 * Kontakt-Entwurf per E-Mail (Phase 2, Stufe 2): Das LLM schreibt nur Anrede und Mittelteil (Einstieg, ein Befund,
 * Kompliment). Betreff, Terminvorschläge, Kontaktweg, Gruß und Signatur setzt der Code, damit sie stimmen und
 * gegen Spamfilter abwechseln. Avelio verschickt nichts; Christian sendet selbst.
 */

export const CONTACT_PROMPT_VERSION = "v1";

export const contactOutputSchema = z.object({
  anrede: z.string().min(3).max(80),
  absatz: z.string().min(40).max(900),
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
  subject: string;
  body: string;
  slots: string[];
  du: boolean;
  costUsd: number;
  warnings: string[];
  draftId: string;
}

const SEVERITY = { high: 0, medium: 1, low: 2 } as const;
const CATEGORY = { mobile: 0, conversion: 1, trust: 2, design: 3, content: 4, technical: 5 } as const;

/** Der eine Befund für die Mail: schwerster zuerst, bei Gleichstand das, was ein Kunde am Handy am ehesten merkt. */
export function pickFinding(findings: readonly Finding[]): Finding | null {
  return (
    [...findings].sort(
      (a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || CATEGORY[a.category] - CATEGORY[b.category],
    )[0] ?? null
  );
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

const pick = <T>(list: readonly T[], seed: number, shift: number): T => list[(seed >>> shift) % list.length]!;

async function recipient(db: Db, companyId: string): Promise<{ email: string | null; name: string | null }> {
  const contacts = await contactsOf(db, companyId);
  const email =
    contacts.find((c) => c.email && c.source === "impressum")?.email ??
    contacts.find((c) => c.email)?.email ??
    null;
  const name = contacts.find((c) => c.name && c.source === "impressum")?.name ?? null;
  if (email) return { email, name };
  // Notfalls die erste mailto-Adresse der Website.
  const snapshotId = await latestOkSnapshotId(db, companyId);
  if (snapshotId) {
    const { rows } = await db.query<{ facts: { mailto_links?: string[] } | null }>(
      "select facts from website_snapshots where id = $1",
      [snapshotId],
    );
    const mail = rows[0]?.facts?.mailto_links?.[0]?.replace(/^mailto:/i, "").split("?")[0] ?? null;
    return { email: mail || null, name };
  }
  return { email: null, name };
}

export async function draftEmail(
  deps: OutreachDeps,
  company: Company,
  by: string,
): Promise<EmailDraft | { kind: "no_audit" }> {
  const { db, outreach: o } = deps;
  const now = deps.now();
  const audit = await latestAudit(db, company.id);
  const finding = pickFinding((audit?.findings as Finding[] | undefined) ?? []);
  if (!audit && company.segment !== "NO_WEBSITE") return { kind: "no_audit" };

  const places = await latestPlacesSnapshot(db, company.id);
  const { email, name } = await recipient(db, company.id);
  const duBranch = company.branch_key !== null && o.du_branchen.includes(company.branch_key);
  const form: Form = !duBranch ? "sie" : name ? "du" : "ihr";
  const du = form !== "sie";
  const inForm = (sieText: string, duText: string) =>
    form === "sie" ? sieText : form === "du" ? duText : duToIhr(duText);
  const { rows: prior } = await db.query<{ n: number }>(
    "select count(*)::int as n from interactions where company_id = $1 and type = 'draft'",
    [company.id],
  );
  const seed = seedOf(`${company.id}:${prior[0]!.n}`);

  const intros = [o.einstieg, ...o.einstiege_abwechslung];
  const intro = prior[0]!.n === 0 ? o.einstieg : pick(intros, seed, 0);
  const branch = company.branch_key ? deps.branches[company.branch_key] : undefined;
  const input = {
    betrieb: { name: company.name, ort: company.city, branche: branch?.label ?? company.category },
    ansprechpartner: name,
    anrede: form,
    einstiegssatz: intro,
    befund: finding
      ? { titel: finding.title, detail: finding.detail, beleg: finding.evidence }
      : company.segment === "NO_WEBSITE"
        ? {
            titel: "Keine eigene Website",
            detail: "Wer den Betrieb googelt, findet nur den Maps-Eintrag.",
            beleg: "",
          }
        : null,
    kompliment_fakt: complimentFact(places),
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
  });
  const k = o.kontaktweg;
  const slotSentence = slots ? (form === "ihr" ? duToIhr(slots.sentence) : slots.sentence) : null;
  const prepared = inForm(pick(k.vorbereitet, seed, 7), pick(k.vorbereitet_du, seed, 7));
  const cta = deps.contact.whatsapp
    ? inForm(k.email_cta, k.email_cta_du).replace(
        "{whatsapp}",
        whatsappLink(deps.contact.whatsapp, form === "sie" ? k.whatsapp_text_sie : k.whatsapp_text),
      )
    : inForm(k.email_cta_ohne_whatsapp, k.email_cta_ohne_whatsapp_du);
  const subject = subjectFor(pick(o.spamschutz.betreffe, seed, 11).replace("{firma}", company.name), form);
  const greeting = pick(o.spamschutz.gruesse, seed, 13);
  const signature = [o.absender_name, o.absender_zusatz, deps.contact.phone].filter(Boolean).join("\n");

  const body = [
    sanitizeDraftText(result.output.anrede).text,
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
    meta: { subject, to: email, slots: slots?.slots ?? [], prompt: CONTACT_PROMPT_VERSION },
    by,
    now,
  });
  return {
    to: email,
    subject,
    body,
    slots: slots?.slots ?? [],
    du,
    costUsd: Math.round(cost * 1000) / 1000,
    warnings,
    draftId: draft.id,
  };
}
