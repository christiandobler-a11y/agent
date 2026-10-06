import type Anthropic from "@anthropic-ai/sdk";
import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { upsertCompany } from "../src/db/companies.js";
import { loadBranches } from "../src/pipeline/research/branches.js";
import { loadRegion } from "../src/pipeline/research/tiling.js";
import { loadScoringConfig } from "../src/pipeline/scoring/config.js";
import { NO_BUDGET } from "../src/llm/budget.js";
import type { LlmGateway, ToolStepRequest } from "../src/llm/gateway.js";
import { askManager, historyToMessages } from "../src/manager/agent.js";
import { findLead } from "../src/manager/leads.js";
import { runTool, toolDefinitions } from "../src/manager/tools.js";
import type { PipelineContext } from "../src/queue/pipeline.js";
import type { RunSummary } from "../src/queue/notifier.js";
import { createBot, telegramFetch } from "../src/telegram/bot.js";
import {
  callbackData,
  chunk,
  escapeHtml,
  markdownToTelegramHtml,
  parseCallback,
  runCompletedMessage,
} from "../src/telegram/format.js";
import { telegramNotifier } from "../src/telegram/notifier.js";
import { loadAutopilotConfig } from "../src/autopilot/plan.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const ALLOWED = 4242;
const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "Avelio",
  username: "avelio_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as UserFromGetMe;

