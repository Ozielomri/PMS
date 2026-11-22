/** Turns database error messages from the reservation RPCs into short, user-facing text. */
const MESSAGES: [prefix: string, text: string][] = [
  ["calendar_conflict", "Those nights are not available."],
  ["calendar_rule_violation", "The stay breaks a booking rule of the listing."],
  ["reservation_transition_invalid", "That change is not possible for a reservation in this status."],
  ["reservation_final", "This reservation is closed; only tags and notes can change."],
  ["reservation_in_progress", "The stay has started, so this cannot be changed."],
  ["stay_status_transition_invalid", "That stay status change is not possible."],
  ["change_on_channel", "This booking belongs to a channel. Change it on the channel; the PMS will follow."],
  ["approval_deadline_passed", "The approval deadline has passed; the request has expired."],
  ["override_reason_required", "Enter a reason for the price override."],
  ["guest_required", "Choose or create a guest."],
  ["financials_locked", "The financials are locked 30 days after check-out; add an adjustment with a reason instead."],
  ["listing_not_bookable", "This listing cannot take bookings (archived, draft or a complex)."],
  ["price_missing", "The listing has no price for some nights."],
  ["owner_stay_no_money", "Owner stays have no price."],
  ["invalid_unit", "Pick a unit of the same multi-unit."],
  ["quote_not_open", "This quote has expired or was withdrawn."],
  ["quote_not_found", "Quote not found."],
  ["guest_already_merged", "One of these guests was merged already."],
  ["invalid_dates", "Check-out must be after check-in."],
  ["invalid_expiry", "Choose an expiry in the next 60 days."],
  ["channel_source", "Channel bookings come from the channel; choose another source."],
  ["reservation_not_found", "Reservation not found."],
  ["invalid_extra", "Extras are positive amounts; use an adjustment for a credit."],
  ["invalid_price", "The total cannot be negative."],
  ["invalid_guests", "Check the number of guests."],
  ["guest_not_found", "Guest not found."],
  ["hold_not_active", "The calendar hold of this booking is no longer active."],
  ["listing_not_found", "Listing not found."],
  ["invalid_refund_percent", "The refund must be 0 to 100 %."],
  ["invalid_options", "A quote has 1 to 10 options."],
  ["forbidden", "You do not have permission to do that."],
];

export function reservationErrorMessage(message: string | null | undefined): string {
  const m = message ?? "";
  for (const [prefix, text] of MESSAGES) {
    if (m.startsWith(prefix)) {
      // Calendar conflicts name what is in the way; keep that part.
      if (prefix === "calendar_conflict") {
        const detail = m.split(": ").slice(2).join(": ");
        return detail ? `${text} (${detail.replace(/\(hold [0-9a-f-]+\)/g, "").trim()})` : text;
      }
      return text;
    }
  }
  return "Something went wrong. Try again.";
}
