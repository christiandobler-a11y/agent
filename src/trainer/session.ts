import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";
import type { Db } from "../db/client.js";
import { loadPrompt } from "../llm/config.js";
import type { LlmGateway } from "../llm/gateway.js";

/**
 * Sales-Trainer (09.10.2026, Christian: "Einwandbehandlung wie ein Lernspiel mit XP"). Ein Gespräch = eine Zeile in
 * `training_sessions`. Die Rolle `trainer` spielt den Inhaber, `trainer_coach` bewertet am Ende vier Punkte von 1 bis
 * 5. Szenario-Wahl und XP rechnet Code (rein, unit-getestet), nie das LLM.
 */

export const TRAINER_PROMPT = "v1";
export const COACH_PROMPT = "v1";

const scenarioSchema = z.object({
  titel: z.string(),
  schwierigkeit: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  lage: z.string(),
  person: z.string(),
  haltung: z.string(),
  tipp: z.string(),
});
export type Scenario = z.infer<typeof scenarioSchema>;

const hm = z.string().regex(/^\d{2}:\d{2}$/);

export const trainerConfigSchema = z.object({
  runden: z.number().int().min(1),
  verfall_min: z.number().int().min(1),
  xp: z.object({
    basis: z.object({ 1: z.number(), 2: z.number(), 3: z.number() }),
    ja_bonus: z.number().min(0),
    tipp: z.number().min(0),
  }),
  gemeistert_ab: z.number().min(1).max(5),
  melden: z
    .object({
      aktiv: z.boolean(),
      tage: z.array(
        z.enum(["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"]),
      ),
      haeppchen: z.array(hm),
      einladung: hm.nullable(),
      wochenbilanz: z
        .object({
          tag: z.enum(["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"]),
          ab: hm,
        })
        .nullable(),
    })
    .default({ aktiv: false, tage: [], haeppchen: [], einladung: null, wochenbilanz: null }),
  themen: z.array(z.string()).default([]),
  angebot: z.string(),
  szenarien: z.record(z.string(), scenarioSchema),
});
export type TrainerConfig = z.infer<typeof trainerConfigSchema>;
export const loadTrainerConfig = () => loadYamlConfig("trainer.yaml", trainerConfigSchema);

export type Decision = "offen" | "ja" | "nein";

export interface Turn {
  who: "inhaber" | "christian";
  text: string;
  /** Stimmung des Inhabers nach seiner Antwort (-2 bis 2). */
  mood?: number;
}

export const ownerReplySchema = z.object({
  antwort: z.string().min(1).max(600),
  stimmung: z.number().int().min(-2).max(2),
  entscheidung: z.enum(["offen", "ja", "nein"]),
});

const point = z.object({ punkte: z.number().int().min(1).max(5), satz: z.string().min(1).max(300) });
export const coachSchema = z.object({
  zuhoeren: point,
  nutzen: point,
  ruhe: point,
  abschluss: point,
  gut: z.string().min(1).max(300),
  besser: z.string().min(1).max(300),
  beispiel: z.string().min(1).max(400),
});
export type CoachFeedback = z.infer<typeof coachSchema>;

export interface TrainingSession {
  id: string;
  chat_id: string;
  scenario: string;
  status: "offen" | "fertig" | "abgebrochen";
  turns: Turn[];
  hints: number;
  decision: Decision | null;
  feedback: CoachFeedback | null;
  score: string | null;
  xp: number;
  updated_at: Date;
}

// ---------------------------------------------------------------------------------------------------------------
// Rein: Szenario-Wahl, Punkte, XP

export interface PlayedScenario {
  scenario: string;
  /** Bester Durchschnitt bisher. */
  best: number;
  plays: number;
}

/**
 * Nächstes Szenario: erst die noch nie gespielten, dann die mit dem schwächsten besten Ergebnis, bei Gleichstand das
 * seltener gespielte. `rand` wählt unter gleich guten Kandidaten.
 */
