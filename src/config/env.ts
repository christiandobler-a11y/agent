import { z } from "zod";

const optionalSecret = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const chatIdList = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (!v) return [];
    const ids = v.split(",").map((s) => s.trim());
    for (const id of ids) {
      if (!/^-?\d+$/.test(id)) {
        ctx.addIssue({ code: "custom", message: `Ungültige Chat-ID: "${id}"` });
        return z.NEVER;
      }
    }
    return ids.map(Number);
  });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  GOOGLE_API_KEY: optionalSecret,
  TELEGRAM_BOT_TOKEN: optionalSecret,
  TELEGRAM_ALLOWED_CHAT_IDS: chatIdList,
  /** Kontakt-Entwürfe: WhatsApp-Business-Nummer (international, z. B. +49 151 …) und Telefon für die Signatur. */
  OUTREACH_WHATSAPP: optionalSecret,
  OUTREACH_PHONE: optionalSecret,
  /** Optional: Ping-URL eines Uptime-Dienstes (z. B. Healthchecks.io). Enthält ein Token, nie loggen. */
  HEALTHCHECK_URL: optionalSecret.pipe(z.url().optional()),
});

export type Env = z.infer<typeof envSchema>;

export const SECRET_KEYS = [
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "TELEGRAM_BOT_TOKEN",
] as const satisfies readonly (keyof Env)[];

export type SecretKey = (typeof SECRET_KEYS)[number];

/**
 * Ausweichname für den Anthropic-Key: In Claude-Code-Cloud-Sessions wird ANTHROPIC_API_KEY von der
 * Umgebung selbst belegt bzw. herausgefiltert. Dort den Key als AVELIO_ANTHROPIC_API_KEY setzen.
 */
const ANTHROPIC_KEY_FALLBACK = "AVELIO_ANTHROPIC_API_KEY";

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse({
    ...source,
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY?.trim() || source[ANTHROPIC_KEY_FALLBACK],
  });
  if (!result.success) {
    throw new Error(`Ungültige Umgebungsvariablen:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Jedes Modul fordert nur die Secrets an, die es selbst braucht (ARCHITECTURE.md 12.1).
 * Fehlt eines, bricht der Start mit einer klaren Meldung ab.
 */
export function requireKeys<K extends SecretKey>(env: Env, keys: readonly K[]): Record<K, string> {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Fehlende Umgebungsvariablen: ${missing.join(", ")}`);
  }
  return Object.fromEntries(keys.map((k) => [k, env[k]])) as Record<K, string>;
}

/**
 * Lädt `.env` aus dem Arbeitsverzeichnis, falls vorhanden. Bereits gesetzte Umgebungsvariablen haben Vorrang
 * (Server, CI, Cloud-Session setzen sie direkt). Gibt zurück, ob eine Datei geladen wurde.
 */
export function loadDotEnv(path = ".env"): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
