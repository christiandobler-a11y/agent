import { lookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { z } from "zod";
import { getState, setState } from "../db/appState.js";
import type { DbClient } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { loadPrompt } from "../llm/config.js";
import type { LlmGateway } from "../llm/gateway.js";
import { derivePalette, type HeroPalette } from "./colors.js";

/**
 * Hero-Foto aus der eigenen Website der Praxis (05.10.2026, Christian: "das bringt mehr Nähe als ein generisches
 * Bild", aber es muss passen). Ablauf:
 * 1. Browser öffnet die Startseite und sammelt große Bilder (img, Hintergrundbilder, og:image). Kein LLM.
 * 2. Regeln im Code (rein, `rankCandidates`/`qualityOk`): Querformat, groß genug, kein Logo/Icon/Karte/Siegel,
 *    nicht flach wie eine Grafik oder ein Text-Banner.
 * 3. Die besten bis zu vier zeigt Code dem Modell (Rolle `hero`, ohne Werkzeuge, festes Schema); es nimmt nur ein
 *    Bild, das als ruhiges, hochwertiges Hero taugt, sonst keins.
 * 4. Aus dem gewählten Foto bestimmt Code die Farbwelt (colors.ts). Ohne passendes Foto bleibt das Stockfoto.
 * Ergebnis je Firma in `app_state` (`hero:<id>`), damit es einmal geprüft wird und später auswertbar ist.
 */

export interface ImageCandidate {
  url: string;
  /** Natürliche Größe in Pixeln (bei Hintergrundbildern 0 = unbekannt, wird nach dem Laden geprüft). */
  width: number;
  height: number;
  /** Angezeigte Fläche und Abstand von oben (px) auf der Startseite. */
  shownWidth: number;
  shownHeight: number;
  top: number;
  alt: string;
  kind: "img" | "bg" | "og";
}

export interface HeroResult {
  status: "ok" | "none";
  /** Gespeichertes Foto (JPEG, höchstens 1920 px breit). */
  file?: string;
  url?: string;
  /** Bildausschnitt für object-position, z. B. "50% 40%". */
  position?: string;
  motiv?: string;
  /** Farbwelt aus dem Foto; fehlt sie (farbloses Foto), gilt die Standardfarbe. */
  palette?: HeroPalette | null;
  reason?: string;
  /** Logo der Praxis (PNG, unabhängig vom Foto); `wide` = Schriftzug, der den Namen schon enthält. */
  logo?: { file: string; wide: boolean } | null;
  checkedAt: string;
}

export interface LogoCandidate {
  url: string;
  width: number;
  height: number;
  shownWidth: number;
  shownHeight: number;
  top: number;
}

export interface PageImages {
  images: ImageCandidate[];
  logos: LogoCandidate[];
}

// v2 (05.10.2026, mit Logo): ältere Ergebnisse ohne Logo werden neu geprüft.
export const heroKey = (companyId: string) => `hero:v2:${companyId}`;

// Viele Praxis-Seiten liefern Fotos um 900 bis 1200 px; im Vorschau-Bild (Laptop) reicht das unter dem Farbschleier.
const MIN_WIDTH = 900;
const MIN_HEIGHT = 480;
const BAD_NAME =
  /(logo|icon|favicon|sprite|badge|siegel|zertifik|certif|award|qr|map|karte|maps|placeholder|dummy|banner-ad|button|arrow|pfeil|avatar|signature|unterschrift|partner|sponsor|kasse|krankenkasse)/i;

/** Regeln vor dem Laden (rein): Format, Größe, Name; sortiert nach Fläche und Nähe zum Seitenanfang. */
export function rankCandidates(cands: readonly ImageCandidate[], max = 6): ImageCandidate[] {
  const seen = new Set<string>();
  const ok = cands.filter((c) => {
    if (!/^https?:\/\//i.test(c.url) || seen.has(c.url)) return false;
    seen.add(c.url);
    const path = c.url.split("?")[0]!.toLowerCase();
    if (/\.(svg|gif|ico)$/.test(path)) return false;
    if (BAD_NAME.test(path) || BAD_NAME.test(c.alt)) return false;
    if (c.width > 0 && (c.width < MIN_WIDTH || c.height < MIN_HEIGHT)) return false;
    if (c.width > 0 && (c.width / c.height < 1.2 || c.width / c.height > 3)) return false;
    // Winzig angezeigte Bilder (Galerie-Daumen) sind selten gute Hero-Fotos; og:image hat keine Anzeige.
    if (c.kind !== "og" && c.shownWidth < 300) return false;
    return true;
  });
  const score = (c: ImageCandidate) =>
    (c.kind === "og" ? 400_000 : c.shownWidth * c.shownHeight) / (1 + Math.max(0, c.top) / 1200);
  return ok.sort((a, b) => score(b) - score(a)).slice(0, max);
}

export interface ImageStats {
  width: number;
  height: number;
  /** Informationsgehalt (sharp); Grafiken, Text-Banner und Flächen liegen deutlich niedriger als Fotos. */
  entropy: number;
}

/** Regeln nach dem Laden (rein): echtes Foto in guter Größe und im Querformat. */
export function qualityOk(s: ImageStats): string | null {
  if (s.width < MIN_WIDTH || s.height < MIN_HEIGHT) return `zu klein (${s.width}×${s.height})`;
  const ratio = s.width / s.height;
  if (ratio < 1.2 || ratio > 3) return "kein Querformat";
  // Fotos liegen bei etwa 6,5 bis 7,5, helle, ruhige Räume etwas darunter; Grafiken und Text-Banner deutlich tiefer.
  if (s.entropy < 5.5) return "wirkt wie eine Grafik";
  return null;
}

/** Nur öffentliche Adressen laden (die Bild-URLs stammen von fremden Websites). */
export async function isPublicUrl(url: string, resolve = lookup): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(u.protocol)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host)
    ? [host]
    : (await resolve(host, { all: true }).catch(() => [])).map((a) => a.address);
  return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a));
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

