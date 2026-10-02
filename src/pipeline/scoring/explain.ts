import type { Dimension, ScoreResult } from "./score.js";

/** "Warum hat dieser Lead 91 Punkte?" (ARCHITECTURE.md 7.5): Aufschlüsselung als Text, aus gespeicherten Daten. */

export interface ExplainContext {
  companyName: string;
  scoredAt: Date;
  /** z. B. "audit (claude-sonnet-5-5, Lauf 1a2b3c4d)"; null ohne Audit. */
  auditBy: string | null;
}

const LETTER: Record<Dimension["key"], string> = {
  business: "A",
  website: "B",
  potential: "C",
  gap: "D",
  reach: "E",
};
const SHORT: Record<Dimension["key"], string> = {
  business: "Business",
  website: "Website",
  potential: "Potenzial",
  gap: "Lücke",
  reach: "Kontakt",
};

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ","));
const date = (d: Date) =>
  d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });

/** Die wichtigsten Gründe einer Dimension (Positionen mit Punkten, größte zuerst). */
function reasons(d: Dimension, max = 3): string {
  const top = d.items
    .filter((i) => i.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, max)
    .map((i) =>
      i.source === "rubrik" && i.detail.match(/^\d\/5/)
        ? `${i.label} ${i.detail.slice(0, 3)}`
        : `${i.label}: ${i.detail}`,
    );
  return top.length > 0 ? top.join(" · ") : "keine Punkte";
}

export function explainScore(result: ScoreResult, ctx: ExplainContext): string {
  const lines = [
    `${ctx.companyName} – ${result.total}/100 (Scoring ${result.version}, ${date(ctx.scoredAt)})`,
  ];
  if (result.knockout) {
    lines.push(`Aussortiert: ${result.knockout.detail}`);
  } else if (!result.qualified) {
    lines.push("Unter der Schwelle für QUALIFIED");
  }
  for (const d of result.dimensions) {
    const head = `${LETTER[d.key]} ${SHORT[d.key]}`.padEnd(12);
    lines.push(`${head}${`${num(d.points)}/${d.max}`.padEnd(8)}${reasons(d)}`);
  }
  lines.push(`Bewertet von: ${ctx.auditBy ? `${ctx.auditBy}, ` : ""}score (Code)`);
  return lines.join("\n");
}

/** Ausführliche Aufschlüsselung aller Positionen (CLI `explain --full`). */
export function explainFull(result: ScoreResult): string {
  const lines: string[] = [];
  for (const d of result.dimensions) {
    lines.push(`${LETTER[d.key]} ${d.label}: ${num(d.points)}/${d.max}`);
    for (const i of d.items) {
      lines.push(
        `   ${num(i.points).padStart(5)}/${num(i.max).padEnd(4)} ${i.label} [${i.source}] – ${i.detail}`,
      );
    }
  }
  return lines.join("\n");
}
