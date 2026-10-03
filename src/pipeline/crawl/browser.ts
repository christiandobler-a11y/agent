import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { CrawlError, classifyNavigationError, isCertificateError } from "./classify.js";
import type { CrawlConfig } from "./config.js";
import { findLink } from "./facts.js";
import { IMAGE_SCRIPT, type ImageCandidate } from "./images.js";
import * as cheerio from "cheerio";

/**
 * Rendert eine Website mit Chromium: Startseite desktop + mobil (Screenshots), dazu Impressum und eine
 * Leistungen-Seite als HTML. Gecrawlter Inhalt ist fremd und nicht vertrauenswürdig: Er wird nur
 * gespeichert und regelbasiert ausgewertet, nie ausgeführt oder an Tools weitergereicht.
 */

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** Typische Zustimmungs-Buttons; ein Klick macht die Screenshots aussagekräftiger (Banner verdeckt sonst die Seite). */
const CONSENT_BUTTON =
  /^\s*(alle\s+)?(akzeptieren|annehmen|zustimmen|erlauben|accept( all)?|allow all|einverstanden|ok|verstanden|alle cookies akzeptieren)\s*!?\s*$/i;

/** Ergebnis von `promise`, oder `fallback`, wenn es länger als `ms` dauert. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SubpageCapture {
  url: string;
  html: string;
}

export interface SiteCapture {
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  html: string;
  title: string | null;
  /** false: Zertifikat ungültig; Seite wurde ohne Prüfung geladen, um sie trotzdem bewerten zu können. */
  tlsValid: boolean;
  cookieBannerClicked: boolean;
  /**
   * Mobil: um wie viele CSS-Pixel die Seite breiter ist als der Bildschirm. Chrome verkleinert solche Seiten
   * (Text wird kleiner), wenige Pixel fallen nicht auf.
   */
  mobileOverflowPx: number;
  desktopScreenshot: string;
  mobileScreenshot: string;
  impressum: SubpageCapture | null;
  services: SubpageCapture | null;
  /** Bilder der Startseite (desktop) für Prototypen; fehlt bei älteren Erfassungen. */
  images?: ImageCandidate[];
}

export interface BrowserCrawlerOptions {
  config: CrawlConfig;
  /** Eigener Chromium (z. B. in Cloud-Sessions); sonst der von Playwright installierte. */
  executablePath?: string | undefined;
  /** HTTP(S)-Proxy für den Browser, z. B. aus HTTPS_PROXY. */
  proxy?: string | undefined;
}

export interface BrowserCrawler {
  /**
   * `acceptInvalidTls`: bei ungültigem Zertifikat die Seite trotzdem laden (Standard). `false` für den
   * HTTPS-Versuch einer http://-Adresse: dort zählt nur eine einwandfreie HTTPS-Version.
   */
  crawl(
    url: string,
    screenshots: { desktop: string; mobile: string },
    options?: { acceptInvalidTls?: boolean },
  ): Promise<SiteCapture>;
  close(): Promise<void>;
}

