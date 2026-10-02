import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";

/**
 * Fakten einer Seite aus dem gerenderten HTML (ARCHITECTURE.md 11.1): klein, objektiv, ohne LLM.
 * Gehen später als JSON ins Audit und in den objektiven Teil des Scores.
 */

export interface PageFacts {
  title: string | null;
  meta_description: string | null;
  lang: string | null;
  h1: string[];
  nav_items: string[];
  cta_texts: string[];
  tel_links: string[];
  mailto_links: string[];
  has_viewport_meta: boolean;
  viewport: string | null;
  generator: string | null;
  cms: string | null;
  copyright_year: number | null;
  word_count: number;
  image_count: number;
  images_without_alt: number;
  link_count: number;
  form_count: number;
  has_contact_form: boolean;
  social_links: string[];
  impressum_url: string | null;
  privacy_url: string | null;
  iframe_count: number;
  layout_tables: number;
  has_favicon: boolean;
  has_open_graph: boolean;
  has_structured_data: boolean;
  html_kb: number;
}

const MAX_ITEMS = 12;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const short = (s: string, max = 80) => {
  const c = clean(s);
  return c.length > max ? `${c.slice(0, max - 1)}…` : c;
};
const uniq = (items: string[], max = MAX_ITEMS) => [...new Set(items.filter(Boolean))].slice(0, max);

