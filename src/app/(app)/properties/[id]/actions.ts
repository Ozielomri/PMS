"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/context";
import { parseKey } from "@/lib/crypto/secrets";
import { serverEnv } from "@/lib/env";
import { BED_TYPES, DESCRIPTION_FIELDS, ROOM_TYPES } from "@/lib/properties/constants";
import { propertyErrorMessage } from "@/lib/properties/errors";
import { PHOTO_BUCKET, isPhotoPathFor, validatePhotoFile } from "@/lib/properties/photos";
import { formDataToObject, parseListingPatch, type ListingTabSchema } from "@/lib/properties/schemas";
import { decryptCustomSecret, encryptCustomSecret } from "@/lib/properties/secrets";
import { createClient } from "@/lib/supabase/server";

export type SaveResult = { ok?: boolean; error?: string; savedAt?: string; message?: string; needsConfirmation?: boolean } | null;

const uuid = z.guid();
const saved = (): SaveResult => ({ ok: true, savedAt: new Date().toISOString() });
const path = (listingId: string) => `/properties/${listingId}`;

async function editor() {
  const auth = await authorizeAction("properties.edit");
  if (!auth.ok) return { auth, supabase: null } as const;
  return { auth, supabase: await createClient() } as const;
}

/** Autosave of a listings-column tab (Overview, Location, Rooms and beds capacity, Booking rules, Fees). */
export async function saveListingTab(listingId: string, schema: ListingTabSchema, _prev: SaveResult, formData: FormData): Promise<SaveResult> {
  if (!uuid.safeParse(listingId).success) return { error: "Invalid listing." };
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  const parsed = parseListingPatch(schema, formData);
  if (!parsed.ok) return { error: parsed.error };

  const { data, error } = await supabase.from("listings").update(parsed.patch).eq("id", listingId).select("id");
  if (error || !data?.length) return { error: propertyErrorMessage(error?.message ?? "forbidden") };
  revalidatePath(path(listingId));
  return saved();
}

/** Timezone change: asks for confirmation when the listing has future bookings (business rule). */
export async function changeTimezone(listingId: string, _prev: SaveResult, formData: FormData): Promise<SaveResult> {
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  const tz = z.string().min(1).max(100).safeParse(formData.get("timezone"));
  if (!tz.success || !uuid.safeParse(listingId).success) return { error: "Choose a timezone." };
  const confirm = formData.get("confirm") === "1";

  if (!confirm) {
    const { data: hasBookings } = await supabase.rpc("listing_has_future_bookings", { p_listing_id: listingId });
    if (hasBookings) {
      return {
        needsConfirmation: true,
        message:
          "This listing has future bookings. Their dates stay the same local dates, but check-in and check-out moments shift to the new timezone. Review the affected bookings before you confirm.",
      };
    }
  }
  const { error } = await supabase.rpc("change_listing_timezone", { p_listing_id: listingId, p_timezone: tz.data, p_confirm: confirm });
  if (error) {
    if (error.message.startsWith("timezone_change_requires_confirmation")) return { needsConfirmation: true, message: propertyErrorMessage(error.message) };
    return { error: propertyErrorMessage(error.message) };
  }
  revalidatePath(path(listingId));
  return { ...saved(), message: "Timezone changed." };
}

// ---------------------------------------------------------------------------
// Rooms and beds (PRP-03)
// ---------------------------------------------------------------------------

export async function addRoom(listingId: string, formData: FormData): Promise<void> {
  const { auth, supabase } = await editor();
  if (!supabase || !auth.ok) return;
  const type = z.enum(ROOM_TYPES).catch("bedroom").parse(formData.get("room_type"));
  const { count } = await supabase.from("listing_rooms").select("id", { count: "exact", head: true }).eq("listing_id", listingId);
  await supabase.from("listing_rooms").insert({
    account_id: auth.ctx.active.accountId,
    listing_id: listingId,
    room_type: type,
    name: `${type === "bedroom" ? "Bedroom" : type.replace("_", " ").replace(/^./, (c) => c.toUpperCase())} ${(count ?? 0) + 1}`,
    position: count ?? 0,
  });
  revalidatePath(path(listingId));
}

