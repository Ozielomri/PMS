/** Labels and enumerations shared by the Properties screens, server actions and tests. */

export const LISTING_TYPES = ["single", "multi_parent", "sub_unit", "complex"] as const;
export type ListingType = (typeof LISTING_TYPES)[number];
export const LISTING_TYPE_LABELS: Record<ListingType, string> = {
  single: "Single unit",
  multi_parent: "Multi-unit",
  sub_unit: "Sub-unit",
  complex: "Complex",
};

export const LISTING_STATUSES = ["draft", "active", "archived"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export const LISTING_STATUS_LABELS: Record<ListingStatus, string> = { draft: "Draft", active: "Active", archived: "Archived" };
export const LISTING_STATUS_TONE: Record<ListingStatus, "green" | "neutral" | "amber"> = { draft: "amber", active: "green", archived: "neutral" };

export const CLEANING_STATUSES = ["clean", "dirty", "in_progress", "inspected"] as const;
export type CleaningStatus = (typeof CLEANING_STATUSES)[number];
export const CLEANING_STATUS_LABELS: Record<CleaningStatus, string> = {
  clean: "Clean",
  dirty: "Dirty",
  in_progress: "In progress",
  inspected: "Inspected",
};
export const CLEANING_STATUS_TONE: Record<CleaningStatus, "green" | "red" | "amber" | "neutral"> = {
  clean: "green",
  dirty: "red",
  in_progress: "amber",
  inspected: "green",
};

export const CANCELLATION_POLICIES = ["flexible", "moderate", "strict", "non_refundable", "custom"] as const;
export type CancellationPolicy = (typeof CANCELLATION_POLICIES)[number];
export const CANCELLATION_POLICY_LABELS: Record<CancellationPolicy, string> = {
  flexible: "Flexible",
  moderate: "Moderate",
  strict: "Strict",
  non_refundable: "Non-refundable",
  custom: "Custom",
};

export const ROOM_TYPES = ["bedroom", "living_room", "bathroom", "kitchen", "dining_room", "outdoor", "other"] as const;
export type RoomType = (typeof ROOM_TYPES)[number];
export const ROOM_TYPE_LABELS: Record<RoomType, string> = {
  bedroom: "Bedroom",
  living_room: "Living room",
  bathroom: "Bathroom",
  kitchen: "Kitchen",
  dining_room: "Dining room",
  outdoor: "Outdoor",
  other: "Other",
};

export const BED_TYPES = ["king", "queen", "double", "single", "sofa_bed", "bunk_bed", "crib", "air_mattress", "futon"] as const;
export type BedType = (typeof BED_TYPES)[number];
export const BED_TYPE_LABELS: Record<BedType, string> = {
  king: "King",
  queen: "Queen",
  double: "Double / full",
  single: "Single / twin",
  sofa_bed: "Sofa bed",
  bunk_bed: "Bunk bed",
  crib: "Crib",
  air_mattress: "Air mattress",
  futon: "Futon",
};

export const CUSTOM_FIELD_TYPES = ["text", "number", "date", "dropdown", "secret"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  dropdown: "Dropdown",
  secret: "Secret (encrypted, masked)",
};

/** Codes returned by public.listing_activation_problems(). */
export const ACTIVATION_PROBLEM_LABELS: Record<string, string> = {
  address: "Address (street, city, ZIP code, country)",
  timezone: "Timezone",
  capacity: "Capacity (max guests, bedrooms, full bathrooms)",
  base_price: "Base nightly price",
  check_in_out_times: "Check-in and check-out times",
  photo: "At least one photo",
  sub_units: "At least one sub-unit",
  parent_not_active: "The multi-unit parent must be active",
  not_bookable: "Complexes are not bookable",
  not_found: "Listing not found",
};

export const CHANNEL_LABELS: Record<string, string> = { booking_com: "Booking.com" };
export const SYNC_MODE_LABELS: Record<string, string> = {
  full: "Full sync",
  availability_and_rates: "Availability and rates",
  availability_only: "Availability only",
  paused: "Paused",
};

/**
 * Description fields with the character limit shown next to each field. The database caps every
 * field at 10 000 characters; the limits below are working values for Booking.com, to be
 * confirmed against the Connectivity API in step 9.
 */
export const DESCRIPTION_FIELDS = [
  { key: "summary", label: "Summary", limit: 500 },
  { key: "space", label: "The space", limit: 5000 },
  { key: "neighborhood", label: "Neighborhood", limit: 2000 },
  { key: "transit", label: "Getting around", limit: 2000 },
  { key: "house_rules", label: "House rules", limit: 2000 },
  { key: "access_notes", label: "Guest access notes", limit: 2000 },
] as const;
export type DescriptionKey = (typeof DESCRIPTION_FIELDS)[number]["key"];

export const DESCRIPTION_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
  { value: "it", label: "Italian" },
  { value: "nl", label: "Dutch" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
] as const;

export function characterCount(value: string | null | undefined, limit: number) {
  const count = [...(value ?? "")].length;
  return { count, limit, over: count > limit };
}
