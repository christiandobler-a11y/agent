import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";
import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { recipient } from "./draft.js";
import { personInCompanyName } from "./names.js";

/**
 * Angebot in Lexware (04.10.2026, mit Christian). Lexware Office M hat keine Public API (erst XL): Christian legt einmal
 * Artikel für die Pakete an (Texte aus `lexwareArticles`, Telegram /lexware), Avelio liefert je Lead die Teile zum
 * Kopieren (`offerCopyParts`: Anschrift, Einleitung, Artikel, Bemerkung). Mit LEXWARE_API_KEY (XL) legt Avelio den
 * Entwurf direkt an (`quotationBody`, `createOffer`). Preise sind Endpreise inkl. MwSt. Kein LLM.
 */

const configSchema = z.object({
  mwst_prozent: z.number().min(0),
  gueltig_tage: z.number().int().min(1),
  einheit: z.string().default("Pauschal"),
  lieferzeit: z.string(),
  zahlung: z.string(),
  pakete: z.record(
    z.string(),
    z.object({ titel: z.string(), preis_brutto: z.number(), leistungen: z.array(z.string()).min(1) }),
  ),
  hosting: z.object({
    titel: z.string(),
    preis_monat_brutto: z.number(),
    hinweis: z.string(),
    leistungen: z.array(z.string()),
  }),
  optional: z.array(z.object({ titel: z.string(), text: z.string(), preis: z.string() })).default([]),
  mitwirkung: z.array(z.string()).default([]),
});
export type OfferConfig = z.infer<typeof configSchema>;
export const loadOfferConfig = () => loadYamlConfig("angebot.yaml", configSchema);

export const LEXWARE_API = "https://api.lexware.io";
export const LEXWARE_APP = "https://app.lexware.de";

