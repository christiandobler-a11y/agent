import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update, UserFromGetMe } from "grammy/types";
import { chromium } from "playwright";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { upsertCompany } from "../src/db/companies.js";
import { insertWebsiteSnapshot } from "../src/db/websiteSnapshots.js";
import type { LlmGateway } from "../src/llm/gateway.js";
import { loadOutreachConfig } from "../src/outreach/config.js";
import { normalizeMarks, pickLetterFindings, upperFirst } from "../src/outreach/letter.js";
import { handEllipse, normalizeBox, renderLetterHtml, type LetterPage } from "../src/outreach/letterPage.js";
import { chromiumLetterRenderer } from "../src/outreach/letterPdf.js";
import type { Finding } from "../src/pipeline/audit/schema.js";
import type { PipelineContext } from "../src/queue/pipeline.js";
import { createBot } from "../src/telegram/bot.js";
import { crmCallback, parseCrmCallback } from "../src/telegram/format.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const finding = (title: string, category: Finding["category"], severity: Finding["severity"] = "medium") => ({
  title,
  detail: "d",
  evidence: "e",
  severity,
  category,
});

const page = (over: Partial<LetterPage> = {}): LetterPage => ({
  dateLine: "Peißenberg, 3. Oktober 2026",
  greeting: "Hallo Herr Ernst,",
  image: { dataUri: "data:image/jpeg;base64,AAAA", width: 1440, height: 900 },
  caption: "Ihre Startseite am Rechner, Stand 3.10.2026",
  marks: [
    { n: 1, box: { x: 10, y: 20, w: 30, h: 10 }, note: "Name <abgeschnitten>" },
    { n: 2, box: null, note: "Lädt lange" },
  ],
  lines: "Ihre Seite ist mir aufgefallen.",
  closing: "Viele Grüße",
  signature: "Christian",
  qr: { svg: "<svg id='qr'></svg>", text: "Kurz scannen" },
  phoneLine: "Oder einfach kurz anrufen.\n0151 1",
  footer: "Christian Dobler · Avelio, Peißenberg",
  fontDataUri: null,
  seed: 42,
  ...over,
});

