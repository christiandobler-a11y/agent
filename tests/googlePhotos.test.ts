import { describe, expect, it, vi } from "vitest";
import { upsertCompany } from "../src/db/companies.js";
import { NO_BUDGET } from "../src/llm/budget.js";
import { googleOwnerPhotos, isOwnerPhoto, ownerPhotos } from "../src/prototype/googlePhotos.js";
import { describeDb, useTestDb } from "./helpers/db.js";

describe("Fotos aus dem Google-Profil (rein)", () => {
  it("nur Fotos, die die Praxis selbst hochgeladen hat", () => {
    expect(isOwnerPhoto("Physio Lorre", "Physiotherapie Lorre")).toBe(true);
    expect(isOwnerPhoto("Therapie Centrum Rosenheim", "therapie centrum Rosenheim - Physiotherapie")).toBe(
      true,
    );
    expect(isOwnerPhoto("Anna Maier", "Physiotherapie Lorre")).toBe(false);
    expect(isOwnerPhoto("Physiotherapie Praxis", "Physiotherapie Lorre")).toBe(false); // nur Gattungswörter
    expect(isOwnerPhoto(undefined, "Physiotherapie Lorre")).toBe(false);
  });

  it("eigene, große Fotos aus der Liste; höchstens zwei", () => {
    const photo = (name: string, author: string, w = 1600, h = 1066) => ({
      name,
      widthPx: w,
      heightPx: h,
      authorAttributions: [{ displayName: author }],
    });
    const refs = ownerPhotos(
      {
        photos: [
          photo("p/1", "Max Kunde"),
          photo("p/2", "Physio Lorre"),
          photo("p/3", "Physio Lorre", 400, 300),
          photo("p/4", "Physio Lorre", 900, 2000),
          photo("p/5", "Physiotherapie Lorre"),
          photo("p/6", "Physio Lorre"),
        ],
      },
      "Physiotherapie Lorre",
    );
    expect(refs.map((r) => r.name)).toEqual(["p/2", "p/5"]);
    expect(ownerPhotos({}, "X")).toEqual([]);
  });
});

describeDb("Fotos aus dem Google-Profil mit Datenbank", () => {
  const db = useTestDb();

  it("lädt eigene Fotos, verbucht die Kosten, nur von Google-Adressen", async () => {
    const { company } = await upsertCompany(db(), { name: "Physiotherapie Lorre", placeId: "gp-1" });
    const fetchFn = vi.fn((url: string) => {
      if (url.includes("/media?"))
        return Promise.resolve(Response.json({ photoUri: "https://lh3.googleusercontent.com/abc" }));
      if (url.startsWith("https://lh3.googleusercontent.com/"))
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
      return Promise.resolve(
        Response.json({
          photos: [
            {
              name: "places/gp-1/photos/a",
              widthPx: 1600,
              heightPx: 1000,
              authorAttributions: [{ displayName: "Physio Lorre" }],
            },
            {
              name: "places/gp-1/photos/b",
              widthPx: 1600,
              heightPx: 1000,
              authorAttributions: [{ displayName: "Eva K." }],
            },
          ],
        }),
      );
    });
    const load = googleOwnerPhotos({
      db: db(),
      budget: NO_BUDGET,
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const photos = await load(company);
    expect(photos).toHaveLength(1);
    expect(fetchFn.mock.calls.map((c) => c[0]).filter((u) => u.includes("photos/b"))).toEqual([]);
    const { rows } = await db().query<{ n: number }>(
      "select count(*)::int as n from api_usage where company_id = $1",
      [company.id],
    );
    expect(rows[0]!.n).toBe(2); // Liste + ein Foto
    // Ohne Schlüssel oder Place-ID: nichts
    expect(await googleOwnerPhotos({ db: db(), budget: NO_BUDGET, apiKey: null })(company)).toEqual([]);
  });
});
