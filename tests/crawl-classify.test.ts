import { describe, expect, it } from "vitest";
import {
  classifyNavigationError,
  CrawlError,
  detectUnusablePage,
  homepageUrl,
  isSocialOnly,
  normalizeSiteUrl,
} from "../src/pipeline/crawl/classify.js";
import { parseCrawlArgs } from "../src/cli-args.js";

describe("Crawl-Fehler klassifizieren", () => {
  it("Chromium-Meldungen → Fehlerart", () => {
    expect(classifyNavigationError("page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.de/")).toBe(
      "unreachable",
    );
    expect(classifyNavigationError("net::ERR_CONNECTION_REFUSED")).toBe("unreachable");
    expect(classifyNavigationError("page.goto: Timeout 30000ms exceeded.")).toBe("timeout");
    expect(classifyNavigationError("net::ERR_CERT_DATE_INVALID")).toBe("tls_error");
    expect(classifyNavigationError("net::ERR_SSL_PROTOCOL_ERROR")).toBe("tls_error");
  });

  it("Bot-Schutz und leere Seiten erkennen", () => {
    const base = { title: "Fahrrad Müller", wordCount: 300, imageCount: 5, html: "<html></html>" };
    expect(detectUnusablePage(base)).toBeNull();
    expect(detectUnusablePage({ ...base, title: "Just a moment...", wordCount: 12 })).toMatchObject({
      kind: "blocked",
    });
    expect(detectUnusablePage({ ...base, html: '<div class="g-recaptcha">', wordCount: 20 })).toMatchObject({
      kind: "blocked",
    });
    // Viel Inhalt + Captcha im Kontaktformular ist kein Bot-Schutz.
    expect(detectUnusablePage({ ...base, html: '<div class="g-recaptcha">', wordCount: 800 })).toBeNull();
    expect(detectUnusablePage({ ...base, wordCount: 3, imageCount: 0 })).toMatchObject({ kind: "empty" });
  });

  it("Social-Media-Profile statt Website", () => {
    expect(isSocialOnly("https://www.facebook.com/radlmeier")).toBe(true);
    expect(isSocialOnly("https://m.facebook.com/x")).toBe(true);
    expect(isSocialOnly("https://www.instagram.com/x/")).toBe(true);
    expect(isSocialOnly("https://radhaus.jimdofree.com/")).toBe(false);
    expect(isSocialOnly("https://www.radlmeier.com/")).toBe(false);
  });

  it("URL normalisieren und Unterseiten auf die Startseite zurückführen", () => {
    expect(normalizeSiteUrl("www.radl.de")).toBe("https://www.radl.de/");
    expect(normalizeSiteUrl(" http://radl.de/shop ")).toBe("http://radl.de/shop");
    expect(() => normalizeSiteUrl("ftp://radl.de")).toThrow(CrawlError);
    expect(homepageUrl("https://mr-bike.com/en/contact-us/")).toBe("https://mr-bike.com/");
    expect(homepageUrl("https://radl.de/kontakt.html")).toBe("https://radl.de/");
    expect(homepageUrl("https://radl.de/de/")).toBe("https://radl.de/de/");
    expect(homepageUrl("https://radl.de/kontaktlinsen-shop/")).toBe("https://radl.de/kontaktlinsen-shop/");
  });
});

describe("parseCrawlArgs", () => {
  it("eine Firma oder offene Firmen", () => {
    expect(parseCrawlArgs(["radl.de"])).toEqual({ mode: "one", ref: "radl.de" });
    expect(parseCrawlArgs(["--pending"])).toEqual({ mode: "pending", limit: 10 });
    expect(parseCrawlArgs(["--pending", "-n", "3"])).toEqual({ mode: "pending", limit: 3 });
    expect(() => parseCrawlArgs([])).toThrow(/Verwendung/);
    expect(() => parseCrawlArgs(["--pending", "-n", "0"])).toThrow(/-n/);
    expect(() => parseCrawlArgs(["a", "b"])).toThrow(/Verwendung/);
  });
});
