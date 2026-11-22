import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { characterCount, DESCRIPTION_FIELDS } from "@/lib/properties/constants";
import { propertyErrorMessage } from "@/lib/properties/errors";
import { buildListingsCsv, csvCell, type ExportListing } from "@/lib/properties/export";
import { bpsToPercentInput, centsToDollarInput, formatMoney, parseDollarsToCents, parsePercentToBps } from "@/lib/properties/money";
import { isPhotoPathFor, photoPath, photoUrl, validatePhotoFile } from "@/lib/properties/photos";
import { parseBulkChange, parseListingPatch, parseTags, wizardSchema } from "@/lib/properties/schemas";
import { decryptCustomSecret, encryptCustomSecret } from "@/lib/properties/secrets";
import { normalizeUsState, suggestTimezone } from "@/lib/properties/timezone";
import { renderTemplate, resolveListingVariables, type ListingVariableStore, type VariableListing } from "@/lib/properties/variables";

const ACCOUNT = "6d2eb852-a880-49bc-85ff-afe8ca9f3d1b";
const LISTING = "0c98c383-5a69-4d2d-917f-cd9519804fec";

function fd(entries: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}

describe("money", () => {
  it("parses dollars into integer cents and back", () => {
    expect(parseDollarsToCents("150")).toBe(15000);
    expect(parseDollarsToCents("$1,250.5")).toBe(125050);
    expect(parseDollarsToCents("0.07")).toBe(7);
    expect(parseDollarsToCents(" ")).toBeNull();
    expect(() => parseDollarsToCents("12.345")).toThrow();
    expect(() => parseDollarsToCents("-5")).toThrow();
    expect(centsToDollarInput(15000)).toBe("150");
    expect(centsToDollarInput(125050)).toBe("1250.50");
    expect(centsToDollarInput(null)).toBe("");
    expect(formatMoney(125050)).toBe("$1,250.50");
  });

  it("parses percentages into basis points", () => {
    expect(parsePercentToBps("10")).toBe(1000);
    expect(parsePercentToBps("12.5%")).toBe(1250);
    expect(parsePercentToBps("")).toBe(0);
    expect(() => parsePercentToBps("101")).toThrow();
    expect(bpsToPercentInput(1250)).toBe("12.5");
  });
});

describe("timezone from address (PRP-02)", () => {
  it("suggests a timezone from the US state", () => {
    expect(normalizeUsState("florida")).toBe("FL");
    expect(normalizeUsState("tx")).toBe("TX");
    expect(normalizeUsState("Atlantis")).toBeNull();
    expect(suggestTimezone({ stateRegion: "CA" })).toBe("America/Los_Angeles");
    expect(suggestTimezone({ countryCode: "US", stateRegion: "Arizona" })).toBe("America/Phoenix");
    expect(suggestTimezone({ countryCode: "PR" })).toBe("America/Puerto_Rico");
    expect(suggestTimezone({ countryCode: "FR", stateRegion: "CA" })).toBeNull();
  });
});

describe("photos (PRP-06)", () => {
  it("accepts JPEG, PNG and HEIC up to 25 MB, using the extension when the browser gives no type", () => {
    expect(validatePhotoFile({ name: "a.jpg", type: "image/jpeg", size: 1000 })).toEqual({ ok: true, contentType: "image/jpeg", extension: "jpg" });
    expect(validatePhotoFile({ name: "IMG_1.HEIC", type: "", size: 1000 })).toEqual({ ok: true, contentType: "image/heic", extension: "heic" });
    expect(validatePhotoFile({ name: "a.png", type: "image/png", size: 25 * 1024 * 1024 }).ok).toBe(true);
    expect(validatePhotoFile({ name: "a.png", type: "image/png", size: 25 * 1024 * 1024 + 1 })).toMatchObject({ ok: false });
    expect(validatePhotoFile({ name: "a.gif", type: "image/gif", size: 10 })).toMatchObject({ ok: false });
    expect(validatePhotoFile({ name: "a.jpg", type: "image/jpeg", size: 0 })).toMatchObject({ ok: false });
  });

  it("builds storage paths and variant URLs", () => {
    const path = photoPath(ACCOUNT, LISTING, "f1", "jpg");
    expect(isPhotoPathFor(path, ACCOUNT, LISTING)).toBe(true);
    expect(isPhotoPathFor(`${ACCOUNT}/${LISTING}/../x.jpg`, ACCOUNT, LISTING)).toBe(false);
    expect(isPhotoPathFor(path, ACCOUNT, "0c98c383-5a69-4d2d-917f-000000000000")).toBe(false);
    expect(photoUrl("https://x.supabase.co/", path, "thumb")).toBe(
      `https://x.supabase.co/storage/v1/render/image/public/listing-photos/${ACCOUNT}/${LISTING}/f1.jpg?width=320&height=240&resize=cover&quality=80`,
    );
    expect(photoUrl("https://x.supabase.co", path, "original")).toBe(`https://x.supabase.co/storage/v1/object/public/listing-photos/${path}`);
  });
});