export async function saveRoom(roomId: string, listingId: string, _prev: SaveResult, formData: FormData): Promise<SaveResult> {
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  const parsed = z
    .object({ name: z.string().trim().min(1, "Enter a room name").max(100), room_type: z.enum(ROOM_TYPES) })
    .safeParse({ name: formData.get("name"), room_type: formData.get("room_type") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const beds: Record<string, number> = {};
  for (const bed of BED_TYPES) {
    const n = Number(formData.get(`bed_${bed}`) ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > 50) return { error: "Bed counts must be whole numbers from 0 to 50." };
    if (n > 0) beds[bed] = n;
  }
  const { error } = await supabase.from("listing_rooms").update({ ...parsed.data, beds }).eq("id", roomId).eq("listing_id", listingId);
  if (error) return { error: propertyErrorMessage(error.message) };
  revalidatePath(path(listingId));
  return saved();
}

export async function deleteRoom(formData: FormData): Promise<void> {
  const { supabase } = await editor();
  if (!supabase) return;
  const roomId = String(formData.get("roomId"));
  const listingId = String(formData.get("listingId"));
  await supabase.from("listing_rooms").delete().eq("id", roomId).eq("listing_id", listingId);
  revalidatePath(path(listingId));
}

// ---------------------------------------------------------------------------
// Amenities (PRP-04)
// ---------------------------------------------------------------------------

export async function saveAmenities(listingId: string, _prev: SaveResult, formData: FormData): Promise<SaveResult> {
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  const codes = new Set(formData.getAll("amenity").map(String).filter((c) => /^[a-z][a-z0-9_]*$/.test(c)));
  const custom = [...new Map(
    String(formData.get("custom") ?? "")
      .split("\n")
      .map((s) => s.trim().slice(0, 100))
      .filter(Boolean)
      .map((s) => [s.toLowerCase(), s] as const),
  ).values()];

  const { data: current, error: readError } = await supabase
    .from("listing_amenities")
    .select("id, amenity_code, custom_label")
    .eq("listing_id", listingId)
    .returns<{ id: string; amenity_code: string | null; custom_label: string | null }[]>();
  if (readError) return { error: propertyErrorMessage(readError.message) };
  const customLower = new Set(custom.map((c) => c.toLowerCase()));
  const remove = (current ?? [])
    .filter((a) => (a.amenity_code ? !codes.has(a.amenity_code) : !customLower.has((a.custom_label ?? "").toLowerCase())))
    .map((a) => a.id);
  const haveCodes = new Set((current ?? []).map((a) => a.amenity_code).filter(Boolean));
  const haveCustom = new Set((current ?? []).map((a) => a.custom_label?.toLowerCase()).filter(Boolean));
  const add = [
    ...[...codes].filter((c) => !haveCodes.has(c)).map((c) => ({ amenity_code: c })),
    ...custom.filter((c) => !haveCustom.has(c.toLowerCase())).map((c) => ({ custom_label: c })),
  ].map((a) => ({ ...a, account_id: auth.ctx.active.accountId, listing_id: listingId }));

  if (remove.length) {
    const { error } = await supabase.from("listing_amenities").delete().in("id", remove);
    if (error) return { error: propertyErrorMessage(error.message) };
  }
  if (add.length) {
    const { error } = await supabase.from("listing_amenities").insert(add);
    if (error) return { error: propertyErrorMessage(error.message) };
  }
  return saved();
}

// ---------------------------------------------------------------------------
// Descriptions (PRP-05)
// ---------------------------------------------------------------------------

export async function saveDescription(listingId: string, language: string, _prev: SaveResult, formData: FormData): Promise<SaveResult> {
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(language)) return { error: "Invalid language." };
  const row: Record<string, string | null> = {};
  for (const f of DESCRIPTION_FIELDS) {
    const v = String(formData.get(f.key) ?? "").trim();
    if (v.length > 10000) return { error: `${f.label} is too long (max 10,000 characters).` };
    row[f.key] = v === "" ? null : v;
  }
  const { error } = await supabase
    .from("listing_descriptions")
    .upsert({ account_id: auth.ctx.active.accountId, listing_id: listingId, language, ...row }, { onConflict: "listing_id,language" });
  if (error) return { error: propertyErrorMessage(error.message) };
  return saved();
}

// ---------------------------------------------------------------------------
// Photos (PRP-06). Files are uploaded by the browser straight to Storage; these record metadata.
// ---------------------------------------------------------------------------

const uploadedPhoto = z.object({
  path: z.string(),
  name: z.string().max(300),
  contentType: z.string(),
  size: z.number().int(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

export async function recordPhotos(listingId: string, photos: z.input<typeof uploadedPhoto>[]): Promise<SaveResult> {
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  const parsed = z.array(uploadedPhoto).min(1).max(50).safeParse(photos);
  if (!parsed.success) return { error: "Invalid upload." };
  const accountId = auth.ctx.active.accountId;
  const rows = [];
  for (const p of parsed.data) {
    const check = validatePhotoFile({ name: p.name, type: p.contentType, size: p.size });
    if (!check.ok) return { error: check.error };
    if (!isPhotoPathFor(p.path, accountId, listingId)) return { error: "Invalid upload path." };
    rows.push({ ...p, contentType: check.contentType });
  }
  for (const p of rows) {
    // Inserted one by one so each gets the next position (cover = first).
    const { error } = await supabase.from("listing_photos").insert({
      account_id: accountId,
      listing_id: listingId,
      storage_path: p.path,
      content_type: p.contentType,
      size_bytes: p.size,
      width: p.width,
      height: p.height,
    });
    if (error) return { error: propertyErrorMessage(error.message) };
  }
  revalidatePath(path(listingId));
  return { ...saved(), message: `${parsed.data.length} photo${parsed.data.length === 1 ? "" : "s"} added.` };
}

export async function updatePhoto(photoId: string, listingId: string, _prev: SaveResult, formData: FormData): Promise<SaveResult> {
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  const caption = String(formData.get("caption") ?? "").trim().slice(0, 500) || null;
  const roomId = String(formData.get("room_id") ?? "");
  const { error } = await supabase
    .from("listing_photos")
    .update({ caption, room_id: uuid.safeParse(roomId).success ? roomId : null })
    .eq("id", photoId)
    .eq("listing_id", listingId);
  if (error) return { error: propertyErrorMessage(error.message) };
  return saved();
}

export async function reorderPhotos(listingId: string, photoIds: string[]): Promise<SaveResult> {
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  const ids = z.array(uuid).max(500).safeParse(photoIds);
  if (!ids.success) return { error: "Invalid order." };
  const { error } = await supabase.rpc("reorder_listing_photos", { p_listing_id: listingId, p_photo_ids: ids.data });
  if (error) return { error: propertyErrorMessage(error.message) };
  revalidatePath(path(listingId));
  return saved();
}

export async function deletePhoto(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  const photoId = String(formData.get("photoId"));
  const listingId = String(formData.get("listingId"));
  const { data, error } = await supabase
    .from("listing_photos")
    .delete()
    .eq("id", photoId)
    .eq("listing_id", listingId)
    .select("storage_path")
    .returns<{ storage_path: string }[]>();
  if (error || !data?.length) return { error: propertyErrorMessage(error?.message ?? "not_found") };
  // Remove the file only when no other listing (a duplicate) still uses it.
  const storagePath = data[0].storage_path;
  const { count } = await supabase.from("listing_photos").select("id", { count: "exact", head: true }).eq("storage_path", storagePath);
  const [account, folderListing] = storagePath.split("/");
  if (!count && account === auth.ctx.active.accountId && isPhotoPathFor(storagePath, account, folderListing)) {
    await supabase.storage.from(PHOTO_BUCKET).remove([storagePath]);
  }
  revalidatePath(path(listingId));
  return saved();
}

// ---------------------------------------------------------------------------
// Custom field values (PRP-12)
// ---------------------------------------------------------------------------

interface FieldDef {
  id: string;
  key: string;
  field_type: string;
}

/** Autosave of the non-secret custom values. Empty input clears the value. */
export async function saveCustomValues(listingId: string, _prev: SaveResult, formData: FormData): Promise<SaveResult> {
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  const { data: fields } = await supabase
    .from("custom_fields")
    .select("id, key, field_type")
    .eq("account_id", auth.ctx.active.accountId)
    .is("archived_at", null)
    .neq("field_type", "secret")
    .returns<FieldDef[]>();
  const input = formDataToObject(formData);
  for (const f of fields ?? []) {
    const name = `field_${f.id}`;
    if (!(name in input)) continue;
    const raw = String(input[name]).trim();
    if (raw === "") {
      const { error } = await supabase.rpc("clear_listing_custom_value", { p_listing_id: listingId, p_field_id: f.id });
      if (error) return { error: propertyErrorMessage(error.message) };
      continue;
    }
    const args: Record<string, unknown> = { p_listing_id: listingId, p_field_id: f.id };
    if (f.field_type === "number") {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) return { error: `${f.key}: enter a number.` };
      args.p_number = Number(raw);
    } else if (f.field_type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { error: `${f.key}: enter a date.` };
      args.p_date = raw;
    } else {
      args.p_text = raw.slice(0, 2000);
    }
    const { error } = await supabase.rpc("set_listing_custom_value", args);
    if (error) return { error: propertyErrorMessage(error.message) };
  }
  return saved();
}

/** Set or replace a secret value: encrypted here (X-15), bound to listing + field. */
export async function saveSecretValue(listingId: string, fieldId: string, _prev: SaveResult, formData: FormData): Promise<SaveResult> {
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  if (!uuid.safeParse(listingId).success || !uuid.safeParse(fieldId).success) return { error: "Invalid field." };
  const value = String(formData.get("secret") ?? "");
  if (formData.get("clear") === "1") {
    const { error } = await supabase.rpc("clear_listing_custom_value", { p_listing_id: listingId, p_field_id: fieldId });
    if (error) return { error: propertyErrorMessage(error.message) };
    revalidatePath(path(listingId));
    return { ...saved(), message: "Secret removed." };
  }
  if (value.trim() === "" || value.length > 1000) return { error: "Enter a value (up to 1,000 characters)." };
  const ciphertext = encryptCustomSecret(value, parseKey(serverEnv().encryptionKey), listingId, fieldId);
  const { error } = await supabase.rpc("set_listing_custom_value", { p_listing_id: listingId, p_field_id: fieldId, p_secret_ciphertext: ciphertext });
  if (error) return { error: propertyErrorMessage(error.message) };
  revalidatePath(path(listingId));
  return { ...saved(), message: "Secret saved." };
}

/** Reveal a secret to an editor (the database only hands ciphertexts to properties.edit). */
export async function revealSecret(listingId: string, fieldId: string): Promise<{ value?: string; error?: string }> {
  const { auth, supabase } = await editor();
  if (!supabase) return { error: auth.ok ? undefined : auth.error };
  const { data, error } = await supabase.rpc("listing_secret_ciphertexts", { p_listing_id: listingId });
  if (error) return { error: propertyErrorMessage(error.message) };
  const row = (data as { listing_id: string; field_id: string; ciphertext: string }[]).find((r) => r.listing_id === listingId && r.field_id === fieldId);
  if (!row) return { error: "No value set." };
  try {
    return { value: decryptCustomSecret(row.ciphertext, parseKey(serverEnv().encryptionKey), listingId, fieldId) };
  } catch {
    return { error: "This value can't be decrypted. Enter it again." };
  }
}
