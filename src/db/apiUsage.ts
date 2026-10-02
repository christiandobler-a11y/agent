import type { DbClient } from "./client.js";

export interface ApiUsageInput {
  service: string;
  operation: string;
  costUsd: number;
  searchRunId?: string | null;
  companyId?: string | null;
}

/** Kostenpflichtigen Aufruf einer externen API (ohne LLM) festhalten; zählt für den Budget-Wächter. */
export async function recordApiUsage(db: DbClient, u: ApiUsageInput): Promise<void> {
  await db.query(
    `insert into api_usage (service, operation, search_run_id, company_id, cost_usd) values ($1, $2, $3, $4, $5)`,
    [u.service, u.operation, u.searchRunId ?? null, u.companyId ?? null, u.costUsd.toFixed(5)],
  );
}
