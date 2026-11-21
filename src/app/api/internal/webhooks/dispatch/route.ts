import { NextResponse, type NextRequest } from "next/server";

import { parseKey } from "@/lib/crypto/secrets";
import { serverEnv } from "@/lib/env";
import { isAuthorizedCronRequest } from "@/lib/internal/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchWebhooks } from "@/lib/webhooks/dispatcher";
import { supabaseDeliveryStore } from "@/lib/webhooks/supabase-store";

export const maxDuration = 60;

/** Sends due webhook deliveries. Schedule every minute; overlapping runs are safe. */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET ?? "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const env = serverEnv();
  const summary = await dispatchWebhooks({
    store: supabaseDeliveryStore(createAdminClient({ type: "system", id: "webhook-dispatcher" })),
    encryptionKey: parseKey(env.encryptionKey),
    allowPrivateNetworks: env.webhooksAllowPrivateNetworks,
    limit: 100,
  });
  return NextResponse.json(summary);
}

export const GET = handle;
export const POST = handle;
