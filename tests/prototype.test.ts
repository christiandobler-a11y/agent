import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { upsertCompany, type Company } from "../src/db/companies.js";
import { insertWebsiteSnapshot } from "../src/db/websiteSnapshots.js";
import type { LlmGateway } from "../src/llm/gateway.js";
import { selectImages, type ImageCandidate } from "../src/pipeline/crawl/images.js";
import { buildSite, isLightLogo } from "../src/prototype/build.js";
import { contrast, paletteFrom } from "../src/prototype/color.js";
import type { PrototypeOutput, SiteContent } from "../src/prototype/content.js";
import { compressHours, parseDetails, shortAuthor, shortenQuote } from "../src/prototype/placeDetails.js";
import { buildPrototype, loadPrototypeConfig, pickPhotos, toSiteContent } from "../src/prototype/run.js";
import { renderPhysio } from "../src/prototype/templates/physio.js";
import { crmCallback, parseCrmCallback, prototypeMessage } from "../src/telegram/format.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const output: PrototypeOutput = {
  anzeigename: "Physio Mike",
  claim: "Physiotherapie in Rosenheim",
  handschrift: "Wir machen Sie wieder fit.",
  hero: {
    ueberschrift: "Wieder beweglich – und fit im Alltag.",
    text: "Zentral im Gillitzerblock, nah am Busbahnhof.",
  },
  markenfarbe: "#2f6fa3",
  vertrauen: ["Alle Kassen & privat", "Zentral am Busbahnhof"],
  leistungen: [
    { titel: "Krankengymnastik", text: "Gezielte Übungen für mehr Beweglichkeit.", icon: "activity" },
    { titel: "Manuelle Therapie", text: "Sanfte Techniken für Gelenke.", icon: "hand" },
    { titel: "Lymphdrainage <b>", text: "Entstauung nach Operationen.", icon: "waves" },
  ],
  ueber_uns: {
    titel: "Persönlich und mit Erfahrung",
    text: "Seit 25 Jahren in eigener Praxis.\n\nMit Team.",
  },
  ablauf: [
    { titel: "Rezept holen", text: "Ihre Ärztin verordnet die Behandlung." },
    { titel: "Anrufen", text: "Wir finden einen Termin." },
    { titel: "Loslegen", text: "Wir planen gemeinsam." },
  ],
  cta: "Termin vereinbaren",
  hero_foto: 2,
  ueber_uns_foto: null,
};

const company = {
  id: "c1",
  name: "Praxis für Physiotherapie Pickelmann Mike",
  street: "Prinzregentenstraße 5",
  postal_code: "83022",
  city: "Rosenheim",
  phone: "08031 219876",
} as Company;

const photos = [
  { url: "https://x.de/a.jpg", alt: "", w: 1200, h: 800 },
  { url: "https://x.de/b.jpg", alt: "", w: 1600, h: 900 },
  { url: "https://x.de/c.jpg", alt: "", w: 900, h: 900 },
];

function content(over: Partial<SiteContent> = {}): SiteContent {
  return {
    ...toSiteContent(output, {
      form: "sie",
      company,
      images: { logo: null, photos },
      rating: 5,
      reviewCount: 26,
      details: {
        mapsUrl: null,
        hours: ["Mo–Fr: 09:00–18:00 Uhr"],
        quotes: [{ text: "Super Praxis.", author: "Tina T." }],
      },
      email: "info@x.de",
    }),
    ...over,
  };
}

