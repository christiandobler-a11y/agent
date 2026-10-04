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
import {
  buildPrototype,
  loadPrototypeConfig,
  pickPhotos,
  siteForm,
  toSiteContent,
} from "../src/prototype/run.js";
import { renderFahrrad } from "../src/prototype/templates/fahrrad.js";
import { renderPhysio } from "../src/prototype/templates/physio.js";
import { crmCallback, parseCrmCallback, prototypeMessage } from "../src/telegram/format.js";
import { loadOutreachConfig } from "../src/outreach/config.js";
import { draftEmail } from "../src/outreach/draft.js";
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
  galerie_fotos: [1, 3],
  abgelehnte_fotos: [],
  hero_zeilen: ["Wieder", "beweglich", "im Alltag."],
  marken: [],
  sortiment: [],
  leasing: false,
  leasing_partner: [],
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

  it("Hero: keine Werbestreifen oder Slider, stattdessen echtes Querformat", () => {
    const shop = [
      { url: "https://x.de/Slider_Opening-Aktion_1920.jpg", alt: "", w: 1440, h: 768 },
      { url: "https://x.de/streifen.jpg", alt: "", w: 1440, h: 315 },
      { url: "https://x.de/AQ9I9301.jpg", alt: "", w: 1440, h: 900 },
    ];
    expect(pickPhotos({ hero_foto: 1, ueber_uns_foto: null, galerie_fotos: [3] }, shop).hero).toBe(
      "https://x.de/AQ9I9301.jpg",
    );
    expect(
      pickPhotos({ hero_foto: 2, ueber_uns_foto: null, galerie_fotos: [] }, shop.slice(0, 2)).hero,
    ).toBeNull();
  });

  it("Fotowahl und Inhalt: gültige Nummern, Rest in die Galerie, keine Gedankenstriche, Maps-Link aus Adresse", () => {
    // Keine Wahl und nichts gebilligt: größtes Querformat (b.jpg 1600×900) wird Hero.
    expect(pickPhotos({ hero_foto: null, ueber_uns_foto: null, galerie_fotos: [] }, photos).hero).toBe(
      "https://x.de/b.jpg",
    );
    // Gültige Wahl, ungültige Nummer ignoriert, Galerie ohne Dubletten von Hero/Über uns.
    expect(pickPhotos({ hero_foto: 2, ueber_uns_foto: 9, galerie_fotos: [1, 3, 2, 1] }, photos)).toEqual({
      hero: "https://x.de/b.jpg",
      about: null,
      gallery: ["https://x.de/a.jpg", "https://x.de/c.jpg"],
    });
    // Abgelehnt (z. B. Text-Banner): nie verwenden, auch nicht als Ersatz.
    expect(
      pickPhotos({ hero_foto: null, ueber_uns_foto: null, galerie_fotos: [], abgelehnte_fotos: [2] }, photos)
        .hero,
    ).toBe("https://x.de/a.jpg");
    expect(
      pickPhotos(
        { hero_foto: 2, ueber_uns_foto: null, galerie_fotos: [2], abgelehnte_fotos: [1, 2] },
        photos,
      ),
    ).toEqual({ hero: null, about: null, gallery: [] });
    // Zu kleines Hero-Foto (900 px): größtes gebilligtes Querformat stattdessen; b.jpg wurde nicht gebilligt.
    expect(pickPhotos({ hero_foto: 3, ueber_uns_foto: null, galerie_fotos: [1] }, photos).hero).toBe(
      "https://x.de/a.jpg",
    );
    const c = content();
    expect(c.hero.headline).toBe("Wieder beweglich, und fit im Alltag.");
    expect(c.contact.address).toBe("Prinzregentenstraße 5, 83022 Rosenheim");
    expect(c.contact.mapsUrl).toContain("google.com/maps/search");
    expect(c.reviews.quotes).toHaveLength(1);
  });

  it("Anrede wie auf der Website des Betriebs", () => {
    expect(
      siteForm("Wir helfen dir schnell. Buche deinen Termin, wir freuen uns auf dich und deine Fragen."),
    ).toBe("du");
    expect(
      siteForm("Wir stimmen jede Behandlung auf Ihre Situation ab und begleiten Sie. Wir helfen Ihnen gern."),
    ).toBe("sie");
    expect(siteForm("Physiotherapie in Rosenheim. Krankengymnastik, Massage.")).toBeNull();
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

describe("Vorlage fahrrad (wie fs-pbg)", () => {
  const bike = (over: Partial<SiteContent> = {}) =>
    content({
      name: "Radl Huber",
      heroLines: ["Dein Bike.", "Dein Weg.", "Dein Laden."],
      brands: ["Cube", "Trek", "Haibike"],
      range: [{ kind: "ebike", title: "E-Bikes", text: "Probefahrt jederzeit." }],
      leasing: { offered: true, partners: ["JobRad"] },
      ...over,
    });

  it("nutzt Stil und Aufbau von fs-pbg, letzte Hero-Zeile als Akzent, keine Skripte", () => {
    const html = renderFahrrad(bike());
    expect(html).toContain('href="style.css"');
    expect(html).toContain("--color-magenta:");
    expect(html).toContain("Radl");
    expect(html).toMatch(/italic[^"]*text-magenta-bright[^"]*">Dein Laden\.</);
    expect(html).toContain("JobRad");
    expect(html).toContain("Cube");
    expect(html).toContain('name="robots" content="noindex');
    expect(html).not.toContain("<script");
  });

  it("ohne eigenes Foto: Produktbild der Kategorie als Hero", () => {
    const html = renderFahrrad(bike({ hero: { ...content().hero, image: null } }));
    expect(html).toContain("img/cat-ebike.webp");
  });

  it("buildSite kopiert CSS, Schriften und Ersatzbilder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avelio-bike-"));
    await buildSite(
      bike({
        hero: { ...content().hero, image: null },
        gallery: [],
        about: { ...content().about, image: null },
      }),
      dir,
      () => Promise.resolve(null),
      "fahrrad",
    );
    expect(existsSync(join(dir, "style.css"))).toBe(true);
    expect(existsSync(join(dir, "img/cat-ebike.webp"))).toBe(true);
    expect(existsSync(join(dir, "fonts/archivo-latin-400-normal-C81ewxNO.woff2"))).toBe(true);
  });
});

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
        teaser: {
          dir: join(tmp, "teasers"),
          branchen: [],
          stil: "welt" as const,
          geraete: false,
          farbe: "petrol",
          google_details: false,
          foto: null,
        },
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
    // Das LLM sieht jedes Foto als Vorschaubild.
    expect(JSON.stringify(input.input)).toContain("Foto 3 (900×900 px)");

    const second = await buildPrototype(deps, c, "test");
    if ("kind" in second) throw new Error("kein Prototyp");
    expect(second.url).toBe(first.url);
    const { rows } = await db().query<{ n: number }>(
      "select count(*)::int as n from interactions where company_id = $1 and body like 'Prototyp gebaut:%'",
      [c.id],
    );
    expect(rows[0]!.n).toBe(2);
    // Die Mail verlinkt den Entwurf statt WhatsApp (höchstens ein Link).
    await db().query(
      `insert into audits (company_id, prompt_version, model, findings, rubric, commercial, summary)
       values ($1, 'v1', 'm', '[]', '{}', '{}', 's')`,
      [c.id],
    );
    const mail = await draftEmail(
      {
        db: db(),
        llm: {
          structured: () =>
            Promise.resolve({
              output: { absatz: "ich heiße Christian und mache Online-Auftritte zeitgemäß." },
              agentRunId: "r",
              costUsd: 0,
              model: "m",
            }),
        } as unknown as LlmGateway,
        outreach: loadOutreachConfig(),
        branches: {},
        now: () => NOW,
        contact: { whatsapp: "+49 151 1", phone: null },
        previewBaseUrl: "https://vorschau.example",
      },
      c,
      "test",
    );
    if ("kind" in mail) throw new Error("kein Entwurf");
    expect(mail.body).toContain(first.url!);
    expect(mail.body).not.toContain("wa.me");

    const { rows: usage } = await db().query<{ n: number }>(
      "select count(*)::int as n from api_usage where company_id = $1 and operation = 'place_details_prototype'",
      [c.id],
    );
    expect(usage[0]!.n).toBe(2);
  });
});
