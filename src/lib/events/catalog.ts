/**
 * X-04 catalog of domain event types. Each module emits its events from SQL in the same
 * transaction as the change (private.emit_event); this list is what webhooks and the internal
 * bus can subscribe to. Types marked `planned` are emitted once their module is built.
 */

export const EVENT_TYPES = {
  // Step 1 — foundations
  "account.created": { module: "account", planned: false },
  "account.updated": { module: "account", planned: false },
  "membership.created": { module: "account", planned: false },
  "membership.updated": { module: "account", planned: false },
  "membership.removed": { module: "account", planned: false },
  "invitation.created": { module: "account", planned: false },
  "invitation.updated": { module: "account", planned: false },
  "webhook_endpoint.created": { module: "account", planned: false },
  "webhook_endpoint.updated": { module: "account", planned: false },

  // Step 3 — properties
  "listing.created": { module: "properties", planned: false },
  "listing.updated": { module: "properties", planned: false },
  "listing.status_changed": { module: "properties", planned: false },
  "listing.cleaning_status_changed": { module: "properties", planned: false },
  "listing.content_updated": { module: "properties", planned: false },
  "custom_field.created": { module: "properties", planned: false },
  "custom_field.updated": { module: "properties", planned: false },
  "listing_channel_link.created": { module: "properties", planned: false },
  "listing_channel_link.updated": { module: "properties", planned: false },

  // CAL-14
  "calendar.updated": { module: "calendar", planned: false },
  // Step 4 — reservations (RES-19)
  "reservation.created": { module: "reservations", planned: false },
  "reservation.updated": { module: "reservations", planned: false },
  "reservation.status_changed": { module: "reservations", planned: false },
  "reservation.dates_changed": { module: "reservations", planned: false },
  "guest.created": { module: "reservations", planned: false },
  "guest.updated": { module: "reservations", planned: false },
  "quote.created": { module: "reservations", planned: false },
  "quote.updated": { module: "reservations", planned: false },
  // INB-16
  "message.received": { module: "inbox", planned: true },
  "message.sent": { module: "inbox", planned: true },
  // TSK-17
  "task.created": { module: "tasks", planned: true },
  "task.updated": { module: "tasks", planned: true },
  "task.completed": { module: "tasks", planned: true },
} as const satisfies Record<string, { module: string; planned: boolean }>;

export type EventType = keyof typeof EVENT_TYPES;

export const ALL_EVENT_TYPES = Object.keys(EVENT_TYPES) as EventType[];

/** Same rule as private.event_type_matches: '*', 'prefix.*' or an exact type. */
export function eventTypeMatches(patterns: readonly string[], type: string): boolean {
  return patterns.some(
    (p) => p === "*" || p === type || (p.endsWith(".*") && type.startsWith(p.slice(0, -1))),
  );
}

const PATTERN = /^(\*|[a-z][a-z_]*(\.[a-z][a-z_]*)*\.\*|[a-z][a-z_]*(\.[a-z][a-z_]*)+)$/;

/** A subscription pattern is valid if it is well-formed and matches at least one known type. */
export function isValidEventPattern(pattern: string): boolean {
  if (!PATTERN.test(pattern)) return false;
  return ALL_EVENT_TYPES.some((t) => eventTypeMatches([pattern], t));
}
