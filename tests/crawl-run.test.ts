import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { upsertCompany, type Company } from "../src/db/companies.js";
import type { BrowserCrawler, SiteCapture } from "../src/pipeline/crawl/browser.js";
import { CrawlError } from "../src/pipeline/crawl/classify.js";
import type { CrawlConfig } from "../src/pipeline/crawl/config.js";
import type { PageSpeedClient, PsiResult } from "../src/pipeline/crawl/pagespeed.js";
import { contentHash, crawlCompany, type CrawlDeps } from "../src/pipeline/crawl/run.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const modern = readFileSync(new URL("./fixtures/sites/modern-site.html", import.meta.url), "utf8");
const T0 = new Date("2026-10-02T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const config: CrawlConfig = {
  navigation_timeout_s: 30,
  settle_ms: 0,
  concurrency: 1,
  desktop: { width: 1440, height: 900, scale: 1 },
  mobile: { width: 390, height: 844, scale: 2 },
  screenshot_screens: 3,
  jpeg_quality: 70,
  screenshot_dir: "data/screenshots",
  text_max_words: 1500,
  subpages: { impressum: ["impressum"], services: ["leistungen"] },
};

const PSI: PsiResult = {
  strategy: "mobile",
  performance: 31,
  seo: 85,
  best_practices: 92,
  accessibility: 77,
  lcp_ms: 6100,
  fcp_ms: 2100,
  tbt_ms: 700,
  cls: 0.05,
  speed_index_ms: 5200,
  final_url: "https://www.radhaus-berg.de/",
};

function capture(url: string, overrides: Partial<SiteCapture> = {}): SiteCapture {
  return {
    requestedUrl: url,
    finalUrl: url,
    httpStatus: 200,
    html: modern,
    title: "Radhaus Berg",
    tlsValid: true,
    cookieBannerClicked: false,
    mobileOverflowPx: 0,
    desktopScreenshot: "d.jpg",
    mobileScreenshot: "m.jpg",
    impressum: {
      url: `${new URL(url).origin}/impressum/`,
      html: "<p>Inhaber: Peter Berg<br>Telefon: 08031 123456<br>E-Mail: info@radhaus-berg.de</p>",
    },
    services: { url: `${new URL(url).origin}/leistungen/`, html: "<p>Inspektion und Leasing</p>" },
    ...overrides,
  };
}

