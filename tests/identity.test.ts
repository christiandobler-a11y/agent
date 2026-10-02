import { describe, expect, it } from "vitest";
import { domainIdentity, normalizeName, normalizePostalCode } from "../src/pipeline/research/identity.js";

describe("domainIdentity", () => {
  it.each([
    ["https://www.fahrrad-mueller.de/kontakt?x=1", "fahrrad-mueller.de"],
    ["http://Fahrrad-Mueller.DE", "fahrrad-mueller.de"],
    ["fahrrad-mueller.de/", "fahrrad-mueller.de"],
    ["www.fahrrad-mueller.de:8080/shop", "fahrrad-mueller.de"],
    ["https://shop.fahrrad-mueller.de", "shop.fahrrad-mueller.de"],
    ["https://www.radhaus-rosenheim.de.", "radhaus-rosenheim.de"],
    ["https://xn--mller-kva.de", "xn--mller-kva.de"],
    ["https://müller.de", "xn--mller-kva.de"],
  ])("%s → %s", (input, expected) => {
    expect(domainIdentity(input)).toBe(expected);
  });

  it.each([
    ["https://www.facebook.com/FahrradMueller/", "facebook.com/fahrradmueller"],
    ["https://m.facebook.com/fahrradmueller", "m.facebook.com/fahrradmueller"],
    ["https://radhaus.jimdofree.com/", "radhaus.jimdofree.com"],
    ["https://radhaus.jimdofree.com/leistungen", "radhaus.jimdofree.com/leistungen"],
    ["https://maxmueller.wixsite.com/radladen", "maxmueller.wixsite.com/radladen"],
    ["https://www.gelbeseiten.de/gsbiz/1234", "gelbeseiten.de/gsbiz/1234"],
  ])("Plattform %s → %s", (input, expected) => {
    expect(domainIdentity(input)).toBe(expected);
  });

  it("unterscheidet zwei Firmen auf derselben Plattform", () => {
    expect(domainIdentity("https://facebook.com/radladen-a")).not.toBe(
      domainIdentity("https://facebook.com/radladen-b"),
    );
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["   "],
    ["https://www.facebook.com/"],
    ["https://instagram.com"],
    ["mailto:info@fahrrad-mueller.de"],
    ["ftp://fahrrad-mueller.de"],
    ["localhost"],
    ["http://"],
  ])("liefert null für %s", (input) => {
    expect(domainIdentity(input)).toBeNull();
  });
});

describe("normalizeName", () => {
  it.each([
    ["Fahrrad Müller GmbH", "fahrrad mueller"],
    ["Fahrrad-Müller GmbH & Co. KG", "fahrrad mueller"],
    ["FAHRRAD MÜLLER e.K.", "fahrrad mueller"],
    ["Fahrrad Müller e. K.", "fahrrad mueller"],
    ["Radsport Weiß UG (haftungsbeschränkt)", "radsport weiss"],
    ["Bäckerei & Café Schön", "baeckerei und cafe schoen"],
    ["Zweirad Huber Inh. Max Huber", "zweirad huber max huber"],
    ["  Bike   Center  Rosenheim ", "bike center rosenheim"],
    ["Café Crème", "cafe creme"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it("gleicht Schreibvarianten derselben Firma an", () => {
    expect(normalizeName("Fahrrad Müller GmbH")).toBe(normalizeName("Fahrrad Mueller"));
  });

  it("lässt einen Namen, der nur aus einer Rechtsform besteht, nicht leer", () => {
    expect(normalizeName("AG")).toBe("ag");
  });
});

describe("normalizePostalCode", () => {
  it.each([
    ["83022", "83022"],
    [" 83 022 ", "83022"],
    ["8302", null],
    ["A-6020", null],
    [null, null],
  ])("%s → %s", (input, expected) => {
    expect(normalizePostalCode(input)).toBe(expected);
  });
});
