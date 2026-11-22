"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/context";
import { CLEANING_STATUSES } from "@/lib/properties/constants";
import { propertyErrorMessage } from "@/lib/properties/errors";
import { createClient } from "@/lib/supabase/server";

export type UnitActionResult = { ok?: boolean; error?: string; message?: string } | null;

const uuid = z.guid();

function refresh(...ids: (string | null | undefined)[]) {
  revalidatePath("/properties");
  for (const id of ids) if (id) {
    revalidatePath(`/properties/${id}`);
    revalidatePath(`/properties/${id}/units`);
  }
}

/** PRP-13: add sub-units ("Unit 101, Unit 102" or a count). */
export async function addSubUnits(parentId: string, _prev: UnitActionResult, formData: FormData): Promise<UnitActionResult> {
  const auth = await authorizeAction("properties.manage");
  if (!auth.ok) return { error: auth.error };
  const raw = String(formData.get("names") ?? "").trim();
  const names = /^\d+$/.test(raw)
    ? Array.from({ length: Number(raw) }, (_, i) => `Unit ${i + 1}`)
    : raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (names.length < 1 || names.length > 200) return { error: "Enter 1–200 names (comma or one per line), or a number." };
  if (names.some((n) => n.length > 200)) return { error: "Names are limited to 200 characters." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_sub_units", { p_parent_id: parentId, p_names: names });
  if (error) return { error: propertyErrorMessage(error.message) };
  refresh(parentId);
  return { ok: true, message: `Added ${names.length} sub-unit${names.length === 1 ? "" : "s"}.` };
}

/** Remove = archive (never deleted), restore = back to draft. */
export async function setSubUnitArchived(_prev: UnitActionResult, formData: FormData): Promise<UnitActionResult> {
  const auth = await authorizeAction("properties.manage");
  if (!auth.ok) return { error: auth.error };
  const id = uuid.safeParse(formData.get("subUnitId"));
  if (!id.success) return { error: "Invalid sub-unit." };
  const archive = formData.get("archive") === "true";
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("listings")
    .update({ status: archive ? "archived" : "draft" })
    .eq("id", id.data)
    .eq("type", "sub_unit")
    .select("parent_id")
    .returns<{ parent_id: string }[]>();
  if (error || !data?.length) return { error: propertyErrorMessage(error?.message ?? "not_found") };
  refresh(data[0].parent_id, id.data);
  return { ok: true, message: archive ? "Sub-unit removed (archived)." : "Sub-unit restored as draft." };
}

export async function moveSubUnit(_prev: UnitActionResult, formData: FormData): Promise<UnitActionResult> {
  const auth = await authorizeAction("properties.manage");
  if (!auth.ok) return { error: auth.error };
  const parsed = z.object({ subUnitId: uuid, parentId: uuid, newParentId: uuid }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Choose the parent to move to." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("move_sub_unit", { p_sub_unit_id: parsed.data.subUnitId, p_new_parent_id: parsed.data.newParentId });
  if (error) return { error: propertyErrorMessage(error.message) };
  refresh(parsed.data.parentId, parsed.data.newParentId, parsed.data.subUnitId);
  return { ok: true, message: "Sub-unit moved." };
}

export async function convertSubUnit(_prev: UnitActionResult, formData: FormData): Promise<UnitActionResult> {
  const auth = await authorizeAction("properties.manage");
  if (!auth.ok) return { error: auth.error };
  const parsed = z.object({ subUnitId: uuid, parentId: uuid }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Invalid sub-unit." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("convert_sub_unit_to_single", { p_sub_unit_id: parsed.data.subUnitId });
  if (error) return { error: propertyErrorMessage(error.message) };
  refresh(parsed.data.parentId, parsed.data.subUnitId);
  return { ok: true, message: "Converted to a single unit with the parent's content and prices." };
}

/** PRP-16: set the cleaning status of one or more units. */
export async function setCleaningStatus(_prev: UnitActionResult, formData: FormData): Promise<UnitActionResult> {
  const auth = await authorizeAction("properties.edit");
  if (!auth.ok) return { error: auth.error };
  const parsed = z
    .object({ ids: z.array(uuid).min(1).max(500), status: z.enum(CLEANING_STATUSES) })
    .safeParse({ ids: formData.getAll("ids").map(String), status: formData.get("status") });
  if (!parsed.success) return { error: "Choose units and a status." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("listings")
    .update({ cleaning_status: parsed.data.status })
    .in("id", parsed.data.ids)
    .in("type", ["single", "sub_unit"])
    .select("id, parent_id")
    .returns<{ id: string; parent_id: string | null }[]>();
  if (error || !data?.length) return { error: propertyErrorMessage(error?.message ?? "forbidden") };
  refresh(...data.map((r) => r.parent_id), ...data.map((r) => r.id));
  return { ok: true };
}
