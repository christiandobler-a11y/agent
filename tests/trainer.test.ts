import { describe, expect, it, vi } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Update, UserFromGetMe } from "grammy/types";
import { gameStats, loadGameConfig } from "../src/game/xp.js";
import { loadModelsConfig, loadPrompt } from "../src/llm/config.js";
import type { LlmGateway } from "../src/llm/gateway.js";
import { loadMailConfig } from "../src/outreach/mail.js";
import { loadOutreachConfig } from "../src/outreach/config.js";
import type { PipelineContext } from "../src/queue/pipeline.js";
import { createBot } from "../src/telegram/bot.js";
import {
  moodEmoji,
  parseTrainerCallback,
  resultText,
  scenarioList,
  trainerCallback,
} from "../src/telegram/trainer.js";
import {
  averageScore,
  coachSchema,
  loadTrainerConfig,
  openSession,
  ownerReplySchema,
  pickScenario,
  xpFor,
  type CoachFeedback,
} from "../src/trainer/session.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const config = loadTrainerConfig();
const feedback = (p: number): CoachFeedback => ({
  zuhoeren: { punkte: p, satz: "Hat nachgefragt." },
  nutzen: { punkte: p, satz: "In Rädern gerechnet." },
  ruhe: { punkte: p, satz: "Ruhig <geblieben>." },
  abschluss: { punkte: p, satz: "Termin am Dienstag." },
  gut: "Preis gehalten.",
  besser: "Früher nach dem Termin fragen.",
  beispiel: "Passt Ihnen Dienstag um zehn?",
});

describe("Sales-Trainer (rein)", () => {
  it("Konfiguration, Prompts, Rollen und Schemas", () => {
    expect(Object.keys(config.szenarien).length).toBeGreaterThanOrEqual(10);
    for (const key of Object.keys(config.szenarien)) expect(key).toMatch(/^[a-z0-9_]{1,40}$/);
    expect(loadModelsConfig().roles.trainer).toBeDefined();
    expect(loadModelsConfig().roles.trainer_coach).toBeDefined();
    expect(loadPrompt("trainer", "v1")).toContain("Bleib immer in deiner Rolle");
    expect(loadPrompt("trainer_coach", "v1")).toContain("`abschluss`");
    expect(zodOutputFormat(ownerReplySchema).type).toBe("json_schema");
    expect(zodOutputFormat(coachSchema).type).toBe("json_schema");
    // Abzeichen im Spiel vorhanden
    expect(Object.keys(loadGameConfig().abzeichen)).toEqual(
      expect.arrayContaining(["erstes_training", "training_10", "einwand_profi"]),
    );
  });

  it("Szenario: erst ungespielte, dann das schwächste", () => {
    const c = {
      ...config,
      szenarien: { a: config.szenarien.preis!, b: config.szenarien.neffe!, c: config.szenarien.kamera! },
    };
    expect(pickScenario(c, [{ scenario: "a", best: 3, plays: 1 }], () => 0)).toBe("b");
    expect(pickScenario(c, [{ scenario: "a", best: 3, plays: 1 }], () => 0.99)).toBe("c");
    const all = [
      { scenario: "a", best: 4.5, plays: 1 },
      { scenario: "b", best: 2.5, plays: 3 },
      { scenario: "c", best: 2.5, plays: 1 },
    ];
    expect(pickScenario(c, all, () => 0)).toBe("c");
  });

  it("XP: anteilig zur Punktzahl, Ja-Bonus, Tipp-Abzug, mindestens 1", () => {
    const c = { ...config, xp: { basis: { 1: 10, 2: 15, 3: 20 }, ja_bonus: 5, tipp: 3 } };
    expect(xpFor(c, 3, 5, "ja", 0)).toBe(25);
    expect(xpFor(c, 2, 3, "offen", 0)).toBe(9);
    expect(xpFor(c, 2, 3, "offen", 1)).toBe(6);
    expect(xpFor(c, 1, 1, "nein", 5)).toBe(1);
    expect(averageScore({ ...feedback(4), abschluss: { punkte: 2, satz: "x" } })).toBe(3.5);
  });

  it("Knöpfe hin und zurück; Ergebnis escaped", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    for (const c of [
      { kind: "hint" as const, id },
      { kind: "quit" as const, id },
      { kind: "again" as const, scenario: "mundpropaganda" },
      { kind: "next" as const },
    ]) {
      expect(trainerCallback(c).length).toBeLessThanOrEqual(64);
      expect(parseTrainerCallback(trainerCallback(c))).toEqual(c);
    }
    expect(parseTrainerCallback("tr:r:Böse!")).toBeNull();
    expect(moodEmoji(-5)).toBe("😠");
    expect(moodEmoji(2)).toBe("😄");
    const text = resultText(config.szenarien.preis!, {
      decision: "ja",
      feedback: feedback(4),
      score: 4,
      xp: 17,
    });
    expect(text).toContain("Sepp Huber ist dabei!");
    expect(text).toContain("+17 XP");
    expect(text).toContain("Ruhig &lt;geblieben&gt;.");
    expect(text).toContain("★★★★☆ <b>Zuhören</b>");
    const list = scenarioList(config, [{ scenario: "preis", best: 4.5, plays: 2 }]);
    expect(list).toContain("🧠 bestes 4,5 (2×)");
    expect(list).toContain("<code>/training neffe</code>");
  });
});