/** Baukästen/CMS: Generator-Tag oder typische Spuren im HTML. Reihenfolge = Priorität. */
const CMS_SIGNATURES: [string, RegExp][] = [
  ["Wix", /static\.wixstatic\.com|wix\.com website builder|_wixcss/i],
  ["Jimdo", /jimdo(?:cdn|free|site)?\.com|jimdo/i],
  ["Squarespace", /squarespace(?:-cdn)?\.com/i],
  ["Webflow", /webflow\.(?:com|io)|data-wf-page/i],
  ["Shopify", /cdn\.shopify\.com/i],
  ["IONOS MyWebsite", /mywebsite-editor|homepagebaukasten|ionos\.(?:de|com)\/website/i],
  ["Strato Homepage-Baukasten", /strato-editor|sitebuilder\.strato/i],
  ["Weebly", /weebly\.com|editmysite\.com/i],
  ["Webnode", /webnode\./i],
  ["WordPress", /wp-content\/|wp-includes\//i],
  ["TYPO3", /typo3(?:conf|temp)?\//i],
  ["Joomla", /\/media\/jui\/|\/components\/com_|joomla/i],
  ["Drupal", /\/sites\/default\/files\/|drupal/i],
  ["Contao", /contao|\/assets\/contao\//i],
];

export function detectCms(html: string, generator: string | null): string | null {
  if (generator) {
    const g = generator.toLowerCase();
    const byGenerator = CMS_SIGNATURES.find(
      ([name, re]) => re.test(generator) || g.startsWith(name.toLowerCase().split(" ")[0]!),
    );
    if (byGenerator) return byGenerator[0];
  }
  return CMS_SIGNATURES.find(([, re]) => re.test(html))?.[0] ?? (generator ? short(generator, 40) : null);
}

/** Neuestes plausibles Jahr hinter ©/Copyright, z. B. "© 2014–2019 Fahrrad Müller" → 2019. */
export function copyrightYear(text: string, now: Date = new Date()): number | null {
  const maxYear = now.getUTCFullYear() + 1;
  let best: number | null = null;
  const re = /(?:©|\(c\)|copyright)\s*(?:by\s+)?((?:19|20)\d{2})(?:\s*[-–—/]\s*((?:19|20)\d{2}))?/gi;
  for (const m of text.matchAll(re)) {
    for (const y of [m[1], m[2]]) {
      const year = Number(y);
      if (y && year >= 1995 && year <= maxYear && (best === null || year > best)) best = year;
    }
  }
  return best;
}

const SOCIAL = /(?:facebook|instagram|tiktok|youtube|linkedin|xing|pinterest|x|twitter)\.com/i;
const CTA_WORDS =
  /termin|anfrage|anfragen|kontakt|angebot|jetzt|buchen|anrufen|bestellen|reservier|beratung|probefahrt|vereinbaren|zum shop|online-shop/i;

function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** Link per Linktext oder URL finden (z. B. Impressum, Leistungen). Gleiche Website bevorzugt. */
export function findLink($: CheerioAPI, base: string, keywords: readonly string[]): string | null {
  const host = new URL(base).hostname.replace(/^www\./, "");
  let fallback: string | null = null;
  for (const el of $("a[href]").toArray()) {
    const href = $(el).attr("href");
    if (!href || /^(mailto|tel|javascript):|^#/i.test(href)) continue;
    const text = clean($(el).text()).toLowerCase();
    const url = absolute(href, base);
    if (!url) continue;
    const hit = keywords.some((k) => text.includes(k) || url.toLowerCase().includes(k.replace(/\s+/g, "-")));
    if (!hit) continue;
    if (new URL(url).hostname.replace(/^www\./, "") === host) return url;
    fallback ??= url;
  }
  return fallback;
}

/** Sichtbarer Text mit Zeilenumbrüchen an Block-Grenzen (für Wortzahl, Impressum, Audit). */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, template, iframe").remove();
  $("br").replaceWith("\n");
  $("p, div, li, h1, h2, h3, h4, h5, h6, tr, section, article, header, footer, address, td, dd, dt").each(
    (_, el) => {
      $(el).append("\n");
    },
  );
  return $("body")
    .text()
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Gekürzter Text für das Audit: höchstens `maxWords` Wörter. */
export function textExcerpt(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? words.join(" ") : `${words.slice(0, maxWords).join(" ")} …`;
}

export function extractFacts(html: string, pageUrl: string, now: Date = new Date()): PageFacts {
  const $ = cheerio.load(html);
  const text = htmlToText(html);
  const generator = $('meta[name="generator" i]').attr("content")?.trim() || null;
  const viewport = $('meta[name="viewport" i]').attr("content")?.trim() || null;

  const links = $("a[href]").toArray();
  const hrefs = links.map((el) => $(el).attr("href") ?? "");
  const navItems = $("nav a, header a, [role=navigation] a, .menu a, #menu a, .nav a")
    .toArray()
    .map((el) => short($(el).text(), 40));
  const ctas = $("a, button, input[type=submit]")
    .toArray()
    .map((el) => short($(el).text() || $(el).attr("value") || "", 50))
    .filter((t) => t.length > 1 && CTA_WORDS.test(t));
  const images = $("img").toArray();
  const forms = $("form").toArray();

  return {
    title: short($("title").first().text(), 120) || null,
    meta_description: short($('meta[name="description" i]').attr("content") ?? "", 200) || null,
    lang: $("html").attr("lang")?.trim() || null,
    h1: uniq(
      $("h1")
        .toArray()
        .map((el) => short($(el).text(), 120)),
      5,
    ),
    nav_items: uniq(navItems, 20),
    cta_texts: uniq(ctas, 10),
    tel_links: uniq(
      hrefs.filter((h) => /^tel:/i.test(h)).map((h) => clean(decodeURIComponent(h.slice(4)))),
      5,
    ),
    mailto_links: uniq(
      hrefs
        .filter((h) => /^mailto:/i.test(h))
        .map((h) => clean(decodeURIComponent(h.slice(7).split("?")[0]!)).toLowerCase()),
      5,
    ),
    has_viewport_meta: viewport !== null,
    viewport,
    generator,
    cms: detectCms(html, generator),
    copyright_year: copyrightYear(text, now),
    word_count: text.split(/\s+/).filter(Boolean).length,
    image_count: images.length,
    images_without_alt: images.filter((el) => !$(el).attr("alt")?.trim()).length,
    link_count: links.length,
    form_count: forms.length,
    has_contact_form: forms.some(
      (el) => $(el).find('textarea, input[type="email" i], input[name*="mail" i]').length > 0,
    ),
    social_links: uniq(
      hrefs
        .map((h) => absolute(h, pageUrl))
        .filter((u): u is string => u !== null && SOCIAL.test(new URL(u).hostname)),
      8,
    ),
    impressum_url: findLink($, pageUrl, ["impressum", "imprint"]),
    privacy_url: findLink($, pageUrl, ["datenschutz", "privacy"]),
    iframe_count: $("iframe").length,
    // Tabellen ohne Kopfzeile mit Bildern oder vielen Zellen: typisches Layout der 2000er.
    layout_tables: $("table")
      .toArray()
      .filter(
        (el) =>
          $(el).find("th").length === 0 && ($(el).find("img").length > 0 || $(el).find("td").length >= 6),
      ).length,
    has_favicon: $('link[rel~="icon" i]').length > 0,
    has_open_graph: $('meta[property^="og:"]').length > 0,
    has_structured_data: $('script[type="application/ld+json"]').length > 0,
    html_kb: Math.round(Buffer.byteLength(html, "utf8") / 1024),
  };
}
