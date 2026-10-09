import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";

/**
 * Universelle Sätze für Einwände (config/saetze.yaml) und die reine Prüf-Logik der Stufen leicht (Lückentext) und
 * mittel (Satz aus dem Kopf). Alles ohne LLM, voll unit-getestet.
 */

const phraseSchema = z.object({
  kategorie: z.string(),
  einwand: z.string(),
  satz: z.string().regex(/\[\[[^\]]+\]\]/, "Satz braucht eine Lücke [[…]]"),
  kern: z.array(z.string()).min(1),
  wann: z.string(),
});
export type Phrase = z.infer<typeof phraseSchema>;

export const phrasesSchema = z.object({
  saetze: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), phraseSchema),
});
export type Phrases = Record<string, Phrase>;
export const loadPhrases = (): Phrases => loadYamlConfig("saetze.yaml", phrasesSchema).saetze;

const GAP = /\[\[([^\]]+)\]\]/;

/** Antworten für die Lücke (erste = Standard). */
export const gapAnswers = (p: Phrase): string[] =>
  GAP.exec(p.satz)![1]!
    .split("|")
    .map((a) => a.trim());

/** Satz mit Lücke „____“. */
export const withGap = (p: Phrase): string => p.satz.replace(GAP, "____");

/** Ganzer Satz (erste Antwort eingesetzt). */
export const fullSentence = (p: Phrase): string => p.satz.replace(GAP, gapAnswers(p)[0]!);

/** Vergleichsform: klein, Umlaute ausgeschrieben, nur Buchstaben, Ziffern und Leerzeichen. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Editierabstand mit vertauschten Nachbarbuchstaben als einem Fehler („googlet“ statt „googelt“). */
export function levenshtein(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  return d[a.length]![b.length]!;
}

/** Lückentext: richtig bei gleichem Wort (ab 5 Buchstaben ein Tippfehler erlaubt). */
export function checkGap(p: Phrase, input: string): boolean {
  const given = normalize(input);
  if (!given) return false;
  return gapAnswers(p).some((a) => {
    const want = normalize(a);
    return given === want || (want.length >= 5 && levenshtein(given, want) <= 1);
  });
}

/**
 * Wiedergeben: Welche Kernwörter kommen vor? Ein Kernwort zählt, wenn ein Wort der Antwort mit seinem Stamm beginnt
 * (Endungen egal) bzw. mehrteilige Kernwörter als Ganzes vorkommen. Bestanden ab 60 %.
 */
export function checkRecall(p: Phrase, input: string): { passed: boolean; hit: string[]; missed: string[] } {
  const text = ` ${normalize(input)} `;
  const words = text.trim().split(" ");
  const hit: string[] = [];
  const missed: string[] = [];
  for (const k of p.kern) {
    const n = normalize(k);
    const ok = n.includes(" ")
      ? text.includes(` ${n} `) || text.includes(` ${n}`)
      : words.some((w) => {
          const stem = n.length > 5 ? n.slice(0, n.length - 2) : n;
          return w.startsWith(stem) || (n.length >= 5 && levenshtein(w, n) <= 1);
        });
    (ok ? hit : missed).push(k);
  }
  return { passed: hit.length >= Math.ceil(p.kern.length * 0.6), hit, missed };
}

export interface PhraseProgress {
  phrase: string;
  /** Leitner-Fach 0 bis 4: richtig = eins höher, falsch = zurück auf 0. */
  box: number;
  last_at: Date | null;
}

/**
 * Sätze für eine Runde: zuerst nie gesehene bzw. niedrige Fächer, bei Gleichstand der am längsten nicht gesehene.
 * Für „mittel“ kommen zuerst Sätze, die im Lückentext schon mal saßen (Fach ≥ 1).
 */
export function pickPhrases(
  phrases: Phrases,
  progress: readonly PhraseProgress[],
  n: number,
  mode: "leicht" | "mittel",
  rand: () => number = Math.random,
): string[] {
  const byKey = new Map(progress.map((p) => [p.phrase, p]));
  const keys = Object.keys(phrases);
  const jitter = new Map(keys.map((k) => [k, rand()]));
  const rank = (k: string) => {
    const p = byKey.get(k);
    const box = p?.box ?? -1;
    const learned = mode === "mittel" ? (box >= 1 ? 0 : 1) : 0;
    return [learned, box, p?.last_at ? new Date(p.last_at).getTime() : 0, jitter.get(k)!] as const;
  };
  return [...keys]
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
      return 0;
    })
    .slice(0, n);
}
