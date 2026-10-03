import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";

/** Positionierung, Schreibregeln, Spamschutz und Terminfenster für Kontakt-Entwürfe (config/outreach.yaml). */

const hm = z.string().regex(/^\d{2}:\d{2}$/);
export const WEEKDAYS = [
  "sonntag",
  "montag",
  "dienstag",
  "mittwoch",
  "donnerstag",
  "freitag",
  "samstag",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const outreachConfigSchema = z.object({
  positionierung: z.string(),
  absender_name: z.string().min(1),
  absender_zusatz: z.string().default(""),
  du_branchen: z.array(z.string()).default([]),
  einstieg: z.string().min(1),
  einstiege_abwechslung: z.array(z.string()).default([]),
  regeln: z.array(z.string()),
  spamschutz: z.object({
    betreffe: z.array(z.string()).min(1),
    gruesse: z.array(z.string()).min(1),
    regeln: z.array(z.string()),
  }),
  kontaktweg: z.object({
    whatsapp_text: z.string(),
    whatsapp_text_sie: z.string(),
    email_cta: z.string(),
    email_cta_du: z.string(),
    email_cta_ohne_whatsapp: z.string(),
    email_cta_ohne_whatsapp_du: z.string(),
    vorbereitet: z.array(z.string()).min(1),
    vorbereitet_du: z.array(z.string()).min(1),
  }),
  termine: z.object({
    zeitfenster: z.partialRecord(z.enum(WEEKDAYS), z.array(hm)),
    ausnahmen_mittagspause: z.partialRecord(z.enum(WEEKDAYS), z.array(hm)).default({}),
    branchen_bevorzugt: z.record(z.string(), z.array(hm)).default({}),
    tage_je_nachricht: z.number().int().min(1).max(3),
    uhrzeiten_je_tag: z.number().int().min(1).max(3),
    fruehestens_in_tagen: z.number().int().min(0),
    spaetestens_in_tagen: z.number().int().min(1),
    max_leads_je_termin: z.number().int().min(1),
    formulierungen: z.array(z.string()).min(1),
    formulierungen_du: z.array(z.string()).min(1),
  }),
});

export type OutreachConfig = z.infer<typeof outreachConfigSchema>;

export function loadOutreachConfig(): OutreachConfig {
  return loadYamlConfig("outreach.yaml", outreachConfigSchema);
}