async function download(url: string, fetchFn: typeof fetch, allowSvg = false): Promise<Buffer | null> {
  // Weiterleitungen selbst folgen und jede Adresse prüfen (sonst könnte eine fremde Seite auf interne Adressen zeigen).
  let target = url;
  let res: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    if (!(await isPublicUrl(target))) return null;
    res = await fetchFn(target, { signal: AbortSignal.timeout(15_000), redirect: "manual" }).catch(
      () => null,
    );
    const next = res && res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) break;
    target = new URL(next, target).href;
    res = null;
  }
  const type = res?.headers.get("content-type") ?? "";
  if (
    !res?.ok ||
    !(/^image\/(jpeg|jpg|png|webp|avif)/i.test(type) || (allowSvg && /^image\/svg\+xml/i.test(type)))
  )
    return null;
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > 12_000_000) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 12_000_000 ? null : buf;
}

/** Logo-Kandidaten (rein): oben auf der Seite, nicht winzig; das erste ist meist das richtige (Kopfzeile). */
export function rankLogos(cands: readonly LogoCandidate[]): LogoCandidate[] {
  const seen = new Set<string>();
  return cands
    .filter((c) => {
      if (!/^https?:\/\//i.test(c.url) || seen.has(c.url)) return false;
      seen.add(c.url);
      if (c.top > 300 || c.shownHeight < 24 || c.shownWidth < 40) return false;
      const svg = /\.svg(\?|$)/i.test(c.url);
      // Pixel-Logos: genug Auflösung, damit es im Bild nicht verschwimmt.
      return svg || c.height >= 60 || c.width >= 200;
    })
    .slice(0, 2);
}

/** Logo laden und prüfen: als PNG mit 240 px Höhe; auf weißem Grund sichtbar (keine weißen Logos). */
export async function prepareLogo(buf: Buffer): Promise<{ png: Buffer; wide: boolean } | null> {
  try {
    const png = await sharp(buf, { density: 300 })
      .trim()
      .resize({ height: 240, withoutEnlargement: false })
      .png()
      .toBuffer();
    const meta = await sharp(png).metadata();
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let sum = 0;
    let weight = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const a = data[i + 3]! / 255;
      sum += a * ((0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255);
      weight += a;
    }
    if (weight === 0 || sum / weight > 0.86) return null; // weiß oder fast unsichtbar auf Weiß
    return { png, wide: (meta.width ?? 0) / (meta.height ?? 1) >= 2.4 };
  } catch {
    return null;
  }
}

/** Große Bilder und das Logo der Startseite einsammeln (läuft im Browser der Praxis-Seite). */
export async function collectCandidates(
  url: string,
  executablePath?: string,
  proxy?: string,
): Promise<PageImages> {
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    // Lazy-Loading anstoßen.
    await page.evaluate("window.scrollTo(0, 1200)");
    await page.waitForTimeout(1200);
    await page.evaluate("window.scrollTo(0, 0)");
    await page.waitForTimeout(400);
    return await page.evaluate(`(() => {
      const images = [];
      const logos = [];
      const abs = (u) => { try { return new URL(u, location.href).href } catch { return null } };
      const isLogo = (img) => {
        const own = [img.currentSrc || img.src, img.alt, img.className, img.id].join(" ");
        if (/logo/i.test(own)) return true;
        const a = img.closest("a");
        const home = a && (() => { try { const h = new URL(a.href, location.href); return h.origin === location.origin && (h.pathname === "/" || h.pathname === "/index.html") } catch { return false } })();
        const box = img.closest("[class*=logo i],[id*=logo i]");
        return Boolean(box) || Boolean(home && img.closest("header,nav,[class*=header i]"));
      };
      for (const img of document.images) {
        const r = img.getBoundingClientRect();
        // Lazy-Loading (WordPress u. a.): echtes Bild steht in data-src/data-lazy-src/data-srcset, src ist ein Platzhalter.
        const lazy = img.dataset.src || img.dataset.lazySrc || img.dataset.original || ((img.dataset.srcset || img.dataset.lazySrcset || "").split(",").map((x) => x.trim().split(" ")[0]).filter(Boolean).pop());
        const raw = img.currentSrc || img.src;
        const placeholder = !raw || raw.startsWith("data:");
        const src = abs(placeholder && lazy ? lazy : raw);
        if (!src) continue;
        if (placeholder && lazy) { images.push({ url: src, width: 0, height: 0, shownWidth: r.width, shownHeight: r.height, top: r.top + scrollY, alt: img.alt || "", kind: "img" }); continue; }
        if (isLogo(img)) logos.push({ url: src, width: img.naturalWidth, height: img.naturalHeight, shownWidth: r.width, shownHeight: r.height, top: r.top + scrollY });
        else images.push({ url: src, width: img.naturalWidth, height: img.naturalHeight, shownWidth: r.width, shownHeight: r.height, top: r.top + scrollY, alt: img.alt || "", kind: "img" });
      }
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width < 600 || r.height < 250 || r.top + scrollY > 2200) continue;
        const m = /url\\(["']?([^"')]+)["']?\\)/.exec(getComputedStyle(el).backgroundImage || "");
        const src = m && abs(m[1]);
        if (src) images.push({ url: src, width: 0, height: 0, shownWidth: r.width, shownHeight: r.height, top: r.top + scrollY, alt: "", kind: "bg" });
      }
      const og = document.querySelector('meta[property="og:image"]');
      const ogSrc = og && abs(og.getAttribute("content"));
      if (ogSrc) images.push({ url: ogSrc, width: 0, height: 0, shownWidth: 0, shownHeight: 0, top: 0, alt: "", kind: "og" });
      return { images, logos };
    })()`);
  } finally {
    await browser.close();
  }
}

