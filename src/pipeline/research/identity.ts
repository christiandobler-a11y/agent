/**
 * Firmenidentität (ARCHITECTURE.md Abschnitt 8): reine Normalisierungsfunktionen.
 * Abgleich-Reihenfolge: Place-ID → Domain-Schlüssel → normalisierter Name + PLZ.
 */

/**
 * Plattformen, deren Domain keine Firma identifiziert. Dort zählt Host + Pfad
 * (z. B. facebook.com/fahrradmueller, radhaus.jimdofree.com).
 */
const PLATFORM_DOMAINS = [
  // Social, Link-Sammlungen, Google
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "linkedin.com",
  "xing.com",
  "linktr.ee",
  "google.com",
  "g.page",
  "goo.gl",
  // Baukästen mit Subdomain bzw. Pfad je Kunde
  "jimdo.com",
  "jimdofree.com",
  "jimdosite.com",
  "wixsite.com",
  "business.site",
  "webnode.page",
  "site123.me",
  "wordpress.com",
  "blogspot.com",
  "squarespace.com",
  "weebly.com",
  "strikingly.com",
  "mystrikingly.com",
  // Branchenportale
  "gelbeseiten.de",
  "dasoertliche.de",
  "das-telefonbuch.de",
  "11880.com",
  "yelp.de",
  "yelp.com",
  "meinestadt.de",
] as const;

function isPlatformHost(host: string): boolean {
  return PLATFORM_DOMAINS.some((p) => host === p || host.endsWith(`.${p}`));
}

/**
 * Identitätsschlüssel aus einer Website-URL.
 * Eigene Domains: Host ohne Protokoll, `www.`, Port und Pfad, klein geschrieben.
 * Plattform-Domains: Host + Pfad; ohne Pfad und ohne eigene Subdomain gibt es keinen Schlüssel.
 * Gibt `null` zurück, wenn sich keine Identität ableiten lässt.
 */
export function domainIdentity(rawUrl: string | null | undefined): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    // Ein Schema ist "xyz:" ohne folgende Ziffer (sonst ist es ein Port wie in "example.de:8080").
    const hasScheme = /^[a-z][a-z\d+.-]*:(?!\d)/i.test(trimmed);
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username) return null;

  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!host.includes(".")) return null;
  if (!isPlatformHost(host)) return host;

  const path = url.pathname.toLowerCase().replace(/\/+$/, "");
  const isBarePlatform = PLATFORM_DOMAINS.includes(host as (typeof PLATFORM_DOMAINS)[number]);
  if (isBarePlatform && path === "") return null;
  return `${host}${path}`;
}

const LEGAL_FORM_PHRASES = [
  /\bgmbh\s*(?:&|und|\+)\s*co\s*kg(?:aa)?\b/g,
  /\bug\s*\(?\s*haftungsbeschraenkt\s*\)?/g,
  // "e. K.", "e. Kfm.", "e. V.", "e. G." (Punkte sind zu diesem Zeitpunkt schon entfernt)
  /\be\s+(?:k|kfm|kfr|v|g)\b/g,
];

const LEGAL_FORM_TOKENS = new Set([
  "gmbh",
  "mbh",
  "ggmbh",
  "ug",
  "ag",
  "kg",
  "kgaa",
  "ohg",
  "gbr",
  "ek",
  "ekfm",
  "ekfr",
  "ev",
  "eg",
  "partg",
  "partgmbb",
  "ltd",
  "limited",
  "inc",
  "inh",
  "inhaber",
  "co",
]);

function transliterate(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Normalisierter Firmenname für den Abgleich: Kleinschreibung, Umlaute ausgeschrieben, Akzente und
 * Satzzeichen entfernt, Rechtsformen (GmbH, e.K., UG (haftungsbeschränkt) …) gestrichen.
 */
export function normalizeName(name: string): string {
  let s = transliterate(name).replace(/\./g, "");
  for (const phrase of LEGAL_FORM_PHRASES) s = s.replace(phrase, " ");
  s = s.replace(/[&+]/g, " und ");
  const tokens = s.split(/[^a-z0-9]+/).filter(Boolean);
  const withoutLegal = tokens.filter((t) => !LEGAL_FORM_TOKENS.has(t));
  return (withoutLegal.length > 0 ? withoutLegal : tokens).join(" ");
}

/** Deutsche PLZ (5 Ziffern) oder `null`. */
export function normalizePostalCode(postalCode: string | null | undefined): string | null {
  const digits = postalCode?.replace(/\s/g, "");
  return digits && /^\d{5}$/.test(digits) ? digits : null;
}
