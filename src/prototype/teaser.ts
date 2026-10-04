import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import type { DbClient } from "../db/client.js";
import type { Company } from "../db/companies.js";
import { latestAudit, latestPlacesSnapshot } from "../db/leads.js";
import { seedOf } from "../outreach/slots.js";
import type { PlaceDetails } from "./placeDetails.js";

/**
 * Muster-Startseite fürs Erstkontakt-Bild (04.10.2026, Christian: eine Branche, ein einheitliches starkes Hero, nur Name
 * und Bild tauschen). Kein LLM, keine Fotos der Praxis: Code setzt Name, Ort, Telefon und Google-Bewertung in eine fest
 * gestaltete Seite mit einem ausgesuchten Stockfoto, Chromium macht daraus ein Bild für Mail und Befund-Seite. Den
 * echten Prototyp baut Christian erst, wenn jemand Interesse zeigt.
 */

export interface TeaserData {
  /** Firmenname wie bei Google. */
  name: string;
  city: string | null;
  street: string | null;
  phone: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** Bestimmt das Foto (gleiche Firma = gleiches Bild). */
  seed: string;
  /** Leistungen laut Website (Audit), für die Kacheln; fehlen sie, die üblichen Physio-Leistungen. */
  services?: readonly string[];
  /** Echte Google-Bewertung (fremder Inhalt: nur gekürzt und escaped angezeigt). */
  quote?: { text: string; author: string } | null;
  /** Öffnungszeiten von Google, z. B. "Mo–Fr: 08:00–19:00". */
  hours?: readonly string[];
  /** Fester Stockfoto-Dateiname (config/prototype.yaml → teaser.foto); fehlt er, je Firma eins. */
  photo?: string | null;
  /** Farbwelt des Stils "vital" (VITAL_PALETTES), Standard petrol. */
  palette?: string | null;
}

/**
 * Farbwelten für den Stil "vital" (config/prototype.yaml → teaser.farbe). primary = Flächen und Schrift,
 * accent = Termin-Knopf, veil = Farbschleier über dem Foto.
 */
export const VITAL_PALETTES = {
  petrol: {
    primary: "#1f5f68",
    accent: "#e46a1c",
    ink: "#24515a",
    veil: "rgba(27,86,95,.74)",
    label: "Petrol + Orange",
  },
  salbei: {
    primary: "#4f6b5a",
    accent: "#c8794f",
    ink: "#3b5245",
    veil: "rgba(70,96,80,.72)",
    label: "Salbei + Terrakotta",
  },
  navy: {
    primary: "#1e2f4f",
    accent: "#f2b632",
    ink: "#1e2f4f",
    veil: "rgba(24,38,66,.72)",
    label: "Navy + Gelb",
  },
  wald: {
    primary: "#245b3b",
    accent: "#9bc53d",
    ink: "#21452f",
    veil: "rgba(31,82,52,.72)",
    label: "Waldgrün + Limette",
  },
  ozean: {
    primary: "#155e75",
    accent: "#2ec4b6",
    ink: "#164e63",
    veil: "rgba(18,84,105,.72)",
    label: "Ozeanblau + Türkis",
  },
  anthrazit: {
    primary: "#26292e",
    accent: "#d7263d",
    ink: "#26292e",
    veil: "rgba(30,32,36,.74)",
    label: "Anthrazit + Rot",
  },
  gelb: {
    primary: "#2b303b",
    accent: "#f5b800",
    ink: "#1f2633",
    veil: "rgba(58,63,72,.62)",
    label: "Dunkelblau + Gelb (Elementa)",
  },
} as const;
export type VitalPalette = keyof typeof VITAL_PALETTES;

const paletteOf = (d: Pick<TeaserData, "palette">) =>
  VITAL_PALETTES[(d.palette ?? "petrol") as VitalPalette] ?? VITAL_PALETTES.petrol;

/** Stockfotos (Unsplash-Lizenz, kommerziell frei, siehe assets/teaser/physio/QUELLEN.md); erstes = Favorit. */
export const PHYSIO_PHOTOS = [
  { file: "1706353399656-210cca727a33.jpg", position: "50% 40%" },
  { file: "1649751361457-01d3a696c7e6.jpg", position: "60% 50%" },
  { file: "1645005513713-9e2b92a687d3.jpg", position: "50% 30%" },
  { file: "1519824145371-296894a0daa9.jpg", position: "50% 50%" },
] as const;

const GENERIC_PREFIX =
  /^(praxis für physiotherapie|physiotherapiepraxis|physiotherapie-praxis|praxis für krankengymnastik|krankengymnastikpraxis|physiotherapie|praxis)\s+(?:(?:und|&)\s+\S+\s+)?/i;

const LEGAL =
  /\s+(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|UG(?:\s*\(haftungsbeschränkt\))?|KG|OHG|AG|e\.\s?K\.|GbR|PartG(?:\s*mbB)?)\.?$/i;
const GENERIC_WORDS =
  /\b(praxis|für|fuer|physiotherapie|physiotherapiepraxis|physio|krankengymnastik|und|&|zentrum|in|am|an|der|die|das)\b/gi;

/**
 * Anzeigename: Rechtsform und Zusätze weg. Ist der erste Teil nur Gattung und Ort ("Physiotherapie Rosenheim - Salzmann
 * am Salzstadel"), zählt der nächste. Ein langer Gattungsbegriff vorne wird zur kleinen Zeile darüber.
 */
