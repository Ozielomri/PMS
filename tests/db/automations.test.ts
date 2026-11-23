/** Step 7 automations: scheduling (AUT-02/03/04/05), idempotency (AUT-07), jobs (AUT-06), worker. */
import { describe, expect, it } from "vitest";

import { createListing, day } from "./calendar-fixtures";
import { addMember, as, createAccount, query } from "./helpers";
import { book, sqlAs } from "./reservations-fixtures";

type Job = { id: string; occurrence: string; status: string; run_at: Date; reason: string | null; message_id: string | null };

const message = (body = "Hi {{guest.first_name}}") => ({ kind: "message", recipient: "guest", body });

async function setup() {
  const { accountId } = await createAccount();
  const manager = await addMember(accountId, "manager");
  const listing = await createListing(accountId, { tags: ["beach"] });
  return { accountId, manager, listing };
}

async function saveRule(ctx: Awaited<ReturnType<typeof setup>>, payload: Record<string, unknown>, ruleId: string | null = null): Promise<string> {
  const [{ id }] = await sqlAs<{ id: string }>(ctx.manager, "select public.save_automation_rule($1, $2, $3::jsonb) as id", [
    ctx.accountId,
    ruleId,
    JSON.stringify({ name: "Rule", action: message(), ...payload }),
  ]);
  return id;
}

const jobs = (reservationId: string) =>
  query<Job>("select id, occurrence, status, run_at, reason, message_id from public.automation_jobs where reservation_id = $1 order by created_at", [
    reservationId,
  ]);

/** Wall-clock time of a date at HH:MM in New York, as an ISO instant. */
async function nyInstant(date: string, time: string): Promise<string> {
  const [{ t }] = await query<{ t: Date }>("select ($1::date + $2::time) at time zone 'America/New_York' as t", [date, time]);
  return t.toISOString();
}

