/**
 * CAL-10: external events → the nights they block in the listing's timezone. The result is
 * what the database diffs against the feed's imported events (public.apply_ical_feed_sync).
 *
 *   check_in  = listing-local date of DTSTART
 *   check_out = listing-local date of DTEND (exclusive), at least check_in + 1
 */
import { addDays, isIsoDate, localToday, nightsBetween } from "@/lib/calendar/dates";

import type { IcalEvent, IcalTime } from "./parse";

export interface DesiredBlock {
  uid: string;
  check_in: string;
  check_out: string;
}

export interface SkippedCounts {
  cancelled: number;
  recurring: number;
  past: number;
  invalid: number;
  duplicate: number;
}

export interface NormalizeOptions {
  timeZone: string;
  /** Listing-local today; events that ended before it are dropped. */
  today?: string;
  maxEvents?: number;
}

/** Same limit as calendar_holds (check_out - check_in <= 1100). */
export const MAX_BLOCK_NIGHTS = 1100;
export const MAX_FEED_EVENTS = 5000;
export const MAX_UID_LENGTH = 500;

const zoneCache = new Map<string, boolean>();

export function isValidTimeZone(tz: string): boolean {
  let ok = zoneCache.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    zoneCache.set(tz, ok);
  }
  return ok;
}

/** Offset (ms) of `timeZone` from UTC at instant `ms`. */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock `YYYY-MM-DDTHH:MM:SS` in `timeZone` → UTC instant (ms). */
export function zonedTimeToUtc(dateTime: string, timeZone: string): number {
  const [d, t] = dateTime.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi, s] = t.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, da, h, mi, s);
  let guess = wall - zoneOffset(wall, timeZone);
  // A second pass settles instants next to a DST change.
  guess = wall - zoneOffset(guess, timeZone);
  return guess;
}

/** The listing-local date of an iCal time; also returns the instant for date-times. */
function localDate(time: IcalTime, timeZone: string): { date: string; instant: number | null } {
  if (time.kind === "date") return { date: time.date, instant: null };
  let instant: number;
  if (time.kind === "utc") {
    instant = time.instant;
  } else {
    const zone = time.tzid && isValidTimeZone(time.tzid) ? time.tzid : timeZone;
    if (zone === timeZone) return { date: time.dateTime.slice(0, 10), instant: zonedTimeToUtc(time.dateTime, zone) };
    instant = zonedTimeToUtc(time.dateTime, zone);
  }
  return { date: localToday(timeZone, new Date(instant)), instant };
}

/** RFC 5545 DURATION (P1W, P2DT3H, PT90M, …) in ms and whole days; null when malformed or negative. */
export function parseDuration(value: string): { days: number; ms: number } | null {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m || value === "P" || value.endsWith("T")) return null;
  const [, w, d, h, mi, s] = m.map((x) => Number(x ?? 0));
  const days = w * 7 + d;
  return { days, ms: days * 86_400_000 + ((h * 60 + mi) * 60 + s) * 1000 };
}

function eventRange(e: IcalEvent, timeZone: string): { check_in: string; check_out: string } | null {
  if (!e.start) return null;
  const start = localDate(e.start, timeZone);
  let endDate: string;
  if (e.end) {
    if (e.end.kind === "date" && e.start.kind !== "date") return null; // mixed value types: invalid per RFC 5545
    endDate = localDate(e.end, timeZone).date;
  } else if (e.duration) {
    const dur = parseDuration(e.duration);
    if (!dur) return null;
    if (e.start.kind === "date") {
      endDate = addDays(start.date, dur.days);
    } else {
      endDate = localToday(timeZone, new Date((start.instant ?? 0) + dur.ms));
    }
  } else {
    endDate = addDays(start.date, 1);
  }
  if (endDate < start.date) return null;
  const checkOut = endDate > start.date ? endDate : addDays(start.date, 1);
  return { check_in: start.date, check_out: checkOut };
}

/**
 * Turns parsed events into the blocks the feed asks for. Cancelled and recurring events are not
 * imported (recurrence is not expanded; booking feeds do not use it), nor events that are over.
 */
export function normalizeEvents(events: IcalEvent[], opts: NormalizeOptions): { blocks: DesiredBlock[]; skipped: SkippedCounts } {
  const maxEvents = opts.maxEvents ?? MAX_FEED_EVENTS;
  if (events.length > maxEvents) throw new Error(`The feed has more than ${maxEvents} events`);
  const today = opts.today ?? localToday(opts.timeZone);
  const skipped: SkippedCounts = { cancelled: 0, recurring: 0, past: 0, invalid: 0, duplicate: 0 };
  const byUid = new Map<string, DesiredBlock & { sequence: number }>();

  for (const e of events) {
    if (e.recurring) {
      skipped.recurring++;
      continue;
    }
    const range = eventRange(e, opts.timeZone);
    if (!range || !isIsoDate(range.check_in) || !isIsoDate(range.check_out)) {
      skipped.invalid++;
      continue;
    }
    if (e.status === "CANCELLED") {
      skipped.cancelled++;
      continue;
    }
    if (range.check_out <= today) {
      skipped.past++;
      continue;
    }
    if (nightsBetween(range.check_in, range.check_out) > MAX_BLOCK_NIGHTS) {
      range.check_out = addDays(range.check_in, MAX_BLOCK_NIGHTS);
    }
    const uid = (e.uid ?? `nouid:${range.check_in}:${range.check_out}`).slice(0, MAX_UID_LENGTH);
    const existing = byUid.get(uid);
    if (existing) {
      skipped.duplicate++;
      if (existing.sequence >= e.sequence) continue;
    }
    byUid.set(uid, { uid, ...range, sequence: e.sequence });
  }

  const blocks = [...byUid.values()].map(({ uid, check_in, check_out }) => ({ uid, check_in, check_out }));
  return { blocks, skipped };
}
