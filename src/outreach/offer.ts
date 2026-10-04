import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";
import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { recipient } from "./draft.js";
import type { LetterRenderer } from "./letterPdf.js";
import { personInCompanyName } from "./names.js";

/**
 * Angebot als PDF (04.10.2026, mit Christian): festes Paket (Onepager oder mehrseitig), Hosting und Pflege monatlich,
 * optionale Erweiterungen, Mitwirkung, Zahlung. Kein LLM: Inhalt aus config/angebot.yaml, Layout rein
 * (`renderOfferHtml`), Chromium druckt das PDF. Jedes Angebot steht als Notiz mit Nummer im Verlauf.
 */

const configSchema = z.object({
  mwst_prozent: z.number().min(0),
  gueltig_tage: z.number().int().min(1),
  lieferzeit: z.string(),
  zahlung: z.string(),
  pakete: z.record(
    z.string(),
    z.object({ titel: z.string(), preis_netto: z.number(), leistungen: z.array(z.string()).min(1) }),
  ),
  hosting: z.object({
    titel: z.string(),
    preis_monat_netto: z.number(),
    hinweis: z.string(),
    leistungen: z.array(z.string()),
  }),
  optional: z.array(z.object({ titel: z.string(), text: z.string(), preis: z.string() })).default([]),
  mitwirkung: z.array(z.string()).default([]),
});
export type OfferConfig = z.infer<typeof configSchema>;
export const loadOfferConfig = () => loadYamlConfig("angebot.yaml", configSchema);