describe("automations: scheduling", () => {
  it("anchors check-in rules on the listing's default time in its timezone, and on the ETA when set (AUT-04)", async () => {
    const ctx = await setup();
    await saveRule(ctx, { trigger: "check_in", offset_minutes: -2 * 1440, at_time: "10:00" });
    await saveRule(ctx, { name: "Arrival", trigger: "check_in", offset_minutes: -60 });
    const r = await book(ctx.manager, ctx.listing, day(10), day(13));
    const [fixed, relative] = await jobs(r);
    expect(fixed.run_at.toISOString()).toBe(await nyInstant(day(8), "10:00"));
    expect(relative.run_at.toISOString()).toBe(await nyInstant(day(10), "15:00")); // 16:00 default − 1 h

    await sqlAs(ctx.manager, "select public.update_reservation_details($1, p_eta => '18:30'::time, p_clear_times => true)", [r]);
    const [, moved] = await jobs(r);
    expect(moved.run_at.toISOString()).toBe(await nyInstant(day(10), "17:30"));
  });

  it("moves check-in jobs with the dates and cancels them on cancellation, except cancellation rules (AUT-03, AUT-05)", async () => {
    const ctx = await setup();
    await saveRule(ctx, { trigger: "check_in", offset_minutes: -1440, at_time: "09:00" });
    await saveRule(ctx, { name: "Sorry to see you go", trigger: "reservation_canceled" });
    const r = await book(ctx.manager, ctx.listing, day(10), day(12));
    await sqlAs(ctx.manager, "select public.alter_reservation($1, p_check_in => $2::date, p_check_out => $3::date)", [r, day(13), day(15)]);
    const [job] = await jobs(r);
    expect(job.status).toBe("scheduled");
    expect(job.run_at.toISOString()).toBe(await nyInstant(day(12), "09:00"));

    await sqlAs(ctx.manager, "select public.cancel_reservation($1, 'host')", [r]);
    const after = await jobs(r);
    expect(after.map((j) => [j.occurrence, j.status])).toEqual([
      ["check_in", "canceled"],
      ["reservation_canceled", "scheduled"],
    ]);
    expect(after[0].reason).toBe("Reservation canceled");
  });

  it("fires event rules once per occurrence (AUT-07) and only for matching reservations", async () => {
    const ctx = await setup();
    const other = await createListing(ctx.accountId, { tags: ["city"] });
    await saveRule(ctx, { trigger: "reservation_confirmed", conditions: { tags: ["beach"], min_nights: 2 } });
    const a = await book(ctx.manager, ctx.listing, day(20), day(23));
    const shortStay = await book(ctx.manager, ctx.listing, day(30), day(31));
    const city = await book(ctx.manager, other, day(20), day(23));
    expect((await jobs(a)).map((j) => j.occurrence)).toEqual(["reservation_confirmed"]);
    expect(await jobs(shortStay)).toEqual([]);
    expect(await jobs(city)).toEqual([]);
    // Later changes do not fire it again.
    await sqlAs(ctx.manager, "select public.update_reservation_details($1, p_tags => array['vip'])", [a]);
    expect(await jobs(a)).toHaveLength(1);
  });

  it("schedules only future runs when a rule is activated, and pause / resume / delete follow (AUT-02)", async () => {
    const ctx = await setup();
    const soon = await book(ctx.manager, ctx.listing, day(1), day(3));
    const later = await book(ctx.manager, ctx.listing, day(15), day(17));
    const rule = await saveRule(ctx, { trigger: "check_in", offset_minutes: -7 * 1440, at_time: "10:00" });
    expect(await jobs(soon)).toEqual([]); // a week before tomorrow has passed
    expect((await jobs(later))[0].status).toBe("scheduled");

    await sqlAs(ctx.manager, "select public.set_automation_rule_status($1, 'paused')", [rule]);
    expect((await jobs(later))[0]).toMatchObject({ status: "canceled", reason: "Rule paused" });
    await sqlAs(ctx.manager, "select public.set_automation_rule_status($1, 'active')", [rule]);
    expect((await jobs(later))[0].status).toBe("scheduled");

    await expect(sqlAs(ctx.manager, "select public.delete_automation_rule($1)", [rule])).rejects.toThrow(/forbidden/);
    const admin = await addMember(ctx.accountId, "admin");
    await sqlAs(admin, "select public.delete_automation_rule($1)", [rule]);
    expect((await jobs(later))[0]).toMatchObject({ status: "canceled", reason: "Rule deleted" });
  });

  it("validates rules", async () => {
    const ctx = await setup();
    await expect(saveRule(ctx, { trigger: "reservation_confirmed", offset_minutes: -60 })).rejects.toThrow(/at or after/);
    await expect(saveRule(ctx, { trigger: "check_in", offset_minutes: -90, at_time: "10:00" })).rejects.toThrow(/number of days/);
    await expect(saveRule(ctx, { trigger: "check_in", conditions: { colour: ["red"] } })).rejects.toThrow(/unknown condition/);
    await expect(saveRule(ctx, { trigger: "check_in", action: { kind: "message", recipient: "email", email: "nope", body: "x" } })).rejects.toThrow(/valid email/);
    const cleaner = await addMember(ctx.accountId, "cleaner");
    await expect(
      sqlAs(cleaner, "select public.save_automation_rule($1, null, $2::jsonb)", [ctx.accountId, JSON.stringify({ name: "x", trigger: "check_in", action: message() })]),
    ).rejects.toThrow(/forbidden/);
  });
});

