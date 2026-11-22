/**
 * CAL-09: availability-only iCal export (RFC 5545). One all-day VEVENT per run of busy nights;
 * no guest data of any kind.
 */
import { createHash } from "node:crypto";

import { addDays } from "@/lib/calendar/dates";

export const PRODID = "-//PMS//iCal export 1.0//EN";
const CRLF = "\r\n";

export interface BusyRange {
  /** First busy night. */
  from: string;
  /** Exclusive end (the morning after the last busy night). */
  to: string;
}

/** Sorted, merged [from, to) ranges from a list of busy nights. */
export function mergeBusyNights(nights: string[]): BusyRange[] {
  const sorted = [...new Set(nights)].sort();
  const out: BusyRange[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && last.to === n) last.to = addDays(n, 1);
    else out.push({ from: n, to: addDays(n, 1) });
  }
  return out;
}

/** Folds a content line at 75 octets (RFC 5545 §3.1), never inside a UTF-8 sequence. */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74; // continuation lines start with a space
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

export function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

const compact = (date: string) => date.replaceAll("-", "");

function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Stable UID: the block's first night plus a hash of the listing, so an unchanged block keeps its
 * UID across fetches (and an extended one too: only DTEND changes). The listing id is not shown.
 */
export function exportUid(listingKey: string, from: string): string {
  const hash = createHash("sha256").update(`pms-ical:${listingKey}`).digest("hex").slice(0, 16);
  return `${compact(from)}-${hash}@pms-ical`;
}

export function buildIcs(opts: { listingKey: string; ranges: BusyRange[]; now?: Date; calendarName?: string }): string {
  const stamp = utcStamp(opts.now ?? new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.calendarName ?? "Availability")}`,
  ];
  for (const r of opts.ranges) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${exportUid(opts.listingKey, r.from)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(r.from)}`,
      `DTEND;VALUE=DATE:${compact(r.to)}`,
      "SUMMARY:Not available",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** Strong ETag over the busy ranges (not DTSTAMP), so unchanged availability answers 304. */
export function exportEtag(listingKey: string, ranges: BusyRange[]): string {
  const hash = createHash("sha256")
    .update(listingKey)
    .update(ranges.map((r) => `${r.from}/${r.to}`).join(","))
    .digest("base64url")
    .slice(0, 27);
  return `"${hash}"`;
}
