/** HTTP helpers shared by the calendar route handlers. */
import { CalendarError } from "@/lib/calendar/service";

/** SQLSTATE → HTTP status for errors raised by the calendar SQL API. */
export function statusForCalendarError(code: string | undefined): number {
  switch (code) {
    case "22023": // invalid input
    case "22P02": // invalid text representation (bad uuid/date)
      return 400;
    case "28000": // invalid token
      return 401;
    case "42501": // forbidden
      return 403;
    case "P0002": // listing / hold not found
      return 404;
    case "23P01": // calendar conflict
      return 409;
    case "P0001": // business rule (not bookable, price missing, …)
      return 422;
    default:
      return 500;
  }
}

export function calendarErrorBody(err: unknown): { status: number; body: { error: string; code?: string } } {
  if (err instanceof CalendarError) {
    const status = statusForCalendarError(err.code);
    return { status, body: { error: status === 500 ? "internal_error" : err.message, code: err.code } };
  }
  return { status: 500, body: { error: "internal_error" } };
}

/** `Authorization: Bearer <token>` → token, else null. */
export function bearerToken(authorization: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/.exec(authorization ?? "");
  return m ? m[1] : null;
}

export function searchParamsObject(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}
