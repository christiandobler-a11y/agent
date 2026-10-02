import { spending } from "../llm/budget.js";
import type { DbClient } from "./client.js";

export interface CostRow {
  day: string;
  source: "llm" | "api";
  name: string;
  calls: number;
  errors: number;
  cost_usd: number;
}

export interface CostReport {
  today: number;
  month: number;
  /** Letzte `days` Tage (deutsche Zeit), neueste zuerst. */
  rows: CostRow[];
}

/** Kostenübersicht aus der Ansicht `v_costs_daily` (LLM-Aufrufe und bezahlte APIs). */
export async function costReport(db: DbClient, now: Date = new Date(), days = 7): Promise<CostReport> {
  const { rows } = await db.query<{
    day: string;
    source: "llm" | "api";
    name: string;
    calls: number;
    errors: number;
    cost_usd: string;
  }>(
    `select to_char(day, 'YYYY-MM-DD') as day, source, name, calls, errors, cost_usd
       from v_costs_daily
      where day > ($1::timestamptz at time zone 'Europe/Berlin')::date - $2::int
      order by day desc, cost_usd desc, name`,
    [now, days],
  );
  const spent = await spending(db, now);
  return { ...spent, rows: rows.map((r) => ({ ...r, cost_usd: Number(r.cost_usd) })) };
}