const euro = (n: number) =>
  n.toLocaleString("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2 });
const bullets = (items: readonly string[]) => items.map((i) => `• ${i}`).join("\n");

/** Förmliche Anrede fürs Angebot; das Geschlecht nur, wenn es angegeben ist. */
export function offerSalutation(person: { name: string | null; salutation: "Herr" | "Frau" | null }): string {
  const name = person.name?.trim();
  if (!name) return "Sehr geehrtes Praxisteam,";
  const last = name.split(/\s+/).at(-1);
  if (person.salutation === "Frau") return `Sehr geehrte Frau ${last},`;
  if (person.salutation === "Herr") return `Sehr geehrter Herr ${last},`;
  return `Guten Tag ${name},`;
}

/** Brutto-Endpreis → Netto und enthaltene MwSt. (990 € → 831,93 € + 158,07 €). */
export function grossSplit(gross: number, vatPercent: number): { net: number; vat: number } {
  const net = Math.round((gross / (1 + vatPercent / 100)) * 100) / 100;
  return { net, vat: Math.round((gross - net) * 100) / 100 };
}

/** Lexware-Datum (ISO mit Zeitzone Berlin, Mitternacht). */
function lexDate(d: Date): string {
  const day = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const offset = d
    .toLocaleString("en-US", { timeZone: "Europe/Berlin", timeZoneName: "longOffset" })
    .match(/GMT([+-]\d{2}:\d{2})/);
  return `${day}T00:00:00.000${offset?.[1] ?? "+01:00"}`;
}

export interface QuotationInput {
  paket: string;
  now: Date;
  company: { name: string; street: string | null; postalCode: string | null; city: string | null };
  salutation: string;
}

/** Request-Body für POST /v1/quotations (Entwurf), rein. */
export function quotationBody(c: OfferConfig, q: QuotationInput): Record<string, unknown> {
  const p = c.pakete[q.paket];
  if (!p) throw new Error(`Unbekanntes Paket: ${q.paket}`);
  const price = (gross: number) => ({
    currency: "EUR",
    grossAmount: gross,
    taxRatePercentage: c.mwst_prozent,
  });
  const address: Record<string, string> = { name: q.company.name, countryCode: "DE" };
  if (q.company.street) address.street = q.company.street;
  if (q.company.postalCode) address.zip = q.company.postalCode;
  if (q.company.city) address.city = q.company.city;
  return {
    voucherDate: lexDate(q.now),
    expirationDate: lexDate(new Date(q.now.getTime() + c.gueltig_tage * 86_400_000)),
    address,
    lineItems: [
      {
        type: "custom",
        name: p.titel,
        description: bullets(p.leistungen),
        quantity: 1,
        unitName: c.einheit,
        unitPrice: price(p.preis_brutto),
        discountPercentage: 0,
      },
      {
        type: "text",
        name: `${c.hosting.titel}: ${euro(c.hosting.preis_monat_brutto)} im Monat`,
        description: `${bullets(c.hosting.leistungen)}\n${c.hosting.hinweis}`,
      },
      ...(c.mitwirkung.length
        ? [{ type: "text", name: "Was ich von Ihnen brauche", description: bullets(c.mitwirkung) }]
        : []),
      ...(c.optional.length
        ? [
            {
              type: "text",
              name: "Optional erweiterbar",
              description: c.optional.map((o) => `• ${o.titel}: ${o.text} (${o.preis})`).join("\n"),
            },
          ]
        : []),
    ],
    totalPrice: { currency: "EUR" },
    taxConditions: { taxType: "gross" },
    title: "Angebot",
    introduction: `${q.salutation}\nvielen Dank für das nette Gespräch. Wie besprochen erhalten Sie hier mein Angebot für die neue Website von ${q.company.name}.`,
    remark: `Lieferzeit: ${c.lieferzeit}.\nZahlung: ${c.zahlung}.\nZur Beauftragung genügt eine kurze Antwort per Mail. Ich freue mich auf Ihre Rückmeldung.`,
  };
}

export class LexwareError extends Error {}

/** Angebot als Entwurf in Lexware anlegen; gibt die ID zurück. */
export async function createLexwareQuotation(
  fetchFn: typeof fetch,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await fetchFn(`${LEXWARE_API}/v1/quotations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401
        ? "Lexware-Schlüssel ungültig (LEXWARE_API_KEY)"
        : res.status === 429
          ? "Lexware: zu viele Anfragen, bitte gleich noch einmal"
          : `Lexware antwortet mit ${res.status}`;
    // Antworttext gekürzt und ohne Schlüssel
    throw new LexwareError(`${hint}: ${text.slice(0, 200)}`);
  }
  const parsed = z.object({ id: z.string() }).safeParse(JSON.parse(text));
  if (!parsed.success) throw new LexwareError("Lexware: unerwartete Antwort");
  return parsed.data.id;
}

export interface OfferDeps {
  db: Db;
  config: OfferConfig;
  apiKey: string;
  fetch?: typeof fetch;
  now: () => Date;
}

export async function createOffer(
  deps: OfferDeps,
  company: Company,
  paket: string,
  by: string,
): Promise<{ id: string; url: string; gross: number }> {
  if (!deps.config.pakete[paket]) throw new Error(`Unbekanntes Paket: ${paket}`);
  const now = deps.now();
  const person = await recipient(deps.db, company.id);
  const fromName = person.name ? null : personInCompanyName(company.name);
  const body = quotationBody(deps.config, {
    paket,
    now,
    company: {
      name: company.name,
      street: company.street,
      postalCode: company.postal_code,
      city: company.city,
    },
    salutation: offerSalutation({
      name: person.name ?? fromName?.name ?? null,
      salutation: person.salutation ?? fromName?.salutation ?? null,
    }),
  });
  const id = await createLexwareQuotation(deps.fetch ?? fetch, deps.apiKey, body);
  const url = `${LEXWARE_APP}/permalink/quotations/edit/${id}`;
  const gross = deps.config.pakete[paket].preis_brutto;
  await deps.db.query(
    `insert into interactions (company_id, type, channel, body, meta, created_by, created_at)
     values ($1, 'note', 'other', $2, $3, $4, $5)`,
    [
      company.id,
      `Angebot in Lexware angelegt (Entwurf): ${deps.config.pakete[paket].titel}, ${euro(gross)}`,
      JSON.stringify({ lexware_quotation: id, paket, brutto: gross }),
      by,
      now,
    ],
  );
  return { id, url, gross };
}

/** Artikel für die einmalige Einrichtung in Lexware (Name, Preis brutto, Beschreibung). */
export function lexwareArticles(c: OfferConfig): { name: string; price: string; description: string }[] {
  return [
    ...Object.values(c.pakete).map((p) => ({
      name: p.titel,
      price: euro(p.preis_brutto),
      description: bullets(p.leistungen),
    })),
    {
      name: `${c.hosting.titel} (monatlich)`,
      price: euro(c.hosting.preis_monat_brutto),
      description: `${bullets(c.hosting.leistungen)}\n${c.hosting.hinweis}`,
    },
  ];
}

/** Bemerkung fürs Angebot (Mitwirkung, Optionen, Lieferzeit, Zahlung). */
export function offerRemark(c: OfferConfig): string {
  return [
    c.mitwirkung.length ? `Was ich von Ihnen brauche:\n${bullets(c.mitwirkung)}` : null,
    c.optional.length
      ? `Optional erweiterbar:\n${c.optional.map((o) => `• ${o.titel}: ${o.text} (${o.preis})`).join("\n")}`
      : null,
    `Lieferzeit: ${c.lieferzeit}.\nZahlung: ${c.zahlung}.`,
    "Zur Beauftragung genügt eine kurze Antwort per Mail. Ich freue mich auf Ihre Rückmeldung.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Teile zum Kopieren in Lexware für einen Lead, rein. */
export function offerCopyParts(
  c: OfferConfig,
  q: Omit<QuotationInput, "now">,
): { address: string; introduction: string; article: string; price: string; remark: string } {
  const p = c.pakete[q.paket];
  if (!p) throw new Error(`Unbekanntes Paket: ${q.paket}`);
  return {
    address: [
      q.company.name,
      q.company.street,
      [q.company.postalCode, q.company.city].filter(Boolean).join(" "),
    ]
      .filter((x) => x && x.trim())
      .join("\n"),
    introduction: `${q.salutation}\nvielen Dank für das nette Gespräch. Wie besprochen erhalten Sie hier mein Angebot für die neue Website von ${q.company.name}.`,
    article: p.titel,
    price: euro(p.preis_brutto),
    remark: offerRemark(c),
  };
}

/** Anrede für das Angebot eines Leads (Impressum, sonst Inhaberin aus dem Firmennamen). */
export async function offerSalutationFor(db: Db, company: Company): Promise<string> {
  const person = await recipient(db, company.id);
  const fromName = person.name ? null : personInCompanyName(company.name);
  return offerSalutation({
    name: person.name ?? fromName?.name ?? null,
    salutation: person.salutation ?? fromName?.salutation ?? null,
  });
}
