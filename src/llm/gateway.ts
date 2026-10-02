import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import { costUsd, type ModelsConfig, type TokenUsage } from "./config.js";

/**
 * LLM-Gateway (ARCHITECTURE.md 6/10): der einzige Ort mit Anthropic-Aufrufen. Wählt das Modell je Rolle
 * aus config/models.yaml, erzwingt ein Ausgabe-Schema und schreibt jeden Aufruf mit Tokens und Kosten
 * in `agent_runs`. Budget-Wächter und Job-Retries folgen in Schritt 4.
 */

/** Der Teil des SDK-Clients, den das Gateway nutzt (in Tests ersetzbar). */
export interface MessagesApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export function createAnthropicMessages(apiKey: string): MessagesApi {
  // Das SDK wiederholt 408/409/429/5xx und Verbindungsfehler selbst.
  const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 60_000 });
  return { create: (params) => client.messages.create(params) };
}

export interface StructuredRequest<S extends z.ZodType> {
  role: string;
  promptVersion: string;
  system: string;
  /** Nutzereingabe. Fremde Inhalte (Places, Websites) nur hier, nie im System-Prompt. */
  input: string;
  schema: S;
  companyId?: string | null;
  searchRunId?: string | null;
  /** Kurzbeschreibung für `agent_runs.input_summary` (keine personenbezogenen Daten). */
  inputSummary?: string;
}

export interface StructuredResult<T> {
  output: T;
  agentRunId: string;
  costUsd: number;
  model: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly agentRunId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmError";
  }
}

const SUMMARY_MAX = 500;
const clip = (s: string) => (s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s);

function usageOf(message: Anthropic.Message | undefined): TokenUsage {
  const u = message?.usage;
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

export interface LlmGatewayDeps {
  db: Db;
  messages: MessagesApi;
  models: ModelsConfig;
}

export function createLlmGateway({ db, messages, models }: LlmGatewayDeps) {
  async function finishRun(
    id: string,
    status: "OK" | "ERROR",
    model: string, // konfigurierte Modell-ID (Alias), nach ihr richtet sich der Preis
    usage: TokenUsage,
    outputSummary: string | null,
    error: string | null,
  ): Promise<number> {
    const price = models.pricing[model];
    const cost = price ? costUsd(price, usage) : 0;
    await db.query(
      `update agent_runs set
         status = $2, model = $3, input_tokens = $4, output_tokens = $5, cache_read_tokens = $6,
         cost_usd = $7, output_summary = $8, error = $9, finished_at = now()
       where id = $1`,
      [
        id,
        status,
        model,
        usage.inputTokens + usage.cacheWriteTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        cost.toFixed(5),
        outputSummary,
        error,
      ],
    );
    return cost;
  }

  return {
    /** Ein Aufruf ohne Tools mit erzwungenem JSON-Schema. Wirft `LlmError`; der Lauf steht dann als ERROR in agent_runs. */
    async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.output<S>>> {
      const roleConfig = models.roles[req.role];
      if (!roleConfig)
        throw new Error(`Keine Modell-Konfiguration für Rolle "${req.role}" (config/models.yaml)`);
      const model = roleConfig.model;

      const { rows } = await db.query<{ id: string }>(
        `insert into agent_runs (role, company_id, search_run_id, model, prompt_version, input_summary, status)
         values ($1, $2, $3, $4, $5, $6, 'RUNNING') returning id`,
        [
          req.role,
          req.companyId ?? null,
          req.searchRunId ?? null,
          model,
          req.promptVersion,
          req.inputSummary ? clip(req.inputSummary) : null,
        ],
      );
      const runId = rows[0]!.id;

      let response: Anthropic.Message | undefined;
      try {
        response = await messages.create({
          model,
          max_tokens: roleConfig.max_tokens,
          system: req.system,
          messages: [{ role: "user", content: req.input }],
          output_config: { format: zodOutputFormat(req.schema) },
        });
        if (response.stop_reason !== "end_turn") {
          throw new Error(`Antwort unvollständig (stop_reason: ${response.stop_reason})`);
        }
        const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
        if (!text) throw new Error("Antwort ohne Text");
        const parsed = req.schema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`Antwort verletzt das Schema: ${parsed.error.message}`);

        const cost = await finishRun(runId, "OK", model, usageOf(response), clip(text), null);
        return { output: parsed.data, agentRunId: runId, costUsd: cost, model };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await finishRun(runId, "ERROR", model, usageOf(response), null, clip(message));
        throw new LlmError(`${req.role}: ${message}`, runId, { cause: err });
      }
    },
  };
}

export type LlmGateway = ReturnType<typeof createLlmGateway>;
