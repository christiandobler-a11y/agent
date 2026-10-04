import { describe, expect, it } from "vitest";
import { cleanPersonName, deobfuscate, parseImpressum } from "../src/pipeline/crawl/impressum.js";

describe("parseImpressum", () => {
  it("Einzelunternehmen mit Inhaber, Telefon, E-Mail und USt-ID", () => {
    const text = `Impressum
Angaben gemäß § 5 DDG
Radl Meier
Inhaber: Thomas Meier
Aiblinger Str. 17c
83043 Bad Aibling
Telefon: 08061 / 93 67 396
Fax: 08061 / 93 67 397
E-Mail: info@radlmeier.com
Umsatzsteuer-Identifikationsnummer gemäß § 27 a UStG: DE 123 456 789`;
    expect(parseImpressum(text)).toEqual({
      person: "Thomas Meier",
      salutation: null,
      role: "Inhaber",
      emails: ["info@radlmeier.com"],
      phones: ["08061 / 93 67 396"],
      vat_id: "DE123456789",
      register: null,
    });
  });

  it("GmbH: Geschäftsführer in der nächsten Zeile, mehrere Namen, Registereintrag", () => {
    const text = `Bikestore Oliver Blas GmbH
Geschäftsführer:
Oliver Blas, Maria Blas
Registergericht: Amtsgericht Traunstein
HRB 12345
Tel. +49 (0) 8035 123-45
Kontakt: shop [at] bikestore-ob [dot] de`;
    expect(parseImpressum(text)).toMatchObject({
      person: "Oliver Blas",
      role: "Geschäftsführer",
      emails: ["shop@bikestore-ob.de"],
      phones: ["+49 (0) 8035 123-45"],
      register: "HRB 12345",
    });
  });

  it("'Vertreten durch' mit Titel und Anrede; Firmenname wird nicht als Person erkannt", () => {
    expect(
      parseImpressum("Vertreten durch: Herrn Dipl.-Ing. Hans-Peter Huber\nTelefon 08031 12345"),
    ).toMatchObject({ person: "Hans-Peter Huber", role: "Vertreten durch", phones: ["08031 12345"] });
    expect(parseImpressum("Vertreten durch: Muster Verwaltungs GmbH")).toMatchObject({
      person: null,
      role: null,
    });
  });

  it("ohne verwertbare Angaben: leeres Ergebnis statt Fehler", () => {
    expect(parseImpressum("Seite nicht gefunden")).toEqual({
      person: null,
      salutation: null,
      role: null,
      emails: [],
      phones: [],
      vat_id: null,
      register: null,
    });
  });

  it("Verantwortlich nach § 18 MStV und Fax wird nicht als Telefon gezählt", () => {
    const r = parseImpressum(
      "Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV:\nAnna Berger\nFax: 0800 999",
    );
    expect(r).toMatchObject({ person: "Anna Berger", role: "Verantwortlich", phones: [] });
  });
});

describe("Hilfsfunktionen Impressum", () => {
  it("deobfuscate", () => {
    expect(deobfuscate("info(at)firma.de")).toBe("info@firma.de");
    expect(deobfuscate("info [ät] firma [punkt] de")).toBe("info@firma.de");
  });

  it("Anrede nur, wenn sie dasteht; Berufsbezeichnungen und Rollenwörter sind keine Namen", () => {
    expect(parseImpressum("Inhaberin: Frau Monika Späth\nTel. 08051 1234")).toMatchObject({
      person: "Monika Späth",
      salutation: "Frau",
      role: "Inhaber",
    });
    expect(parseImpressum("Verantwortlich: Malermeister Kai Ernst")).toMatchObject({
      person: "Kai Ernst",
      salutation: null,
    });
    expect(parseImpressum("Vertreten durch:\nGeschäftsführender Gesellschafter")).toMatchObject({
      person: null,
    });
    // Weibliche Rolle ist eine Angabe → Frau; männliche Rolle nie → Herr.
    expect(parseImpressum("Praxisinhaberin: Christina Heider")).toMatchObject({
      person: "Christina Heider",
      salutation: "Frau",
    });
    expect(parseImpressum("Inhaber: Max Huber")).toMatchObject({ person: "Max Huber", salutation: null });
    expect(parseImpressum("Geschäftsführer: Herrn Josef Kerscher")).toMatchObject({
      person: "Josef Kerscher",
      salutation: "Herr",
    });
  });

  it("Einzelunternehmer ohne Rollen-Angabe direkt unter „Angaben gemäß § 5“", () => {
    expect(
      parseImpressum(
        "Impressum\nAngaben gemäß § 5 DDG\nPhysiotherapie Aicher\nAnna Aicher\nHauptstr. 3\n83022 Rosenheim",
      ),
    ).toMatchObject({ person: "Anna Aicher", role: "Inhaber" });
  });

  it("cleanPersonName", () => {
    expect(cleanPersonName("Frau Dr. Eva Maria Schmidt (Inhaberin)")).toBe("Eva Maria Schmidt");
    expect(cleanPersonName("Hauptstraße 5")).toBeNull();
    expect(cleanPersonName("Thomas")).toBeNull();
    expect(cleanPersonName("siehe oben")).toBeNull();
    expect(cleanPersonName("Wasserburger Radhaus")).toBeNull();
    expect(cleanPersonName("Schreinerei Senega")).toBeNull();
    expect(cleanPersonName("Hotel Ariadne")).toBeNull();
    expect(cleanPersonName("Thomas Frei")).toBe("Thomas Frei");
    expect(cleanPersonName("Kai Ernst")).toBe("Kai Ernst");
    expect(cleanPersonName("Fahrradwelt Huber")).toBeNull();
    expect(cleanPersonName("Bike Point Rosenheim")).toBeNull();
    expect(cleanPersonName("Martin Huber")).toBe("Martin Huber");
  });
});
