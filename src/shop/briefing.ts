import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { latestAudit, latestPlacesSnapshot } from "../db/leads.js";
import { loadPrompt } from "../llm/config.js";
import type { LlmGateway } from "../llm/gateway.js";
import type { Finding } from "../pipeline/audit/schema.js";
import { screenRegion } from "../pipeline/audit/images.js";
import type { PlaceDetails } from "../prototype/placeDetails.js";
import { rankCandidates, rankLogos, type PageImages } from "../prototype/heroPhoto.js";
import { usedDirections } from "./pick.js";

/**
 * Design-Briefing für den Laden der Woche (06.10.2026): Daten aus Crawl, Audit und Google plus drei klar verschiedene
 * Designrichtungen (Rolle `briefing`, sieht den Screenshot der jetzigen Startseite). Christian wählt eine Richtung, die
 * Seite bauen er und Claude von Hand. Gewählte Richtungen gehen in künftige Briefings als „schon verwendet“ ein.
 */

export const BRIEFING_PROMPT = "v1";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const directionSchema = z.object({
  name: z.string(),
  idee: z.string(),
  grundform: z.string(),
  stimmung: z.string(),
  farben: z.array(hex),
  schriften: z.object({ titel: z.string(), text: z.string() }),
  layout: z.string(),
  signatur_element: z.string(),
  bildsprache: z.string(),
  textton: z.string(),
  warum: z.string(),
});

export const briefingSchema = z.object({
  laden_kurz: z.string(),
  zielgruppe: z.string(),
  staerken: z.array(z.string()),
  schwaechen_alte_seite: z.array(z.string()),
  inhalte: z.array(z.string()),
  richtungen: z.array(directionSchema),
  gespraech: z.array(z.string()),
  fotos_vor_ort: z.array(z.string()),
});

export type Direction = z.infer<typeof directionSchema>;
export type BriefingOutput = z.infer<typeof briefingSchema>;

/** Gespeichertes Briefing: Ausgabe des LLM plus die Fakten, die Christian beim Bauen braucht. */
export interface Briefing extends BriefingOutput {
  laden: {
    name: string;
    ort: string | null;
    adresse: string | null;
    telefon: string | null;
    website: string | null;
    bewertung: string | null;
    oeffnungszeiten: string[];
    fotos: string[];
    logo: string | null;
  };
}

export interface BriefingDeps {
  db: Db;
  llm: LlmGateway;
  /** Fotos und Logo von der Startseite (heroPhoto.ts → collectCandidates). */
  collect: (url: string) => Promise<PageImages>;
  hours?: ((company: Company) => Promise<string[]>) | null;
  details?: ((company: Company) => Promise<PlaceDetails | null>) | null;
  /** Bildschirmhöhe des Desktop-Screenshots in Pixeln. */
  desktopScreenPx: number;
  branchLabel?: (key: string | null) => string | null;
}

