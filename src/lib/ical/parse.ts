/**
 * CAL-10: a small RFC 5545 reader for availability feeds (Airbnb, Vrbo, Booking.com, Google).
 * Only VEVENT components and the properties that decide which nights are busy are read; guest
 * details (SUMMARY, DESCRIPTION) are deliberately not kept.
 */

export class IcalParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IcalParseError";
  }
}

export type IcalTime =
  /** VALUE=DATE: an all-day date. */
  | { kind: "date"; date: string }
  /** DATE-TIME with a trailing Z: an instant (ms since epoch). */
  | { kind: "utc"; instant: number }
  /** DATE-TIME in a TZID, or floating (tzid null = the listing timezone). */
  | { kind: "local"; dateTime: string; tzid: string | null };

export interface IcalEvent {
  uid: string | null;
  start: IcalTime | null;
  end: IcalTime | null;
  /** RFC 5545 DURATION, when there is no DTEND. */
  duration: string | null;
  /** Upper-cased STATUS (TENTATIVE, CONFIRMED, CANCELLED) or null. */
  status: string | null;
  sequence: number;
  /** Has RRULE / RDATE or is an override (RECURRENCE-ID). Not expanded. */
  recurring: boolean;
}

export interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Splits into logical lines: CRLF or bare LF, continuation lines start with a space or tab. */
export function unfoldLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else if (raw !== "") {
      out.push(raw);
    }
  }
  return out;
}

/** `NAME;P1=v;P2="a:b":value` → parts. Returns null for a line without a value. */
export function parseContentLine(line: string): ContentLine | null {
  let i = 0;
  let inQuotes = false;
  const parts: string[] = [];
  let current = "";
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (!inQuotes && ch === ";") {
      parts.push(current);
      current = "";
    } else if (!inQuotes && ch === ":") {
      parts.push(current);
      break;
    } else {
      current += ch;
    }
  }
  if (i >= line.length) return null;
  const [name, ...rawParams] = parts;
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    let v = p.slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    params[p.slice(0, eq).toUpperCase()] = v;
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** TEXT value unescaping (\\n, \\, \; \,). */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function validDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** DTSTART / DTEND value → IcalTime, or null when malformed. */
export function parseTime(line: ContentLine): IcalTime | null {
  const value = line.value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    const date = validDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
    return date ? { kind: "date", date } : null;
  }
  if (line.params.VALUE?.toUpperCase() === "DATE") return null;
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(value);
  if (!dt) return null;
  const [, y, mo, d, h, mi, s, z] = dt;
  const date = validDate(Number(y), Number(mo), Number(d));
  if (!date || Number(h) > 23 || Number(mi) > 59 || Number(s) > 60) return null;
  if (z) return { kind: "utc", instant: Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Math.min(Number(s), 59)) };
  return { kind: "local", dateTime: `${date}T${h}:${mi}:${s === "60" ? "59" : s}`, tzid: line.params.TZID?.trim() || null };
}

/** Reads every top-level VEVENT of a VCALENDAR. Throws IcalParseError when it is not a calendar. */
export function parseIcs(text: string): { events: IcalEvent[] } {
  const lines = unfoldLines(text);
  if (lines.length === 0 || lines[0].trim().toUpperCase() !== "BEGIN:VCALENDAR") {
    throw new IcalParseError("Not an iCal feed (it does not start with BEGIN:VCALENDAR)");
  }
  const events: IcalEvent[] = [];
  const stack: string[] = [];
  let event: IcalEvent | null = null;
  let ended = false;

  for (const raw of lines) {
    const line = parseContentLine(raw);
    if (!line) continue;
    if (line.name === "BEGIN") {
      const component = line.value.trim().toUpperCase();
      stack.push(component);
      if (component === "VEVENT" && stack.length === 2 && stack[0] === "VCALENDAR") {
        event = { uid: null, start: null, end: null, duration: null, status: null, sequence: 0, recurring: false };
      }
      continue;
    }
    if (line.name === "END") {
      const component = line.value.trim().toUpperCase();
      if (stack[stack.length - 1] === component) stack.pop();
      if (component === "VEVENT" && event && stack.length === 1) {
        events.push(event);
        event = null;
      }
      if (component === "VCALENDAR" && stack.length === 0) {
        ended = true;
        break;
      }
      continue;
    }
    if (!event || stack.length !== 2) continue;
    switch (line.name) {
      case "UID":
        event.uid = unescapeText(line.value).trim() || null;
        break;
      case "DTSTART":
        event.start = parseTime(line);
        break;
      case "DTEND":
        event.end = parseTime(line);
        break;
      case "DURATION":
        event.duration = line.value.trim().toUpperCase();
        break;
      case "STATUS":
        event.status = line.value.trim().toUpperCase() || null;
        break;
      case "SEQUENCE": {
        const n = Number.parseInt(line.value, 10);
        event.sequence = Number.isFinite(n) ? n : 0;
        break;
      }
      case "RRULE":
      case "RDATE":
      case "RECURRENCE-ID":
        event.recurring = true;
        break;
    }
  }
  if (!ended) throw new IcalParseError("Incomplete iCal feed (no END:VCALENDAR)");
  return { events };
}
