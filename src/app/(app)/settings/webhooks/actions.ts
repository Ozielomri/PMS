"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/context";
import { encryptSecret, generateToken, parseKey } from "@/lib/crypto/secrets";
import { serverEnv } from "@/lib/env";
import { isValidEventPattern } from "@/lib/events/catalog";
import { createClient } from "@/lib/supabase/server";
import { validateWebhookUrl } from "@/lib/webhooks/url-guard";

export type WebhookActionResult = { ok?: boolean; error?: string; secret?: string } | null;

const PATH = "/settings/webhooks";

function newSecret(endpointId: string) {
  const secret = generateToken("whsec_");
  const ciphertext = encryptSecret(secret, parseKey(serverEnv().encryptionKey), endpointId);
  return { secret, ciphertext, last4: secret.slice(-4) };
}

export async function createEndpoint(_prev: WebhookActionResult, formData: FormData): Promise<WebhookActionResult> {
  const auth = await authorizeAction("webhooks.manage");
  if (!auth.ok) return { error: auth.error };

  const patterns = formData.getAll("eventTypes").map(String);
  const parsed = z
    .object({
      url: z.string().trim().min(1, "Enter a URL"),
      description: z.string().trim().max(500).optional(),
      eventTypes: z.array(z.string()).min(1, "Choose at least one event"),
    })
    .safeParse({ url: formData.get("url"), description: formData.get("description") || undefined, eventTypes: patterns });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const urlCheck = validateWebhookUrl(parsed.data.url, { allowPrivateNetworks: serverEnv().webhooksAllowPrivateNetworks });
  if (!urlCheck.ok) return { error: urlCheck.reason };
  const invalid = parsed.data.eventTypes.find((p) => !isValidEventPattern(p));
  if (invalid) return { error: `Unknown event type: ${invalid}` };

  const id = randomUUID();
  const { secret, ciphertext, last4 } = newSecret(id);
  const supabase = await createClient();
  const { error } = await supabase.from("webhook_endpoints").insert({
    id,
    account_id: auth.ctx.active.accountId,
    url: urlCheck.url.toString(),
    description: parsed.data.description ?? null,
    event_types: parsed.data.eventTypes,
    secret_ciphertext: ciphertext,
    secret_last4: last4,
  });
  if (error) return { error: "Could not save the endpoint." };

  revalidatePath(PATH);
  return { ok: true, secret };
}

export async function setEndpointActive(formData: FormData): Promise<void> {
  const auth = await authorizeAction("webhooks.manage");
  if (!auth.ok) return;
  const supabase = await createClient();
  await supabase
    .from("webhook_endpoints")
    .update({ active: formData.get("active") === "true" })
    .eq("id", String(formData.get("endpointId")))
    .eq("account_id", auth.ctx.active.accountId);
  revalidatePath(PATH);
}

export async function rotateSecret(_prev: WebhookActionResult, formData: FormData): Promise<WebhookActionResult> {
  const auth = await authorizeAction("webhooks.manage");
  if (!auth.ok) return { error: auth.error };
  const endpointId = z.guid().safeParse(formData.get("endpointId"));
  if (!endpointId.success) return { error: "Invalid endpoint." };

  const { secret, ciphertext, last4 } = newSecret(endpointId.data);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("webhook_endpoints")
    .update({ secret_ciphertext: ciphertext, secret_last4: last4 })
    .eq("id", endpointId.data)
    .eq("account_id", auth.ctx.active.accountId)
    .select("id");
  if (error || !data?.length) return { error: "Could not rotate the secret." };
  revalidatePath(PATH);
  return { ok: true, secret };
}

export async function redeliver(formData: FormData): Promise<void> {
  const auth = await authorizeAction("webhooks.manage");
  if (!auth.ok) return;
  const supabase = await createClient();
  await supabase.rpc("redeliver_webhook", { p_delivery_id: String(formData.get("deliveryId")) });
  revalidatePath(PATH);
}
