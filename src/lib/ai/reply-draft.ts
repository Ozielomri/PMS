/**
 * INB-11 AI reply draft. Grounded only in the thread (guest messages and our replies, not internal
 * notes), the reservation (no money, no contact details) and the listing's content and non-secret
 * custom fields. The draft goes to the approval queue and the composer; it is never sent by the
 * agent in this step.
 *
 * Privacy (TODO.md): only the guest's first name leaves the server; secret custom fields (door
 * codes) are never included, whatever the caller passes.
 */
import { z } from "zod";

import type { LlmProvider } from "@/lib/ai/provider";

export interface DraftInput {
  accountName: string;
  guestFirstName: string | null;
  language: string | null;
  reservation: {
    code: string;
    status: string;
    check_in: string;
    check_out: string;
    nights: number;
    adults: number;
    children: number;
    pets: number;
    eta: string | null;
    etd: string | null;
  } | null;
  listing: Record<"title" | "city" | "state" | "address" | "check_in_from" | "check_in_to" | "check_out_by", string | null> & { max_guests: number | null } | null;
  descriptions: Record<"summary" | "space" | "neighborhood" | "transit" | "house_rules" | "access_notes", string | null> | null;
  amenities: string[];
  customFields: { key: string; label: string; type: string; value: string }[];
  thread: { kind: "inbound" | "outbound" | "note"; author: string; body: string; at: string }[];
  /** What the team wants this message to do (automation "ask the agent" rules). */
  instructions?: string | null;
}

export interface Draft {
  reply: string;
  confidence: "high" | "medium" | "low";
  needsHuman: boolean;
  reasoningSummary: string;
}

export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "The reply to the guest, plain text, ready to send." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    needs_human: { type: "boolean", description: "True when the answer needs information or a decision the facts do not give." },
    reasoning_summary: { type: "string", description: "One or two sentences for the host: which facts the reply relies on, or what is missing." },
  },
  required: ["reply", "confidence", "needs_human", "reasoning_summary"],
  additionalProperties: false,
} as const;

const SYSTEM = `You draft replies to guests for a short-term rental company. A team member reads every draft, edits it if needed and sends it; you never send anything yourself.

Rules:
- Use only the facts given in <reservation>, <listing>, <descriptions>, <amenities>, <custom_fields> and the conversation. Never guess times, prices, codes, addresses or policies.
- If the guest asks something the facts do not answer, or asks for a decision (discounts, refunds, date changes, early check-in or late check-out that is not stated, exceptions to house rules), say the team will check and get back to them, and set needs_human to true.
- Door codes, lockbox codes and Wi-Fi passwords are never in your facts; if the guest asks for one, say it will be sent before arrival and set needs_human to true.
- Answer the guest's latest message. Write in the language of that message.
- Plain text, no markdown. Warm, brief and specific: usually two to five sentences. Greet the guest by first name if known; sign off with the company name.`;

function section(tag: string, value: unknown): string {
  return `<${tag}>\n${JSON.stringify(value, null, 2)}\n</${tag}>`;
}

function present<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== "")) as Partial<T>;
}

export function buildDraftPrompt(input: DraftInput) {
  const listing = input.listing ? present(input.listing) : null;
  const descriptions = input.descriptions ? present(input.descriptions) : null;
  const custom = input.customFields.filter((f) => f.type !== "secret" && f.value.trim() !== "");
  const thread = input.thread.filter((m) => m.kind !== "note").slice(-20);

  const parts = [
    `Company: ${input.accountName}`,
    `Guest first name: ${input.guestFirstName ?? "unknown"}${input.language ? ` (profile language: ${input.language})` : ""}`,
    section("reservation", input.reservation ?? "No reservation yet (inquiry)."),
    section("listing", listing ?? "Unknown listing."),
    section("descriptions", descriptions ?? {}),
    section("amenities", input.amenities),
    section("custom_fields", Object.fromEntries(custom.map((f) => [f.label, f.value]))),
    "<conversation>",
    ...thread.map((m) => `[${m.at}] ${m.kind === "inbound" ? `Guest (${m.author})` : `Team (${m.author})`}:\n${m.body.slice(0, 2000)}`),
    "</conversation>",
    input.instructions
      ? `<team_instructions>\n${input.instructions.slice(0, 2000)}\n</team_instructions>\n\nDraft the next message from the team, following the team instructions above.`
      : "Draft the next reply from the team.",
  ];

  return {
    system: SYSTEM,
    prompt: parts.join("\n\n"),
    grounding: {
      reservation: Boolean(input.reservation),
      listing: listing ? Object.keys(listing) : [],
      descriptions: descriptions ? Object.keys(descriptions) : [],
      amenities: input.amenities.length,
      custom_fields: custom.map((f) => f.key),
      thread_messages: thread.length,
      ...(input.instructions ? { instructions: true } : {}),
    },
  };
}

const draftSchema = z.object({
  reply: z.string().trim().min(1).max(20000),
  confidence: z.enum(["high", "medium", "low"]).catch("low"),
  needs_human: z.boolean().catch(true),
  reasoning_summary: z.string().max(4000).catch(""),
});

export function parseDraft(text: string): Draft {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The AI answer could not read as a draft.");
  }
  const parsed = draftSchema.safeParse(json);
  if (!parsed.success) throw new Error("The AI answer could not read as a draft.");
  return { reply: parsed.data.reply, confidence: parsed.data.confidence, needsHuman: parsed.data.needs_human, reasoningSummary: parsed.data.reasoning_summary };
}

export async function draftReply(provider: LlmProvider, input: DraftInput) {
  const { system, prompt, grounding } = buildDraftPrompt(input);
  const result = await provider.generate({ system, prompt, schema: DRAFT_SCHEMA, maxTokens: 16000 });
  return { draft: parseDraft(result.text), model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, grounding };
}