export const heroOutputSchema = z.object({
  /** Nummer des gewählten Fotos (1 bis n) oder null, wenn keins taugt. */
  wahl: z.number().int().min(1).nullable(),
  /** 1 bis 5: wie gut passt es als Hero einer modernen Praxis-Website? */
  passt: z.number().int().min(1).max(5),
  motiv: z.string().max(80),
  /** Wichtigster Bildteil in Prozent (für den Ausschnitt). */
  fokus_x: z.number().min(0).max(100),
  fokus_y: z.number().min(0).max(100),
  grund: z.string().max(200),
  /** Ist "Logo" wirklich das gut lesbare Logo dieser Praxis (kein Partner, Siegel, Krankenkasse)? */
  logo_ok: z.boolean().default(false),
});
export type HeroChoice = z.infer<typeof heroOutputSchema>;

export const HERO_PROMPT_VERSION = "v2";
/** Nur ab dieser Note kommt das eigene Foto ins Bild, sonst das Stockfoto. */
export const HERO_MIN_FIT = 4;

export interface HeroDeps {
  db: DbClient;
  llm: LlmGateway;
  dir: string;
  fetch?: typeof fetch;
  collect?: (url: string) => Promise<PageImages>;
  now?: () => Date;
}

/** Hero-Foto und Logo einer Firma (aus dem Speicher oder neu bestimmt). Fehler führen nie zum Abbruch: dann ohne. */
export async function heroForCompany(deps: HeroDeps, company: Company): Promise<HeroResult> {
  const cached = await getState<HeroResult>(deps.db, heroKey(company.id));
  if (cached) return cached;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const save = async (r: HeroResult): Promise<HeroResult> => {
    await setState(deps.db, heroKey(company.id), r);
    return r;
  };
  const none = (reason: string) => save({ status: "none", reason, checkedAt: now });
  if (!company.website_url) return none("keine Website");
  const fetchFn = deps.fetch ?? fetch;
  let page: PageImages;
  try {
    const url = /^https?:\/\//i.test(company.website_url)
      ? company.website_url
      : `https://${company.website_url}`;
    page = await (deps.collect ?? ((u) => collectCandidates(u, process.env.CHROMIUM_PATH)))(url);
  } catch (err) {
    // Nicht merken: beim nächsten Mal neu versuchen (Seite kurz down, Zeitüberschreitung).
    return { status: "none", reason: `Seite nicht ladbar: ${String(err).slice(0, 80)}`, checkedAt: now };
  }
  const loaded: { cand: ImageCandidate; buf: Buffer; thumb: string }[] = [];
  for (const cand of rankCandidates(page.images)) {
    if (loaded.length >= 4) break;
    const buf = await download(cand.url, fetchFn).catch(() => null);
    if (!buf) continue;
    try {
      const img = sharp(buf).rotate();
      const meta = await img.metadata();
      const stats = await img.stats();
      const problem = qualityOk({ width: meta.width ?? 0, height: meta.height ?? 0, entropy: stats.entropy });
      if (problem) continue;
      const thumb = await sharp(buf).rotate().resize({ width: 640 }).jpeg({ quality: 80 }).toBuffer();
      loaded.push({ cand, buf, thumb: thumb.toString("base64") });
    } catch {
      // kein lesbares Bild
    }
  }
  let logo: { png: Buffer; wide: boolean } | null = null;
  for (const cand of rankLogos(page.logos)) {
    const buf = await download(cand.url, fetchFn, true).catch(() => null);
    logo = buf ? await prepareLogo(buf) : null;
    if (logo) break;
  }
  if (loaded.length === 0 && !logo) return none("kein großes, echtes Foto und kein Logo auf der Startseite");

  const { output: choice } = await deps.llm.structured({
    role: "hero",
    promptVersion: HERO_PROMPT_VERSION,
    system: loadPrompt("hero", HERO_PROMPT_VERSION),
    input: [
      {
        type: "text",
        text: `Betrieb: Physiotherapie-Praxis. ${loaded.length} Foto(s) von ihrer Website${logo ? " und ein mögliches Logo" : ", kein Logo"}:`,
      },
      ...loaded.flatMap((l, i) => [
        { type: "text" as const, text: `Bild ${i + 1}:` },
        {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/jpeg" as const, data: l.thumb },
        },
      ]),
      ...(logo
        ? [
            { type: "text" as const, text: "Logo:" },
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/png" as const,
                data: logo.png.toString("base64"),
              },
            },
          ]
        : []),
    ],
    schema: heroOutputSchema,
    companyId: company.id,
    inputSummary: `Hero-Foto ${company.name} (${loaded.length} Kandidaten${logo ? ", Logo" : ""})`,
  });

  await mkdir(deps.dir, { recursive: true });
  let savedLogo: HeroResult["logo"] = null;
  if (logo && choice.logo_ok) {
    const file = join(deps.dir, `${company.id}-logo.png`);
    await writeFile(file, logo.png);
    savedLogo = { file, wide: logo.wide };
  }
  const picked = choice.wahl !== null ? loaded[choice.wahl - 1] : undefined;
  if (!picked || choice.passt < HERO_MIN_FIT)
    return save({
      status: "none",
      reason: loaded.length === 0 ? "kein großes, echtes Foto" : `kein passendes Foto (${choice.grund})`,
      logo: savedLogo,
      checkedAt: now,
    });

  const file = join(deps.dir, `${company.id}.jpg`);
  await writeFile(
    file,
    await sharp(picked.buf)
      .rotate()
      .resize({ width: 1920, withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer(),
  );
  const { data: px } = await sharp(picked.buf)
    .rotate()
    .resize(48, 48, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return save({
    status: "ok",
    file,
    url: picked.cand.url,
    position: `${Math.round(choice.fokus_x)}% ${Math.round(choice.fokus_y)}%`,
    motiv: choice.motiv,
    palette: derivePalette(px),
    logo: savedLogo,
    checkedAt: now,
  });
}
