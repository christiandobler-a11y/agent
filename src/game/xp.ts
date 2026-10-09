import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";
import { getState, setState } from "../db/appState.js";
import type { DbClient } from "../db/client.js";
import { loadTrainerConfig } from "../trainer/session.js";

/**
 * Fortschritt als kleines Spiel (04.10.2026, Christians Idee): XP, Level und Abzeichen. Alles wird aus dem Verlauf
 * berechnet (rein bis auf `gameStats`), jeder Lead zählt je Ereignis nur einmal. Neue Level und Abzeichen erkennt
 * `checkProgress` über den zuletzt gemeldeten Stand in app_state.
 */

const configSchema = z.object({
  xp: z.object({
    kontaktiert: z.number(),
    nachgefasst: z.number(),
    antwort: z.number(),
    interessiert: z.number(),
    gewonnen: z.number(),
    perfekter_tag: z.number(),
  }),
  level: z.array(z.object({ ab: z.number().min(0), name: z.string(), emoji: z.string() })).min(1),
  abzeichen: z.record(z.string(), z.object({ name: z.string(), emoji: z.string(), text: z.string() })),
});
export type GameConfig = z.infer<typeof configSchema>;
export const loadGameConfig = () => loadYamlConfig("game.yaml", configSchema);

export interface GameStats {
  contacted: number;
  followUps: number;
  replied: number;
  interested: number;
  won: number;
  perfectDays: number;
  /** Komplett abgearbeitete Pakete in Folge bis zum letzten abgeschlossenen Tag. */
  streak: number;
  bestStreak: number;
  /** Sales-Trainer (09.10.2026): fertige Gespräche, ihre XP (von Code berechnet) und gemeisterte Szenarien. */
  trainings: number;
  trainingXp: number;
  mastered: number;
  /** Trainings, in denen der Inhaber Ja gesagt hat, und der beste Schnitt eines Gesprächs. */
  trainingYes: number;
  bestScore: number;
}

/** Bedingungen der Abzeichen (Schlüssel wie in config/game.yaml). */
const BADGES: Record<string, (s: GameStats) => boolean> = {
  erste_mail: (s) => s.contacted >= 1,
  erste_antwort: (s) => s.replied >= 1,
  erster_interessent: (s) => s.interested >= 1,
  erster_kunde: (s) => s.won >= 1,
  drei_kunden: (s) => s.won >= 3,
  zehn_kunden: (s) => s.won >= 10,
  perfekter_tag: (s) => s.perfectDays >= 1,
  serie_5: (s) => s.bestStreak >= 5,
  serie_20: (s) => s.bestStreak >= 20,
  erstes_training: (s) => s.trainings >= 1,
  training_10: (s) => s.trainings >= 10,
  training_50: (s) => s.trainings >= 50,
  erstes_ja: (s) => s.trainingYes >= 1,
  glatte_fuenf: (s) => s.bestScore >= 5,
  einwand_profi: (s) => s.mastered >= 10,
};

export function xpOf(s: GameStats, c: GameConfig): number {
  const x = c.xp;
  return (
    s.contacted * x.kontaktiert +
    s.followUps * x.nachgefasst +
    s.replied * x.antwort +
    s.interested * x.interessiert +
    s.won * x.gewonnen +
    s.perfectDays * x.perfekter_tag +
    s.trainingXp
  );
}

export interface LevelInfo {
  /** 1 = erstes Level. */
  number: number;
  name: string;
  emoji: string;
  next: { name: string; emoji: string; at: number } | null;
  /** Anteil bis zum nächsten Level (0 bis 1). */
  progress: number;
}

export function levelOf(xp: number, c: GameConfig): LevelInfo {
  const levels = [...c.level].sort((a, b) => a.ab - b.ab);
  let i = 0;
  while (i + 1 < levels.length && xp >= levels[i + 1]!.ab) i++;
  const cur = levels[i]!;
  const nxt = levels[i + 1] ?? null;
  return {
    number: i + 1,
    name: cur.name,
    emoji: cur.emoji,
    next: nxt ? { name: nxt.name, emoji: nxt.emoji, at: nxt.ab } : null,
    progress: nxt ? (xp - cur.ab) / (nxt.ab - cur.ab) : 1,
  };
}

export function badgesOf(s: GameStats, c: GameConfig): string[] {
  return Object.keys(c.abzeichen).filter((k) => BADGES[k]?.(s));
}

