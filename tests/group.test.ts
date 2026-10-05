import { describe, expect, it } from "vitest";
import { GroupIndex, groupKeys } from "../src/outreach/group.js";

describe("Gleicher Betrieb, anderer Standort (rein)", () => {
  // Beide Standorte der therapie centrum GmbH: eigene Domain, Mail und Telefon, aber gleiches Impressum.
  const rosenheim = groupKeys({
    websiteUrl: "https://www.tc-rosenheim.de/",
    email: "info@tc-rosenheim.de",
    postalCode: "83022",
    impressum: { register: "HRB 21103", vat_id: null, person: "Markus Ziegler" },
  });
  const stoll = groupKeys({
    websiteUrl: "https://www.tc-stollstrasse.de/",
    email: "info@tc-stollstrasse.de",
    postalCode: "83022",
    impressum: { register: "HRB 21103", vat_id: null, person: "Markus Ziegler" },
  });

  it("Standorte mit gleichem Handelsregister und Geschäftsführer gehören zusammen", () => {
    const index = new GroupIndex();
    index.add(rosenheim, "therapie centrum Rosenheim");
    expect(index.match(stoll)).toBe("therapie centrum Rosenheim");
  });

  it("gleiche USt-IdNr., gleiche Mail-Domain oder gleiche Website reichen", () => {
    const index = new GroupIndex();
    index.add(
      groupKeys({
        websiteUrl: "fitalm.de/standort/rosenheim",
        email: null,
        postalCode: null,
        impressum: null,
      }),
      "FitAlm Rosenheim",
    );
    expect(
      index.match(
        groupKeys({ websiteUrl: "https://fitalm.de/standort/kolbermoor", email: null, postalCode: null }),
      ),
    ).toBe("FitAlm Rosenheim");
    index.add(groupKeys({ websiteUrl: null, email: "a@praxis-x.de", postalCode: null }), "Praxis X");
    expect(index.match(groupKeys({ websiteUrl: null, email: "b@praxis-x.de", postalCode: null }))).toBe(
      "Praxis X",
    );
    index.add(
      groupKeys({ websiteUrl: null, email: null, postalCode: null, impressum: { vat_id: "DE 123 456 789" } }),
      "Praxis Y",
    );
    expect(
      index.match(
        groupKeys({ websiteUrl: null, email: null, postalCode: null, impressum: { vat_id: "DE123456789" } }),
      ),
    ).toBe("Praxis Y");
  });

  it("verschiedene Betriebe bleiben getrennt: Freemailer, gleiche Registernummer bei anderer Person, gleicher Name woanders", () => {
    const index = new GroupIndex();
    index.add(groupKeys({ websiteUrl: null, email: "praxis.huber@gmx.de", postalCode: "82362" }), "Huber");
    expect(
      index.match(groupKeys({ websiteUrl: null, email: "physio.maier@gmx.de", postalCode: "82362" })),
    ).toBeNull();
    index.add(rosenheim, "tc");
    expect(
      index.match(
        groupKeys({
          websiteUrl: null,
          email: null,
          postalCode: "80331",
          impressum: { register: "HRB 21103", person: "Anna Schmid" },
        }),
      ),
    ).toBeNull();
    expect(
      index.match(
        groupKeys({
          websiteUrl: null,
          email: null,
          postalCode: "10115",
          impressum: { person: "Markus Ziegler" },
        }),
      ),
    ).toBeNull();
  });
});
