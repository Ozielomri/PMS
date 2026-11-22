/**
 * RES-03 reservation status machine. Mirrors private.reservation_transition_allowed and
 * private.stay_transition_allowed (migration 20261123002100); a DB test checks they match.
 */

export const RESERVATION_STATUSES = ["inquiry", "reserved", "confirmed", "declined", "expired", "closed", "canceled"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const STAY_STATUSES = ["upcoming", "checked_in", "checked_out", "no_show"] as const;
export type StayStatus = (typeof STAY_STATUSES)[number];

export const TRANSITIONS: Readonly<Record<ReservationStatus, readonly ReservationStatus[]>> = {
  inquiry: ["reserved", "confirmed", "closed"],
  reserved: ["confirmed", "declined", "expired"],
  confirmed: ["canceled"],
  declined: [],
  expired: [],
  closed: [],
  canceled: [],
};

export const STAY_TRANSITIONS: Readonly<Record<StayStatus, readonly StayStatus[]>> = {
  upcoming: ["checked_in", "no_show"],
  checked_in: ["checked_out"],
  checked_out: [],
  no_show: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function canChangeStay(from: StayStatus, to: StayStatus): boolean {
  return STAY_TRANSITIONS[from].includes(to);
}

export function isFinal(status: ReservationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Does this status hold nights on the calendar? */
export function blocksCalendar(status: ReservationStatus): boolean {
  return status === "reserved" || status === "confirmed";
}

export const STATUS_LABELS: Record<ReservationStatus, string> = {
  inquiry: "Inquiry",
  reserved: "Pending approval",
  confirmed: "Confirmed",
  declined: "Declined",
  expired: "Expired",
  closed: "Closed",
  canceled: "Canceled",
};

export const STATUS_TONE: Record<ReservationStatus, "neutral" | "green" | "amber" | "red"> = {
  inquiry: "neutral",
  reserved: "amber",
  confirmed: "green",
  declined: "red",
  expired: "neutral",
  closed: "neutral",
  canceled: "red",
};

export const STAY_LABELS: Record<StayStatus, string> = {
  upcoming: "Upcoming",
  checked_in: "Checked in",
  checked_out: "Checked out",
  no_show: "No-show",
};

export const SOURCES = ["direct", "phone", "email", "walk_in", "website", "booking_com", "airbnb", "vrbo", "owner", "other"] as const;
export type ReservationSource = (typeof SOURCES)[number];

export const CHANNEL_SOURCES: readonly ReservationSource[] = ["booking_com", "airbnb", "vrbo"];
/** Sources a user can pick when creating a booking by hand. */
export const MANUAL_SOURCES = SOURCES.filter((s) => !CHANNEL_SOURCES.includes(s) && s !== "owner");

export const SOURCE_LABELS: Record<ReservationSource, string> = {
  direct: "Direct",
  phone: "Phone",
  email: "Email",
  walk_in: "Walk-in",
  website: "Website",
  booking_com: "Booking.com",
  airbnb: "Airbnb",
  vrbo: "Vrbo",
  owner: "Owner",
  other: "Other",
};

/** Bar colour per source on the calendar grid (Tailwind classes). */
export const SOURCE_COLORS: Record<ReservationSource, string> = {
  direct: "bg-emerald-600",
  phone: "bg-emerald-600",
  email: "bg-emerald-600",
  walk_in: "bg-emerald-600",
  website: "bg-teal-600",
  booking_com: "bg-blue-700",
  airbnb: "bg-rose-600",
  vrbo: "bg-indigo-600",
  owner: "bg-violet-600",
  other: "bg-slate-600",
};

export function isChannelSource(source: string): boolean {
  return (CHANNEL_SOURCES as readonly string[]).includes(source);
}
