import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { recordApiUsage } from "../../db/apiUsage.js";
import type { Db } from "../../db/client.js";
import { clearCrawlFailure, markNoWebsite, setFailed, type Company } from "../../db/companies.js";
import { replaceImpressumContacts } from "../../db/contacts.js";
import { insertWebsiteSnapshot, type WebsiteSnapshot } from "../../db/websiteSnapshots.js";
import { normalizeName } from "../research/identity.js";
import { computeRecheckAfter, type RecheckRules } from "../research/recheck.js";
import type { BrowserCrawler, SiteCapture } from "./browser.js";
import { CrawlError, detectUnusablePage, homepageUrl, isSocialOnly, normalizeSiteUrl } from "./classify.js";
import type { CrawlConfig } from "./config.js";
import { extractFacts, htmlToText, textExcerpt, type PageFacts } from "./facts.js";
import { parseImpressum, type ImpressumData } from "./impressum.js";
import type { PageSpeedClient, PsiResult } from "./pagespeed.js";

/**
 * Crawl einer Firma (ARCHITECTURE.md 5.2 Schritt 7): ein Job = eine Firma × ein Schritt, idempotent im Sinne
 * von "jeder Lauf schreibt einen neuen, vollständigen Snapshot". Browser und PageSpeed laufen parallel.
 */

export interface CrawlDeps {
  db: Db;
  crawler: BrowserCrawler;
  pagespeed: PageSpeedClient | null;
  config: CrawlConfig;
  recheck: RecheckRules;
  now?: () => Date;
}

export interface SiteFacts extends PageFacts {
  https: boolean;
  tls_valid: boolean;
  redirected: boolean;
  /** Mobil deutlich zu breit (mehr als 10 % der Bildschirmbreite): Seite wird verkleinert dargestellt. */
  mobile_too_wide: boolean;
  mobile_overflow_px: number;
  cookie_banner_clicked: boolean;
  impressum: (ImpressumData & { url: string }) | null;
  services_url: string | null;
}

export type CrawlOutcome =
  | {
      kind: "ok";
      snapshot: WebsiteSnapshot;
      facts: SiteFacts;
      psi: PsiResult | null;
      psiError: string | null;
    }
  | { kind: "failed"; snapshot: WebsiteSnapshot; errorKind: string; error: string }
  | { kind: "social_only"; snapshot: WebsiteSnapshot }
  | { kind: "no_website" };

