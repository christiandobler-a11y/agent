import { describe, expect, it, vi } from "vitest";
import { insertPlacesSnapshot } from "../src/db/placesSnapshots.js";
import { upsertCompany, type Company } from "../src/db/companies.js";
import type { LlmGateway } from "../src/llm/gateway.js";
import { loadModelsConfig, loadPrompt } from "../src/llm/config.js";
import { briefingMarkdown, briefingSchema, buildBriefing, type Briefing } from "../src/shop/briefing.js";
import { proposeShop } from "../src/shop/job.js";
import {
  getPick,
  isoWeek,
  loadShopConfig,
  pickShop,
  setPick,
  shopDue,
  usedDirections,
  type ShopConfig,
} from "../src/shop/pick.js";
import { directionCard, parseShopCallback, shopCallback } from "../src/telegram/shop.js";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createBot } from "../src/telegram/bot.js";
import type { PipelineContext } from "../src/queue/pipeline.js";
import { loadOutreachConfig } from "../src/outreach/config.js";
import { loadMailConfig } from "../src/outreach/mail.js";
import type { Update, UserFromGetMe } from "grammy/types";
import { describeDb, useTestDb } from "./helpers/db.js";

const ALLOWED = 4244;
let updateId = 1;
const callbackUpdate = (data: string): Update => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`,
    chat_instance: "x",
    from: { id: ALLOWED, is_bot: false, first_name: "X" },
    data,
    message: { message_id: 7, date: 0, chat: { id: ALLOWED, type: "private", first_name: "X" }, text: "alt" },
  },
});
const textUpdate = (text: string): Update => ({
  update_id: updateId++,
  message: {
    message_id: 100 + updateId,
    date: 0,
    chat: { id: ALLOWED, type: "private", first_name: "X" },
    from: { id: ALLOWED, is_bot: false, first_name: "X" },
    text,
    entities: text.startsWith("/")
      ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }]
      : [],
  },
});

const direction = (name: string) => ({
  name,
  idee: `Idee ${name}`,
  grundform: "redaktionell",
  stimmung: "ruhig",
  farben: ["#112233", "#ddeeff"],
  schriften: { titel: "Fraunces", text: "Work Sans" },
  layout: "großes Foto, dann Werkstatt-Raster",
  signatur_element: "Rahmenlinie <durchgehend>",
  bildsprache: "eigene Fotos",
  textton: "direkt",
  warum: "Bewertungen loben die Werkstatt",
});

const output = {
  laden_kurz: "Kleiner Radladen mit Werkstatt.",
  zielgruppe: "Pendler und Familien",
  staerken: ["schnelle Reparatur"],
  schwaechen_alte_seite: ["wirkt älter als der Laden"],
  inhalte: ["Werkstatt", "Räder", "Kontakt"],
  richtungen: [
    direction("Werkstattbuch"),
    direction("Bergsommer"),
    direction("Kettenblatt"),
    direction("Extra"),
  ],
  gespraech: ["Ich hab mir Ihre Seite angeschaut …"],
  fotos_vor_ort: ["Werkbank mit Werkzeug"],
};

describe("Laden der Woche (rein)", () => {
  it("Konfiguration, Prompt, Schema, Kalenderwoche, Fälligkeit", () => {
    const c = loadShopConfig();
    expect(c.branchen).toEqual(["fahrrad", "friseur", "kosmetik"]);
    expect(loadModelsConfig().roles.briefing).toBeDefined();
    expect(loadPrompt("briefing", "v1")).toContain("keine austauschbare KI-Optik");
    expect(zodOutputFormat(briefingSchema).type).toBe("json_schema");
    expect(isoWeek(new Date("2026-10-05T10:00:00Z"))).toBe("2026-W41");
    expect(isoWeek(new Date("2027-01-01T10:00:00Z"))).toBe("2026-W53");
    expect(shopDue(c, 1, "07:30")).toBe(true);
    expect(shopDue(c, 1, "07:00")).toBe(false);
    expect(shopDue(c, 2, "09:00")).toBe(false);
  });

  it("Knopf-Daten hin und zurück; Richtungs-Karte escaped", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    for (const c of [
      { kind: "take" as const, id },
      { kind: "next" as const, id },
      { kind: "dir" as const, id, index: 2 },
    ]) {
      expect(shopCallback(c).length).toBeLessThanOrEqual(64);
      expect(parseShopCallback(shopCallback(c))).toEqual(c);
    }
    expect(parseShopCallback("sw:x:1")).toBeNull();
    const card = directionCard(direction("Werkstattbuch"), 1, id);
    expect(card.text).toContain("<b>B: Werkstattbuch</b>");
    expect(card.text).toContain("Rahmenlinie &lt;durchgehend&gt;");
    expect(card.keyboard[0]![0]!.text).toBe("👉 Richtung B nehmen");
  });

  it("Briefing als Markdown mit gewählter Richtung", () => {
    const b: Briefing = {
      ...output,
      richtungen: output.richtungen.slice(0, 3),
      laden: {
        name: "Bikeshop",
        ort: "Peißenberg",
        adresse: "Hauptstr. 1, 82380 Peißenberg",
        telefon: "0881 1",
        website: "https://bike.de",
        bewertung: "4,8 bei 90 Bewertungen",
        oeffnungszeiten: ["Mo–Fr: 09:00–18:00"],
        fotos: ["https://bike.de/a.jpg"],
        logo: "https://bike.de/logo.png",
      },
    };
    const md = briefingMarkdown(b, 1);
    expect(md).toMatch(/^# Laden der Woche: Bikeshop/);
    expect(md).toContain("### B: Bergsommer (gewählt)");
    expect(md).toContain("- **Schriften:** Fraunces (Überschriften), Work Sans (Text)");
    expect(md).toContain("Logo: https://bike.de/logo.png");
  });
});

describeDb("Laden der Woche", () => {
  const db = useTestDb();
  const home = { lat: 47.7955, lng: 11.0645 }; // Peißenberg
  const config: ShopConfig = {
    aktiv: true,
    tag: "montag",
    ab: "07:30",
    branchen: ["fahrrad", "friseur"],
    umkreis_km: 25,
    min_bewertung: 4.2,
    min_bewertungen: 10,
  };
  let n = 0;
  async function shop(o: {
    branch?: string;
    lat?: number;
    lng?: number;
    rating?: number;
    reviews?: number;
    score?: number;
  }): Promise<Company> {
    const { company } = await upsertCompany(db(), {
      name: `Laden ${++n}`,
      placeId: `shop-${n}`,
      city: "Peißenberg",
      websiteUrl: `https://laden${n}.de`,
    });
    await db().query(
      `update companies set status = 'QUALIFIED', branch_key = $2, lat = $3, lng = $4, current_score = $5
        where id = $1`,
      [company.id, o.branch ?? "fahrrad", o.lat ?? 47.8, o.lng ?? 11.07, o.score ?? 70],
    );
    await insertPlacesSnapshot(db(), {
      companyId: company.id,
      rating: o.rating ?? 4.7,
      reviewCount: o.reviews ?? 40,
      businessStatus: "OPERATIONAL",
      photoCount: 0,
      raw: {},
    });
    const { rows } = await db().query<Company>("select * from companies where id = $1", [company.id]);
    return rows[0]!;
  }

  it("Auswahl: Branche, Umkreis, Bewertung; bester Score zuerst; nie zweimal", async () => {
    const best = await shop({ score: 90 });
    const good = await shop({ score: 80, branch: "friseur" });
    await shop({ score: 99, branch: "physiotherapie" }); // falsche Branche
    await shop({ score: 99, lat: 47.86, lng: 12.12 }); // Rosenheim, zu weit
    await shop({ score: 99, rating: 3.9 }); // zu schlecht bewertet
    await shop({ score: 99, reviews: 3 }); // zu wenige Bewertungen
    const first = await proposeShop(db(), { config, home, briefing: () => ({}) as never }, new Date());
    expect(first?.candidate.id).toBe(best.id);
    expect(first?.candidate.distance_km).toBeLessThan(5);
    expect(first?.pick.status).toBe("vorgeschlagen");
    const second = await pickShop(db(), config, home);
    expect(second?.id).toBe(good.id);
  });

  it("Briefing: Daten an das LLM, höchstens drei Richtungen, gewählte Richtung zählt als verwendet", async () => {
    const c = await shop({ score: 60 });
    const structured = vi.fn().mockResolvedValue({ output, costUsd: 0.2, agentRunId: "r", model: "m" });
    const collect = vi.fn().mockResolvedValue({
      images: [
        {
          url: "https://x.de/foto.jpg",
          width: 1600,
          height: 900,
          shownWidth: 1200,
          shownHeight: 600,
          top: 100,
          alt: "",
          kind: "img",
        },
      ],
      logos: [],
    });
    const b = await buildBriefing(
      {
        db: db(),
        llm: { structured } as unknown as LlmGateway,
        collect,
        hours: () => Promise.resolve(["Mo–Fr: 09:00–18:00"]),
        desktopScreenPx: 900,
        branchLabel: () => "Fahrradhandel",
      },
      c,
    );
    expect(b.richtungen).toHaveLength(3);
    expect(b.laden).toMatchObject({
      name: c.name,
      bewertung: "4,7 bei 40 Bewertungen",
      fotos: ["https://x.de/foto.jpg"],
    });
    const req = structured.mock.calls[0]![0] as { role: string; input: { type: string; text?: string }[] };
    expect(req.role).toBe("briefing");
    const data = req.input.find((p) => p.type === "text" && p.text?.startsWith("<daten>"))!.text!;
    expect(data).toContain('"branche": "Fahrradhandel"');
    expect(data).toContain('"schon_verwendet": []');

    const pick = (await proposeShop(
      db(),
      { config: { ...config, min_bewertungen: 0 }, home, briefing: () => ({}) as never },
      new Date(),
    ))!;
    await setPick(db(), pick.pick.id, { status: "genommen", briefing: b }, new Date());
    await setPick(db(), pick.pick.id, { chosen: 1 }, new Date());
    expect((await getPick(db(), pick.pick.id))?.chosen).toBe(1);
    expect(await usedDirections(db())).toEqual([{ name: "Bergsommer", idee: "Idee Bergsommer" }]);
  });

  it("Telegram: /laden → Nehmen → Briefing mit drei Richtungen und Datei → Richtung wählen", async () => {
    await db().query("update companies set status = 'LOST'");
    const c = await shop({ score: 95 });
    const structured = vi.fn().mockResolvedValue({ output, costUsd: 0.2, agentRunId: "r", model: "m" });
    const llm = { structured, toolStep: vi.fn(), research: vi.fn() } as unknown as LlmGateway;
    const pipeline = {
      db: db(),
      now: () => new Date(),
      crm: { follow_up_days: 5, quiet_hours: { start: "21:00", end: "08:00" } },
      lead: { branches: {} },
      shop: {
        config,
        home,
        briefing: () => ({
          db: db(),
          llm,
          collect: () => Promise.resolve({ images: [], logos: [] }),
          desktopScreenPx: 900,
        }),
      },
    } as unknown as PipelineContext;
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const bot = createBot({
      token: "123:test",
      allowedChatIds: [ALLOWED],
      manager: { ctx: pipeline, llm },
      botInfo: { id: 1, is_bot: true, first_name: "Avelio", username: "avelio_test_bot" } as UserFromGetMe,
      outreach: { config: loadOutreachConfig(), contact: { whatsapp: null, phone: null } },
      mail: { mailbox: null, config: loadMailConfig() },
    });
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload });
      return Promise.resolve({
        ok: true,
        result: method.startsWith("send")
          ? { message_id: calls.length, date: 0, chat: { id: ALLOWED, type: "private" } }
          : true,
      } as never);
    });
    const messages = () => calls.filter((x) => x.method === "sendMessage").map((x) => x.payload);
    const buttons = (p: Record<string, unknown>) =>
      (
        p.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }
      ).inline_keyboard.flat();

    await bot.handleUpdate(textUpdate("/laden"));
    const card = messages().at(-1)!;
    expect(String(card.text)).toContain(`<b>${c.name}</b>`);
    await bot.handleUpdate(callbackUpdate(buttons(card).find((b) => b.text === "✅ Nehmen")!.callback_data!));
    const texts = messages().map((m) => String(m.text));
    expect(texts.some((t) => t.startsWith("🎨 <b>Briefing:"))).toBe(true);
    const dirs = messages().filter((m) => String(m.text).match(/^<b>[ABC]: /));
    expect(dirs).toHaveLength(3);
    expect(calls.filter((x) => x.method === "sendDocument")).toHaveLength(1);
    await bot.handleUpdate(callbackUpdate(buttons(dirs[2]!)[0]!.callback_data!));
    expect(String(messages().at(-1)!.text)).toContain("<b>Kettenblatt</b>");
    expect(calls.filter((x) => x.method === "sendDocument")).toHaveLength(2);
    expect((await usedDirections(db()))[0]).toEqual({ name: "Kettenblatt", idee: "Idee Kettenblatt" });
  });
});
