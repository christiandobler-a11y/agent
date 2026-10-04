import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import QRCode from "qrcode";
import sharp from "sharp";
import { z } from "zod";
import type { Company } from "../db/companies.js";
import { insertDraft } from "../db/drafts.js";
import { latestAudit, latestOkSnapshotId, latestPlacesSnapshot } from "../db/leads.js";
import { loadPrompt } from "../llm/config.js";
import { screenRegion } from "../pipeline/audit/images.js";
import type { Finding } from "../pipeline/audit/schema.js";
import { teaserExists, teaserPath } from "../prototype/teaser.js";
import {
  byImpact,
  complimentFact,
  pick,
  recipient,
  salutationLine,
  sanitizeDraftText,
  whatsappLink,
  type OutreachDeps,
} from "./draft.js";
import { duToIhr, type Form } from "./form.js";
import { normalizeBox, renderLetterHtml, type LetterMark } from "./letterPage.js";
import type { LetterRenderer } from "./letterPdf.js";
import { seedOf } from "./slots.js";

/**
 * Befund-Seite für einen Brief (Phase 2): Screenshot der Startseite am Rechner mit zwei bis drei roten Markierungen,
 * kurzen Notizen und ein paar Zeilen in Handschrift, QR-Code zu WhatsApp. Das LLM (Rolle `letter`) sieht den
 * Screenshot und liefert nur Markierungen (Prozent-Rechtecke), Notizen und Zeilen; Layout, Anrede, Gruß, QR-Code und
 * Kontaktdaten setzt der Code. Avelio verschickt nichts: Christian druckt aus und schreibt den Umschlag selbst.
 */

export const LETTER_PROMPT_VERSION = "v3";

const pct = z.number();
export const letterOutputSchema = z.object({
  markierungen: z
    .array(
      z.object({
        befund: z.number().int(),
        box: z.object({ x: pct, y: pct, w: pct, h: pct }).nullable(),
        notiz: z.string().min(3).max(80),
      }),
    )
    .max(3),
  zeilen: z.string().min(20).max(500),
  /** Verdeckt ein Cookie- oder Popup-Fenster einen Teil des Screenshots? */
  popup_im_bild: z.boolean(),
});

export interface LetterDeps extends OutreachDeps {
  render: LetterRenderer;
  /** Bildschirmhöhe der Desktop-Screenshots in Pixeln (config/crawl.yaml: desktop.height × scale). */
  desktopScreenPx: number;
  /** Prototyp-Screenshots (config/prototype.yaml → shots_dir) und Vorschau-Adresse für Vorher/Nachher. */
  prototype?: { shotsDir: string; baseUrl: string | null };
}

export interface LetterDraft {
  pdf: Buffer;
  png: Buffer;
  filename: string;
  /** Anschrift für den Umschlag, Zeile für Zeile (so weit bekannt). */
  envelope: string[];
  greeting: string;
  notes: string[];
  variant: number;
  costUsd: number;
  warnings: string[];
  draftId: string;
}

export type LetterOutcome = LetterDraft | { kind: "no_audit" } | { kind: "no_screenshot" };

/**
 * Für den Brief bis zu drei Befunde, wichtigster zuerst. Was man im Screenshot am Rechner sieht (Gestaltung, Inhalt,
 * Kontaktweg, Vertrauen) geht vor; Handy und Technik nur, wenn sonst weniger als zwei übrig blieben.
 */
export function pickLetterFindings(findings: readonly Finding[]): Finding[] {
  const sorted = [...findings].sort(byImpact);
  const visible = sorted.filter((f) => f.category !== "mobile" && f.category !== "technical");
  const rest = sorted.filter((f) => !visible.includes(f));
  return (visible.length >= 2 ? visible : [...visible, ...rest]).slice(0, 3);
}

/** Die Zeilen stehen für sich (nicht nach "Hallo …,"), beginnen also groß. */
export const upperFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Markierungen aus dem LLM: nur gültige Befund-Nummern, je Befund eine, Notiz ohne Gedankenstriche. */
export function normalizeMarks(
  raw: z.infer<typeof letterOutputSchema>["markierungen"],
  findingCount: number,
): LetterMark[] {
  const seen = new Set<number>();
  const marks: LetterMark[] = [];
  for (const m of raw) {
    if (m.befund < 1 || m.befund > findingCount || seen.has(m.befund)) continue;
    seen.add(m.befund);
    marks.push({ n: 0, box: normalizeBox(m.box), note: sanitizeDraftText(m.notiz).text.replace(/[.]$/, "") });
  }
  // Fortlaufend nummerieren, mit Bild-Markierungen zuerst (Nummern im Bild sollen bei 1 beginnen).
  marks.sort((a, b) => Number(Boolean(b.box)) - Number(Boolean(a.box)));
  return marks.map((m, i) => ({ ...m, n: i + 1 }));
}

