/**
 * X-09 CSV export of the property list. Secret custom fields are never exported in plain text
 * (PRP-12 acceptance): the column shows "[secret]" when a value is set. The export only ever
 * receives `secret_is_set` — clients cannot read the ciphertext column at all.
 */
import { CLEANING_STATUS_LABELS, LISTING_STATUS_LABELS, LISTING_TYPE_LABELS, type CleaningStatus, type ListingStatus, type ListingType } from "@/lib/properties/constants";
import { centsToDollarInput } from "@/lib/properties/money";
import { SECRET_EXPORT_PLACEHOLDER } from "@/lib/properties/secrets";

export interface ExportListing {
  id: string;
  internal_name: string;
  public_title: string | null;
  type: ListingType;
  status: ListingStatus;
  parent_id: string | null;
  address_line1: string | null;
  city: string | null;
  state_region: string | null;
  postal_code: string | null;
  country_code: string;
  timezone: string;
  max_guests: number | null;
  bedrooms: number | null;
  bathrooms_full: number | null;
  base_price_cents: number | null;
  cleaning_fee_cents: number;
  min_nights: number;
  tags: string[];
  cleaning_status: CleaningStatus | null;
}

export interface ExportField {
  id: string;
  key: string;
  label: string;
  field_type: string;
}

export interface ExportValue {
  listing_id: string;
  field_id: string;
  value_text: string | null;
  value_number: number | string | null;
  value_date: string | null;
  secret_is_set: boolean;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Spreadsheet formula injection: prefix cells that would be evaluated.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildListingsCsv(listings: ExportListing[], fields: ExportField[], values: ExportValue[]): string {
  const byKey = new Map(values.map((v) => [`${v.listing_id}:${v.field_id}`, v]));
  const header = [
    "id", "internal_name", "public_title", "type", "status", "parent_id", "address", "city", "state", "zip", "country",
    "timezone", "max_guests", "bedrooms", "bathrooms_full", "base_price_usd", "cleaning_fee_usd", "min_nights", "tags",
    "cleaning_status", ...fields.map((f) => `custom.${f.key}`),
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const l of listings) {
    const row: unknown[] = [
      l.id, l.internal_name, l.public_title, LISTING_TYPE_LABELS[l.type], LISTING_STATUS_LABELS[l.status], l.parent_id,
      l.address_line1, l.city, l.state_region, l.postal_code, l.country_code, l.timezone, l.max_guests, l.bedrooms,
      l.bathrooms_full, centsToDollarInput(l.base_price_cents), centsToDollarInput(l.cleaning_fee_cents), l.min_nights,
      l.tags.join("; "), l.cleaning_status ? CLEANING_STATUS_LABELS[l.cleaning_status] : "",
    ];
    for (const f of fields) {
      const v = byKey.get(`${l.id}:${f.id}`);
      if (!v) row.push("");
      else if (f.field_type === "secret") row.push(v.secret_is_set ? SECRET_EXPORT_PLACEHOLDER : "");
      else if (f.field_type === "number") row.push(v.value_number);
      else if (f.field_type === "date") row.push(v.value_date);
      else row.push(v.value_text);
    }
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
