import type { DbClient } from "../db/client.js";

/** Budget-Wächter (ARCHITECTURE.md 11.1): Tages- und Monatslimit über LLM- und API-Kosten zusammen. */

export interface BudgetLimits {
  daily_usd: number;
  monthly_usd: number;
}

export interface Spending {
  today: number;
  month: number;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly period: "Tag" | "Monat",
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(
      `Budget für ${period === "Tag" ? "heute" : "diesen Monat"} erreicht: ` +
        `${spentUsd.toFixed(2)} $ von ${limitUsd.toFixed(2)} $ (config/models.yaml → budget)`,
    );
    this.name = "BudgetExceededError";
  }
}

const TIMEZONE = "Europe/Berlin";

/** Ausgaben heute und im laufenden Monat (deutsche Zeit), Stichtag `now`. */
export async function spending(db: DbClient, now: Date = new Date()): Promise<Spending> {
  const { rows } = await db.query<{ today: string; month: string }>(
    `with bounds as (
       select date_trunc('day', $1::timestamptz at time zone $2) at time zone $2 as day_start,
              date_trunc('month', $1::timestamptz at time zone $2) at time zone $2 as month_start
     ),
     costs as (
       select started_at as at, cost_usd from agent_runs, bounds where started_at >= month_start
       union all
       select created_at, cost_usd from api_usage, bounds where created_at >= month_start
     )
     select coalesce(sum(cost_usd) filter (where at >= (select day_start from bounds)), 0) as today,
            coalesce(sum(cost_usd), 0) as month
       from costs`,
    [now, TIMEZONE],
  );
  return { today: Number(rows[0]!.today), month: Number(rows[0]!.month) };
}

export interface BudgetGuard {
  limits: BudgetLimits;
  /** Wirft `BudgetExceededError`, wenn Tages- oder Monatslimit erreicht ist. */
  assertAvailable(): Promise<void>;
}

export function createBudgetGuard(
  db: DbClient,
  limits: BudgetLimits,
  now: () => Date = () => new Date(),
): BudgetGuard {
  return {
    limits,
    async assertAvailable() {
      const spent = await spending(db, now());
      if (spent.month >= limits.monthly_usd)
        throw new BudgetExceededError("Monat", spent.month, limits.monthly_usd);
      if (spent.today >= limits.daily_usd)
        throw new BudgetExceededError("Tag", spent.today, limits.daily_usd);
    },
  };
}

/** Ohne Limit, z. B. für Tests. */
export const NO_BUDGET: BudgetGuard = {
  limits: { daily_usd: Infinity, monthly_usd: Infinity },
  assertAvailable: () => Promise.resolve(),
};