const require = createRequire(import.meta.url);
let fontCache: string | null | undefined;
async function handwritingFont(): Promise<string | null> {
  if (fontCache !== undefined) return fontCache;
  try {
    const path = require.resolve("@fontsource/caveat/files/caveat-latin-500-normal.woff2");
    fontCache = `data:font/woff2;base64,${(await readFile(path)).toString("base64")}`;
  } catch {
    fontCache = null;
  }
  return fontCache;
}

export function germanDate(d: Date): string {
  return new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Berlin",
  }).format(d);
}

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .toLowerCase();

/** Für den Druck verkleinert (ca. 80 mm breit) als data:-URI. */
async function printImage(path: string): Promise<string> {
  const jpg = await sharp(path).resize({ width: 1100 }).jpeg({ quality: 82 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString("base64")}`;
}

/** Hero-Screenshot und Adresse des neuesten Prototyps (oder `null`). */
async function prototypeHero(
  db: OutreachDeps["db"],
  companyId: string,
  p: { shotsDir: string; baseUrl: string | null },
): Promise<{ dataUri: string; url: string | null } | null> {
  const { rows } = await db.query<{ slug: string }>(
    "select slug from prototypes where company_id = $1 order by created_at desc limit 1",
    [companyId],
  );
  const slug = rows[0]?.slug;
  if (!slug) return null;
  try {
    return {
      dataUri: await printImage(join(p.shotsDir, slug, "hero.jpg")),
      url: p.baseUrl ? `${p.baseUrl}/${slug}/` : null,
    };
  } catch {
    return null;
  }
}

export async function draftLetter(
  deps: LetterDeps,
  company: Company,
  by: string,
  /** Brief als Nachfassen auf eine unbeantwortete Mail (Text erwähnt die Mail). */
  opts: { followUp?: boolean } = {},
): Promise<LetterOutcome> {
  const { db, outreach: o } = deps;
  const now = deps.now();
  const audit = await latestAudit(db, company.id);
  if (!audit) return { kind: "no_audit" };
  const snapshotId = await latestOkSnapshotId(db, company.id);
  const { rows: snap } = snapshotId
    ? await db.query<{ screenshot_desktop: string | null }>(
        "select screenshot_desktop from website_snapshots where id = $1",
        [snapshotId],
      )
    : { rows: [] };
  const shotPath = snap[0]?.screenshot_desktop;
  if (!shotPath) return { kind: "no_screenshot" };
  const image = await screenRegion(shotPath, deps.desktopScreenPx, "Startseite am Rechner").catch(() => null);
  if (!image) return { kind: "no_screenshot" };

  const findings = pickLetterFindings((audit.findings as Finding[] | undefined) ?? []);
  const places = await latestPlacesSnapshot(db, company.id);
  const person = await recipient(db, company.id);
  const duBranch = company.branch_key !== null && o.du_branchen.includes(company.branch_key);
  const form: Form = !duBranch ? "sie" : person.name ? "du" : "ihr";
  const inForm = (sieText: string, duText: string) =>
    form === "sie" ? sieText : form === "du" ? duText : duToIhr(duText);

  const { rows: prior } = await db.query<{ meta: { zeilen?: string } | null }>(
    `select meta from interactions
      where company_id = $1 and type = 'draft' and channel = 'letter' order by created_at desc`,
    [company.id],
  );
  const variant = prior.length;
  const seed = seedOf(company.id);
  const previous = prior[0]?.meta?.zeilen ?? null;

  // Nachher: Kopfbereich des letzten Prototyps, falls es einen gibt.
  // Sonst das einheitliche Vorschau-Bild (ohne QR-Code, es gibt keine Seite dazu).
  const after =
    (deps.prototype ? await prototypeHero(db, company.id, deps.prototype) : null) ??
    (deps.teaserDir && teaserExists(deps.teaserDir, company.id)
      ? await printImage(teaserPath(deps.teaserDir, company.id)).then(
          (dataUri) => ({ dataUri, url: null, teaser: true }),
          () => null,
        )
      : null);

  const branch = company.branch_key ? deps.branches[company.branch_key] : undefined;
  const data = {
    entwurf_vorhanden: after !== null,
    ...(opts.followUp ? { nachfassen: true } : {}),
    betrieb: { name: company.name, ort: company.city, branche: branch?.label ?? company.category },
    anrede: form,
    befunde: findings.map((f, i) => ({
      nr: i + 1,
      titel: f.title,
      detail: f.detail,
      beleg: f.evidence,
      kategorie: f.category,
    })),
    kompliment_fakt: complimentFact(places),
    ...(previous ? { vorheriger_text: previous } : {}),
  };
  const run = () =>
    deps.llm.structured({
      role: "letter",
      promptVersion: LETTER_PROMPT_VERSION,
      system: loadPrompt("letter", LETTER_PROMPT_VERSION),
      input: [
        { type: "text", text: "Screenshot der Startseite am Rechner (erster Bildschirm):" },
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
        { type: "text", text: `<daten>\n${JSON.stringify(data)}\n</daten>` },
      ],
      schema: letterOutputSchema,
      companyId: company.id,
      inputSummary: `Befund-Seite ${company.name}`,
    });
  let result = await run();
  let cost = result.costUsd;
  let lines = sanitizeDraftText(result.output.zeilen);
  if (lines.warnings.some((w) => w.startsWith("Spam-Wort"))) {
    result = await run();
    cost += result.costUsd;
    lines = sanitizeDraftText(result.output.zeilen);
  }
  const marks = normalizeMarks(result.output.markierungen, findings.length);

  const b = o.brief;
  const greeting = salutationLine(
    form,
    person,
    company.name,
    o.team_anrede[company.branch_key ?? ""]?.anrede,
  );
  const whatsapp = deps.contact.whatsapp;
  const qr = whatsapp
    ? {
        svg: await QRCode.toString(
          whatsappLink(
            whatsapp,
            form === "sie" ? o.kontaktweg.whatsapp_text_sie : o.kontaktweg.whatsapp_text,
          ),
          { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#1d3557", light: "#ffffff" } },
        ),
        text: inForm(b.qr_text, b.qr_text_du),
      }
    : null;
  const phone = deps.contact.phone;
  const phoneLine = phone ? (qr ? `${b.qr_text_telefon}\n${phone}` : phone) : null;
  const datum = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin" }).format(now);
  const html = renderLetterHtml({
    dateLine: `Peißenberg, ${germanDate(now)}`,
    greeting,
    image: {
      dataUri: `data:${image.mediaType};base64,${image.data}`,
      width: image.width,
      height: image.height,
    },
    caption: inForm(b.bildunterschrift, b.bildunterschrift_du).replace("{datum}", datum),
    marks,
    lines: upperFirst(lines.text),
    closing: pick(b.gruss, seed, 13, variant),
    signature: b.unterschrift,
    qr,
    after: after
      ? {
          dataUri: after.dataUri,
          label: inForm("So könnte Ihre Seite aussehen:", "So könnte eure Seite aussehen:"),
          qrSvg: after.url
            ? await QRCode.toString(after.url, {
                type: "svg",
                margin: 0,
                errorCorrectionLevel: "M",
                color: { dark: "#1d3557", light: "#ffffff" },
              })
            : null,
          qrText: after.url ? inForm("Ganzen Entwurf ansehen", "Ganzen Entwurf ansehen") : null,
        }
      : null,
    phoneLine,
    footer: [o.absender_name, o.absender_zusatz, phone].filter(Boolean).join(" · "),
    fontDataUri: await handwritingFont(),
    seed: seed + variant,
  });
  const rendered = await deps.render(html);

  const envelope = [
    person.name,
    company.name,
    company.street,
    [company.postal_code, company.city].filter(Boolean).join(" ") || null,
  ].filter((l): l is string => Boolean(l));
  const warnings = [...lines.warnings];
  if (result.output.popup_im_bild)
    warnings.push(
      "Ein Cookie-Hinweis verdeckt den Screenshot; ggf. neu crawlen und Befund-Seite neu erstellen",
    );
  if (marks.filter((m) => m.box).length === 0) warnings.push("Keine Stelle im Bild markiert, bitte prüfen");
  if (!company.street || !company.postal_code)
    warnings.push("Anschrift unvollständig, bitte im Impressum prüfen");
  if (after && !after.url && !("teaser" in after))
    warnings.push("Vorschau-Adresse fehlt (PREVIEW_BASE_URL), daher kein QR-Code zum Entwurf");
  if (!whatsapp) warnings.push("WhatsApp-Nummer fehlt (OUTREACH_WHATSAPP), daher kein QR-Code");

  const notes = marks.map((m) => `${m.n}. ${m.note}`);
  const draft = await insertDraft(db, company.id, {
    channel: "letter",
    body: [greeting, ...notes, upperFirst(lines.text)].join("\n\n"),
    meta: {
      prompt: LETTER_PROMPT_VERSION,
      variant,
      marks,
      zeilen: lines.text,
      envelope,
      snapshot_id: snapshotId,
    },
    by,
    now,
  });
  return {
    pdf: rendered.pdf,
    png: rendered.png,
    filename: `befund-${slug(company.name) || "seite"}.pdf`,
    envelope,
    greeting,
    notes,
    variant: variant + 1,
    costUsd: Math.round(cost * 1000) / 1000,
    warnings,
    draftId: draft.id,
  };
}
