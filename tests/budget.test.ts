import { expect, it } from "vitest";
import { costReport } from "../src/db/costs.js";
import { BudgetExceededError, createBudgetGuard, spending } from "../src/llm/budget.js";
import { loadModelsConfig } from "../src/llm/config.js";
import { describeDb, useTestDb } from "./helpers/db.js";

// 2. Oktober 2026, 14:00 in Berlin (MESZ = UTC+2)
const NOW = new Date("2026-10-02T12:00:00Z");

describeDb("Budget und Kosten", () => {
  const db = useTestDb();

  const llm = (at: string, cost: number, role = "prefilter", status = "OK") =>
    db().query(
      `insert into agent_runs (role, model, status, cost_usd, started_at) values ($1, 'claude-haiku-4-5', $2, $3, $4)`,
      [role, status, cost, at],
    );
  const api = (at: string, cost: number) =>
    db().query(
      `insert into api_usage (service, operation, cost_usd, created_at) values ('places', 'searchText', $1, $2)`,
      [cost, at],
    );

  it("summiert LLM- und API-Kosten nach deutschem Tag und Monat", async () => {
    await llm("2026-10-01T22:30:00Z", 0.5); //    2.10. 00:30 Berlin → heute
    await api("2026-10-02T11:00:00Z", 0.25); //   2.10. 13:00 → heute
    await api("2026-10-01T21:30:00Z", 1); //      1.10. 23:30 → nur Monat
    await llm("2026-09-30T21:59:00Z", 7, "audit"); // 30.9. 23:59 → Vormonat
    await llm("2026-10-02T13:00:00Z", 3); //      nach "jetzt", zählt trotzdem (heute)

    expect(await spending(db(), NOW)).toEqual({ today: 3.75, month: 4.75 });
  });

  it("der Wächter sperrt ab Erreichen des Tages- oder Monatslimits", async () => {
    await expect(
      createBudgetGuard(db(), { daily_usd: 4, monthly_usd: 10 }, () => NOW).assertAvailable(),
    ).resolves.toBeUndefined();

    const daily = await createBudgetGuard(db(), { daily_usd: 3.75, monthly_usd: 10 }, () => NOW)
      .assertAvailable()
      .catch((e: unknown) => e);
    expect(daily).toBeInstanceOf(BudgetExceededError);
    expect(daily).toMatchObject({ period: "Tag", spentUsd: 3.75, limitUsd: 3.75 });

    const monthly = await createBudgetGuard(db(), { daily_usd: 100, monthly_usd: 4 }, () => NOW)
      .assertAvailable()
      .catch((e: unknown) => e);
    expect(monthly).toMatchObject({ period: "Monat" });
    expect((monthly as Error).message).toBe(
      "Budget für diesen Monat erreicht: 4.75 $ von 4.00 $ (config/models.yaml → budget)",
    );
  });

  it("Kostenübersicht je Tag, Quelle und Rolle", async () => {
    await llm("2026-10-02T08:00:00Z", 0.1, "prefilter", "ERROR");
    const report = await costReport(db(), NOW);
    expect(report).toMatchObject({ today: 3.85, month: 4.85 });
    expect(report.rows).toEqual([
      { day: "2026-10-02", source: "llm", name: "prefilter", calls: 3, errors: 1, cost_usd: 3.6 },
      { day: "2026-10-02", source: "api", name: "places", calls: 1, errors: 0, cost_usd: 0.25 },
      { day: "2026-10-01", source: "api", name: "places", calls: 1, errors: 0, cost_usd: 1 },
      { day: "2026-09-30", source: "llm", name: "audit", calls: 1, errors: 0, cost_usd: 7 },
    ]);
  });

  it("config/models.yaml: Budget gesetzt, alle Rollen haben Preise", () => {
    const config = loadModelsConfig();
    expect(config.budget.daily_usd).toBeGreaterThan(0);
    expect(Object.keys(config.roles)).toEqual(
      expect.arrayContaining(["prefilter", "audit", "pitch", "manager"]),
    );
  });
});
