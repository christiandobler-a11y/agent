import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { costUsd, loadModelsConfig, loadPrompt } from "../src/llm/config.js";
import { BudgetExceededError, NO_BUDGET, type BudgetGuard } from "../src/llm/budget.js";
import { createLlmGateway, LlmError, type MessagesApi } from "../src/llm/gateway.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const models = {
  roles: { prefilter: { model: "claude-haiku-4-5", max_tokens: 400 } },
  pricing: { "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1 } },
  budget: { daily_usd: 5, monthly_usd: 50 },
};

function message(text: string, overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  } as Anthropic.Message;
}

describe("costUsd", () => {
  it("rechnet Input, Output, Cache-Lesen und -Schreiben", () => {
    const price = { input: 1, output: 5, cache_read: 0.1 };
    expect(
      costUsd(price, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toBeCloseTo(0.002);
    expect(
      costUsd(price, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.1 + 1.25);
  });
});

describe("Konfiguration", () => {
  it("models.yaml hat für jede Rolle einen Preis, Prompts sind lesbar", () => {
    expect(loadModelsConfig().roles.prefilter?.model).toBe("claude-haiku-4-5");
    expect(loadPrompt("prefilter", "v1")).toMatch(/^Du prüfst/);
  });
});

describeDb("LLM-Gateway", () => {
  const db = useTestDb();
  const schema = z.object({ ok: z.boolean() });
  const run = async (id: string) =>
    (await db().query("select * from agent_runs where id = $1", [id])).rows[0] as Record<string, unknown>;

  it("liefert validierte Ausgabe und schreibt agent_runs mit Kosten", async () => {
    const create = vi.fn(() => Promise.resolve(message('{"ok":true}')));
    const llm = createLlmGateway({ db: db(), messages: { create }, models, budget: NO_BUDGET });

    const result = await llm.structured({
      role: "prefilter",
      promptVersion: "v1",
      system: "System",
      input: "Eingabe",
      schema,
      inputSummary: "Test",
    });

    expect(result.output).toEqual({ ok: true });
    expect(result.costUsd).toBeCloseTo(0.002);
    const params = (create.mock.calls[0] as unknown[])[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 400, system: "System" });
    expect(params.output_config?.format?.type).toBe("json_schema");
    expect(params.tools).toBeUndefined();
    expect(await run(result.agentRunId)).toMatchObject({
      role: "prefilter",
      model: "claude-haiku-4-5",
      prompt_version: "v1",
      status: "OK",
      input_tokens: 1000,
      output_tokens: 200,
      cost_usd: "0.00200",
      input_summary: "Test",
      error: null,
    });
  });

  const call = (create: MessagesApi["create"], budget: BudgetGuard = NO_BUDGET) =>
    createLlmGateway({ db: db(), messages: { create }, models, budget }).structured({
      role: "prefilter",
      promptVersion: "v1",
      system: "S",
      input: "I",
      schema,
      inputSummary: "Retry-Test",
    });
  const runsFor = async (summaryPrefix: string) =>
    (
      await db().query<{ status: string; cost_usd: string; input_summary: string }>(
        "select status, cost_usd, input_summary from agent_runs where input_summary like $1 order by started_at",
        [`${summaryPrefix}%`],
      )
    ).rows;

  it("wiederholt eine unbrauchbare Antwort einmal; beide Versuche stehen mit Kosten in agent_runs", async () => {
    await db().query("delete from agent_runs");
    const answers = [message('{"ok":"ja"}'), message('{"ok":true}')];
    const create = vi.fn(() => Promise.resolve(answers.shift()!));

    const result = await call(create);

    expect(result.output).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.costUsd).toBeCloseTo(0.004); // beide Versuche zählen
    expect(await runsFor("Retry-Test")).toEqual([
      { status: "ERROR", cost_usd: "0.00200", input_summary: "Retry-Test" },
      { status: "OK", cost_usd: "0.00200", input_summary: "Retry-Test (Versuch 2)" },
    ]);
  });

  it("gibt nach zwei unbrauchbaren Antworten auf (Schema, kein JSON, abgeschnitten)", async () => {
    const bad = [
      message('{"ok":"ja"}'),
      message("kein json"),
      message('{"ok":', { stop_reason: "max_tokens" }),
      message("", { content: [] }),
    ];
    for (const answer of bad) {
      const create = vi.fn(() => Promise.resolve(answer));
      const err = await call(create).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect(create).toHaveBeenCalledTimes(2);
      const row = await run((err as LlmError).agentRunId);
      expect(row).toMatchObject({ status: "ERROR", finished_at: expect.any(Date) as Date });
      expect(row.error).toBeTruthy();
    }
  });

  it("wiederholt API-Fehler und Ablehnungen nicht (API-Retries macht das SDK)", async () => {
    for (const create of [
      vi.fn(() => Promise.reject(new Error("overloaded"))),
      vi.fn(() => Promise.resolve(message("", { stop_reason: "refusal", content: [] }))),
    ]) {
      const err = await call(create).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it("ruft bei erschöpftem Budget nichts auf und schreibt keinen Lauf", async () => {
    await db().query("delete from agent_runs");
    const create = vi.fn(() => Promise.resolve(message('{"ok":true}')));
    const exhausted: BudgetGuard = {
      limits: { daily_usd: 1, monthly_usd: 1 },
      assertAvailable: () => Promise.reject(new BudgetExceededError("Tag", 1.2, 1)),
    };
    await expect(call(create, exhausted)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
    expect(await runsFor("")).toEqual([]);
  });

  it("unbekannte Rolle ist ein Konfigurationsfehler", async () => {
    const llm = createLlmGateway({ db: db(), messages: { create: vi.fn() }, models, budget: NO_BUDGET });
    await expect(
      llm.structured({ role: "audit", promptVersion: "v1", system: "S", input: "I", schema }),
    ).rejects.toThrow(/Rolle "audit"/);
  });
});
