import { ACTIVATION_PROBLEM_LABELS } from "@/lib/properties/constants";

/** Turns database errors raised by the Properties rules into messages for the UI. */
export function propertyErrorMessage(message: string | null | undefined): string {
  const m = message ?? "";
  if (m.startsWith("listing_not_activatable")) {
    const codes = m.split(":")[1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    return `The listing can't be active yet. Missing: ${codes.map((c) => ACTIVATION_PROBLEM_LABELS[c] ?? c).join("; ")}.`;
  }
  if (m.startsWith("listing_has_future_bookings")) return "This listing has future bookings. Move or cancel them first.";
  if (m.startsWith("timezone_change_requires_confirmation")) return "This listing has future bookings. Confirm the timezone change.";
  if (m.startsWith("forbidden") || /row-level security|permission denied/.test(m)) return "You do not have permission to do that.";
  if (m.startsWith("sub_unit_content_on_parent")) return "Sub-units share the parent's content. Edit the parent instead.";
  if (m.startsWith("sub_units_inherit_from_parent")) return "Sub-units inherit prices, rules, times and amenities from their parent. Remove them from the selection or only change tags.";
  if (m.startsWith("parent_archived")) return "That multi-unit parent is archived.";
  if (m.startsWith("not_a_multi_unit_parent")) return "Choose a multi-unit parent.";
  if (m.startsWith("listing_type_change_not_allowed")) return "The listing type can't be changed this way.";
  if (m.startsWith("custom_value_type_mismatch") || m.startsWith("custom_value_not_an_option")) return "That value doesn't fit the field type.";
  if (m.startsWith("custom_field_immutable")) return "A field's key and type can't change after it is created.";
  if (m.startsWith("an archived listing is restored to draft first")) return "Restore the listing to draft before activating it.";
  if (m.includes("listings_min_le_max")) return "Max nights must be at least min nights.";
  if (m.includes("invalid timezone")) return "Choose a valid timezone.";
  if (m.includes("duplicate key") && m.includes("custom_fields_account_id_key_key")) return "A field with that key already exists.";
  if (m.startsWith("not_found")) return "Not found, or you don't have access to it.";
  return "Something went wrong. Try again.";
}
