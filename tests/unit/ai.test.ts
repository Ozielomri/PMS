import { describe, expect, it, vi } from "vitest";

import { anthropicProvider } from "@/lib/ai/anthropic";
import { aiStatus } from "@/lib/ai/config";
import { LlmRefusalError, type LlmProvider } from "@/lib/ai/provider";
import { DRAFT_SCHEMA, buildDraftPrompt, draftReply, parseDraft, type DraftInput } from "@/lib/ai/reply-draft";

const INPUT: DraftInput = {
  accountName: "Sunny Stays",
  guestFirstName: "Ada",
  language: "en",
  reservation: { code: "RABC2345", status: "confirmed", check_in: "2026-12-04", check_out: "2026-12-07", nights: 3, adults: 2, children: 0, pets: 0, eta: null, etd: null },
  listing: { title: "Ocean Breeze", city: "Destin", state: "FL", address: "412 Gulf Shore Dr", check_in_from: "4:00 PM", check_in_to: "10:00 PM", check_out_by: "10:00 AM", max_guests: 6 },
  descriptions: { summary: "Steps to the beach.", house_rules: "No parties. Quiet after 10 PM.", access_notes: null, space: null, neighborhood: null, transit: null },
  amenities: ["Wi-Fi", "Free parking"],
  customFields: [
    { key: "parking", label: "Parking", type: "text", value: "Two spots in the driveway" },
    { key: "door_code", label: "Door code", type: "secret", value: "4821" },
  ],
  thread: [
    { kind: "inbound", author: "Ada", body: "Hi! Can we park two cars?", at: "2026-11-23T12:00:00Z" },
    { kind: "note", author: "Team", body: "VIP, comp late check-out", at: "2026-11-23T12:01:00Z" },
  ],
};

describe("reply draft prompt (INB-11)", () => {
  it("grounds in thread, reservation and listing, and never includes secret fields or internal notes", () => {
    const { system, prompt, grounding } = buildDraftPrompt(INPUT);
    expect(system).toMatch(/only the facts/i);
    expect(prompt).toContain("Two spots in the driveway");
    expect(prompt).toContain("No parties");
    expect(prompt).toContain("Can we park two cars?");
    expect(prompt).not.toContain("4821");
    expect(prompt).not.toContain("door_code");
    expect(prompt).not.toContain("VIP, comp late check-out");
    expect(grounding).toEqual({
      reservation: true,
      listing: ["title", "city", "state", "address", "check_in_from", "check_in_to", "check_out_by", "max_guests"],
      descriptions: ["summary", "house_rules"],
      amenities: 2,
      custom_fields: ["parking"],
      thread_messages: 1,
    });
  });

  it("parses the model's JSON and rejects junk", () => {
    expect(parseDraft('{"reply":"Yes, two spots.","confidence":"high","needs_human":false,"reasoning_summary":"Parking field."}')).toEqual({
      reply: "Yes, two spots.",
      confidence: "high",
      needsHuman: false,
      reasoningSummary: "Parking field.",
    });
    expect(() => parseDraft("not json")).toThrow(/could not read/);
    expect(() => parseDraft('{"reply":""}')).toThrow(/could not read/);
  });

  it("drafts through the provider interface", async () => {
    const provider: LlmProvider = {
      name: "fake",
      generate: vi.fn().mockResolvedValue({
        text: '{"reply":"Hi Ada, yes: two spots in the driveway.","confidence":"high","needs_human":false,"reasoning_summary":"Parking custom field."}',
        model: "claude-opus-5-5",
        inputTokens: 900,
        outputTokens: 60,
      }),
    };
    const result = await draftReply(provider, INPUT);
    expect(result).toMatchObject({ draft: { reply: "Hi Ada, yes: two spots in the driveway.", needsHuman: false }, model: "claude-opus-5-5", inputTokens: 900, outputTokens: 60 });
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ schema: DRAFT_SCHEMA }));
  });
});

describe("Anthropic provider", () => {
  function fakeClient(response: Record<string, unknown>) {
    return { beta: { messages: { create: vi.fn().mockResolvedValue(response) } } };
  }

  it("calls the Messages API with structured output and the refusal fallback", async () => {
    const client = fakeClient({
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"reply":"x"}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = anthropicProvider({ apiKey: "test", model: "claude-opus-5-5", client: client as never });
    const res = await provider.generate({ system: "S", prompt: "P", schema: DRAFT_SCHEMA, maxTokens: 16000 });
    expect(res).toEqual({ text: '{"reply":"x"}', model: "claude-opus-5-5", inputTokens: 10, outputTokens: 5 });
    const params = client.beta.messages.create.mock.calls[0][0];
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: DRAFT_SCHEMA } },
      messages: [{ role: "user", content: "P" }],
    });
    expect(params.system[0]).toMatchObject({ type: "text", text: "S" });
    expect(params).not.toHaveProperty("thinking");
  });

  it("turns a refusal into a typed error", async () => {
    const client = fakeClient({ model: "m", stop_reason: "refusal", stop_details: { category: "cyber" }, content: [], usage: { input_tokens: 1, output_tokens: 0 } });
    const provider = anthropicProvider({ apiKey: "test", model: "claude-opus-5-5", client: client as never });
    await expect(provider.generate({ system: "S", prompt: "P", schema: DRAFT_SCHEMA, maxTokens: 100 })).rejects.toBeInstanceOf(LlmRefusalError);
  });
});

describe("AI configuration", () => {
  it("is off without an API key and explains why", () => {
    expect(aiStatus({})).toEqual({ enabled: false, reason: "AI suggestions are off: ANTHROPIC_API_KEY is not set on the server." });
    expect(aiStatus({ ANTHROPIC_API_KEY: "k" })).toEqual({ enabled: false, reason: "AI suggestions are off: SUPABASE_SECRET_KEY is not set on the server." });
    expect(aiStatus({ ANTHROPIC_API_KEY: "k", SUPABASE_SECRET_KEY: "s" })).toEqual({ enabled: true, model: "claude-opus-5-5" });
    expect(aiStatus({ ANTHROPIC_API_KEY: "k", SUPABASE_SECRET_KEY: "s", ANTHROPIC_MODEL: "claude-sonnet-5-5" })).toEqual({ enabled: true, model: "claude-sonnet-5-5" });
  });
});
