// Thin wrapper over the Anthropic SDK.
//
// Everything AI in this product is optional. If no key is configured the app
// still runs end to end: extraction falls back to deterministic table parsing
// and the narrative falls back to a rules engine driven by the model's own flag
// definitions. That is not a demo trick — it is what lets an investment
// committee run the tool with documents they will not send to a third party.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.ts";

let client: Anthropic | null = null;

export function anthropic(): Anthropic | null {
  if (!env.aiEnabled) return null;
  if (!client) {
    client = new Anthropic({
      apiKey: env.anthropicKey,
      maxRetries: 3,
      timeout: 120_000,
    });
  }
  return client;
}

export interface ToolCallResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs: number;
  raw?: unknown;
}

/**
 * One structured-output call. The schema is enforced by the API through a
 * forced tool call, so the response either parses or the call failed — there is
 * no "the model returned prose instead of JSON" branch to write.
 */
export async function structuredCall<T>(options: {
  system: string;
  messages: Anthropic.MessageParam[];
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<ToolCallResult<T>> {
  const started = performance.now();
  const api = anthropic();

  if (!api) {
    return {
      ok: false,
      error: "No ANTHROPIC_API_KEY configured",
      durationMs: 0,
    };
  }

  try {
    const response = await api.messages.create({
      model: env.model,
      max_tokens: options.maxTokens ?? 8000,
      system: options.system,
      messages: options.messages,
      tools: [
        {
          name: options.toolName,
          description: options.toolDescription,
          input_schema: options.schema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: options.toolName },
    });

    const block = response.content.find((c) => c.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      return {
        ok: false,
        error: "Model did not return structured output",
        durationMs: Math.round(performance.now() - started),
        raw: response.content,
      };
    }

    return {
      ok: true,
      data: block.input as T,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      durationMs: Math.round(performance.now() - started),
      raw: block.input,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - started),
    };
  }
}

export function aiAvailable(): boolean {
  return env.aiEnabled;
}
