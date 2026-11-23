/**
 * Step 7 automations: rule shapes, labels and the starter library (AUT-11). Client-safe. The
 * database (public.save_automation_rule) validates every rule again.
 */
import { z } from "zod";

export const TRIGGERS = ["reservation_confirmed", "reservation_created", "reservation_canceled", "dates_changed", "check_in", "check_out"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const TRIGGER_LABELS: Record<Trigger, string> = {
  reservation_confirmed: "Reservation confirmed",
  reservation_created: "Reservation created (any status)",
  reservation_canceled: "Reservation canceled",
  dates_changed: "Reservation dates changed",
  check_in: "Check-in",
  check_out: "Check-out",
};

export const isTimeAnchored = (t: Trigger) => t === "check_in" || t === "check_out";

export type MessageAction = { kind: "message"; recipient: "guest" | "email"; email?: string; subject?: string; body: string; variants?: Record<string, string> };
export type AgentAction = { kind: "agent_draft"; instructions: string };
export type RuleAction = MessageAction | AgentAction;

export interface RuleConditions {
  listing_ids?: string[];
  exclude_listing_ids?: string[];
  tags?: string[];
  exclude_tags?: string[];
  sources?: string[];
  languages?: string[];
  min_nights?: number;
  max_nights?: number;
  min_guests?: number;
  max_guests?: number;
  min_lead_days?: number;
  max_lead_days?: number;
}

export interface RulePayload {
  name: string;
  status: "active" | "paused";
  trigger: Trigger;
  offset_minutes: number;
  at_time: string | null;
  conditions: RuleConditions;
  action: RuleAction;
  expire_after_hours: number | null;
  starter_key?: string | null;
}

export const OFFSET_UNITS = { minutes: 1, hours: 60, days: 1440 } as const;
export type OffsetUnit = keyof typeof OFFSET_UNITS;

/** Signed minutes → the builder's amount, unit and direction. */
export function splitOffset(minutes: number): { amount: number; unit: OffsetUnit; direction: "before" | "after" } {
  const abs = Math.abs(minutes);
  const unit: OffsetUnit = abs === 0 || abs % 1440 === 0 ? "days" : abs % 60 === 0 ? "hours" : "minutes";
  return { amount: abs / OFFSET_UNITS[unit], unit, direction: minutes < 0 ? "before" : "after" };
}

export function joinOffset(amount: number, unit: OffsetUnit, direction: "before" | "after"): number {
  const m = Math.round(amount * OFFSET_UNITS[unit]);
  return direction === "before" ? -m : m;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "2 days before check-in at 10:00", "Immediately after the reservation is confirmed". */
export function describeTiming(rule: Pick<RulePayload, "trigger" | "offset_minutes" | "at_time">): string {
  const anchor: Record<Trigger, string> = {
    reservation_confirmed: "the reservation is confirmed",
    reservation_created: "the reservation is created",
    reservation_canceled: "the reservation is canceled",
    dates_changed: "the dates change",
    check_in: "check-in",
    check_out: "check-out",
  };
  const at = rule.at_time ? ` at ${rule.at_time.slice(0, 5)}` : "";
  if (rule.offset_minutes === 0) {
    return isTimeAnchored(rule.trigger) ? `On ${anchor[rule.trigger]}${at || " time"}` : `Immediately when ${anchor[rule.trigger]}${at ? `, at ${rule.at_time!.slice(0, 5)}` : ""}`;
  }
  const { amount, unit, direction } = splitOffset(rule.offset_minutes);
  const when = isTimeAnchored(rule.trigger) ? anchor[rule.trigger] : `${anchor[rule.trigger]}`;
  return `${plural(amount, unit.slice(0, -1))} ${direction} ${isTimeAnchored(rule.trigger) ? when : `${when}`}${at}`;
}

export function describeAction(action: RuleAction): string {
  if (action.kind === "agent_draft") return "AI agent drafts a message for approval";
  return action.recipient === "guest" ? "Send message to the guest" : `Send email to ${action.email}`;
}

export function describeConditions(c: RuleConditions, listingNames: Map<string, string> = new Map()): string {
  const parts: string[] = [];
  const names = (ids?: string[]) => (ids ?? []).map((id) => listingNames.get(id) ?? "a listing").join(", ");
  if (c.listing_ids?.length) parts.push(`listings: ${names(c.listing_ids)}`);
  if (c.exclude_listing_ids?.length) parts.push(`not ${names(c.exclude_listing_ids)}`);
  if (c.tags?.length) parts.push(`tagged ${c.tags.join(", ")}`);
  if (c.exclude_tags?.length) parts.push(`not tagged ${c.exclude_tags.join(", ")}`);
  if (c.sources?.length) parts.push(`from ${c.sources.join(", ")}`);
  if (c.min_nights != null) parts.push(`≥ ${c.min_nights} nights`);
  if (c.max_nights != null) parts.push(`≤ ${c.max_nights} nights`);
  if (c.min_guests != null) parts.push(`≥ ${c.min_guests} guests`);
  if (c.max_guests != null) parts.push(`≤ ${c.max_guests} guests`);
  if (c.languages?.length) parts.push(`language ${c.languages.join(", ")}`);
  if (c.min_lead_days != null) parts.push(`booked ≥ ${c.min_lead_days} days ahead`);
  if (c.max_lead_days != null) parts.push(`booked ≤ ${c.max_lead_days} days ahead`);
  return parts.length ? parts.join(" · ") : "All guest reservations";
}

/** Picks the message text for the guest's language: exact, then base language, then default. */
export function pickBody(action: MessageAction, language: string | null | undefined): string {
  const v = action.variants ?? {};
  if (language && v[language]) return v[language];
  const base = language?.split("-")[0];
  if (base && v[base]) return v[base];
  return action.body;
}

// ---------------------------------------------------------------------------
// Builder form → payload
// ---------------------------------------------------------------------------

const list = (v: unknown) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const num = (v: unknown) => (v === undefined || v === null || String(v).trim() === "" ? undefined : Number(v));

const formSchema = z.object({
  name: z.string().trim().min(1, "Give the rule a name").max(120),
  status: z.enum(["active", "paused"]).default("active"),
  trigger: z.enum(TRIGGERS),
  offset_amount: z.coerce.number().min(0).max(365 * 1440).default(0),
  offset_unit: z.enum(["minutes", "hours", "days"]).default("days"),
  offset_direction: z.enum(["before", "after"]).default("after"),
  at_time: z.string().regex(/^(\d{2}:\d{2})?$/, "Enter a time like 10:00").default(""),
  action_kind: z.enum(["message", "agent_draft"]).default("message"),
  recipient: z.enum(["guest", "email"]).default("guest"),
  email: z.string().trim().max(254).default(""),
  subject: z.string().trim().max(300).default(""),
  body: z.string().max(10000).default(""),
  instructions: z.string().max(2000).default(""),
  expire_after_hours: z.string().default(""),
  starter_key: z.string().default(""),
});

/** FormData (or a plain object) from the rule builder → the payload save_automation_rule takes. */
export function payloadFromForm(input: Record<string, unknown>): { payload?: RulePayload; error?: string } {
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const f = parsed.data;
  const offset = joinOffset(f.offset_amount, f.offset_unit, isTimeAnchored(f.trigger) ? f.offset_direction : "after");
  const variants: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    const m = /^variant_([a-z]{2})$/.exec(k);
    if (m && String(v).trim()) variants[m[1]] = String(v);
  }
  const conditions: RuleConditions = {};
  const ids = list(input.listing_ids);
  const exIds = list(input.exclude_listing_ids);
  const tags = list(input.tags);
  const exTags = list(input.exclude_tags);
  const sources = list(input.sources);
  const languages = list(input.languages).map((l) => l.toLowerCase());
  if (ids.length) conditions.listing_ids = ids;
  if (exIds.length) conditions.exclude_listing_ids = exIds;
  if (tags.length) conditions.tags = tags;
  if (exTags.length) conditions.exclude_tags = exTags;
  if (sources.length) conditions.sources = sources;
  if (languages.length) conditions.languages = languages;
  for (const k of ["min_nights", "max_nights", "min_guests", "max_guests", "min_lead_days", "max_lead_days"] as const) {
    const n = num(input[k]);
    if (n !== undefined) {
      if (!Number.isFinite(n) || n < 0 || n > 1000) return { error: "Numbers in conditions are 0 to 1000." };
      conditions[k] = n;
    }
  }
  const action: RuleAction =
    f.action_kind === "agent_draft"
      ? { kind: "agent_draft", instructions: f.instructions.trim() }
      : {
          kind: "message",
          recipient: f.recipient,
          ...(f.recipient === "email" ? { email: f.email } : {}),
          ...(f.subject ? { subject: f.subject } : {}),
          body: f.body,
          ...(Object.keys(variants).length ? { variants } : {}),
        };
  const expire = num(f.expire_after_hours);
  return {
    payload: {
      name: f.name,
      status: f.status,
      trigger: f.trigger,
      offset_minutes: offset,
      at_time: f.at_time || null,
      conditions,
      action,
      expire_after_hours: expire ?? null,
      starter_key: f.starter_key || null,
    },
  };
}

// ---------------------------------------------------------------------------
// AUT-11 starter rules
// ---------------------------------------------------------------------------

export const STARTERS: { key: string; title: string; summary: string; payload: Omit<RulePayload, "status"> }[] = [
  {
    key: "booking_confirmation",
    title: "Booking confirmation",
    summary: "Right after a reservation is confirmed.",
    payload: {
      name: "Booking confirmation",
      trigger: "reservation_confirmed",
      offset_minutes: 0,
      at_time: null,
      conditions: {},
      expire_after_hours: 24,
      action: {
        kind: "message",
        recipient: "guest",
        subject: "Your stay at {{listing.title}} is confirmed",
        body: "Hi {{guest.first_name}},\n\nThank you for booking {{listing.title}}! Your stay from {{reservation.check_in}} to {{reservation.check_out}} is confirmed (code {{reservation.code}}).\n\nWe'll send check-in instructions a couple of days before you arrive.\n\n{{account.name}}",
      },
    },
  },
  {
    key: "check_in_instructions",
    title: "Check-in instructions",
    summary: "2 days before check-in at 10:00.",
    payload: {
      name: "Check-in instructions",
      trigger: "check_in",
      offset_minutes: -2 * 1440,
      at_time: "10:00",
      conditions: {},
      expire_after_hours: 12,
      action: {
        kind: "message",
        recipient: "guest",
        subject: "Check-in details for {{listing.title}}",
        body: "Hi {{guest.first_name}},\n\nWe're looking forward to welcoming you on {{reservation.check_in}}. Check-in is from {{listing.check_in_from}} at {{listing.address}}.\n\nLet us know your arrival time and anything you need.\n\n{{account.name}}",
      },
    },
  },
  {
    key: "mid_stay_check",
    title: "Mid-stay check",
    summary: "1 day after check-in at 11:00.",
    payload: {
      name: "Mid-stay check",
      trigger: "check_in",
      offset_minutes: 1440,
      at_time: "11:00",
      conditions: { min_nights: 3 },
      expire_after_hours: 6,
      action: {
        kind: "message",
        recipient: "guest",
        body: "Hi {{guest.first_name}}, we hope you're settling in well at {{listing.title}}! Is there anything we can help with?",
      },
    },
  },
  {
    key: "check_out_reminder",
    title: "Check-out reminder",
    summary: "The evening before check-out at 18:00.",
    payload: {
      name: "Check-out reminder",
      trigger: "check_out",
      offset_minutes: -1440,
      at_time: "18:00",
      conditions: {},
      expire_after_hours: 6,
      action: {
        kind: "message",
        recipient: "guest",
        body: "Hi {{guest.first_name}}, a quick reminder that check-out is tomorrow by {{listing.check_out_by}}. Thank you for staying with us!",
      },
    },
  },
  {
    key: "review_request",
    title: "Review request",
    summary: "1 day after check-out at 11:00.",
    payload: {
      name: "Review request",
      trigger: "check_out",
      offset_minutes: 1440,
      at_time: "11:00",
      conditions: {},
      expire_after_hours: 48,
      action: {
        kind: "message",
        recipient: "guest",
        body: "Hi {{guest.first_name}},\n\nThank you for staying at {{listing.title}}! If you enjoyed your stay, a short review would mean a lot to us.\n\n{{account.name}}",
      },
    },
  },
];