export interface OfferData {
  number: string;
  date: Date;
  paket: string;
  company: { name: string; street: string | null; postalCode: string | null; city: string | null };
  /** "Sehr geehrte Frau Heider," */
  salutation: string;
  sender: {
    name: string;
    line: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
}

const euro = (n: number) =>
  n.toLocaleString("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2 });
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const deDate = (d: Date) =>
  d.toLocaleDateString("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

/** Förmliche Anrede fürs Angebot; das Geschlecht nur, wenn es angegeben ist. */
export function offerSalutation(person: { name: string | null; salutation: "Herr" | "Frau" | null }): string {
  const name = person.name?.trim();
  if (!name) return "Sehr geehrtes Praxisteam,";
  const last = name.split(/\s+/).at(-1);
  if (person.salutation === "Frau") return `Sehr geehrte Frau ${last},`;
  if (person.salutation === "Herr") return `Sehr geehrter Herr ${last},`;
  return `Guten Tag ${name},`;
}

export function offerTotals(c: OfferConfig, paket: string): { net: number; vat: number; gross: number } {
  const net = c.pakete[paket]!.preis_netto;
  const vat = Math.round(net * c.mwst_prozent) / 100;
  return { net, vat, gross: net + vat };
}

/** A4-Seite(n) als HTML, rein. */
export function renderOfferHtml(d: OfferData, c: OfferConfig): string {
  const p = c.pakete[d.paket];
  if (!p) throw new Error(`Unbekanntes Paket: ${d.paket}`);
  const t = offerTotals(c, d.paket);
  const valid = new Date(d.date.getTime() + c.gueltig_tage * 86_400_000);
  const hostingVat = Math.round(c.hosting.preis_monat_netto * c.mwst_prozent) / 100;
  const list = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  const addr = [
    d.company.name,
    d.company.street,
    [d.company.postalCode, d.company.city].filter(Boolean).join(" "),
  ]
    .filter((x) => x && x.trim())
    .map((x) => esc(x!))
    .join("<br>");
  const sender = [d.sender.name, d.sender.line, d.sender.address, d.sender.phone, d.sender.email]
    .filter(Boolean)
    .map((x) => esc(x!));
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Angebot ${esc(d.number)}</title><style>
@page{size:A4;margin:16mm 20mm 14mm}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Helvetica,Arial,sans-serif;color:#1d2433;font-size:10.5pt;line-height:1.45}
.page{width:100%}
.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1f5f68;padding-bottom:6mm}
.brand{font-size:20pt;font-weight:700;letter-spacing:.04em;color:#1f5f68}
.brand small{display:block;font-size:8.5pt;font-weight:400;letter-spacing:.08em;color:#5d6577;text-transform:uppercase}
.sender{text-align:right;font-size:8.5pt;color:#5d6577;line-height:1.5}
.meta{display:flex;justify-content:space-between;margin-top:10mm}
.to{font-size:10.5pt}
.info{text-align:right;font-size:9pt;color:#5d6577}
.info b{color:#1d2433}
h1{font-size:15pt;margin-top:10mm;color:#1f5f68}
p.intro{margin-top:4mm}
table{width:100%;border-collapse:collapse;margin-top:6mm}
th{text-align:left;font-size:8.5pt;text-transform:uppercase;letter-spacing:.06em;color:#5d6577;border-bottom:1px solid #d5dae2;padding:2mm 0}
td{vertical-align:top;padding:3mm 0;border-bottom:1px solid #eef0f4}
td.num{text-align:right;white-space:nowrap;padding-left:6mm}
td b{font-size:11pt}
ul{margin:1.5mm 0 0 4.5mm}
li{margin:.6mm 0}
.sum td{border:0;padding:1mm 0}
.sum tr.total td{font-weight:700;font-size:11.5pt;border-top:2px solid #1d2433;padding-top:2mm}
.box,.cols,.sign,tr{break-inside:avoid}
.box{margin-top:6mm;padding:4mm 5mm;background:#f2f6f7;border-radius:2mm}
.box h2{font-size:10.5pt;color:#1f5f68;margin-bottom:1mm}
.cols{display:flex;gap:6mm;margin-top:6mm}
.cols>div{flex:1}
h3{font-size:10pt;color:#1f5f68;margin-bottom:1mm}
.small{font-size:9pt;color:#5d6577}
.sign{margin-top:8mm}
</style></head><body><div class="page">
<div class="top"><div class="brand">AVELIO<small>Websites für Physiotherapie</small></div><div class="sender">${sender.join("<br>")}</div></div>
<div class="meta"><div class="to">${addr}</div>
<div class="info">Angebot <b>${esc(d.number)}</b><br>Datum: ${deDate(d.date)}<br>Gültig bis: ${deDate(valid)}</div></div>
<h1>Angebot: ${esc(p.titel)}</h1>
<p class="intro">${esc(d.salutation)}<br>vielen Dank für das nette Gespräch. Wie besprochen erhalten Sie hier mein Angebot für die neue Website von ${esc(d.company.name)}.</p>
<table><thead><tr><th>Leistung</th><th style="text-align:right">Betrag</th></tr></thead><tbody>
<tr><td><b>${esc(p.titel)}</b>${list(p.leistungen)}</td><td class="num">${euro(t.net)}</td></tr>
</tbody></table>
<table class="sum"><tbody>
<tr><td>Summe netto</td><td class="num">${euro(t.net)}</td></tr>
<tr><td>zzgl. ${c.mwst_prozent} % MwSt.</td><td class="num">${euro(t.vat)}</td></tr>
<tr class="total"><td>Gesamtbetrag (einmalig)</td><td class="num">${euro(t.gross)}</td></tr>
</tbody></table>
<div class="box"><h2>${esc(c.hosting.titel)}: ${euro(c.hosting.preis_monat_netto)} netto im Monat (${euro(c.hosting.preis_monat_netto + hostingVat)} inkl. MwSt.)</h2>
${list(c.hosting.leistungen)}<p class="small" style="margin-top:1.5mm">${esc(c.hosting.hinweis)}</p></div>
<div class="cols">
<div><h3>Was ich von Ihnen brauche</h3>${list(c.mitwirkung)}</div>
<div><h3>Ablauf und Zahlung</h3><ul><li>Lieferzeit: ${esc(c.lieferzeit)}</li><li>Zahlung: ${esc(c.zahlung)}</li></ul></div>
</div>
${
  c.optional.length
    ? `<div class="box"><h2>Optional erweiterbar</h2><ul>${c.optional
        .map((o) => `<li><b>${esc(o.titel)}</b>: ${esc(o.text)} (${esc(o.preis)})</li>`)
        .join("")}</ul></div>`
    : ""
}
<p class="sign">Ich freue mich auf Ihre Rückmeldung. Zur Beauftragung genügt eine kurze Antwort per Mail.<br><br>Viele Grüße<br>${esc(d.sender.name)}</p>
</div></body></html>`;
}

export interface OfferDeps {
  db: Db;
  render: LetterRenderer;
  config: OfferConfig;
  sender: OfferData["sender"];
  dir: string;
  now: () => Date;
}

/** Laufende Nummer je Jahr: A-2026-001. */
export async function nextOfferNumber(db: Db, now: Date): Promise<string> {
  const year = now.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", year: "numeric" });
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from interactions where type = 'note' and meta->>'angebot' like $1",
    [`A-${year}-%`],
  );
  return `A-${year}-${String((rows[0]?.n ?? 0) + 1).padStart(3, "0")}`;
}

export async function createOffer(
  deps: OfferDeps,
  company: Company,
  paket: string,
  by: string,
): Promise<{ pdf: string; filename: string; number: string; gross: number }> {
  if (!deps.config.pakete[paket]) throw new Error(`Unbekanntes Paket: ${paket}`);
  const now = deps.now();
  const number = await nextOfferNumber(deps.db, now);
  const person = await recipient(deps.db, company.id);
  const fromName = person.name ? null : personInCompanyName(company.name);
  const html = renderOfferHtml(
    {
      number,
      date: now,
      paket,
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
      sender: deps.sender,
    },
    deps.config,
  );
  const rendered = await deps.render(html);
  await mkdir(deps.dir, { recursive: true });
  const slug = company.name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .toLowerCase();
  const filename = `Angebot-${number}-${slug}.pdf`;
  const pdf = join(deps.dir, filename);
  await writeFile(pdf, rendered.pdf);
  const t = offerTotals(deps.config, paket);
  await deps.db.query(
    `insert into interactions (company_id, type, channel, body, meta, created_by, created_at)
     values ($1, 'note', 'other', $2, $3, $4, $5)`,
    [
      company.id,
      `Angebot ${number} erstellt: ${deps.config.pakete[paket].titel}, ${euro(t.gross)} brutto`,
      JSON.stringify({ angebot: number, paket, pdf, netto: t.net }),
      by,
      now,
    ],
  );
  return { pdf, filename, number, gross: t.gross };
}
