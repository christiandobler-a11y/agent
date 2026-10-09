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
import {
  coachTick,
  criterionAverages,
  invitationMessage,
  nextTopic,
  tipMessage,
  tipSchema,
  weakest,
  weeklyMessage,
} from "../src/trainer/coach.js";
import {
  checkGap,
  checkRecall,
  fullSentence,
  gapAnswers,
  loadPhrases,
  normalize,
  pickPhrases,
  withGap,
} from "../src/trainer/phrases.js";
import { hintSchema } from "../src/trainer/session.js";
import { drillPrompt, phraseList } from "../src/telegram/trainer.js";
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
    const c = { ...config, xp: { ...config.xp, basis: { 1: 10, 2: 15, 3: 20 }, ja_bonus: 5, tipp: 3 } };
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
    const structured = vi.fn((req: { role: string; input: string; promptVersion: string }) => {
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
      if (req.role === "trainer_hint")
        return Promise.resolve({
          output: { hinweis: "Frag nach, was ihn wirklich stört.", satz: "Zu teuer im Vergleich wozu?" },
          agentRunId: "r",
          costUsd: 0.001,
          model: "m",
        });
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
    expect(t.texts().at(-1)).toContain("Frag nach, was ihn wirklich stört.");
    expect(t.texts().at(-1)).toContain("„Zu teuer im Vergleich wozu?“");
    const hintReq = t.structured.mock.calls.find((c) => c[0].role === "trainer_hint")![0];
    expect(hintReq.input).toContain("<saetze>");
    expect(hintReq.input).toContain("Zu teuer im Vergleich wozu?");

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
    expect(coachReq.promptVersion).toBe("v2");
    const ownerReq = t.structured.mock.calls.find((c) => c[0].role === "trainer")![0];
    expect(ownerReq.input).toContain("<neue_seite>Die neue Seite ist für genau diesen Laden gebaut");
    expect(t.texts().join("\n")).toContain("Handlungen in eckige Klammern");
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

describe("Trainer meldet sich (rein)", () => {
  it("Schnitt je Punkt, schwächster und stärkster, Themen-Reihenfolge", () => {
    const avg = criterionAverages([feedback(4), { ...feedback(4), abschluss: { punkte: 2, satz: "x" } }])!;
    expect(avg).toEqual({ zuhoeren: 4, nutzen: 4, ruhe: 4, abschluss: 3 });
    expect(weakest(avg)).toBe("abschluss");
    expect(criterionAverages([])).toBeNull();
    expect(nextTopic(["a", "b", "c"], ["a"])).toBe("b");
    expect(nextTopic(["a", "b"], ["b", "a"])).toBe("a"); // a liegt am längsten zurück
    expect(nextTopic([], [])).toBeNull();
    expect(config.themen.length).toBeGreaterThanOrEqual(10);
    expect(loadModelsConfig().roles.trainer_tip).toBeDefined();
    expect(loadPrompt("trainer_tip", "v1")).toContain("Keine erfundenen Zahlen");
    expect(zodOutputFormat(tipSchema).type).toBe("json_schema");
  });

  it("Häppchen mit Übungs-Knopf, escaped; unbekanntes Szenario → zufällige Runde", () => {
    const tip = {
      aufhaenger: "Hmm … die beste Einwandbehandlung ist die, die du nicht brauchst.",
      erklaerung: "Sprich den Preis <selbst> an.",
      so_klingts: "Ich sag Ihnen gleich, was es kostet.",
      uebung: "Sag den Preis heute laut vor dem Spiegel.",
      szenario: "preis",
    };
    const m = tipMessage(tip, config);
    expect(m.text).toContain("🧠 <b>Hmm …");
    expect(m.text).toContain("&lt;selbst&gt;");
    expect(m.buttons[0]!.callback_data).toBe("tr:r:preis");
    expect(parseTrainerCallback(m.buttons[0]!.callback_data)).toEqual({ kind: "again", scenario: "preis" });
    expect(tipMessage({ ...tip, szenario: "keins" }, config).buttons[0]!.callback_data).toBe("tr:n");
    const inv = invitationMessage(config, "neffe", 3);
    expect(inv.text).toContain("3 Tage in Folge");
    expect(inv.buttons.map((b) => b.callback_data)).toEqual(["tr:r:neffe", "tr:m:leicht", "tr:m:mittel"]);
    const week = weeklyMessage({
      sessions: 3,
      xp: 40,
      yes: 1,
      avg: { zuhoeren: 4, nutzen: 3, ruhe: 4.5, abschluss: 2.5 },
      prevAvg: 3,
    });
    expect(week.text).toContain("Schnitt <b>3,5</b> (📈 von 3,0)");
    expect(week.text).toContain("Nächste Woche drauf achten: <b>Abschluss</b>");
    expect(weeklyMessage({ sessions: 0, xp: 0, yes: 0, avg: null, prevAvg: null }).text).toContain(
      "keine Runde",
    );
  });
});

describeDb("Trainer meldet sich", () => {
  const db = useTestDb();

  it("Häppchen morgens und abends, Einladung mittags (nicht nach Training), Wochenbilanz sonntags, je einmal", async () => {
    const tip = {
      aufhaenger: "Hmm … Pause nach dem Preis.",
      erklaerung: "Wer zuerst redet, gibt nach.",
      so_klingts: "Neunhundertneunzig Euro.",
      uebung: "Zähl nach dem Preis still bis drei.",
      szenario: "preis",
    };
    const structured = vi.fn(() =>
      Promise.resolve({ output: tip, agentRunId: "r", costUsd: 0.01, model: "m" }),
    );
    const llm = { structured } as unknown as LlmGateway;
    const sent: { text: string }[] = [];
    let now = new Date("2026-10-11T05:00:00Z"); // Sonntag 07:00 Berlin
    const ctx = {
      db: db(),
      now: () => now,
      notifier: {
        coachMessage: (m: { text: string }) => {
          sent.push(m);
          return Promise.resolve();
        },
      },
      trainer: () => ({ db: db(), llm, config, now: () => now }),
    } as unknown as PipelineContext;

    await coachTick(ctx);
    expect(sent).toHaveLength(0); // vor 08:30
    now = new Date("2026-10-11T06:31:00Z"); // 08:31
    await coachTick(ctx);
    await coachTick(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Pause nach dem Preis");
    // Das Thema rückt weiter, der letzte Aufhänger geht in die nächste Anfrage
    now = new Date("2026-10-11T10:31:00Z"); // 12:31: Einladung
    await coachTick(ctx);
    expect(sent.at(-1)!.text).toContain("Mittagspause");
    now = new Date("2026-10-11T15:31:00Z"); // 17:31: zweites Häppchen
    await coachTick(ctx);
    expect(sent).toHaveLength(3);
    const second = (structured.mock.calls[1] as unknown as [{ input: string }])[0].input;
    expect(second).toContain(config.themen[1]!);
    expect(second).toContain("- Hmm … Pause nach dem Preis.");
    now = new Date("2026-10-11T17:01:00Z"); // 19:01: Wochenbilanz
    await coachTick(ctx);
    await coachTick(ctx);
    expect(sent).toHaveLength(4);
    expect(sent.at(-1)!.text).toContain("Deine Trainingswoche");

    // Montag: heute schon trainiert → keine Einladung; Neustart am Abend → nur ein Häppchen
    await db().query(
      `insert into training_sessions (chat_id, scenario, status, feedback, score, xp, finished_at)
       values (1, 'preis', 'fertig', $1, 4, 12, '2026-10-12T09:00:00Z')`,
      [JSON.stringify(feedback(4))],
    );
    now = new Date("2026-10-12T18:00:00Z"); // Montag 20:00
    const before = sent.length;
    await coachTick(ctx);
    expect(sent.length - before).toBe(1);
    expect(sent.at(-1)!.text).toContain("Pause nach dem Preis");
    const third = (structured.mock.calls[2] as unknown as [{ input: string }])[0].input;
    expect(third).toContain("Zuhören (Schnitt 4,0 von 5)");
  });
});

describe("Sätze und Stufen (rein)", () => {
  const phrases = loadPhrases();
  it("Sätze laden, Lücke, ganzer Satz", () => {
    expect(Object.keys(phrases).length).toBeGreaterThanOrEqual(20);
    const p = phrases.preis_vergleich!;
    expect(withGap(p)).toBe("Zu teuer im ____ wozu?");
    expect(fullSentence(p)).toBe("Zu teuer im Vergleich wozu?");
    expect(gapAnswers(phrases.nachfragen!)).toEqual(["genau", "konkret"]);
    expect(loadModelsConfig().roles.trainer_hint).toBeDefined();
    expect(loadPrompt("trainer_hint", "v1")).toContain("wiederhol dich nicht");
    expect(zodOutputFormat(hintSchema).type).toBe("json_schema");
  });

  it("Lückentext: groß/klein, Satzzeichen, Umlaute, ein Tippfehler ab fünf Buchstaben", () => {
    const p = phrases.preis_vergleich!;
    expect(checkGap(p, "vergleich")).toBe(true);
    expect(checkGap(p, " Vergleich. ")).toBe(true);
    expect(checkGap(p, "Vergleih")).toBe(true);
    expect(checkGap(p, "Preis")).toBe(false);
    expect(checkGap(p, "")).toBe(false);
    expect(checkGap(phrases.nachfragen!, "konkret")).toBe(true);
    expect(checkGap(phrases.mundpropaganda!, "googlet")).toBe(true); // Tippfehler
    expect(checkGap(phrases.ja_und!, "aber")).toBe(false);
    expect(normalize("Grüß Gott!")).toBe("gruess gott");
  });

  it("Aus dem Kopf: Kernwörter mit Endungen, mehrteilige Kernwörter, 60 %", () => {
    const p = phrases.nachfragen!; // kern: verstehen, fragen, hängt
    expect(checkRecall(p, "Versteh ich. Darf ich fragen, woran es hängt?").passed).toBe(true);
    const half = checkRecall(p, "Okay, woran hängt's denn?");
    expect(half.passed).toBe(false);
    expect(half.missed).toEqual(["verstehen", "fragen"]);
    expect(
      checkRecall(phrases.zusammenfassen!, "Wenn ich Sie richtig verstehe, geht es vor allem um Zeit?")
        .passed,
    ).toBe(true);
  });

  it("Auswahl: erst neue und schwache Sätze, für mittel zuerst die im Lückentext gelernten", () => {
    const ps = { a: phrases.ja_und!, b: phrases.nachfragen!, c: phrases.preis_vergleich! };
    const old = new Date("2026-10-01T00:00:00Z");
    const progress = [
      { phrase: "a", box: 2, last_at: old },
      { phrase: "b", box: 0, last_at: old },
    ];
    expect(pickPhrases(ps, progress, 2, "leicht", () => 0)).toEqual(["c", "b"]);
    expect(pickPhrases(ps, progress, 1, "mittel", () => 0)).toEqual(["a"]);
  });

  it("Knöpfe für Stufen und Weiß-nicht, Texte", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    for (const c of [
      { kind: "skip" as const, id },
      { kind: "mode" as const, mode: "mittel" as const },
    ])
      expect(parseTrainerCallback(trainerCallback(c))).toEqual(c);
    expect(parseTrainerCallback("tr:m:extrem")).toBeNull();
    const p = phrases.preis_vergleich!;
    expect(drillPrompt("leicht", p, 2, 5)).toContain("Du: „Zu teuer im ____ wozu?“");
    expect(drillPrompt("mittel", p, 2, 5)).toContain("Du: „Zu teuer …“");
    const list = phraseList(phrases, new Map([["preis_vergleich", 3]]));
    expect(list).toContain("1/");
    expect(list).toContain("🧠 „Zu teuer im Vergleich wozu?“");
  });
});

describeDb("Sales-Trainer: Stufen leicht und mittel", () => {
  const db = useTestDb();

  it("Lückentext-Runde: richtig, falsch, weiß nicht; XP, Lernstand, Stufe gemerkt, dann mittel", async () => {
    const structured = vi.fn();
    const llm = { structured, toolStep: vi.fn(), research: vi.fn() } as unknown as LlmGateway;
    const pipeline = {
      db: db(),
      now: () => new Date("2026-10-09T10:00:00Z"),
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
    const phrases = loadPhrases();
    const current = async () => {
      const { rows } = await db().query<{ id: string; drill: { items: string[]; index: number } }>(
        "select id, drill from training_sessions where status = 'offen'",
      );
      return { id: rows[0]!.id, key: rows[0]!.drill.items[rows[0]!.drill.index]! };
    };

    // Ohne Angabe startet die leichte Stufe
    await bot.handleUpdate(textUpdate("/training"));
    expect(texts().join("\n")).toContain("Lückentext");
    expect(texts().at(-1)).toContain("Satz 1/5");

    let c = await current();
    await bot.handleUpdate(textUpdate(gapAnswers(phrases[c.key]!)[0]!));
    expect(texts().at(-2)).toContain("✅");
    c = await current();
    await bot.handleUpdate(textUpdate("quatsch"));
    expect(texts().at(-2)).toContain("❌");
    expect(texts().at(-2)).toContain(fullSentence(phrases[c.key]!).slice(0, 10));
    c = await current();
    await bot.handleUpdate(callbackUpdate(`tr:k:${c.id}`)); // weiß nicht
    expect(texts().at(-2)).toContain("❌");
    for (let i = 0; i < 2; i++) {
      c = await current();
      await bot.handleUpdate(textUpdate(gapAnswers(phrases[c.key]!)[0]!));
    }
    const done = texts().find((x) => x.includes("Runde fertig"))!;
    expect(done).toContain("3/5 richtig");
    expect(done).toContain("+6 XP");
    expect(structured).not.toHaveBeenCalled(); // ohne LLM

    const { rows } = await db().query<{ box: number }>("select box from training_phrases");
    expect(rows.length).toBe(5);
    expect(rows.filter((r) => r.box === 1).length).toBe(3);
    expect((await gameStats(db(), new Date("2026-10-09T11:00:00Z"))).trainingXp).toBe(6);

    // Stufe gemerkt; Knopf "Mittel" wechselt
    await bot.handleUpdate(callbackUpdate("tr:m:mittel"));
    expect(texts().join("\n")).toContain("Aus dem Kopf");
    c = await current();
    // Für mittel kommen zuerst die gelernten Sätze
    expect(rows.length).toBeGreaterThan(0);
    await bot.handleUpdate(textUpdate(fullSentence(phrases[c.key]!)));
    expect(texts().at(-2)).toContain("✅");
    const { rows: modes } = await db().query<{ value: string }>(
      "select value #>> '{}' as value from app_state where key = $1",
      [`trainer:mode:${ALLOWED}`],
    );
    expect(modes[0]!.value).toBe("mittel");

    await bot.handleUpdate(textUpdate("/saetze"));
    expect(texts().at(-1)).toContain("Deine Sätze");
  });
});
