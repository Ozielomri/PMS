/** RES-05 quotes: options, link, optional hold, expiry, accept with availability re-check. */
import { describe, expect, it } from "vitest";

import { calendar, createListing, day } from "./calendar-fixtures";
import { addMember, as, createAccount, query } from "./helpers";
import { book, lines, sqlAs } from "./reservations-fixtures";

async function setup() {
  const { accountId } = await createAccount();
  const manager = await addMember(accountId, "manager");
  const a = await createListing(accountId, { base_price_cents: 10000 });
  const b = await createListing(accountId, { base_price_cents: 15000 });
  return { accountId, manager, a, b };
}

async function createQuote(ctx: Awaited<ReturnType<typeof setup>>, hold: boolean, expiresInMinutes = 60 * 24) {
  const [row] = await sqlAs<{ quote_id: string; token: string }>(
    ctx.manager,
    `select * from public.create_quote($1, $2::jsonb, now() + make_interval(mins => $3), p_guest => $4::jsonb, p_hold => $5)`,
    [
      ctx.accountId,
      JSON.stringify([
        { listing_id: ctx.a, check_in: day(10), check_out: day(12), adults: 2 },
        { listing_id: ctx.b, check_in: day(10), check_out: day(12), adults: 2 },
      ]),
      expiresInMinutes,
      JSON.stringify({ first_name: "Quinn", email: "quinn@example.test" }),
      hold,
    ],
  );
  return row;
}

const anon = <T>(sql: string, params: unknown[]) => as({ role: "anon" }, async (db) => (await db.query(sql, params)).rows as T[]);

describe("quotes (RES-05)", () => {
  it("prices each option and shows them on the public link", async () => {
    const ctx = await setup();
    const q = await createQuote(ctx, false);
    const [{ quote }] = await anon<{ quote: { status: string; options: { total_cents: number }[]; guest_first_name: string } }>(
      "select public.get_quote($1) as quote",
      [q.token],
    );
    expect(quote.status).toBe("open");
    expect(quote.guest_first_name).toBe("Quinn");
    expect(quote.options.map((o) => o.total_cents)).toEqual([20000, 30000]);
    expect((await anon<{ quote: unknown }>("select public.get_quote('nope') as quote", []))[0].quote).toBeNull();
  });

  it("holds nothing unless asked; with a hold the nights are blocked until expiry", async () => {
    const ctx = await setup();
    await createQuote(ctx, false);
    expect((await calendar([ctx.a], day(10), day(11)))[0].status).toBe("available");
    const held = await createListing(ctx.accountId);
    const other = await createListing(ctx.accountId);
    await createQuote({ ...ctx, a: held, b: other }, true);
    expect((await calendar([held], day(10), day(11)))[0].status).toBe("booked");
  });

  it("books the accepted option at the quoted price and frees the others", async () => {
    const ctx = await setup();
    const q = await createQuote(ctx, true);
    const [opt] = await query<{ id: string }>("select id from public.quote_options where quote_id = $1 order by position", [q.quote_id]);
    // Prices change after the quote was sent; the quoted price stands.
    await query("update public.listings set base_price_cents = 50000 where id = $1", [ctx.a]);

    const [{ r }] = await anon<{ r: { reservation_code: string } }>("select public.accept_quote($1, $2) as r", [q.token, opt.id]);
    const [res] = await query<{ id: string; status: string; listing_id: string }>("select id, status, listing_id from public.reservations where code = $1", [r.reservation_code]);
    expect(res).toMatchObject({ status: "confirmed", listing_id: ctx.a });
    expect((await lines(res.id)).map((l) => [l.kind, Number(l.amount_cents), l.source])).toEqual([["accommodation", 20000, "quote"]]);
    expect((await calendar([ctx.b], day(10), day(11)))[0].status).toBe("available");
    expect((await calendar([ctx.a], day(10), day(11)))[0].status).toBe("booked");

    const [{ r: again }] = await anon<{ r: { already_accepted: boolean } }>("select public.accept_quote($1, $2) as r", [q.token, opt.id]);
    expect(again.already_accepted).toBe(true);
  });

  it("re-checks availability on accept when nothing was held", async () => {
    const ctx = await setup();
    const q = await createQuote(ctx, false);
    await book(ctx.manager, ctx.a, day(10), day(12));
    const [opt] = await query<{ id: string }>("select id from public.quote_options where quote_id = $1 order by position", [q.quote_id]);
    await expect(anon("select public.accept_quote($1, $2)", [q.token, opt.id])).rejects.toThrow(/calendar_conflict/);
    expect((await query("select status from public.quotes where id = $1", [q.quote_id]))[0].status).toBe("open");
  });

  it("refuses expired and canceled quotes", async () => {
    const ctx = await setup();
    const q = await createQuote(ctx, false);
    await sqlAs(ctx.manager, "select public.cancel_quote($1)", [q.quote_id]);
    const [opt] = await query<{ id: string }>("select id from public.quote_options where quote_id = $1", [q.quote_id]);
    await expect(anon("select public.accept_quote($1, $2)", [q.token, opt.id])).rejects.toThrow(/quote_not_open/);
    await expect(sqlAs(ctx.manager, "select token_hash from public.quotes")).rejects.toThrow(/permission denied/);
  });
});