export function pickScenario(
  config: TrainerConfig,
  played: readonly PlayedScenario[],
  rand: () => number = Math.random,
): string {
  const keys = Object.keys(config.szenarien);
  const rank = (k: string): [number, number] => {
    const p = played.find((x) => x.scenario === k);
    return p ? [p.best, p.plays] : [-1, 0];
  };
  const sorted = [...keys].sort((a, b) => {
    const [ba, pa] = rank(a);
    const [bb, pb] = rank(b);
    return ba - bb || pa - pb;
  });
  const [b0, p0] = rank(sorted[0]!);
  const top = sorted.filter((k) => {
    const [b, p] = rank(k);
    return b === b0 && p === p0;
  });
  return top[Math.floor(rand() * top.length)] ?? sorted[0]!;
}

export function averageScore(f: CoachFeedback): number {
  return (f.zuhoeren.punkte + f.nutzen.punkte + f.ruhe.punkte + f.abschluss.punkte) / 4;
}

/** XP eines Gesprächs: Grund-XP je Schwierigkeit anteilig zum Durchschnitt, Ja-Bonus, Abzug je Tipp, nie unter 1. */
export function xpFor(
  config: TrainerConfig,
  difficulty: 1 | 2 | 3,
  score: number,
  decision: Decision,
  hints: number,
): number {
  const base = config.xp.basis[difficulty] * (score / 5);
  const bonus = decision === "ja" ? config.xp.ja_bonus : 0;
  return Math.max(1, Math.round(base + bonus - hints * config.xp.tipp));
}

export const christianTurns = (turns: readonly Turn[]) => turns.filter((t) => t.who === "christian").length;

/** Verlauf als Text für die Modelle. */
export function transcript(turns: readonly Turn[], ownerName: string): string {
  return turns.map((t) => `${t.who === "christian" ? "Christian" : ownerName}: ${t.text}`).join("\n");
}

const ownerName = (s: Scenario) => s.person.split(",")[0]!.trim();

// ---------------------------------------------------------------------------------------------------------------
// Datenbank

export async function openSession(
  db: Db,
  chatId: number,
  now: Date,
  config: TrainerConfig,
): Promise<TrainingSession | null> {
  const { rows } = await db.query<TrainingSession>(
    `select * from training_sessions where chat_id = $1 and status = 'offen'
      order by updated_at desc limit 1`,
    [chatId],
  );
  const s = rows[0];
  if (!s) return null;
  if (now.getTime() - new Date(s.updated_at).getTime() > config.verfall_min * 60_000) {
    await abortSession(db, s.id, now);
    return null;
  }
  return s;
}

export async function getSession(db: Db, id: string): Promise<TrainingSession | null> {
  const { rows } = await db.query<TrainingSession>("select * from training_sessions where id = $1", [id]);
  return rows[0] ?? null;
}

export async function abortSession(db: Db, id: string, now: Date): Promise<boolean> {
  const { rowCount } = await db.query(
    `update training_sessions set status = 'abgebrochen', finished_at = $2, updated_at = $2
      where id = $1 and status = 'offen'`,
    [id, now],
  );
  return (rowCount ?? 0) > 0;
}

export async function useHint(db: Db, id: string, now: Date): Promise<void> {
  await db.query(`update training_sessions set hints = hints + 1, updated_at = $2 where id = $1`, [id, now]);
}

/** Bisherige Ergebnisse je Szenario (nur fertige Gespräche). */
export async function playedScenarios(db: Db): Promise<PlayedScenario[]> {
  const { rows } = await db.query<{ scenario: string; best: string; plays: number }>(
    `select scenario, max(score) as best, count(*)::int as plays from training_sessions
      where status = 'fertig' group by scenario`,
  );
  return rows.map((r) => ({ scenario: r.scenario, best: Number(r.best), plays: r.plays }));
}

// ---------------------------------------------------------------------------------------------------------------
// Ablauf

export interface TrainerDeps {
  db: Db;
  llm: LlmGateway;
  config: TrainerConfig;
  now: () => Date;
}

async function ownerReply(deps: TrainerDeps, sc: Scenario, turns: readonly Turn[]) {
  const r = await deps.llm.structured({
    role: "trainer",
    promptVersion: TRAINER_PROMPT,
    system: loadPrompt("trainer", TRAINER_PROMPT),
    input: [
      `<lage>${sc.lage}</lage>`,
      `<person>${sc.person}</person>`,
      `<haltung>${sc.haltung}</haltung>`,
      `<verlauf>\n${turns.length > 0 ? transcript(turns, ownerName(sc)) : "(Das Gespräch beginnt, du eröffnest.)"}\n</verlauf>`,
    ].join("\n"),
    schema: ownerReplySchema,
    inputSummary: `Training ${sc.titel}`,
  });
  return r.output;
}

