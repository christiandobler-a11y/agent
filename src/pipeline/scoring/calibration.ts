import { z } from "zod";
import type { ScoringConfig } from "./config.js";
import { scoreLead, type ScoreInput, type ScoreResult } from "./score.js";

/**
 * Kalibrierung am Golden Set (ARCHITECTURE.md 7.4, Abnahmekriterium 10): Christians A/B/C gegen den Score aus Code.
 * Rein und ohne Datenbank, damit Gewichte offline gegen die exportierte Datei getestet werden können.
 */

export type GoldenGrade = "A" | "B" | "C";

export interface GoldenEntry {
  company_id: string;
  name: string;
  branch_key: string | null;
  city: string | null;
  website: string | null;
  grade: GoldenGrade;
  /** Eingabe des Scores zum Zeitpunkt des Exports (Places, Fakten, Audit-Rubrik). */
  input: ScoreInput;
}

const entrySchema = z.object({
  company_id: z.string(),
  name: z.string(),
  branch_key: z.string().nullable(),
  city: z.string().nullable(),
  website: z.string().nullable(),
  grade: z.enum(["A", "B", "C"]),
  input: z.looseObject({ segment: z.enum(["WEBSITE", "NO_WEBSITE"]), now: z.string() }),
});

export const goldenFileSchema = z.object({
  description: z.string(),
  exported_at: z.string(),
  entries: z.array(entrySchema),
});

export type GoldenFile = z.infer<typeof goldenFileSchema>;

export function toGoldenFile(entries: GoldenEntry[], exportedAt: Date): GoldenFile {
  return {
    description:
      "Golden Set: Christians Bauchgefühl (A = sofort ansprechen, B = vielleicht, C = kein guter Lead) mit der " +
      "Score-Eingabe zum Exportzeitpunkt. Regressionstest: tests/golden.test.ts.",
    exported_at: exportedAt.toISOString(),
    entries: entries.map((e) => ({ ...e, input: { ...e.input, now: e.input.now.toISOString() } })),
  };
}

export function parseGoldenFile(raw: unknown): GoldenEntry[] {
  return goldenFileSchema.parse(raw).entries.map((e) => ({
    ...e,
    input: { ...(e.input as unknown as ScoreInput), now: new Date(e.input.now) },
  }));
}

export interface RankedEntry {
  entry: GoldenEntry;
  result: ScoreResult;
  rank: number;
}

export interface CalibrationReport {
  ranked: RankedEntry[];
  byGrade: Record<
    GoldenGrade,
    { n: number; avg: number | null; min: number | null; max: number | null; qualified: number }
  >;
  /** Kriterium 10a: deine Top-A-Firmen (bis 5) liegen in den System-Top-(Anzahl + 3). */
  topA: { needed: number; window: number; found: number; pass: boolean; missed: RankedEntry[] };
  /** Kriterium 10b: keine C-Firma erreicht die Pitch-Schwelle. */
  cHigh: { threshold: number; offenders: RankedEntry[]; pass: boolean };
  /** Anteil der Paare (A vor B, A vor C, B vor C), die das System in der richtigen Reihenfolge hat. */
  concordance: number | null;
  enough: boolean;
  pass: boolean;
}

export const MIN_GOLDEN_ENTRIES = 20;
const GRADE_ORDER: Record<GoldenGrade, number> = { A: 0, B: 1, C: 2 };

/** Aussortierte (Knock-out) stehen hinter allen anderen, sonst zählt die Punktzahl. */
const effective = (r: ScoreResult) => (r.knockout ? r.total - 1000 : r.total);

