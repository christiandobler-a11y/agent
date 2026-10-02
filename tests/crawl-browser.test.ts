import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserCrawler, withDeadline, type BrowserCrawler } from "../src/pipeline/crawl/browser.js";
import { CrawlError } from "../src/pipeline/crawl/classify.js";
import type { CrawlConfig } from "../src/pipeline/crawl/config.js";

/** Echter Chromium gegen einen lokalen Testserver (kein Internet). Ohne Browser übersprungen. */
const executablePath = process.env.CHROMIUM_PATH;
const browserAvailable = existsSync(executablePath ?? chromium.executablePath());
if (!browserAvailable && process.env.CI) throw new Error("In der CI muss Chromium installiert sein.");

const modern = readFileSync(new URL("./fixtures/sites/modern-site.html", import.meta.url), "utf8");
const IMPRESSUM = `<html><body><h1>Impressum</h1><p>Radhaus Berg GmbH<br>Geschäftsführer: Peter Berg<br>
Telefon: 08031 123456<br>E-Mail: info@radhaus-berg.de</p></body></html>`;
const WIDE = `<html><head><meta name="viewport" content="width=device-width"></head>
<body><div style="width:1200px">Zu breit für Handys, Text Text Text</div></body></html>`;

const config: CrawlConfig = {
  navigation_timeout_s: 5,
  settle_ms: 0,
  concurrency: 1,
  desktop: { width: 1024, height: 700, scale: 1 },
  mobile: { width: 390, height: 700, scale: 1 },
  screenshot_screens: 2,
  jpeg_quality: 60,
  screenshot_dir: "unused",
  text_max_words: 100,
  subpages: { impressum: ["impressum"], services: ["leistungen"] },
};

describe.skipIf(!browserAvailable)("Browser-Crawler (Chromium)", () => {
  let server: Server;
  let base: string;
  let crawler: BrowserCrawler;
  const dir = mkdtempSync(join(tmpdir(), "avelio-shots-"));
  const shots = (name: string) => ({
    desktop: join(dir, `${name}-d.jpg`),
    mobile: join(dir, `${name}-m.jpg`),
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const send = (status: number, body: string, type = "text/html; charset=utf-8") => {
        res.writeHead(status, { "content-type": type });
        res.end(body);
      };
      switch (req.url) {
        case "/":
          return send(200, modern);
        case "/impressum/":
          return send(200, IMPRESSUM);
        case "/leistungen/":
          return send(
            200,
            "<html><body><h1>Leistungen</h1><p>Inspektion, Leasing, Probefahrt</p></body></html>",
          );
        case "/wide":
          return send(200, WIDE);
        case "/missing":
          return send(404, "<h1>Not found</h1>");
        case "/file.pdf":
          return send(200, "%PDF-1.4", "application/pdf");
        case "/iframe-hang":
          return send(
            200,
            '<html><body><h1>Laden mit Karte</h1><p>Text Text Text Text Text Text Text Text Text Text</p><iframe src="/hang"></iframe></body></html>',
          );
        case "/hang":
          return; // antwortet nie → Timeout
        default:
          return send(404, "nope");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    crawler = await createBrowserCrawler({ config, executablePath });
  });

  afterAll(async () => {
    await crawler?.close();
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
  });

  it("rendert Startseite, Screenshots desktop/mobil, Impressum und Leistungen", async () => {
    const c = await crawler.crawl(`${base}/`, shots("ok"));
    expect(c).toMatchObject({
      finalUrl: `${base}/`,
      httpStatus: 200,
      title: "Radhaus Berg | E-Bikes & Werkstatt in Rosenheim",
      tlsValid: true,
      mobileOverflowPx: 0,
      impressum: { url: `${base}/impressum/` },
      services: { url: `${base}/leistungen/` },
    });
    expect(c.impressum?.html).toContain("Geschäftsführer: Peter Berg");
    for (const path of [c.desktopScreenshot, c.mobileScreenshot]) {
      expect(statSync(path).size).toBeGreaterThan(1000);
      expect(readFileSync(path).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
    }
  });

  it("erkennt zu breite Seiten auf dem Handy", async () => {
    expect((await crawler.crawl(`${base}/wide`, shots("wide"))).mobileOverflowPx).toBeGreaterThan(700);
  });

  it("ein hängendes iframe (z. B. Karten-Widget) blockiert den Crawl nicht", async () => {
    const started = Date.now();
    const c = await crawler.crawl(`${base}/iframe-hang`, shots("iframe"));
    expect(c.title).toBeNull();
    expect(c.html).toContain("Laden mit Karte");
    expect(Date.now() - started).toBeLessThan(25_000);
  }, 40_000);

  it("klassifiziert Fehler: HTTP-Status, kein HTML, Timeout, nicht erreichbar", async () => {
    const kind = async (url: string) => {
      const err = await crawler.crawl(url, shots("err")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CrawlError);
      return (err as CrawlError).kind;
    };
    expect(await kind(`${base}/missing`)).toBe("http_error");
    expect(await kind(`${base}/file.pdf`)).toBe("not_html");
    expect(await kind(`${base}/hang`)).toBe("timeout");
    expect(await kind("http://127.0.0.1:9/")).toBe("unreachable");
  }, 40_000);
});

describe("withDeadline", () => {
  it("liefert das Ergebnis oder nach Ablauf den Ersatzwert", async () => {
    expect(await withDeadline(Promise.resolve(1), 1000, 0)).toBe(1);
    expect(await withDeadline(new Promise<number>(() => undefined), 20, 0)).toBe(0);
    expect(await withDeadline(Promise.reject(new Error("x")), 1000, 0)).toBe(0);
  });
});
