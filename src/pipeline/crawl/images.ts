/**
 * Bilder der Startseite für Prototypen (Phase 3): Logo und die größten Fotos, wie sie im Browser wirklich angezeigt
 * werden (inkl. Lazy-Loading und CSS-Hintergrundbilder). Gespeichert werden nur Adressen und Maße in den Fakten; die
 * Dateien lädt erst der Prototyp-Bau. Die Auswahl ist rein und unit-getestet.
 */

export interface ImageCandidate {
  url: string;
  alt: string;
  /** Natürliche Größe (img) bzw. angezeigte Größe (Hintergrundbild), CSS-Pixel. */
  w: number;
  h: number;
  /** Abstand vom Seitenanfang in CSS-Pixeln. */
  top: number;
  /** Angezeigte Fläche in CSS-Pixeln². */
  area: number;
  logoHint: boolean;
  background: boolean;
}

export interface SiteImages {
  logo: string | null;
  photos: { url: string; alt: string; w: number; h: number }[];
}

/** Läuft im Browser (als String, das Projekt kennt keine DOM-Typen). Höchstens 200 Kandidaten. */
export const IMAGE_SCRIPT = `(() => {
  const out = [];
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  for (const img of Array.from(document.images).slice(0, 150)) {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith("data:")) continue;
    const r = img.getBoundingClientRect();
    const hint = [src, img.alt, img.className, img.id].join(" ");
    const inHeader = !!img.closest("header, nav, [class*=header], [id*=header], [class*=logo], [id*=logo]");
    out.push({ url: abs(src), alt: img.alt || "", w: img.naturalWidth, h: img.naturalHeight,
      top: Math.round(r.top + window.scrollY), area: Math.round(r.width * r.height),
      logoHint: /logo/i.test(hint) || (inHeader && r.top + window.scrollY < 250 && r.width < 500),
      background: false });
  }
  const els = Array.from(document.querySelectorAll("section, header, div, figure, a")).slice(0, 2500);
  for (const el of els) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") continue;
    const m = /url\\(["']?([^"')]+)["']?\\)/.exec(bg);
    if (!m || m[1].startsWith("data:")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 300 || r.height < 150) continue;
    out.push({ url: abs(m[1]), alt: "", w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top + window.scrollY), area: Math.round(r.width * r.height), logoHint: false, background: true });
    if (out.length >= 200) break;
  }
  return out.filter((c) => c.url);
})()`;

const ICONISH =
  /(icon|sprite|favicon|pixel|spacer|blank|loader|loading|placeholder|flag|badge|siegel|payment|paypal|visa|social|facebook|instagram|whatsapp|youtube|google|tracking|analytics|texture|pattern|background|bg-|overlay|shadow|divider)/i;
const PHOTO_EXT = /\.(jpe?g|png|webp|avif)(\?|#|$)/i;

/** Keine Icons, Texturen, Logos von Diensten, keine SVG-Grafiken. */
export function isUsablePhotoUrl(url: string): boolean {
  return !ICONISH.test(url) && !/\.svg(\?|#|$)/i.test(url);
}

/** Logo: oben, als Logo erkennbar, nicht riesig. Fotos: groß genug, keine Icons, nach angezeigter Fläche. */
export function selectImages(candidates: readonly ImageCandidate[], max = 12): SiteImages {
  const valid = candidates.filter((c) => /^https?:\/\//.test(c.url));
  const logo =
    valid
      .filter((c) => c.logoHint && c.top < 400 && !c.background)
      .sort((a, b) => a.top - b.top || b.area - a.area)[0]?.url ?? null;
  const seen = new Set<string>(logo ? [logo] : []);
  const photos: SiteImages["photos"] = [];
  for (const c of [...valid].sort((a, b) => b.area - a.area)) {
    if (seen.has(c.url) || c.logoHint) continue;
    if (!isUsablePhotoUrl(c.url)) continue;
    if (!c.background && !PHOTO_EXT.test(c.url) && !/\/(image|img|media|uploads|wp-content)/i.test(c.url))
      continue;
    if (c.w < 480 || c.h < 280 || c.w / c.h > 5 || c.h / c.w > 3) continue;
    seen.add(c.url);
    photos.push({ url: c.url, alt: c.alt.slice(0, 120), w: c.w, h: c.h });
    if (photos.length >= max) break;
  }
  return { logo, photos };
}
