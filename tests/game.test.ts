import { describe, expect, it } from "vitest";
import { upsertCompany } from "../src/db/companies.js";
import {
  badgesOf,
  checkProgress,
  gameStats,
  levelOf,
  loadGameConfig,
  streaks,
  xpOf,
  type GameStats,
} from "../src/game/xp.js";
import { celebrationText, levelPath, levelText, progressBar } from "../src/telegram/game.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const c = loadGameConfig();
const stats = (over: Partial<GameStats> = {}): GameStats => ({
  contacted: 0,
  followUps: 0,
  replied: 0,
  interested: 0,
  won: 0,
  perfectDays: 0,
  streak: 0,
  bestStreak: 0,
  trainings: 0,
  trainingXp: 0,
  mastered: 0,
  trainingYes: 0,
  bestScore: 0,
  ...over,
});

describe("Spiel (rein)", () => {
  it("XP aus Verlauf und Training, Level", () => {
    expect(xpOf(stats({ contacted: 10 }), c)).toBe(50);
    expect(xpOf(stats({ contacted: 2, replied: 1, interested: 1, won: 1, perfectDays: 1 }), c)).toBe(
      10 + 15 + 25 + 100 + 10,
    );
    expect(levelOf(0, c)).toMatchObject({ number: 1, name: "Startklar", progress: 0 });
    expect(levelOf(49, c).number).toBe(1);
    expect(levelOf(50, c)).toMatchObject({ number: 2, next: { at: 100 } });
    expect(levelOf(75, c).progress).toBeCloseTo(0.5);
    expect(levelOf(500, c).name).toBe("Abschluss-Ass");
    expect(xpOf(stats({ trainingXp: 37, won: 1 }), c)).toBe(137);
    expect(levelOf(99999, c)).toMatchObject({ next: null, progress: 1 });
  });

  it("Abzeichen und Serien", () => {
    expect(badgesOf(stats(), c)).toEqual([]);
    expect(badgesOf(stats({ contacted: 1, replied: 1, won: 3, bestStreak: 5, perfectDays: 5 }), c)).toEqual(
      expect.arrayContaining(["erste_mail", "erste_antwort", "erster_kunde", "drei_kunden"]),
    );
    expect(badgesOf(stats({ trainings: 10, trainingYes: 1, bestScore: 5, mastered: 10 }), c)).toEqual([
      "erstes_training",
      "erstes_ja",
      "glatte_fuenf",
      "training_10",
      "einwand_profi",
    ]);
    const p = (perfect: boolean) => ({ perfect });
    expect(streaks([p(true), p(true), p(false), p(true)])).toEqual({ perfectDays: 3, streak: 1, best: 2 });
    expect(streaks([])).toEqual({ perfectDays: 0, streak: 0, best: 0 });
  });

  it("Texte: Balken, Glückwunsch, Übersicht", () => {
    expect(progressBar(0.35)).toBe("▰▰▰▱▱▱▱▱▱▱");
    expect(progressBar(2)).toBe("▰".repeat(10));
    const s = stats({ contacted: 10, replied: 1 });
    const xp = xpOf(s, c);
    const state = { stats: s, xp, level: levelOf(xp, c), badges: badgesOf(s, c) };
    const text = celebrationText({ state, gained: 20, levelUp: true, newBadges: ["erste_antwort"] }, c)!;
    expect(text).toContain("Level 2 erreicht");
    expect(text).toContain("Eis gebrochen");
    expect(celebrationText({ state, gained: 5, levelUp: false, newBadges: [] }, c)).toBeNull();
    const overview = levelText(state, c);
    expect(overview).toContain("Aus der Mail-Zeit: 10 angeschrieben, 1 Antworten");
    expect(overview).toContain("🔒 Erste Runde");
    expect(overview).not.toMatch(/Postbote|Mails ✉️/);
    expect(overview).toContain("📤 Erster Schuss · 💬 Eis gebrochen");
    expect(overview).toContain("ca. 3 Trainingsrunden"); // 65 XP, noch 35 bis Zuhörer, ca. 12 XP je Runde
    expect(levelPath(state, c)).toBe("🌱 👉🚪 " + Array(9).fill("◽").join(" "));
  });
});

describeDb("Spiel mit Datenbank", () => {
  const db = useTestDb();
  const NOW = new Date("2026-10-06T10:00:00Z");

  async function status(name: string, to: string[], at = NOW) {
    const { company } = await upsertCompany(db(), { name, placeId: `game-${name}` });
    for (const s of to)
      await db().query(
        `insert into interactions (company_id, type, to_status, created_by, created_at) values ($1, 'status', $2, 'test', $3)`,
        [company.id, s, at],
      );
    return company;
  }

  it("zählt jeden Lead je Ereignis einmal, meldet Level und Abzeichen genau einmal", async () => {
    // Doppelt auf CONTACTED gesetzt zählt nur einmal.
    const a = await status("Physio A", ["CONTACTED", "CONTACTED", "REPLIED"]);
    await status("Physio B", ["CONTACTED"], new Date("2026-10-05T10:00:00Z"));
    for (let i = 0; i < 8; i++) await status(`Physio ${i}`, ["CONTACTED"]);
    // Gestern komplett abgearbeitet, heute noch offen.
    await db().query(
      `insert into outreach_plan (plan_date, company_id, kind, channel, status, position) values
        ('2026-10-05', $1, 'new', 'email', 'done', 1), ('2026-10-06', $1, 'followup', 'email', 'ready', 1)`,
      [a.id],
    );
    const s = await gameStats(db(), NOW);
    expect(s).toMatchObject({ contacted: 10, replied: 1, perfectDays: 1, streak: 1 });
    // Stand bis gestern Mittag: nur Physio B
    expect((await gameStats(db(), NOW, new Date("2026-10-05T12:00:00Z"))).contacted).toBe(1);

    const first = await checkProgress(db(), NOW, c);
    expect(first.gained).toBe(50 + 15 + 10);
    expect(first.levelUp).toBe(true);
    expect(first.newBadges).toEqual(expect.arrayContaining(["erste_mail", "erste_antwort"]));
    const again = await checkProgress(db(), NOW, c);
    expect(again).toMatchObject({ gained: 0, levelUp: false, newBadges: [] });
  });
});
