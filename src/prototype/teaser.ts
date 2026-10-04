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
import { latestPlacesSnapshot } from "../db/leads.js";
import { seedOf } from "../outreach/slots.js";

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
}

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

export function pickPhoto(seed: string): (typeof PHYSIO_PHOTOS)[number] {
  return PHYSIO_PHOTOS[seedOf(seed) % PHYSIO_PHOTOS.length]!;
}

const STAR =
  '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 1.5l2.6 5.5 6 .7-4.5 4.1 1.2 5.9L10 14.8l-5.3 2.9 1.2-5.9L1.4 7.7l6-.7z"/></svg>';
const GOOGLE =
  '<svg viewBox="0 0 48 48" width="34" height="34" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
const PIN =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

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
export type TeaserStyle = "welt" | "vital";

export function renderPhysioTeaser(
  d: TeaserData,
  assets: TeaserAssets = fileAssets,
  style: TeaserStyle = "welt",
): string {
  if (style === "vital") return renderVital(d, assets);
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
  const { title } = teaserName(d.name, d.city);
  const photo = pickPhoto(d.seed);
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
:root{--petrol:#1f5f68;--orange:#e46a1c;--ink:#24515a}
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
.hero::before{content:"";position:absolute;inset:0;z-index:1;background:rgba(27,86,95,.74)}
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
      await page.evaluate("document.fonts.ready.then(() => true)");
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
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const out = teaserPath(dir, companyId);
  await shoot(renderPhysioTeaser({ ...data, seed: companyId }, fileAssets, style), out);
  return out;
}

export interface TeaserDeps {
  dir: string;
  /** Branchen-Schlüssel, die statt eines Prototyps dieses Bild bekommen (config/prototype.yaml → teaser.branchen). */
  branches: readonly string[];
  shoot: TeaserShooter;
  style?: TeaserStyle;
}

export const usesTeaser = (t: Pick<TeaserDeps, "branches"> | null | undefined, company: Company) =>
  Boolean(t && company.branch_key && t.branches.includes(company.branch_key));

/** Bild für eine Firma bauen (Name, Ort, Telefon aus der Firma, Bewertung aus dem letzten Places-Abruf). */
export async function teaserForCompany(db: DbClient, t: TeaserDeps, company: Company): Promise<string> {
  const places = await latestPlacesSnapshot(db, company.id);
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
    },
    t.shoot,
    t.style,
  );
}