let updateId = 1;
const textUpdate = (chatId: number, text: string): Update => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: chatId, type: "private", first_name: "X" },
    from: { id: chatId, is_bot: false, first_name: "X" },
    text,
    ...(text.startsWith("/")
      ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] }
      : {}),
  },
});
const callbackUpdate = (chatId: number, data: string): Update => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`,
    chat_instance: "x",
    from: { id: chatId, is_bot: false, first_name: "X" },
    data,
    message: { message_id: 7, date: 0, chat: { id: chatId, type: "private", first_name: "X" }, text: "alt" },
  },
});

/** Bot mit abgefangener Telegram-API: nichts verlässt den Test. */
function testBot(ctx: PipelineContext, llm: LlmGateway) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const bot = createBot({
    token: "123:test",
    allowedChatIds: [ALLOWED],
    manager: { ctx, llm },
    botInfo: BOT_INFO,
  });
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload });
    return Promise.resolve({
      ok: true,
      result:
        method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: ALLOWED, type: "private" } } : true,
    } as never);
  });
  const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
  return { bot, calls, sent };
}

function assistant(
  content: Anthropic.ContentBlock[],
  stop: Anthropic.Message["stop_reason"],
): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as Anthropic.Message;
}

describe("Formatierung", () => {
  it("escaped HTML, erlaubt nur Fett und Code", () => {
    expect(escapeHtml("<a & b>")).toBe("&lt;a &amp; b&gt;");
    expect(markdownToTelegramHtml("**Radl & Co** <script>")).toBe("<b>Radl &amp; Co</b> &lt;script&gt;");
  });

  it("teilt lange Texte an Zeilengrenzen", () => {
    const parts = chunk(
      Array.from({ length: 50 }, (_, i) => `Zeile ${i} ${"x".repeat(100)}`).join("\n"),
      1000,
    );
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join("\n").split("\n")).toHaveLength(50);
  });

  it("Buttons tragen Aktion und Firmen-ID (≤ 64 Byte)", () => {
    const id = "0b5e5a1e-1111-4222-8333-944455556666";
    const data = callbackData("sy", id);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseCallback(data)).toEqual({ action: "sy", companyId: id });
    expect(parseCallback("x:kaputt")).toBeNull();
  });

  it("Abschlussmeldung mit Top-Leads, Zahlen und vier Buttons je Lead", () => {
    const summary: RunSummary = {
      run: { id: "r", query: { term: "Fahrradladen", region: "rosenheim" }, requested_by: "cli" } as never,
      counts: { QUALIFIED: 2, SKIPPED: 5, FAILED: 1 },
      topLeads: [
        {
          companyId: "0b5e5a1e-1111-4222-8333-944455556666",
          name: "Radl <Meier>",
          city: "Bad Aibling",
          score: 87,
          segment: "WEBSITE",
          mainOpportunity: "4,8★, aber Website von 2012.",
        },
        {
          companyId: "1b5e5a1e-1111-4222-8333-944455556666",
          name: "Rad ohne Netz",
          city: null,
          score: 73,
          segment: "NO_WEBSITE",
          mainOpportunity: null,
        },
      ],
      costUsd: 0.4321,
    };
    const { text, keyboard } = runCompletedMessage(summary);
    expect(text).toContain("<b>Suche fertig: Fahrradladen in rosenheim</b>");
    expect(text).toContain(
      "8 Firmen geprüft: 2 qualifiziert, 5 aussortiert, 1 fehlgeschlagen · Kosten 0,43 $",
    );
    expect(text).toContain("<b>1. Radl &lt;Meier&gt;</b> (Bad Aibling) – <b>87</b>/100");
    expect(text).toContain("ohne Website");
    expect(keyboard).toHaveLength(2);
    expect(keyboard[0]!.map((b) => b.text)).toEqual(["1 Details", "1 Skip", "1 Kontakt", "1 Prototyp"]);
  });

  it("Notifier schreibt an den Chat, aus dem die Suche kam, sonst an alle erlaubten", async () => {
    const sendMessage = vi.fn((_id: number, _text: string) => Promise.resolve());
    const n = telegramNotifier({ sendMessage } as never, [1, 2]);
    const summary = (requestedBy: string) =>
      ({
        run: { id: "r", query: {}, requested_by: requestedBy },
        counts: {},
        topLeads: [],
        costUsd: 0,
      }) as unknown as RunSummary;
    await n.runCompleted(summary("telegram:2"));
    expect(sendMessage.mock.calls.map((c) => c[0])).toEqual([2]);
    await n.runCompleted(summary("telegram:999")); // fremde ID → nicht dorthin, sondern an alle erlaubten
    await n.budgetExceeded("Budget für heute erreicht");
    expect(sendMessage.mock.calls.map((c) => c[0])).toEqual([2, 1, 2, 1, 2]);
    expect(sendMessage.mock.calls.at(-1)![1]).toContain("/budget +5");
  });
});

describe("Telegram-Verbindung", () => {
  it("entfernt node-fetch-Optionen und protokolliert Netzwerkfehler ohne Token", async () => {
    const inner = vi.fn((_url: string | URL, _init?: RequestInit) => Promise.resolve(new Response("{}")));
    await telegramFetch(inner as unknown as typeof fetch)("https://api.telegram.org/bot123:GEHEIM/getMe", {
      method: "POST",
      agent: {},
      compress: true,
    });
    expect(inner.mock.calls[0]![1]).toEqual({ method: "POST" });

    // Signal aus grammYs Polyfill (wie im echten Betrieb) → eingebautes AbortSignal, Abbruch wird weitergereicht
    const { AbortController: PolyfillController } = await import("abort-controller");
    const polyfill = new PolyfillController();
    await telegramFetch(inner as unknown as typeof fetch)("https://api.telegram.org/x", {
      signal: polyfill.signal as unknown as AbortSignal,
    });
    const passed = inner.mock.calls[1]![1]!.signal!;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed.aborted).toBe(false);
    polyfill.abort();
    expect(passed.aborted).toBe(true);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
    await expect(
      telegramFetch(failing as unknown as typeof fetch)("https://api.telegram.org/bot123:GEHEIM/getMe"),
    ).rejects.toThrow("fetch failed");
    const line = String(warn.mock.calls.at(-1)![0]);
    expect(line).toContain("fetch failed (ECONNRESET)");
    expect(line).not.toContain("GEHEIM");
    warn.mockRestore();
  });
});

describe("Manager", () => {
  it("Verlauf → abwechselnde Rollen, beginnt mit user", () => {
    expect(
      historyToMessages([
        { direction: "OUT", text: "alt" },
        { direction: "IN", text: "a" },
        { direction: "IN", text: "b" },
        { direction: "OUT", text: "c" },
        { direction: "IN", text: null },
      ]),
    ).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c" },
    ]);
  });

  it("Werkzeuge haben gültige Schemas; ungültige Eingaben werden als Fehlertext zurückgegeben", async () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.name)).toEqual([
      "search_leads",
      "list_leads",
      "get_lead",
      "explain_score",
      "score_history",
      "skip_lead",
      "set_status",
      "add_note",
      "add_reminder",
      "pipeline",
      "stats",
      "coverage",
      "costs",
      "failed_leads",
    ]);
    for (const d of defs) expect(d.input_schema.type).toBe("object");
    expect(JSON.stringify(defs)).not.toContain("$schema");
    const r = await runTool("search_leads", { branche: "x" }, { ctx: {} as PipelineContext, chatId: 1 });
    expect(r.isError).toBe(true);
    expect((await runTool("drop_table", {}, { ctx: {} as PipelineContext, chatId: 1 })).text).toContain(
      "Unbekanntes Werkzeug",
    );
  });
});

describeDb("Telegram-Bot und Manager mit Datenbank", () => {
  const db = useTestDb();
  const ctx = () =>
    ({
      db: db(),
      bossSchema: "pgboss_none",
      budget: { ...NO_BUDGET, limits: { daily_usd: 5, monthly_usd: 50 } },
      now: () => new Date("2026-10-03T10:00:00Z"),
    }) as unknown as PipelineContext;

  async function lead(name: string) {
    const { company } = await upsertCompany(db(), {
      name,
      placeId: `p-${name}`,
      postalCode: "83022",
      city: "Rosenheim",
      websiteUrl: `https://${name.toLowerCase().replace(/\W/g, "")}.de`,
    });
    await db().query("update companies set status = 'QUALIFIED', current_score = 81 where id = $1", [
      company.id,
    ]);
    return company;
  }

  it("fremde Chats bekommen keine Antwort (Kriterium 9)", async () => {
    const toolStep = vi.fn();
    const llm = { toolStep, structured: vi.fn() } as unknown as LlmGateway;
    const { bot, calls } = testBot(ctx(), llm);
    await bot.handleUpdate(textUpdate(999, "Zeig mir alle Leads"));
    await bot.handleUpdate(textUpdate(999, "/kosten"));
    expect(calls).toEqual([]);
    expect(toolStep).not.toHaveBeenCalled();
  });

  it("Freitext → Manager-Schleife mit Werkzeug → formatierte Antwort; Verlauf gespeichert", async () => {
    await lead("Radl Sepp");
    const toolStep = vi.fn((req: ToolStepRequest) =>
      Promise.resolve({
        agentRunId: "x",
        costUsd: 0.01,
        message:
          req.messages.length === 1
            ? assistant(
                [
                  {
                    type: "tool_use",
                    id: "t1",
                    name: "list_leads",
                    input: { limit: 5 },
                    caller: { type: "direct" },
                  },
                ],
                "tool_use",
              )
            : assistant(
                [{ type: "text", text: "Top-Lead: **Radl Sepp** mit 81 Punkten.", citations: null }],
                "end_turn",
              ),
      }),
    );
    const { bot, sent, calls } = testBot(ctx(), { toolStep } as unknown as LlmGateway);
    await bot.handleUpdate(textUpdate(ALLOWED, "Zeig mir die besten Leads"));

    expect(toolStep).toHaveBeenCalledTimes(2);
    const toolResult = toolStep.mock.calls[1]![0].messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    ).find((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result")!;
    expect(toolResult.content).toContain("Radl Sepp");
    expect(calls.some((c) => c.method === "sendChatAction")).toBe(true);
    expect(sent()).toEqual(["Top-Lead: <b>Radl Sepp</b> mit 81 Punkten."]);
    const { rows } = await db().query<{ direction: string; text: string; tool_calls: unknown }>(
      "select direction, text, tool_calls from messages where chat_id = $1 order by created_at",
      [ALLOWED],
    );
    expect(rows.map((r) => r.direction)).toEqual(["IN", "OUT"]);
    expect(rows[1]!.tool_calls).toEqual([{ name: "list_leads", input: { limit: 5 }, isError: false }]);
  });

  it("Schnellbefehle ohne LLM; Buttons: Details, Skip mit Rückfrage, Phase-3-Hinweis", async () => {
    const c = await lead("Fahrrad Huber");
    const toolStep = vi.fn();
    const { bot, sent, calls } = testBot(ctx(), { toolStep } as unknown as LlmGateway);

    await bot.handleUpdate(textUpdate(ALLOWED, "/kosten"));
    expect(sent().at(-1)).toMatch(/^Heute 0\.00 \$ von 5 \$/);
    await bot.handleUpdate(textUpdate(ALLOWED, "/start"));
    expect(sent().at(-1)).toContain("Such mir 20 Fahrradläden");
    expect(sent().at(-1)).toContain("/abdeckung");

    await bot.handleUpdate(callbackUpdate(ALLOWED, callbackData("d", c.id)));
    expect(sent().at(-1)).toContain("Fahrrad Huber: noch nicht bewertet");

    await bot.handleUpdate(callbackUpdate(ALLOWED, callbackData("s", c.id)));
    expect(sent().at(-1)).toBe("Fahrrad Huber wirklich aussortieren?");
    await bot.handleUpdate(callbackUpdate(ALLOWED, callbackData("sy", c.id)));
    const { rows } = await db().query(
      "select status, skip_reason, skip_detail from companies where id = $1",
      [c.id],
    );
    expect(rows[0]).toEqual({
      status: "SKIPPED",
      skip_reason: "manual",
      skip_detail: "Manuell: per Button in Telegram",
    });

    await bot.handleUpdate(callbackUpdate(ALLOWED, callbackData("p", c.id)));
    const alert = calls.filter((x) => x.method === "answerCallbackQuery").at(-1)!.payload;
    expect(alert).toMatchObject({ text: "Prototypen kommen in Phase 3", show_alert: true });
    expect(toolStep).not.toHaveBeenCalled();
  });

  it("/budget +5 erhöht das Tagesbudget und gibt wartende Jobs frei", async () => {
    await db().query(`create schema if not exists pgboss_none`);
    await db().query(
      `create table if not exists pgboss_none.job (state text, singleton_key text, start_after timestamptz)`,
    );
    await db().query(
      `insert into pgboss_none.job values ('created', 'abc:budget:2026-10-04', now() + interval '1 day')`,
    );
    const { bot, sent } = testBot(ctx(), {} as LlmGateway);
    await bot.handleUpdate(textUpdate(ALLOWED, "/budget +5"));
    expect(sent().at(-1)).toBe(
      "Okay, heute 5,00 $ zusätzlich freigegeben. 1 wartende Jobs laufen jetzt weiter.",
    );
    const { rows } = await db().query<{ value: { usd: number } }>(
      "select value from app_state where key = 'budget_extra:2026-10-03'",
    );
    expect(rows[0]!.value.usd).toBe(5);
    await db().query("drop schema pgboss_none cascade");
  });

  it("Budget erschöpft: Manager antwortet mit Hinweis statt Fehler", async () => {
    const { BudgetExceededError } = await import("../src/llm/budget.js");
    const llm = {
      toolStep: () => Promise.reject(new BudgetExceededError("Tag", 5.1, 5)),
    } as unknown as LlmGateway;
    const reply = await askManager({ ctx: ctx(), llm }, ALLOWED, "Hallo");
    expect(reply.text).toContain("Budget für heute erreicht");
  });

  it("Kalibrierung: /kalibrieren zeigt Firmen ohne Score, A/B/C speichert und zeigt die nächste", async () => {
    const scored = async (name: string) => {
      const { company } = await upsertCompany(db(), { name, placeId: `k-${name}`, city: "Kolbermoor" });
      await db().query("update companies set segment = 'NO_WEBSITE', branch_key = 'gastro' where id = $1", [
        company.id,
      ]);
      await db().query(
        `insert into places_snapshots (company_id, raw, rating, review_count, business_status)
         values ($1, '{}', 4.6, 80, 'OPERATIONAL')`,
        [company.id],
      );
      const { rows } = await db().query<{ id: string }>(
        `insert into lead_scores (company_id, scoring_version, total, breakdown) values ($1, 'v1', 70, '{}') returning id`,
        [company.id],
      );
      await db().query("update companies set current_score_id = $2, current_score = 70 where id = $1", [
        company.id,
        rows[0]!.id,
      ]);
      return company;
    };
    await scored("Gasthaus <Post>");
    await scored("Café Mühle");
    const pctx = {
      ...ctx(),
      lead: { branches: loadBranches(), scoring: loadScoringConfig(), crawl: {}, recheck: {}, llm: {} },
    } as unknown as PipelineContext;
    const toolStep = vi.fn();
    const { bot, sent, calls } = testBot(pctx, { toolStep } as unknown as LlmGateway);
    const lastCard = () => {
      const msg = calls.filter((c) => c.method === "sendMessage").at(-1)!.payload;
      const kb = (msg.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
      return { text: String(msg.text), ids: kb[0]!.map((b) => b.callback_data) };
    };

    await bot.handleUpdate(textUpdate(ALLOWED, "/kalibrieren alle"));
    const first = lastCard();
    expect(first.text).toContain("Kalibrierung · 0 bewertet");
    expect(first.text).toContain("Restaurant, Gasthaus, Café · Kolbermoor");
    expect(first.text).toContain("Google: 4,6★ (80 Bewertungen)");
    expect(first.text).not.toContain("70"); // kein Score auf der Karte
    expect(first.ids.map((d) => d.slice(0, 2))).toEqual(["gA", "gB", "gC", "gX"]);

    await bot.handleUpdate(callbackUpdate(ALLOWED, first.ids[0]!));
    expect(calls.filter((c) => c.method === "answerCallbackQuery").at(-1)!.payload).toMatchObject({
      text: "A gespeichert",
    });
    const second = lastCard();
    expect(second.text).toContain("1 bewertet (A 1 · B 0 · C 0)");
    expect(second.ids[0]).not.toBe(first.ids[0]);

    await bot.handleUpdate(callbackUpdate(ALLOWED, second.ids[2]!));
    expect(sent().at(-1)).toContain("Keine unbewertete Firma");
    const { rows } = await db().query<{ grade: string }>(
      "select grade from calibration_ratings order by grade",
    );
    expect(rows.map((r) => r.grade)).toEqual(["A", "C"]);

    await bot.handleUpdate(textUpdate(ALLOWED, "/auswertung"));
    expect(sent().at(-1)).toContain("Golden Set: 2 Firmen");
    expect(sent().at(-1)).toContain("noch nicht bestanden");
    expect(toolStep).not.toHaveBeenCalled();
  });

  it("Kalibrierung: standardmäßig nur die Branchen der Nachtsuche, Vorbild merken mit Notiz, /vorbilder", async () => {
    // Fokus-Branche aus config/autopilot.yaml → suche.branchen (06.10.2026: Fahrrad statt Physio).
    const focus = loadAutopilotConfig().suche.branchen[0]!;
    const scored = async (name: string, branch: string) => {
      const { company } = await upsertCompany(db(), {
        name,
        placeId: `v-${name}`,
        city: "Weilheim",
        websiteUrl: `https://${name.toLowerCase().replace(/\W/g, "")}.de/`,
      });
      await db().query("update companies set branch_key = $2 where id = $1", [company.id, branch]);
      const { rows } = await db().query<{ id: string }>(
        `insert into lead_scores (company_id, scoring_version, total, breakdown) values ($1, 'v1', 70, '{}') returning id`,
        [company.id],
      );
      await db().query("update companies set current_score_id = $2 where id = $1", [company.id, rows[0]!.id]);
      return company;
    };
    const physio = await scored("Physio Vorbild", focus);
    await scored("Gasthaus Andere", "gastro");
    const pctx = {
      ...ctx(),
      lead: { branches: loadBranches(), scoring: loadScoringConfig(), crawl: {}, recheck: {}, llm: {} },
    } as unknown as PipelineContext;
    const toolStep = vi.fn();
    const { bot, sent, calls } = testBot(pctx, { toolStep } as unknown as LlmGateway);
    const keyboard = () =>
      (
        calls.filter((c) => c.method === "sendMessage").at(-1)!.payload.reply_markup as {
          inline_keyboard: { callback_data: string }[][];
        }
      ).inline_keyboard;

    await bot.handleUpdate(textUpdate(ALLOWED, "/kalibrieren"));
    expect(sent().at(-1)).toContain("Physio Vorbild");
    expect(keyboard()[1]![0]).toMatchObject({ text: "🌐 Website ansehen" });
    const inspo = keyboard()[1]![1]!.callback_data;
    expect(inspo).toBe(`iv:${physio.id}`);
    await bot.handleUpdate(callbackUpdate(ALLOWED, inspo));
    expect(sent().at(-1)).toContain("Was gefällt dir an der Seite?");
    await bot.handleUpdate(textUpdate(ALLOWED, "Übergänge zwischen den Abschnitten & Team-Fotos"));
    expect(sent().at(-1)).toContain("Gemerkt");
    const { rows } = await db().query<{ branch_key: string; url: string; note: string }>(
      "select branch_key, url, note from design_notes",
    );
    expect(rows).toEqual([
      {
        branch_key: focus,
        url: "https://physiovorbild.de/",
        note: "Übergänge zwischen den Abschnitten & Team-Fotos",
      },
    ]);
    // Danach geht Text wieder an den Manager, nicht noch einmal in die Notizen.
    await bot.handleUpdate(callbackUpdate(ALLOWED, `gA:${physio.id}`));
    expect(sent().at(-1)).toContain("Keine unbewertete Firma"); // Gastro ist nicht dran
    await bot.handleUpdate(textUpdate(ALLOWED, "/vorbilder"));
    expect(sent().at(-1)).toContain("Physio Vorbild");
    expect(sent().at(-1)).toContain("Übergänge zwischen den Abschnitten &amp; Team-Fotos");
    expect(toolStep).not.toHaveBeenCalled();
  });

  it("/abdeckung zeigt je Region, was vollständig ist und was nie gesucht wurde (ohne LLM)", async () => {
    const pctx = {
      ...ctx(),
      loadRegion: (key: string) => loadRegion(key),
      research: { branches: loadBranches(), config: { coverage_valid_days: 180 } },
    } as unknown as PipelineContext;
    const toolStep = vi.fn();
    const { bot, sent } = testBot(pctx, { toolStep } as unknown as LlmGateway);
    await bot.handleUpdate(textUpdate(ALLOWED, "/abdeckung rosenheim"));
    expect(sent().at(-1)).toMatch(/^Landkreis Rosenheim \(\d+ Orte\):/);
    expect(sent().at(-1)).toContain("○ Noch nie gesucht:");
    expect(toolStep).not.toHaveBeenCalled();
  });

  it("findLead: Kurz-ID, Domain, Namensteil, mehrdeutig", async () => {
    const a = await lead("Radhaus Alpha");
    await lead("Radhaus Beta");
    expect(await findLead(db(), a.id.slice(0, 8))).toMatchObject({ kind: "found", company: { id: a.id } });
    expect(await findLead(db(), "radhausalpha.de")).toMatchObject({ kind: "found", company: { id: a.id } });
    expect(await findLead(db(), "Alpha")).toMatchObject({ kind: "found", company: { id: a.id } });
    expect((await findLead(db(), "Radhaus")).kind).toBe("ambiguous");
    expect((await findLead(db(), "gibtsnicht")).kind).toBe("none");
  });
});