/** Fingerabdruck des Inhalts: gleicher Hash beim Recheck → kein neues Audit nötig (ARCHITECTURE.md 8). */
export function contentHash(title: string | null, text: string): string {
  const normalized = `${title ?? ""}\n${text}`.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function screenshotPaths(config: CrawlConfig, companyId: string, now: Date) {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const base = join(config.screenshot_dir, companyId, `${stamp}-${randomUUID().slice(0, 8)}`);
  return { desktop: `${base}-desktop.jpg`, mobile: `${base}-mobile.jpg` };
}

/** Steht im Impressum statt einer Person nur der Firmenname, gibt es keine Person. */
function withoutCompanyName(data: ImpressumData, companyName: string): ImpressumData {
  if (!data.person) return data;
  const person = normalizeName(data.person);
  const company = normalizeName(companyName);
  return person === company || company.includes(person)
    ? { ...data, person: null, role: null, salutation: null }
    : data;
}

export function buildFacts(
  capture: SiteCapture,
  now: Date,
  mobileWidth: number,
  companyName = "",
): SiteFacts {
  const facts = extractFacts(capture.html, capture.finalUrl, now);
  const impressum = capture.impressum
    ? {
        url: capture.impressum.url,
        ...withoutCompanyName(parseImpressum(htmlToText(capture.impressum.html)), companyName),
      }
    : null;
  return {
    ...facts,
    https: new URL(capture.finalUrl).protocol === "https:",
    tls_valid: capture.tlsValid,
    redirected: new URL(capture.finalUrl).hostname !== new URL(capture.requestedUrl).hostname,
    mobile_too_wide: capture.mobileOverflowPx > mobileWidth * 0.1,
    mobile_overflow_px: capture.mobileOverflowPx,
    cookie_banner_clicked: capture.cookieBannerClicked,
    impressum,
    impressum_url: impressum?.url ?? facts.impressum_url,
    services_url: capture.services?.url ?? null,
  };
}

/**
 * http://-Adressen (aus Google) zuerst per HTTPS versuchen: Viele Seiten können HTTPS, Google kennt nur die alte
 * Adresse. Gilt nur bei einwandfreiem Zertifikat; sonst zählt die http-Version (fehlendes HTTPS ist ein Befund).
 */
async function captureSite(
  crawler: BrowserCrawler,
  url: string,
  shots: { desktop: string; mobile: string },
): Promise<SiteCapture> {
  if (!url.startsWith("http://")) return crawler.crawl(url, shots);
  let httpsError: string;
  try {
    return await crawler.crawl(`https://${url.slice("http://".length)}`, shots, { acceptInvalidTls: false });
  } catch (err) {
    httpsError = err instanceof Error ? err.message : String(err);
  }
  try {
    return await crawler.crawl(url, shots);
  } catch (err) {
    // Beide Gründe nennen, sonst ist ein Fehlschlag später nicht nachvollziehbar.
    if (err instanceof CrawlError)
      throw new CrawlError(err.kind, `${err.message} (HTTPS-Versuch: ${httpsError})`);
    throw err;
  }
}

export async function crawlCompany(deps: CrawlDeps, company: Company): Promise<CrawlOutcome> {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  if (!company.website_url) return { kind: "no_website" };

  const fail = async (url: string, err: CrawlError): Promise<CrawlOutcome> => {
    const snapshot = await insertWebsiteSnapshot(db, {
      companyId: company.id,
      url,
      error: err.message.slice(0, 500),
      errorKind: err.kind,
    });
    await setFailed(
      db,
      company.id,
      `Crawl: ${err.kind} – ${err.message.slice(0, 200)}`,
      computeRecheckAfter(deps.recheck, "FAILED", null, now()),
    );
    return { kind: "failed", snapshot, errorKind: err.kind, error: err.message };
  };

  let url: string;
  try {
    url = homepageUrl(normalizeSiteUrl(company.website_url));
  } catch (err) {
    if (err instanceof CrawlError) return fail(company.website_url, err);
    throw err;
  }

  if (isSocialOnly(url)) {
    const snapshot = await insertWebsiteSnapshot(db, {
      companyId: company.id,
      url,
      error: "Website ist nur ein Social-Media-Profil",
      errorKind: "social_only",
    });
    await markNoWebsite(db, company.id);
    return { kind: "social_only", snapshot };
  }

  const shots = screenshotPaths(config, company.id, now());
  const [captureResult, psiResult] = await Promise.allSettled([
    captureSite(deps.crawler, url, shots),
    deps.pagespeed ? deps.pagespeed.run(url) : Promise.resolve(null),
  ]);
  if (deps.pagespeed) {
    // PageSpeed ist kostenlos, wird aber für die Übersicht (und Kontingent-Probleme) mitgezählt.
    await recordApiUsage(db, {
      service: "pagespeed",
      operation: "runPagespeed",
      costUsd: 0,
      companyId: company.id,
    });
  }

  if (captureResult.status === "rejected") {
    const err = captureResult.reason as unknown;
    if (err instanceof CrawlError) return fail(url, err);
    throw err;
  }
  const capture = captureResult.value;
  const facts = buildFacts(capture, now(), config.mobile.width, company.name);

  const unusable = detectUnusablePage({
    title: capture.title,
    wordCount: facts.word_count,
    imageCount: facts.image_count,
    html: capture.html,
  });
  if (unusable) return fail(url, new CrawlError(unusable.kind, unusable.reason));

  const text = [htmlToText(capture.html), capture.services ? htmlToText(capture.services.html) : ""]
    .filter(Boolean)
    .join("\n\n");
  const psi = psiResult.status === "fulfilled" ? psiResult.value : null;
  const psiError =
    psiResult.status === "rejected"
      ? psiResult.reason instanceof Error
        ? psiResult.reason.message
        : String(psiResult.reason)
      : null;

  const snapshot = await insertWebsiteSnapshot(db, {
    companyId: company.id,
    url,
    finalUrl: capture.finalUrl,
    httpStatus: capture.httpStatus,
    https: facts.https,
    facts,
    psi: psi ?? (psiError ? { error: psiError.slice(0, 300) } : null),
    screenshotDesktop: capture.desktopScreenshot,
    screenshotMobile: capture.mobileScreenshot,
    contentHash: contentHash(capture.title, text),
    textExcerpt: textExcerpt(text, config.text_max_words),
  });

  await clearCrawlFailure(db, company.id);
  if (facts.impressum) {
    const imp = facts.impressum;
    await replaceImpressumContacts(db, company.id, [
      {
        name: imp.person,
        salutation: imp.salutation ?? null,
        role: imp.role,
        email: imp.emails[0] ?? null,
        phone: imp.phones[0] ?? null,
      },
    ]);
  }
  return { kind: "ok", snapshot, facts, psi, psiError };
}
