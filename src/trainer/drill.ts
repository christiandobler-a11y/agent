import type { Db } from "../db/client.js";
import {
  checkGap,
  checkRecall,
  pickPhrases,
  type Phrase,
  type PhraseProgress,
  type Phrases,
} from "./phrases.js";
import { closeOpen, type DrillState, type TrainerDeps, type TrainingSession } from "./session.js";

/**
 * Stufen leicht (Lückentext) und mittel (Satz aus dem Kopf), 09.10.2026. Eine Runde = `saetze_runde` Sätze, ohne LLM.
 * Der Lernstand je Satz (Leitner-Fach) steht in `training_phrases`, die XP der Runde in `training_sessions`.
 */

export type DrillMode = "leicht" | "mittel";

export async function phraseProgress(db: Db): Promise<PhraseProgress[]> {
  const { rows } = await db.query<PhraseProgress>("select phrase, box, last_at from training_phrases");
  return rows;
}

/** Lernstand aller Sätze für /saetze: Fach je Satz. */
export async function phraseBoxes(db: Db): Promise<Map<string, number>> {
  return new Map((await phraseProgress(db)).map((p) => [p.phrase, p.box]));
}

async function recordPhrase(db: Db, phrase: string, correct: boolean, now: Date): Promise<void> {
  await db.query(
    `insert into training_phrases (phrase, box, seen, correct, last_at)
     values ($1, $2, 1, $3, $4)
     on conflict (phrase) do update set
       box = case when $2 = 0 then 0 else least(training_phrases.box + 1, 4) end,
       seen = training_phrases.seen + 1,
       correct = training_phrases.correct + $3,
       last_at = $4`,
    [phrase, correct ? 1 : 0, correct ? 1 : 0, now],
  );
}

export async function startDrill(
  deps: TrainerDeps,
  phrases: Phrases,
  chatId: number,
  mode: DrillMode,
): Promise<{ session: TrainingSession; phrase: Phrase; key: string }> {
  const { db } = deps;
  const now = deps.now();
  const items = pickPhrases(phrases, await phraseProgress(db), deps.config.saetze_runde, mode);
  if (items.length === 0) throw new Error("Keine Sätze in config/saetze.yaml");
  await closeOpen(db, chatId, now);
  const drill: DrillState = { items, index: 0, results: [] };
  const { rows } = await db.query<TrainingSession>(
    `insert into training_sessions (chat_id, scenario, mode, drill, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $5) returning *`,
    [chatId, `saetze-${mode}`, mode, JSON.stringify(drill), now],
  );
  return { session: rows[0]!, phrase: phrases[items[0]!]!, key: items[0]! };
}

export interface DrillStep {
  key: string;
  phrase: Phrase;
  correct: boolean;
  /** Stufe mittel: welche Kernwörter fehlten. */
  missed: string[];
  next: { key: string; phrase: Phrase; position: number; total: number } | null;
  done: { correct: number; total: number; xp: number } | null;
}

/** Antwort auf den aktuellen Satz (`null` = „weiß nicht“). */
export async function drillAnswer(
  deps: TrainerDeps,
  phrases: Phrases,
  session: TrainingSession,
  input: string | null,
): Promise<DrillStep> {
  const { db, config } = deps;
  const drill = session.drill!;
  const key = drill.items[drill.index]!;
  const phrase = phrases[key];
  if (!phrase) throw new Error(`Unbekannter Satz: ${key}`);
  const now = deps.now();
  let correct = false;
  let missed: string[] = [];
  if (input !== null) {
    if (session.mode === "leicht") correct = checkGap(phrase, input);
    else {
      const r = checkRecall(phrase, input);
      correct = r.passed;
      missed = r.missed;
    }
  } else missed = phrase.kern;
  await recordPhrase(db, key, correct, now);
  const next: DrillState = {
    items: drill.items,
    index: drill.index + 1,
    results: [...drill.results, correct],
  };
  if (next.index < next.items.length) {
    await db.query(`update training_sessions set drill = $2, updated_at = $3 where id = $1`, [
      session.id,
      JSON.stringify(next),
      now,
    ]);
    const k = next.items[next.index]!;
    return {
      key,
      phrase,
      correct,
      missed,
      next: { key: k, phrase: phrases[k]!, position: next.index + 1, total: next.items.length },
      done: null,
    };
  }
  const right = next.results.filter(Boolean).length;
  const xp = right * (session.mode === "leicht" ? config.xp.leicht : config.xp.mittel);
  await db.query(
    `update training_sessions set drill = $2, status = 'fertig', xp = $3, updated_at = $4, finished_at = $4
      where id = $1`,
    [session.id, JSON.stringify(next), xp, now],
  );
  return { key, phrase, correct, missed, next: null, done: { correct: right, total: next.items.length, xp } };
}
