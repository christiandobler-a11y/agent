import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";

/** Vorbild-Websites je Branche (config/inspiration.yaml), Grundlage für Creative-Briefing und Prototypen. */

const entrySchema = z.object({
  url: z.url(),
  name: z.string().min(1),
  warum: z.string().min(1),
  merkmale: z.array(z.string().min(1)).default([]),
  gespeichert: z.iso.date().or(z.date().transform((d) => d.toISOString().slice(0, 10))),
});

export const inspirationSchema = z.record(z.string().regex(/^[a-z0-9_]+$/), z.array(entrySchema));

export type Inspiration = z.infer<typeof inspirationSchema>;

export function loadInspiration(): Inspiration {
  return loadYamlConfig("inspiration.yaml", inspirationSchema);
}
