import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";
import { recordApiUsage } from "../db/apiUsage.js";
import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { latestAudit, latestOkSnapshotId, latestPlacesSnapshot } from "../db/leads.js";
import type { BudgetGuard } from "../llm/budget.js";
import { loadPrompt } from "../llm/config.js";
import type { LlmGateway } from "../llm/gateway.js";
import { screenRegion } from "../pipeline/audit/images.js";
import type { Finding } from "../pipeline/audit/schema.js";
import { isUsablePhotoUrl, type SiteImages } from "../pipeline/crawl/images.js";
import { loadInspiration } from "../pipeline/inspiration.js";
import type { Branches } from "../pipeline/research/branches.js";
import { buildSite, httpImageFetcher, type ImageFetcher } from "./build.js";
import { prototypeOutputSchema, type PrototypeOutput, type SiteContent } from "./content.js";
import { fetchPlaceDetails, PLACE_DETAILS_COST_USD, type PlaceDetails } from "./placeDetails.js";

/**
 * Prototyp bauen (Phase 3): Fakten aus Crawl, Google und Impressum, Texte/Farbe/Fotowahl vom LLM (Rolle `prototype`),
 * Gestaltung aus der Branchen-Vorlage. Ergebnis ist eine statische Seite unter PREVIEW_BASE_URL/<slug>/ und
 * Screenshots für Nachrichten (Vorher/Nachher).
 */

export const PROTOTYPE_PROMPT_VERSION = "v1";

const configSchema = z.object({
  previews_dir: z.string(),
  shots_dir: z.string(),
  keep_days: z.number().int().min(1),
  templates: z.record(z.string(), z.string()),
  fallback: z.string(),
});
export type PrototypeConfig = z.infer<typeof configSchema>;
export const loadPrototypeConfig = () => loadYamlConfig("prototype.yaml", configSchema);

export interface PrototypeDeps {
  db: Db;
  llm: LlmGateway;
  budget: BudgetGuard;
  branches: Branches;
  config: PrototypeConfig;
  duBranches: readonly string[];
  now: () => Date;
  googleApiKey: string | null;
  baseUrl: string | null;
  desktopScreenPx: number;
  fetchImage?: ImageFetcher;
  fetchDetails?: (placeId: string) => Promise<PlaceDetails>;
  /** Screenshots der fertigen Seite; ohne Angabe Chromium. */
  shoot?: (indexFile: string, outDir: string) => Promise<PrototypeShots>;
}

export interface PrototypeShots {
  /** Erster Bildschirm am Rechner (für Vorher/Nachher). */
  hero: string;
  /** Ganze Seite am Rechner (Vorschau in Telegram). */
  full: string;
  mobile: string;
}

export interface PrototypeResult {
  id: string;
  url: string | null;
  dir: string;
  shots: PrototypeShots;
  content: SiteContent;
  costUsd: number;
  warnings: string[];
}

export type PrototypeOutcome = PrototypeResult | { kind: "no_snapshot" };

const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);

/** Fotowahl des LLM in Adressen übersetzen; ungültige Nummern ignorieren. */
export function pickPhotos(
  out: Pick<PrototypeOutput, "hero_foto" | "ueber_uns_foto">,
  photos: SiteImages["photos"],
): { hero: string | null; about: string | null; gallery: string[] } {
  const at = (i: number | null) => (i !== null && i >= 1 && i <= photos.length ? photos[i - 1]!.url : null);
  // Ohne Wahl: das größte Querformat-Foto (ein Hero ohne Bild überzeugt deutlich weniger).
  const landscape = photos
    .filter((p) => p.w >= 1000 && p.w / p.h >= 1.3)
    .sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const hero = at(out.hero_foto) ?? landscape?.url ?? null;
  const about = at(out.ueber_uns_foto) === hero ? null : at(out.ueber_uns_foto);
  return { hero, about, gallery: photos.map((p) => p.url).filter((u) => u !== hero && u !== about) };
}

/** Text ohne Gedankenstriche (Christians Regel gilt auch hier). */
const clean = (t: string) => t.replace(/\s*[–—]\s*/g, ", ").trim();

