import { describe, expect, it } from "vitest";
import { loadOutreachConfig } from "../src/outreach/config.js";
import { closingNotice, senderSignature } from "../src/outreach/signature.js";

describe("Absender und Schlussabsatz", () => {
  const o = loadOutreachConfig();

  it("Signatur mit Anschrift, nur wenn gesetzt", () => {
    expect(senderSignature(o, { phone: "0151 1", address: "Musterweg 1, 82380 Peißenberg" })).toBe(
      "Christian Dobler\nWebsites für lokale Betriebe · Avelio, Peißenberg\nMusterweg 1, 82380 Peißenberg\n0151 1",
    );
    expect(senderSignature(o, { phone: null })).toBe(
      "Christian Dobler\nWebsites für lokale Betriebe · Avelio, Peißenberg",
    );
  });

  it("Herkunft der Adresse passt zur Quelle; Datenschutz-Link nur mit URL", () => {
    const sie = closingNotice(o, { phone: null }, false, "google");
    expect(sie).toMatch(
      /^Ihre Mail-Adresse habe ich aus Ihrem Google-Profil und nutze sie nur für diese Anfrage\. Sie möchten/,
    );
    expect(sie).not.toContain("Datenschutz");
    const du = closingNotice(o, { phone: null, privacyUrl: "https://a.de/ds" }, true, "website");
    expect(du).toMatch(/^Deine Mail-Adresse habe ich von deiner Website/);
    expect(du).toMatch(/Mehr zum Datenschutz und zu deinem Widerspruchsrecht: https:\/\/a\.de\/ds$/);
    // Unbekannte Quelle: kein Satz über die Herkunft, der nicht stimmt
    expect(closingNotice(o, { phone: null }, false, null)).toMatch(/^Sie möchten keine weiteren/);
  });
});
