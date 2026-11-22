/**
 * Anthropic implementation of LlmProvider (official SDK, ANTHROPIC_API_KEY). Structured output
 * via output_config.format; server-side refusal fallback on, so a declined request is retried on a
 * fallback model inside the same call.
 */
import Anthropic from "@anthropic-ai/sdk";

import { LlmRefusalError, type LlmProvider } from "@/lib/ai/provider";

export const DEFAULT_MODEL = "claude-opus-5-5";

type Client = Pick<Anthropic, "beta">;

export function anthropicProvider(opts: { apiKey: string; model?: string; client?: Client }): LlmProvider {
  const client: Client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 60_000 });
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    name: "anthropic",
    async generate(request) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: request.maxTokens,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // The instructions are the same for every draft: cacheable prefix.
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        // Routine guest replies: medium effort (set explicitly; thinking stays adaptive).
        output_config: { effort: "medium", format: { type: "json_schema", schema: request.schema } },
        messages: [{ role: "user", content: request.prompt }],
      });
      if (response.stop_reason === "refusal") {
        throw new LlmRefusalError(response.stop_details?.category ?? null);
      }
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    },
  };
}
