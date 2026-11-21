import type { EventHandler } from "@/lib/events/bus";

/**
 * Registered internal consumers. To add one:
 *   1. a migration inserts into public.event_consumers (name, event_types), and
 *   2. its handler is added here under the same name.
 * Automations (step 7) and notifications (X-06) will be the first consumers.
 */
export const CONSUMERS: Readonly<Record<string, EventHandler>> = {};
