/**
 * Form parsing for the property editor tabs and the create wizard. Each tab maps to a set of
 * `listings` columns; the result is a patch for one UPDATE (autosave per tab). Money inputs are
 * dollars → integer cents; percentages → basis points; times "HH:MM".
 */
import { z } from "zod";

import { CANCELLATION_POLICIES, CLEANING_STATUSES } from "@/lib/properties/constants";
import { parseDollarsToCents, parsePercentToBps } from "@/lib/properties/money";

export const EDITOR_TABS = [
  "overview",
  "location",
  "rooms",
  "amenities",
  "descriptions",
  "photos",
  "booking",
  "fees",
  "custom-fields",
  "channels",
  "ical",
  "log",
] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

export const TAB_LABELS: Record<EditorTab, string> = {
  overview: "Overview",
  location: "Location",
  rooms: "Rooms and beds",
  amenities: "Amenities",
  descriptions: "Descriptions",
  photos: "Photos",
  booking: "Booking rules",
  fees: "Fees and taxes",
  "custom-fields": "Custom fields",
  channels: "Channels",
  ical: "iCal",
  log: "Log",
};

/** Tabs a sub-unit has: content and prices are edited on the parent. */
export const SUB_UNIT_TABS: readonly EditorTab[] = ["overview", "custom-fields", "channels", "ical", "log"];

export function isEditorTab(value: unknown): value is EditorTab {
  return typeof value === "string" && (EDITOR_TABS as readonly string[]).includes(value);
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .transform((v) => (v === "" ? null : v));
const requiredText = (max: number, message: string) => z.string().trim().min(1, message).max(max, `Keep it under ${max} characters`);
const int = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (v === "") return null;
      if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
        ctx.addIssue({ code: "custom", message: `${label} must be a whole number from ${min} to ${max}` });
        return z.NEVER;
      }
      return Number(v);
    });
const requiredInt = (min: number, max: number, label: string) =>
  int(min, max, label).refine((v) => v !== null, `Enter ${label.toLowerCase()}`);
const money = (label: string) =>
  z
    .string()
    .transform((v, ctx) => {
      try {
        return parseDollarsToCents(v);
      } catch {
        ctx.addIssue({ code: "custom", message: `${label}: enter an amount like 150 or 150.50` });
        return z.NEVER;
      }
    });
const moneyOrZero = (label: string) => money(label).transform((v) => v ?? 0);
const percent = (label: string) =>
  z.string().transform((v, ctx) => {
    try {
      return parsePercentToBps(v);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: `${label}: ${(e as Error).message}` });
      return z.NEVER;
    }
  });
const time = (label: string) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (v === "") return null;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
        ctx.addIssue({ code: "custom", message: `${label}: use HH:MM` });
        return z.NEVER;
      }
      return v;
    });
const coordinate = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `${label} must be between ${min} and ${max}` });
        return z.NEVER;
      }
      return Math.round(n * 1e6) / 1e6;
    });

