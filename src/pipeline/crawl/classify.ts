/** Fehlerarten beim Crawlen (ARCHITECTURE.md 11.2): klar benannt statt Absturz. Rein. */

export const CRAWL_ERROR_KINDS = [
  "invalid_url", // keine brauchbare URL
  "social_only", // "Website" ist nur Facebook/Instagram & Co.
  "unreachable", // DNS, Verbindung abgelehnt, Netz
  "timeout",
  "tls_error", // Zertifikat ungültig, auch ohne Prüfung nicht ladbar
  "http_error", // Status ≥ 400
  "not_html", // z. B. PDF statt Website
  "blocked", // Bot-Schutz, Captcha, Zugriff verweigert
  "empty", // Seite lädt, zeigt aber (fast) nichts
] as const;

export type CrawlErrorKind = (typeof CRAWL_ERROR_KINDS)[number];

export class CrawlError extends Error {
  constructor(
    readonly kind: CrawlErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CrawlError";
  }
}

/** Fehlermeldung von Chromium/Playwright → Fehlerart. */
export function classifyNavigationError(message: string): CrawlErrorKind {
  if (/timeout|ERR_TIMED_OUT/i.test(message)) return "timeout";
  if (/ERR_CERT_|ERR_SSL_|SSL_PROTOCOL|certificate/i.test(message)) return "tls_error";
  if (/ERR_INVALID_URL|invalid url/i.test(message)) return "invalid_url";
  // Neuere Chromium-Versionen laden PDFs & Co. herunter statt sie anzuzeigen.
  if (/download is starting|ERR_ABORTED.*download/i.test(message)) return "not_html";
  return "unreachable";
}

export function isCertificateError(message: string): boolean {
  return classifyNavigationError(message) === "tls_error";
}

const SOCIAL_HOSTS = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "tiktok.com",
  "linktr.ee",
  "youtube.com",
  "linkedin.com",
  "xing.com",
  "g.page",
  "business.google.com",
  "maps.google.com",
  "goo.gl",
];

/** Zeigt die "Website" nur auf ein soziales Netzwerk oder Google? Dann gibt es nichts zu crawlen. */
export function isSocialOnly(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const BLOCK_SIGNS =
  /just a moment|attention required|checking your browser|cf-chl|captcha|access denied|zugriff verweigert|request blocked|ddos protection|bot verification|are you a robot/i;

/** Bot-Schutz oder leere Seite erkennen (nach dem Rendern). `null` = Seite brauchbar. */
export function detectUnusablePage(page: {
  title: string | null;
  wordCount: number;
  imageCount: number;
  html: string;
}): { kind: "blocked" | "empty"; reason: string } | null {
  const head = `${page.title ?? ""} ${page.html.slice(0, 20_000)}`;
  if (BLOCK_SIGNS.test(head) && page.wordCount < 150) {
    return { kind: "blocked", reason: `Bot-Schutz erkannt (${page.title ?? "ohne Titel"})` };
  }
  if (page.wordCount < 10 && page.imageCount === 0) {
    return { kind: "empty", reason: `Seite ohne Inhalt (${page.wordCount} Wörter, keine Bilder)` };
  }
  return null;
}

/** Google verlinkt manchmal direkt eine Unterseite; für das Audit zählt die Startseite. */
const SUBPAGE_PATH =
  /\/(?:[a-z]{2}\/)?(?:kontakt|contact(?:-us)?|impressum|imprint|anfahrt|about(?:-us)?|ueber-uns|uber-uns|team|oeffnungszeiten|standort|location)(?:[/.?#]|$)/i;

export function homepageUrl(url: string): string {
  const u = new URL(url);
  return SUBPAGE_PATH.test(u.pathname) ? `${u.origin}/` : u.toString();
}

/** URL aus Google ergänzen/prüfen: Schema ergänzen, nur http(s). */
export function normalizeSiteUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CrawlError("invalid_url", `Keine gültige URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CrawlError("invalid_url", `Kein http(s): ${raw}`);
  }
  return url.toString();
}
