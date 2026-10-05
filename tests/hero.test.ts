import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { getState } from "../src/db/appState.js";
import { upsertCompany } from "../src/db/companies.js";
import type { LlmGateway } from "../src/llm/gateway.js";
import { contrast, derivePalette, isSkinOrWood, rgbOf, toHsl, type Rgb } from "../src/prototype/colors.js";
import {
  heroForCompany,
  heroKey,
  isPrivateIp,
  qualityOk,
  rankCandidates,
  type HeroResult,
  type ImageCandidate,
} from "../src/prototype/heroPhoto.js";
import { renderTeaserMockup, teaserLook, teaserForCompany } from "../src/prototype/teaser.js";
import { describeDb, useTestDb } from "./helpers/db.js";

/** Pixel aus Farbflächen: [Farbe, Anteil]. */
function pixels(parts: [Rgb, number][], n = 2304): number[] {
  const out: number[] = [];
  for (const [c, share] of parts) for (let i = 0; i < Math.round(n * share); i++) out.push(...c);
  return out;
}

const WHITE: Rgb = [255, 255, 255];

describe("Farbwelt aus dem Foto (rein)", () => {
  it("Hauptfarbe aus der prägenden farbigen Fläche, lesbar mit weißer Schrift", () => {
    const p = derivePalette(
      pixels([
        [[40, 120, 160], 0.45], // Blau (Wand)
        [[235, 235, 230], 0.35], // Weiß
        [[60, 60, 60], 0.2], // Grau
      ]),
    )!;
    expect(p).not.toBeNull();
    const [h] = toHsl(rgbOf(p.primary));
    expect(h).toBeGreaterThan(180);
    expect(h).toBeLessThan(220);
    expect(contrast(rgbOf(p.primary), WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgbOf(p.ink), WHITE)).toBeGreaterThan(10);
    expect(toHsl(rgbOf(p.bg))[2]).toBeGreaterThan(0.94);
    // Akzent: lesbare Schrift darauf
    expect(contrast(rgbOf(p.accent), rgbOf(p.onAccent))).toBeGreaterThanOrEqual(3);
    expect(p.veil).toMatch(/^rgba\(\d+,\d+,\d+,\.70\)$/);
  });

  it("Akzent aus einer zweiten, klar anderen Farbe des Fotos", () => {
    const p = derivePalette(
      pixels([
        [[30, 110, 90], 0.5], // Grün
        [[230, 180, 40], 0.2], // Gelb
        [[240, 240, 240], 0.3],
      ]),
    )!;
    const [ha] = toHsl(rgbOf(p.accent));
    expect(ha).toBeGreaterThan(35);
    expect(ha).toBeLessThan(55);
  });

  it("Farbloses Foto oder nur Haut und Holz: keine eigene Farbwelt", () => {
    expect(
      derivePalette(
        pixels([
          [[200, 200, 200], 0.6],
          [[40, 40, 40], 0.4],
        ]),
      ),
    ).toBeNull();
    expect(
      derivePalette(
        pixels([
          [[180, 130, 90], 0.5], // Holzboden
          [[225, 190, 165], 0.3], // Haut
          [[245, 245, 240], 0.2],
        ]),
      ),
    ).toBeNull();
    expect(isSkinOrWood(toHsl([180, 130, 90]))).toBe(true);
    expect(isSkinOrWood(toHsl([40, 120, 160]))).toBe(false);
  });
});

describe("Hero-Foto: Regeln (rein)", () => {
  const c = (over: Partial<ImageCandidate>): ImageCandidate => ({
    url: "https://praxis.de/bild.jpg",
    width: 1920,
    height: 1080,
    shownWidth: 1440,
    shownHeight: 700,
    top: 0,
    alt: "",
    kind: "img",
    ...over,
  });

  it("nur große Querformat-Fotos, keine Logos, Grafiken oder Daumen; groß und weit oben zuerst", () => {
    const ranked = rankCandidates([
      c({ url: "https://praxis.de/logo.png" }),
      c({ url: "https://praxis.de/team.svg" }),
      c({ url: "https://praxis.de/klein.jpg", width: 600, height: 400 }),
      c({ url: "https://praxis.de/hoch.jpg", width: 1000, height: 1500 }),
      c({ url: "https://praxis.de/daumen.jpg", shownWidth: 200, shownHeight: 120 }),
      c({ url: "https://praxis.de/unten.jpg", top: 3000 }),
      c({ url: "https://praxis.de/oben.jpg", top: 80 }),
      c({ url: "https://praxis.de/oben.jpg", top: 80 }), // doppelt
      c({ url: "https://praxis.de/hintergrund.jpg", width: 0, height: 0, kind: "bg" }),
      c({ url: "https://praxis.de/siegel.jpg", alt: "Zertifikat" }),
    ]);
    expect(ranked.map((r) => r.url)).toEqual([
      "https://praxis.de/hintergrund.jpg",
      "https://praxis.de/oben.jpg",
      "https://praxis.de/unten.jpg",
    ]);
  });

  it("nach dem Laden: Größe, Querformat, echtes Foto", () => {
    expect(qualityOk({ width: 1920, height: 1080, entropy: 7.4 })).toBeNull();
    expect(qualityOk({ width: 800, height: 600, entropy: 7.4 })).toContain("zu klein");
    expect(qualityOk({ width: 1200, height: 1200, entropy: 7.4 })).toBe("kein Querformat");
    expect(qualityOk({ width: 1920, height: 1080, entropy: 3.1 })).toBe("wirkt wie eine Grafik");
  });

  it("lädt nichts aus internen Netzen", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.10",
      "172.20.0.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
    ])
      expect(isPrivateIp(ip), ip).toBe(true);
    expect(isPrivateIp("85.13.150.20")).toBe(false);
  });
});