const ALLOWED = 4255;
let updateId = 1;
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

describeDb("Sales-Trainer", () => {
  const db = useTestDb();

  function setup(decisions: ("offen" | "ja" | "nein")[]) {
    let owner = 0;
    const structured = vi.fn((req: { role: string; input: string }) => {
      if (req.role === "trainer") {
        const d = owner === 0 ? "offen" : (decisions[owner - 1] ?? "offen");
        owner++;
        return Promise.resolve({
          output: { antwort: `Antwort ${owner}`, stimmung: owner === 1 ? -1 : 1, entscheidung: d },
          agentRunId: "r",
          costUsd: 0.001,
          model: "m",
        });
      }
      return Promise.resolve({ output: feedback(4), agentRunId: "r", costUsd: 0.01, model: "m" });
    });
    const toolStep = vi.fn();
    const llm = { structured, toolStep, research: vi.fn() } as unknown as LlmGateway;
    let now = new Date("2026-10-09T10:00:00Z");
    const pipeline = {
      db: db(),
      now: () => now,
      crm: { follow_up_days: 5, quiet_hours: { start: "21:00", end: "08:00" } },
      lead: { branches: {} },
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
    const texts = () =>
      calls.filter((x) => x.method === "sendMessage").map((x) => (x.payload.text as string) ?? "");
    const lastButtons = () => {
      const p = calls.filter((x) => x.method === "sendMessage" && x.payload.reply_markup).at(-1)!.payload;
      return (
        p.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }
      ).inline_keyboard.flat();
    };
    return {
      bot,
      structured,
      toolStep,
      texts,
      lastButtons,
      setNow: (d: Date) => (now = d),
    };
  }

  it("Gespräch bis zur Bewertung: Antworten gehen an den Inhaber, nicht an den Chat; XP ins Spiel", async () => {
    const t = setup(["offen", "offen", "offen", "offen"]);
    await t.bot.handleUpdate(textUpdate("/training preis"));
    expect(t.texts().join("\n")).toContain("Training: „Was kostet der Spaß?“");
    expect(t.texts().at(-1)).toContain("Antwort 1");
    expect(t.texts().at(-1)).toContain("Deine Antwort 1/4");

    // Tipp kostet XP
    const hint = t.lastButtons().find((b) => b.text.startsWith("💡"))!.callback_data!;
    await t.bot.handleUpdate(callbackUpdate(hint));
    expect(t.texts().at(-1)).toContain("Preis ruhig nennen");

    for (let i = 1; i <= 3; i++) {
      await t.bot.handleUpdate(textUpdate(`Meine Antwort ${i}`));
      expect(t.texts().at(-1)).toContain(`Deine Antwort ${i + 1}/4`);
    }
    await t.bot.handleUpdate(textUpdate("Passt Ihnen Dienstag um zehn?"));
    expect(t.toolStep).not.toHaveBeenCalled(); // nichts ging an den Manager
    const result = t.texts().find((x) => x.includes("Schnitt"))!;
    expect(result).toContain("Noch offen.");
    expect(result).toContain("+9 XP"); // Schwierigkeit 2: 15 × 4/5 = 12, minus 3 für den Tipp
    // Der Coach hat den ganzen Verlauf mit Angebot gesehen
    const coachReq = t.structured.mock.calls.find((c) => c[0].role === "trainer_coach")![0];
    expect(coachReq.input).toContain("990");
    expect(coachReq.input).toContain("Christian: Passt Ihnen Dienstag um zehn?");

    const { rows } = await db().query<{ status: string; xp: number; hints: number; score: string }>(
      "select status, xp, hints, score from training_sessions",
    );
    expect(rows[0]).toMatchObject({ status: "fertig", xp: 9, hints: 1, score: "4.00" });
    const stats = await gameStats(db(), new Date("2026-10-09T11:00:00Z"));
    expect(stats).toMatchObject({ trainings: 1, trainingXp: 9, mastered: 1 });
    expect(t.texts().join("\n")).toContain("Erste Runde"); // Abzeichen gefeiert

    // Danach geht Text wieder an den Manager
    t.toolStep.mockResolvedValue({
      message: { role: "assistant", content: [{ type: "text", text: "Hallo" }], stop_reason: "end_turn" },
      agentRunId: "r",
      costUsd: 0,
    });
    await t.bot.handleUpdate(textUpdate("Wie viele Leads?"));
    expect(t.toolStep).toHaveBeenCalled();
  });

  it("Ja des Inhabers beendet früher und gibt Bonus; Aufgeben ohne XP; offene Gespräche verfallen", async () => {
    const t = setup(["ja"]);
    await t.bot.handleUpdate(textUpdate("/training keine_zeit"));
    await t.bot.handleUpdate(textUpdate("Darf ich Dienstag um 9 vorbeikommen?"));
    const result = t.texts().find((x) => x.includes("Schnitt"))!;
    expect(result).toContain("ist dabei!");
    expect(result).toContain("+13 XP"); // 10 × 4/5 + 5

    // Nächster Einwand über den Knopf, dann aufgeben
    const next = t.lastButtons().find((b) => b.text.includes("Nächster"))!.callback_data!;
    await t.bot.handleUpdate(callbackUpdate(next));
    const quit = t.lastButtons().find((b) => b.text.includes("Aufgeben"))!.callback_data!;
    await t.bot.handleUpdate(callbackUpdate(quit));
    expect(t.texts().at(-1)).toContain("Abgebrochen, ohne XP");
    const { rows } = await db().query<{ status: string; xp: number }>(
      "select status, xp from training_sessions order by created_at",
    );
    expect(rows.map((r) => r.status).slice(-2)).toEqual(["fertig", "abgebrochen"]); // Datenbank gilt je Datei

    // Verfall: ein altes offenes Gespräch zählt nicht mehr
    await t.bot.handleUpdate(textUpdate("/training neffe"));
    expect(await openSession(db(), ALLOWED, new Date("2026-10-09T10:30:00Z"), config)).not.toBeNull();
    expect(await openSession(db(), ALLOWED, new Date("2026-10-09T13:00:00Z"), config)).toBeNull();
  });

  it("/training liste und unbekannter Einwand", async () => {
    const t = setup([]);
    await t.bot.handleUpdate(textUpdate("/training liste"));
    expect(t.texts().at(-1)).toContain("Einwände zum Üben");
    await t.bot.handleUpdate(textUpdate("/training quatsch"));
    expect(t.texts().at(-1)).toContain("kenne ich nicht");
    expect(t.structured).not.toHaveBeenCalled();
  });
});
