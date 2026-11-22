"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/context";
import { encryptSecret, parseKey } from "@/lib/crypto/secrets";
import { serverEnv } from "@/lib/env";
import { syncFeed, type SyncResult } from "@/lib/ical/sync";
import { feedUrlDisplay, feedUrlHash, newExportToken, sha256Hex } from "@/lib/ical/urls";
import { createClient } from "@/lib/supabase/server";
import { validatePublicUrl } from "@/lib/webhooks/url-guard";

export type IcalActionResult = { ok?: boolean; error?: string; message?: string } | null;

const guid = z.guid();
const path = (listingId: string) => `/properties/${listingId}`;

function dbError(message: string | undefined): string {
  if (!message) return "Something went wrong. Try again.";
  if (/forbidden/.test(message)) return "You do not have permission to do that.";
  if (/ical_feed_exists/.test(message)) return "This listing already imports that URL.";
  if (/too_many_feeds/.test(message)) return "A listing can import at most 20 feeds.";
  if (/listing_not_bookable/.test(message)) return message.replace(/^listing_not_bookable: /, "This listing cannot do that: ").replace(/\.?$/, ".");
  return "Something went wrong. Try again.";
}

function encryptionKey(): Buffer | null {
  try {
    return parseKey(serverEnv().encryptionKey);
  } catch {
    return null;
  }
}

function summary(r: SyncResult): string {
  if (r.unchanged) return `Feed unchanged since the last import (${r.events} event${r.events === 1 ? "" : "s"}).`;
  const parts = [`${r.placed} added`, `${r.moved} changed`, `${r.released} removed`];
  if (r.restored) parts.push(`${r.restored} restored`);
  return `Imported ${r.events} event${r.events === 1 ? "" : "s"}: ${parts.join(", ")}.${r.conflicts ? ` ${r.conflicts} overlap${r.conflicts === 1 ? "s" : ""} a booking — see below.` : ""}`;
}

/** CAL-09: create the export URL, or rotate it (the old one stops working at once). */
export async function createExportUrl(_prev: IcalActionResult, formData: FormData): Promise<IcalActionResult> {
  const listingId = guid.safeParse(formData.get("listingId"));
  if (!listingId.success) return { error: "Invalid listing." };
  const auth = await authorizeAction("calendar.manage");
  if (!auth.ok) return { error: auth.error };
  const key = encryptionKey();
  if (!key) return { error: "PMS_ENCRYPTION_KEY is not configured on the server." };

  const id = randomUUID();
  const token = newExportToken();
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_ical_export", {
    p_export_id: id,
    p_listing_id: listingId.data,
    p_token_hash: sha256Hex(token),
    p_token_ciphertext: encryptSecret(token, key, id),
    p_token_hint: token.slice(-4),
  });
  if (error) return { error: dbError(error.message) };
  revalidatePath(path(listingId.data));
  return { ok: true, message: formData.get("rotate") === "1" ? "New URL created. The old one no longer works." : "Export URL created." };
}

export async function revokeExportUrl(_prev: IcalActionResult, formData: FormData): Promise<IcalActionResult> {
  const exportId = guid.safeParse(formData.get("exportId"));
  const listingId = guid.safeParse(formData.get("listingId"));
  if (!exportId.success || !listingId.success) return { error: "Invalid export." };
  const auth = await authorizeAction("calendar.manage");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_ical_export", { p_export_id: exportId.data });
  if (error) return { error: dbError(error.message) };
  revalidatePath(path(listingId.data));
  return { ok: true, message: "Export URL revoked." };
}

const feedSchema = z.object({
  listingId: z.guid(),
  name: z.string().trim().min(1, "Name the feed, e.g. Airbnb.").max(100, "Keep the name under 100 characters."),
  url: z.string().trim().min(1, "Paste the feed URL.").max(2000, "That URL is too long."),
});

