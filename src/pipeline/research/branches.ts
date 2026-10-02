import { z } from "zod";
import { loadYamlConfig } from "../../config/files.js";
import { normalizeName } from "./identity.js";

const branchSchema = z.object({
  label: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  places_types: z.array(z.string()).default([]),
  value: z.number().int().min(1).max(5),
  chains: z.array(z.string().min(1)).default([]),
});

export const branchesSchema = z.record(z.string().regex(/^[a-z0-9_]+$/), branchSchema);

export type Branch = z.infer<typeof branchSchema> & { key: string };
export type Branches = Record<string, Branch>;

export function loadBranches(): Branches {
  const raw = loadYamlConfig("branches.yaml", branchesSchema);
  return Object.fromEntries(Object.entries(raw).map(([key, b]) => [key, { key, ...b }]));
}

const fold = (s: string) => normalizeName(s).replace(/ /g, "");

/** Ordnet einen Suchbegriff einer Branche zu (Schlüssel, Bezeichnung oder Alias), sonst `null`. */
export function resolveBranch(branches: Branches, term: string): Branch | null {
  const t = fold(term);
  if (!t) return null;
  return (
    Object.values(branches).find(
      (b) => fold(b.key) === t || fold(b.label) === t || b.aliases.some((a) => fold(a) === t),
    ) ?? null
  );
}

/** Alle Ketten-Namen aller Branchen, normalisiert (eine Kette bleibt eine Kette, egal wonach gesucht wird). */
export function chainNames(branches: Branches): string[] {
  const names = Object.values(branches).flatMap((b) => b.chains.map((c) => normalizeName(c)));
  return [...new Set(names.filter(Boolean))];
}
