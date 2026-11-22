"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/context";
import { CUSTOM_FIELD_TYPES } from "@/lib/properties/constants";
import { propertyErrorMessage } from "@/lib/properties/errors";
import { formDataToObject, parseBulkChange, wizardSchema } from "@/lib/properties/schemas";
import { createClient } from "@/lib/supabase/server";

export type PropertyActionResult = { ok?: boolean; error?: string; message?: string } | null;

const LIST = "/properties";
const uuid = z.guid();

/** Create wizard (PRP-01, screen 4): one draft listing (plus sub-units), then photos. */
export async function createListing(_prev: PropertyActionResult, formData: FormData): Promise<PropertyActionResult> {
  const auth = await authorizeAction("properties.manage");
  if (!auth.ok) return { error: auth.error };
  const parsed = wizardSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const { sub_units: subUnits, ...fields } = parsed.data;
  if (fields.type === "multi_parent" && subUnits < 1) return { error: "A multi-unit needs at least one sub-unit." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("listings")
    .insert({ ...fields, account_id: auth.ctx.active.accountId, status: "draft" })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) return { error: propertyErrorMessage(error?.message) };

  if (fields.type === "multi_parent") {
    const names = Array.from({ length: subUnits }, (_, i) => `${fields.internal_name} – Unit ${i + 1}`.slice(0, 200));
    const { error: subError } = await supabase.rpc("add_sub_units", { p_parent_id: data.id, p_names: names });
    if (subError) return { error: propertyErrorMessage(subError.message) };
  }
  revalidatePath(LIST);
  redirect(`/properties/${data.id}?tab=photos&wizard=1`);
}

/** Activate, move to draft, archive, restore (PRP-01). The database enforces the rules. */
export async function setListingStatus(_prev: PropertyActionResult, formData: FormData): Promise<PropertyActionResult> {
  const parsed = z
    .object({ listingId: uuid, status: z.enum(["draft", "active", "archived"]) })
    .safeParse({ listingId: formData.get("listingId"), status: formData.get("status") });
  if (!parsed.success) return { error: "Invalid request." };
  const auth = await authorizeAction(parsed.data.status === "active" ? "properties.edit" : parsed.data.status === "archived" ? "properties.manage" : "properties.edit");
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("listings")
    .update({ status: parsed.data.status })
    .eq("id", parsed.data.listingId)
    .eq("account_id", auth.ctx.active.accountId)
    .select("id");
  if (error || !data?.length) return { error: propertyErrorMessage(error?.message ?? "forbidden") };
  revalidatePath(LIST);
  revalidatePath(`/properties/${parsed.data.listingId}`);
  return { ok: true, message: parsed.data.status === "active" ? "The listing is active and bookable." : "Status updated." };
}

export async function duplicateListing(_prev: PropertyActionResult, formData: FormData): Promise<PropertyActionResult> {
  const auth = await authorizeAction("properties.manage");
  if (!auth.ok) return { error: auth.error };
  const id = uuid.safeParse(formData.get("listingId"));
  if (!id.success) return { error: "Invalid listing." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("duplicate_listing", { p_listing_id: id.data });
  if (error || !data) return { error: propertyErrorMessage(error?.message) };
  revalidatePath(LIST);
  redirect(`/properties/${data as string}`);
}

/** PRP-15 bulk edit: one change applied to the whole selection, all or nothing. */
export async function bulkEdit(_prev: PropertyActionResult, formData: FormData): Promise<PropertyActionResult> {
  const auth = await authorizeAction("properties.edit");
  if (!auth.ok) return { error: auth.error };
  const ids = z.array(uuid).min(1, "Select at least one listing").max(1000).safeParse(formData.getAll("ids").map(String));
  if (!ids.success) return { error: ids.error.issues[0]?.message };
  const change = parseBulkChange(String(formData.get("action") ?? ""), String(formData.get("value") ?? ""));
  if (!change.ok) return { error: change.error };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("bulk_update_listings", { p_listing_ids: ids.data, p_changes: change.changes });
  if (error) return { error: propertyErrorMessage(error.message) };
  revalidatePath(LIST);
  return { ok: true, message: `Updated ${data as number} listing${data === 1 ? "" : "s"}.` };
}

// ---------------------------------------------------------------------------
// Custom field definitions (PRP-12) — account settings, admins only
// ---------------------------------------------------------------------------

export async function createCustomField(_prev: PropertyActionResult, formData: FormData): Promise<PropertyActionResult> {
  const auth = await authorizeAction("properties.manage");
  if (!auth.ok) return { error: auth.error };
  const parsed = z
    .object({
      label: z.string().trim().min(1, "Enter a label").max(100),
      key: z
        .string()
        .trim()
        .regex(/^[a-z][a-z0-9_]{0,49}$/, "Key: lowercase letters, digits and _ (e.g. door_code)"),
      field_type: z.enum(CUSTOM_FIELD_TYPES),
      options: z.string().default(""),
    })
    .safeParse(formDataToObject(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const options =
    parsed.data.field_type === "dropdown"
      ? [...new Set(parsed.data.options.split("\n").map((o) => o.trim()).filter(Boolean))]
      : [];
  if (parsed.data.field_type === "dropdown" && options.length === 0) return { error: "Add at least one option, one per line." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("custom_fields")
    .insert({ account_id: auth.ctx.active.accountId, label: parsed.data.label, key: parsed.data.key, field_type: parsed.data.field_type, options });
  if (error) return { error: propertyErrorMessage(error.message) };
  revalidatePath("/properties/custom-fields");
  return { ok: true, message: `Field added. Use it in messages as {{custom.${parsed.data.key}}}.` };
}

export async function setCustomFieldArchived(formData: FormData): Promise<void> {
  const auth = await authorizeAction("properties.manage");
  if (!auth.ok) return;
  const id = uuid.safeParse(formData.get("fieldId"));
  if (!id.success) return;
  const supabase = await createClient();
  await supabase
    .from("custom_fields")
    .update({ archived_at: formData.get("archived") === "true" ? new Date().toISOString() : null })
    .eq("id", id.data)
    .eq("account_id", auth.ctx.active.accountId);
  revalidatePath("/properties/custom-fields");
}
