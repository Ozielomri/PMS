import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/lib/auth/context";
import { buildListingsCsv, type ExportField, type ExportListing, type ExportValue } from "@/lib/properties/export";
import { createClient } from "@/lib/supabase/server";

/**
 * X-09 CSV export of the property list (incl. sub-units) under RLS. Secret custom fields are
 * exported as "[secret]": the ciphertext column is not even selectable by clients.
 */
export async function GET(request: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx || ctx.mfa !== "ok" || !ctx.active || !ctx.can("properties.view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const params = request.nextUrl.searchParams;
  const supabase = await createClient();
  let query = supabase
    .from("listings")
    .select(
      "id, internal_name, public_title, type, status, parent_id, address_line1, city, state_region, postal_code, country_code, timezone, max_guests, bedrooms, bathrooms_full, base_price_cents, cleaning_fee_cents, min_nights, tags, cleaning_status",
    )
    .eq("account_id", ctx.active.accountId)
    .order("internal_name")
    .limit(10000);
  const status = params.get("status");
  if (status === "draft" || status === "active" || status === "archived") query = query.eq("status", status);
  else if (status !== "all") query = query.neq("status", "archived");
  const type = params.get("type");
  if (type === "single" || type === "multi_parent") query = query.eq("type", type);
  const tag = params.get("tag");
  if (tag) query = query.contains("tags", [tag]);

  const [{ data: listings, error }, { data: fields }] = await Promise.all([
    query.returns<ExportListing[]>(),
    supabase.from("custom_fields").select("id, key, label, field_type").eq("account_id", ctx.active.accountId).is("archived_at", null).order("label").returns<ExportField[]>(),
  ]);
  if (error) return NextResponse.json({ error: "export failed" }, { status: 500 });

  const ids = (listings ?? []).map((l) => l.id);
  const values: ExportValue[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await supabase
      .from("listing_custom_values")
      .select("listing_id, field_id, value_text, value_number, value_date, secret_is_set")
      .in("listing_id", ids.slice(i, i + 500))
      .returns<ExportValue[]>();
    values.push(...(data ?? []));
  }

  const csv = buildListingsCsv(listings ?? [], fields ?? [], values);
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="listings-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