export function evaluateGoldenSet(entries: GoldenEntry[], config: ScoringConfig): CalibrationReport {
  const ranked = entries
    .map((entry) => ({ entry, result: scoreLead(entry.input, config) }))
    .sort((a, b) => effective(b.result) - effective(a.result) || a.entry.name.localeCompare(b.entry.name))
    .map((r, i) => ({ ...r, rank: i + 1 }));

  const byGrade = Object.fromEntries(
    (["A", "B", "C"] as const).map((g) => {
      const totals = ranked.filter((r) => r.entry.grade === g).map((r) => r.result.total);
      return [
        g,
        {
          n: totals.length,
          avg: totals.length
            ? Math.round((totals.reduce((s, t) => s + t, 0) / totals.length) * 10) / 10
            : null,
          min: totals.length ? Math.min(...totals) : null,
          max: totals.length ? Math.max(...totals) : null,
          qualified: ranked.filter((r) => r.entry.grade === g && r.result.qualified).length,
        },
      ];
    }),
  ) as CalibrationReport["byGrade"];

  const aEntries = ranked.filter((r) => r.entry.grade === "A");
  const needed = Math.min(aEntries.length, 5);
  const window = needed + 3;
  const found = aEntries.filter((r) => r.rank <= window).length;
  const topA = {
    needed,
    window,
    found,
    pass: found >= needed,
    missed: found >= needed ? [] : aEntries.filter((r) => r.rank > window),
  };

  const threshold = config.pitch_min_total;
  const offenders = ranked.filter(
    (r) => r.entry.grade === "C" && !r.result.knockout && r.result.total >= threshold,
  );

  let pairs = 0;
  let correct = 0;
  for (const hi of ranked) {
    for (const lo of ranked) {
      if (GRADE_ORDER[hi.entry.grade] >= GRADE_ORDER[lo.entry.grade]) continue;
      pairs++;
      const d = effective(hi.result) - effective(lo.result);
      correct += d > 0 ? 1 : d === 0 ? 0.5 : 0;
    }
  }

  const enough = entries.length >= MIN_GOLDEN_ENTRIES;
  const cHigh = { threshold, offenders, pass: offenders.length === 0 };
  return {
    ranked,
    byGrade,
    topA,
    cHigh,
    concordance: pairs ? Math.round((correct / pairs) * 1000) / 1000 : null,
    enough,
    pass: enough && topA.pass && cHigh.pass,
  };
}

const ok = (b: boolean) => (b ? "✔" : "✘");

export function formatCalibrationReport(r: CalibrationReport, version: string): string {
  const lines: string[] = [];
  lines.push(`Golden Set: ${r.ranked.length} Firmen, Score-Version ${version}`, "");
  lines.push("Rang  Score  Note  Firma");
  for (const x of r.ranked) {
    const ko = x.result.knockout ? `  (aussortiert: ${x.result.knockout.detail})` : "";
    const q = x.result.qualified ? "" : x.result.knockout ? "" : "  (unter Schwelle)";
    lines.push(
      `${String(x.rank).padStart(4)}  ${String(x.result.total).padStart(5)}  ${x.entry.grade.padStart(4)}  ${x.entry.name}${x.entry.branch_key ? ` · ${x.entry.branch_key}` : ""}${ko}${q}`,
    );
  }
  lines.push("", "Je Note:");
  for (const g of ["A", "B", "C"] as const) {
    const s = r.byGrade[g];
    lines.push(
      s.n === 0
        ? `  ${g}: keine`
        : `  ${g}: ${s.n} ${s.n === 1 ? "Firma" : "Firmen"} · Ø ${String(s.avg).replace(".", ",")} (${s.min}–${s.max}) · qualifiziert ${s.qualified}`,
    );
  }
  lines.push("", "Abnahmekriterium 10:");
  lines.push(
    r.topA.needed === 0
      ? "  – keine A-Firmen bewertet"
      : `  ${ok(r.topA.pass)} ${r.topA.found} von ${r.topA.needed} A-Firmen in den System-Top-${r.topA.window}` +
          (r.topA.missed.length
            ? ` (zu weit hinten: ${r.topA.missed.map((m) => `${m.entry.name} Rang ${m.rank}`).join(", ")})`
            : ""),
  );
  lines.push(
    `  ${ok(r.cHigh.pass)} keine C-Firma ab ${r.cHigh.threshold} Punkten` +
      (r.cHigh.offenders.length
        ? ` (zu hoch: ${r.cHigh.offenders.map((o) => `${o.entry.name} ${o.result.total}`).join(", ")})`
        : ""),
  );
  lines.push(`  ${ok(r.enough)} mindestens ${MIN_GOLDEN_ENTRIES} bewertete Firmen (${r.ranked.length})`);
  if (r.concordance !== null) {
    lines.push(
      "",
      `Reihenfolge: ${Math.round(r.concordance * 100)} % der Paare (A vor B, A vor C, B vor C) stimmen.`,
    );
  }
  lines.push("", r.pass ? "Ergebnis: bestanden." : "Ergebnis: noch nicht bestanden.");
  return lines.join("\n");
}
