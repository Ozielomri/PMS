/**
 * Calendar date helpers. Calendar dates are plain local dates (`YYYY-MM-DD`) in the listing's
 * timezone; nights are half-open ranges [check_in, check_out), so the check-out day is not a
 * booked night. Arithmetic is done on UTC midnights, which has no DST gaps.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

function toUtc(date: string): number {
  if (!isIsoDate(date)) throw new Error(`invalid date: ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** Number of nights in [checkIn, checkOut). */
export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((toUtc(checkOut) - toUtc(checkIn)) / DAY_MS);
}

/** Every night of a stay: check-in up to, not including, check-out. */
export function eachNight(checkIn: string, checkOut: string): string[] {
  const n = nightsBetween(checkIn, checkOut);
  return Array.from({ length: Math.max(n, 0) }, (_, i) => addDays(checkIn, i));
}

/** Postgres `extract(dow)` numbering: 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: string): number {
  return new Date(toUtc(date)).getUTCDay();
}

/** The local date in `timeZone` at instant `now`. */
export function localToday(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** First arrival date allowed by advance notice: the local date of now + notice (same rule as SQL). */
export function firstBookableDate(timeZone: string, advanceNoticeHours: number, now: Date = new Date()): string {
  return localToday(timeZone, new Date(now.getTime() + advanceNoticeHours * 3_600_000));
}
