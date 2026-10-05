import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  buildDailyPlan,
  candidates,
  loadAutopilotConfig,
  type AutopilotConfig,
} from "../src/autopilot/plan.js";
import { upsertCompany, type Company } from "../src/db/companies.js";
import { planItems } from "../src/db/plan.js";
import { insertWebsiteSnapshot } from "../src/db/websiteSnapshots.js";
import type { LlmGateway } from "../src/llm/gateway.js";
import {
  dialable,
  dueCallLetters,
  missedCalls,
  parseConsentInput,
  phoneDigits,
  pitchAt,
  prepareCall,
  recordCall,
} from "../src/outreach/call.js";
import { cachedOpeningHours, hoursOn } from "../src/prototype/placeDetails.js";
import { insertPlacesSnapshot } from "../src/db/placesSnapshots.js";
import { NO_BUDGET } from "../src/llm/budget.js";
import { loadOutreachConfig } from "../src/outreach/config.js";
import { outreachStats, statsText } from "../src/outreach/stats.js";
import { planCallCard, planCallback, parsePlanCallback } from "../src/telegram/plan.js";
import { createBot } from "../src/telegram/bot.js";
import type { PipelineContext } from "../src/queue/pipeline.js";
import { loadMailConfig } from "../src/outreach/mail.js";
import type { Update, UserFromGetMe } from "grammy/types";
import { describeDb, useTestDb } from "./helpers/db.js";

const ALLOWED = 4243;
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
  },
});

const NOW = new Date("2026-10-05T03:00:00Z"); // Montag
const o = loadOutreachConfig();

describe("Anruf-Liste (rein)", () => {
  it("Telefonnummer international zum Antippen", () => {
    expect(dialable("08031 123456")).toBe("+49 8031 123456");
    expect(dialable("+49 881 1")).toBe("+49 881 1");
    expect(dialable("0049 881 1")).toBe("+49 881 1");
  });

  it("Kurzer Satz aus der Konfiguration, Wähl-Ziffern", () => {
    expect(pitchAt(o.anruf!, "08:15")).toBe(
      "Guten Morgen, Dobler mein Name. Ich habe etwas für die Praxis vorbereitet und würde Ihnen das gerne einmal per Mail zeigen. Ist es in Ordnung, wenn ich Ihnen das schicke?",
    );
    expect(pitchAt(o.anruf!, "10:59")).toMatch(/^Guten Morgen,/);
    expect(pitchAt(o.anruf!, "11:00")).toMatch(/^Grüß Gott,/);
    expect(pitchAt(o.anruf!, "17:45")).toMatch(/^Guten Abend,/);
    expect(phoneDigits("08031 12-34 56")).toBe("498031123456");
  });

  it("Öffnungszeiten für heute aus den zusammengefassten Zeilen", () => {
    const hours = ["Mo–Do: 08:00–12:00, 14:00–19:00", "Fr: 08:00–14:00", "Sa, So: geschlossen"];
    expect(hoursOn(hours, 1)).toBe("08:00–12:00, 14:00–19:00"); // Montag
    expect(hoursOn(hours, 4)).toBe("08:00–12:00, 14:00–19:00"); // Donnerstag
    expect(hoursOn(hours, 5)).toBe("08:00–14:00");
    expect(hoursOn(hours, 0)).toBe("geschlossen"); // Sonntag
    expect(hoursOn([], 1)).toBeNull();
  });

  it("Eingabe nach dem Ja: Name und Adresse", () => {
    expect(parseConsentInput("Frau Huber huber@praxis.de")).toEqual({
      email: "huber@praxis.de",
      name: "Huber",
      salutation: "Frau",
    });
    expect(parseConsentInput("info@Praxis.DE")).toEqual({
      email: "info@praxis.de",
      name: null,
      salutation: null,
    });
    expect(parseConsentInput("herr Max Maier, max@x.de")).toMatchObject({
      name: "Max Maier",
      salutation: "Herr",
    });
    expect(parseConsentInput("ruft zurück").email).toBeNull();
  });

  it("Karte: Name, Nummer, Öffnungszeiten heute, Wähl-Knopf, Ja/Nein/nicht erreicht", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const card = planCallCard(
      {
        id,
        plan_date: "2026-10-05",
        company_id: id,
        kind: "new",
        channel: "phone",
        draft_id: id,
        status: "ready",
        position: 1,
        done_at: null,
        send_after: null,
        company_name: "Physio <Test>",
        current_score: 80,
        website_url: "https://physio.de",
      },
      {
        body: "",
        meta: {
          phone: "+49 881 1",
          hours: ["Mo–Fr: 08:00–18:00", "Sa, So: geschlossen"],
          pitch: "Guten Morgen",
        },
      },
      { n: 1, total: 3 },
      1,
      "https://vorschau.example/tel/498811",
    );
    expect(card.text).toBe(
      "📞 <b>Physio &lt;Test&gt;</b> · 1/3\n☎️ +49 881 1\n🕐 Heute: 08:00–18:00\n\n<i>Guten Morgen</i>",
    );
    expect(card.keyboard.flat().map((b) => b.text)).toEqual([
      "📞 Anrufen",
      "✅ Ja",
      "❌ Nein",
      "📵 Nicht erreicht",
    ]);
    expect(card.keyboard[0]![0]).toMatchObject({ url: "https://vorschau.example/tel/498811" });
    for (const kind of ["yes", "post", "missed", "nope", "impressum", "other"] as const)
      expect(parsePlanCallback(planCallback({ kind, id }))).toEqual({ kind, id });
  });

  it("Zahlen zeigen die Anrufe", () => {
    const text = statsText({
      sent: 2,
      followUps: 0,
      bounced: 0,
      replied: 0,
      interested: 0,
      won: 0,
      calls: 10,
      callYes: 4,
      costUsd: 1,
    });
    expect(text).toContain("📞 Anrufe erreicht: 10, davon Ja zur Mail: 4 (40,0 %)");
  });
});

