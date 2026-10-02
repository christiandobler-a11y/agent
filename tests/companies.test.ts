import { expect, it } from "vitest";
import { upsertCompany, type CompanyCandidate } from "../src/db/companies.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const base: CompanyCandidate = {
  name: "Fahrrad Müller GmbH",
  placeId: "place-mueller",
  websiteUrl: "https://www.fahrrad-mueller.de/",
  postalCode: "83022",
  city: "Rosenheim",
};

describeDb("upsertCompany", () => {
  const db = useTestDb();
  const count = async () =>
    Number((await db().query<{ n: string }>("select count(*) as n from companies")).rows[0]!.n);

  it("legt eine neue Firma mit normalisierten Schlüsseln an", async () => {
    const { company, created } = await upsertCompany(db(), base);
    expect(created).toBe(true);
    expect(company).toMatchObject({
      name: "Fahrrad Müller GmbH",
      name_normalized: "fahrrad mueller",
      place_id: "place-mueller",
      domain: "fahrrad-mueller.de",
      segment: "WEBSITE",
      status: "NEW",
    });
  });

  it("erkennt dieselbe Firma über die Place-ID", async () => {
    const r = await upsertCompany(db(), { ...base, name: "Ganz anderer Name", websiteUrl: null });
    expect(r).toMatchObject({ created: false, matchedBy: "place_id" });
    expect(r.company.name).toBe("Fahrrad Müller GmbH");
  });

  it("erkennt dieselbe Firma über die Domain", async () => {
    const r = await upsertCompany(db(), {
      name: "Müller Zweiräder",
      placeId: "place-mueller-2",
      websiteUrl: "http://fahrrad-mueller.de/kontakt",
    });
    expect(r).toMatchObject({ created: false, matchedBy: "domain" });
  });

  it("erkennt dieselbe Firma über Name + PLZ trotz Schreibvariante", async () => {
    const r = await upsertCompany(db(), {
      name: "Fahrrad Mueller e.K.",
      postalCode: "83022",
      websiteUrl: "https://facebook.com/fahrradmueller",
    });
    expect(r).toMatchObject({ created: false, matchedBy: "name_postal" });
  });

  it("legt bei gleichem Namen in anderer PLZ eine neue Firma an", async () => {
    const r = await upsertCompany(db(), { name: "Fahrrad Müller", postalCode: "83101" });
    expect(r.created).toBe(true);
  });

  it("trennt gleichnamige Firmen mit unterschiedlicher Place-ID in derselben PLZ", async () => {
    const a = await upsertCompany(db(), { name: "Radstation", placeId: "rs-1", postalCode: "83024" });
    const b = await upsertCompany(db(), { name: "Radstation", placeId: "rs-2", postalCode: "83024" });
    expect(a.created && b.created).toBe(true);
    expect(a.company.id).not.toBe(b.company.id);
  });

  it("verwechselt Firmen auf derselben Plattform nicht", async () => {
    const a = await upsertCompany(db(), { name: "Radl A", websiteUrl: "https://facebook.com/radl-a" });
    const b = await upsertCompany(db(), { name: "Radl B", websiteUrl: "https://facebook.com/radl-b" });
    expect(b.created).toBe(true);
    expect(a.company.domain).toBe("facebook.com/radl-a");
  });

  it("ergänzt fehlende Daten einer bekannten Firma, ohne vorhandene zu überschreiben", async () => {
    const first = await upsertCompany(db(), { name: "Bike Huber", postalCode: "83043" });
    expect(first.company.segment).toBe("NO_WEBSITE");

    const second = await upsertCompany(db(), {
      name: "Bike Huber",
      postalCode: "83043",
      placeId: "place-huber",
      websiteUrl: "https://bike-huber.de",
      city: "Bad Aibling",
    });
    expect(second).toMatchObject({ created: false, matchedBy: "name_postal" });
    expect(second.company).toMatchObject({
      id: first.company.id,
      place_id: "place-huber",
      domain: "bike-huber.de",
      segment: "WEBSITE",
      city: "Bad Aibling",
    });
    expect(second.company.last_seen_at.getTime()).toBeGreaterThanOrEqual(
      first.company.last_seen_at.getTime(),
    );

    const third = await upsertCompany(db(), {
      name: "Bike Huber",
      placeId: "place-huber",
      websiteUrl: "https://andere-domain.de",
    });
    expect(third.company.domain).toBe("bike-huber.de");
  });

  it("legt bei einem Doppellauf keine Dubletten an", async () => {
    const run = [
      {
        name: "Zweirad Weiß",
        placeId: "p-weiss",
        websiteUrl: "https://zweirad-weiss.de",
        postalCode: "83026",
      },
      { name: "Radsport Kern", placeId: "p-kern", postalCode: "83026" },
      { name: "E-Bike Welt", websiteUrl: "https://ebike-welt.de" },
    ];
    for (const c of run) await upsertCompany(db(), c);
    const before = await count();
    for (const c of run) expect((await upsertCompany(db(), c)).created).toBe(false);
    expect(await count()).toBe(before);
  });

  it("legt bei parallelen Jobs für dieselbe Firma genau einen Datensatz an", async () => {
    const candidate = { name: "Velo Parallel", placeId: "p-parallel", postalCode: "83022" };
    const results = await Promise.all(Array.from({ length: 5 }, () => upsertCompany(db(), candidate)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.company.id)).size).toBe(1);
  });
});
