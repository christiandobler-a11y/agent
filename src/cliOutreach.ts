import { mkdir, writeFile } from "node:fs/promises";
import { googleOwnerPhotos } from "./prototype/googlePhotos.js";
import { heroForCompany } from "./prototype/heroPhoto.js";
import { join } from "node:path";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { findLead } from "./manager/leads.js";
import { loadOutreachConfig } from "./outreach/config.js";
import { draftLetter } from "./outreach/letter.js";
import { createOffer, loadOfferConfig, offerCopyParts, offerSalutationFor } from "./outreach/offer.js";
import { chromiumLetterRenderer } from "./outreach/letterPdf.js";
import { buildPrototype, loadPrototypeConfig, type PrototypeDeps } from "./prototype/run.js";
import { chromiumTeaserShooter, teaserForCompany } from "./prototype/teaser.js";
import { cachedPlaceDetails } from "./prototype/placeDetails.js";

/** Befund-Seite als PDF: `avelio letter <Firma>` schreibt PDF und Vorschau nach data/letters/. */
export async function letter(argv: string[]): Promise<number> {
  const ref = argv.join(" ").trim();
  if (!ref) {
    console.error("Verwendung: avelio letter <Firmen-ID|Domain|Name>");
    return 2;
  }
  const env = loadEnv();
  const app = await createApp();
  try {
    const found = await findLead(app.ctx.db, ref);
    if (found.kind !== "found") {
      console.log(
        found.kind === "none"
          ? `Keine Firma gefunden für "${ref}".`
          : `Mehrere Treffer: ${found.candidates.map((c) => c.name).join(", ")}`,
      );
      return 1;
    }
    const crawl = app.ctx.crawl.config;
    const result = await draftLetter(
      {
        db: app.ctx.db,
        llm: app.llm,
        outreach: loadOutreachConfig(),
        branches: app.ctx.lead.branches,
        now: app.ctx.now,
        contact: { whatsapp: env.OUTREACH_WHATSAPP ?? null, phone: env.OUTREACH_PHONE ?? null },
        render: chromiumLetterRenderer(process.env.CHROMIUM_PATH),
        prototype: {
          shotsDir: loadPrototypeConfig().shots_dir,
          baseUrl: env.PREVIEW_BASE_URL?.replace(/\/$/, "") ?? null,
        },
        teaserDir: loadPrototypeConfig().teaser.dir,
        desktopScreenPx: crawl.desktop.height * crawl.desktop.scale,
      },
      found.company,
      "cli",
    );
    if ("kind" in result) {
      console.log(
        result.kind === "no_audit"
          ? `${found.company.name} ist noch nicht auditiert.`
          : `Für ${found.company.name} gibt es keinen Screenshot (erst crawlen).`,
      );
      return 1;
    }
    const dir = join("data", "letters");
    await mkdir(dir, { recursive: true });
    const pdfPath = join(dir, result.filename);
    await writeFile(pdfPath, result.pdf);
    await writeFile(pdfPath.replace(/\.pdf$/, ".png"), result.png);
    console.log(`Befund-Seite: ${pdfPath} (Vorschau .png daneben), Variante ${result.variant}`);
    console.log(`\nUmschlag:\n${result.envelope.join("\n")}`);
    console.log(`\n${result.greeting}\n${result.notes.join("\n")}`);
    if (result.warnings.length) console.log(`\n⚠️ ${result.warnings.join(" · ")}`);
    console.log(`\nKosten ${result.costUsd.toFixed(3).replace(".", ",")} $`);
    return 0;
  } finally {
    await app.close();
  }
}

/** Prototyp bauen: `avelio prototype <Firma>` (Seite unter data/previews/, Screenshots unter data/preview-shots/). */
export async function prototype(argv: string[]): Promise<number> {
  const ref = argv.join(" ").trim();
  if (!ref) {
    console.error("Verwendung: avelio prototype <Firmen-ID|Domain|Name>");
    return 2;
  }
  const env = loadEnv();
  const app = await createApp();
  try {
    const found = await findLead(app.ctx.db, ref);
    if (found.kind !== "found") {
      console.log(
        found.kind === "none"
          ? `Keine Firma gefunden für "${ref}".`
          : `Mehrere Treffer: ${found.candidates.map((c) => c.name).join(", ")}`,
      );
      return 1;
    }
    const result = await buildPrototype(prototypeDeps(app, env), found.company, "cli");
    if ("kind" in result) {
      console.log(`Für ${found.company.name} gibt es keinen Screenshot der Website (erst crawlen).`);
      return 1;
    }
    console.log(`Prototyp: ${result.url ?? `${result.dir}/index.html`}`);
    console.log(`Screenshots: ${result.shots.hero}, ${result.shots.full}, ${result.shots.mobile}`);
    if (result.warnings.length) console.log(`⚠️ ${result.warnings.join(" · ")}`);
    console.log(`Kosten ${result.costUsd.toFixed(3).replace(".", ",")} $`);
    return 0;
  } finally {
    await app.close();
  }
}