export function teaserName(
  raw: string,
  city: string | null = null,
): { kicker: string | null; title: string } {
  const parts = raw
    .replace(/["„“”]/g, "")
    .split(/\s+[|–—-]\s+|\s*\|\s*|,|:/)
    .map((p) => p.replace(LEGAL, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const cityWords = (city ?? "").split(/\s+/).filter((w) => w.length > 2);
  const onlyGeneric = (p: string) =>
    cityWords
      .reduce((t, w) => t.split(w).join(" "), p)
      .replace(GENERIC_WORDS, " ")
      .trim().length === 0;
  const n = parts.find((p) => !onlyGeneric(p)) ?? parts[0] ?? raw.trim();
  const m = n.length > 26 ? GENERIC_PREFIX.exec(n) : null;
  if (m && n.length - m[0].length >= 3) {
    return { kicker: m[0].trim(), title: n.slice(m[0].length).trim() };
  }
  return { kicker: null, title: n };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const de = (n: number, digits = 1) => n.toFixed(digits).replace(".", ",");

const require = createRequire(import.meta.url);
const FONT_FILES = {
  "Barlow Condensed 300": "@fontsource/barlow-condensed/files/barlow-condensed-latin-300-normal.woff2",
  "Barlow Condensed 600": "@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff2",
  "Manrope 400": "@fontsource/manrope/files/manrope-latin-400-normal.woff2",
  "Manrope 600": "@fontsource/manrope/files/manrope-latin-600-normal.woff2",
  "Manrope 800": "@fontsource/manrope/files/manrope-latin-800-normal.woff2",
} as const;

export function physioAssetDir(): string {
  return fileURLToPath(new URL("../../assets/teaser/physio/", import.meta.url));
}

export interface TeaserAssets {
  /** file://-Adressen (für Chromium) bzw. beliebige URLs (Tests). */
  font: (key: keyof typeof FONT_FILES) => string;
  photo: (file: string) => string;
}

export const fileAssets: TeaserAssets = {
  font: (key) => pathToFileURL(require.resolve(FONT_FILES[key])).href,
  photo: (file) => pathToFileURL(join(physioAssetDir(), file)).href,
};

/** Festes Foto (config/prototype.yaml → teaser.foto), sonst je Firma eins aus der Auswahl. */
export function photoFor(d: Pick<TeaserData, "seed" | "photo">): (typeof PHYSIO_PHOTOS)[number] {
  return PHYSIO_PHOTOS.find((p) => p.file === d.photo) ?? pickPhoto(d.seed);
}

export function pickPhoto(seed: string): (typeof PHYSIO_PHOTOS)[number] {
  return PHYSIO_PHOTOS[seedOf(seed) % PHYSIO_PHOTOS.length]!;
}

const STAR =
  '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 1.5l2.6 5.5 6 .7-4.5 4.1 1.2 5.9L10 14.8l-5.3 2.9 1.2-5.9L1.4 7.7l6-.7z"/></svg>';
const GOOGLE =
  '<svg viewBox="0 0 48 48" width="34" height="34" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
const PIN =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

const PHONE_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>';

/** Leiste unten im Stil einer Partner-Leiste: Kassen und typische Qualifikationen als schlichte Schriftzüge. */
const STRIP: { icon: string; top: string; main: string }[] = [
  { icon: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z", top: "Alle Kassen", main: "& Privat" },
  {
    icon: "M7 11V6a2 2 0 0 1 4 0v4m0-1V4a2 2 0 0 1 4 0v6m0-3a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-1a7 7 0 0 1-6-3.5L2 13a2 2 0 0 1 3.4-2L7 13",
    top: "Manuelle",
    main: "Therapie",
  },
  {
    icon: "M3 12c3-4 6-4 9 0s6 4 9 0M3 17c3-4 6-4 9 0s6 4 9 0M3 7c3-4 6-4 9 0s6 4 9 0",
    top: "Manuelle",
    main: "Lymphdrainage",
  },
  { icon: "M6 7v10M18 7v10M3 9v6M21 9v6M6 12h12", top: "Krankengymnastik", main: "am Gerät" },
  { icon: "M13 4a2 2 0 1 0 0 .1M9 20l3-6 3 3v4M6 12l3-3 4 1 3 3 3-1", top: "Sport-", main: "physiotherapie" },
];

/** Feine Höhenlinien als Hintergrund (fest, kein Zufall). */
function topoLines(): string {
  const lines: string[] = [];
  for (let i = 0; i < 26; i++) {
    const y = -60 + i * 38;
    const a = 26 + (i % 5) * 7;
    lines.push(
      `<path d="M-40 ${y} C 240 ${y - a}, 420 ${y + a * 1.6}, 720 ${y + a * 0.4} S 1180 ${y - a * 1.4}, 1480 ${y + a * 0.6}"/>`,
    );
  }
  return `<svg class="topo" viewBox="0 0 1440 900" preserveAspectRatio="none" aria-hidden="true"><g fill="none" stroke="#dde2ea" stroke-width="1.2">${lines.join("")}</g></svg>`;
}

/** Monogramm fürs Logo aus den ersten zwei Wörtern des Namens. */
export function monogram(title: string): string {
  const words = title
    .replace(/[^\p{L}\s&-]/gu, "")
    .split(/[\s-]+/)
    .filter((w) => /^\p{L}/u.test(w));
  return (
    words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "P"
  ).slice(0, 2);
}

/**
 * Muster-Startseite (1440 × 900) als HTML. Rein: gleiche Daten = gleiche Seite. Stil angelehnt an starke
 * Physio-Seiten (z. B. therapie-welt.de, 04.10.2026 mit Christian): schwebende Kopfleiste, Höhenlinien, Aussage mit
 * markiertem Praxisnamen, Google-Bewertung, Foto-Collage, Leiste mit Kassen und Qualifikationen.
 */
export type TeaserStyle = "welt" | "vital" | "rund" | "mix" | "elementa";

export function renderPhysioTeaser(
  d: TeaserData,
  assets: TeaserAssets = fileAssets,
  style: TeaserStyle = "welt",
): string {
  if (style === "vital") return renderVital(d, assets);
  if (style === "rund" || style === "mix") return renderRund(d, assets);
  if (style === "elementa") return renderElementa(d, assets);
  const { title } = teaserName(d.name, d.city);
  const start = seedOf(d.seed) % PHYSIO_PHOTOS.length;
  const photo = (k: number) => PHYSIO_PHOTOS[(start + k) % PHYSIO_PHOTOS.length]!;
  const city = d.city?.trim() || null;
  const showRating = d.rating !== null && d.rating >= 4.3 && (d.reviewCount ?? 0) >= 5;
  const fonts = (
    [
      ["Manrope", "Manrope 400", 400],
      ["Manrope", "Manrope 600", 600],
      ["Manrope", "Manrope 800", 800],
    ] as const
  )
    .map(
      ([family, key, weight]) =>
        `@font-face{font-family:"${family}";src:url("${assets.font(key)}") format("woff2");font-weight:${weight}}`,
    )
    .join("\n");
  const trust = showRating
    ? `<div class="trust">${GOOGLE}<div><div class="stars">${STAR.repeat(5)}</div><b>${de(d.rating!)}</b> aus <b>${d.reviewCount}</b> Bewertungen</div></div>`
    : d.street || city
      ? `<div class="trust">${PIN}<div><b>${esc(d.street ?? "")}</b><br>${esc(city ?? "")}</div></div>`
      : "";
  const size = title.length <= 18 ? 60 : title.length <= 30 ? 54 : 46;
  const strip = STRIP.map(
    (x) =>
      `<div class="logo"><svg viewBox="0 0 24 24" width="38" height="38" aria-hidden="true"><path d="${x.icon}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span><small>${x.top}</small>${x.main}</span></div>`,
  ).join("");
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
${fonts}
:root{--ink:#1d2433;--muted:#5d6577;--gold:#b08d57;--line:#e3e7ee;--bg:#f6f7fa}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1440px;height:900px;overflow:hidden}
body{position:relative;background:linear-gradient(180deg,#fff 0%,var(--bg) 100%);color:var(--ink);font-family:Manrope,sans-serif;-webkit-font-smoothing:antialiased}
.topo{position:absolute;inset:0;width:100%;height:100%;opacity:.9}
header{position:absolute;z-index:3;top:0;left:72px;right:72px;height:68px;background:#fff;border-radius:0 0 18px 18px;box-shadow:0 10px 30px rgba(29,36,51,.07);display:flex;align-items:center;padding:0 18px 0 16px;gap:40px}
.logo-mark{display:flex;align-items:center;gap:10px;font-weight:800;font-size:${title.length > 28 ? 14 : 16}px;line-height:1.15;letter-spacing:-.01em;max-width:340px}
.logo-mark i{flex:none;width:44px;height:44px;border-radius:50%;background:#2a4f8f;color:#fff;font-style:normal;display:grid;place-items:center;font-size:17px;letter-spacing:-.04em}
nav{display:flex;gap:34px;font-size:16px;font-weight:600}
.right{margin-left:auto;display:flex;align-items:center;gap:30px;font-weight:600;font-size:16px}
.btn{display:inline-flex;align-items:center;height:48px;padding:0 26px;border-radius:6px;font-weight:700;font-size:16px;box-shadow:0 4px 14px rgba(29,36,51,.10)}
.btn.gold{background:var(--gold);color:#fff}
.btn.white{background:#fff;color:var(--ink)}
header .btn{height:40px;padding:0 22px}
.copy{position:absolute;z-index:2;left:80px;top:160px;width:700px}
.eyebrow{font-weight:700;font-size:19px}
h1{margin-top:18px;font-weight:800;font-size:${size}px;line-height:1.1;letter-spacing:-.025em}
h1 mark{background:linear-gradient(180deg,transparent 72%,rgba(176,141,87,.28) 72%);color:inherit;padding:0 2px}
h1 span{font-weight:600;color:#2b3445}
.actions{display:flex;gap:18px;margin-top:34px}
.trust{display:inline-flex;align-items:center;gap:14px;margin-top:22px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 22px 12px 18px;font-size:16px;line-height:1.25;color:var(--ink)}
.trust b{font-weight:800}
.stars{display:flex;color:#f2b33d;margin-bottom:2px}
.collage{position:absolute;z-index:2;left:860px;top:150px;width:520px;height:470px}
.ph{position:absolute;overflow:hidden;border-radius:14px;border:4px solid #fff;box-shadow:0 22px 50px rgba(29,36,51,.16)}
.ph img{width:100%;height:100%;object-fit:cover}
.ph.main{left:60px;top:0;width:420px;height:440px}
.ph.a{left:0;top:150px;width:200px;height:270px}
.ph.b{left:330px;top:40px;width:220px;height:150px}
.strip{position:absolute;z-index:2;left:80px;right:80px;bottom:70px;display:flex;justify-content:space-between;align-items:center;color:#6b7383}
.logo{display:flex;align-items:center;gap:12px;font-weight:800;font-size:22px;letter-spacing:-.01em;line-height:1.05;color:#3b4252}
.logo small{display:block;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#7b8394;margin-bottom:3px}
.logo svg{color:var(--gold)}
</style></head>
<body>
${topoLines()}
<header>
  <span class="logo-mark"><i>${esc(monogram(title))}</i>${esc(title)}</span>
  <nav><span>Leistungen</span><span>Praxis</span><span>Team</span><span>Kontakt</span></nav>
  <span class="right">${d.phone ? `<span>${esc(d.phone)}</span>` : ""}<span class="btn gold">Termin buchen</span></span>
</header>
<section class="copy">
  <div class="eyebrow">Physiotherapie${city ? ` ${esc(city)}` : ""}</div>
  <h1><mark>${esc(title)}.</mark> <span>Wieder schmerzfrei bewegen. Mit einem Plan, der zu Ihrem Alltag passt.</span></h1>
  <div class="actions"><span class="btn gold">Termin buchen</span><span class="btn white">Unsere Leistungen</span></div>
  ${trust}
</section>
<section class="collage">
  <div class="ph main"><img src="${assets.photo(photo(0).file)}" style="object-position:${photo(0).position}" alt=""></div>
  <div class="ph a"><img src="${assets.photo(photo(1).file)}" style="object-position:${photo(1).position}" alt=""></div>
  <div class="ph b"><img src="${assets.photo(photo(2).file)}" style="object-position:${photo(2).position}" alt=""></div>
</section>
<div class="strip">${strip}</div>
</body></html>`;
}

/**
 * Zweite Variante, angelehnt an revitalis-physio.de (04.10.2026, Christian): Telefonleiste oben, großes Foto über die
 * ganze Breite mit Petrol-Schleier, zentrierte schmale Schrift, orange Pille, geschwungener Abschluss unten.
 */
function renderVital(d: TeaserData, assets: TeaserAssets): string {
  const pal = paletteOf(d);
  const { title } = teaserName(d.name, d.city);
  const photo = photoFor(d);
  const city = d.city?.trim() || null;
  const showRating = d.rating !== null && d.rating >= 4.3 && (d.reviewCount ?? 0) >= 5;
  const fonts = (
    [
      ["Barlow Condensed", "Barlow Condensed 300", 300],
      ["Barlow Condensed", "Barlow Condensed 600", 600],
      ["Manrope", "Manrope 600", 600],
      ["Manrope", "Manrope 800", 800],
    ] as const
  )
    .map(
      ([family, key, weight]) =>
        `@font-face{font-family:"${family}";src:url("${assets.font(key)}") format("woff2");font-weight:${weight}}`,
    )
    .join("\n");
  const top = [
    d.phone ? `Telefon: ${esc(d.phone)}` : null,
    [d.street, city]
      .filter(Boolean)
      .map((x) => esc(x!))
      .join(", ") || null,
    "Termine nach Vereinbarung",
  ]
    .filter(Boolean)
    .join("<i>||</i>");
  const size = title.length <= 18 ? 92 : title.length <= 28 ? 78 : 64;
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
${fonts}
:root{--petrol:${pal.primary};--orange:${pal.accent};--ink:${pal.ink}}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1440px;height:900px;overflow:hidden}
body{background:#fff;font-family:"Barlow Condensed",sans-serif;-webkit-font-smoothing:antialiased;color:var(--ink)}
.bar{height:40px;background:var(--petrol);color:#e7f0f1;display:flex;align-items:center;justify-content:flex-end;padding:0 116px;gap:14px;font-size:15px;font-weight:600;letter-spacing:.02em}
.bar i{font-style:normal;color:var(--orange)}
header{height:100px;display:flex;align-items:center;justify-content:space-between;padding:0 116px}
.brand{display:flex;align-items:center;gap:14px}
.mark{width:62px;height:62px;border-radius:50%;border:3px solid var(--petrol);display:grid;place-items:center;color:var(--orange);font-weight:600;font-size:26px}
.brand b{display:block;font-weight:300;font-size:${title.length <= 20 ? 34 : title.length <= 30 ? 28 : 24}px;letter-spacing:.04em;text-transform:uppercase;line-height:1.02;max-width:560px}
.brand small{display:block;color:var(--orange);font-family:Manrope,sans-serif;font-weight:800;font-size:12px;letter-spacing:.2em;margin-top:5px}
nav{display:flex;gap:30px;font-size:21px;font-weight:300;color:var(--ink)}
.hero{position:relative;height:760px;overflow:hidden}
.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:${photo.position}}
.hero::before{content:"";position:absolute;inset:0;z-index:1;background:${pal.veil}}
.inner{position:relative;z-index:2;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#fff;padding-bottom:150px}
.eyebrow{font-weight:300;font-size:22px;letter-spacing:.32em;text-transform:uppercase;padding-left:.32em}
h1{font-weight:600;font-size:${size}px;line-height:1.02;margin-top:18px;max-width:1100px}
p{font-weight:300;font-size:28px;margin-top:22px;opacity:.95}
.row{display:flex;align-items:center;gap:18px;margin-top:36px}
.cta{background:var(--orange);color:#fff;font-size:22px;font-weight:600;padding:16px 56px;border-radius:999px}
.rating{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:12px 24px;font-family:Manrope,sans-serif;font-size:16px;font-weight:600}
.rating .stars{display:flex;color:#ffc24a}
.wave{position:absolute;z-index:3;left:0;right:0;bottom:-1px;width:100%;height:150px}
</style></head>
<body>
<div class="bar">${top}</div>
<header>
  <div class="brand"><span class="mark">${esc(monogram(title))}</span><span><b>${esc(title)}</b><small>PHYSIOTHERAPIE</small></span></div>
  <nav><span>Leistungen</span><span>Beschwerdebild</span><span>Über uns</span><span>Kontakt</span></nav>
</header>
<section class="hero">
  <img src="${assets.photo(photo.file)}" alt="">
  <div class="inner">
    <div class="eyebrow">Physiotherapie${city ? ` ${esc(city)}` : ""}</div>
    <h1>${esc(title)}</h1>
    <p>Ihre Praxis${city ? ` in ${esc(city)}` : ""}. Wir machen Sie wieder fit für den Alltag.</p>
    <div class="row"><span class="cta">Termin vereinbaren</span>${showRating ? `<span class="rating"><span class="stars">${STAR.repeat(5)}</span>${de(d.rating!)} · ${d.reviewCount} Google-Bewertungen</span>` : ""}</div>
  </div>
  <svg class="wave" viewBox="0 0 1440 150" preserveAspectRatio="none" aria-hidden="true"><path fill="#fff" d="M0 40 C 360 0, 620 150, 980 120 S 1340 40, 1440 70 L1440 150 L0 150 Z"/></svg>
</section>
</body></html>`;
}

const rundFonts = (assets: TeaserAssets) =>
  (
    [
      ["Barlow Condensed", "Barlow Condensed 300", 300],
      ["Barlow Condensed", "Barlow Condensed 600", 600],
      ["Manrope", "Manrope 600", 600],
      ["Manrope", "Manrope 800", 800],
    ] as const
  )
    .map(
      ([family, key, weight]) =>
        `@font-face{font-family:"${family}";src:url("${assets.font(key)}") format("woff2");font-weight:${weight}}`,
    )
    .join("\n");

/** Leistungs-Kacheln der runden Variante: Icon in einer Blase, zwei Zeilen Text (übliche Physio-Leistungen). */
const RUND_SERVICES = [STRIP[3]!, STRIP[1]!, STRIP[2]!, STRIP[4]!];

/**
 * Dritte Variante (04.10.2026, Christians Vorbild-Notizen zu corpore.health und physio-burkart.de): „rundes“ Design
 * ohne harte Kanten, Kopfleiste als schwebende Pille, Foto oval ausgeschnitten mit weichen Farbkreisen dahinter,
 * Google-Bewertung als Karte, Leistungen als Kacheln mit Icon statt reinem Text. Farben wie "vital".
 */
function renderRund(d: TeaserData, assets: TeaserAssets): string {
  const { title } = teaserName(d.name, d.city);
  const photo = photoFor(d);
  const city = d.city?.trim() || null;
  const showRating = d.rating !== null && d.rating >= 4.3 && (d.reviewCount ?? 0) >= 5;
  const size = title.length <= 16 ? 88 : title.length <= 26 ? 72 : 58;
  const tiles = RUND_SERVICES.map(
    (x) =>
      `<div class="tile"><span class="bubble"><svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="${x.icon}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span><small>${x.top}</small>${x.main}</span><i>→</i></div>`,
  ).join("");
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
${rundFonts(assets)}
:root{--petrol:#1f5f68;--orange:#e46a1c;--ink:#24515a;--mint:#e3efed;--bg:#f5f8f7}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1440px;height:900px;overflow:hidden}
body{position:relative;background:var(--bg);font-family:Manrope,sans-serif;-webkit-font-smoothing:antialiased;color:var(--ink)}
header{position:absolute;z-index:5;top:26px;left:72px;right:72px;height:78px;background:#fff;border-radius:999px;box-shadow:0 14px 40px rgba(31,95,104,.10);display:flex;align-items:center;justify-content:space-between;padding:0 14px 0 18px}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.mark{flex:none;width:52px;height:52px;border-radius:50%;background:var(--petrol);color:#fff;display:grid;place-items:center;font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:22px}
.brand b{display:block;font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:${title.length <= 22 ? 26 : 21}px;letter-spacing:.03em;text-transform:uppercase;line-height:1.02;max-width:420px}
.brand small{display:block;color:var(--orange);font-weight:800;font-size:11px;letter-spacing:.2em;margin-top:3px}
nav{display:flex;gap:34px;font-weight:600;font-size:16px}
.pill{background:var(--orange);color:#fff;font-weight:800;font-size:16px;padding:16px 28px;border-radius:999px}
.blob{position:absolute;border-radius:50%}
.b1{left:770px;top:150px;width:620px;height:620px;background:var(--mint)}
.b2{left:1250px;top:120px;width:120px;height:120px;background:#fbe3d3}
.b3{left:790px;top:610px;width:70px;height:70px;background:var(--orange);opacity:.9}
.oval{position:absolute;z-index:2;left:830px;top:140px;width:500px;height:600px;border-radius:50%;overflow:hidden;box-shadow:0 30px 60px rgba(31,95,104,.18);border:8px solid #fff}
.oval img{width:100%;height:100%;object-fit:cover;object-position:${photo.position}}
.left{position:absolute;z-index:3;left:116px;top:196px;width:660px}
.chip{display:inline-block;background:var(--mint);color:var(--petrol);font-weight:800;font-size:14px;letter-spacing:.14em;text-transform:uppercase;padding:10px 20px;border-radius:999px}
h1{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:${size}px;line-height:1;color:var(--petrol);margin-top:22px}
p{font-size:21px;line-height:1.5;margin-top:20px;max-width:520px;color:#3d5f66}
.row{display:flex;align-items:center;gap:18px;margin-top:34px}
.cta{background:var(--orange);color:#fff;font-weight:800;font-size:18px;padding:20px 38px;border-radius:999px;box-shadow:0 12px 26px rgba(228,106,28,.28)}
.rating{display:flex;align-items:center;gap:12px;background:#fff;border-radius:999px;padding:10px 22px 10px 12px;box-shadow:0 10px 26px rgba(31,95,104,.10);font-size:14px;font-weight:600}
.rating b{display:block;font-size:17px;font-weight:800}
.rating .stars{display:flex;color:#f5b400}
.tiles{position:absolute;z-index:4;left:116px;right:116px;top:760px;display:flex;gap:22px}
.tile{flex:1;display:flex;align-items:center;gap:16px;background:#fff;border-radius:28px;padding:18px 22px;box-shadow:0 14px 34px rgba(31,95,104,.09)}
.bubble{flex:none;width:62px;height:62px;border-radius:50%;background:var(--mint);color:var(--petrol);display:grid;place-items:center}
.tile span:not(.bubble){flex:1;font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:23px;line-height:1.05;color:var(--petrol)}
.tile small{display:block;font-family:Manrope,sans-serif;font-weight:600;font-size:13px;color:#6c8a90}
.tile i{font-style:normal;color:var(--orange);font-weight:800;font-size:20px}
</style></head>
<body>
<header>
  <div class="brand"><span class="mark">${esc(monogram(title))}</span><span><b>${esc(title)}</b><small>PHYSIOTHERAPIE</small></span></div>
  <nav><span>Leistungen</span><span>Über uns</span><span>Team</span><span>Kontakt</span></nav>
  <span class="pill">Termin vereinbaren</span>
</header>
<span class="blob b1"></span><span class="blob b2"></span>
<div class="oval"><img src="${assets.photo(photo.file)}" alt=""></div>
<span class="blob b3" style="z-index:3"></span>
<div class="left">
  <span class="chip">Physiotherapie${city ? ` in ${esc(city)}` : ""}</span>
  <h1>${esc(title)}</h1>
  <p>Wir machen Sie wieder fit für den Alltag. Persönlich betreut, mit Zeit für Ihre Beschwerden.</p>
  <div class="row"><span class="cta">Termin vereinbaren</span>${showRating ? `<span class="rating">${GOOGLE}<span><span class="stars">${STAR.repeat(5)}</span><b>${de(d.rating!)} · ${d.reviewCount} Bewertungen</b></span></span>` : ""}</div>
</div>
<div class="tiles">${tiles}</div>
</body></html>`;
}

/** Runde Variante in Handy-Breite (390 × 844) für das Geräte-Bild. */
function renderRundMobile(d: TeaserData, assets: TeaserAssets): string {
  const { title } = teaserName(d.name, d.city);
  const photo = photoFor(d);
  const city = d.city?.trim() || null;
  const showRating = d.rating !== null && d.rating >= 4.3 && (d.reviewCount ?? 0) >= 5;
  const size = title.length <= 14 ? 48 : title.length <= 24 ? 40 : 32;
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
${rundFonts(assets)}
:root{--petrol:#1f5f68;--orange:#e46a1c;--ink:#24515a;--mint:#e3efed;--bg:#f5f8f7}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:390px;height:844px;overflow:hidden}
body{position:relative;background:var(--bg);font-family:Manrope,sans-serif;-webkit-font-smoothing:antialiased;color:var(--ink)}
header{position:absolute;z-index:5;top:52px;left:14px;right:14px;height:60px;background:#fff;border-radius:999px;box-shadow:0 10px 26px rgba(31,95,104,.10);display:flex;align-items:center;justify-content:space-between;padding:0 18px 0 10px}
.brand{display:flex;align-items:center;gap:9px;min-width:0}
.mark{flex:none;width:40px;height:40px;border-radius:50%;background:var(--petrol);color:#fff;display:grid;place-items:center;font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:17px}
.brand b{display:block;font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:${title.length <= 18 ? 18 : 15}px;letter-spacing:.03em;text-transform:uppercase;line-height:1.05}
.brand small{display:block;color:var(--orange);font-weight:800;font-size:8px;letter-spacing:.2em;margin-top:2px}
.burger{flex:none;width:22px;height:14px;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink);position:relative}
.burger::after{content:"";position:absolute;left:0;right:0;top:4px;border-top:2px solid var(--ink)}
.blob{position:absolute;border-radius:50%;background:var(--mint);left:45px;top:140px;width:300px;height:300px}
.oval{position:absolute;z-index:2;left:75px;top:132px;width:240px;height:290px;border-radius:50%;overflow:hidden;border:6px solid #fff;box-shadow:0 20px 40px rgba(31,95,104,.18)}
.oval img{width:100%;height:100%;object-fit:cover;object-position:${photo.position}}
.dot{position:absolute;z-index:3;left:270px;top:380px;width:40px;height:40px;border-radius:50%;background:var(--orange)}
.body{position:absolute;left:22px;right:22px;top:450px;text-align:center}
.chip{display:inline-block;background:var(--mint);color:var(--petrol);font-weight:800;font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:7px 14px;border-radius:999px}
h1{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:${size}px;line-height:1;color:var(--petrol);margin-top:12px}
p{font-size:15px;line-height:1.45;margin-top:10px;color:#3d5f66}
.cta{display:inline-block;margin-top:18px;background:var(--orange);color:#fff;font-weight:800;font-size:16px;padding:14px 30px;border-radius:999px}
.rating{display:inline-flex;align-items:center;gap:8px;margin-top:14px;background:#fff;border-radius:999px;padding:7px 16px;box-shadow:0 8px 20px rgba(31,95,104,.10);font-size:12px;font-weight:800}
.rating .stars{display:flex;color:#f5b400}
.rating svg{width:12px;height:12px}
.tiles{position:absolute;left:18px;right:18px;top:742px;display:flex;gap:10px}
.tile{flex:1;display:flex;align-items:center;gap:8px;background:#fff;border-radius:20px;padding:10px 12px;box-shadow:0 8px 20px rgba(31,95,104,.09)}
.bubble{flex:none;width:36px;height:36px;border-radius:50%;background:var(--mint);color:var(--petrol);display:grid;place-items:center}
.tile span:not(.bubble){font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:15px;line-height:1.05;color:var(--petrol)}
.tile small{display:block;font-family:Manrope,sans-serif;font-weight:600;font-size:9px;color:#6c8a90}
</style></head>
<body>
<header>
  <div class="brand"><span class="mark">${esc(monogram(title))}</span><span><b>${esc(title)}</b><small>PHYSIOTHERAPIE</small></span></div>
  <span class="burger"></span>
</header>
<span class="blob"></span>
<div class="oval"><img src="${assets.photo(photo.file)}" alt=""></div>
<span class="dot"></span>
<div class="body">
  <span class="chip">Physiotherapie${city ? ` in ${esc(city)}` : ""}</span>
  <h1>${esc(title)}</h1>
  <p>Wir machen Sie wieder fit für den Alltag.</p>
  <span class="cta">Termin vereinbaren</span><br>
  ${showRating ? `<span class="rating"><span class="stars">${STAR.repeat(5)}</span>${de(d.rating!)} · ${d.reviewCount} Bewertungen</span>` : ""}
</div>
<div class="tiles">${RUND_SERVICES.slice(0, 2)
    .map(
      (x) =>
        `<div class="tile"><span class="bubble"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="${x.icon}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span><small>${x.top}</small>${x.main}</span></div>`,
    )
    .join("")}</div>
</body></html>`;
}

/**
 * Mischung (04.10.2026, Christian: "rund gefällt mir mehr, die mobile Ansicht bei vital weitaus besser, gut dass gleich
 * die 4 wichtigsten Punkte zu sehen sind"): Handy wie vital (Foto über die ganze Breite mit Petrol-Schleier, Welle),
 * darunter die vier Leistungen als runde Kacheln. Am Rechner die runde Variante.
 */
function renderMixMobile(d: TeaserData, assets: TeaserAssets): string {
  const { title } = teaserName(d.name, d.city);
  const photo = photoFor(d);
  const city = d.city?.trim() || null;
  const showRating = d.rating !== null && d.rating >= 4.3 && (d.reviewCount ?? 0) >= 5;
  const size = title.length <= 14 ? 44 : title.length <= 24 ? 38 : 30;
  const tiles = RUND_SERVICES.map(
    (x) =>
      `<div class="tile"><span class="bubble"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="${x.icon}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span><small>${x.top}</small>${x.main}</span></div>`,
  ).join("");
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
${rundFonts(assets)}
:root{--petrol:#1f5f68;--orange:#e46a1c;--ink:#24515a;--mint:#e3efed;--bg:#f5f8f7}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:390px;height:844px;overflow:hidden}
body{background:var(--bg);font-family:"Barlow Condensed",sans-serif;-webkit-font-smoothing:antialiased;color:var(--ink)}
.status{height:44px;background:#fff}
header{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;background:#fff}
.brand{display:flex;align-items:center;gap:10px;min-width:0}
.mark{flex:none;width:40px;height:40px;border-radius:50%;background:var(--petrol);color:#fff;display:grid;place-items:center;font-weight:600;font-size:17px}
.brand b{display:block;font-weight:600;font-size:${title.length <= 18 ? 19 : 15}px;letter-spacing:.03em;text-transform:uppercase;line-height:1.05}
.brand small{display:block;color:var(--orange);font-family:Manrope,sans-serif;font-weight:800;font-size:8px;letter-spacing:.2em;margin-top:3px}
.burger{flex:none;width:24px;height:16px;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink);position:relative}
.burger::after{content:"";position:absolute;left:0;right:0;top:5px;border-top:2px solid var(--ink)}
.hero{position:relative;height:540px;overflow:hidden}
.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:${photo.position}}
.hero::before{content:"";position:absolute;inset:0;z-index:1;background:rgba(27,86,95,.74)}
.inner{position:relative;z-index:2;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#fff;padding:0 22px 70px}
.eyebrow{font-weight:300;font-size:13px;letter-spacing:.26em;text-transform:uppercase}
h1{font-weight:600;font-size:${size}px;line-height:1.02;margin-top:10px}
p{font-weight:300;font-size:18px;margin-top:10px;opacity:.95}
.cta{margin-top:20px;background:var(--orange);color:#fff;font-size:18px;font-weight:600;padding:12px 36px;border-radius:999px}
.rating{margin-top:12px;display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:7px 15px;font-family:Manrope,sans-serif;font-size:12px;font-weight:600}
.rating .stars{display:flex;color:#ffc24a}
.rating svg{width:12px;height:12px}
.wave{position:absolute;z-index:3;left:0;right:0;bottom:-1px;width:100%;height:60px}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:4px 16px 0}
.tile{display:flex;align-items:center;gap:9px;background:#fff;border-radius:22px;padding:11px 12px;box-shadow:0 8px 20px rgba(31,95,104,.09)}
.bubble{flex:none;width:38px;height:38px;border-radius:50%;background:var(--mint);color:var(--petrol);display:grid;place-items:center}
.tile span:not(.bubble){font-weight:600;font-size:16px;line-height:1.05;color:var(--petrol)}
.tile small{display:block;font-family:Manrope,sans-serif;font-weight:600;font-size:9px;color:#6c8a90}
</style></head>
<body>
<div class="status"></div>
<header>
  <div class="brand"><span class="mark">${esc(monogram(title))}</span><span><b>${esc(title)}</b><small>PHYSIOTHERAPIE</small></span></div>
  <span class="burger"></span>
</header>
<section class="hero">
  <img src="${assets.photo(photo.file)}" alt="">
  <div class="inner">
    <div class="eyebrow">Physiotherapie${city ? ` ${esc(city)}` : ""}</div>
    <h1>${esc(title)}</h1>
    <p>Wir machen Sie wieder fit für den Alltag.</p>
    <span class="cta">Termin vereinbaren</span>
    ${showRating ? `<span class="rating"><span class="stars">${STAR.repeat(5)}</span>${de(d.rating!)} · ${d.reviewCount} Bewertungen</span>` : ""}
  </div>
  <svg class="wave" viewBox="0 0 390 60" preserveAspectRatio="none" aria-hidden="true"><path fill="#f5f8f7" d="M0 24 C 110 0, 190 60, 300 44 S 370 18, 390 26 L390 60 L0 60 Z"/></svg>
</section>
<div class="tiles">${tiles}</div>
</body></html>`;
}

const DEFAULT_SERVICES = ["Krankengymnastik", "Manuelle Therapie", "Lymphdrainage", "Sportphysiotherapie"];

/** Icon passend zur Leistung (sonst ein Plus). */
function serviceIcon(name: string): string {
  const n = name.toLowerCase();
  const pick = (i: number) => STRIP[i]!.icon;
  if (/gerät|kg|krankengym|training|reha/.test(n)) return pick(3);
  if (/manuell|massage|faszi|osteo|chiro/.test(n)) return pick(1);
  if (/lymph|wärme|fango|elektro|ultraschall/.test(n)) return pick(2);
  if (/sport|lauf|kinesio|tape/.test(n)) return pick(4);
  if (/kasse|privat|hausbesuch/.test(n)) return pick(0);
  return "M12 5v14M5 12h14";
}

/** Leistungen für die Kacheln: kurze Namen von der Website, sonst die üblichen. */
export function teaserServices(raw: readonly string[] | undefined, n = 4): string[] {
  const clean = (raw ?? [])
    .map((x) =>
      x
        .replace(/\s*[(:–-].*$/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((x) => x.length >= 4 && x.length <= 26 && /^\p{L}/u.test(x))
    .map((x) => x[0]!.toUpperCase() + x.slice(1));
  const unique = [...new Set(clean)];
  for (const d of DEFAULT_SERVICES) if (unique.length < n && !unique.includes(d)) unique.push(d);
  return unique.slice(0, n);
}

/** Bewertung fürs Bild kürzen (an einer Satz- oder Wortgrenze). */
export function teaserQuote(text: string, max = 150): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))} …`;
}

/**
 * "Der Rest" in Handy-Breite (04.10.2026, Christian: "noch nicht dieser Wow, lass mich sehen wie der Rest aussieht"):
 * Ende des Heros, darunter ihre Leistungen und Öffnungszeiten, unten ausgeblendet. Macht neugierig auf die ganze Seite.
 */
interface RestTheme {
  primary: string;
  accent: string;
  ink: string;
  /** Kopf-Streifen: Foto mit Farbschleier (vital) oder Farbflächen (elementa). */
  stub: "photo" | "shapes";
  veil?: string;
  shapeAccent?: string;
  shapeDark?: string;
}
const VITAL_THEME: RestTheme = { primary: "#1f5f68", accent: "#e46a1c", ink: "#24515a", stub: "photo" };
const ELEMENTA_THEME: RestTheme = { primary: "#1f2633", accent: "#c48a00", ink: "#1f2633", stub: "shapes" };

function renderVitalRest(d: TeaserData, assets: TeaserAssets, theme: RestTheme = VITAL_THEME): string {
  const { title } = teaserName(d.name, d.city);
  const photo = photoFor(d);
  const services = teaserServices(d.services);
  const hours = (d.hours ?? []).slice(0, 3);
  const fonts = (
    [
      ["Barlow Condensed", "Barlow Condensed 300", 300],
      ["Barlow Condensed", "Barlow Condensed 600", 600],
      ["Manrope", "Manrope 600", 600],
      ["Manrope", "Manrope 800", 800],
    ] as const
  )
    .map(
      ([family, key, weight]) =>
        `@font-face{font-family:"${family}";src:url("${assets.font(key)}") format("woff2");font-weight:${weight}}`,
    )
    .join("\n");
  const tiles = services
    .map(
      (x) =>
        `<div class="tile"><span class="ic"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${serviceIcon(x)}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span><b>${esc(x)}</b><i>Mehr erfahren →</i></div>`,
    )
    .join("");
  // Kennzahlen-Leiste (Vorbild ReBuild): nur echte Werte der Praxis.
  const good = d.rating !== null && d.rating >= 4.3 && (d.reviewCount ?? 0) >= 5;
  const firstHours = /^([^:]+):\s*(.+)$/.exec(hours[0] ?? "");
  const stats = [
    ...(good
      ? [
          [de(d.rating!), "Google-Sterne"],
          [String(d.reviewCount), "Bewertungen"],
        ]
      : []),
    ...(firstHours ? [[firstHours[1]!.replace(/\s/g, ""), firstHours[2]!.replace(/\s*Uhr$/, "")]] : []),
  ].slice(0, 3);
  const statsHtml =
    stats.length > 0
      ? `<div class="stats">${stats.map(([big, small]) => `<div><b>${esc(big!)}</b><small>${esc(small!)}</small></div>`).join("")}</div>`
      : "";
  const info =
    hours.length > 0
      ? hours.map((h) => `<li>${esc(h)}</li>`).join("")
      : `<li>Termine nach Vereinbarung</li>${d.phone ? `<li>Telefon: ${esc(d.phone)}</li>` : ""}`;
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
${fonts}
:root{--petrol:${theme.primary};--orange:${theme.accent};--ink:${theme.ink}}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:390px;height:844px;overflow:hidden}
body{position:relative;background:#fff;font-family:Manrope,sans-serif;-webkit-font-smoothing:antialiased;color:var(--ink)}
.status{height:44px}
header{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid #eef2f2}
.brand{display:flex;align-items:center;gap:9px;min-width:0}
.mark{flex:none;width:34px;height:34px;border-radius:50%;border:2px solid var(--petrol);display:grid;place-items:center;color:var(--orange);font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:15px}
.brand b{font-family:"Barlow Condensed",sans-serif;font-weight:300;font-size:${title.length <= 18 ? 17 : 14}px;letter-spacing:.04em;text-transform:uppercase}
.burger{flex:none;width:22px;height:14px;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink);position:relative}
.burger::after{content:"";position:absolute;left:0;right:0;top:4px;border-top:2px solid var(--ink)}
.hero{position:relative;height:120px;overflow:hidden}
.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:${photo.position}}
.hero::before{content:"";position:absolute;inset:0;z-index:1;background:${theme.stub === "photo" ? (theme.veil ?? "rgba(27,86,95,.74)") : "transparent"}}
.hero .shapes{position:absolute;inset:0;width:100%;height:100%}
.hero span{position:absolute;z-index:2;left:0;right:0;top:26px;text-align:center;color:#fff;font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:24px}
.wave{position:absolute;z-index:3;left:0;right:0;bottom:-1px;width:100%;height:46px}
section{padding:6px 20px 0}
.eyebrow{color:var(--orange);font-weight:800;font-size:11px;letter-spacing:.2em;text-transform:uppercase;text-align:center}
h2{font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:30px;color:var(--petrol);text-align:center;margin-top:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.tile{background:#f3f8f8;border-radius:16px;padding:14px 12px;min-height:118px;display:flex;flex-direction:column}
.ic{width:40px;height:40px;border-radius:50%;background:#fff;color:var(--petrol);display:grid;place-items:center;box-shadow:0 4px 12px rgba(31,95,104,.10)}
.tile b{margin-top:10px;font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:18px;line-height:1.05;color:var(--petrol)}
.tile i{margin-top:auto;padding-top:6px;font-style:normal;font-weight:800;font-size:10px;color:var(--orange)}
.hours{margin-top:16px;background:var(--petrol);color:#fff;border-radius:16px;padding:14px 16px}
.hours small{display:block;font-weight:800;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#f3b27f}
.hours ul{list-style:none;margin-top:6px;font-weight:600;font-size:13px;line-height:1.6}
.fade{position:absolute;left:0;right:0;bottom:0;height:120px;background:linear-gradient(rgba(255,255,255,0),#fff 80%)}
.stats{display:flex;justify-content:space-around;padding:4px 14px 14px;border-bottom:1px solid #eef2f2;margin-bottom:12px}
.stats div{text-align:center}
.stats b{display:block;font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:30px;line-height:1;color:var(--petrol)}
.stats small{display:block;margin-top:3px;font-weight:600;font-size:10px;color:#6c8a90}
</style></head>
<body>
<div class="status"></div>
<header><div class="brand"><span class="mark">${esc(monogram(title))}</span><b>${esc(title)}</b></div><span class="burger"></span></header>
<div class="hero">${
    theme.stub === "photo"
      ? `<img src="${assets.photo(photo.file)}" alt="">`
      : `<svg class="shapes" viewBox="0 0 390 120" preserveAspectRatio="none" aria-hidden="true"><rect width="390" height="120" fill="#a9aeb3"/><path d="M0 0H150L0 70Z" fill="${theme.shapeAccent ?? "#ffd24c"}"/><path d="M250 0H390V90Z" fill="${theme.shapeDark ?? "#2b303b"}"/><path d="M390 60V120H200Z" fill="${theme.shapeAccent ?? "#ffd24c"}"/></svg>`
  }<span>Termin vereinbaren</span>
<svg class="wave" viewBox="0 0 390 46" preserveAspectRatio="none" aria-hidden="true"><path fill="#fff" d="M0 18 C 110 0, 190 46, 300 34 S 370 12, 390 20 L390 46 L0 46 Z"/></svg></div>
${statsHtml}
<section>
  <div class="eyebrow">Leistungen</div>
  <h2>Wobei wir Ihnen helfen</h2>
  <div class="grid">${tiles}</div>
  <div class="hours"><small>Öffnungszeiten</small><ul>${info}</ul></div>
</section>
<div class="fade"></div>
</body></html>`;
}

/**
 * Stil "elementa" (04.10.2026, Christians Favorit elementa-therapie.de): geometrische Farbflächen in Gelb, Dunkelblau
 * und Grau, schwebende weiße Kopfleiste, große fette Überschrift, Stern-Badge mit der Google-Note, gelber und weißer
 * Knopf, Adresse und Telefon, grüner Anruf-Knopf. Das Praxisfoto liegt gedämpft dahinter.
 */
function renderElementa(d: TeaserData, assets: TeaserAssets): string {
  // Farben aus der Farbwelt (teaser.farbe): Dreiecke in Akzent, Hauptfarbe und Hellgrau.
  const pal = paletteOf(d);
  const { title } = teaserName(d.name, d.city);
  const photo = photoFor(d);
  const city = d.city?.trim() || null;
  const good = d.rating !== null && d.rating >= 4.3 && (d.reviewCount ?? 0) >= 5;
  const fonts = (
    [
      ["Manrope", "Manrope 400", 400],
      ["Manrope", "Manrope 600", 600],
      ["Manrope", "Manrope 800", 800],
    ] as const
  )
    .map(
      ([family, key, weight]) =>
        `@font-face{font-family:"${family}";src:url("${assets.font(key)}") format("woff2");font-weight:${weight}}`,
    )
    .join("\n");
  const size = title.length <= 22 ? 76 : title.length <= 34 ? 62 : 50;
  const address = [d.street, city]
    .filter(Boolean)
    .map((x) => esc(x!))
    .join(", ");
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
${fonts}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1440px;height:900px;overflow:hidden}
body{position:relative;font-family:Manrope,sans-serif;-webkit-font-smoothing:antialiased;color:${pal.ink};background:#a9aeb3}
.photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:${photo.position};filter:grayscale(.35)}
.veil{position:absolute;inset:0;background:${pal.veil};opacity:.85}
.shapes{position:absolute;inset:0;width:100%;height:100%}
header{position:absolute;z-index:5;top:20px;left:70px;right:70px;height:78px;background:#fff;border-radius:18px;display:flex;align-items:center;justify-content:space-between;padding:0 16px 0 18px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
.brand{display:flex;align-items:center;gap:12px}
.ring{width:56px;height:56px;border-radius:50%;border:2px solid ${pal.primary};display:grid;place-items:center}
.ring i{width:22px;height:22px;border-radius:50%;border:4px solid ${pal.accent}}
.brand b{display:block;font-weight:600;font-size:${title.length <= 24 ? 24 : 19}px;letter-spacing:-.01em;max-width:420px;line-height:1.1}
.brand small{display:block;font-weight:800;font-size:9px;letter-spacing:.14em;margin-top:2px}
nav{display:flex;align-items:center;gap:22px;font-weight:800;font-size:14px;color:${pal.ink}}
.btn{border-radius:8px;padding:12px 16px;font-weight:800;font-size:14px}
.dark{background:${pal.primary};color:#fff}.yellow{background:${pal.accent};color:#fff}
.center{position:absolute;z-index:4;left:0;right:0;top:250px;text-align:center;color:#fff}
h1{font-weight:800;font-size:${size}px;line-height:1.08;letter-spacing:-.01em;max-width:1050px;margin:0 auto}
h2{font-weight:800;font-size:${Math.round(size * 0.62)}px;margin-top:6px}
.row{display:flex;justify-content:center;gap:10px;margin-top:40px}
.big{width:272px;height:52px;border-radius:8px;display:grid;place-items:center;font-weight:800;font-size:17px}
.big.y{background:${pal.accent};color:#fff}.big.w{background:#fff;color:${pal.ink}}
.meta{margin-top:30px;font-weight:800;font-size:17px;line-height:1.7}
.meta div{display:flex;align-items:center;justify-content:center;gap:8px}
.star{position:absolute;z-index:6;right:150px;top:228px;width:124px;height:124px;transform:rotate(14deg)}
.star b{position:absolute;left:0;right:0;top:36px;text-align:center;color:#fff;font-weight:800;font-size:38px}
.star small{position:absolute;left:0;right:0;top:80px;text-align:center;color:#fff;font-weight:800;font-size:12px}
.call{position:absolute;z-index:6;right:48px;bottom:48px;width:104px;height:104px;border-radius:50%;background:rgba(80,210,110,.45);display:grid;place-items:center}
.call i{width:82px;height:82px;border-radius:50%;background:#2fd15a;display:grid;place-items:center}
</style></head>
<body>
<img class="photo" src="${assets.photo(photo.file)}" alt="">
<div class="veil"></div>
<svg class="shapes" viewBox="0 0 1440 900" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 0H430L0 185Z" fill="${pal.accent}"/>
  <path d="M730 0H1440V210Z" fill="${pal.primary}"/>
  <path d="M0 595L715 900H0Z" fill="#cfd3d9"/>
  <path d="M1440 720V900H1010Z" fill="${pal.accent}"/>
</svg>
<header>
  <div class="brand"><span class="ring"><i></i></span><span><b>${esc(title)}</b><small>PHYSIOTHERAPIE</small></span></div>
  <nav><span>Leistungen</span><span>Praxis</span><span>Team</span><span>Kontakt</span><span class="btn dark">Rezept einreichen</span><span class="btn yellow">Termin vereinbaren</span></nav>
</header>
${good ? `<div class="star"><svg viewBox="0 0 100 100" width="124" height="124" aria-hidden="true"><path fill="${pal.accent}" d="M50 4l13 30 32 3-24 21 7 32-28-17-28 17 7-32L5 37l32-3z"/></svg><b>${de(d.rating!)}</b><small>Bei Google</small></div>` : ""}
<div class="center">
  <h1>${esc(title)}</h1>
  ${/physio/i.test(title) && !city ? "" : `<h2>${/physio/i.test(title) ? "" : "Physiotherapie "}${city ? `in ${esc(city)}` : ""}</h2>`}
  <div class="row"><span class="big y">Jetzt Termin vereinbaren</span><span class="big w">Öffnungszeiten</span></div>
  <div class="meta">${address ? `<div>${PIN} ${address}</div>` : ""}${d.phone ? `<div>${PHONE_ICON} ${esc(d.phone)}</div>` : ""}</div>
</div>
<div class="call"><i><svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"><path fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg></i></div>
</body></html>`;
}

/** Schwebende Karte mit einer echten Google-Bewertung (oder nur der Sterne-Zahl), fürs Geräte-Bild. */
function quoteCard(d: TeaserData): string {
  const good = d.rating !== null && d.rating >= 4.3 && (d.reviewCount ?? 0) >= 5;
  if (!d.quote && !good) return "";
  const stars = `<span class="qstars">${STAR.repeat(5)}</span>`;
  const head = `<div class="qhead">${GOOGLE}<div>${stars}${good ? `<b>${de(d.rating!)} · ${d.reviewCount} Bewertungen</b>` : ""}</div></div>`;
  const body = d.quote
    ? `<p>„${esc(teaserQuote(d.quote.text))}“</p><small>${esc(d.quote.author)} auf Google</small>`
    : "";
  return `<div class="quote">${head}${body}</div>`;
}

/**
 * Geräte-Bild (04.10.2026, Christian): die Startseite auf einem Laptop, daneben dieselbe Seite auf einem Smartphone.
 * Wirkt wie ein fertiges Produkt und zeigt nebenbei, dass die Seite am Handy funktioniert. Beide Seiten stecken als
 * iframe (srcdoc) in der Szene, ein Screenshot reicht. Bildgröße 1440 × 900 wie die Seite selbst.
 */
export function renderTeaserMockup(
  d: TeaserData,
  assets: TeaserAssets = fileAssets,
  style: Exclude<TeaserStyle, "welt"> = "vital",
): string {
  const desktop =
    style === "vital"
      ? renderVital(d, assets)
      : style === "elementa"
        ? renderElementa(d, assets)
        : renderRund(d, assets);
  // vital: am Handy schon "der Rest" (Leistungen, Öffnungszeiten), dazu eine echte Bewertung als Karte.
  const mobile =
    style === "rund"
      ? renderRundMobile(d, assets)
      : style === "mix"
        ? renderMixMobile(d, assets)
        : renderVitalRest(
            d,
            assets,
            style === "elementa"
              ? {
                  ...ELEMENTA_THEME,
                  primary: paletteOf(d).primary,
                  ink: paletteOf(d).ink,
                  accent: paletteOf(d).accent,
                  shapeAccent: paletteOf(d).accent,
                  shapeDark: paletteOf(d).primary,
                }
              : {
                  ...VITAL_THEME,
                  primary: paletteOf(d).primary,
                  accent: paletteOf(d).accent,
                  ink: paletteOf(d).ink,
                  veil: paletteOf(d).veil,
                },
          );
  const card = style === "vital" || style === "elementa" ? quoteCard(d) : "";
  const lw = 1060; // Bildschirmbreite Laptop
  const ls = lw / 1440;
  const pw = 250; // Bildschirmbreite Handy
  const ps = pw / 390;
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Entwurf</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1440px;height:900px;overflow:hidden}
body{background:radial-gradient(120% 90% at 30% 20%,#f4f8f8 0%,#e3ecee 55%,#d5e1e3 100%)}
.laptop{position:absolute;left:110px;top:70px;width:${lw + 32}px}
.lid{background:#16191c;border-radius:22px 22px 6px 6px;padding:16px 16px 22px;box-shadow:0 40px 80px rgba(22,48,53,.28)}
.lid::before{content:"";display:block;width:6px;height:6px;border-radius:50%;background:#3a3f44;margin:-9px auto 3px}
.screen{width:${lw}px;height:${Math.round(900 * ls)}px;overflow:hidden;border-radius:4px;background:#fff}
.screen iframe{width:1440px;height:900px;border:0;transform:scale(${ls.toFixed(5)});transform-origin:0 0}
.base{width:${lw + 140}px;height:22px;margin-left:-54px;background:linear-gradient(#e9ecef,#c3c8cd);border-radius:0 0 18px 18px;box-shadow:0 18px 30px rgba(22,48,53,.22);position:relative}
.base::before{content:"";position:absolute;left:50%;top:0;width:140px;height:8px;margin-left:-70px;background:#b4bac0;border-radius:0 0 10px 10px}
.phone{position:absolute;left:1065px;top:300px;width:${pw + 24}px;padding:12px;background:#111316;border-radius:46px;box-shadow:0 40px 70px rgba(22,48,53,.35),inset 0 0 0 2px #2b2f34}
.phone .screen{width:${pw}px;height:${Math.round(844 * ps)}px;border-radius:34px;position:relative}
.phone .screen iframe{width:390px;height:844px;transform:scale(${ps.toFixed(5)})}
.island{position:absolute;z-index:2;left:50%;top:10px;width:78px;height:22px;margin-left:-39px;background:#000;border-radius:999px}
@font-face{font-family:"Manrope";src:url("${assets.font("Manrope 600")}") format("woff2");font-weight:600}
@font-face{font-family:"Manrope";src:url("${assets.font("Manrope 800")}") format("woff2");font-weight:800}
.quote{position:absolute;z-index:5;left:56px;top:560px;width:430px;background:#fff;border-radius:18px;padding:20px 24px 18px;box-shadow:0 30px 60px rgba(22,48,53,.28);font-family:Manrope,sans-serif;color:#24515a}
.qhead{display:flex;align-items:center;gap:12px}
.qhead b{display:block;font-weight:800;font-size:15px;margin-top:2px}
.qstars{display:flex;color:#f5b400}
.quote p{margin-top:12px;font-weight:600;font-size:17px;line-height:1.45;color:#1f3f45}
.quote small{display:block;margin-top:8px;font-weight:600;font-size:13px;color:#6c8a90}
</style></head>
<body>
<div class="laptop"><div class="lid"><div class="screen"><iframe srcdoc="${esc(desktop)}"></iframe></div></div><div class="base"></div></div>
<div class="phone"><div class="screen"><span class="island"></span><iframe srcdoc="${esc(mobile)}"></iframe></div></div>
${card}
</body></html>`;
}

export type TeaserShooter = (html: string, outFile: string) => Promise<void>;

/** HTML mit Chromium als JPEG (1600 px breit) speichern. */
export function chromiumTeaserShooter(executablePath?: string): TeaserShooter {
  return async (html, outFile) => {
    const dir = await mkdtemp(join(tmpdir(), "avelio-teaser-"));
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    try {
      const file = join(dir, "index.html");
      await writeFile(file, html);
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
      await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
      for (const frame of page.frames()) await frame.evaluate("document.fonts.ready.then(() => true)");
      const png = await page.screenshot({ type: "png" });
      await sharp(png).resize({ width: 1600 }).jpeg({ quality: 84, mozjpeg: true }).toFile(outFile);
    } finally {
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** Pfad des Bildes einer Firma (fest, damit Mail und Brief es ohne Datenbank finden). */
export function teaserPath(dir: string, companyId: string): string {
  return join(dir, `${companyId}.jpg`);
}

export function teaserExists(dir: string, companyId: string): boolean {
  return existsSync(teaserPath(dir, companyId));
}

/** Bild bauen (überschreibt ein altes). */
export async function buildTeaser(
  dir: string,
  companyId: string,
  data: Omit<TeaserData, "seed">,
  shoot: TeaserShooter,
  style: TeaserStyle = "welt",
  devices = false,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const out = teaserPath(dir, companyId);
  const d = { ...data, seed: companyId };
  // Laptop + Smartphone gibt es für alle Stile außer "welt".
  await shoot(
    devices && style !== "welt"
      ? renderTeaserMockup(d, fileAssets, style)
      : renderPhysioTeaser(d, fileAssets, style),
    out,
  );
  return out;
}

export interface TeaserDeps {
  dir: string;
  /** Branchen-Schlüssel, die statt eines Prototyps dieses Bild bekommen (config/prototype.yaml → teaser.branchen). */
  branches: readonly string[];
  shoot: TeaserShooter;
  style?: TeaserStyle;
  /** Startseite auf Laptop und Smartphone statt nur der Seite (alle Stile außer "welt"). */
  devices?: boolean;
  /** Festes Foto für alle (Dateiname aus assets/teaser/physio/). */
  photo?: string | null;
  /** Farbwelt für "vital" (VITAL_PALETTES). */
  palette?: string | null;
  /** Google-Details (Bewertungstext, Öffnungszeiten), siehe cachedPlaceDetails; fehlt es, ohne. */
  details?: ((company: Company) => Promise<PlaceDetails | null>) | null;
}

export const usesTeaser = (t: Pick<TeaserDeps, "branches"> | null | undefined, company: Company) =>
  Boolean(t && company.branch_key && t.branches.includes(company.branch_key));

/** Bild für eine Firma bauen (Name, Ort, Telefon aus der Firma, Bewertung aus dem letzten Places-Abruf). */
export async function teaserForCompany(db: DbClient, t: TeaserDeps, company: Company): Promise<string> {
  const places = await latestPlacesSnapshot(db, company.id);
  // Echte Daten der Praxis (04.10.2026, "das ist ja meine Praxis"): Leistungen aus dem Audit, Bewertung und
  // Öffnungszeiten von Google.
  const audit = await latestAudit(db, company.id);
  const services = ((audit?.commercial as { services?: string[] } | null)?.services ?? []).filter(
    (x): x is string => typeof x === "string",
  );
  const details = t.details ? await t.details(company).catch(() => null) : null;
  return buildTeaser(
    t.dir,
    company.id,
    {
      name: company.name,
      city: company.city,
      street: company.street,
      phone: company.phone,
      rating: places?.rating ?? null,
      reviewCount: places?.review_count ?? null,
      services,
      quote: details?.quotes[0] ?? null,
      hours: details?.hours ?? [],
      photo: t.photo ?? null,
      palette: t.palette ?? null,
    },
    t.shoot,
    t.style,
    t.devices ?? false,
  );
}
