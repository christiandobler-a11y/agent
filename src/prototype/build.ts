import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import sharp from "sharp";
import type { SiteContent } from "./content.js";
import { renderTemplate } from "./templates/index.js";

/**
 * Prototyp als statische Seite in einen Ordner schreiben: Fotos und Logo laden (nur http/https, Größe begrenzt),
 * als WebP verkleinern, Schriften kopieren, index.html rendern. Fremde Bilder werden nur umgewandelt, nie ausgeführt.
 */

const require = createRequire(import.meta.url);
const FONTS = {
  "manrope-400.woff2": "@fontsource/manrope/files/manrope-latin-400-normal.woff2",
  "manrope-600.woff2": "@fontsource/manrope/files/manrope-latin-600-normal.woff2",
  "manrope-800.woff2": "@fontsource/manrope/files/manrope-latin-800-normal.woff2",
  "caveat-600.woff2": "@fontsource/caveat/files/caveat-latin-600-normal.woff2",
} as const;

const MAX_BYTES = 15 * 1024 * 1024;

export type ImageFetcher = (url: string) => Promise<Buffer | null>;

export function httpImageFetcher(fetchFn: typeof fetch = fetch): ImageFetcher {
  return async (url) => {
    if (!/^https?:\/\//i.test(url)) return null;
    try {
      const res = await fetchFn(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { "user-agent": "Mozilla/5.0 (Avelio Vorschau)" },
      });
      if (!res.ok) return null;
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_BYTES) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > MAX_BYTES ? null : buf;
    } catch {
      return null;
    }
  };
}

/** Bild laden und als WebP ablegen; `null` wenn es nicht geht (dann zeigt die Vorlage eine Farbfläche). */
async function storeImage(
  fetchImage: ImageFetcher,
  url: string,
  dir: string,
  name: string,
  width: number,
): Promise<string | null> {
  const buf = await fetchImage(url);
  if (!buf) return null;
  try {
    const out = `img/${name}.webp`;
    await sharp(buf, { animated: false, limitInputPixels: 60_000_000 })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(join(dir, out));
    return out;
  } catch {
    return null;
  }
}

/**
 * Ist das Logo hell (sichtbare Pixel im Schnitt fast weiß)? Dann braucht es einen dunklen Hintergrund. SVG wird nicht
 * vorher gerastert.
 */
export async function isLightLogo(buf: Buffer): Promise<boolean> {
  try {
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .resize(64, 64, { fit: "inside" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3]! < 64) continue; // durchsichtig
      sum += (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
      n++;
    }
    return n > 0 && sum / n > 0.85;
  } catch {
    return false;
  }
}

/** Logo als WebP (mit Transparenz), höchstens 160 px hoch; SVG wird vorher gerastert. */
async function storeLogo(
  fetchImage: ImageFetcher,
  url: string,
  dir: string,
): Promise<{ path: string; light: boolean } | null> {
  const buf = await fetchImage(url);
  if (!buf) return null;
  const svg = /<svg[\s>]/i.test(buf.subarray(0, 1000).toString("utf8")) || /\.svg(\?|#|$)/i.test(url);
  try {
    // Zu kleine Logos werden auf dem Bildschirm unscharf; dann lieber der Schriftzug der Vorlage.
    // SVG wird gerastert (oft ohne feste Größe oder weiß, beides wäre im Kopf unsichtbar); Skripte laufen dabei nicht.
    const input = svg ? await sharp(buf, { density: 300 }).png().toBuffer() : buf;
    const meta = await sharp(input).metadata();
    if (!svg && (meta.width ?? 0) < 180 && (meta.height ?? 0) < 90) return null;
    await sharp(input)
      .resize({ height: 160, withoutEnlargement: true })
      .webp({ quality: 90 })
      .toFile(join(dir, "img/logo.webp"));
    return { path: "img/logo.webp", light: await isLightLogo(input) };
  } catch {
    return null;
  }
}

export interface BuildResult {
  dir: string;
  content: SiteContent;
  /** Wie viele Fotos geladen werden konnten. */
  images: number;
}

/**
 * Seite bauen. Bild-Adressen in `content` sind Original-URLs; im Ergebnis zeigen sie auf die lokalen Dateien.
 */
export async function buildSite(
  content: SiteContent,
  dir: string,
  fetchImage: ImageFetcher = httpImageFetcher(),
  template = "physio",
): Promise<BuildResult> {
  await mkdir(join(dir, "img"), { recursive: true });
  await mkdir(join(dir, "fonts"), { recursive: true });
  for (const [file, pkg] of Object.entries(FONTS))
    await copyFile(require.resolve(pkg), join(dir, "fonts", file));

  const cache = new Map<string, Promise<string | null>>();
  let n = 0;
  const local = (url: string | null, width: number) => {
    if (!url) return Promise.resolve(null);
    let p = cache.get(url);
    if (!p) {
      p = storeImage(fetchImage, url, dir, `foto-${++n}`, width);
      cache.set(url, p);
    }
    return p;
  };
  const heroImage = await local(content.hero.image, 2000);
  // Kein Foto für "Über uns" gewählt: das nächste freie Foto nehmen (leere Flächen wirken unfertig).
  const aboutSource = content.about.image ?? content.gallery.find((g) => g !== content.hero.image) ?? null;
  const aboutImage = await local(aboutSource, 1200);
  const gallery = (await Promise.all(content.gallery.map((g) => local(g, 1200)))).filter(
    (g): g is string => g !== null,
  );
  const logo = content.logo ? await storeLogo(fetchImage, content.logo, dir) : null;

  const built: SiteContent = {
    ...content,
    logo: logo?.path ?? null,
    logoOnDark: logo?.light ?? false,
    hero: { ...content.hero, image: heroImage },
    about: { ...content.about, image: aboutImage },
    gallery: gallery.filter((g) => g !== heroImage && g !== aboutImage),
  };
  await writeFile(join(dir, "index.html"), renderTemplate(template, built));
  await writeFile(join(dir, "robots.txt"), "User-agent: *\nDisallow: /\n");
  return { dir, content: built, images: [heroImage, aboutImage, ...gallery].filter(Boolean).length };
}