describe("automations: jobs and the worker", () => {
  const asWorker = <T>(sql: string, params: unknown[] = []) =>
    as({ role: "service_role", headers: { "x-pms-actor-type": "automation" } }, async (db) => (await db.query(sql, params)).rows as T[]);

  it("claims a due job once and writes the message into the guest's conversation (AUT-07)", async () => {
    const ctx = await setup();
    await saveRule(ctx, { trigger: "reservation_confirmed" });
    const r = await book(ctx.manager, ctx.listing, day(20), day(22));
    const claimed = await asWorker<{ job_id: string; attempts: number }>("select * from public.claim_automation_jobs()");
    const mine = claimed.filter((c) => (c as unknown as { reservation_id: string }).reservation_id === r);
    expect(mine).toHaveLength(1);
    const again = await asWorker<{ reservation_id: string }>("select * from public.claim_automation_jobs()");
    expect(again.filter((c) => c.reservation_id === r)).toEqual([]);

    const [{ ok }] = await asWorker<{ ok: boolean }>("select public.complete_automation_job($1, $2, 'sent', 'Hi Jane') as ok", [mine[0].job_id, mine[0].attempts]);
    expect(ok).toBe(true);
    const [{ ok: twice }] = await asWorker<{ ok: boolean }>("select public.complete_automation_job($1, $2, 'sent', 'Hi Jane') as ok", [mine[0].job_id, mine[0].attempts]);
    expect(twice).toBe(false);

    const [job] = await jobs(r);
    expect(job.status).toBe("sent");
    const [msg] = await query<{ author_type: string; body: string; status: string }>(
      "select m.author_type, m.body, d.status from public.messages m join public.message_deliveries d on d.message_id = m.id where m.id = $1",
      [job.message_id],
    );
    expect(msg).toEqual({ author_type: "automation", body: "Hi Jane", status: "queued" });
  });

  it("refuses to send unresolved variables, skips late jobs past their expiry (AUT-09) and lets users skip or send now (AUT-06)", async () => {
    const ctx = await setup();
    const rule = await saveRule(ctx, { trigger: "check_in", offset_minutes: -1440, expire_after_hours: 2 });
    const r = await book(ctx.manager, ctx.listing, day(20), day(22));
    const [job] = await jobs(r);

    // Due five hours ago: past the 2-hour expiry.
    await query("update public.automation_jobs set run_at = now() - interval '5 hours' where id = $1", [job.id]);
    await asWorker("select * from public.claim_automation_jobs()");
    expect((await jobs(r))[0]).toMatchObject({ status: "skipped", reason: "Expired: more than 2 hours late" });

    await expect(sqlAs(ctx.manager, "select public.skip_automation_job($1)", [job.id])).rejects.toThrow(/job_not_scheduled/);
    await sqlAs(ctx.manager, "select public.set_automation_rule_status($1, 'paused')", [rule]);
    await sqlAs(ctx.manager, "select public.set_automation_rule_status($1, 'active')", [rule]);

    const r2 = await book(ctx.manager, ctx.listing, day(25), day(27));
    const [job2] = await jobs(r2);
    await sqlAs(ctx.manager, "select public.edit_automation_job($1, 'Custom text')", [job2.id]);
    await sqlAs(ctx.manager, "select public.send_automation_job_now($1)", [job2.id]);
    const claimed = (await asWorker<{ job_id: string; attempts: number; override_body: string }>("select * from public.claim_automation_jobs()")).find(
      (c) => c.job_id === job2.id,
    );
    expect(claimed?.override_body).toBe("Custom text");
    await expect(asWorker("select public.complete_automation_job($1, $2, 'sent', 'Hi {{guest.first_name}}')", [job2.id, claimed!.attempts])).rejects.toThrow(
      /unresolved_variables/,
    );
    await asWorker("select public.complete_automation_job($1, $2, 'failed', p_reason => 'Unresolved variables: guest.first_name')", [job2.id, claimed!.attempts]);
    expect((await jobs(r2))[0].status).toBe("failed");
    await sqlAs(ctx.manager, "select public.send_automation_job_now($1)", [job2.id]);
    expect((await jobs(r2))[0].status).toBe("scheduled");
  });

  it("previews how many reservations a rule applies to without writing anything (AUT-10)", async () => {
    const ctx = await setup();
    await book(ctx.manager, ctx.listing, day(20), day(22));
    await book(ctx.manager, ctx.listing, day(30), day(35));
    const [{ p }] = await sqlAs<{ p: { count: number; next: { code: string }[] } }>(ctx.manager, "select public.preview_automation_rule($1, $2::jsonb) as p", [
      ctx.accountId,
      JSON.stringify({ name: "x", trigger: "check_in", offset_minutes: -1440, action: message(), conditions: { min_nights: 3 } }),
    ]);
    expect(p.count).toBe(1);
    expect(p.next).toHaveLength(1);
    expect(await query("select 1 from public.automation_rules where account_id = $1", [ctx.accountId])).toEqual([]);
  });
});
