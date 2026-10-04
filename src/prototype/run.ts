import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";
import { recordApiUsage } from "../db/apiUsage.js";
import type { Db } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { designNotes } from "../db/designNotes.js";
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

export const PROTOTYPE_PROMPT_VERSION = "v4";

const configSchema = z.object({
  previews_dir: z.string(),
  shots_dir: z.string(),
  keep_days: z.number().int().min(1),
  templates: z.record(z.string(), z.string()),
  fallback: z.string(),
  // Einheitliches Vorschau-Bild statt Prototyp (src/prototype/teaser.ts) für diese Branchen.
  teaser: z
    .object({
      dir: z.string(),
      branchen: z.array(z.string()),
      stil: z.enum(["welt", "vital", "rund", "mix", "elementa"]).default("welt"),
      geraete: z.boolean().default(false),
    })
    .default({ dir: "data/teasers", branchen: [], stil: "welt", geraete: false }),
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

/** Unter dieser Breite wird ein Foto im Hero (volle Bildschirmbreite) sichtbar unscharf. */
export const MIN_HERO_WIDTH = 1000;
/** Breitere Bilder sind Werbestreifen; im Hero (Querformat-Ausschnitt) würden sie unscharf vergrößert. */
export const MAX_HERO_RATIO = 2.6;
/** Dateinamen von Werbegrafiken mit Text (Slider, Aktionen), die das LLM trotz Anweisung gern als Hero nimmt. */
const BANNERISH =
  /slider|banner|aktion|angebot|gutschein|flyer|plakat|sale|rabatt|opening|eroeffnung|er%C3%B6ffnung/i;

function heroWorthy(p: { url: string; w: number; h: number }): boolean {
  const file = p.url.split("?")[0]?.split("/").pop() ?? "";
  return p.w >= MIN_HERO_WIDTH && p.w / p.h <= MAX_HERO_RATIO && !BANNERISH.test(file);
}

/**
 * Fotowahl des LLM (hat die Vorschaubilder gesehen) in Adressen übersetzen. Ungültige Nummern werden ignoriert, ein zu
 * kleines Hero-Foto (oder ein Werbestreifen bzw. Slider) ersetzt der Code durch das größte gute Querformat (aus den vom LLM gebilligten Fotos, falls es
 * welche gebilligt hat).
 */
export function pickPhotos(
  out: Pick<PrototypeOutput, "hero_foto" | "ueber_uns_foto" | "galerie_fotos"> & {
    abgelehnte_fotos?: number[];
  },
  all: SiteImages["photos"],
): { hero: string | null; about: string | null; gallery: string[] } {
  // Abgelehnte Fotos (Banner, Grafiken) gibt es für diese Seite nicht, auch nicht als Ersatz.
  const rejected = new Set((out.abgelehnte_fotos ?? []).map((i) => all[i - 1]?.url));
  const photos = all.map((p) => (rejected.has(p.url) ? null : p));
  const at = (i: number | null) =>
    i !== null && i >= 1 && i <= photos.length ? (photos[i - 1] ?? null) : null;
  const approved = [out.hero_foto, out.ueber_uns_foto, ...out.galerie_fotos]
    .map(at)
    .filter((p): p is SiteImages["photos"][number] => p !== null);
  const chosen = at(out.hero_foto);
  // Größtes scharfes Querformat, zuerst unter den gebilligten Fotos, notfalls unter allen: ein Hero ohne Bild wirkt
  // schwächer als z. B. eine Landschaft der Region.
  const widest = (list: SiteImages["photos"]) =>
    list.filter((p) => heroWorthy(p) && p.w / p.h >= 1.3).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const landscape =
    widest(approved) ?? widest(photos.filter((p): p is SiteImages["photos"][number] => p !== null));
  const hero = (chosen && heroWorthy(chosen) ? chosen : landscape)?.url ?? null;
  const aboutPick = at(out.ueber_uns_foto)?.url ?? null;
  const about = aboutPick === hero ? null : aboutPick;
  const gallery = [...new Set(out.galerie_fotos.map(at).map((p) => p?.url))].filter(
    (u): u is string => Boolean(u) && u !== hero && u !== about,
  );
  return { hero, about, gallery };
}

/**
 * Duzt oder siezt die Website ihre Kunden? Zählt eindeutige Formen ("du", "dein", "Ihnen", "Ihre" mitten im Satz).
 * `null`, wenn es nicht klar ist (dann entscheidet die Branche).
 */
export function siteForm(text: string): "sie" | "du" | null {
  const du = (text.match(/\b(du|dich|dir|dein|deine|deinen|deinem|deiner|euch|euer|eure)\b/gi) ?? []).length;
  // Großgeschriebene Höflichkeitsformen nicht am Satzanfang (dort wären es auch "Ihr Team" o. ä.).
  const sie = (text.match(/[a-zäöüß,]\s+(Sie|Ihnen|Ihre|Ihren|Ihrem|Ihrer)\b/g) ?? []).length;
  if (du >= 3 && du > sie * 2) return "du";
  if (sie >= 3 && sie > du * 2) return "sie";
  return null;
}

/** Handwerk und Dienstleister ohne Laden (Vorlage "werkstatt", außer Fahrradhandel). */
export function isCompanySite(branchKey: string | null, config: PrototypeConfig): boolean {
  return branchKey !== null && branchKey !== "fahrrad" && config.templates[branchKey] === "werkstatt";
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
    heroLines: out.hero_zeilen.slice(0, 3).map(clean),
    brands: out.marken.slice(0, 10).map(clean),
    range: out.sortiment
      .slice(0, 6)
      .map((r) => ({ kind: r.art, title: clean(r.titel), text: clean(r.text) })),
    leasing: { offered: out.leasing, partners: out.leasing_partner.slice(0, 10).map(clean) },
    city: c.city,
    previewNote: "",
  };
}

/** Jede Adresse nur einmal laden (Vorschau fürs LLM und Bau der Seite). */
export function memoFetcher(fetchImage: ImageFetcher): ImageFetcher {
  const cache = new Map<string, Promise<Buffer | null>>();
  return (url) => {
    let p = cache.get(url);
    if (!p) {
      p = fetchImage(url);
      cache.set(url, p);
    }
    return p;
  };
}

/** Kleine Vorschaubilder (384 px breit, ca. 200 Tokens je Bild) der ladbaren Fotos. */
export async function photoThumbnails(
  photos: SiteImages["photos"],
  fetchImage: ImageFetcher,
): Promise<{ photo: SiteImages["photos"][number]; data: string }[]> {
  const out: { photo: SiteImages["photos"][number]; data: string }[] = [];
  for (const photo of photos) {
    const buf = await fetchImage(photo.url);
    if (!buf) continue;
    try {
      const jpg = await sharp(buf, { animated: false, limitInputPixels: 60_000_000 })
        .rotate()
        .resize({ width: 384, height: 384, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      out.push({ photo, data: jpg.toString("base64") });
    } catch {
      // kein lesbares Bild
    }
  }
  return out;
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

  // Die Anrede, die der Betrieb selbst auf seiner Website nutzt; sonst nach Branche.
  const form: "sie" | "du" =
    siteForm(snap.text_excerpt ?? "") ??
    (company.branch_key && deps.duBranches.includes(company.branch_key) ? "du" : "sie");
  const branch = company.branch_key ? deps.branches[company.branch_key] : undefined;
  const inspiration = loadInspiration();
  // Christians Vorbild-Notizen aus der Kalibrierung (/kalibrieren → 💡), neueste zuerst, je Branche.
  const notes = company.branch_key ? await designNotes(db, company.branch_key, 8) : [];
  const shot = await screenRegion(snap.screenshot_desktop, deps.desktopScreenPx, "Bisherige Startseite");
  // Fotos einmal laden (auch für den Bau), Vorschaubilder fürs LLM; was nicht lädt, fällt aus der Liste.
  const fetchImage = memoFetcher(deps.fetchImage ?? httpImageFetcher());
  const thumbs = await photoThumbnails(images.photos.slice(0, 12), fetchImage);
  images.photos = thumbs.map((t) => t.photo);
  const data = {
    betrieb: { name: company.name, ort: company.city },
    branche: branch?.label ?? company.category,
    anrede: form,
    website_text: (snap.text_excerpt ?? "").slice(0, 9000),
    logo_vorhanden: Boolean(images.logo),
    google: places?.rating ? { sterne: places.rating, bewertungen: places.review_count } : null,
    audit_befunde: ((audit?.findings as Finding[] | undefined) ?? []).slice(0, 6).map((f) => f.title),
    vorbilder: [
      ...(inspiration[company.branch_key ?? ""] ?? []),
      // Betriebe ohne Laden (Handwerk, Dienstleister): Vorbild Unternehmensseite.
      ...(isCompanySite(company.branch_key, deps.config) ? (inspiration.unternehmen ?? []) : []),
      ...(inspiration.alle ?? []),
    ]
      .flatMap((v) => v.merkmale)
      .concat(notes.map((n) => `Christian gefällt an ${n.name}: ${n.note}`)),
  };
  const result = await deps.llm.structured({
    role: "prototype",
    promptVersion: PROTOTYPE_PROMPT_VERSION,
    system: loadPrompt("prototype", PROTOTYPE_PROMPT_VERSION),
    input: [
      { type: "text", text: "Screenshot der bisherigen Startseite (erster Bildschirm am Rechner):" },
      { type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.data } },
      ...thumbs.flatMap((t, i) => [
        {
          type: "text" as const,
          text: `Foto ${i + 1} (${t.photo.w}×${t.photo.h} px${t.photo.alt ? `, Beschreibung: ${t.photo.alt}` : ""}):`,
        },
        {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/jpeg" as const, data: t.data },
        },
      ]),
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
  const template = deps.config.templates[company.branch_key ?? ""] ?? deps.config.fallback;
  const built = await buildSite(content, dir, fetchImage, template);
  if (built.images === 0) warnings.push("Keine Fotos geladen, Seite nutzt Farbflächen");
  const shoot = deps.shoot ?? chromiumShooter(process.env.CHROMIUM_PATH);
  const shots = await shoot(join(process.cwd(), dir, "index.html"), join(deps.config.shots_dir, slug));

  const { rows } = await db.query<{ id: string }>(
    `insert into prototypes (company_id, slug, template, content, prompt_version, cost_usd, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      company.id,
      slug,
      template,
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
