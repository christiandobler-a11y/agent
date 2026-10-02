import { z } from "zod";
import { loadPrompt } from "../../llm/config.js";
import type { LlmGateway } from "../../llm/gateway.js";
import type { Branch, Branches } from "./branches.js";
import { domainIdentity } from "./identity.js";
import type { Place } from "./places.js";

/** Prefilter (ARCHITECTURE.md 5.2 Schritt 5, Rolle "prefilter"): Branche passt? Kette? Kein Tool-Zugriff. */

export const PREFILTER_PROMPT_VERSION = "v1";

export const prefilterOutputSchema = z.object({
  fit: z.boolean(),
  is_chain: z.boolean(),
  branch_key: z.string().nullable(),
  reason: z.string(),
});

export type PrefilterOutput = z.infer<typeof prefilterOutputSchema>;

export type PrefilterVerdict =
  | { pass: true; branchKey: string | null; reason: string }
  | { pass: false; reason: "chain" | "off_target"; detail: string; branchKey: string | null };

export type PrefilterDecision = PrefilterVerdict & { agentRunId: string; costUsd: number };

export interface PrefilterContext {
  term: string;
  branch: Branch | null;
  branches: Branches;
}

/** Eingabe für das Modell: nur strukturierte Places-Felder (~200 Tokens), keine Website-Inhalte. */
export function prefilterInput(place: Place, ctx: PrefilterContext): string {
  const search = ctx.branch
    ? { suchbegriff: ctx.term, branche: ctx.branch.key, bezeichnung: ctx.branch.label }
    : { suchbegriff: ctx.term, branche: null };
  const branchList = Object.values(ctx.branches).map((b) => ({ key: b.key, bezeichnung: b.label }));
  const entry = {
    name: place.displayName?.text ?? null,
    kategorie: place.primaryTypeDisplayName?.text ?? null,
    google_typen: place.types.filter((t) => t !== "point_of_interest" && t !== "establishment"),
    adresse: place.formattedAddress ?? null,
    website_domain: domainIdentity(place.websiteUri),
    bewertung: place.rating ?? null,
    anzahl_bewertungen: place.userRatingCount ?? 0,
  };
  return JSON.stringify({ suche: search, branchen: branchList, eintrag: entry });
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300);

/** Wertet die Modell-Antwort aus. Unbekannte Branchen-Schlüssel werden zu `null`. */
export function decide(output: PrefilterOutput, branches: Branches): PrefilterVerdict {
  const branchKey =
    output.branch_key && Object.hasOwn(branches, output.branch_key) ? output.branch_key : null;
  const reason = clean(output.reason) || "ohne Begründung";
  if (output.is_chain) return { pass: false, reason: "chain", detail: `Prefilter: ${reason}`, branchKey };
  if (!output.fit) return { pass: false, reason: "off_target", detail: `Prefilter: ${reason}`, branchKey };
  return { pass: true, branchKey, reason };
}

export function createPrefilter(llm: LlmGateway) {
  const system = loadPrompt("prefilter", PREFILTER_PROMPT_VERSION);

  return async function prefilter(
    place: Place,
    ctx: PrefilterContext,
    ids: { companyId: string; searchRunId: string | null },
  ): Promise<PrefilterDecision> {
    const result = await llm.structured({
      role: "prefilter",
      promptVersion: PREFILTER_PROMPT_VERSION,
      system,
      input: prefilterInput(place, ctx),
      schema: prefilterOutputSchema,
      companyId: ids.companyId,
      searchRunId: ids.searchRunId,
      inputSummary: `${place.displayName?.text ?? place.id} · Suche "${ctx.term}"`,
    });
    return { ...decide(result.output, ctx.branches), agentRunId: result.agentRunId, costUsd: result.costUsd };
  };
}

export type Prefilter = ReturnType<typeof createPrefilter>;
