import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { CleaningStatus, CustomFieldType, ListingStatus, ListingType } from "@/lib/properties/constants";
import type { ListingVariableStore, VariableListing, VariableSecretRow, VariableValueRow } from "@/lib/properties/variables";

/** Every column of public.listings the Properties screens use. */
export interface ListingRow {
  id: string;
  account_id: string;
  type: ListingType;
  parent_id: string | null;
  status: ListingStatus;
  internal_name: string;
  public_title: string | null;
  timezone: string;
  currency: string;
  tags: string[];
  max_guests: number | null;
  check_in_from: string | null;
  check_in_to: string | null;
  check_out_by: string | null;
  base_price_cents: number | null;
  weekend_price_cents: number | null;
  weekend_nights: number[];
  min_nights: number;
  max_nights: number | null;
  advance_notice_hours: number;
  preparation_nights: number;
  booking_window_days: number;
  instant_book: boolean;
  weekly_discount_bps: number;
  monthly_discount_bps: number;
  cleaning_fee_cents: number;
  extra_guest_fee_cents: number;
  extra_guest_after: number | null;
  pet_fee_cents: number;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_region: string | null;
  postal_code: string | null;
  country_code: string;
  latitude: number | null;
  longitude: number | null;
  bedrooms: number | null;
  bathrooms_full: number | null;
  bathrooms_half: number | null;
  size_sqft: number | null;
  cancellation_policy: string;
  cancellation_policy_notes: string | null;
  cleaning_status: CleaningStatus | null;
  cleaning_status_updated_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface PhotoRow {
  id: string;
  listing_id: string;
  storage_path: string;
  position: number;
  caption: string | null;
  room_id: string | null;
  content_type: string;
  size_bytes: number;
}

export interface RoomRow {
  id: string;
  name: string;
  room_type: string;
  beds: Record<string, number>;
  position: number;
}

export interface CustomFieldRow {
  id: string;
  key: string;
  label: string;
  field_type: CustomFieldType;
  options: string[];
  position: number;
  archived_at: string | null;
}

export interface CustomValueRow {
  listing_id: string;
  field_id: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  secret_is_set: boolean;
}

export async function getListing(supabase: SupabaseClient, id: string): Promise<ListingRow | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data } = await supabase.from("listings").select("*").eq("id", id).maybeSingle<ListingRow>();
  return data ?? null;
}

export async function getActivationProblems(supabase: SupabaseClient, id: string): Promise<string[]> {
  const { data } = await supabase.rpc("listing_activation_problems", { p_listing_id: id });
  return (data as string[] | null) ?? [];
}

/** Supabase-backed store for resolveListingVariables(). Pass a service-role client (Inbox) or the user's client (editors). */
export function supabaseVariableStore(supabase: SupabaseClient): ListingVariableStore {
  return {
    async loadListing(id) {
      const { data } = await supabase
        .from("listings")
        .select("id, parent_id, internal_name, public_title, address_line1, address_line2, city, state_region, postal_code, check_in_from, check_in_to, check_out_by, max_guests")
        .eq("id", id)
        .maybeSingle<VariableListing>();
      return data ?? null;
    },
    async loadValues(ids) {
      const { data } = await supabase
        .from("listing_custom_values")
        .select("listing_id, value_text, value_number, value_date, custom_fields!inner(key, field_type, archived_at)")
        .in("listing_id", ids)
        .is("custom_fields.archived_at", null)
        .returns<
          { listing_id: string; value_text: string | null; value_number: number | null; value_date: string | null; custom_fields: { key: string; field_type: CustomFieldType } }[]
        >();
      return (data ?? []).map(
        (r): VariableValueRow => ({
          listing_id: r.listing_id,
          key: r.custom_fields.key,
          field_type: r.custom_fields.field_type,
          value_text: r.value_text,
          value_number: r.value_number,
          value_date: r.value_date,
        }),
      );
    },
    async loadSecretCiphertexts(id) {
      const { data, error } = await supabase.rpc("listing_secret_ciphertexts", { p_listing_id: id });
      if (error) throw new Error("Could not load secret values");
      return (data as VariableSecretRow[] | null) ?? [];
    },
  };
}
