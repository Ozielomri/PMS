/**
 * PRP-12 custom fields, incl. secret values (X-15): encrypted, masked, redacted in audit and
 * events, never readable by clients in plain text, usable as message variables.
 * Acceptance: "A custom field marked secret never appears in exports or logs in plain text."
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildListingsCsv } from "@/lib/properties/export";
import { decryptCustomSecret, encryptCustomSecret } from "@/lib/properties/secrets";
import { renderTemplate, resolveListingVariables, type ListingVariableStore } from "@/lib/properties/variables";

import { addMember, as, createAccount, query } from "./helpers";
import { bookableListing, multiUnit, run } from "./properties-fixtures";

const KEY = randomBytes(32);
const DOOR_CODE = "4711-secret-door";

async function field(user: { id: string }, accountId: string, key: string, type: string, options: string[] = []) {
  return run(user, async (db) => {
    const { rows } = await db.query(
      "insert into public.custom_fields (account_id, key, label, field_type, options) values ($1, $2, $3, $4, $5) returning id",
      [accountId, key, key.replace(/_/g, " "), type, options],
    );
    return rows[0].id as string;
  });
}

async function setValue(user: { id: string }, listingId: string, fieldId: string, v: { text?: string; number?: number; date?: string; secret?: string }) {
  return run(user, (db) =>
    db.query("select public.set_listing_custom_value($1, $2, $3, $4, $5, $6)", [listingId, fieldId, v.text ?? null, v.number ?? null, v.date ?? null, v.secret ?? null]),
  );
}

/** The resolver's store, over a direct connection as the service role (as Inbox will use it). */
const service = { role: "service_role" as const };
const pgStore: ListingVariableStore = {
  async loadListing(id) {
    return as(service, async (db) => (await db.query("select * from public.listings where id = $1", [id])).rows[0] ?? null);
  },
  async loadValues(ids) {
    return as(service, async (db) =>
      (
        await db.query(
          `select v.listing_id, f.key, f.field_type::text, v.value_text, v.value_number, v.value_date::text
           from public.listing_custom_values v join public.custom_fields f on f.id = v.field_id
           where v.listing_id = any($1) and f.archived_at is null`,
          [ids],
        )
      ).rows,
    );
  },
  async loadSecretCiphertexts(id) {
    return as(service, async (db) => (await db.query("select * from public.listing_secret_ciphertexts($1)", [id])).rows);
  },
};

describe("custom field definitions", () => {
  it("are account settings: admins create them, key and type are immutable, everyone with view reads them", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    await expect(field(manager, accountId, "door_code", "secret")).rejects.toThrow(/row-level security/);
    const id = await field(admin, accountId, "door_code", "secret");
    await expect(run(admin, (db) => db.query("update public.custom_fields set field_type = 'text' where id = $1", [id]))).rejects.toThrow(/custom_field_immutable/);
    await expect(field(admin, accountId, "floor", "dropdown")).rejects.toThrow(/custom_fields_options/);
    await expect(field(admin, accountId, "Bad Key", "text")).rejects.toThrow(/check constraint/);
    const seen = await run(manager, async (db) => (await db.query("select key from public.custom_fields where account_id = $1", [accountId])).rows);
    expect(seen).toEqual([{ key: "door_code" }]);
  });
});

