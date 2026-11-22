import { NextResponse, type NextRequest } from "next/server";

import { emailConfig, emailProvider } from "@/lib/inbox/config";
import { ingestInboundEmail } from "@/lib/inbox/email/ingest";
import { isAuthorizedInboxWebhook } from "@/lib/inbox/email/webhook-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

/**
 * Inbound email webhook (Postmark inbound stream, or the generic JSON format of the log adapter).
 * Authorized with INBOX_WEBHOOK_SECRET (Bearer, Basic password or X-PMS-Signature HMAC). Every
 * email is stored, matched or not; provider retries are idempotent.
 */
export async function POST(request: NextRequest) {
  const body = await request.text();
  if (
    !isAuthorizedInboxWebhook({
      authorization: request.headers.get("authorization"),
      signature: request.headers.get("x-pms-signature"),
      body,
      secret: process.env.INBOX_WEBHOOK_SECRET ?? "",
    })
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const provider = emailProvider();
  let inbound;
  try {
    inbound = provider.parseInbound(payload);
  } catch (err) {
    // 4xx: the provider should not retry a payload that can never parse.
    return NextResponse.json({ error: (err as Error).message }, { status: 422 });
  }
  const result = await ingestInboundEmail(createAdminClient({ type: "channel", id: "email" }), provider.name, inbound, emailConfig().inboundDomain);
  return NextResponse.json(result);
}
