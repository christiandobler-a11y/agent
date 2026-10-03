import { z } from "zod";
import { loadYamlConfig } from "../config/files.js";
import type { CompanyStatus } from "../db/companies.js";

/** Vertriebsstatus (ARCHITECTURE.md 9.1): setzt nur Christian, per Button oder über den Manager. */

export const SALES_STATUSES = [
  "READY_FOR_CONTACT",
  "CONTACTED",
  "REPLIED",
  "INTERESTED",
  "PROTOTYPE",
  "WON",
  "LOST",
] as const satisfies readonly CompanyStatus[];

export type SalesStatus = (typeof SALES_STATUSES)[number];

export const SALES_LABELS: Record<SalesStatus, string> = {
  READY_FOR_CONTACT: "vorgemerkt",
  CONTACTED: "kontaktiert",
  REPLIED: "Antwort erhalten",
  INTERESTED: "Termin / Interesse",
  PROTOTYPE: "Prototyp",
  WON: "gewonnen",
  LOST: "verloren",
};

export const SALES_EMOJI: Record<SalesStatus, string> = {
  READY_FOR_CONTACT: "📌",
  CONTACTED: "📤",
  REPLIED: "💬",
  INTERESTED: "📅",
  PROTOTYPE: "🛠",
  WON: "✅",
  LOST: "❌",
};

/** Ein Buchstabe je Status für Telegram-Buttons (callback_data ≤ 64 Byte). */
export const SALES_CODES: Record<SalesStatus, string> = {
  READY_FOR_CONTACT: "m",
  CONTACTED: "k",
  REPLIED: "a",
  INTERESTED: "t",
  PROTOTYPE: "p",
  WON: "g",
  LOST: "v",
};

export const isSalesStatus = (s: string): s is SalesStatus =>
  (SALES_STATUSES as readonly string[]).includes(s);

export function salesStatusFromCode(code: string): SalesStatus | null {
  return SALES_STATUSES.find((s) => SALES_CODES[s] === code) ?? null;
}

const time = z.string().regex(/^\d{2}:\d{2}$/);
export const crmConfigSchema = z.object({
  follow_up_days: z.number().int().min(0).max(60),
  quiet_hours: z.object({ start: time, end: time }),
});
export type CrmConfig = z.infer<typeof crmConfigSchema>;

export function loadCrmConfig(): CrmConfig {
  return loadYamlConfig("crm.yaml", crmConfigSchema);
}

/** Liegt `now` (deutsche Zeit) in der Ruhezeit? Die Ruhezeit darf über Mitternacht gehen. */
export function isQuietTime(now: Date, quiet: CrmConfig["quiet_hours"]): boolean {
  const hm = now.toLocaleTimeString("de-DE", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
  });
  const { start, end } = quiet;
  return start <= end ? hm >= start && hm < end : hm >= start || hm < end;
}