describe("editor schemas", () => {
  it("parses the booking rules tab into a listings patch", () => {
    const r = parseListingPatch(
      "booking",
      fd({
        base_price_cents: "189.99",
        weekend_price_cents: "",
        weekend_nights: ["6", "5"],
        min_nights: "2",
        max_nights: "",
        advance_notice_hours: "24",
        preparation_nights: "0",
        booking_window_days: "365",
        weekly_discount_bps: "10",
        monthly_discount_bps: "",
        check_in_from: "16:00",
        check_in_to: "",
        check_out_by: "11:00",
        cancellation_policy: "strict",
        cancellation_policy_notes: "",
      }),
    );
    expect(r).toEqual({
      ok: true,
      patch: {
        base_price_cents: 18999,
        weekend_price_cents: null,
        weekend_nights: [5, 6],
        min_nights: 2,
        max_nights: null,
        advance_notice_hours: 24,
        preparation_nights: 0,
        booking_window_days: 365,
        instant_book: false,
        weekly_discount_bps: 1000,
        monthly_discount_bps: 0,
        check_in_from: "16:00",
        check_in_to: null,
        check_out_by: "11:00",
        cancellation_policy: "strict",
        cancellation_policy_notes: null,
      },
    });
  });

  it("reports the first problem", () => {
    expect(parseListingPatch("capacity", fd({ max_guests: "0", bedrooms: "", bathrooms_full: "", bathrooms_half: "", size_sqft: "" }))).toEqual({
      ok: false,
      error: "Max guests must be a whole number from 1 to 100",
    });
    expect(parseListingPatch("fees", fd({ cleaning_fee_cents: "abc", extra_guest_fee_cents: "", extra_guest_after: "", pet_fee_cents: "" }))).toMatchObject({ ok: false });
    expect(parseListingPatch("overview", fd({ internal_name: " ", public_title: "", tags: "" }))).toEqual({ ok: false, error: "Enter an internal name" });
    expect(parseTags(" Miami, Pool ,,Owner: Jansen")).toEqual(["Miami", "Pool", "Owner: Jansen"]);
  });

  it("requires what activation needs in the wizard", () => {
    const base = {
      type: "single", internal_name: "Ocean 1", public_title: "", address_line1: "1 Main St", address_line2: "", city: "Miami",
      state_region: "FL", postal_code: "33139", country_code: "us", timezone: "America/New_York", max_guests: "4", bedrooms: "0",
      bathrooms_full: "1", base_price_cents: "150", check_in_from: "16:00", check_out_by: "11:00", sub_units: "",
    };
    expect(wizardSchema.parse(base)).toMatchObject({ country_code: "US", bedrooms: 0, base_price_cents: 15000, sub_units: 0 });
    expect(wizardSchema.safeParse({ ...base, base_price_cents: "0" }).success).toBe(false);
    expect(wizardSchema.safeParse({ ...base, check_out_by: "" }).success).toBe(false);
  });

  it("parses bulk changes", () => {
    expect(parseBulkChange("base_price_cents", "200")).toEqual({ ok: true, changes: { base_price_cents: 20000 } });
    expect(parseBulkChange("add_tags", "Pool, Beach")).toEqual({ ok: true, changes: { add_tags: ["Pool", "Beach"] } });
    expect(parseBulkChange("check_in_from", "25:00")).toMatchObject({ ok: false });
    expect(parseBulkChange("status", "archived")).toMatchObject({ ok: false });
  });
});

describe("descriptions (PRP-05)", () => {
  it("counts characters against channel limits", () => {
    const summary = DESCRIPTION_FIELDS.find((f) => f.key === "summary")!;
    expect(characterCount("x".repeat(501), summary.limit)).toEqual({ count: 501, limit: 500, over: true });
    expect(characterCount("🏖️ok", 10).count).toBe(4);
  });
});

