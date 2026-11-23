import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { accountToday } from "@/lib/reservations/list";

/** Listings for the condition pickers and upcoming reservations for the preview. */
export async function builderData(supabase: SupabaseClient, accountId: string) {
  const { today } = await accountToday(supabase, accountId);
  const [{ data: listings }, { data: reservations }] = await Promise.all([
    supabase.from("listings").select("id, internal_name, type").eq("account_id", accountId).neq("status", "archived").neq("type", "complex").order("internal_name").limit(500).returns<{ id: string; internal_name: string; type: string }[]>(),
    supabase
      .from("reservations")
      .select("id, code, check_in, guest:guests(first_name, last_name), listing:listings!reservations_listing_id_account_id_fkey(internal_name)")
      .eq("account_id", accountId)
      .eq("kind", "guest")
      .in("status", ["confirmed", "reserved"])
      .gte("check_out", today)
      .order("check_in")
      .limit(30)
      .returns<{ id: string; code: string; check_in: string; guest: { first_name: string; last_name: string | null } | null; listing: { internal_name: string } | null }[]>(),
  ]);
  return {
    listings: (listings ?? []).map((l) => ({ id: l.id, name: l.type === "sub_unit" ? `  ${l.internal_name}` : l.internal_name })),
    samples: (reservations ?? []).map((r) => ({
      id: r.id,
      label: `${r.code} · ${[r.guest?.first_name, r.guest?.last_name].filter(Boolean).join(" ")} · ${r.listing?.internal_name ?? ""} · ${r.check_in}`,
    })),
  };
}