/** Vorschau-Bild (Physio, ohne LLM): `avelio teaser <Firma>` schreibt data/teasers/<Firmen-ID>.jpg. */
export async function teaser(argv: string[]): Promise<number> {
  const ref = argv.join(" ").trim();
  if (!ref) {
    console.error("Verwendung: avelio teaser <Firmen-ID|Domain|Name>");
    return 2;
  }
  const app = await createApp();
  try {
    const found = await findLead(app.ctx.db, ref);
    if (found.kind !== "found") {
      console.log(
        found.kind === "none"
          ? `Keine Firma gefunden für "${ref}".`
          : `Mehrere Treffer: ${found.candidates.map((c) => c.name).join(", ")}`,
      );
      return 1;
    }
    const config = loadPrototypeConfig().teaser;
    const path = await teaserForCompany(
      app.ctx.db,
      {
        ...config,
        branches: config.branchen,
        style: config.stil,
        devices: config.geraete,
        shoot: chromiumTeaserShooter(process.env.CHROMIUM_PATH),
        photo: config.foto,
        palette: config.farbe,
        details: !config.google_details
          ? null
          : cachedPlaceDetails({
              db: app.ctx.db,
              budget: app.ctx.budget,
              apiKey: loadEnv().GOOGLE_API_KEY,
            }),
        font: config.schrift,
        withoutPhoto: config.ohne_foto,
        hero: config.eigenes_foto
          ? (company) =>
              heroForCompany(
                {
                  db: app.ctx.db,
                  llm: app.llm,
                  dir: config.foto_dir,
                  googlePhotos: config.google_fotos
                    ? googleOwnerPhotos({
                        db: app.ctx.db,
                        budget: app.ctx.budget,
                        apiKey: loadEnv().GOOGLE_API_KEY,
                      })
                    : null,
                },
                company,
              )
          : null,
      },
      found.company,
    );
    console.log(`Vorschau-Bild: ${path}`);
    return 0;
  } finally {
    await app.close();
  }
}

/** Angebot als Entwurf in Lexware: `avelio angebot <Firma> [onepager|mehrseitig]`. */
export async function angebot(argv: string[]): Promise<number> {
  const last = argv.at(-1);
  const paket = last === "onepager" || last === "mehrseitig" ? last : "onepager";
  const ref = (last === paket ? argv.slice(0, -1) : argv).join(" ").trim();
  if (!ref) {
    console.error("Verwendung: avelio angebot <Firmen-ID|Domain|Name> [onepager|mehrseitig]");
    return 2;
  }
  const env = loadEnv();
  const app = await createApp();
  try {
    const found = await findLead(app.ctx.db, ref);
    if (found.kind !== "found") {
      console.log(
        found.kind === "none"
          ? `Keine Firma gefunden für "${ref}".`
          : `Mehrere Treffer: ${found.candidates.map((c) => c.name).join(", ")}`,
      );
      return 1;
    }
    if (!env.LEXWARE_API_KEY) {
      // Ohne Public API (Lexware Office bis M): Teile zum Kopieren.
      const parts = offerCopyParts(loadOfferConfig(), {
        paket,
        company: {
          name: found.company.name,
          street: found.company.street,
          postalCode: found.company.postal_code,
          city: found.company.city,
        },
        salutation: await offerSalutationFor(app.ctx.db, found.company),
      });
      console.log(
        `Kunde:\n${parts.address}\n\nEinleitung:\n${parts.introduction}\n\nArtikel: ${parts.article} (${parts.price})\n\nBemerkung:\n${parts.remark}`,
      );
      return 0;
    }
    const offer = await createOffer(
      { db: app.ctx.db, config: loadOfferConfig(), apiKey: env.LEXWARE_API_KEY, now: app.ctx.now },
      found.company,
      paket,
      "cli",
    );
    console.log(`Angebot als Entwurf in Lexware: ${offer.url}`);
    return 0;
  } finally {
    await app.close();
  }
}

export function prototypeDeps(
  app: Awaited<ReturnType<typeof createApp>>,
  env: ReturnType<typeof loadEnv>,
): PrototypeDeps {
  const crawl = app.ctx.crawl.config;
  return {
    db: app.ctx.db,
    llm: app.llm,
    budget: app.ctx.budget,
    branches: app.ctx.lead.branches,
    config: loadPrototypeConfig(),
    duBranches: loadOutreachConfig().du_branchen,
    now: app.ctx.now,
    googleApiKey: env.GOOGLE_API_KEY ?? null,
    baseUrl: env.PREVIEW_BASE_URL?.replace(/\/$/, "") ?? null,
    desktopScreenPx: crawl.desktop.height * crawl.desktop.scale,
  };
}