describe("Prototyp (rein)", () => {
  it("Palette: genug Kontrast für weiße Schrift, Graustufen bekommen eine Farbe", () => {
    for (const brand of ["#f5d90a", "#ffffff", "#9ed8ff", "#2f6fa3", "#b5793f"]) {
      const p = paletteFrom(brand);
      expect(contrast(p.primary, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
    expect(paletteFrom("#808080").primary).not.toBe("#808080");
  });

  it("Google-Details: Öffnungszeiten zusammengefasst, Autoren gekürzt, nur gute Bewertungen", () => {
    expect(
      compressHours([
        "Montag: 09:00–18:00 Uhr",
        "Dienstag: 09:00–18:00 Uhr",
        "Mittwoch: 09:00–18:00 Uhr",
        "Donnerstag: 09:00–18:00 Uhr",
        "Freitag: 09:00–14:00 Uhr",
        "Samstag: Geschlossen",
        "Sonntag: Geschlossen",
      ]),
    ).toEqual(["Mo–Do: 09:00–18:00 Uhr", "Fr: 09:00–14:00 Uhr", "Sa, So: geschlossen"]);
    expect(shortAuthor("Marianne Huber")).toBe("Marianne H.");
    expect(shortAuthor("123 S")).toBe("Google-Bewertung");
    expect(shortenQuote(`${"Sehr gut. ".repeat(30)}`, 120).length).toBeLessThanOrEqual(120);
    const d = parseDetails({
      googleMapsUri: "https://maps.google.com/?cid=1",
      reviews: [
        { rating: 2, text: { text: "Schlecht, lange gewartet und unfreundlich am Empfang gewesen." } },
        {
          rating: 5,
          text: { text: "Tolles Team, sehr kompetent und freundlich, immer wieder gern." },
          authorAttribution: { displayName: "Anna Maier" },
        },
        { rating: 5, text: { text: "Kurz." } },
      ],
    });
    expect(d.quotes).toEqual([
      { text: "Tolles Team, sehr kompetent und freundlich, immer wieder gern.", author: "Anna M." },
    ]);
    expect(d.mapsUrl).toBe("https://maps.google.com/?cid=1");
  });

  it("Fotowahl und Inhalt: gültige Nummern, Rest in die Galerie, keine Gedankenstriche, Maps-Link aus Adresse", () => {
    // Keine Wahl: größtes Querformat (b.jpg 1600×900) wird Hero.
    expect(pickPhotos({ hero_foto: null, ueber_uns_foto: null }, photos).hero).toBe("https://x.de/b.jpg");
    expect(pickPhotos({ hero_foto: 2, ueber_uns_foto: 9 }, photos)).toEqual({
      hero: "https://x.de/b.jpg",
      about: null,
      gallery: ["https://x.de/a.jpg", "https://x.de/c.jpg"],
    });
    const c = content();
    expect(c.hero.headline).toBe("Wieder beweglich, und fit im Alltag.");
    expect(c.contact.address).toBe("Prinzregentenstraße 5, 83022 Rosenheim");
    expect(c.contact.mapsUrl).toContain("google.com/maps/search");
    expect(c.reviews.quotes).toHaveLength(1);
  });

  it("Bildauswahl beim Crawl: Logo oben, keine Icons/Texturen, große Fotos zuerst", () => {
    const cand = (over: Partial<ImageCandidate>): ImageCandidate => ({
      url: "https://x.de/p.jpg",
      alt: "",
      w: 1200,
      h: 800,
      top: 900,
      area: 500_000,
      logoHint: false,
      background: false,
      ...over,
    });
    const r = selectImages([
      cand({ url: "https://x.de/logo.png", logoHint: true, top: 20, w: 300, h: 80, area: 20_000 }),
      cand({ url: "https://x.de/small.jpg", area: 900_000, w: 300, h: 200 }),
      cand({ url: "https://x.de/section-background-texture.png", area: 2_000_000, w: 1440, h: 2000 }),
      cand({ url: "https://x.de/icon-phone.png" }),
      cand({ url: "https://x.de/team.jpg", area: 600_000 }),
      cand({ url: "https://x.de/praxis.jpg", area: 800_000 }),
    ]);
    expect(r.logo).toBe("https://x.de/logo.png");
    expect(r.photos.map((p) => p.url)).toEqual(["https://x.de/praxis.jpg", "https://x.de/team.jpg"]);
  });

  it("Vorlage: Entwurfs-Hinweis, noindex, kein Skript, escaped, Bewertungen nur mit Daten", () => {
    const html = renderPhysio(content());
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain("Entwurf: <b>So könnte Ihre neue Website aussehen.</b>");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("Lymphdrainage &lt;b&gt;");
    expect(html.match(/class="card"/g)).toHaveLength(3);
    expect(html).toContain('href="tel:08031219876"');
    expect(html).toContain("26 Bewertungen bei Google");
    expect(html).toContain("„Super Praxis.“");
    const noReviews = renderPhysio(content({ reviews: { rating: null, count: null, quotes: [] } }));
    expect(noReviews).not.toContain('id="bewertungen"');
    // Ohne Foto bei "Über uns": Bewertungs-Karte statt leerer Fläche.
    expect(renderPhysio(content({ about: { ...content().about, image: null } }))).toContain('class="phbig"');
    expect(renderPhysio(content({ form: "du" }))).toContain("So könnte eure neue Website aussehen.");
  });

  it("Callback und Telegram-Text", () => {
    const id = "0b9a3f0e-1111-4222-8333-444455556666";
    expect(parseCrmCallback(crmCallback({ kind: "prototype", companyId: id }))).toEqual({
      kind: "prototype",
      companyId: id,
    });
    const m = prototypeMessage({ id, name: "Physio <Mike>" } as Company, {
      url: "https://vorschau.example/physio-mike-ab12/",
      dir: "d",
      warnings: [],
      costUsd: 0.058,
    });
    expect(m.caption).toContain("Physio &lt;Mike&gt;");
    expect(m.keyboard[0]![0]).toEqual({
      text: "🌐 Öffnen",
      url: "https://vorschau.example/physio-mike-ab12/",
    });
  });
});

const jpeg = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: "#88aacc" } })
    .jpeg()
    .toBuffer();