export function toSiteContent(
  out: PrototypeOutput,
  facts: {
    form: "sie" | "du";
    company: Company;
    images: SiteImages;
    rating: number | null;
    reviewCount: number | null;
    details: PlaceDetails | null;
    email: string | null;
  },
): SiteContent {
  const photos = pickPhotos(out, facts.images.photos);
  const c = facts.company;
  const address =
    [c.street, [c.postal_code, c.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null;
  return {
    form: facts.form,
    name: clean(out.anzeigename),
    claim: clean(out.claim),
    // Handschrift wirkt nur kurz; zu lange Sätze lieber weglassen.
    handwriting: out.handschrift && out.handschrift.length <= 40 ? clean(out.handschrift) : null,
    primary: out.markenfarbe,
    logo: facts.images.logo,
    hero: { headline: clean(out.hero.ueberschrift), text: clean(out.hero.text), image: photos.hero },
    trust: out.vertrauen.slice(0, 4).map(clean),
    services: out.leistungen
      .slice(0, 8)
      .map((l) => ({ title: clean(l.titel), text: clean(l.text), icon: l.icon })),
    about: { title: clean(out.ueber_uns.titel), text: clean(out.ueber_uns.text), image: photos.about },
    steps: out.ablauf.slice(0, 3).map((s) => ({ title: clean(s.titel), text: clean(s.text) })),
    reviews: {
      rating: facts.rating,
      count: facts.reviewCount,
      quotes: (facts.rating ?? 0) >= 4 ? (facts.details?.quotes ?? []) : [],
    },
    gallery: photos.gallery,
    contact: {
      address,
      phone: c.phone,
      email: facts.email,
      hours: facts.details?.hours ?? [],
      mapsUrl:
        facts.details?.mapsUrl ??
        (address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null),
    },
    cta: clean(out.cta),
    previewNote: "",
  };
}

export function chromiumShooter(executablePath?: string) {
  return async (indexFile: string, outDir: string): Promise<PrototypeShots> => {
    await mkdir(outDir, { recursive: true });
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    try {
      const shots = {
        hero: join(outDir, "hero.jpg"),
        full: join(outDir, "full.jpg"),
        mobile: join(outDir, "mobile.jpg"),
      };
      const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await desktop.goto(`file://${indexFile}`, { waitUntil: "load" });
      await desktop.evaluate("document.fonts.ready.then(() => true)");
      await desktop.screenshot({ path: shots.hero, type: "jpeg", quality: 82 });
      await desktop.screenshot({ path: shots.full, type: "jpeg", quality: 70, fullPage: true });
      const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      await mobile.goto(`file://${indexFile}`, { waitUntil: "load" });
      await mobile.evaluate("document.fonts.ready.then(() => true)");
      await mobile.screenshot({ path: shots.mobile, type: "jpeg", quality: 75 });
      return shots;
    } finally {
      await browser.close();
    }
  };
}

export async function buildPrototype(
  deps: PrototypeDeps,
  company: Company,
  by: string,
): Promise<PrototypeOutcome> {
  const { db } = deps;
  const snapshotId = await latestOkSnapshotId(db, company.id);
  if (!snapshotId) return { kind: "no_snapshot" };
  const { rows: snaps } = await db.query<{
    screenshot_desktop: string | null;
    text_excerpt: string | null;
    facts: { images?: SiteImages; mailto_links?: string[] } | null;
  }>("select screenshot_desktop, text_excerpt, facts from website_snapshots where id = $1", [snapshotId]);
  const snap = snaps[0]!;
  if (!snap.screenshot_desktop) return { kind: "no_snapshot" };
  const stored: SiteImages = snap.facts?.images ?? { logo: null, photos: [] };
  // Auch ältere Erfassungen nachfiltern (Texturen, Icons).
  const images: SiteImages = { ...stored, photos: stored.photos.filter((p) => isUsablePhotoUrl(p.url)) };
  const warnings: string[] = [];
  if (!snap.facts?.images)
    warnings.push("Ohne Bilder gecrawlt (alter Stand): erst neu crawlen für echte Fotos");

  const audit = await latestAudit(db, company.id);
  const places = await latestPlacesSnapshot(db, company.id);
  const { rows: contacts } = await db.query<{ email: string | null; source: string }>(
    "select email, source from contacts where company_id = $1 and email is not null order by created_at",
    [company.id],
  );
  const email = contacts.find((c) => c.source === "impressum")?.email ?? contacts[0]?.email ?? null;

  let cost = 0;
  let details: PlaceDetails | null = null;
  const fetchDetails =
    deps.fetchDetails ??
    (deps.googleApiKey ? (id: string) => fetchPlaceDetails(deps.googleApiKey!, id) : undefined);
  if (company.place_id && fetchDetails) {
    try {
      await deps.budget.assertAvailable();
      details = await fetchDetails(company.place_id);
      await recordApiUsage(db, {
        service: "google_places",
        operation: "place_details_prototype",
        costUsd: PLACE_DETAILS_COST_USD,
        companyId: company.id,
      });
      cost += PLACE_DETAILS_COST_USD;
    } catch (err) {
      warnings.push(
        `Google-Details fehlen: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
    }
  }

  const form: "sie" | "du" =
    company.branch_key && deps.duBranches.includes(company.branch_key) ? "du" : "sie";
  const branch = company.branch_key ? deps.branches[company.branch_key] : undefined;
  const inspiration = loadInspiration();
  const shot = await screenRegion(snap.screenshot_desktop, deps.desktopScreenPx, "Bisherige Startseite");
  const data = {
    betrieb: { name: company.name, ort: company.city },
    branche: branch?.label ?? company.category,
    anrede: form,
    website_text: (snap.text_excerpt ?? "").slice(0, 9000),
    fotos: images.photos.map((p, i) => ({ nr: i + 1, beschreibung: p.alt || null, breite: p.w, hoehe: p.h })),
    logo_vorhanden: Boolean(images.logo),
    google: places?.rating ? { sterne: places.rating, bewertungen: places.review_count } : null,
    audit_befunde: ((audit?.findings as Finding[] | undefined) ?? []).slice(0, 6).map((f) => f.title),
    vorbilder: [...(inspiration[company.branch_key ?? ""] ?? []), ...(inspiration.alle ?? [])].flatMap(
      (v) => v.merkmale,
    ),
  };
  const result = await deps.llm.structured({
    role: "prototype",
    promptVersion: PROTOTYPE_PROMPT_VERSION,
    system: loadPrompt("prototype", PROTOTYPE_PROMPT_VERSION),
    input: [
      { type: "text", text: "Screenshot der bisherigen Startseite (erster Bildschirm am Rechner):" },
      { type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.data } },
      { type: "text", text: `<daten>\n${JSON.stringify(data)}\n</daten>` },
    ],
    schema: prototypeOutputSchema,
    companyId: company.id,
    inputSummary: `Prototyp ${company.name}`,
  });
  cost += result.costUsd;

  const content = toSiteContent(result.output, {
    form,
    company,
    images,
    rating: places?.rating ?? null,
    reviewCount: places?.review_count ?? null,
    details,
    email,
  });

  // Gleicher Pfad beim Neubau (Links in verschickten Nachrichten bleiben gültig).
  const { rows: existing } = await db.query<{ slug: string }>(
    "select slug from prototypes where company_id = $1 order by created_at desc limit 1",
    [company.id],
  );
  const slug = existing[0]?.slug ?? `${slugify(content.name) || "entwurf"}-${randomBytes(4).toString("hex")}`;
  const dir = join(deps.config.previews_dir, slug);
  await rm(dir, { recursive: true, force: true });
  const built = await buildSite(content, dir, deps.fetchImage ?? httpImageFetcher());
  if (built.images === 0) warnings.push("Keine Fotos geladen, Seite nutzt Farbflächen");
  const shoot = deps.shoot ?? chromiumShooter(process.env.CHROMIUM_PATH);
  const shots = await shoot(join(process.cwd(), dir, "index.html"), join(deps.config.shots_dir, slug));

  const { rows } = await db.query<{ id: string }>(
    `insert into prototypes (company_id, slug, template, content, prompt_version, cost_usd, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      company.id,
      slug,
      deps.config.templates[company.branch_key ?? ""] ?? deps.config.fallback,
      JSON.stringify(built.content),
      PROTOTYPE_PROMPT_VERSION,
      cost.toFixed(5),
      by,
    ],
  );
  await db.query(
    `insert into interactions (company_id, type, body, created_by, created_at) values ($1, 'note', $2, $3, $4)`,
    [company.id, `Prototyp gebaut: ${deps.baseUrl ? `${deps.baseUrl}/${slug}/` : dir}`, by, deps.now()],
  );
  return {
    id: rows[0]!.id,
    url: deps.baseUrl ? `${deps.baseUrl}/${slug}/` : null,
    dir,
    shots,
    content: built.content,
    costUsd: Math.round(cost * 1000) / 1000,
    warnings,
  };
}

/**
 * Alte Vorschauen löschen (einmal am Tag aus dem Sweep): älter als keep_days und der Lead ist nicht mehr im
 * Gespräch. Gibt die gelöschten Pfade zurück.
 */
export async function cleanupPrototypes(db: Db, config: PrototypeConfig, now: Date): Promise<string[]> {
  const { rows } = await db.query<{ slug: string }>(
    `select p.slug from prototypes p join companies c on c.id = p.company_id
      group by p.slug, c.status
     having max(p.created_at) < $1::timestamptz - make_interval(days => $2)
        and c.status not in ('REPLIED', 'INTERESTED', 'PROTOTYPE', 'WON')`,
    [now, config.keep_days],
  );
  for (const r of rows) {
    await rm(join(config.previews_dir, r.slug), { recursive: true, force: true });
    await rm(join(config.shots_dir, r.slug), { recursive: true, force: true });
  }
  return rows.map((r) => r.slug);
}
