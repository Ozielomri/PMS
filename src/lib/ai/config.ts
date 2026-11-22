/**
 * Whether AI suggestions can run on this server. Read lazily so builds work without secrets.
 * The draft is stored by the agent through the service role, so SUPABASE_SECRET_KEY is needed too.
 */
import { DEFAULT_MODEL } from "@/lib/ai/anthropic";

export type AiStatus = { enabled: true; model: string } | { enabled: false; reason: string };

export function aiStatus(env: Record<string, string | undefined> = process.env): AiStatus {
  if (!env.ANTHROPIC_API_KEY) return { enabled: false, reason: "AI suggestions are off: ANTHROPIC_API_KEY is not set on the server." };
  if (!env.SUPABASE_SECRET_KEY) return { enabled: false, reason: "AI suggestions are off: SUPABASE_SECRET_KEY is not set on the server." };
  return { enabled: true, model: env.ANTHROPIC_MODEL || DEFAULT_MODEL };
}
