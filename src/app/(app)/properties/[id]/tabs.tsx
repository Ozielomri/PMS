import Link from "next/link";
import type { ReactNode } from "react";

import { Badge, Field, Input, Select, formatDateTime } from "@/components/ui";
import { publicEnv } from "@/lib/env";
import {
  BED_TYPES,
  BED_TYPE_LABELS,
  CANCELLATION_POLICIES,
  CANCELLATION_POLICY_LABELS,
  CHANNEL_LABELS,
  CLEANING_STATUSES,
  CLEANING_STATUS_LABELS,
  DESCRIPTION_FIELDS,
  DESCRIPTION_LANGUAGES,
  ROOM_TYPES,
  ROOM_TYPE_LABELS,
  SYNC_MODE_LABELS,
} from "@/lib/properties/constants";
import { bpsToPercentInput, centsToDollarInput } from "@/lib/properties/money";
import { photoUrl } from "@/lib/properties/photos";
import type { CustomFieldRow, CustomValueRow, ListingRow, PhotoRow, RoomRow } from "@/lib/properties/queries";
import type { EditorTab } from "@/lib/properties/schemas";
import { suggestTimezone } from "@/lib/properties/timezone";
import { createClient } from "@/lib/supabase/server";

import { AutosaveForm } from "../_components/autosave";
import { addRoom, deleteRoom, saveAmenities, saveCustomValues, saveDescription, saveListingTab, saveRoom } from "./actions";
import { CountedTextarea, PhotoManager, SecretField, TimezoneForm } from "./editor-client";
import { IcalTab } from "./ical-tab";

interface TabProps {
  tab: EditorTab;
  listing: ListingRow;
  canEdit: boolean;
  accountId: string;
  searchParams: Record<string, string | string[] | undefined>;
}

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : "");
const num = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

export async function TabContent(props: TabProps) {
  switch (props.tab) {
    case "overview":
      return <Overview {...props} />;
    case "location":
      return <Location {...props} />;
    case "rooms":
      return <Rooms {...props} />;
    case "amenities":
      return <Amenities {...props} />;
    case "descriptions":
      return <Descriptions {...props} />;
    case "photos":
      return <Photos {...props} />;
    case "booking":
      return <Booking {...props} />;
    case "fees":
      return <Fees {...props} />;
    case "custom-fields":
      return <CustomFields {...props} />;
    case "channels":
      return <Channels {...props} />;
    case "ical":
      return <IcalTab listing={props.listing} />;
    case "log":
      return <Log {...props} />;
  }
}

