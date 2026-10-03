import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { findLead } from "./manager/leads.js";
import { loadOutreachConfig } from "./outreach/config.js";
import { draftLetter } from "./outreach/letter.js";
import { chromiumLetterRenderer } from "./outreach/letterPdf.js";

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
