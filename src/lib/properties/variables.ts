/**
 * PRP-12: listing values as message variables, for the Inbox (step 6) and automations (step 7).
 *
 *   {{custom.door_code}}, {{custom.wifi_password}}, {{listing.title}}, {{listing.address}}, …
 *
 * Server-side only: secret values are decrypted here. A sub-unit's own value wins over its
 * parent's, so a door code can be set per physical unit and a Wi-Fi password once on the parent.
 * Never log the returned map.
 */
import { decryptCustomSecret } from "@/lib/properties/secrets";

export interface VariableListing {
  id: string;
  parent_id: string | null;
  internal_name: string;
  public_title: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_region: string | null;
  postal_code: string | null;
  check_in_from: string | null;
  check_in_to: string | null;
  check_out_by: string | null;
  max_guests: number | null;
}

export interface VariableValueRow {
  listing_id: string;
  key: string;
  field_type: "text" | "number" | "date" | "dropdown" | "secret";
  value_text: string | null;
  value_number: number | string | null;
  value_date: string | null;
}

export interface VariableSecretRow {
  listing_id: string;
  field_id: string;
  key: string;
  ciphertext: string;
}

/** Data access for the resolver (Supabase-backed in production, pg-backed in tests). */
export interface ListingVariableStore {
  loadListing(listingId: string): Promise<VariableListing | null>;
  /** Non-secret values of the given listings (active field definitions only). */
  loadValues(listingIds: string[]): Promise<VariableValueRow[]>;
  /** Secret ciphertexts of the listing and its parent: public.listing_secret_ciphertexts(). */
  loadSecretCiphertexts(listingId: string): Promise<VariableSecretRow[]>;
}

function time(value: string | null): string {
  if (!value) return "";
  const [h, m] = value.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

export async function resolveListingVariables(
  store: ListingVariableStore,
  listingId: string,
  key: Buffer,
): Promise<Record<string, string>> {
  const listing = await store.loadListing(listingId);
  if (!listing) throw new Error("Listing not found");
  const parent = listing.parent_id ? await store.loadListing(listing.parent_id) : null;
  const content = parent ?? listing; // sub-units take content from the parent

  const vars: Record<string, string> = {
    "listing.name": listing.internal_name,
    "listing.title": content.public_title ?? content.internal_name,
    "listing.address": [content.address_line1, content.address_line2].filter(Boolean).join(", "),
    "listing.city": content.city ?? "",
    "listing.state": content.state_region ?? "",
    "listing.zip": content.postal_code ?? "",
    "listing.check_in_from": time(content.check_in_from),
    "listing.check_in_to": time(content.check_in_to),
    "listing.check_out_by": time(content.check_out_by),
    "listing.max_guests": content.max_guests === null ? "" : String(content.max_guests),
  };

  // Parent first, then the listing itself, so the more specific value wins.
  const order = (id: string) => (id === listing.id ? 1 : 0);
  const ids = parent ? [parent.id, listing.id] : [listing.id];
  const values = (await store.loadValues(ids)).sort((a, b) => order(a.listing_id) - order(b.listing_id));
  for (const v of values) {
    if (v.field_type === "secret") continue;
    const value = v.field_type === "number" ? String(v.value_number ?? "") : v.field_type === "date" ? (v.value_date ?? "") : (v.value_text ?? "");
    vars[`custom.${v.key}`] = value;
  }

  const secrets = (await store.loadSecretCiphertexts(listing.id)).sort((a, b) => order(a.listing_id) - order(b.listing_id));
  for (const s of secrets) {
    vars[`custom.${s.key}`] = decryptCustomSecret(s.ciphertext, key, s.listing_id, s.field_id);
  }
  return vars;
}

/** Replace {{name}} placeholders; unknown names are left as they are. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\}\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? vars[name] : match,
  );
}
