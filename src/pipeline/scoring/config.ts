import { z } from "zod";
import { loadYamlConfig } from "../../config/files.js";
import { RUBRIC_CRITERIA } from "../audit/schema.js";

const pts = z.number().min(0);

export const scoringConfigSchema = z.object({
  version: z.string().min(1),
  qualify_min_total: z.number().min(0).max(100),
  pitch_min_total: z.number().min(0).max(100),
  knockouts: z.object({
    min_rating_with_reviews: z.object({ rating: z.number(), reviews: z.number().int() }),
    min_reviews: z.number().int().min(0),
    min_website_chance: pts,
  }),
  dimensions: z.object({
    business: z.object({
      max: pts,
      rating: z.object({ max: pts, from: z.number(), full: z.number() }),
      reviews: z.object({ max: pts, full: z.number().positive() }),
      photos: z.object({ max: pts, full: z.number().positive() }),
    }),
    website: z.object({
      max: pts,
      objective_max: pts,
      objective: z.object({
        psi_performance_below_50: pts,
        psi_performance_below_30: pts,
        no_https: pts,
        invalid_certificate: pts,
        no_viewport: pts,
        mobile_too_wide: pts,
        no_tel_link: pts,
        no_contact_form: pts,
        copyright_older_than_years: z.object({ years: z.number().int().positive(), points: pts }),
        layout_tables: pts,
        outdated_builder: pts,
      }),
      outdated_builders: z.array(z.string()),
      rubric_max: pts,
      /** Gewichte je Rubrik-Kriterium (relativ, fehlend = 1). Ohne Angabe zählen alle Kriterien gleich. */
      rubric_weights: z.partialRecord(z.enum(RUBRIC_CRITERIA), z.number().min(0)).default({}),
      no_website_points: pts,
    }),
    potential: z.object({
      max: pts,
      branch_value: pts,
      high_value_services: z.object({ per_service: pts, max: pts }),
      team_size: z.object({ solo: pts, small: pts, medium: pts, large: pts, unknown: pts }),
    }),
    gap: z.object({
      max: pts,
      gap_max: pts,
      explainable: z.object({
        min_findings: z.number().int(),
        points: pts,
        partial_findings: z.number().int(),
        partial_points: pts,
      }),
    }),
    reach: z.object({ max: pts, owner_named: pts, email: pts, phone: pts, contact_form: pts }),
  }),
});

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

/** Aktive Score-Version (config/scoring.<version>.yaml). v2 = kalibriert am Golden Set vom 03.10.2026. */
export const ACTIVE_SCORING_VERSION = "v2";

export function loadScoringConfig(version = ACTIVE_SCORING_VERSION): ScoringConfig {
  const config = loadYamlConfig(`scoring.${version}.yaml`, scoringConfigSchema);
  const d = config.dimensions;
  const sum = d.business.max + d.website.max + d.potential.max + d.gap.max + d.reach.max;
  if (sum !== 100)
    throw new Error(`config/scoring.${version}.yaml: Dimensionen ergeben ${sum} statt 100 Punkte`);
  return config;
}
