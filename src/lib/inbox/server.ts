import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DraftInput } from "@/lib/ai/reply-draft";
import { parseKey } from "@/lib/crypto/secrets";
import { emailConfig, emailProvider } from "@/lib/inbox/config";
import { processOutbox, supabaseOutboxStore } from "@/lib/inbox/outbox";
import { buildMessageVariables, type VariableGuest, type VariableReservation } from "@/lib/inbox/variables";
import { supabaseVariableStore } from "@/lib/properties/queries";
import { resolveListingVariables, type ListingVariableStore } from "@/lib/properties/variables";
import { createAdminClient } from "@/lib/supabase/admin";

export interface ConversationRow {
  id: string;
  account_id: string;
  reservation_id: string | null;
  guest_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  channel: string;
  subject: string | null;
  status: "open" | "done";
  assignee_user_id: string | null;
  tags: string[];
  awaiting_reply_since: string | null;
  last_guest_message_at: string | null;
  reply_token: string;
  created_at: string;
}

export interface ReservationContext extends VariableReservation {
  id: string;
  listing_id: string;
  unit_id: string | null;
  stay_status: string | null;
  source: string;
  pets: number;
  infants: number;
  approval_deadline: string | null;
  kind: string;
  listing: { id: string; internal_name: string; timezone: string; parent_id: string | null } | null;
}

export interface ConversationContext {
  conversation: ConversationRow;
  guest: (VariableGuest & { id: string; notes: string | null; tags: string[] }) | null;
  reservation: ReservationContext | null;
  accountName: string;
}

/** Loads a conversation with its guest and reservation as the signed-in user (RLS applies). */
export async function loadConversationContext(supabase: SupabaseClient, conversationId: string): Promise<ConversationContext | null> {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return null;
  const { data: conversation } = await supabase.from("conversations").select("*").eq("id", conversationId).maybeSingle<ConversationRow>();
  if (!conversation) return null;
  const [{ data: guest }, { data: reservation }, { data: account }] = await Promise.all([
    conversation.guest_id
      ? supabase.from("guests").select("id, first_name, last_name, email, phone, language, notes, tags").eq("id", conversation.guest_id).maybeSingle<NonNullable<ConversationContext["guest"]>>()
      : Promise.resolve({ data: null }),
    conversation.reservation_id
      ? supabase
          .from("reservations")
          .select(
            "id, code, status, stay_status, kind, source, check_in, check_out, nights, adults, children, infants, pets, eta, etd, listing_id, unit_id, approval_deadline, " +
              "listing:listings!reservations_listing_id_account_id_fkey(id, internal_name, timezone, parent_id)",
          )
          .eq("id", conversation.reservation_id)
          .maybeSingle<ReservationContext>()
      : Promise.resolve({ data: null }),
    supabase.from("accounts").select("name").eq("id", conversation.account_id).maybeSingle<{ name: string }>(),
  ]);
  return { conversation, guest: guest ?? null, reservation: reservation ?? null, accountName: account?.name ?? "" };
}

function hasServerKey(): boolean {
  return Boolean(process.env.SUPABASE_SECRET_KEY);
}

/**
 * Listing values for variables: non-secret values as the user (RLS); secret ones (door codes) need
 * the service role and PMS_ENCRYPTION_KEY, because repliers (front office) cannot read them
 * otherwise. If that is not configured, secret variables stay unresolved and block sending.
 */
function variableStore(supabase: SupabaseClient): ListingVariableStore {
  const user = supabaseVariableStore(supabase);
  return {
    loadListing: user.loadListing,
    loadValues: user.loadValues,
    async loadSecretCiphertexts(id) {
      try {
        const client = hasServerKey() ? createAdminClient({ type: "system", id: "inbox-variables" }) : supabase;
        return await supabaseVariableStore(client).loadSecretCiphertexts(id);
      } catch {
        return [];
      }
    },
  };
}

/** INB-06: every variable available for this conversation, resolved now. Never log the result. */
export async function conversationVariables(supabase: SupabaseClient, ctx: ConversationContext): Promise<Record<string, string>> {
  return resolveVariables(supabase, { accountName: ctx.accountName, guest: ctx.guest, reservation: ctx.reservation, contactName: ctx.conversation.contact_name });
}

/** Saved-reply preview against a sample reservation (INB-05 screen). */
export async function reservationVariables(supabase: SupabaseClient, reservationId: string, accountName: string): Promise<Record<string, string> | null> {
  if (!/^[0-9a-f-]{36}$/i.test(reservationId)) return null;
  const { data: r } = await supabase
    .from("reservations")
    .select("id, code, status, stay_status, kind, source, check_in, check_out, nights, adults, children, infants, pets, eta, etd, listing_id, unit_id, approval_deadline, guest:guests(id, first_name, last_name, email, phone, language, notes, tags)")
    .eq("id", reservationId)
    .maybeSingle<ReservationContext & { guest: ConversationContext["guest"] }>();
  if (!r) return null;
  return resolveVariables(supabase, { accountName, guest: r.guest, reservation: { ...r, listing: null }, contactName: null });
}

async function resolveVariables(
  supabase: SupabaseClient,
  ctx: { accountName: string; guest: ConversationContext["guest"]; reservation: ReservationContext | null; contactName: string | null },
): Promise<Record<string, string>> {
  let listingVars: Record<string, string> = {};
  const listingId = ctx.reservation?.unit_id ?? ctx.reservation?.listing_id ?? null;
  if (listingId) {
    const key = process.env.PMS_ENCRYPTION_KEY;
    const store = variableStore(supabase);
    try {
      listingVars = await resolveListingVariables(key ? store : { ...store, loadSecretCiphertexts: async () => [] }, listingId, key ? parseKey(key) : Buffer.alloc(32));
    } catch {
      listingVars = {};
    }
  }
  return buildMessageVariables({ accountName: ctx.accountName, guest: ctx.guest, reservation: ctx.reservation, listingVars, contactName: ctx.contactName });
}