async function runSync(feedId: string, key: Buffer): Promise<IcalActionResult> {
  const supabase = await createClient();
  const { data: feed } = await supabase.from("ical_feeds").select("id, listing_id, url_ciphertext, etag, last_modified").eq("id", feedId).maybeSingle();
  if (!feed) return { error: "Feed not found." };
  const { data: listing } = await supabase.from("listings").select("timezone, parent_id").eq("id", feed.listing_id).maybeSingle();
  let timeZone = listing?.timezone as string | undefined;
  if (listing?.parent_id) {
    const { data: parent } = await supabase.from("listings").select("timezone").eq("id", listing.parent_id).maybeSingle();
    timeZone = (parent?.timezone as string | undefined) ?? timeZone;
  }
  const outcome = await syncFeed(
    supabase,
    { feedId, urlCiphertext: feed.url_ciphertext, etag: feed.etag, lastModified: feed.last_modified, timeZone: timeZone ?? "America/New_York" },
    { encryptionKey: key, fetch: { allowPrivateNetworks: serverEnv().webhooksAllowPrivateNetworks } },
  );
  revalidatePath(path(feed.listing_id));
  revalidatePath("/calendar", "layout");
  return outcome.ok ? { ok: true, message: summary(outcome.result) } : { error: `Import failed: ${outcome.error}` };
}

/** CAL-10: subscribe to an external feed, then import it right away. */
export async function addFeed(_prev: IcalActionResult, formData: FormData): Promise<IcalActionResult> {
  const parsed = feedSchema.safeParse({ listingId: formData.get("listingId"), name: formData.get("name"), url: formData.get("url") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const auth = await authorizeAction("calendar.manage");
  if (!auth.ok) return { error: auth.error };
  const key = encryptionKey();
  if (!key) return { error: "PMS_ENCRYPTION_KEY is not configured on the server." };

  // Calendar apps hand out webcal:// links; they are plain https.
  const raw = parsed.data.url.replace(/^webcals?:\/\//i, "https://");
  const check = validatePublicUrl(raw, { allowPrivateNetworks: serverEnv().webhooksAllowPrivateNetworks, label: "iCal feed URLs" });
  if (!check.ok) return { error: check.reason };

  const id = randomUUID();
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_ical_feed", {
    p_feed_id: id,
    p_listing_id: parsed.data.listingId,
    p_name: parsed.data.name,
    p_url_ciphertext: encryptSecret(check.url.toString(), key, id),
    p_url_hash: feedUrlHash(check.url),
    p_url_display: feedUrlDisplay(check.url),
  });
  if (error) return { error: dbError(error.message) };
  const first = await runSync(id, key);
  revalidatePath(path(parsed.data.listingId));
  return first?.ok ? { ok: true, message: `Feed added. ${first.message}` } : { ok: true, message: `Feed added. ${first?.error ?? ""}`.trim() };
}

export async function syncFeedNow(_prev: IcalActionResult, formData: FormData): Promise<IcalActionResult> {
  const feedId = guid.safeParse(formData.get("feedId"));
  if (!feedId.success) return { error: "Invalid feed." };
  const auth = await authorizeAction("calendar.manage");
  if (!auth.ok) return { error: auth.error };
  const key = encryptionKey();
  if (!key) return { error: "PMS_ENCRYPTION_KEY is not configured on the server." };
  return runSync(feedId.data, key);
}

export async function removeFeed(_prev: IcalActionResult, formData: FormData): Promise<IcalActionResult> {
  const feedId = guid.safeParse(formData.get("feedId"));
  const listingId = guid.safeParse(formData.get("listingId"));
  if (!feedId.success || !listingId.success) return { error: "Invalid feed." };
  const auth = await authorizeAction("calendar.manage");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("remove_ical_feed", { p_feed_id: feedId.data });
  if (error) return { error: dbError(error.message) };
  revalidatePath(path(listingId.data));
  revalidatePath("/calendar", "layout");
  const n = Number(data ?? 0);
  return { ok: true, message: `Feed removed${n ? `; ${n} imported block${n === 1 ? "" : "s"} released` : ""}.` };
}