describe("secrets (PRP-12)", () => {
  const key = randomBytes(32);

  it("binds a secret to its listing and field", () => {
    const c = encryptCustomSecret("1234", key, LISTING, "f1");
    expect(c).not.toContain("1234");
    expect(decryptCustomSecret(c, key, LISTING, "f1")).toBe("1234");
    expect(() => decryptCustomSecret(c, key, LISTING, "f2")).toThrow();
  });

  it("never exports a secret in plain text", () => {
    const listing: ExportListing = {
      id: LISTING, internal_name: "=cmd|' /C calc'!A0", public_title: 'Ocean "view", 2BR', type: "single", status: "active", parent_id: null,
      address_line1: "1 Main", city: "Miami", state_region: "FL", postal_code: "33139", country_code: "US", timezone: "America/New_York",
      max_guests: 4, bedrooms: 2, bathrooms_full: 1, base_price_cents: 15000, cleaning_fee_cents: 5000, min_nights: 2, tags: ["Pool"], cleaning_status: "dirty",
    };
    const csv = buildListingsCsv(
      [listing],
      [{ id: "f1", key: "door_code", label: "Door code", field_type: "secret" }, { id: "f2", key: "floor", label: "Floor", field_type: "text" }],
      [
        { listing_id: LISTING, field_id: "f1", value_text: null, value_number: null, value_date: null, secret_is_set: true },
        { listing_id: LISTING, field_id: "f2", value_text: "3rd", value_number: null, value_date: null, secret_is_set: false },
      ],
    );
    const [header, row] = csv.trim().split("\r\n");
    expect(header).toContain("custom.door_code,custom.floor");
    expect(row.endsWith(",[secret],3rd")).toBe(true);
    expect(row).toContain(`"Ocean ""view"", 2BR"`);
    expect(row.startsWith(`${LISTING},'=cmd`)).toBe(true); // formula injection neutralised
    expect(csvCell("-1")).toBe("'-1");
  });
});

describe("message variables (PRP-12)", () => {
  const key = randomBytes(32);
  const parent: VariableListing = {
    id: "p", parent_id: null, internal_name: "Studios", public_title: "Sunny Studios", address_line1: "1 Main St", address_line2: "Apt 2",
    city: "Miami", state_region: "FL", postal_code: "33139", check_in_from: "16:00:00", check_in_to: null, check_out_by: "11:00:00", max_guests: 2,
  };
  const sub: VariableListing = { ...parent, id: "s", parent_id: "p", internal_name: "Studio 4", public_title: null, address_line1: null, city: null };
  const store: ListingVariableStore = {
    loadListing: async (id) => ({ p: parent, s: sub })[id] ?? null,
    loadValues: async () => [
      { listing_id: "s", key: "floor", field_type: "text", value_text: "4th", value_number: null, value_date: null },
      { listing_id: "p", key: "floor", field_type: "text", value_text: "ground", value_number: null, value_date: null },
      { listing_id: "p", key: "spots", field_type: "number", value_text: null, value_number: "2", value_date: null },
    ],
    loadSecretCiphertexts: async () => [
      { listing_id: "s", field_id: "d", key: "door_code", ciphertext: encryptCustomSecret("7777", key, "s", "d") },
      { listing_id: "p", field_id: "d", key: "door_code", ciphertext: encryptCustomSecret("0000", key, "p", "d") },
    ],
  };

  it("resolves sub-unit values over the parent's, with the parent's content, without logging", async () => {
    const log = vi.spyOn(console, "log");
    const vars = await resolveListingVariables(store, "s", key);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    expect(vars).toMatchObject({
      "listing.name": "Studio 4",
      "listing.title": "Sunny Studios",
      "listing.address": "1 Main St, Apt 2",
      "listing.check_in_from": "4:00 PM",
      "listing.check_out_by": "11:00 AM",
      "custom.floor": "4th",
      "custom.spots": "2",
      "custom.door_code": "7777",
    });
    expect(renderTemplate("Code {{custom.door_code}} at {{listing.address}}", vars)).toBe("Code 7777 at 1 Main St, Apt 2");
  });
});

describe("error messages", () => {
  it("explains activation problems", () => {
    expect(propertyErrorMessage("listing_not_activatable: address, photo")).toBe(
      "The listing can't be active yet. Missing: Address (street, city, ZIP code, country); At least one photo.",
    );
    expect(propertyErrorMessage("new row violates row-level security policy")).toBe("You do not have permission to do that.");
    expect(propertyErrorMessage("whatever")).toBe("Something went wrong. Try again.");
  });
});
