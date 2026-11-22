"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/context";
import { parseCalendarChanges, type CalendarChanges } from "@/lib/calendar/bulk";
import { isIsoDate } from "@/lib/calendar/dates";
import { CalendarError, blockDates, unblockDates, updateCalendar, type UpdateResult } from "@/lib/calendar/service";
import { parseDollarsToCents, parsePercentToBps } from "@/lib/properties/money";
import { reservationErrorMessage } from "@/lib/reservations/errors";
import { createClient } from "@/lib/supabase/server";

export type CalendarActionResult = { ok?: boolean; error?: string; message?: string; results?: UpdateResult[] } | null;

const rangeSchema = z
  .object({ listingIds: z.array(z.guid()).min(1).max(500), from: z.string().refine(isIsoDate), to: z.string().refine(isIsoDate) })
  .refine((r) => r.to > r.from, "The end must be after the start.");

function failure(err: unknown): { error: string } {
  if (err instanceof CalendarError) {
    if (err.isForbidden) return { error: "You do not have permission to do that." };
    const known = reservationErrorMessage(err.message);
    // Calendar validation messages ("invalid_changes: …") are readable after the code prefix.
    return { error: known !== "Something went wrong. Try again." ? known : err.message.replace(/^[a-z_]+: /, "") };
  }
  return { error: "Something went wrong. Try again." };
}

/** CAL-06 block nights [from, to) on the listings. Bookings in the way make the whole call fail. */
export async function blockRange(input: { listingIds: string[]; from: string; to: string; reason?: "maintenance" | "personal_use" | "other"; note?: string }): Promise<CalendarActionResult> {
  const parsed = rangeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid range." };
  const auth = await authorizeAction("calendar.block");
  if (!auth.ok) return { error: auth.error };
  try {
    await blockDates(await createClient(), { ...parsed.data, reason: input.reason ?? "other", note: input.note?.slice(0, 500) || null });
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/calendar", "layout");
  return { ok: true, message: "Dates blocked." };
}

export async function unblockRange(input: { listingIds: string[]; from: string; to: string }): Promise<CalendarActionResult> {
  const parsed = rangeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid range." };
  const auth = await authorizeAction("calendar.block");
  if (!auth.ok) return { error: auth.error };
  try {
    const rows = await unblockDates(await createClient(), parsed.data);
    const n = rows.reduce((s, r) => s + r.nightsUnblocked, 0);
    revalidatePath("/calendar", "layout");
    return { ok: true, message: n ? `Unblocked ${n} night${n === 1 ? "" : "s"}.` : "Nothing was blocked there." };
  } catch (err) {
    return failure(err);
  }
}

/** Builds the CAL-12 changes object from the quick-edit / bulk form fields. */
function changesFromForm(fields: Record<string, string | boolean | undefined>): { changes?: CalendarChanges; error?: string } {
  const out: Record<string, unknown> = {};
  try {
    switch (fields.price_op) {
      case "set": {
        const cents = parseDollarsToCents(String(fields.price_value ?? ""));
        if (cents === null) return { error: "Enter a price." };
        out.price = { op: "set", cents };
        break;
      }
      case "add": {
        const raw = String(fields.price_value ?? "").trim();
        const negative = raw.startsWith("-");
        const cents = parseDollarsToCents(raw.replace(/^-/, ""));
        if (cents === null) return { error: "Enter an amount." };
        out.price = { op: "add", cents: negative ? -cents : cents };
        break;
      }
      case "percent": {
        const raw = String(fields.price_value ?? "").trim();
        const negative = raw.startsWith("-");
        const bps = parsePercentToBps(raw.replace(/^-/, ""));
        out.price = { op: "percent", percent: (negative ? -bps : bps) / 100 };
        break;
      }
      case "reset":
        out.price = { op: "reset" };
        break;
    }
  } catch (e) {
    return { error: (e as Error).message };
  }
  for (const key of ["min_nights", "max_nights"] as const) {
    const v = fields[key];
    if (v === "default") out[key] = null;
    else if (typeof v === "string" && v.trim()) out[key] = Number(v);
  }
  for (const key of ["closed_to_arrival", "closed_to_departure", "closed"] as const) {
    const v = fields[key];
    if (v === "yes") out[key] = true;
    else if (v === "no") out[key] = false;
  }
  const parsed = parseCalendarChanges(out);
  return parsed.ok ? { changes: parsed.changes } : { error: Object.keys(out).length ? parsed.error : "Choose at least one change." };
}

/** CAL-12 price / rule changes over a range; preview returns the counts without writing. */
export async function updateRange(input: {
  listingIds: string[];
  from: string;
  to: string;
  fields: Record<string, string | boolean | undefined>;
  daysOfWeek?: number[];
  preview: boolean;
}): Promise<CalendarActionResult> {
  const parsed = rangeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid range." };
  const days = (input.daysOfWeek ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const { changes, error } = changesFromForm(input.fields);
  if (!changes) return { error };
  const auth = await authorizeAction("calendar.edit");
  if (!auth.ok) return { error: auth.error };
  try {
    const results = await updateCalendar(await createClient(), {
      ...parsed.data,
      changes,
      daysOfWeek: days.length && days.length < 7 ? days : undefined,
      preview: input.preview,
    });
    if (!input.preview) revalidatePath("/calendar", "layout");
    const changed = results.reduce((s, r) => s + r.nightsChanged, 0);
    return {
      ok: true,
      results,
      message: input.preview ? `${changed} night${changed === 1 ? "" : "s"} would change.` : `Updated ${changed} night${changed === 1 ? "" : "s"}.`,
    };
  } catch (err) {
    return failure(err);
  }
}
