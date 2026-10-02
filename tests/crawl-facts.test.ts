import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  copyrightYear,
  detectCms,
  extractFacts,
  htmlToText,
  textExcerpt,
} from "../src/pipeline/crawl/facts.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/sites/${name}`, import.meta.url), "utf8");
const NOW = new Date("2026-10-02T12:00:00Z");

describe("extractFacts", () => {
  it("alte Seite: kein Viewport, Tabellen-Layout, Baukasten, altes Copyright", () => {
    const f = extractFacts(fixture("old-site.html"), "http://www.zweirad-huber.de/", NOW);
    expect(f).toMatchObject({
      title: "Zweirad Huber - Ihr Fahrradhändler in Musterstadt",
      lang: null,
      h1: ["Willkommen bei Zweirad Huber!"],
      has_viewport_meta: false,
      viewport: null,
      generator: "IONOS MyWebsite 8",
      cms: "IONOS MyWebsite",
      copyright_year: 2014,
      tel_links: [],
      mailto_links: [],
      image_count: 3,
      images_without_alt: 2,
      form_count: 0,
      has_contact_form: false,
      impressum_url: "http://www.zweirad-huber.de/impressum.html",
      privacy_url: null,
      iframe_count: 1,
      layout_tables: 1,
      has_favicon: false,
      has_open_graph: false,
      has_structured_data: false,
      cta_texts: ["Kontakt"],
    });
    expect(f.word_count).toBeGreaterThan(20);
  });

  it("moderne Seite: Viewport, CTA, tel:/mailto:, Kontaktformular, Social Links", () => {
    const f = extractFacts(fixture("modern-site.html"), "https://www.radhaus-berg.de/", NOW);
    expect(f).toMatchObject({
      lang: "de",
      meta_description: "E-Bike-Beratung, Leasing und Meisterwerkstatt in Rosenheim.",
      h1: ["Ihr E-Bike-Spezialist in Rosenheim"],
      nav_items: ["Start", "Leistungen", "E-Bike-Leasing", "Kontakt"],
      has_viewport_meta: true,
      cms: "WordPress",
      copyright_year: 2025, // "© 1999" im Script zählt nicht
      tel_links: ["+498031123456"],
      mailto_links: ["info@radhaus-berg.de"],
      image_count: 2,
      images_without_alt: 1,
      form_count: 1,
      has_contact_form: true,
      social_links: ["https://www.instagram.com/radhausberg", "https://facebook.com/radhausberg"],
      impressum_url: "https://www.radhaus-berg.de/impressum/",
      privacy_url: "https://www.radhaus-berg.de/datenschutz/",
      layout_tables: 0,
      has_favicon: true,
      has_open_graph: true,
      has_structured_data: true,
    });
    expect(f.cta_texts).toEqual(
      expect.arrayContaining(["Jetzt Termin vereinbaren", "Anfrage senden", "Kontakt"]),
    );
  });

  it("kommt mit leerem oder kaputtem HTML zurecht", () => {
    const f = extractFacts("<p>nur Text<div>", "https://x.de/", NOW);
    expect(f).toMatchObject({ title: null, h1: [], word_count: 2, cms: null, copyright_year: null });
  });
});

describe("Hilfsfunktionen", () => {
  it("copyrightYear nimmt das neueste plausible Jahr", () => {
    expect(copyrightYear("© 2014–2019 Firma", NOW)).toBe(2019);
    expect(copyrightYear("Copyright 2021 by X · (c) 2008", NOW)).toBe(2021);
    expect(copyrightYear("© 2099 Zukunft", NOW)).toBeNull();
    expect(copyrightYear("Gegründet 2005", NOW)).toBeNull();
  });

  it("detectCms erkennt Baukästen an Spuren im HTML", () => {
    expect(detectCms('<img src="https://static.wixstatic.com/x.png">', null)).toBe("Wix");
    expect(detectCms('<link href="https://assets.jimdo.com/a.css">', null)).toBe("Jimdo");
    expect(detectCms("<div></div>", "Joomla! - Open Source Content Management")).toBe("Joomla");
    expect(detectCms("<div></div>", "Hugo 0.120")).toBe("Hugo 0.120");
    expect(detectCms("<div></div>", null)).toBeNull();
  });

  it("htmlToText trennt Blöcke in Zeilen und ignoriert Scripts", () => {
    expect(
      htmlToText("<body><p>Inhaber: Max Muster<br>Tel: 0123</p><script>x()</script><div>Ende</div></body>"),
    ).toBe("Inhaber: Max Muster\nTel: 0123\nEnde");
  });

  it("textExcerpt kürzt auf eine Wortzahl", () => {
    expect(textExcerpt("a b c d", 10)).toBe("a b c d");
    expect(textExcerpt("a b  c\nd", 2)).toBe("a b …");
  });
});