describe("Befund-Seite (rein)", () => {
  it("Markierungen: in den Bildbereich ziehen, zu große Bereiche und Unsinn verwerfen", () => {
    expect(normalizeBox({ x: 95, y: -5, w: 30, h: 1 })).toEqual({ x: 95, y: 0, w: 5, h: 3 });
    expect(normalizeBox({ x: 0, y: 0, w: 100, h: 8 })).toBeNull(); // ganze Menüleiste
    expect(normalizeBox({ x: 0, y: 10, w: 60, h: 70 })).toBeNull(); // halber Bildschirm
    expect(normalizeBox({ x: Number.NaN, y: 0, w: 10, h: 10 })).toBeNull();
    expect(normalizeBox(null)).toBeNull();
  });

  it("LLM-Markierungen: gültige Befunde, je einer, Bild-Markierungen zuerst nummeriert", () => {
    const marks = normalizeMarks(
      [
        { befund: 2, box: null, notiz: "Lädt ewig." },
        { befund: 1, box: { x: 1, y: 1, w: 10, h: 10 }, notiz: "Name – abgeschnitten" },
        { befund: 1, box: null, notiz: "doppelt" },
        { befund: 7, box: null, notiz: "gibt es nicht" },
      ],
      2,
    );
    expect(marks.map((m) => [m.n, m.note, Boolean(m.box)])).toEqual([
      [1, "Name, abgeschnitten", true],
      [2, "Lädt ewig", false],
    ]);
  });

  it("Befunde für den Brief: sichtbare vor Handy und Technik", () => {
    const picked = pickLetterFindings([
      finding("Handy langsam", "mobile", "high"),
      finding("Kein Knopf", "conversion"),
      finding("Altbacken", "design"),
      finding("Kein HTTPS", "technical", "high"),
    ]);
    expect(picked.map((f) => f.title)).toEqual(["Altbacken", "Kein Knopf"]);
    // Gibt es weniger als zwei sichtbare, wird aufgefüllt.
    expect(
      pickLetterFindings([finding("Handy langsam", "mobile", "high"), finding("Altbacken", "design")]).map(
        (f) => f.title,
      ),
    ).toEqual(["Altbacken", "Handy langsam"]);
    expect(upperFirst("ihre Seite")).toBe("Ihre Seite");
  });

  it("HTML: Kreise nur für Markierungen mit Stelle, Notizen nummeriert, Text escaped", () => {
    const html = renderLetterHtml(page());
    expect(html.match(/<path d="M/g)).toHaveLength(1);
    expect(html).toContain("Name &lt;abgeschnitten&gt;");
    expect(html).toContain('<span class="n">2</span><span>Lädt lange</span>');
    expect(html).toContain("Oder einfach kurz anrufen.<br>0151 1");
    expect(html).toContain("<svg id='qr'></svg>");
    expect(html).not.toMatch(/[–—]/);
    expect(handEllipse(100, 100, 50, 20, 1)).toBe(handEllipse(100, 100, 50, 20, 1));
    expect(handEllipse(100, 100, 50, 20, 1)).not.toBe(handEllipse(100, 100, 50, 20, 2));
  });

  it("Callback für die Befund-Seite", () => {
    const id = "0b9a3f0e-1111-4222-8333-444455556666";
    expect(parseCrmCallback(crmCallback({ kind: "letter", companyId: id }))).toEqual({
      kind: "letter",
      companyId: id,
    });
  });
});

/** Echtes PDF mit Chromium (ohne Browser übersprungen, in der CI Pflicht wie bei den Crawl-Tests). */
const executablePath = process.env.CHROMIUM_PATH;
const browserAvailable = existsSync(executablePath ?? chromium.executablePath());
describe.skipIf(!browserAvailable)("Befund-Seite als PDF", () => {
  it("druckt eine A4-Seite und eine Vorschau", async () => {
    const jpg = await sharp({ create: { width: 144, height: 90, channels: 3, background: "#ddeeff" } })
      .jpeg()
      .toBuffer();
    const html = renderLetterHtml(
      page({
        image: { dataUri: `data:image/jpeg;base64,${jpg.toString("base64")}`, width: 144, height: 90 },
      }),
    );
    const out = await chromiumLetterRenderer(executablePath)(html);
    expect(out.pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect((out.pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);
    const meta = await sharp(out.png).metadata();
    expect(meta.width).toBe(794 * 2);
  }, 60_000);
});

const ALLOWED = 4242;
const BOT_INFO = { id: 1, is_bot: true, first_name: "Avelio", username: "avelio_test_bot" } as UserFromGetMe;
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

describeDb("Befund-Seite mit Datenbank", () => {
  const db = useTestDb();
  const NOW = new Date("2026-10-03T10:00:00Z");

  it("Telegram: Vorschau mit Umschlag, PDF mit Buttons, Neu erstellen gibt den alten Text mit", async () => {
    const { company: c } = await upsertCompany(db(), {
      name: "Malerei Brief GmbH",
      placeId: "letter-1",
      city: "Raubling",
    });
    await db().query(
      "update companies set status = 'QUALIFIED', street = 'Föhrenweg 9', postal_code = '83064' where id = $1",
      [c.id],
    );
    const dir = mkdtempSync(join(tmpdir(), "avelio-letter-"));
    const shot = join(dir, "desktop.jpg");
    await sharp({ create: { width: 1440, height: 2000, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toFile(shot);
    await insertWebsiteSnapshot(db(), {
      companyId: c.id,
      url: "https://malerei.example",
      screenshotDesktop: shot,
      screenshotMobile: shot,
    });
    await db().query(
      `insert into audits (company_id, prompt_version, model, findings, rubric, commercial, summary)
       values ($1, 'v1', 'm', $2, '{}', '{}', 's')`,
      [c.id, JSON.stringify([finding("Schriftzug abgeschnitten", "design", "high"), finding("x", "mobile")])],
    );
    await db().query(
      `insert into contacts (company_id, name, salutation, email, source) values ($1, 'Kai Ernst', 'Herr', 'k@x.de', 'impressum')`,
      [c.id],
    );

    const structured = vi.fn(() =>
      Promise.resolve({
        output: {
          markierungen: [{ befund: 1, box: { x: 5, y: 20, w: 40, h: 12 }, notiz: "Maler fehlt" }],
          zeilen: "ihre Seite ist mir aufgefallen, 5,0 Sterne sprechen für sich.",
          popup_im_bild: true,
        },
        agentRunId: "r",
        costUsd: 0.01,
        model: "m",
      }),
    );
    const render = vi.fn((html: string) =>
      Promise.resolve({ pdf: Buffer.from(`%PDF ${html.length}`), png: Buffer.from("png") }),
    );
    const pctx = {
      db: db(),
      now: () => NOW,
      crm: { follow_up_days: 5, quiet_hours: { from: "21:00", to: "08:00" } },
      lead: { branches: {} },
      crawl: { config: { desktop: { width: 1440, height: 900, scale: 1 } } },
    } as unknown as PipelineContext;
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const bot = createBot({
      token: "123:test",
      allowedChatIds: [ALLOWED],
      manager: { ctx: pctx, llm: { structured, toolStep: vi.fn() } as unknown as LlmGateway },
      botInfo: BOT_INFO,
      outreach: {
        config: loadOutreachConfig(),
        contact: { whatsapp: "+49 151 1", phone: "0151 1" },
        renderLetter: render,
      },
    });
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload });
      return Promise.resolve({
        ok: true,
        result: method.startsWith("send")
          ? { message_id: 1, date: 0, chat: { id: ALLOWED, type: "private" } }
          : true,
      } as never);
    });

    await bot.handleUpdate(callbackUpdate(crmCallback({ kind: "letter", companyId: c.id })));
    const photo = calls.find((x) => x.method === "sendPhoto")!.payload;
    const caption = String(photo.caption);
    expect(caption).toContain("🖨️ <b>Befund-Seite für Malerei Brief GmbH</b>");
    expect(caption).toContain("<pre>Kai Ernst\nMalerei Brief GmbH\nFöhrenweg 9\n83064 Raubling</pre>");
    expect(caption).toContain("1. Maler fehlt");
    expect(caption).toContain("Cookie-Hinweis");
    const doc = calls.find((x) => x.method === "sendDocument")!.payload;
    const buttons = (
      doc.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(["📮 Verschickt, kontaktiert", "🔄 Neu erstellen"]);

    const html = render.mock.calls[0]![0];
    expect(html).toContain("Grüß Gott, Herr Ernst,");
    expect(html).toContain("Ihre Seite ist mir aufgefallen"); // groß, steht für sich
    expect(html).toContain("<svg"); // QR-Code und Markierung
    const input = (structured.mock.calls as unknown as [{ role: string; input: unknown[] }][])[0]![0];
    expect(input.role).toBe("letter");
    expect(JSON.stringify(input.input)).toContain('"type":"image"');

    await bot.handleUpdate(callbackUpdate(buttons[1]!.callback_data));
    const second = JSON.stringify(
      (structured.mock.calls as unknown as [{ input: unknown[] }][])[1]![0].input,
    );
    expect(second).toContain("vorheriger_text");
    expect(String(calls.filter((x) => x.method === "sendPhoto").at(-1)!.payload.caption)).toContain(
      "(Variante 2)",
    );
    const { rows } = await db().query<{ channel: string; n: number }>(
      "select channel, count(*)::int as n from interactions where company_id = $1 and type = 'draft' group by channel",
      [c.id],
    );
    expect(rows).toEqual([{ channel: "letter", n: 2 }]);
  });
});
