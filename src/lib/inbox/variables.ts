/**
 * INB-06 message variables, resolved at send time from the guest, the reservation, the account
 * and the listing (listing.* and custom.* come from resolveListingVariables() in
 * src/lib/properties/variables.ts, which decrypts secret fields on the server).
 *
 * A variable that is unknown or resolves to an empty value is *unresolved*; a message with any
 * unresolved variable cannot be sent (the database refuses an outbound body that still contains
 * a {{…}} placeholder as well).
 */

export const VARIABLE_PATTERN = /\{\{\s*([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\}\}/g;

export interface VariableGuest {
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  language?: string | null;
}

export interface VariableReservation {
  code: string;
  check_in: string;
  check_out: string;
  nights: number;
  adults: number;
  children: number;
  status: string;
  eta: string | null;
  etd: string | null;
}

/** Variables offered in pickers, grouped. listing.* / custom.* are added per account. */
export const VARIABLE_CATALOG: { name: string; label: string }[] = [
  { name: "guest.first_name", label: "Guest first name" },
  { name: "guest.last_name", label: "Guest last name" },
  { name: "guest.full_name", label: "Guest full name" },
  { name: "guest.email", label: "Guest email" },
  { name: "guest.phone", label: "Guest phone" },
  { name: "reservation.code", label: "Confirmation code" },
  { name: "reservation.check_in", label: "Check-in date" },
  { name: "reservation.check_out", label: "Check-out date" },
  { name: "reservation.nights", label: "Nights" },
  { name: "reservation.guests", label: "Number of guests" },
  { name: "reservation.eta", label: "Expected arrival" },
  { name: "reservation.etd", label: "Expected departure" },
  { name: "account.name", label: "Company name" },
  { name: "listing.title", label: "Listing title" },
  { name: "listing.name", label: "Listing internal name" },
  { name: "listing.address", label: "Listing address" },
  { name: "listing.city", label: "Listing city" },
  { name: "listing.check_in_from", label: "Check-in from" },
  { name: "listing.check_in_to", label: "Check-in until" },
  { name: "listing.check_out_by", label: "Check-out by" },
];

function longDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

function clock(value: string | null): string {
  if (!value) return "";
  const [h, m] = value.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

export function buildMessageVariables(input: {
  accountName: string;
  guest: VariableGuest | null;
  reservation: VariableReservation | null;
  listingVars: Record<string, string>;
  /** For conversations without a guest record (inquiries by email). */
  contactName?: string | null;
}): Record<string, string> {
  const vars: Record<string, string> = { ...input.listingVars, "account.name": input.accountName };
  const g = input.guest;
  if (g) {
    vars["guest.first_name"] = g.first_name;
    vars["guest.last_name"] = g.last_name ?? "";
    vars["guest.full_name"] = [g.first_name, g.last_name].filter(Boolean).join(" ");
    vars["guest.email"] = g.email ?? "";
    vars["guest.phone"] = g.phone ?? "";
  } else if (input.contactName) {
    const [first, ...rest] = input.contactName.trim().split(/\s+/);
    vars["guest.first_name"] = first ?? "";
    vars["guest.last_name"] = rest.join(" ");
    vars["guest.full_name"] = input.contactName.trim();
  }
  const r = input.reservation;
  if (r) {
    vars["reservation.code"] = r.code;
    vars["reservation.check_in"] = longDate(r.check_in);
    vars["reservation.check_out"] = longDate(r.check_out);
    vars["reservation.nights"] = String(r.nights);
    vars["reservation.guests"] = String(r.adults + r.children);
    vars["reservation.eta"] = clock(r.eta);
    vars["reservation.etd"] = clock(r.etd);
    vars["reservation.status"] = r.status;
  }
  return vars;
}

/** Distinct variable names used in a template, in order of first use. */
export function findVariables(template: string): string[] {
  return [...new Set([...template.matchAll(VARIABLE_PATTERN)].map((m) => m[1]))];
}

function isResolved(vars: Record<string, string>, name: string): boolean {
  return Object.hasOwn(vars, name) && vars[name].trim() !== "";
}

/** Replaces resolvable variables; unresolved ones stay as {{name}} and are listed. */
export function resolveTemplate(template: string, vars: Record<string, string>): { text: string; unresolved: string[] } {
  const unresolved = new Set<string>();
  const text = template.replace(VARIABLE_PATTERN, (match, name: string) => {
    if (isResolved(vars, name)) return vars[name];
    unresolved.add(name);
    return match;
  });
  return { text, unresolved: [...unresolved] };
}

export type PreviewPart = { kind: "text"; text: string } | { kind: "value" | "missing"; text: string; name: string };

/** Splits a template into plain text, resolved values and missing variables for a highlighted preview. */
export function previewTemplate(template: string, vars: Record<string, string>): PreviewPart[] {
  const parts: PreviewPart[] = [];
  let last = 0;
  for (const m of template.matchAll(VARIABLE_PATTERN)) {
    const index = m.index ?? 0;
    if (index > last) parts.push({ kind: "text", text: template.slice(last, index) });
    const name = m[1];
    parts.push(isResolved(vars, name) ? { kind: "value", text: vars[name], name } : { kind: "missing", text: m[0], name });
    last = index + m[0].length;
  }
  if (last < template.length) parts.push({ kind: "text", text: template.slice(last) });
  return parts;
}
