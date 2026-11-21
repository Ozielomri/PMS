/**
 * X-04 domain events (outbox) and the internal event bus.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processConsumer } from "@/lib/events/bus";
import { domainEventSchema } from "@/lib/events/types";

import { addMember, as, asSystem, asUser, createAccount, query } from "./helpers";
import { pgEventQueueStore } from "./pg-stores";

const CONSUMER = `test-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await query("insert into public.event_consumers (name, event_types) values ($1, $2)", [CONSUMER, ["membership.*", "account.updated"]]);
  await query("insert into public.event_consumers (name, event_types, active) values ($1, '{*}', false)", [`${CONSUMER}-off`]);
});

afterAll(async () => {
  await query("update public.event_consumers set active = false where name like $1", [`${CONSUMER}%`]);
});

const eventsFor = (accountId: string) =>
  query<{ id: string; type: string; entity_id: string; actor_type: string; actor_id: string | null; payload: Record<string, unknown> }>(
    "select * from public.domain_events where account_id = $1 order by seq",
    [accountId],
  );

describe("domain events", () => {
  it("are emitted for every state change, attributed to the actor", async () => {
    const { accountId, admin } = await createAccount();
    const cleaner = await addMember(accountId, "cleaner");
    await asUser(admin, (db) => db.query("update public.memberships set role = 'supervisor' where id = $1", [cleaner.membershipId]));
    await asUser(admin, (db) => db.query("update public.memberships set status = 'removed' where id = $1", [cleaner.membershipId]));

    const events = await eventsFor(accountId);
    expect(events.map((e) => e.type)).toEqual([
      "account.created",
      "membership.created", // admin, via create_account
      "membership.created", // cleaner, added directly by the system
      "membership.updated",
      "membership.removed",
    ]);
    expect(events[3]).toMatchObject({ actor_type: "user", actor_id: admin.id, entity_id: cleaner.membershipId });
    expect(events[3].payload.changes).toEqual({ role: { old: "cleaner", new: "supervisor" } });
    expect(events[2].actor_type).toBe("system");
  });

  it("exist only if the transaction commits (transactional outbox)", async () => {
    const { accountId, admin } = await createAccount();
    const before = (await eventsFor(accountId)).length;
    await expect(
      asUser(admin, async (db) => {
        await db.query("update public.accounts set name = 'Rolled back' where id = $1", [accountId]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await eventsFor(accountId)).length).toBe(before);
  });

  it("share a transaction id when emitted together", async () => {
    const { accountId } = await createAccount();
    const rows = await query<{ txid: string }>("select distinct txid from public.domain_events where account_id = $1", [accountId]);
    expect(rows).toHaveLength(1); // account.created + membership.created in one create_account call
  });

  it("serialise to the documented envelope", async () => {
    const { accountId } = await createAccount();
    const [row] = await query<{ envelope: unknown }>(
      "select private.event_envelope(e) as envelope from public.domain_events e where account_id = $1 order by seq limit 1",
      [accountId],
    );
    const parsed = domainEventSchema.parse(row.envelope);
    expect(parsed).toMatchObject({ type: "account.created", account_id: accountId, entity: { type: "account", id: accountId } });
    expect(parsed.occurred_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  });

  it("are append-only and readable only with events.view", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const fo = await addMember(accountId, "front_office");
    await expect(query("update public.domain_events set type = 'x.y' where account_id = $1", [accountId])).rejects.toThrow(/append-only/);
    await expect(query("delete from public.domain_events where account_id = $1", [accountId])).rejects.toThrow(/append-only/);
    const count = (u: { id: string }) =>
      asUser(u, async (db) => (await db.query("select count(*)::int as n from public.domain_events where account_id = $1", [accountId])).rows[0].n);
    expect(await count(admin)).toBeGreaterThan(0);
    expect(await count(manager)).toBeGreaterThan(0);
    expect(await count(fo)).toBe(0);
  });
});

describe("internal event bus", () => {
  it("fans events out to active consumers whose patterns match", async () => {
    const { accountId, admin } = await createAccount();
    await asUser(admin, (db) => db.query("update public.accounts set name = 'Fan-out' where id = $1", [accountId]));
    const queued = await query<{ consumer: string; type: string }>(
      `select q.consumer, e.type from public.event_queue q join public.domain_events e on e.id = q.event_id
       where q.account_id = $1 and q.consumer like $2 order by e.seq`,
      [accountId, `${CONSUMER}%`],
    );
    expect(queued).toEqual([
      { consumer: CONSUMER, type: "membership.created" },
      { consumer: CONSUMER, type: "account.updated" },
    ]); // account.created does not match; the inactive consumer gets nothing
  });

  it("processes events in order, retries failures with backoff and gives up after max attempts", async () => {
    // Drain anything queued by earlier tests.
    await processConsumer({ consumer: CONSUMER, handler: () => undefined, store: pgEventQueueStore, limit: 1000 });

    const { accountId, admin } = await createAccount();
    await asUser(admin, (db) => db.query("update public.accounts set name = 'Bus' where id = $1", [accountId]));

    const seen: string[] = [];
    let summary = await processConsumer({
      consumer: CONSUMER,
      store: pgEventQueueStore,
      handler: (e) => {
        seen.push(e.type);
        if (e.type === "account.updated") throw new Error("downstream unavailable");
      },
    });
    expect(seen).toEqual(["membership.created", "account.updated"]);
    expect(summary).toMatchObject({ claimed: 2, done: 1, retrying: 1, failed: 0 });

    const [pending] = await query<{ status: string; attempts: number; last_error: string; delay: number }>(
      `select status, attempts, last_error, extract(epoch from next_attempt_at - now())::float as delay
       from public.event_queue where consumer = $1 and status = 'pending'`,
      [CONSUMER],
    );
    expect(pending).toMatchObject({ status: "pending", attempts: 1, last_error: "downstream unavailable" });
    expect(pending.delay).toBeGreaterThan(5);
    expect(pending.delay).toBeLessThan(15);

    // Not due yet: nothing to claim.
    summary = await processConsumer({ consumer: CONSUMER, store: pgEventQueueStore, handler: () => undefined });
    expect(summary.claimed).toBe(0);

    // Make it due and fail it for the last allowed attempt.
    await query("update public.event_queue set next_attempt_at = now() where consumer = $1 and status = 'pending'", [CONSUMER]);
    summary = await processConsumer({
      consumer: CONSUMER,
      store: pgEventQueueStore,
      maxAttempts: 2,
      handler: () => {
        throw new Error("still down");
      },
    });
    expect(summary).toMatchObject({ claimed: 1, failed: 1 });
    const [failed] = await query("select status, attempts from public.event_queue where consumer = $1 and status = 'failed'", [CONSUMER]);
    expect(failed).toEqual({ status: "failed", attempts: 2 });
  });

  it("never hands the same item to two concurrent workers (SKIP LOCKED + lease)", async () => {
    const { accountId, admin } = await createAccount();
    for (let i = 0; i < 20; i++) {
      await asUser(admin, (db) => db.query("update public.accounts set name = $2 where id = $1", [accountId, `Concurrent ${i}`]));
    }
    const claim = () => as({ role: "service_role" }, (db) => db.query("select queue_id from public.claim_events($1, 15, 60)", [CONSUMER]));
    const [a, b] = await Promise.all([claim(), claim()]);
    const idsA = a.rows.map((r) => r.queue_id);
    const idsB = b.rows.map((r) => r.queue_id);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect(idsA.length + idsB.length).toBeGreaterThanOrEqual(20);

    // Leased items are not handed out again until the lease expires.
    const again = await claim();
    expect(again.rows.filter((r) => idsA.includes(r.queue_id) || idsB.includes(r.queue_id))).toEqual([]);
    await asSystem((db) => db.query("update public.event_queue set locked_until = now() - interval '1 second' where id = any($1)", [idsA]));
    const reclaimed = await claim();
    expect(reclaimed.rows.map((r) => r.queue_id).sort()).toEqual(expect.arrayContaining(idsA.slice(0, 1)));
  });
});
