import { z } from "zod";
import { loadYamlConfig } from "../../config/files.js";
import { normalizeName } from "./identity.js";

/** Objektives Gate (ARCHITECTURE.md 5.2 Schritt 6): reine Regeln, kostenlos, vor jedem LLM-Aufruf. */

export const gateRulesSchema = z.object({
  min_rating: z.number().min(0).max(5),
  min_reviews: z.number().int().min(0),
  required_business_status: z.string().min(1),
});

export type GateRules = z.infer<typeof gateRulesSchema>;

export function loadGateRules(): GateRules {
  return loadYamlConfig("gate.yaml", gateRulesSchema);
}

export interface GateInput {
  name: string;
  businessStatus: string | null;
  rating: number | null;
  reviewCount: number | null;
}

/** `reason` entspricht den Schlüsseln in config/recheck.yaml (skipped.*). */
export type GateResult =
  { pass: true } | { pass: false; reason: "closed" | "reputation" | "chain"; detail: string };

const formatRating = (r: number) => r.toFixed(1).replace(".", ",");

/** Ganze Wörter des normalisierten Namens, damit "boc" nicht in "bocholt" trifft. */
function matchesChain(nameNormalized: string, chain: string): boolean {
  return ` ${nameNormalized} `.includes(` ${chain} `);
}

export function evaluateGate(input: GateInput, rules: GateRules, chains: readonly string[]): GateResult {
  const status = input.businessStatus ?? "UNBEKANNT";
  if (status !== rules.required_business_status) {
    return { pass: false, reason: "closed", detail: `Google-Status ${status}` };
  }

  const name = normalizeName(input.name);
  const chain = chains.find((c) => matchesChain(name, c));
  if (chain) return { pass: false, reason: "chain", detail: `Kette laut Namensliste ("${chain}")` };

  const reviews = input.reviewCount ?? 0;
  if (reviews < rules.min_reviews) {
    return {
      pass: false,
      reason: "reputation",
      detail: `zu wenige Bewertungen (${reviews}, mindestens ${rules.min_reviews})`,
    };
  }
  if (input.rating === null || input.rating < rules.min_rating) {
    const shown = input.rating === null ? "keine" : `${formatRating(input.rating)}★`;
    return {
      pass: false,
      reason: "reputation",
      detail: `Bewertung zu schwach (${shown}, mindestens ${formatRating(rules.min_rating)}★)`,
    };
  }
  return { pass: true };
}