/** Perfekte Tage und Serien aus den Tagen des Morgen-Pakets (sortiert, ohne den laufenden Tag). */
export function streaks(days: { perfect: boolean }[]): { perfectDays: number; streak: number; best: number } {
  let run = 0;
  let best = 0;
  for (const d of days) {
    run = d.perfect ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { perfectDays: days.filter((d) => d.perfect).length, streak: run, best };
}

/** Kennzahlen aus der Datenbank, optional nur bis `until` (z. B. Tagesanfang für "heute +X XP"). */
export async function gameStats(
  db: DbClient,
  now: Date,
  until: Date = now,
  masteredFrom = 4,
): Promise<GameStats> {
  const { rows } = await db.query<{ to_status: string; n: number }>(
    `select to_status, count(distinct company_id)::int as n from interactions
      where type = 'status' and to_status in ('CONTACTED', 'REPLIED', 'INTERESTED', 'WON') and created_at <= $1
      group by to_status`,
    [until],
  );
  const n = (s: string) => rows.find((r) => r.to_status === s)?.n ?? 0;
  const { rows: f } = await db.query<{ n: number }>(
    `select count(*)::int as n from interactions
      where type = 'draft' and channel = 'email' and (meta->>'follow_up')::boolean is true
        and meta ? 'sent_at' and (meta->>'sent_at')::timestamptz <= $1`,
    [until],
  );
  // Ein Tag ist perfekt, wenn nichts mehr offen ist (aussortierte zählen nicht); der laufende Tag zählt erst, wenn er
  // komplett ist, bricht aber keine Serie.
  const { rows: days } = await db.query<{ perfect: boolean; today: boolean }>(
    `select bool_and(status in ('done', 'dropped')) and bool_or(status = 'done') as perfect,
            plan_date = ($1::timestamptz at time zone 'Europe/Berlin')::date as today
       from outreach_plan
      where plan_date <= ($1::timestamptz at time zone 'Europe/Berlin')::date
      group by plan_date order by plan_date`,
    [now],
  );
  // Bis `until` vor jetzt (z. B. Tagesanfang) zählt der heutige Tag nicht mit.
  const counted = days.filter((d) => !d.today || (until >= now && d.perfect));
  const s = streaks(counted);
  const { rows: t } = await db.query<{
    n: number;
    xp: number;
    mastered: number;
    yes: number;
    best: string | null;
  }>(
    `select count(*)::int as n, coalesce(sum(xp), 0)::int as xp,
            count(distinct scenario) filter (where score >= $2)::int as mastered,
            count(*) filter (where decision = 'ja')::int as yes, max(score) as best
       from training_sessions where status = 'fertig' and finished_at <= $1`,
    [until, masteredFrom],
  );
  return {
    contacted: n("CONTACTED"),
    followUps: f[0]?.n ?? 0,
    replied: n("REPLIED"),
    interested: n("INTERESTED"),
    won: n("WON"),
    perfectDays: s.perfectDays,
    streak: s.streak,
    bestStreak: s.best,
    trainings: t[0]?.n ?? 0,
    trainingXp: t[0]?.xp ?? 0,
    mastered: t[0]?.mastered ?? 0,
    trainingYes: t[0]?.yes ?? 0,
    bestScore: t[0]?.best != null ? Number(t[0].best) : 0,
  };
}

/** Ab diesem Schnitt gilt ein Trainings-Szenario als gemeistert (config/trainer.yaml → gemeistert_ab). */
function masteredFrom(): number {
  try {
    return loadTrainerConfig().gemeistert_ab;
  } catch {
    return 4;
  }
}

export interface GameState {
  stats: GameStats;
  xp: number;
  level: LevelInfo;
  badges: string[];
}

export async function gameState(
  db: DbClient,
  now: Date,
  c: GameConfig = loadGameConfig(),
): Promise<GameState> {
  const stats = await gameStats(db, now, now, masteredFrom());
  const xp = xpOf(stats, c);
  return { stats, xp, level: levelOf(xp, c), badges: badgesOf(stats, c) };
}

export interface Progress {
  state: GameState;
  /** XP seit der letzten Prüfung. */
  gained: number;
  levelUp: boolean;
  newBadges: string[];
}

const SEEN_KEY = "game:seen";

/** Was ist seit der letzten Prüfung dazugekommen? Merkt sich den neuen Stand (jedes Level und Abzeichen einmal). */
export async function checkProgress(
  db: DbClient,
  now: Date,
  c: GameConfig = loadGameConfig(),
): Promise<Progress> {
  const state = await gameState(db, now, c);
  const seen = (await getState<{ xp: number; level: number; badges: string[] }>(db, SEEN_KEY)) ?? {
    xp: 0,
    level: 1,
    badges: [],
  };
  const newBadges = state.badges.filter((b) => !seen.badges.includes(b));
  const levelUp = state.level.number > seen.level;
  const gained = state.xp - seen.xp;
  if (gained !== 0 || levelUp || newBadges.length > 0)
    await setState(db, SEEN_KEY, {
      xp: state.xp,
      level: Math.max(seen.level, state.level.number),
      badges: [...new Set([...seen.badges, ...state.badges])],
    });
  return { state, gained, levelUp, newBadges };
}
