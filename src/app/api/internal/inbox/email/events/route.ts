import { NextResponse, type NextRequest } from "next/server";

import { emailProvider } from "@/lib/inbox/config";
import { isAuthorizedInboxWebhook } from "@/lib/inbox/email/webhook-auth";
import { createAdminClient } from "@/lib/supabase/admin";

/** INB-10 delivery and bounce webhooks from the email provider → delivered / failed with reason. */
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
  const event = provider.parseEvent(payload);
  if (!event) return NextResponse.json({ ignored: true });
  const { data, error } = await createAdminClient({ type: "channel", id: "email" }).rpc("record_delivery_event", {
    p_provider: provider.name,
    p_provider_message_id: event.providerMessageId,
    p_status: event.status,
    p_reason: event.reason,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ updated: data });
}
