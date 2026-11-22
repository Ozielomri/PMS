import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export interface BookableListing {
  id: string;
  name: string;
  type: "single" | "multi_parent" | "sub_unit";
  parentName: string | null;
}

/** Active listings for pickers: each multi-unit followed by its sub-units. */
export async function bookableListings(supabase: SupabaseClient, accountId: string): Promise<BookableListing[]> {
  const { data } = await supabase
    .from("listings")
    .select("id, internal_name, type, parent_id")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("internal_name")
    .limit(2000)
    .returns<{ id: string; internal_name: string; type: BookableListing["type"]; parent_id: string | null }[]>();
  const rows = data ?? [];
  return rows
    .filter((r) => r.type !== "sub_unit")
    .flatMap((r) => [
      { id: r.id, name: r.internal_name, type: r.type, parentName: null },
      ...rows.filter((s) => s.parent_id === r.id).map((s) => ({ id: s.id, name: s.internal_name, type: s.type, parentName: r.internal_name })),
    ]);
}