export async function createBrowserCrawler(options: BrowserCrawlerOptions): Promise<BrowserCrawler> {
  const { config } = options;
  const browser: Browser = await chromium.launch({
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(options.proxy ? { proxy: { server: options.proxy } } : {}),
  });
  const timeout = config.navigation_timeout_s * 1000;

  async function newContext(kind: "desktop" | "mobile", ignoreHTTPSErrors: boolean): Promise<BrowserContext> {
    const v = config[kind];
    const context = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      deviceScaleFactor: v.scale,
      isMobile: kind === "mobile",
      hasTouch: kind === "mobile",
      userAgent: kind === "mobile" ? MOBILE_UA : DESKTOP_UA,
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      ignoreHTTPSErrors,
      serviceWorkers: "block",
    });
    context.setDefaultTimeout(timeout);
    return context;
  }

  async function open(page: Page, url: string) {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    // "load" kann bei Tracking-Skripten ewig dauern; nach kurzer Zeit reicht DOMContentLoaded.
    await page.waitForLoadState("load", { timeout: Math.min(timeout, 10_000) }).catch(() => undefined);
    await page.waitForTimeout(config.settle_ms);
    // Was jetzt noch lädt (hängende iframes, Tracker), sieht ein Besucher nicht mehr; sonst warten Screenshots ewig.
    await withDeadline(page.evaluate("window.stop()"), 1000, undefined);
    return response;
  }

  async function findAndClickConsent(page: Page): Promise<boolean> {
    for (const frame of page.frames()) {
      const button = frame.getByRole("button", { name: CONSENT_BUTTON }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 1500 }).catch(() => undefined);
        await page.waitForTimeout(500);
        return true;
      }
    }
    return false;
  }

  /** Höchstens 3 s: Eingebettete Frames (Karten, Widgets) können Abfragen sonst unbegrenzt blockieren. */
  async function dismissConsent(page: Page): Promise<boolean> {
    return withDeadline(findAndClickConsent(page), 3000, false);
  }

  /**
   * Schrittweise bis zur Screenshot-Höhe scrollen und zurück: Lazy-Loading-Bilder und Scroll-Animationen
   * erscheinen sonst nicht, und der Screenshot zeigt eine halb leere Seite.
   */
  async function revealContent(page: Page, kind: "desktop" | "mobile") {
    const v = config[kind];
    const limit = v.height * config.screenshot_screens;
    const script = `(async () => {
      const step = ${Math.round(v.height * 0.8)};
      for (let y = 0; y < Math.min(document.documentElement.scrollHeight, ${limit}); y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    })()`;
    await withDeadline(page.evaluate(script), 8000, undefined);
    await page.waitForTimeout(Math.min(config.settle_ms, 1000));
  }

  async function screenshot(page: Page, path: string, kind: "desktop" | "mobile") {
    await mkdir(dirname(path), { recursive: true });
    await revealContent(page, kind);
    const v = config[kind];
    // Ausdrücke als String: läuft im Browser, das Projekt kennt keine DOM-Typen.
    const fullHeight = Number(
      await page.evaluate("document.documentElement.scrollHeight").catch(() => v.height),
    );
    const height = Math.max(v.height, Math.min(fullHeight, v.height * config.screenshot_screens));
    await page.screenshot({
      path,
      type: "jpeg",
      quality: config.jpeg_quality,
      fullPage: true,
      clip: { x: 0, y: 0, width: v.width, height },
      animations: "disabled",
    });
  }

  /** Inhalt lesen; leitet die Seite gerade per JavaScript weiter, nach der Weiterleitung erneut versuchen. */
  async function readContent(page: Page): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await page.content();
      } catch (err) {
        if (attempt >= 2 || !/navigating|context was destroyed/i.test(String(err))) throw err;
        await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
        await page.waitForTimeout(Math.min(config.settle_ms, 1000));
      }
    }
  }

  async function subpage(page: Page, url: string | null): Promise<SubpageCapture | null> {
    if (!url) return null;
    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      if (!res || res.status() >= 400) return null;
      await page.waitForTimeout(Math.min(config.settle_ms, 800));
      return { url: page.url(), html: await readContent(page) };
    } catch {
      return null;
    }
  }

  /**
   * Gesamt-Deadline je Seitenbesuch: Nach Ablauf werden die Kontexte geschlossen (offene Playwright-Aufrufe
   * brechen dann ab) und die Seite zählt als Timeout. So blockiert keine einzelne Website den Lauf.
   */
  async function capture(url: string, shots: { desktop: string; mobile: string }, ignoreTls: boolean) {
    const contexts: BrowserContext[] = [];
    const deadlineMs = timeout * 4;
    const work = captureWithin(contexts, url, shots, ignoreTls);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CrawlError("timeout", `Seite nicht in ${deadlineMs / 1000} s erfasst: ${url}`)),
        deadlineMs,
      );
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
      await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
      work.catch(() => undefined); // läuft nach dem Schließen ins Leere
    }
  }

  async function captureWithin(
    contexts: BrowserContext[],
    url: string,
    shots: { desktop: string; mobile: string },
    ignoreTls: boolean,
  ) {
    const desktop = await newContext("desktop", ignoreTls);
    contexts.push(desktop);
    const mobile = await newContext("mobile", ignoreTls);
    contexts.push(mobile);
    try {
      const page = await desktop.newPage();
      const response = await open(page, url);
      const status = response?.status() ?? null;
      if (status !== null && status >= 400) {
        throw new CrawlError("http_error", `HTTP ${status} für ${url}`);
      }
      const contentType = (await response?.headerValue("content-type")) ?? "text/html";
      if (!/html/i.test(contentType)) throw new CrawlError("not_html", `Keine Website (${contentType})`);

      const cookieBannerClicked = await dismissConsent(page);
      const html = await readContent(page);
      const finalUrl = page.url(); // nach readContent: eine JS-Weiterleitung ist dann abgeschlossen
      const title = (await page.title().catch(() => "")) || null;
      await screenshot(page, shots.desktop, "desktop");
      // Nach dem Screenshot sind Lazy-Loading-Bilder geladen.
      const images = await withDeadline(
        page.evaluate(IMAGE_SCRIPT).then((v) => (Array.isArray(v) ? (v as ImageCandidate[]) : [])),
        4000,
        [] as ImageCandidate[],
      );

      const mobilePage = await mobile.newPage();
      await open(mobilePage, finalUrl);
      await dismissConsent(mobilePage);
      const mobileOverflowPx = await mobilePage
        .evaluate(
          `Math.max(document.documentElement.scrollWidth, window.innerWidth) - ${config.mobile.width}`,
        )
        .then((v) => Math.max(0, Math.round(Number(v) || 0)))
        .catch(() => 0);
      await screenshot(mobilePage, shots.mobile, "mobile");

      const $ = cheerio.load(html);
      const origin = new URL(finalUrl).origin;
      const impressumUrl = findLink($, finalUrl, config.subpages.impressum);
      const servicesUrl =
        config.subpages.services.length > 0 ? findLink($, finalUrl, config.subpages.services) : null;
      const impressum =
        (await subpage(page, impressumUrl)) ??
        (impressumUrl ? null : await subpage(page, `${origin}/impressum`));
      const services = servicesUrl && servicesUrl !== impressumUrl ? await subpage(page, servicesUrl) : null;

      return {
        requestedUrl: url,
        finalUrl,
        httpStatus: status,
        html,
        title,
        tlsValid: !ignoreTls,
        cookieBannerClicked,
        mobileOverflowPx,
        desktopScreenshot: shots.desktop,
        mobileScreenshot: shots.mobile,
        impressum,
        services,
        images,
      } satisfies SiteCapture;
    } finally {
      await desktop.close().catch(() => undefined);
      await mobile.close().catch(() => undefined);
    }
  }

  return {
    async crawl(url, shots, crawlOptions) {
      try {
        return await capture(url, shots, false);
      } catch (err) {
        if (err instanceof CrawlError) throw err;
        const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
        // Ungültiges Zertifikat ist selbst ein Befund (Besucher sehen eine Warnung): Seite trotzdem ansehen.
        if (isCertificateError(message) && crawlOptions?.acceptInvalidTls !== false) {
          try {
            return await capture(url, shots, true);
          } catch (retryErr) {
            if (retryErr instanceof CrawlError) throw retryErr;
          }
          throw new CrawlError("tls_error", message);
        }
        throw new CrawlError(classifyNavigationError(message), message);
      }
    },
    async close() {
      await browser.close();
    },
  };
}