describeDb("Anruf-Liste", () => {
  const db = useTestDb();
  let n = 0;

  async function lead(over: { phone?: string | null; street?: string | null; score?: number } = {}) {
    const { company } = await upsertCompany(db(), {
      name: `Physio ${++n}`,
      placeId: `call-${n}`,
      city: "Weilheim",
    });
    const { rows } = await db().query<Company>(
      `update companies set status = 'QUALIFIED', current_score = $2, street = $3, postal_code = '82362',
              branch_key = 'physiotherapie', phone = $4 where id = $1 returning *`,
      [
        company.id,
        over.score ?? 80,
        over.street === undefined ? "Hauptstr. 1" : over.street,
        over.phone === undefined ? "0881 12345" : over.phone,
      ],
    );
    await db().query(
      "insert into contacts (company_id, name, email, source) values ($1, 'Elisabeth Huber', $2, 'impressum')",
      [company.id, `info@physio${n}.de`],
    );
    await db().query(
      `insert into audits (company_id, prompt_version, model, findings, rubric, commercial, summary)
       values ($1, 'v1', 'm', $2, '{}', '{}', 's')`,
      [
        company.id,
        JSON.stringify([
          {
            title: "Kein Termin-Knopf",
            detail: "d",
            evidence: "e",
            severity: "high",
            category: "conversion",
          },
        ]),
      ],
    );
    return rows[0]!;
  }

  it("Plan: mit Nummer auf die Anruf-Liste, ohne Nummer ein Brief; beides zählt zum Tagesziel", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "avelio-call-"));
    const shot = join(tmp, "desktop.jpg");
    await sharp({ create: { width: 1440, height: 1800, channels: 3, background: "#fff" } })
      .jpeg()
      .toFile(shot);
    const a = await lead({ score: 95 });
    const noPhone = await lead({ score: 90, phone: null });
    const b = await lead({ score: 85 });
    const nothing = await lead({ score: 99, phone: null, street: null });
    await insertWebsiteSnapshot(db(), {
      companyId: noPhone.id,
      url: "https://x.de",
      screenshotDesktop: shot,
      screenshotMobile: shot,
    });
    const structured = vi.fn(() =>
      Promise.resolve({
        output: { markierungen: [], zeilen: "Ihre Seite ist mir aufgefallen.", popup_im_bild: false },
        agentRunId: "r",
        costUsd: 0,
        model: "m",
      }),
    );
    const base = loadAutopilotConfig();
    const config: AutopilotConfig = {
      ...base,
      erstkontakt: "anruf",
      neue_kontakte: { ...base.neue_kontakte, stufen: [{ ab_tag: 0, pro_tag: 3 }], heimat: undefined },
    };
    const mx = vi.fn(() => Promise.resolve(true));
    const result = await buildDailyPlan({
      db: db(),
      now: () => NOW,
      config,
      letter: {
        db: db(),
        llm: { structured } as unknown as LlmGateway,
        outreach: o,
        branches: {},
        now: () => NOW,
        contact: { whatsapp: null, phone: null },
        render: () => Promise.resolve({ pdf: Buffer.from("%PDF"), png: Buffer.from("png") }),
        desktopScreenPx: 900,
      },
      prototype: null,
      mx,
      lettersDir: tmp,
    });
    expect(result.calls).toBe(2);
    expect(result.letters).toBe(1);
    expect(result.emails).toBe(0);
    expect(result.skipped).toEqual([
      { name: nothing.name, reason: "keine Telefonnummer und keine Anschrift" },
    ]);
    const items = await planItems(db(), "2026-10-05");
    expect(items.map((i) => [i.company_id, i.channel])).toEqual([
      [a.id, "phone"],
      [noPhone.id, "letter"],
      [b.id, "phone"],
    ]);
    const { rows } = await db().query<{ meta: { phone: string; email: string } }>(
      "select meta from interactions where id = $1",
      [items[0]!.draft_id],
    );
    expect(rows[0]!.meta.phone).toBe("+49 881 12345");
    expect(rows[0]!.meta.email).toMatch(/^info@/);
    expect(mx).not.toHaveBeenCalled();
    await db().query("update companies set status = 'LOST'");
  });

  it("Ergebnisse: Ja ist Einwilligung, kein Interesse nie wieder, Post oder 3× nicht erreicht → Brief", async () => {
    const yes = await lead();
    const no = await lead();
    const post = await lead();
    const missed = await lead();
    const by = "test";
    await recordCall(db(), yes.id, "ja", { by, now: NOW, to: "huber@praxis.de", person: "Frau Huber" });
    await recordCall(db(), no.id, "kein_interesse", { by, now: NOW });
    await recordCall(db(), post.id, "brief", { by, now: NOW });
    for (let i = 0; i < 2; i++) await recordCall(db(), missed.id, "nicht_erreicht", { by, now: NOW });
    expect(await missedCalls(db(), missed.id)).toBe(2);

    const { rows: consent } = await db().query<{
      body: string;
      meta: { consent: { to: string; person: string } };
    }>("select body, meta from interactions where company_id = $1 and meta->>'call' = 'ja'", [yes.id]);
    expect(consent[0]!.body).toContain("Telefonisch eingewilligt");
    expect(consent[0]!.meta.consent).toMatchObject({ to: "huber@praxis.de", person: "Frau Huber" });
    const status = async (c: Company) =>
      (await db().query<{ status: string }>("select status from companies where id = $1", [c.id])).rows[0]!
        .status;
    expect(await status(yes)).toBe("CONTACTED");
    expect(await status(no)).toBe("LOST");

    // Nur der zweimal nicht erreichte kommt wieder auf die Anruf-Liste.
    const next = (await candidates(db(), "2026-10-06", 20, ["physiotherapie"], undefined, 3)).map(
      (c) => c.id,
    );
    expect(next).toContain(missed.id);
    for (const c of [yes, no, post]) expect(next).not.toContain(c.id);
    expect((await dueCallLetters(db(), 3, 10)).map((c) => c.id)).toEqual([post.id]);

    await recordCall(db(), missed.id, "nicht_erreicht", { by, now: NOW });
    expect(
      (await candidates(db(), "2026-10-06", 20, ["physiotherapie"], undefined, 3)).map((c) => c.id),
    ).not.toContain(missed.id);
    expect((await dueCallLetters(db(), 3, 10)).map((c) => c.id).sort()).toEqual([post.id, missed.id].sort());

    const s = await outreachStats(db());
    expect(s).toMatchObject({ calls: 3, callYes: 1 });
    expect(await prepareCall(db(), o, { ...yes, phone: null }, by, NOW)).toBeNull();
  });

  it("Telegram: Ja → Adresse wählen → Mail mit Einwilligung; andere Adresse per Nachricht; nicht erreicht", async () => {
    await db().query("update companies set status = 'LOST'");
    await db().query("delete from outreach_plan");
    const a = await lead({ score: 99 });
    const b = await lead({ score: 98 });
    const c = await lead({ score: 97 });
    const date = "2026-10-05";
    const { addPlanItem } = await import("../src/db/plan.js");
    for (const x of [a, b, c]) {
      const call = await prepareCall(db(), o, x, "test", NOW);
      await addPlanItem(db(), {
        date,
        companyId: x.id,
        kind: "new",
        channel: "phone",
        draftId: call!.draftId,
      });
    }
    const structured = vi.fn(() =>
      Promise.resolve({
        output: { absatz: "mir ist Ihre Praxis aufgefallen." },
        agentRunId: "r",
        costUsd: 0,
        model: "m",
      }),
    );
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const bot = createBot({
      token: "123:test",
      allowedChatIds: [ALLOWED],
      manager: {
        ctx: {
          db: db(),
          now: () => NOW,
          crm: { follow_up_days: 5, quiet_hours: { start: "21:00", end: "08:00" } },
          lead: { branches: {} },
        } as unknown as PipelineContext,
        llm: { structured, toolStep: vi.fn(), research: vi.fn() } as unknown as LlmGateway,
      },
      botInfo: { id: 1, is_bot: true, first_name: "Avelio", username: "avelio_test_bot" } as UserFromGetMe,
      outreach: { config: o, contact: { whatsapp: null, phone: null } },
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
    const buttonsOf = (p: Record<string, unknown>) =>
      (
        p.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }
      ).inline_keyboard.flat();
    // Letzte Nachricht mit Text (Abzeichen und Level-Meldungen zwischendurch überspringen).
    const lastMessage = () =>
      calls.filter((x) => x.method === "sendMessage" && !String(x.payload.text).includes("Abzeichen")).at(-1)!
        .payload;
    const press = async (text: string) =>
      bot.handleUpdate(
        callbackUpdate(buttonsOf(lastMessage()).find((x) => x.text.startsWith(text))!.callback_data!),
      );

    await bot.sendMorning(date, []);
    expect(String(calls.filter((x) => x.method === "sendMessage")[0]!.payload.text)).toContain(
      "📞 Anrufe: <b>0/3</b>",
    );
    expect(String(lastMessage().text)).toContain(`📞 <b>${a.name}</b> · 1/3`);

    // a: Ja → Adresse aus dem Impressum
    await press("✅ Ja");
    expect(String(lastMessage().text)).toContain("an welche Adresse?");
    await press("📧 info@");
    expect(String(lastMessage().text)).toContain(
      `Mail an ${a.name}</b> (Einwilligung am Telefon ist vermerkt)`,
    );
    expect(String(lastMessage().text)).toContain("danke für das nette Gespräch eben!");
    const { rows } = await db().query<{ n: number }>(
      "select count(*)::int as n from interactions where company_id = $1 and meta->>'call' = 'ja'",
      [a.id],
    );
    expect(rows[0]!.n).toBe(1);

    // b: Ja → andere Adresse per Nachricht
    await bot.handleUpdate(callbackUpdate(`pl:n`));
    expect(String(lastMessage().text)).toContain(b.name);
    await press("✅ Ja");
    await press("✏️");
    expect(String(lastMessage().text)).toContain("Schreib mir die Mail-Adresse");
    await bot.handleUpdate(textUpdate("Frau Maier maier@praxis.de"));
    expect(String(lastMessage().text)).toContain("<code>maier@praxis.de</code>");
    expect(String(lastMessage().text)).toContain("Grüß Gott, Frau Maier,");
    // Keine Frage an den Manager (kein toolStep), die Nachricht war die Adresse.

    // c: nicht erreicht → später, zählt nicht als erledigt
    await bot.handleUpdate(callbackUpdate(`pl:n`));
    expect(String(lastMessage().text)).toContain(c.name);
    await press("📵");
    expect(await missedCalls(db(), c.id)).toBe(1);
    const items = await planItems(db(), date);
    expect(items.map((i) => i.status)).toEqual(["done", "done", "later"]);
  });

  it("Öffnungszeiten: aus der Suche, sonst ein Abruf nur dieses Felds; gemerkt", async () => {
    const withSearch = await lead();
    await insertPlacesSnapshot(db(), {
      companyId: withSearch.id,
      rating: 4.8,
      reviewCount: 10,
      businessStatus: "OPERATIONAL",
      photoCount: 0,
      raw: { regularOpeningHours: { weekdayDescriptions: ["Montag: 08:00–12:00", "Dienstag: 08:00–12:00"] } },
    });
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ regularOpeningHours: { weekdayDescriptions: ["Montag: 07:30–19:00"] } }),
          {
            status: 200,
          },
        ),
      ),
    );
    const hours = cachedOpeningHours({ db: db(), budget: NO_BUDGET, apiKey: "k", fetchFn });
    expect(await hours({ id: withSearch.id, place_id: "p1" })).toEqual(["Mo, Di: 08:00–12:00"]);
    expect(fetchFn).not.toHaveBeenCalled();
    const other = await lead();
    expect(await hours({ id: other.id, place_id: "p2" })).toEqual(["Mo: 07:30–19:00"]);
    expect(await hours({ id: other.id, place_id: "p2" })).toEqual(["Mo: 07:30–19:00"]);
    expect(fetchFn).toHaveBeenCalledOnce();
    const headers = (fetchFn.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1]
      .headers;
    expect(headers["X-Goog-FieldMask"]).toBe("regularOpeningHours.weekdayDescriptions");
  });
});