export function parseTags(input: string | null | undefined): string[] {
  return (input ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

const overview = z.object({
  internal_name: requiredText(200, "Enter an internal name"),
  public_title: text(500),
  tags: z.string().transform(parseTags),
});

const unitOverview = overview.extend({ cleaning_status: z.enum(CLEANING_STATUSES) });

const location = z.object({
  address_line1: text(200),
  address_line2: text(200),
  city: text(100),
  state_region: text(100),
  postal_code: text(20),
  country_code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Use a two-letter country code"),
  latitude: coordinate(-90, 90, "Latitude"),
  longitude: coordinate(-180, 180, "Longitude"),
});

const capacity = z.object({
  max_guests: int(1, 100, "Max guests"),
  bedrooms: int(0, 100, "Bedrooms"),
  bathrooms_full: int(0, 100, "Full bathrooms"),
  bathrooms_half: int(0, 100, "Half bathrooms"),
  size_sqft: int(1, 1_000_000, "Size"),
});

const booking = z
  .object({
    base_price_cents: money("Base price"),
    weekend_price_cents: money("Weekend price"),
    weekend_nights: z.array(z.enum(["0", "1", "2", "3", "4", "5", "6"])).transform((d) => [...new Set(d)].map(Number).sort()),
    min_nights: requiredInt(1, 365, "Min nights"),
    max_nights: int(1, 1095, "Max nights"),
    advance_notice_hours: requiredInt(0, 8760, "Advance notice"),
    preparation_nights: requiredInt(0, 30, "Preparation time"),
    booking_window_days: requiredInt(1, 1095, "Booking window"),
    instant_book: z.enum(["true", "false"]).transform((v) => v === "true"),
    weekly_discount_bps: percent("Weekly discount"),
    monthly_discount_bps: percent("Monthly discount"),
    check_in_from: time("Check-in from"),
    check_in_to: time("Check-in until"),
    check_out_by: time("Check-out by"),
    cancellation_policy: z.enum(CANCELLATION_POLICIES),
    cancellation_policy_notes: text(5000),
  })
  .refine((v) => v.max_nights === null || v.min_nights === null || v.max_nights >= v.min_nights, {
    message: "Max nights must be at least min nights",
    path: ["max_nights"],
  });

const fees = z.object({
  cleaning_fee_cents: moneyOrZero("Cleaning fee"),
  extra_guest_fee_cents: moneyOrZero("Extra-guest fee"),
  extra_guest_after: int(1, 100, "Extra guests after"),
  pet_fee_cents: moneyOrZero("Pet fee"),
});

export const LISTING_TAB_SCHEMAS = { overview, unitOverview, location, capacity, booking, fees } as const;
export type ListingTabSchema = keyof typeof LISTING_TAB_SCHEMAS;

/** FormData → plain object (multi-valued fields as arrays when the schema expects one). */
export function formDataToObject(formData: FormData, arrays: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(formData.keys())) {
    if (key.startsWith("$ACTION")) continue;
    out[key] = arrays.includes(key) ? formData.getAll(key).map(String) : String(formData.get(key) ?? "");
  }
  for (const key of arrays) out[key] ??= [];
  return out;
}

export type PatchResult = { ok: true; patch: Record<string, unknown> } | { ok: false; error: string };

export function parseListingPatch(schema: ListingTabSchema, formData: FormData): PatchResult {
  const shape = LISTING_TAB_SCHEMAS[schema];
  const input = formDataToObject(formData, schema === "booking" ? ["weekend_nights"] : []);
  if (schema === "booking" && !("instant_book" in input && input.instant_book)) input.instant_book = "false";
  const parsed = shape.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  return { ok: true, patch: parsed.data as Record<string, unknown> };
}

/** Create wizard: the minimum to make a listing bookable. */
export const wizardSchema = z.object({
  type: z.enum(["single", "multi_parent"]),
  internal_name: requiredText(200, "Enter a name"),
  public_title: text(500),
  address_line1: requiredText(200, "Enter the street address"),
  address_line2: text(200),
  city: requiredText(100, "Enter the city"),
  state_region: text(100),
  postal_code: requiredText(20, "Enter the ZIP code"),
  country_code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use a two-letter country code").default("US"),
  timezone: z.string().trim().min(1, "Choose a timezone"),
  max_guests: requiredInt(1, 100, "Max guests"),
  bedrooms: requiredInt(0, 100, "Bedrooms"),
  bathrooms_full: requiredInt(0, 100, "Bathrooms"),
  base_price_cents: money("Base price").refine((v) => v !== null && v > 0, "Enter a base nightly price"),
  check_in_from: time("Check-in from").refine((v) => v !== null, "Enter a check-in time"),
  check_out_by: time("Check-out by").refine((v) => v !== null, "Enter a check-out time"),
  sub_units: z
    .string()
    .trim()
    .default("")
    .transform((v) => (v === "" ? 0 : Number(v)))
    .refine((n) => Number.isInteger(n) && n >= 0 && n <= 200, "Sub-units: 0 to 200"),
});
export type WizardInput = z.infer<typeof wizardSchema>;

/** Bulk edit (PRP-15): one change at a time from the list screen. */
export const BULK_ACTIONS = {
  base_price_cents: { label: "Set base price", kind: "money" },
  min_nights: { label: "Set min nights", kind: "int" },
  cleaning_fee_cents: { label: "Set cleaning fee", kind: "money" },
  extra_guest_fee_cents: { label: "Set extra-guest fee", kind: "money" },
  pet_fee_cents: { label: "Set pet fee", kind: "money" },
  check_in_from: { label: "Set check-in from", kind: "time" },
  check_out_by: { label: "Set check-out by", kind: "time" },
  add_tags: { label: "Add tags", kind: "tags" },
  remove_tags: { label: "Remove tags", kind: "tags" },
  add_amenities: { label: "Add amenity", kind: "amenity" },
  remove_amenities: { label: "Remove amenity", kind: "amenity" },
} as const;
export type BulkAction = keyof typeof BULK_ACTIONS;

export function parseBulkChange(action: string, value: string): { ok: true; changes: Record<string, unknown> } | { ok: false; error: string } {
  if (!(action in BULK_ACTIONS)) return { ok: false, error: "Choose an action" };
  const kind = BULK_ACTIONS[action as BulkAction].kind;
  try {
    switch (kind) {
      case "money": {
        const cents = parseDollarsToCents(value);
        if (cents === null) return { ok: false, error: "Enter an amount" };
        return { ok: true, changes: { [action]: cents } };
      }
      case "int": {
        if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > 365) return { ok: false, error: "Enter nights from 1 to 365" };
        return { ok: true, changes: { [action]: Number(value) } };
      }
      case "time": {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) return { ok: false, error: "Use HH:MM" };
        return { ok: true, changes: { [action]: value.trim() } };
      }
      case "tags": {
        const tags = parseTags(value);
        if (tags.length === 0) return { ok: false, error: "Enter at least one tag" };
        return { ok: true, changes: { [action]: tags } };
      }
      case "amenity": {
        if (!/^[a-z][a-z0-9_]*$/.test(value)) return { ok: false, error: "Choose an amenity" };
        return { ok: true, changes: { [action]: [value] } };
      }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
