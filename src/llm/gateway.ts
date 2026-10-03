import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import type { BudgetGuard } from "./budget.js";
import { costUsd, type ModelsConfig, type TokenUsage } from "./config.js";

/**
 * LLM-Gateway (ARCHITECTURE.md 6/10): der einzige Ort mit Anthropic-Aufrufen. Wählt das Modell je Rolle
 * aus config/models.yaml, erzwingt ein Ausgabe-Schema, prüft vor jedem Aufruf das Budget und schreibt jeden
 * Versuch mit Tokens und Kosten in `agent_runs`.
 */

/** Der Teil des SDK-Clients, den das Gateway nutzt (in Tests ersetzbar). */
export interface MessagesApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export function createAnthropicMessages(apiKey: string): MessagesApi {
  // Das SDK wiederholt 408/409/429/5xx und Verbindungsfehler selbst.
  // Audits mit Bildern und Denkphase brauchen länger als einfache Klassifikationen.
  const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 180_000 });
  return { create: (params) => client.messages.create(params) };
}

export interface StructuredRequest<S extends z.ZodType> {
  role: string;
  promptVersion: string;
  system: string;
  /** Nutzereingabe (Text oder Text + Bilder). Fremde Inhalte (Places, Websites) nur hier, nie im System-Prompt. */
  input: string | Anthropic.ContentBlockParam[];
  schema: S;
  companyId?: string | null;
  searchRunId?: string | null;
  jobId?: string | null;
  /** Kurzbeschreibung für `agent_runs.input_summary` (keine personenbezogenen Daten). */
  inputSummary?: string;
}

export interface ToolStepRequest {
  role: string;
  promptVersion: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  inputSummary?: string;
  companyId?: string | null;
  searchRunId?: string | null;
  jobId?: string | null;
}

export interface ToolStepResult {
  message: Anthropic.Message;
  agentRunId: string;
  costUsd: number;
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
  budget: BudgetGuard;
}

/**
 * Unbrauchbare Antwort (Schema verletzt, kein JSON, abgeschnitten): einmal wiederholen (ARCHITECTURE.md 11.2).
 * API-Fehler (429/5xx, Netz) wiederholt bereits das SDK; Ablehnungen (refusal) werden nicht wiederholt.
 */
class BadOutputError extends Error {}

export const MAX_ATTEMPTS = 2;

function parseOutput<S extends z.ZodType>(
  response: Anthropic.Message,
  schema: S,
): { text: string; data: z.output<S> } {
  if (response.stop_reason === "refusal") throw new Error("Anfrage vom Modell abgelehnt (refusal)");
  if (response.stop_reason !== "end_turn") {
    throw new BadOutputError(`Antwort unvollständig (stop_reason: ${response.stop_reason})`);
  }
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) throw new BadOutputError("Antwort ohne Text");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BadOutputError("Antwort ist kein gültiges JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new BadOutputError(`Antwort verletzt das Schema: ${parsed.error.message}`);
  return { text, data: parsed.data };
}

export function createLlmGateway({ db, messages, models, budget }: LlmGatewayDeps) {
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

  async function startRun(
    req: Pick<
      StructuredRequest<z.ZodType>,
      "role" | "companyId" | "searchRunId" | "jobId" | "promptVersion" | "inputSummary"
    >,
    model: string,
    attempt: number,
  ): Promise<string> {
    const summary = req.inputSummary
      ? `${req.inputSummary}${attempt > 1 ? ` (Versuch ${attempt})` : ""}`
      : null;
    const { rows } = await db.query<{ id: string }>(
      `insert into agent_runs (role, company_id, search_run_id, job_id, model, prompt_version, input_summary, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'RUNNING') returning id`,
      [
        req.role,
        req.companyId ?? null,
        req.searchRunId ?? null,
        req.jobId ?? null,
        model,
        req.promptVersion,
        summary ? clip(summary) : null,
      ],
    );
    return rows[0]!.id;
  }

  return {
    /**
     * Ein Schritt einer Tool-Schleife (Manager-Agent): ein API-Aufruf mit Tools, geloggt wie jeder andere Aufruf.
     * Die Schleife selbst (Tools ausführen, Ergebnisse zurückgeben) liegt beim Aufrufer.
     */
    async toolStep(req: ToolStepRequest): Promise<ToolStepResult> {
      const roleConfig = models.roles[req.role];
      if (!roleConfig)
        throw new Error(`Keine Modell-Konfiguration für Rolle "${req.role}" (config/models.yaml)`);
      const model = roleConfig.model;
      await budget.assertAvailable();
      const runId = await startRun(req, model, 1);
      let response: Anthropic.Message | undefined;
      try {
        response = await messages.create({
          model,
          max_tokens: roleConfig.max_tokens,
          system: roleConfig.cache_system
            ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
            : req.system,
          messages: req.messages,
          tools: req.tools,
          ...(roleConfig.effort ? { output_config: { effort: roleConfig.effort } } : {}),
        });
        if (response.stop_reason === "refusal") throw new Error("Anfrage vom Modell abgelehnt (refusal)");
        const summary = response.content
          .map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? `[${b.name}]` : ""))
          .filter(Boolean)
          .join(" ");
        const cost = await finishRun(runId, "OK", model, usageOf(response), clip(summary), null);
        return { message: response, agentRunId: runId, costUsd: cost };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await finishRun(runId, "ERROR", model, usageOf(response), null, clip(message));
        throw new LlmError(`${req.role}: ${message}`, runId, { cause: err });
      }
    },

    /**
     * Ein Aufruf ohne Tools mit erzwungenem JSON-Schema. Jeder Versuch steht mit Kosten in agent_runs.
     * Wirft `BudgetExceededError` (vor dem Aufruf, nichts wird ausgegeben) oder `LlmError`.
     */
    async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.output<S>>> {
      const roleConfig = models.roles[req.role];
      if (!roleConfig)
        throw new Error(`Keine Modell-Konfiguration für Rolle "${req.role}" (config/models.yaml)`);
      const model = roleConfig.model;
      let totalCost = 0;

      for (let attempt = 1; ; attempt++) {
        await budget.assertAvailable();
        const runId = await startRun(req, model, attempt);
        let response: Anthropic.Message | undefined;
        try {
          response = await messages.create({
            model,
            max_tokens: roleConfig.max_tokens,
            system: roleConfig.cache_system
              ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
              : req.system,
            messages: [{ role: "user", content: req.input }],
            output_config: {
              format: zodOutputFormat(req.schema),
              ...(roleConfig.effort ? { effort: roleConfig.effort } : {}),
            },
          });
          const { text, data } = parseOutput(response, req.schema);
          totalCost += await finishRun(runId, "OK", model, usageOf(response), clip(text), null);
          return { output: data, agentRunId: runId, costUsd: totalCost, model };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          totalCost += await finishRun(runId, "ERROR", model, usageOf(response), null, clip(message));
          if (err instanceof BadOutputError && attempt < MAX_ATTEMPTS) continue;
          throw new LlmError(`${req.role}: ${message}`, runId, { cause: err });
        }
      }
    },
  };
}

export type LlmGateway = ReturnType<typeof createLlmGateway>;