/** Sends this account's queued messages right away (the schedule is the fallback). Never throws. */
export async function kickOutbox(accountId: string): Promise<void> {
  if (!hasServerKey()) return;
  try {
    await processOutbox({
      store: supabaseOutboxStore(createAdminClient({ type: "system", id: "inbox-outbox" })),
      provider: emailProvider(),
      config: emailConfig(),
      accountId,
      limit: 10,
    });
  } catch (err) {
    console.error("[inbox] outbox kick failed:", (err as Error).message);
  }
}

/** INB-11 grounding: thread, reservation and listing content as the user sees them; no secrets. */
export async function loadDraftInput(supabase: SupabaseClient, ctx: ConversationContext): Promise<DraftInput> {
  const listingId = ctx.reservation?.unit_id ?? ctx.reservation?.listing_id ?? null;
  const contentId = ctx.reservation?.listing?.parent_id ?? ctx.reservation?.listing_id ?? null;
  const language = ctx.guest?.language?.split("-")[0] ?? "en";

  const [{ data: thread }, listingVars, descriptions, amenities, custom] = await Promise.all([
    supabase
      .from("messages")
      .select("kind, sender_name, author_type, body, created_at, author:profiles!messages_author_user_id_fkey(full_name)")
      .eq("conversation_id", ctx.conversation.id)
      .order("created_at", { ascending: false })
      .limit(30)
      .returns<{ kind: "inbound" | "outbound" | "note"; sender_name: string | null; author_type: string; body: string; created_at: string; author: { full_name: string | null } | null }[]>(),
    listingId ? resolveListingVariables({ ...supabaseVariableStore(supabase), loadSecretCiphertexts: async () => [] }, listingId, Buffer.alloc(32)).catch(() => ({}) as Record<string, string>) : Promise.resolve({} as Record<string, string>),
    contentId
      ? supabase
          .from("listing_descriptions")
          .select("language, summary, space, neighborhood, transit, house_rules, access_notes")
          .eq("listing_id", contentId)
          .returns<({ language: string } & NonNullable<DraftInput["descriptions"]>)[]>()
          .then(({ data }) => (data ?? []).find((d) => d.language === language) ?? (data ?? []).find((d) => d.language === "en") ?? (data ?? [])[0] ?? null)
      : Promise.resolve(null),
    contentId
      ? supabase
          .from("listing_amenities")
          .select("custom_label, amenity:amenities(label)")
          .eq("listing_id", contentId)
          .returns<{ custom_label: string | null; amenity: { label: string } | null }[]>()
          .then(({ data }) => (data ?? []).map((a) => a.amenity?.label ?? a.custom_label ?? "").filter(Boolean))
      : Promise.resolve([] as string[]),
    listingId
      ? supabase
          .from("custom_fields")
          .select("key, label, field_type")
          .eq("account_id", ctx.conversation.account_id)
          .is("archived_at", null)
          .returns<{ key: string; label: string; field_type: string }[]>()
          .then(({ data }) => data ?? [])
      : Promise.resolve([] as { key: string; label: string; field_type: string }[]),
  ]);

  const lv = listingVars as Record<string, string>;
  const desc = descriptions as (NonNullable<DraftInput["descriptions"]> & { language?: string }) | null;
  return {
    accountName: ctx.accountName,
    guestFirstName: ctx.guest?.first_name ?? ctx.conversation.contact_name?.split(/\s+/)[0] ?? null,
    language: ctx.guest?.language ?? null,
    reservation: ctx.reservation
      ? {
          code: ctx.reservation.code,
          status: ctx.reservation.status,
          check_in: ctx.reservation.check_in,
          check_out: ctx.reservation.check_out,
          nights: ctx.reservation.nights,
          adults: ctx.reservation.adults,
          children: ctx.reservation.children,
          pets: ctx.reservation.pets,
          eta: ctx.reservation.eta,
          etd: ctx.reservation.etd,
        }
      : null,
    listing: listingId
      ? {
          title: lv["listing.title"] ?? null,
          city: lv["listing.city"] ?? null,
          state: lv["listing.state"] ?? null,
          address: lv["listing.address"] ?? null,
          check_in_from: lv["listing.check_in_from"] ?? null,
          check_in_to: lv["listing.check_in_to"] ?? null,
          check_out_by: lv["listing.check_out_by"] ?? null,
          max_guests: lv["listing.max_guests"] ? Number(lv["listing.max_guests"]) : null,
        }
      : null,
    descriptions: desc
      ? { summary: desc.summary, space: desc.space, neighborhood: desc.neighborhood, transit: desc.transit, house_rules: desc.house_rules, access_notes: desc.access_notes }
      : null,
    amenities: amenities as string[],
    // Never secret fields: their values are not even loaded here.
    customFields: (custom as { key: string; label: string; field_type: string }[])
      .filter((f) => f.field_type !== "secret")
      .map((f) => ({ key: f.key, label: f.label, type: f.field_type, value: lv[`custom.${f.key}`] ?? "" })),
    thread: (thread ?? [])
      .reverse()
      .map((m) => ({ kind: m.kind, author: m.kind === "inbound" ? (m.sender_name ?? "Guest") : (m.author?.full_name ?? (m.author_type === "agent" ? "Assistant" : "Team")), body: m.body, at: m.created_at })),
  };
}
