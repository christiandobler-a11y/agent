import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const CONFIG_DIR = new URL("../../config/", import.meta.url).pathname;

/** Liest eine YAML-Datei aus `config/` und validiert sie. Fehler nennen Datei und Feld. */
export function loadYamlConfig<T extends z.ZodType>(file: string, schema: T, dir = CONFIG_DIR): z.output<T> {
  const raw: unknown = parse(readFileSync(`${dir}${file}`, "utf8"));
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Ungültige Konfiguration in config/${file}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
