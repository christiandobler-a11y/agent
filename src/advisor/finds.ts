import { getState, setState } from "../db/appState.js";
import type { Db } from "../db/client.js";
import { loadPrompt } from "../llm/config.js";
import type { LlmGateway } from "../llm/gateway.js";

/**
 * Fundstück zwischendurch (05.10.2026, Christian: "wenn die Agenten zwischenzeitlich mal etwas berichten, gerne auch
 * was Lustiges, was sie im Netz finden"). Eine kurze Websuche, ein paar Sätze mit Quelle, ohne Entscheidung. Die
 * letzten Themen merkt sich app_state, damit nichts doppelt kommt.
 */

export const FIND_PROMPT = "v1";
const RECENT_KEY = "advisor:finds";
const KEEP = 15;
const MAX_CHARS = 1200;

export interface FindDeps {
  db: Db;
  llm: LlmGateway;
  maxSearches: number;
}

/** Text fürs Telegram: gekürzt, ohne leere Zeilen am Rand. Rein. */
export function clipFind(text: string, max = MAX_CHARS): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export async function findSomething(deps: FindDeps): Promise<{ text: string; costUsd: number }> {
  const recent = (await getState<string[]>(deps.db, RECENT_KEY)) ?? [];
  const r = await deps.llm.research({
    role: "advisor_research",
    promptVersion: FIND_PROMPT,
    system: loadPrompt("fundstueck", FIND_PROMPT),
    input: `<bisher>\n${recent.length > 0 ? recent.map((t) => `- ${t}`).join("\n") : "(noch keine)"}\n</bisher>`,
    maxSearches: deps.maxSearches,
    inputSummary: "Fundstück",
  });
  const text = clipFind(r.text);
  await setState(deps.db, RECENT_KEY, [text.split("\n")[0]!.slice(0, 120), ...recent].slice(0, KEEP));
  return { text, costUsd: r.costUsd };
}