describeDb("crawlCompany", () => {
  const db = useTestDb();
  let n = 0;
  const company = async (websiteUrl: string | null): Promise<Company> => {
    n++;
    const { company: c } = await upsertCompany(db(), {
      name: `Firma ${n}`,
      placeId: `place-${n}`,
      websiteUrl,
      postalCode: "83022",
    });
    await db().query("update companies set status = 'RESEARCHED' where id = $1", [c.id]);
    return { ...c, status: "RESEARCHED" };
  };
  const deps = (
    crawl: BrowserCrawler["crawl"],
    psi: PageSpeedClient["run"] = () => Promise.resolve(PSI),
  ): CrawlDeps => ({
    db: db(),
    crawler: { crawl, close: () => Promise.resolve() },
    pagespeed: { run: psi },
    config,
    recheck: { qualified: 90, failed: 7, skipped: { default: 180 } },
    now: () => T0,
  });
  const row = async (id: string) =>
    (await db().query<Company>("select * from companies where id = $1", [id])).rows[0]!;

  it("speichert Snapshot mit Fakten, PageSpeed, Text, Hash und Impressum-Kontakt", async () => {
    const c = await company("https://www.radhaus-berg.de/");
    const crawl = vi.fn<BrowserCrawler["crawl"]>((url) => Promise.resolve(capture(url)));
    const out = await crawlCompany(deps(crawl), c);

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(crawl.mock.calls[0]![1].desktop).toMatch(
      new RegExp(`^data/screenshots/${c.id}/2026-10-02-12-00-00-[0-9a-f]{8}-desktop\\.jpg$`),
    );
    expect(out.snapshot).toMatchObject({
      url: "https://www.radhaus-berg.de/",
      final_url: "https://www.radhaus-berg.de/",
      http_status: 200,
      https: true,
      error: null,
      screenshot_desktop: "d.jpg",
      psi: { performance: 31, seo: 85 },
    });
    expect(out.snapshot.facts).toMatchObject({
      cms: "WordPress",
      tls_valid: true,
      mobile_too_wide: false,
      impressum: { person: "Peter Berg", role: "Inhaber", emails: ["info@radhaus-berg.de"] },
      services_url: "https://www.radhaus-berg.de/leistungen/",
    });
    expect(out.snapshot.text_excerpt).toContain("Inspektion und Leasing");
    expect(out.snapshot.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const contacts = await db().query(
      "select name, role, email, phone, source from contacts where company_id = $1",
      [c.id],
    );
    expect(contacts.rows).toEqual([
      {
        name: "Peter Berg",
        role: "Inhaber",
        email: "info@radhaus-berg.de",
        phone: "08031 123456",
        source: "impressum",
      },
    ]);

    // Zweiter Crawl: neuer Snapshot, Kontakte ohne Dubletten.
    await crawlCompany(deps(crawl), c);
    expect(
      (await db().query("select count(*)::int as n from contacts where company_id = $1", [c.id])).rows[0],
    ).toEqual({ n: 1 });
    expect(
      (await db().query("select count(*)::int as n from website_snapshots where company_id = $1", [c.id]))
        .rows[0],
    ).toEqual({ n: 2 });
  });

  it("Firmenname im Impressum zählt nicht als Person", async () => {
    const c = await company("https://muster.example.de/");
    await db().query("update companies set name = 'Muster Huber Kaltenbrunner' where id = $1", [c.id]);
    const out = await crawlCompany(
      deps((url) =>
        Promise.resolve(
          capture(url, { impressum: { url, html: "<p>Verantwortlich: Muster Huber Kaltenbrunner</p>" } }),
        ),
      ),
      { ...c, name: "Muster Huber Kaltenbrunner" },
    );
    expect(out).toMatchObject({ kind: "ok", facts: { impressum: { person: null, role: null } } });
  });

  it("mobil zu breit erst ab 10 % der Bildschirmbreite", async () => {
    const run = async (px: number) => {
      const out = await crawlCompany(
        deps((url) => Promise.resolve(capture(url, { mobileOverflowPx: px }))),
        await company(`https://breit-${px}.example.de/`),
      );
      return out.kind === "ok" ? out.facts.mobile_too_wide : null;
    };
    expect(await run(15)).toBe(false);
    expect(await run(39)).toBe(false);
    expect(await run(40)).toBe(true);
  });

  it("PageSpeed-Fehler bricht den Crawl nicht ab", async () => {
    const c = await company("https://a.example.de/");
    const out = await crawlCompany(
      deps(
        (url) => Promise.resolve(capture(url)),
        () => Promise.reject(new Error("PageSpeed: HTTP 500")),
      ),
      c,
    );
    expect(out).toMatchObject({ kind: "ok", psi: null, psiError: "PageSpeed: HTTP 500" });
    if (out.kind === "ok") expect(out.snapshot.psi).toEqual({ error: "PageSpeed: HTTP 500" });
  });

  it("Fehlschlag: Snapshot mit Fehlerart, Firma FAILED mit Recheck in 7 Tagen; späterer Erfolg setzt zurück", async () => {
    const c = await company("https://kaputt.example.de/");
    const out = await crawlCompany(
      deps(() => Promise.reject(new CrawlError("unreachable", "net::ERR_NAME_NOT_RESOLVED"))),
      c,
    );
    expect(out).toMatchObject({ kind: "failed", errorKind: "unreachable" });
    expect(await row(c.id)).toMatchObject({
      status: "FAILED",
      skip_detail: "Crawl: unreachable – net::ERR_NAME_NOT_RESOLVED",
      recheck_after: new Date(T0.getTime() + 7 * DAY),
    });

    await crawlCompany(
      deps((url) => Promise.resolve(capture(url))),
      c,
    );
    expect(await row(c.id)).toMatchObject({ status: "RESEARCHED", skip_detail: null, recheck_after: null });
  });

  it("Bot-Schutz nach dem Rendern zählt als Fehlschlag", async () => {
    const c = await company("https://geschuetzt.example.de/");
    const out = await crawlCompany(
      deps((url) =>
        Promise.resolve(capture(url, { title: "Just a moment...", html: "<p>Checking your browser</p>" })),
      ),
      c,
    );
    expect(out).toMatchObject({ kind: "failed", errorKind: "blocked" });
  });

  it("http://-Adresse: erst HTTPS mit gültigem Zertifikat versuchen, sonst http", async () => {
    const c1 = await company("http://kann-https.example.de/");
    const crawl1 = vi.fn<BrowserCrawler["crawl"]>((url) => Promise.resolve(capture(url)));
    const out1 = await crawlCompany(deps(crawl1), c1);
    expect(crawl1.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ["https://kann-https.example.de/", { acceptInvalidTls: false }],
    ]);
    expect(out1).toMatchObject({ kind: "ok", facts: { https: true } });

    const c2 = await company("http://nur-http.example.de/");
    const crawl2 = vi.fn<BrowserCrawler["crawl"]>((url) =>
      url.startsWith("https:")
        ? Promise.reject(new CrawlError("tls_error", "net::ERR_CERT_COMMON_NAME_INVALID"))
        : Promise.resolve(capture(url)),
    );
    const out2 = await crawlCompany(deps(crawl2), c2);
    expect(crawl2).toHaveBeenCalledTimes(2);
    expect(out2).toMatchObject({ kind: "ok", facts: { https: false } });
  });

  it("Unterseiten-Link aus Google → Startseite; Social-Media-Profil → ohne Website; keine URL → nichts", async () => {
    const deep = await company("https://mr-bike.example.com/en/contact-us/");
    const crawl = vi.fn<BrowserCrawler["crawl"]>((url) => Promise.resolve(capture(url)));
    await crawlCompany(deps(crawl), deep);
    expect(crawl.mock.calls[0]![0]).toBe("https://mr-bike.example.com/");

    const social = await company("https://www.facebook.com/radlmeier");
    const never = vi.fn(() => Promise.reject(new Error("darf nicht aufgerufen werden")));
    expect(await crawlCompany(deps(never), social)).toMatchObject({ kind: "social_only" });
    expect(never).not.toHaveBeenCalled();
    expect(await row(social.id)).toMatchObject({ segment: "NO_WEBSITE", status: "RESEARCHED" });

    expect(await crawlCompany(deps(never), await company(null))).toEqual({ kind: "no_website" });
  });

  it("contentHash ist unabhängig von Groß-/Kleinschreibung und Leerraum", () => {
    expect(contentHash("Titel", "Hallo  Welt\n")).toBe(contentHash("titel", "hallo welt"));
    expect(contentHash("Titel", "Hallo Welt")).not.toBe(contentHash("Titel", "Hallo Welt!"));
  });
});