describe("Prototyp bauen (Dateien)", () => {
  it("erkennt helle (weiße) Logos auf durchsichtigem Grund", async () => {
    const white = await sharp({
      create: { width: 200, height: 80, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const dark = await sharp({
      create: { width: 200, height: 80, channels: 4, background: { r: 30, g: 60, b: 90, alpha: 1 } },
    })
      .png()
      .toBuffer();
    expect(await isLightLogo(white)).toBe(true);
    expect(await isLightLogo(dark)).toBe(false);
  });

  it("schreibt Seite, Schriften und WebP-Bilder; fehlende Bilder werden zur Farbfläche", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avelio-proto-"));
    const img = await jpeg(1600, 900);
    const fetchImage = vi.fn((url: string) =>
      Promise.resolve(url.includes("b.jpg") || url.includes("a.jpg") ? img : null),
    );
    const r = await buildSite(content(), dir, fetchImage);
    expect(existsSync(join(dir, "index.html"))).toBe(true);
    expect(existsSync(join(dir, "fonts/manrope-800.woff2"))).toBe(true);
    expect(readFileSync(join(dir, "robots.txt"), "utf8")).toContain("Disallow: /");
    expect(r.content.hero.image).toMatch(/^img\/foto-\d\.webp$/);
    // "Über uns" ohne Wahl: nächstes freies Foto (a.jpg)
    expect(r.content.about.image).toMatch(/^img\/foto-\d\.webp$/);
    expect(r.content.gallery).toEqual([]); // c.jpg ließ sich nicht laden
    const meta = await sharp(join(dir, r.content.hero.image!)).metadata();
    expect(meta.format).toBe("webp");
  });
});

describeDb("Prototyp mit Datenbank", () => {
  const db = useTestDb();
  const NOW = new Date("2026-10-03T10:00:00Z");

  it("baut, speichert, behält den Link beim Neubau und vermerkt es im Verlauf", async () => {
    const { company: c } = await upsertCompany(db(), {
      name: "Physio Test",
      placeId: "proto-1",
      city: "Rosenheim",
    });
    await db().query("update companies set branch_key = 'physiotherapie', phone = '08031 1' where id = $1", [
      c.id,
    ]);
    const tmp = mkdtempSync(join(tmpdir(), "avelio-proto-db-"));
    const shot = join(tmp, "desktop.jpg");
    await sharp(await jpeg(1440, 1800)).toFile(shot);
    await insertWebsiteSnapshot(db(), {
      companyId: c.id,
      url: "https://physio.example",
      screenshotDesktop: shot,
      screenshotMobile: shot,
      textExcerpt: "Krankengymnastik, Manuelle Therapie",
      facts: { images: { logo: null, photos } },
    });
    const structured = vi.fn(() => Promise.resolve({ output, agentRunId: "r", costUsd: 0.04, model: "m" }));
    const shoot = vi.fn((_i: string, out: string) =>
      Promise.resolve({
        hero: join(out, "hero.jpg"),
        full: join(out, "full.jpg"),
        mobile: join(out, "mobile.jpg"),
      }),
    );
    const img = await jpeg(1600, 900);
    const deps = {
      db: db(),
      llm: { structured } as unknown as LlmGateway,
      budget: { assertAvailable: () => Promise.resolve() } as never,
      branches: {},
      config: {
        ...loadPrototypeConfig(),
        previews_dir: join(tmp, "previews"),
        shots_dir: join(tmp, "shots"),
      },
      duBranches: ["fahrrad"],
      now: () => NOW,
      googleApiKey: null,
      baseUrl: "https://vorschau.example",
      desktopScreenPx: 900,
      fetchImage: () => Promise.resolve(img),
      fetchDetails: vi.fn(() => Promise.resolve({ mapsUrl: null, hours: [], quotes: [] })),
      shoot,
    };
    const first = await buildPrototype(deps, c, "test");
    if ("kind" in first) throw new Error("kein Prototyp");
    expect(first.url).toMatch(/^https:\/\/vorschau\.example\/physio-mike-[0-9a-f]{8}\/$/);
    expect(existsSync(join(first.dir, "index.html"))).toBe(true);
    expect(first.costUsd).toBeCloseTo(0.065, 3); // LLM + Google-Details
    const input = (structured.mock.calls as unknown as [{ role: string; input: unknown[] }][])[0]![0];
    expect(input.role).toBe("prototype");
    expect(JSON.stringify(input.input)).toContain('"type":"image"');

    const second = await buildPrototype(deps, c, "test");
    if ("kind" in second) throw new Error("kein Prototyp");
    expect(second.url).toBe(first.url);
    const { rows } = await db().query<{ n: number }>(
      "select count(*)::int as n from interactions where company_id = $1 and body like 'Prototyp gebaut:%'",
      [c.id],
    );
    expect(rows[0]!.n).toBe(2);
    const { rows: usage } = await db().query<{ n: number }>(
      "select count(*)::int as n from api_usage where company_id = $1 and operation = 'place_details_prototype'",
      [c.id],
    );
    expect(usage[0]!.n).toBe(2);
  });
});
