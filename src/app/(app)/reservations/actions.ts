"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/context";
import type { Permission } from "@/lib/auth/permissions";
import { isIsoDate } from "@/lib/calendar/dates";
import { parseDollarsToCents } from "@/lib/properties/money";
import { reservationErrorMessage } from "@/lib/reservations/errors";
import { MANUAL_SOURCES, RESERVATION_STATUSES, STAY_STATUSES } from "@/lib/reservations/status";
import { createClient } from "@/lib/supabase/server";

export type ReservationActionResult = { ok?: boolean; error?: string; message?: string; data?: unknown } | null;

const uuid = z.guid();
const isoDate = z.string().refine(isIsoDate, "Enter a date");
const count = (max: number) => z.coerce.number().int().min(0).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));
const time = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^\d{2}:\d{2}$/.test(v), "Enter a time like 15:00");

function get(formData: FormData, key: string): string | undefined {
  const v = formData.get(key);
  return typeof v === "string" ? v : undefined;
}

function tagsFrom(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((t) => t.trim()).filter(Boolean))].slice(0, 20).map((t) => t.slice(0, 50));
}

function money(value: string | undefined): { cents: number | null } | { error: string } {
  try {
    return { cents: parseDollarsToCents(value) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Authorize, run one RPC, map the error, and revalidate the reservation pages. */
async function run(
  permission: Permission,
  fn: string,
  args: Record<string, unknown>,
  opts: { reservationId?: string; message?: string } = {},
): Promise<ReservationActionResult> {
  const auth = await authorizeAction(permission);
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { error: reservationErrorMessage(error.message) };
  revalidatePath("/reservations");
  revalidatePath("/calendar");
  // The inbox context panel shows the reservation and its approve / decline actions (INB-07).
  revalidatePath("/inbox");
  if (opts.reservationId) revalidatePath(`/reservations/${opts.reservationId}`);
  return { ok: true, message: opts.message, data };
}

// ---------------------------------------------------------------------------
// RES-01 create (manual booking, owner stay)
// ---------------------------------------------------------------------------

const createSchema = z.object({
  listing_id: uuid,
  check_in: isoDate,
  check_out: isoDate,
  kind: z.enum(["guest", "owner_stay"]).default("guest"),
  status: z.enum(["inquiry", "reserved", "confirmed"]).default("confirmed"),
  source: z.enum(MANUAL_SOURCES as unknown as [string, ...string[]]).default("direct"),
  guest_id: z.union([uuid, z.literal("")]).optional(),
  first_name: optionalText(100),
  last_name: optionalText(100),
  email: z.union([z.email().max(254), z.literal("")]).optional(),
  phone: optionalText(40),
  adults: count(100).default(1),
  children: count(100).default(0),
  infants: count(100).default(0),
  pets: count(20).default(0),
  price_override: z.string().optional(),
  override_reason: optionalText(1000),
  eta: time,
  etd: time,
  tags: z.string().optional(),
  note: optionalText(10000),
});

export async function createReservation(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const parsed = createSchema.safeParse(Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string")));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const d = parsed.data;
  if (d.check_out <= d.check_in) return { error: "Check-out must be after check-in." };
  const override = money(d.price_override);
  if ("error" in override) return { error: override.error };
  const owner = d.kind === "owner_stay";
  if (!owner && !d.guest_id && !d.first_name) return { error: "Enter the guest's first name or pick an existing guest." };

  const auth = await authorizeAction("reservations.create");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_reservation", {
    p_listing_id: d.listing_id,
    p_check_in: d.check_in,
    p_check_out: d.check_out,
    p_status: owner ? "confirmed" : d.status,
    p_guest_id: owner ? null : d.guest_id || null,
    p_guest: owner || d.guest_id ? null : { first_name: d.first_name, last_name: d.last_name, email: d.email || null, phone: d.phone },
    p_adults: d.adults,
    p_children: d.children,
    p_infants: d.infants,
    p_pets: d.pets,
    p_source: owner ? "owner" : d.source,
    p_kind: d.kind,
    p_price_override_cents: owner ? null : override.cents,
    p_override_reason: d.override_reason,
    p_eta: d.eta,
    p_etd: d.etd,
    p_tags: tagsFrom(d.tags),
    p_note: d.note,
  });
  if (error || !data) return { error: reservationErrorMessage(error?.message) };
  revalidatePath("/reservations");
  revalidatePath("/calendar");
  redirect(`/reservations/${data as string}`);
}

// ---------------------------------------------------------------------------
// RES-03 / RES-04 status changes
// ---------------------------------------------------------------------------

export async function changeStatus(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const id = uuid.safeParse(get(formData, "reservationId"));
  const to = z.enum(RESERVATION_STATUSES).safeParse(get(formData, "to"));
  if (!id.success || !to.success) return { error: "Invalid request." };
  const reason = get(formData, "reason")?.trim() || null;
  if (to.data === "declined" || to.data === "closed") {
    return run("reservations.edit", "decline_reservation", { p_reservation_id: id.data, p_reason: reason }, { reservationId: id.data, message: "Done." });
  }
  if (to.data === "reserved" || to.data === "confirmed") {
    return run("reservations.edit", "confirm_reservation", { p_reservation_id: id.data, p_to: to.data }, {
      reservationId: id.data,
      message: to.data === "confirmed" ? "Confirmed." : "The request now holds the nights until the approval deadline.",
    });
  }
  return { error: "Use the cancel form to cancel." };
}

export async function setStayStatus(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const id = uuid.safeParse(get(formData, "reservationId"));
  const to = z.enum(STAY_STATUSES).safeParse(get(formData, "to"));
  if (!id.success || !to.success) return { error: "Invalid request." };
  return run("reservations.edit", "set_stay_status", { p_reservation_id: id.data, p_stay_status: to.data }, { reservationId: id.data, message: "Stay status updated." });
}

// ---------------------------------------------------------------------------
// RES-07 cancel (preview first, then confirm)
// ---------------------------------------------------------------------------

export interface CancelPreview {
  policy: string;
  days_before_check_in: number;
  refund_percent: number;
  guest_total_cents: number;
  kept_cents: number;
  paid_cents: number;
  refund_due_cents: number;
  balance_due_cents: number;
}

export async function cancelReservation(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const id = uuid.safeParse(get(formData, "reservationId"));
  const by = z.enum(["host", "guest"]).safeParse(get(formData, "canceledBy"));
  if (!id.success || !by.success) return { error: "Invalid request." };
  const pctRaw = get(formData, "refundPercent")?.trim();
  const pct = pctRaw ? Number(pctRaw) : null;
  if (pct !== null && (!Number.isInteger(pct) || pct < 0 || pct > 100)) return { error: "The refund must be a whole number from 0 to 100." };
  const preview = get(formData, "intent") !== "confirm";
  return run(
    pct === null ? "reservations.cancel" : "reservations.manage",
    "cancel_reservation",
    { p_reservation_id: id.data, p_canceled_by: by.data, p_reason: get(formData, "reason")?.trim() || null, p_refund_percent: pct, p_preview: preview },
    { reservationId: preview ? undefined : id.data, message: preview ? undefined : "Reservation canceled; the nights are free again." },
  );
}

// ---------------------------------------------------------------------------
// RES-06 alter (preview first) and CAL-11 unit reassignment
// ---------------------------------------------------------------------------

export interface AlterPreview {
  changes: Record<string, unknown>;
  before: { check_in: string; check_out: string; listing_id: string; nights: number; total_cents: number };
  after: { check_in: string; check_out: string; listing_id: string; nights: number; total_cents: number };
  difference_cents: number;
  available: boolean;
  availability: { failures: string[] | null; message: string | null };
}

const alterSchema = z.object({
  reservationId: uuid,
  check_in: isoDate,
  check_out: isoDate,
  listing_id: uuid,
  adults: count(100),
  children: count(100),
  infants: count(100),
  pets: count(20),
  pricing: z.enum(["reprice", "keep", "custom"]).default("reprice"),
  new_total: z.string().optional(),
  reason: optionalText(1000),
  intent: z.enum(["preview", "confirm"]).default("preview"),
});

export async function alterReservation(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const parsed = alterSchema.safeParse(Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string")));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const d = parsed.data;
  if (d.check_out <= d.check_in) return { error: "Check-out must be after check-in." };
  const total = d.pricing === "custom" ? money(d.new_total) : { cents: null };
  if ("error" in total) return { error: total.error };
  if (d.pricing === "custom" && total.cents === null) return { error: "Enter the new total." };
  const confirm = d.intent === "confirm";
  const result = await run(
    d.pricing === "custom" ? "reservations.manage" : "reservations.edit",
    "alter_reservation",
    {
      p_reservation_id: d.reservationId,
      p_check_in: d.check_in,
      p_check_out: d.check_out,
      p_listing_id: d.listing_id,
      p_adults: d.adults,
      p_children: d.children,
      p_infants: d.infants,
      p_pets: d.pets,
      p_preview: !confirm,
      p_keep_price: d.pricing === "keep",
      p_new_total_cents: total.cents,
      p_reason: d.reason,
    },
    { reservationId: confirm ? d.reservationId : undefined, message: confirm ? "Reservation updated." : undefined },
  );
  if (confirm && result?.ok) redirect(`/reservations/${d.reservationId}`);
  return result;
}

/** Calendar drag-and-drop: move a booking to another listing (and/or dates) in one step. */
export async function relocateReservation(input: { reservationId: string; listingId: string; checkIn: string; checkOut: string; preview: boolean }): Promise<ReservationActionResult> {
  const parsed = z.object({ reservationId: uuid, listingId: uuid, checkIn: isoDate, checkOut: isoDate, preview: z.boolean() }).safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  const d = parsed.data;
  return run(
    "reservations.edit",
    "alter_reservation",
    { p_reservation_id: d.reservationId, p_check_in: d.checkIn, p_check_out: d.checkOut, p_listing_id: d.listingId, p_preview: d.preview },
    { reservationId: d.preview ? undefined : d.reservationId, message: d.preview ? undefined : "Reservation moved." },
  );
}

export async function reassignUnit(input: { reservationId: string; unitId: string }): Promise<ReservationActionResult> {
  const parsed = z.object({ reservationId: uuid, unitId: uuid }).safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  return run("reservations.edit", "reassign_reservation_unit", { p_reservation_id: parsed.data.reservationId, p_unit_id: parsed.data.unitId }, {
    reservationId: parsed.data.reservationId,
    message: "Moved to the other unit.",
  });
}

export async function reassignUnitForm(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  return reassignUnit({ reservationId: get(formData, "reservationId") ?? "", unitId: get(formData, "unitId") ?? "" });
}

// ---------------------------------------------------------------------------
// Details, money (RES-08/09/10), notes and files
// ---------------------------------------------------------------------------

export async function updateDetails(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const parsed = z.object({ reservationId: uuid, eta: time, etd: time, tags: z.string().optional() }).safeParse({
    reservationId: get(formData, "reservationId"),
    eta: get(formData, "eta"),
    etd: get(formData, "etd"),
    tags: get(formData, "tags"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request." };
  const d = parsed.data;
  return run(
    "reservations.edit",
    "update_reservation_details",
    { p_reservation_id: d.reservationId, p_eta: d.eta, p_etd: d.etd, p_tags: tagsFrom(d.tags), p_clear_times: true },
    { reservationId: d.reservationId, message: "Saved." },
  );
}

export async function addLine(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const parsed = z
    .object({
      reservationId: uuid,
      kind: z.enum(["extra", "adjustment"]),
      label: z.string().trim().min(1, "Enter a description").max(200),
      reason: optionalText(1000),
      quantity: z.coerce.number().int().min(1).max(1000).default(1),
      credit: z.string().optional(),
    })
    .safeParse({
      reservationId: get(formData, "reservationId"),
      kind: get(formData, "kind"),
      label: get(formData, "label"),
      reason: get(formData, "reason"),
      quantity: get(formData, "quantity") || 1,
      credit: get(formData, "credit"),
    });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request." };
  const d = parsed.data;
  const amount = money(get(formData, "amount"));
  if ("error" in amount) return { error: amount.error };
  if (!amount.cents) return { error: "Enter an amount." };
  if (d.kind === "adjustment" && !d.reason) return { error: "An adjustment needs a reason." };
  const cents = d.kind === "adjustment" && d.credit === "on" ? -amount.cents : amount.cents;
  return run(
    d.kind === "extra" ? "reservations.edit" : "reservations.manage",
    "add_reservation_line",
    { p_reservation_id: d.reservationId, p_kind: d.kind, p_label: d.label, p_amount_cents: cents, p_reason: d.reason, p_quantity: d.quantity },
    { reservationId: d.reservationId, message: d.kind === "extra" ? "Extra added." : "Adjustment added." },
  );
}

export async function recordPayment(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const parsed = z
    .object({
      reservationId: uuid,
      method: z.enum(["cash", "bank_transfer", "card_external", "check", "channel_collected", "other"]),
      direction: z.enum(["payment", "refund"]).default("payment"),
      received_on: z.union([isoDate, z.literal("")]).optional(),
      reference: optionalText(200),
      note: optionalText(1000),
    })
    .safeParse({
      reservationId: get(formData, "reservationId"),
      method: get(formData, "method"),
      direction: get(formData, "direction") || "payment",
      received_on: get(formData, "received_on"),
      reference: get(formData, "reference"),
      note: get(formData, "note"),
    });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request." };
  const d = parsed.data;
  const amount = money(get(formData, "amount"));
  if ("error" in amount) return { error: amount.error };
  if (!amount.cents) return { error: "Enter an amount." };
  return run(
    "reservations.edit",
    "record_payment",
    {
      p_reservation_id: d.reservationId,
      p_amount_cents: d.direction === "refund" ? -amount.cents : amount.cents,
      p_method: d.method,
      p_received_at: d.received_on ? `${d.received_on}T12:00:00Z` : null,
      p_reference: d.reference,
      p_note: d.note,
    },
    { reservationId: d.reservationId, message: d.direction === "refund" ? "Refund recorded." : "Payment recorded." },
  );
}

export async function addNote(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const id = uuid.safeParse(get(formData, "reservationId"));
  const body = z.string().trim().min(1, "Write a note").max(10000).safeParse(get(formData, "body"));
  if (!id.success) return { error: "Invalid request." };
  if (!body.success) return { error: body.error.issues[0]?.message };
  return run("reservations.edit", "add_reservation_note", { p_reservation_id: id.data, p_body: body.data }, { reservationId: id.data, message: "Note added." });
}

/** Records a file the browser uploaded to the private `reservation-files` bucket. */
export async function registerFile(input: { reservationId: string; path: string; name: string; contentType: string; size: number }): Promise<ReservationActionResult> {
  const parsed = z
    .object({ reservationId: uuid, path: z.string().max(500), name: z.string().trim().min(1).max(255), contentType: z.string().max(100), size: z.number().int().min(1).max(26214400) })
    .safeParse(input);
  if (!parsed.success) return { error: "That file cannot be attached (25 MB at most)." };
  const d = parsed.data;
  return run(
    "reservations.edit",
    "register_reservation_file",
    { p_reservation_id: d.reservationId, p_storage_path: d.path, p_file_name: d.name, p_content_type: d.contentType || "application/octet-stream", p_size_bytes: d.size },
    { reservationId: d.reservationId, message: "File attached." },
  );
}

export async function fileDownloadUrl(fileId: string): Promise<{ url?: string; error?: string }> {
  const auth = await authorizeAction("reservations.view");
  if (!auth.ok) return { error: auth.error };
  if (!uuid.safeParse(fileId).success) return { error: "Invalid file." };
  const supabase = await createClient();
  const { data: file } = await supabase.from("reservation_files").select("storage_path, file_name").eq("id", fileId).maybeSingle<{ storage_path: string; file_name: string }>();
  if (!file) return { error: "File not found." };
  const { data, error } = await supabase.storage.from("reservation-files").createSignedUrl(file.storage_path, 60, { download: file.file_name });
  if (error || !data) return { error: "Could not create a download link." };
  return { url: data.signedUrl };
}

// ---------------------------------------------------------------------------
// Guests (RES-11 merge) and list saved views (RES-13)
// ---------------------------------------------------------------------------

export interface GuestHit {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

/** Guest picker on the booking form and the merge dialog. */
export async function searchGuests(q: string): Promise<GuestHit[]> {
  const auth = await authorizeAction("reservations.view");
  const term = q.trim().replace(/[%_\\,()"]/g, " ").slice(0, 100);
  if (!auth.ok || term.length < 2) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("guests")
    .select("id, first_name, last_name, email, phone")
    .eq("account_id", auth.ctx.active.accountId)
    .is("merged_into_id", null)
    .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`)
    .order("last_name")
    .limit(10)
    .returns<GuestHit[]>();
  return data ?? [];
}

export async function updateGuest(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const parsed = z
    .object({
      guestId: uuid,
      reservationId: uuid.optional(),
      first_name: z.string().trim().min(1, "Enter a first name").max(100),
      last_name: optionalText(100),
      email: z.union([z.email().max(254), z.literal("")]).optional(),
      phone: optionalText(40),
      notes: optionalText(5000),
      tags: z.string().optional(),
    })
    .safeParse(Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string")));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const d = parsed.data;
  const auth = await authorizeAction("reservations.edit");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("guests")
    .update({ first_name: d.first_name, last_name: d.last_name, email: d.email || null, phone: d.phone, notes: d.notes, tags: tagsFrom(d.tags) })
    .eq("id", d.guestId)
    .eq("account_id", auth.ctx.active.accountId)
    .select("id");
  if (error || !data?.length) return { error: reservationErrorMessage(error?.message ?? "forbidden") };
  if (d.reservationId) revalidatePath(`/reservations/${d.reservationId}`);
  return { ok: true, message: "Guest saved." };
}

export async function mergeGuests(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const keep = uuid.safeParse(get(formData, "keepId"));
  const merge = uuid.safeParse(get(formData, "mergeId"));
  if (!keep.success || !merge.success || keep.data === merge.data) return { error: "Pick two different guests." };
  const reservationId = get(formData, "reservationId");
  const result = await run("reservations.manage", "merge_guests", { p_keep_id: keep.data, p_merge_id: merge.data }, {
    reservationId: reservationId && uuid.safeParse(reservationId).success ? reservationId : undefined,
  });
  return result?.ok ? { ok: true, message: `Merged; ${result.data as number} reservation(s) moved to the kept guest.` } : result;
}

export async function saveView(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const name = z.string().trim().min(1, "Name the view").max(100).safeParse(get(formData, "name"));
  if (!name.success) return { error: name.error.issues[0]?.message };
  const auth = await authorizeAction("reservations.view");
  if (!auth.ok) return { error: auth.error };
  const query = get(formData, "query") ?? "";
  const supabase = await createClient();
  const { error } = await supabase.from("reservation_saved_views").insert({
    account_id: auth.ctx.active.accountId,
    name: name.data,
    filters: { query: query.slice(0, 2000) },
    shared: get(formData, "shared") === "on",
  });
  if (error) return { error: reservationErrorMessage(error.message) };
  revalidatePath("/reservations");
  return { ok: true, message: "View saved." };
}

export async function deleteView(formData: FormData): Promise<void> {
  const id = uuid.safeParse(get(formData, "viewId"));
  const auth = await authorizeAction("reservations.view");
  if (!id.success || !auth.ok) return;
  const supabase = await createClient();
  await supabase.from("reservation_saved_views").delete().eq("id", id.data);
  revalidatePath("/reservations");
}

// ---------------------------------------------------------------------------
// RES-04 approval windows per source
// ---------------------------------------------------------------------------

export async function saveApprovalHours(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const auth = await authorizeAction("reservations.manage");
  if (!auth.ok) return { error: auth.error };
  const rows: { account_id: string; source: string; approval_hours: number }[] = [];
  for (const source of [...MANUAL_SOURCES, "booking_com", "airbnb", "vrbo"]) {
    const raw = get(formData, `hours_${source}`);
    if (!raw) continue;
    const hours = Number(raw);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) return { error: "Approval windows are 1 to 168 hours." };
    rows.push({ account_id: auth.ctx.active.accountId, source, approval_hours: hours });
  }
  const supabase = await createClient();
  const { error } = await supabase.from("reservation_source_settings").upsert(rows, { onConflict: "account_id,source" });
  if (error) return { error: reservationErrorMessage(error.message) };
  revalidatePath("/settings/reservations");
  return { ok: true, message: "Saved." };
}

// ---------------------------------------------------------------------------
// RES-05 quotes
// ---------------------------------------------------------------------------

const quoteOption = z.object({
  listing_id: uuid,
  check_in: isoDate,
  check_out: isoDate,
  adults: count(100),
  children: count(100),
  pets: count(20),
});

export async function createQuote(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  let options: z.infer<typeof quoteOption>[];
  try {
    options = z.array(quoteOption).min(1, "Add at least one option").max(10).parse(JSON.parse(get(formData, "options") ?? "[]"));
  } catch (e) {
    return { error: e instanceof z.ZodError ? (e.issues[0]?.message ?? "Check the options.") : "Check the options." };
  }
  if (options.some((o) => o.check_out <= o.check_in)) return { error: "Each option needs check-out after check-in." };
  const days = Number(get(formData, "expires_days") ?? "3");
  if (!Number.isInteger(days) || days < 1 || days > 60) return { error: "The quote expires in 1 to 60 days." };
  const guestId = get(formData, "guest_id");
  const firstName = get(formData, "first_name")?.trim();
  const email = get(formData, "email")?.trim();
  if (!guestId && !firstName) return { error: "Choose a guest or enter a first name." };
  if (email && !z.email().safeParse(email).success) return { error: "Enter a valid email." };

  const auth = await authorizeAction("reservations.create");
  if (!auth.ok) return { error: auth.error };
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("create_quote", {
      p_account_id: auth.ctx.active.accountId,
      p_options: options,
      p_expires_at: new Date(Date.now() + days * 86400000).toISOString(),
      p_guest_id: guestId && uuid.safeParse(guestId).success ? guestId : null,
      p_guest: guestId ? null : { first_name: firstName, last_name: get(formData, "last_name")?.trim() || null, email: email || null },
      p_hold: get(formData, "hold") === "on",
      p_message: get(formData, "message")?.trim().slice(0, 5000) || null,
    })
    .single<{ quote_id: string; token: string }>();
  if (error || !data) return { error: reservationErrorMessage(error?.message) };
  revalidatePath("/reservations/quotes");
  revalidatePath("/calendar");
  return { ok: true, message: "Quote created.", data: { quoteId: data.quote_id, path: `/q/${data.token}` } };
}

export async function cancelQuote(_prev: ReservationActionResult, formData: FormData): Promise<ReservationActionResult> {
  const id = uuid.safeParse(get(formData, "quoteId"));
  if (!id.success) return { error: "Invalid request." };
  const result = await run("reservations.create", "cancel_quote", { p_quote_id: id.data }, { message: "Quote withdrawn; any held nights are free again." });
  revalidatePath("/reservations/quotes");
  return result;
}
