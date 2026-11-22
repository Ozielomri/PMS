/**
 * The LLM behind the AI agent, as a small interface so the rest of the app (and the tests) never
 * depend on a vendor SDK. src/lib/ai/anthropic.ts is the production implementation.
 */

export interface LlmRequest {
  system: string;
  prompt: string;
  /** JSON schema the answer must follow (structured output). */
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface LlmResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  name: string;
  generate(request: LlmRequest): Promise<LlmResult>;
}

/** The model declined the request (safety classifier); show a neutral message, do not retry. */
export class LlmRefusalError extends Error {
  constructor(readonly category: string | null) {
    super("The AI declined to draft this reply.");
    this.name = "LlmRefusalError";
  }
}
