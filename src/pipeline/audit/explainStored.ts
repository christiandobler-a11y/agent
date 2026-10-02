import type { DbClient } from "../../db/client.js";
import type { Company } from "../../db/companies.js";
import { latestAudit, latestLeadScore, latestPitch } from "../../db/leads.js";
import { explainFull, explainScore } from "../scoring/explain.js";
import type { ScoreResult } from "../scoring/score.js";
import type { Finding } from "./schema.js";

/**
 * "Warum hat X 91 Punkte?" / "Warum wurde Y aussortiert?" aus gespeicherten Daten (ARCHITECTURE.md 18, Kriterium 4),
 * inklusive Rolle und Modell, die die Bewertung erzeugt haben. Kein LLM-Aufruf.
 */
export async function explainStoredLead(db: DbClient, company: Company, full = false): Promise<string> {
  const lines: string[] = [];
  const score = await latestLeadScore(db, company.id);
  if (!score) {
    if (company.status === "SKIPPED" || company.status === "FAILED") {
      return `${company.name}: ${company.status === "SKIPPED" ? "aussortiert" : "fehlgeschlagen"} – ${company.skip_detail ?? company.skip_reason ?? "ohne Angabe"} (vor dem Scoring)`;
    }
    return `${company.name}: noch nicht bewertet (Status ${company.status}).`;
  }
  const audit = await latestAudit(db, company.id);
  let auditBy: string | null = null;
  if (audit) {
    const { rows } = await db.query<{ model: string; id: string }>(
      "select model, id from agent_runs where id = $1",
      [audit.agent_run_id],
    );
    const run = rows[0];
    auditBy = `audit (${audit.model}${run ? `, Lauf ${run.id.slice(0, 8)}` : ""}, Prompt ${audit.prompt_version})`;
  }
  const result = score.breakdown as ScoreResult;
  lines.push(explainScore(result, { companyName: company.name, scoredAt: score.created_at, auditBy }));

  if (audit) {
    const findings = (audit.findings as Finding[]).filter((f) => f.severity !== "low").slice(0, 5);
    if (audit.summary) lines.push("", `Audit: ${audit.summary}`);
    if (findings.length > 0) {
      lines.push("Befunde:");
      for (const f of findings) lines.push(`  • ${f.title} – ${f.evidence}`);
    }
  }
  const pitch = await latestPitch(db, company.id);
  if (pitch) {
    lines.push("", `Hauptchance (${pitch.model}): ${pitch.main_opportunity}`);
    pitch.arguments.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
    if (pitch.opening_line) lines.push(`Einstieg: „${pitch.opening_line}“`);
  }
  if (full) lines.push("", explainFull(result));
  return lines.join("\n");
}