export async function buildBriefing(deps: BriefingDeps, company: Company): Promise<Briefing> {
  const { db } = deps;
  const { rows: snap } = await db.query<{
    screenshot_desktop: string | null;
    facts: { title?: string | null; h1?: string[]; nav_items?: string[]; cms?: string | null } | null;
  }>(
    `select screenshot_desktop, facts from website_snapshots
      where company_id = $1 and error is null order by fetched_at desc limit 1`,
    [company.id],
  );
  const audit = await latestAudit(db, company.id);
  const findings = ((audit?.findings as Finding[] | undefined) ?? []).slice(0, 6);
  const places = await latestPlacesSnapshot(db, company.id);
  const hours = deps.hours ? await deps.hours(company).catch(() => []) : [];
  const details = deps.details ? await deps.details(company).catch(() => null) : null;
  const url = company.website_url
    ? /^https?:\/\//i.test(company.website_url)
      ? company.website_url
      : `https://${company.website_url}`
    : null;
  const page = url
    ? await deps.collect(url).catch(() => ({ images: [], logos: [] }))
    : { images: [], logos: [] };
  const fotos = rankCandidates(page.images, 8).map((c) => c.url);
  const logo = rankLogos(page.logos)[0]?.url ?? null;
  const rating =
    places?.rating != null
      ? `${places.rating.toFixed(1).replace(".", ",")} bei ${places.review_count ?? 0} Bewertungen`
      : null;

  const data = {
    laden: {
      name: company.name,
      ort: company.city,
      branche: deps.branchLabel?.(company.branch_key) ?? company.category,
      google: rating,
      oeffnungszeiten: hours,
    },
    jetzige_seite: {
      titel: snap[0]?.facts?.title ?? null,
      ueberschriften: snap[0]?.facts?.h1 ?? [],
      menue: snap[0]?.facts?.nav_items ?? [],
      baukasten: snap[0]?.facts?.cms ?? null,
    },
    befunde: findings.map((f) => ({ titel: f.title, detail: f.detail, schwere: f.severity })),
    fotos,
    logo,
    bewertungen: (details?.quotes ?? []).map((q) => q.text),
    schon_verwendet: await usedDirections(db),
  };

  const shot = snap[0]?.screenshot_desktop;
  const image = shot ? await screenRegion(shot, deps.desktopScreenPx, "Startseite").catch(() => null) : null;
  const result = await deps.llm.structured({
    role: "briefing",
    promptVersion: BRIEFING_PROMPT,
    system: loadPrompt("briefing", BRIEFING_PROMPT),
    input: [
      ...(image
        ? [
            { type: "text" as const, text: "Screenshot der jetzigen Startseite (erster Bildschirm):" },
            {
              type: "image" as const,
              source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
            },
          ]
        : []),
      { type: "text", text: `<daten>\n${JSON.stringify(data, null, 1)}\n</daten>` },
    ],
    schema: briefingSchema,
    companyId: company.id,
    inputSummary: `Design-Briefing ${company.name}`,
  });
  return {
    ...result.output,
    richtungen: result.output.richtungen.slice(0, 3),
    laden: {
      name: company.name,
      ort: company.city,
      adresse:
        [company.street, [company.postal_code, company.city].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(", ") || null,
      telefon: company.phone,
      website: url,
      bewertung: rating,
      oeffnungszeiten: hours,
      fotos,
      logo,
    },
  };
}

/** Briefing als Markdown (Datei für Telegram, zum Mitbringen in die Claude-Session). Rein. */
export function briefingMarkdown(b: Briefing, chosen: number | null = null): string {
  const l = b.laden;
  const list = (items: readonly string[]) => items.map((i) => `- ${i}`).join("\n");
  const dir = (d: Direction, i: number) =>
    [
      `### ${String.fromCharCode(65 + i)}: ${d.name}${chosen === i ? " (gewählt)" : ""}`,
      "",
      d.idee,
      "",
      `- **Grundform:** ${d.grundform}`,
      `- **Stimmung:** ${d.stimmung}`,
      `- **Farben:** ${d.farben.join(", ")}`,
      `- **Schriften:** ${d.schriften.titel} (Überschriften), ${d.schriften.text} (Text)`,
      `- **Aufbau:** ${d.layout}`,
      `- **Signatur-Element:** ${d.signatur_element}`,
      `- **Bildsprache:** ${d.bildsprache}`,
      `- **Textton:** ${d.textton}`,
      `- **Warum:** ${d.warum}`,
    ].join("\n");
  return [
    `# Laden der Woche: ${l.name}`,
    "",
    [l.adresse, l.telefon, l.website, l.bewertung ? `Google: ${l.bewertung}` : null]
      .filter(Boolean)
      .join(" · "),
    "",
    b.laden_kurz,
    "",
    `**Zielgruppe:** ${b.zielgruppe}`,
    "",
    "## Stärken",
    list(b.staerken),
    "",
    "## Was an der jetzigen Seite auffällt",
    list(b.schwaechen_alte_seite),
    "",
    "## Inhalte der neuen Seite",
    list(b.inhalte),
    "",
    "## Drei Richtungen",
    "",
    b.richtungen.map(dir).join("\n\n"),
    "",
    "## Im Laden",
    list(b.gespraech),
    "",
    "## Vor Ort fotografieren",
    list(b.fotos_vor_ort),
    ...(l.oeffnungszeiten.length > 0 ? ["", "## Öffnungszeiten", list(l.oeffnungszeiten)] : []),
    ...(l.fotos.length > 0 || l.logo
      ? ["", "## Material von der jetzigen Seite", list([...(l.logo ? [`Logo: ${l.logo}`] : []), ...l.fotos])]
      : []),
    "",
  ].join("\n");
}
