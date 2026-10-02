import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { costUsd, loadModelsConfig, loadPrompt } from "../src/llm/config.js";
import { createLlmGateway, LlmError, type MessagesApi } from "../src/llm/gateway.js";
import { describeDb, useTestDb } from "./helpers/db.js";

const models = {
  roles: { prefilter: { model: "claude-haiku-4-5", max_tokens: 400 } },
  pricing: { "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1 } },
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
    const llm = createLlmGateway({ db: db(), messages: { create }, models });

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

  it("Schema-Verletzung oder abgeschnittene Antwort → LlmError und ERROR in agent_runs", async () => {
    const cases: MessagesApi["create"][] = [
      () => Promise.resolve(message('{"ok":"ja"}')),
      () => Promise.resolve(message('{"ok":', { stop_reason: "max_tokens" })),
      () => Promise.reject(new Error("overloaded")),
    ];
    for (const create of cases) {
      const llm = createLlmGateway({ db: db(), messages: { create }, models });
      const err = await llm
        .structured({ role: "prefilter", promptVersion: "v1", system: "S", input: "I", schema })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      const row = await run((err as LlmError).agentRunId);
      expect(row.status).toBe("ERROR");
      expect(row.error).toBeTruthy();
      expect(row.finished_at).toBeInstanceOf(Date);
    }
  });

  it("unbekannte Rolle ist ein Konfigurationsfehler", async () => {
    const llm = createLlmGateway({ db: db(), messages: { create: vi.fn() }, models });
    await expect(
      llm.structured({ role: "audit", promptVersion: "v1", system: "S", input: "I", schema }),
    ).rejects.toThrow(/Rolle "audit"/);
  });
});
