import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";

const price = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cache_read: z.number().min(0),
});

export const modelsConfigSchema = z.object({
  roles: z.record(
    z.string(),
    z.object({ model: z.string().min(1), max_tokens: z.number().int().positive() }),
  ),
  pricing: z.record(z.string(), price),
});

export type ModelsConfig = z.infer<typeof modelsConfigSchema>;
export type ModelPrice = z.infer<typeof price>;

export function loadModelsConfig(): ModelsConfig {
  const config = loadYamlConfig("models.yaml", modelsConfigSchema);
  for (const [role, { model }] of Object.entries(config.roles)) {
    if (!config.pricing[model])
      throw new Error(`config/models.yaml: kein Preis für ${model} (Rolle ${role})`);
  }
  return config;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Kosten in $. Cache-Schreibvorgänge kosten das 1,25-Fache des Input-Preises (5-Minuten-Cache). */
export function costUsd(p: ModelPrice, u: TokenUsage): number {
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    u.inputTokens * perToken(p.input) +
    u.cacheWriteTokens * perToken(p.input) * 1.25 +
    u.cacheReadTokens * perToken(p.cache_read) +
    u.outputTokens * perToken(p.output)
  );
}

export const PROMPTS_DIR = new URL("../../prompts/", import.meta.url).pathname;

/** Versionierter Prompt aus `prompts/<name>.<version>.md`. */
export function loadPrompt(name: string, version: string, dir = PROMPTS_DIR): string {
  return readFileSync(`${dir}${name}.${version}.md`, "utf8").trim();
}
