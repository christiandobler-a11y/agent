import { chromium } from "playwright";

/** Druckt die Befund-Seite (HTML, alles eingebettet, kein Netz) mit Chromium zu PDF und einer PNG-Vorschau. */

export interface RenderedLetter {
  pdf: Buffer;
  png: Buffer;
}

export type LetterRenderer = (html: string) => Promise<RenderedLetter>;

export function chromiumLetterRenderer(executablePath?: string): LetterRenderer {
  return async (html) => {
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    try {
      // A4 bei 96 dpi: 794 × 1123 CSS-Pixel; Vorschau doppelt so scharf.
      const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
      // Alles ist eingebettet; Anfragen nach außen gar nicht erst zulassen.
      await page.route("**/*", (route) =>
        route.request().url().startsWith("data:") ? route.continue() : route.abort(),
      );
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate("document.fonts.ready.then(() => true)");
      const png = await page.screenshot({ type: "png" });
      const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
      return { pdf: Buffer.from(pdf), png: Buffer.from(png) };
    } finally {
      await browser.close();
    }
  };
}
