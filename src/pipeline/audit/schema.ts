import { z } from "zod";

/**
 * Ausgabe des Audit-Modells (ARCHITECTURE.md 7.1, 10): Befunde mit Belegen und eine Rubrik 1–5 je Kriterium.
 * Das Modell vergibt keine Punkte; die rechnet die Score-Engine aus der Rubrik.
 */

export const RUBRIC_CRITERIA = [
  "design_age",
  "mobile_ux",
  "cta_clarity",
  "services_visibility",
  "trust_signals",
  "hero_message",
] as const;

export type RubricCriterion = (typeof RUBRIC_CRITERIA)[number];

export const RUBRIC_LABELS: Record<RubricCriterion, string> = {
  design_age: "Design-Aktualität",
  mobile_ux: "Mobile Nutzbarkeit",
  cta_clarity: "Klarheit der Handlungsaufforderung",
  services_visibility: "Sichtbarkeit der Kernleistungen",
  trust_signals: "Vertrauenssignale",
  hero_message: "Aussage des ersten Bildschirms",
};

const rubricItem = z.object({
  /** 1 = sehr schwach/veraltet, 5 = sehr gut. */
  score: z.number().int().min(1).max(5),
  evidence: z.string().min(1).max(400),
});

export const FINDING_CATEGORIES = [
  "design",
  "mobile",
  "conversion",
  "content",
  "trust",
  "technical",
] as const;

export const findingSchema = z.object({
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(500),
  evidence: z.string().min(1).max(300),
  severity: z.enum(["high", "medium", "low"]),
  category: z.enum(FINDING_CATEGORIES),
});

export const auditOutputSchema = z.object({
  summary: z.string().min(1).max(600),
  design_era: z.string().max(40).nullable(),
  rubric: z.object({
    design_age: rubricItem,
    mobile_ux: rubricItem,
    cta_clarity: rubricItem,
    services_visibility: rubricItem,
    trust_signals: rubricItem,
    hero_message: rubricItem,
  }),
  findings: z.array(findingSchema).max(8),
  commercial: z.object({
    services: z.array(z.string().max(80)).max(12),
    high_value_services: z.array(z.string().max(80)).max(6),
    size_signals: z.array(z.string().max(120)).max(6),
    team_size: z.enum(["solo", "small", "medium", "large", "unknown"]),
  }),
});

export type AuditOutput = z.infer<typeof auditOutputSchema>;
export type Finding = z.infer<typeof findingSchema>;
