import { z } from "zod";
import { loadYamlConfig } from "../../config/files.js";
import type { CompanyStatus } from "../../db/companies.js";

const days = z.number().int().positive().nullable();

export const recheckRulesSchema = z.object({
  qualified: days,
  failed: days,
  skipped: z.object({ default: days }).catchall(days),
});

export type RecheckRules = z.infer<typeof recheckRulesSchema>;

export function loadRecheckRules(): RecheckRules {
  return loadYamlConfig("recheck.yaml", recheckRulesSchema);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Zeitpunkt der nächsten automatischen Prüfung nach einem Statuswechsel, oder `null` für nie. */
export function computeRecheckAfter(
  rules: RecheckRules,
  status: CompanyStatus,
  skipReason: string | null,
  now: Date,
): Date | null {
  let d: number | null;
  switch (status) {
    case "QUALIFIED":
      d = rules.qualified;
      break;
    case "FAILED":
      d = rules.failed;
      break;
    case "SKIPPED":
      // `null` heißt "nie" und darf nicht auf den Standard zurückfallen, daher kein `??`.
      d =
        skipReason !== null && Object.hasOwn(rules.skipped, skipReason)
          ? (rules.skipped[skipReason] as number | null)
          : rules.skipped.default;
      break;
    default:
      // Pipeline läuft noch, oder Vertriebsstatus: den setzt nur Christian, nie automatisch neu prüfen.
      d = null;
  }
  return d === null ? null : new Date(now.getTime() + d * DAY_MS);
}

const IN_PIPELINE: readonly CompanyStatus[] = ["NEW", "RESEARCHED", "AUDITED"];
const RECHECKABLE: readonly CompanyStatus[] = ["QUALIFIED", "SKIPPED", "FAILED"];

export type ReprocessDecision =
  { reprocess: true } | { reprocess: false; reason: "in_pipeline" | "in_sales" | "not_due" | "never" };

/** Darf eine bereits bekannte Firma in einem neuen Suchlauf erneut verarbeitet werden? */
export function shouldReprocess(
  company: { status: CompanyStatus; recheck_after: Date | null },
  now: Date,
): ReprocessDecision {
  if (IN_PIPELINE.includes(company.status)) return { reprocess: false, reason: "in_pipeline" };
  if (!RECHECKABLE.includes(company.status)) return { reprocess: false, reason: "in_sales" };
  if (company.recheck_after === null) return { reprocess: false, reason: "never" };
  return company.recheck_after <= now ? { reprocess: true } : { reprocess: false, reason: "not_due" };
}