/** Neues Gespräch: ein offenes wird abgebrochen, der Inhaber eröffnet. */
export async function startSession(
  deps: TrainerDeps,
  chatId: number,
  scenarioKey?: string,
): Promise<{ session: TrainingSession; scenario: Scenario }> {
  const { db, config } = deps;
  const now = deps.now();
  const key =
    scenarioKey && config.szenarien[scenarioKey]
      ? scenarioKey
      : pickScenario(config, await playedScenarios(db));
  const sc = config.szenarien[key]!;
  const first = await ownerReply(deps, sc, []);
  await db.query(
    `update training_sessions set status = 'abgebrochen', finished_at = $2, updated_at = $2
      where chat_id = $1 and status = 'offen'`,
    [chatId, now],
  );
  const turns: Turn[] = [{ who: "inhaber", text: first.antwort, mood: first.stimmung }];
  const { rows } = await db.query<TrainingSession>(
    `insert into training_sessions (chat_id, scenario, turns, created_at, updated_at)
     values ($1, $2, $3, $4, $4) returning *`,
    [chatId, key, JSON.stringify(turns), now],
  );
  return { session: rows[0]!, scenario: sc };
}

export interface TurnResult {
  reply: string;
  mood: number;
  /** Gesetzt, wenn das Gespräch damit beendet und bewertet ist. */
  done: { decision: Decision; feedback: CoachFeedback; score: number; xp: number } | null;
}

/** Christians Antwort: Inhaber reagiert; nach `runden` Antworten oder einer Entscheidung bewertet der Coach. */
export async function answer(deps: TrainerDeps, session: TrainingSession, text: string): Promise<TurnResult> {
  const { db, config } = deps;
  const sc = config.szenarien[session.scenario];
  if (!sc) throw new Error(`Unbekanntes Szenario: ${session.scenario}`);
  const turns: Turn[] = [...session.turns, { who: "christian", text: text.slice(0, 1500) }];
  const owner = await ownerReply(deps, sc, turns);
  turns.push({ who: "inhaber", text: owner.antwort, mood: owner.stimmung });
  const now = deps.now();
  const finished = owner.entscheidung !== "offen" || christianTurns(turns) >= config.runden;
  if (!finished) {
    await db.query(`update training_sessions set turns = $2, updated_at = $3 where id = $1`, [
      session.id,
      JSON.stringify(turns),
      now,
    ]);
    return { reply: owner.antwort, mood: owner.stimmung, done: null };
  }
  const coach = await deps.llm.structured({
    role: "trainer_coach",
    promptVersion: COACH_PROMPT,
    system: loadPrompt("trainer_coach", COACH_PROMPT),
    input: [
      `<angebot>${config.angebot}</angebot>`,
      `<lage>${sc.lage}</lage>`,
      `<person>${sc.person}</person>`,
      `<haltung>${sc.haltung}</haltung>`,
      `<ergebnis>${owner.entscheidung === "offen" ? "nach der letzten Runde noch offen" : owner.entscheidung}</ergebnis>`,
      `<verlauf>\n${transcript(turns, ownerName(sc))}\n</verlauf>`,
    ].join("\n"),
    schema: coachSchema,
    inputSummary: `Training-Bewertung ${sc.titel}`,
  });
  const feedback = coach.output;
  const score = averageScore(feedback);
  const decision = owner.entscheidung;
  const xp = xpFor(config, sc.schwierigkeit, score, decision, session.hints);
  await db.query(
    `update training_sessions
        set turns = $2, status = 'fertig', decision = $3, feedback = $4, score = $5, xp = $6,
            updated_at = $7, finished_at = $7
      where id = $1`,
    [session.id, JSON.stringify(turns), decision, JSON.stringify(feedback), score, xp, now],
  );
  return { reply: owner.antwort, mood: owner.stimmung, done: { decision, feedback, score, xp } };
}