function Overview({ listing, canEdit }: TabProps) {
  const isUnit = listing.type === "single" || listing.type === "sub_unit";
  return (
    <AutosaveForm action={saveListingTab.bind(null, listing.id, isUnit ? "unitOverview" : "overview")} disabled={!canEdit} label="Overview">
      <Grid>
        <Field label="Internal name" htmlFor="o-name">
          <Input id="o-name" name="internal_name" defaultValue={listing.internal_name} required maxLength={200} />
        </Field>
        {listing.type !== "sub_unit" ? (
          <Field label="Public title" htmlFor="o-title">
            <Input id="o-title" name="public_title" defaultValue={listing.public_title ?? ""} maxLength={500} />
          </Field>
        ) : (
          <input type="hidden" name="public_title" value={listing.public_title ?? ""} />
        )}
        <Field label="Tags" htmlFor="o-tags" hint="Comma separated, e.g. Miami, Pool, Owner: Jansen">
          <Input id="o-tags" name="tags" defaultValue={listing.tags.join(", ")} />
        </Field>
        {isUnit ? (
          <Field label="Cleaning status" htmlFor="o-clean">
            <Select id="o-clean" name="cleaning_status" defaultValue={listing.cleaning_status ?? "clean"}>
              {CLEANING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {CLEANING_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </Grid>
      <p className="text-xs text-slate-500">
        Currency {listing.currency} · created {formatDateTime(listing.created_at, listing.timezone)}
        {listing.archived_at ? ` · archived ${formatDateTime(listing.archived_at, listing.timezone)}` : ""}
      </p>
    </AutosaveForm>
  );
}

function Location({ listing, canEdit }: TabProps) {
  const suggestion = suggestTimezone({ countryCode: listing.country_code, stateRegion: listing.state_region });
  return (
    <div className="space-y-8">
      <AutosaveForm action={saveListingTab.bind(null, listing.id, "location")} disabled={!canEdit} label="Address">
        <Grid>
          <Field label="Street address" htmlFor="l-a1">
            <Input id="l-a1" name="address_line1" defaultValue={listing.address_line1 ?? ""} maxLength={200} />
          </Field>
          <Field label="Apt, suite" htmlFor="l-a2">
            <Input id="l-a2" name="address_line2" defaultValue={listing.address_line2 ?? ""} maxLength={200} />
          </Field>
          <Field label="City" htmlFor="l-city">
            <Input id="l-city" name="city" defaultValue={listing.city ?? ""} maxLength={100} />
          </Field>
          <Field label="State" htmlFor="l-state">
            <Input id="l-state" name="state_region" defaultValue={listing.state_region ?? ""} maxLength={100} />
          </Field>
          <Field label="ZIP code" htmlFor="l-zip">
            <Input id="l-zip" name="postal_code" defaultValue={listing.postal_code ?? ""} maxLength={20} />
          </Field>
          <Field label="Country code" htmlFor="l-country">
            <Input id="l-country" name="country_code" defaultValue={listing.country_code} maxLength={2} />
          </Field>
          <Field label="Latitude" htmlFor="l-lat" hint="Optional; no automatic geocoding yet.">
            <Input id="l-lat" name="latitude" defaultValue={num(listing.latitude)} inputMode="decimal" />
          </Field>
          <Field label="Longitude" htmlFor="l-lng">
            <Input id="l-lng" name="longitude" defaultValue={num(listing.longitude)} inputMode="decimal" />
          </Field>
        </Grid>
      </AutosaveForm>
      {listing.type === "sub_unit" ? null : (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Timezone</h3>
          <p className="text-sm text-slate-500">
            All calendar dates of this listing are local dates in this timezone.
            {suggestion && suggestion !== listing.timezone ? ` Suggested from the address: ${suggestion}.` : ""}
          </p>
          <TimezoneForm listingId={listing.id} current={listing.timezone} disabled={!canEdit} />
        </section>
      )}
    </div>
  );
}

async function Rooms({ listing, canEdit }: TabProps) {
  const supabase = await createClient();
  const { data: rooms } = await supabase.from("listing_rooms").select("id, name, room_type, beds, position").eq("listing_id", listing.id).order("position").returns<RoomRow[]>();
  const totals = BED_TYPES.map((b) => [b, (rooms ?? []).reduce((n, r) => n + (r.beds[b] ?? 0), 0)] as const).filter(([, n]) => n > 0);
  return (
    <div className="space-y-8">
      <AutosaveForm action={saveListingTab.bind(null, listing.id, "capacity")} disabled={!canEdit} label="Capacity">
        <Grid>
          <Field label="Max guests" htmlFor="c-guests">
            <Input id="c-guests" name="max_guests" type="number" min={1} max={100} defaultValue={num(listing.max_guests)} />
          </Field>
          <Field label="Bedrooms" htmlFor="c-bed" hint="0 for a studio">
            <Input id="c-bed" name="bedrooms" type="number" min={0} max={100} defaultValue={num(listing.bedrooms)} />
          </Field>
          <Field label="Full bathrooms" htmlFor="c-bath">
            <Input id="c-bath" name="bathrooms_full" type="number" min={0} max={100} defaultValue={num(listing.bathrooms_full)} />
          </Field>
          <Field label="Half bathrooms" htmlFor="c-half">
            <Input id="c-half" name="bathrooms_half" type="number" min={0} max={100} defaultValue={num(listing.bathrooms_half)} />
          </Field>
          <Field label="Size (sq ft)" htmlFor="c-size">
            <Input id="c-size" name="size_sqft" type="number" min={1} defaultValue={num(listing.size_sqft)} />
          </Field>
        </Grid>
      </AutosaveForm>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Rooms and beds</h3>
          <p className="text-xs text-slate-500">{totals.length ? totals.map(([b, n]) => `${n} ${BED_TYPE_LABELS[b].toLowerCase()}`).join(", ") : "No beds yet"}</p>
        </div>
        {(rooms ?? []).map((r) => (
          <div key={r.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <AutosaveForm action={saveRoom.bind(null, r.id, listing.id)} disabled={!canEdit} label={`Room ${r.name}`}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor={`r-${r.id}-name`}>
                  <Input id={`r-${r.id}-name`} name="name" defaultValue={r.name} maxLength={100} />
                </Field>
                <Field label="Type" htmlFor={`r-${r.id}-type`}>
                  <Select id={`r-${r.id}-type`} name="room_type" defaultValue={r.room_type}>
                    {ROOM_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {ROOM_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
                {BED_TYPES.map((b) => (
                  <Field key={b} label={BED_TYPE_LABELS[b]} htmlFor={`r-${r.id}-${b}`}>
                    <Input id={`r-${r.id}-${b}`} name={`bed_${b}`} type="number" min={0} max={50} defaultValue={String(r.beds[b] ?? 0)} />
                  </Field>
                ))}
              </div>
            </AutosaveForm>
            {canEdit ? (
              <form action={deleteRoom} className="mt-2 text-right">
                <input type="hidden" name="roomId" value={r.id} />
                <input type="hidden" name="listingId" value={listing.id} />
                <button type="submit" className="text-sm text-red-600 underline-offset-2 hover:underline">
                  Remove room
                </button>
              </form>
            ) : null}
          </div>
        ))}
        {canEdit ? (
          <form action={addRoom.bind(null, listing.id)} className="flex flex-wrap items-end gap-2">
            <Select name="room_type" aria-label="Room type" className="w-48">
              {ROOM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ROOM_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
            <button type="submit" className="rounded-xl border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700">
              Add room
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}

async function Amenities({ listing, canEdit }: TabProps) {
  const supabase = await createClient();
  const [{ data: master }, { data: selected }] = await Promise.all([
    supabase.from("amenities").select("code, label, category").order("sort").returns<{ code: string; label: string; category: string }[]>(),
    supabase.from("listing_amenities").select("amenity_code, custom_label").eq("listing_id", listing.id).returns<{ amenity_code: string | null; custom_label: string | null }[]>(),
  ]);
  const codes = new Set((selected ?? []).map((a) => a.amenity_code).filter(Boolean));
  const custom = (selected ?? []).map((a) => a.custom_label).filter(Boolean).join("\n");
  const categories = [...new Set((master ?? []).map((a) => a.category))];
  return (
    <AutosaveForm action={saveAmenities.bind(null, listing.id)} disabled={!canEdit} label="Amenities">
      {categories.map((c) => (
        <fieldset key={c}>
          <legend className="mb-2 text-sm font-semibold capitalize">{c}</legend>
          <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {(master ?? [])
              .filter((a) => a.category === c)
              .map((a) => (
                <label key={a.code} className="flex items-center gap-2">
                  <input type="checkbox" name="amenity" value={a.code} defaultChecked={codes.has(a.code)} />
                  {a.label}
                </label>
              ))}
          </div>
        </fieldset>
      ))}
      <Field label="Custom amenities" htmlFor="a-custom" hint="One per line, e.g. Kayaks">
        <textarea
          id="a-custom"
          name="custom"
          rows={3}
          defaultValue={custom}
          className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
      </Field>
    </AutosaveForm>
  );
}

async function Descriptions({ listing, canEdit, searchParams }: TabProps) {
  const lang = typeof searchParams.lang === "string" && /^[a-z]{2}$/.test(searchParams.lang) ? searchParams.lang : "en";
  const supabase = await createClient();
  const { data: rows } = await supabase.from("listing_descriptions").select("*").eq("listing_id", listing.id).returns<Record<string, string | null>[]>();
  const current = (rows ?? []).find((r) => r.language === lang) ?? {};
  const existing = new Set((rows ?? []).map((r) => r.language));
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Description language">
        {DESCRIPTION_LANGUAGES.map((l) => (
          <Link
            key={l.value}
            href={`/properties/${listing.id}?tab=descriptions&lang=${l.value}`}
            aria-current={l.value === lang ? "page" : undefined}
            className={l.value === lang ? "font-semibold underline" : existing.has(l.value) ? "text-slate-700 dark:text-slate-300" : "text-slate-400"}
          >
            {l.label}
            {existing.has(l.value) ? " ✓" : ""}
          </Link>
        ))}
      </nav>
      <AutosaveForm key={lang} action={saveDescription.bind(null, listing.id, lang)} disabled={!canEdit} label="Descriptions">
        {DESCRIPTION_FIELDS.map((f) => (
          <CountedTextarea key={f.key} id={`d-${f.key}`} name={f.key} label={f.label} limit={f.limit} defaultValue={current[f.key] ?? ""} />
        ))}
      </AutosaveForm>
    </div>
  );
}

async function Photos({ listing, canEdit, accountId }: TabProps) {
  const supabase = await createClient();
  const [{ data: photos }, { data: rooms }] = await Promise.all([
    supabase.from("listing_photos").select("id, listing_id, storage_path, position, caption, room_id, content_type, size_bytes").eq("listing_id", listing.id).order("position").returns<PhotoRow[]>(),
    supabase.from("listing_rooms").select("id, name").eq("listing_id", listing.id).order("position").returns<{ id: string; name: string }[]>(),
  ]);
  const { supabaseUrl } = publicEnv();
  const items = (photos ?? []).map((p) => ({ id: p.id, url: photoUrl(supabaseUrl, p.storage_path, "medium"), caption: p.caption, roomId: p.room_id }));
  return (
    <PhotoManager
      key={items.map((p) => p.id).join(",")}
      listingId={listing.id}
      accountId={accountId}
      photos={items}
      rooms={rooms ?? []}
      canEdit={canEdit}
    />
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Booking({ listing, canEdit }: TabProps) {
  return (
    <AutosaveForm action={saveListingTab.bind(null, listing.id, "booking")} disabled={!canEdit} label="Booking rules">
      <p className="text-sm text-slate-500">Changes apply to future dates only; existing reservations keep their price.</p>
      <Grid>
        <Field label="Base nightly price (USD)" htmlFor="b-base">
          <Input id="b-base" name="base_price_cents" defaultValue={centsToDollarInput(listing.base_price_cents)} inputMode="decimal" />
        </Field>
        <Field label="Weekend price (USD)" htmlFor="b-weekend" hint="Optional; used on the weekend nights below.">
          <Input id="b-weekend" name="weekend_price_cents" defaultValue={centsToDollarInput(listing.weekend_price_cents)} inputMode="decimal" />
        </Field>
        <fieldset>
          <legend className="text-sm font-medium">Weekend nights</legend>
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            {DAYS.map((d, i) => (
              <label key={d} className="flex items-center gap-1">
                <input type="checkbox" name="weekend_nights" value={i} defaultChecked={listing.weekend_nights.includes(i)} />
                {d}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Min nights" htmlFor="b-min">
          <Input id="b-min" name="min_nights" type="number" min={1} defaultValue={String(listing.min_nights)} />
        </Field>
        <Field label="Max nights" htmlFor="b-max" hint="Empty = no maximum">
          <Input id="b-max" name="max_nights" type="number" min={1} defaultValue={num(listing.max_nights)} />
        </Field>
        <Field label="Advance notice (hours)" htmlFor="b-notice">
          <Input id="b-notice" name="advance_notice_hours" type="number" min={0} defaultValue={String(listing.advance_notice_hours)} />
        </Field>
        <Field label="Preparation time (nights)" htmlFor="b-prep">
          <Input id="b-prep" name="preparation_nights" type="number" min={0} max={30} defaultValue={String(listing.preparation_nights)} />
        </Field>
        <Field label="Booking window (days ahead)" htmlFor="b-window">
          <Input id="b-window" name="booking_window_days" type="number" min={1} max={1095} defaultValue={String(listing.booking_window_days)} />
        </Field>
        <Field label="Booking type" htmlFor="b-instant">
          <Select id="b-instant" name="instant_book" defaultValue={String(listing.instant_book)}>
            <option value="true">Instant book</option>
            <option value="false">Request to book</option>
          </Select>
        </Field>
        <Field label="Weekly discount (%)" htmlFor="b-weekly" hint="7+ nights">
          <Input id="b-weekly" name="weekly_discount_bps" defaultValue={bpsToPercentInput(listing.weekly_discount_bps)} inputMode="decimal" />
        </Field>
        <Field label="Monthly discount (%)" htmlFor="b-monthly" hint="28+ nights">
          <Input id="b-monthly" name="monthly_discount_bps" defaultValue={bpsToPercentInput(listing.monthly_discount_bps)} inputMode="decimal" />
        </Field>
        <Field label="Check-in from" htmlFor="b-in">
          <Input id="b-in" name="check_in_from" type="time" defaultValue={hhmm(listing.check_in_from)} />
        </Field>
        <Field label="Check-in until" htmlFor="b-in-to" hint="Optional">
          <Input id="b-in-to" name="check_in_to" type="time" defaultValue={hhmm(listing.check_in_to)} />
        </Field>
        <Field label="Check-out by" htmlFor="b-out">
          <Input id="b-out" name="check_out_by" type="time" defaultValue={hhmm(listing.check_out_by)} />
        </Field>
        <Field label="Cancellation policy" htmlFor="b-cancel">
          <Select id="b-cancel" name="cancellation_policy" defaultValue={listing.cancellation_policy}>
            {CANCELLATION_POLICIES.map((p) => (
              <option key={p} value={p}>
                {CANCELLATION_POLICY_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Cancellation notes" htmlFor="b-cancel-notes" hint="For a custom policy">
          <Input id="b-cancel-notes" name="cancellation_policy_notes" defaultValue={listing.cancellation_policy_notes ?? ""} maxLength={5000} />
        </Field>
      </Grid>
    </AutosaveForm>
  );
}

function Fees({ listing, canEdit }: TabProps) {
  return (
    <AutosaveForm action={saveListingTab.bind(null, listing.id, "fees")} disabled={!canEdit} label="Fees">
      <p className="text-sm text-slate-500">Fees are copied onto each reservation when it is booked. Tourist and occupancy taxes are not handled in this phase.</p>
      <Grid>
        <Field label="Cleaning fee (USD)" htmlFor="f-clean">
          <Input id="f-clean" name="cleaning_fee_cents" defaultValue={centsToDollarInput(listing.cleaning_fee_cents)} inputMode="decimal" />
        </Field>
        <Field label="Extra-guest fee per night (USD)" htmlFor="f-extra">
          <Input id="f-extra" name="extra_guest_fee_cents" defaultValue={centsToDollarInput(listing.extra_guest_fee_cents)} inputMode="decimal" />
        </Field>
        <Field label="Charged above (guests)" htmlFor="f-after">
          <Input id="f-after" name="extra_guest_after" type="number" min={1} defaultValue={num(listing.extra_guest_after)} />
        </Field>
        <Field label="Pet fee (USD)" htmlFor="f-pet">
          <Input id="f-pet" name="pet_fee_cents" defaultValue={centsToDollarInput(listing.pet_fee_cents)} inputMode="decimal" />
        </Field>
      </Grid>
    </AutosaveForm>
  );
}

async function CustomFields({ listing, canEdit }: TabProps) {
  const supabase = await createClient();
  const [{ data: fields }, { data: values }] = await Promise.all([
    supabase.from("custom_fields").select("id, key, label, field_type, options, position, archived_at").eq("account_id", listing.account_id).is("archived_at", null).order("position").order("label").returns<CustomFieldRow[]>(),
    supabase.from("listing_custom_values").select("listing_id, field_id, value_text, value_number, value_date, secret_is_set").eq("listing_id", listing.id).returns<CustomValueRow[]>(),
  ]);
  const byField = new Map((values ?? []).map((v) => [v.field_id, v]));
  const plain = (fields ?? []).filter((f) => f.field_type !== "secret");
  const secrets = (fields ?? []).filter((f) => f.field_type === "secret");
  if (!fields?.length) {
    return (
      <p className="text-sm text-slate-500">
        No custom fields yet. Admins define them under{" "}
        <Link href="/properties/custom-fields" className="underline">
          Custom fields
        </Link>{" "}
        (e.g. door code, Wi-Fi password) and use them in messages as <code>{"{{custom.door_code}}"}</code>.
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {listing.type === "sub_unit" ? <p className="text-sm text-slate-500">Values left empty here fall back to the parent&apos;s value in messages.</p> : null}
      {plain.length ? (
        <AutosaveForm action={saveCustomValues.bind(null, listing.id)} disabled={!canEdit} label="Custom fields">
          <Grid>
            {plain.map((f) => {
              const v = byField.get(f.id);
              const id = `cf-${f.id}`;
              return (
                <Field key={f.id} label={f.label} htmlFor={id} hint={`{{custom.${f.key}}}`}>
                  {f.field_type === "dropdown" ? (
                    <Select id={id} name={`field_${f.id}`} defaultValue={v?.value_text ?? ""}>
                      <option value="">—</option>
                      {f.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      id={id}
                      name={`field_${f.id}`}
                      type={f.field_type === "number" ? "number" : f.field_type === "date" ? "date" : "text"}
                      step={f.field_type === "number" ? "any" : undefined}
                      defaultValue={f.field_type === "number" ? num(v?.value_number) : f.field_type === "date" ? (v?.value_date ?? "") : (v?.value_text ?? "")}
                    />
                  )}
                </Field>
              );
            })}
          </Grid>
        </AutosaveForm>
      ) : null}
      {secrets.length ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Secrets</h3>
          <p className="text-xs text-slate-500">Encrypted at rest, masked here, never exported or logged in plain text.</p>
          {secrets.map((f) => (
            <SecretField key={f.id} listingId={listing.id} fieldId={f.id} label={f.label} isSet={Boolean(byField.get(f.id)?.secret_is_set)} canEdit={canEdit} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

interface ChannelLinkRow {
  id: string;
  channel: string;
  external_listing_id: string | null;
  sync_mode: string;
  status: string;
  last_sync_at: string | null;
  last_sync_error: string | null;
}

async function Channels({ listing }: TabProps) {
  const supabase = await createClient();
  const { data: links } = await supabase
    .from("listing_channel_links")
    .select("id, channel, external_listing_id, sync_mode, status, last_sync_at, last_sync_error")
    .eq("listing_id", listing.id)
    .returns<ChannelLinkRow[]>();
  if (!links?.length) {
    return <p className="text-sm text-slate-500">Not connected to any channel. The Booking.com connection arrives with the channel integration.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr>
            <th className="py-2 pr-3">Channel</th>
            <th className="py-2 pr-3">Channel ID</th>
            <th className="py-2 pr-3">Sync mode</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2">Last sync</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {links.map((l) => (
            <tr key={l.id}>
              <td className="py-2 pr-3">{CHANNEL_LABELS[l.channel] ?? l.channel}</td>
              <td className="py-2 pr-3">{l.external_listing_id ?? "—"}</td>
              <td className="py-2 pr-3">{SYNC_MODE_LABELS[l.sync_mode] ?? l.sync_mode}</td>
              <td className="py-2 pr-3">
                <Badge tone={l.status === "connected" ? "green" : l.status === "error" ? "red" : "neutral"}>{l.status}</Badge>
                {l.last_sync_error ? <p className="mt-1 text-xs text-red-600">{l.last_sync_error}</p> : null}
              </td>
              <td className="py-2">{formatDateTime(l.last_sync_at, listing.timezone)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface LogRow {
  id: number;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  entity_type: string;
  action: "insert" | "update" | "delete";
  diff: Record<string, { old?: unknown; new?: unknown }>;
}

const SECTION_LABELS: Record<string, string> = {
  listings: "Listing",
  listing_rooms: "Room",
  listing_amenities: "Amenity",
  listing_descriptions: "Description",
  listing_photos: "Photo",
  listing_custom_values: "Custom field",
  listing_channel_links: "Channel link",
};
const HIDDEN_FIELDS = new Set(["id", "account_id", "listing_id", "created_at", "created_by", "updated_by", "cleaning_status_updated_at", "secret_is_set"]);

function show(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

async function Log({ listing, searchParams }: TabProps) {
  const before = typeof searchParams.before === "string" && /^\d+$/.test(searchParams.before) ? Number(searchParams.before) : null;
  const supabase = await createClient();
  const { data: rows, error } = await supabase.rpc("listing_change_log", { p_listing_id: listing.id, p_before_id: before, p_limit: 50 });
  if (error) return <p className="text-sm text-red-600">Could not load the change log.</p>;
  const log = (rows ?? []) as LogRow[];
  return (
    <div className="space-y-3">
      {log.length === 0 ? <p className="text-sm text-slate-500">No changes yet.</p> : null}
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {log.map((r) => {
          const fields = Object.entries(r.diff).filter(([k]) => !HIDDEN_FIELDS.has(k));
          return (
            <li key={r.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={r.action === "insert" ? "green" : r.action === "delete" ? "red" : "amber"}>
                  {SECTION_LABELS[r.entity_type] ?? r.entity_type} {r.action === "insert" ? "added" : r.action === "delete" ? "removed" : "changed"}
                </Badge>
                <span className="text-slate-600 dark:text-slate-300">
                  by {r.actor_type === "user" ? (r.actor_name ?? "a user") : `${r.actor_type}${r.actor_id ? ` (${r.actor_id})` : ""}`}
                </span>
                <span className="ml-auto text-xs text-slate-500">{formatDateTime(r.occurred_at, listing.timezone)}</span>
              </div>
              {r.action === "update" && fields.length ? (
                <table className="mt-2 text-xs">
                  <tbody>
                    {fields.map(([k, v]) => (
                      <tr key={k}>
                        <td className="pr-3 font-medium">{k}</td>
                        <td className="pr-2 text-slate-500 line-through">{show(v.old)}</td>
                        <td>{show(v.new)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </li>
          );
        })}
      </ul>
      {log.length === 50 ? (
        <Link className="text-sm underline" href={`/properties/${listing.id}?tab=log&before=${log[log.length - 1].id}`}>
          Older changes →
        </Link>
      ) : null}
    </div>
  );
}