describeDb("Hero-Foto mit Datenbank", () => {
  const db = useTestDb();

  it("wählt das passende Foto, leitet Farben ab, merkt es sich; Vorschau-Bild nutzt es", async () => {
    const { company } = await upsertCompany(db(), {
      name: "Physio Hero",
      placeId: "hero-1",
      websiteUrl: "https://physio-hero.de",
    });
    // Fotoähnliches Bild (Rauschen auf Blau), damit die Regeln es als echtes Foto erkennen.
    const noise = Buffer.alloc(1600 * 900 * 3);
    for (let i = 0; i < noise.length; i += 3) {
      const r = Math.random() * 60;
      noise[i] = 30 + r;
      noise[i + 1] = 100 + r;
      noise[i + 2] = 150 + r;
    }
    const photo = await sharp(noise, { raw: { width: 1600, height: 900, channels: 3 } })
      .jpeg()
      .toBuffer();
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response(new Uint8Array(photo), { headers: { "content-type": "image/jpeg" } })),
    );
    const answer = (wahl: number | null, passt: number, grund = "ruhig") => ({
      output: { wahl, passt, motiv: "heller Raum", fokus_x: 40, fokus_y: 35, grund },
      agentRunId: "r",
      costUsd: 0.01,
      model: "m",
    });
    const structured = vi.fn(() => Promise.resolve(answer(1, 4)));
    const dir = mkdtempSync(join(tmpdir(), "avelio-hero-"));
    const deps = {
      db: db(),
      llm: { structured } as unknown as LlmGateway,
      dir,
      // Öffentliche IP direkt, damit der Test keine DNS-Abfrage braucht.
      fetch: fetchFn as unknown as typeof fetch,
      collect: () =>
        Promise.resolve([
          {
            url: "https://93.184.216.34/hero.jpg",
            width: 1600,
            height: 900,
            shownWidth: 1440,
            shownHeight: 700,
            top: 0,
            alt: "",
            kind: "img" as const,
          },
        ]),
    };
    const r = await heroForCompany(deps, company);
    expect(r).toMatchObject({ status: "ok", position: "40% 35%", motiv: "heller Raum" });
    expect(existsSync(r.file!)).toBe(true);
    expect(toHsl(rgbOf(r.palette!.primary))[0]).toBeGreaterThan(180);
    // Einmal je Firma: zweiter Aufruf aus dem Speicher.
    await heroForCompany(deps, company);
    expect(structured).toHaveBeenCalledTimes(1);
    expect((await getState<HeroResult>(db(), heroKey(company.id)))!.status).toBe("ok");

    // Vorschau-Bild: eigenes Foto und Farben, gemerkt für die Auswertung.
    let html = "";
    await teaserForCompany(
      db(),
      {
        dir,
        branches: ["physiotherapie"],
        style: "elementa",
        devices: true,
        palette: "aqua",
        shoot: (h) => Promise.resolve(void (html = h)),
        hero: (c) => heroForCompany(deps, c),
      },
      company,
    );
    expect(html).toContain(pathToFileURL(r.file!).href);
    expect(await teaserLook(db(), company.id)).toMatchObject({
      foto: "praxis",
      farbe: "aus_foto",
      primary: r.palette!.primary,
    });

    // Kein passendes Foto: Stockfoto, Ergebnis gemerkt.
    const { company: other } = await upsertCompany(db(), {
      name: "Physio Ohne",
      placeId: "hero-2",
      websiteUrl: "https://physio-ohne.de",
    });
    structured.mockResolvedValueOnce(answer(null, 2, "nur Text-Banner"));
    expect((await heroForCompany(deps, other)).status).toBe("none");
  });
});

describe("Vorschau-Bild mit eigenem Foto (rein)", () => {
  it("eigenes Foto statt Stockfoto, Farben aus dem Foto, Google-Zeile statt Stern", () => {
    const html = renderTeaserMockup(
      {
        name: "Physio Hero",
        city: "Weilheim",
        street: "Hauptstr. 1",
        phone: "0881 1",
        rating: 4.9,
        reviewCount: 77,
        seed: "x",
        hero: { file: "/data/heroes/abc.jpg", position: "40% 35%" },
        colors: {
          primary: "#1b5e7a",
          accent: "#e0a43a",
          ink: "#1f2a30",
          veil: "rgba(27,94,122,.70)",
          label: "aus dem Foto",
          bg: "#f4f7f8",
          soft: "#e3eef2",
          onAccent: "#1f2a30",
        },
      },
      undefined,
      "elementa",
    );
    expect(html).toContain("file:///data/heroes/abc.jpg");
    expect(html).toContain("#1b5e7a");
    expect(html).toContain("77 Google-Bewertungen");
    expect(html).not.toContain("Bei Google");
  });
});