describe("custom values", () => {
  it("must match the field type", async () => {
    const { accountId, admin } = await createAccount();
    const listing = await bookableListing(admin, accountId);
    const floor = await field(admin, accountId, "floor", "dropdown", ["Ground", "First"]);
    const sqm = await field(admin, accountId, "parking_spots", "number");
    const secret = await field(admin, accountId, "door_code", "secret");

    await setValue(admin, listing, floor, { text: "First" });
    await expect(setValue(admin, listing, floor, { text: "Roof" })).rejects.toThrow(/custom_value_not_an_option/);
    await expect(setValue(admin, listing, sqm, { text: "two" })).rejects.toThrow(/custom_value_type_mismatch/);
    await setValue(admin, listing, sqm, { number: 2 });
    // A plaintext "secret" is rejected by the database: only the v1 ciphertext format is accepted.
    await expect(setValue(admin, listing, secret, { secret: DOOR_CODE })).rejects.toThrow(/check constraint/);
    await expect(setValue(admin, listing, secret, { text: DOOR_CODE })).rejects.toThrow(/custom_value_type_mismatch/);
    expect(await query("select count(*)::int as n from public.listing_custom_values where listing_id = $1", [listing])).toEqual([{ n: 2 }]);
  });

  it("are written only through the RPCs, by editors within scope", async () => {
    const { accountId, admin } = await createAccount();
    const frontOffice = await addMember(accountId, "front_office");
    const listing = await bookableListing(admin, accountId);
    const notes = await field(admin, accountId, "notes", "text");
    await expect(
      run(admin, (db) =>
        db.query("insert into public.listing_custom_values (account_id, listing_id, field_id, value_text) values ($1, $2, $3, 'x')", [accountId, listing, notes]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(setValue(frontOffice, listing, notes, { text: "x" })).rejects.toThrow(/forbidden/);
    const other = await createAccount();
    await expect(setValue(other.admin, listing, notes, { text: "x" })).rejects.toThrow(/not_found/);
    await setValue(admin, listing, notes, { text: "Key in lockbox" });
    await run(admin, (db) => db.query("select public.clear_listing_custom_value($1, $2)", [listing, notes]));
    expect(await query("select count(*)::int as n from public.listing_custom_values where listing_id = $1", [listing])).toEqual([{ n: 0 }]);
  });
});

describe("secret custom fields", () => {
  it("never appear in plain text in the database, audit log, events or exports", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const frontOffice = await addMember(accountId, "front_office");
    const listing = await bookableListing(admin, accountId);
    const secret = await field(admin, accountId, "door_code", "secret");
    const ciphertext = encryptCustomSecret(DOOR_CODE, KEY, listing, secret);
    await setValue(manager, listing, secret, { secret: ciphertext });
    const rotated = encryptCustomSecret("9999-new", KEY, listing, secret);
    await setValue(manager, listing, secret, { secret: rotated });

    // Clients can't select the ciphertext column; they see whether it is set.
    await expect(run(manager, (db) => db.query("select value_secret_ciphertext from public.listing_custom_values"))).rejects.toThrow(/permission denied/);
    const visible = await run(frontOffice, async (db) =>
      (await db.query("select field_id, secret_is_set, value_text from public.listing_custom_values where listing_id = $1", [listing])).rows,
    );
    expect(visible).toEqual([{ field_id: secret, secret_is_set: true, value_text: null }]);

    // Audit log and events: redacted / left out — no plaintext and no ciphertext.
    const audit = await query<{ diff: unknown }>("select diff from public.audit_log where entity_type = 'listing_custom_values' and account_id = $1", [accountId]);
    expect(audit).toHaveLength(2);
    expect(audit[1].diff).toEqual({ value_secret_ciphertext: { old: "[redacted]", new: "[redacted]" } });
    const events = await query<{ payload: unknown }>("select payload from public.domain_events where account_id = $1", [accountId]);
    const everything = JSON.stringify([audit, events]);
    for (const needle of [DOOR_CODE, "9999-new", ciphertext, rotated]) expect(everything).not.toContain(needle);
    expect(events.some((e) => JSON.stringify(e.payload).includes('"section":"custom_fields"'))).toBe(true);

    // Per-listing change log (PRP-19) shows the change, redacted.
    const log = await run(manager, async (db) => (await db.query("select entity_type, diff from public.listing_change_log($1)", [listing])).rows);
    expect(log.find((r) => r.entity_type === "listing_custom_values")?.diff).toEqual({ value_secret_ciphertext: { old: "[redacted]", new: "[redacted]" } });

    // CSV export (what clients can read) prints a placeholder.
    const fields = await run(manager, async (db) => (await db.query("select id, key, label, field_type::text from public.custom_fields where account_id = $1", [accountId])).rows);
    const values = await run(manager, async (db) =>
      (await db.query("select listing_id, field_id, value_text, value_number, value_date, secret_is_set from public.listing_custom_values")).rows,
    );
    const listings = await run(manager, async (db) => (await db.query("select * from public.listings where id = $1", [listing])).rows);
    const csv = buildListingsCsv(listings, fields, values);
    expect(csv).toContain("[secret]");
    expect(csv).not.toContain("9999-new");
  });

  it("are decrypted on the server only for editors or the service role, bound to their row", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const frontOffice = await addMember(accountId, "front_office");
    const listing = await bookableListing(admin, accountId);
    const other = await bookableListing(admin, accountId);
    const secret = await field(admin, accountId, "door_code", "secret");
    await setValue(admin, listing, secret, { secret: encryptCustomSecret(DOOR_CODE, KEY, listing, secret) });

    await expect(run(frontOffice, (db) => db.query("select * from public.listing_secret_ciphertexts($1)", [listing]))).rejects.toThrow(/forbidden/);
    const [row] = await run(manager, async (db) => (await db.query("select * from public.listing_secret_ciphertexts($1)", [listing])).rows);
    expect(decryptCustomSecret(row.ciphertext, KEY, listing, secret)).toBe(DOOR_CODE);
    // A ciphertext copied to another listing does not decrypt there.
    expect(() => decryptCustomSecret(row.ciphertext, KEY, other, secret)).toThrow();
  });

  it("resolve as message variables, sub-unit values overriding the parent's, without logging them", async () => {
    const { accountId, admin } = await createAccount();
    const { parent, subs } = await multiUnit(admin, accountId, { units: 2 });
    const door = await field(admin, accountId, "door_code", "secret");
    const wifi = await field(admin, accountId, "wifi_password", "secret");
    const floor = await field(admin, accountId, "floor", "text");
    await setValue(admin, parent, wifi, { secret: encryptCustomSecret("parent-wifi", KEY, parent, wifi) });
    await setValue(admin, parent, door, { secret: encryptCustomSecret("parent-door", KEY, parent, door) });
    await setValue(admin, subs[0], door, { secret: encryptCustomSecret("1234", KEY, subs[0], door) });
    await setValue(admin, subs[0], floor, { text: "3rd" });

    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const vars = await resolveListingVariables(pgStore, subs[0], KEY);
    const second = await resolveListingVariables(pgStore, subs[1], KEY);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }

    expect(vars).toMatchObject({ "custom.door_code": "1234", "custom.wifi_password": "parent-wifi", "custom.floor": "3rd", "listing.city": "Miami Beach", "listing.check_in_from": "4:00 PM" });
    expect(second["custom.door_code"]).toBe("parent-door");
    expect(renderTemplate("Door: {{custom.door_code}}, Wi-Fi: {{ custom.wifi_password }}, {{custom.unknown}}", vars)).toBe(
      "Door: 1234, Wi-Fi: parent-wifi, {{custom.unknown}}",
    );
  });
});
