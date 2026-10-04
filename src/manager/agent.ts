import type Anthropic from "@anthropic-ai/sdk";
import { insertMessage, recentMessages } from "../db/messages.js";
import { loadPrompt } from "../llm/config.js";
import { BudgetExceededError } from "../llm/budget.js";
import { LlmError, type LlmGateway } from "../llm/gateway.js";
import type { PipelineContext } from "../queue/pipeline.js";
import { availableRegions, runTool, toolDefinitions } from "./tools.js";

/**
 * Manager-Agent (ARCHITECTURE.md 10): Claude-Tool-Schleife über die Werkzeuge aus tools.ts. Gedächtnis ist der
 * gespeicherte Chat-Verlauf (nur Text, keine Tool-Details), damit jeder Turn klein und günstig bleibt.
 */

export const MANAGER_PROMPT_VERSION = "v4";
const HISTORY_MESSAGES = 12;
const MAX_TOOL_ROUNDS = 6;

export interface ManagerDeps {
  ctx: PipelineContext;
  llm: LlmGateway;
}

export interface ManagerReply {
  text: string;
  toolCalls: { name: string; input: unknown; isError: boolean }[];
  costUsd: number;
}

/** Verlauf → abwechselnde user/assistant-Nachrichten (aufeinanderfolgende gleiche Rollen zusammengefasst). */
export function historyToMessages(
  history: { direction: "IN" | "OUT"; text: string | null }[],
): Anthropic.MessageParam[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of history) {
    if (!m.text) continue;
    const role = m.direction === "IN" ? "user" : "assistant";
    const last = out.at(-1);
    if (last && last.role === role) last.content = `${last.content}\n\n${m.text}`;
    else out.push({ role, content: m.text });
  }
  while (out[0]?.role === "assistant") out.shift(); // muss mit user beginnen
  return out;
}

function systemPrompt(now: Date): string {
  const date = now.toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    dateStyle: "full",
    timeStyle: "short",
  });
  return `${loadPrompt("manager", MANAGER_PROMPT_VERSION)}\n\nEingerichtete Regionen: ${availableRegions().join(", ")}.\nJetzt: ${date}.`;
}

export async function askManager(deps: ManagerDeps, chatId: number, userText: string): Promise<ManagerReply> {
  const { ctx, llm } = deps;
  const history = await recentMessages(ctx.db, chatId, HISTORY_MESSAGES);
  await insertMessage(ctx.db, { chatId, direction: "IN", text: userText });

  const messages = historyToMessages([...history, { direction: "IN", text: userText }]);
  const tools = toolDefinitions();
  const toolCalls: ManagerReply["toolCalls"] = [];
  let costUsd = 0;
  let text: string;

  try {
    for (let round = 0; ; round++) {
      const step = await llm.toolStep({
        role: "manager",
        promptVersion: MANAGER_PROMPT_VERSION,
        system: systemPrompt(ctx.now()),
        messages,
        tools,
        inputSummary: `Chat: ${userText.slice(0, 120)}`,
      });
      costUsd += step.costUsd;
      const response = step.message;
      // Vollständige Antwort (inkl. Denk-Blöcke) anhängen, damit die Schleife konsistent bleibt.
      messages.push({ role: "assistant", content: response.content });
      text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || uses.length === 0) break;
      if (round >= MAX_TOOL_ROUNDS) {
        text ||= "Das wird mir zu verschachtelt – frag bitte etwas konkreter.";
        break;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const r = await runTool(use.name, use.input, { ctx, chatId });
        toolCalls.push({ name: use.name, input: use.input, isError: r.isError });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: r.text,
          ...(r.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) text = `⚠️ ${err.message}. Ich kann gerade nicht antworten.`;
    else if (err instanceof LlmError)
      text = "Da ist bei mir gerade etwas schiefgegangen. Versuch es bitte gleich noch einmal.";
    else throw err;
  }

  text ||= "Erledigt.";
  await insertMessage(ctx.db, {
    chatId,
    direction: "OUT",
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  });
  return { text, toolCalls, costUsd };
}
