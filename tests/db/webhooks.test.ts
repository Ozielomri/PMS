/**
 * X-04 outbound webhooks: fan-out, HMAC signature, retries with backoff for 24 h, delivery log,
 * redelivery. Runs the real dispatcher against a local HTTP receiver.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encryptSecret } from "@/lib/crypto/secrets";
import { dispatchWebhooks } from "@/lib/webhooks/dispatcher";
import { verifySignature } from "@/lib/webhooks/signature";

import { addMember, asUser, createAccount, query } from "./helpers";
import { pgDeliveryStore } from "./pg-stores";

const KEY = randomBytes(32);

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server;
let baseUrl: string;
let received: Received[] = [];
/** Status code the receiver answers with, per path. */
let responses: Record<string, number> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body });
      res.statusCode = responses[req.url ?? ""] ?? 200;
      res.end(res.statusCode >= 400 ? "receiver error" : "ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  received = [];
  responses = {};
  // Close deliveries left by earlier tests so each test only dispatches its own.
  await query("update public.webhook_deliveries set status = 'failed', completed_at = now() where status in ('pending', 'delivering')");
});

async function addEndpoint(accountId: string, path: string, eventTypes = ["*"], active = true) {
  const id = randomUUID();
  const secret = `whsec_${randomBytes(16).toString("hex")}`;
  await query(
    `insert into public.webhook_endpoints (id, account_id, url, event_types, secret_ciphertext, secret_last4, active)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, accountId, `${baseUrl}${path}`, eventTypes, encryptSecret(secret, KEY, id), secret.slice(-4), active],
  );
  return { id, secret, path };
}

const dispatch = () => dispatchWebhooks({ store: pgDeliveryStore, encryptionKey: KEY, allowPrivateNetworks: true });

const deliveriesFor = (endpointId: string) =>
  query<{ id: string; status: string; attempt_count: number; event_type: string; last_status_code: number | null; last_error: string | null; retry_in: number }>(
    `select id, status, attempt_count, event_type, last_status_code, last_error,
            extract(epoch from next_attempt_at - now())::float as retry_in
     from public.webhook_deliveries where endpoint_id = $1 order by created_at`,
    [endpointId],
  );

async function renameAccount(admin: { id: string }, accountId: string, name: string) {
  await asUser(admin, (db) => db.query("update public.accounts set name = $2 where id = $1", [accountId, name]));
}

describe("webhook fan-out", () => {
  it("creates one delivery per matching active endpoint of the same account", async () => {
    const { accountId, admin } = await createAccount();
    const other = await createAccount();
    const all = await addEndpoint(accountId, "/all");
    const accountOnly = await addEndpoint(accountId, "/account", ["account.*"]);
    const reservations = await addEndpoint(accountId, "/reservations", ["reservation.*"]);
    const disabled = await addEndpoint(accountId, "/disabled", ["*"], false);
    const foreign = await addEndpoint(other.accountId, "/foreign");

    await renameAccount(admin, accountId, "Fan-out");

    // "*" also receives the webhook_endpoint.created events of the endpoints added after it.
    expect((await deliveriesFor(all.id)).map((d) => d.event_type)).toEqual([
      "webhook_endpoint.created",
      "webhook_endpoint.created",
      "webhook_endpoint.created",
      "webhook_endpoint.created",
      "account.updated",
    ]);
    expect((await deliveriesFor(accountOnly.id)).map((d) => d.event_type)).toEqual(["account.updated"]);
    expect(await deliveriesFor(reservations.id)).toEqual([]);
    expect(await deliveriesFor(disabled.id)).toEqual([]);
    // The other tenant's endpoint only hears about its own account.
    expect((await deliveriesFor(foreign.id)).map((d) => d.event_type)).toEqual(["webhook_endpoint.created"]);
  });
});

describe("webhook dispatcher", () => {
  it("delivers a signed event and logs the attempt", async () => {
    const { accountId, admin } = await createAccount();
    const ep = await addEndpoint(accountId, "/ok", ["account.updated"]);
    await renameAccount(admin, accountId, "Signed");

    const summary = await dispatch();
    expect(summary).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(received).toHaveLength(1);

    const [req] = received;
    expect(verifySignature(req.headers["x-pms-signature"] as string, ep.secret, req.body)).toMatchObject({ ok: true });
    expect(verifySignature(req.headers["x-pms-signature"] as string, "whsec_wrong", req.body)).toMatchObject({ ok: false });
    const event = JSON.parse(req.body);
    expect(event).toMatchObject({ type: "account.updated", account_id: accountId, actor: { type: "user", id: admin.id } });
    expect(event.data.changes).toEqual({ name: { old: "Test Rentals", new: "Signed" } });
    expect(req.headers).toMatchObject({
      "content-type": "application/json",
      "user-agent": "PMS-Webhooks/1.0",
      "x-pms-event-id": event.id,
      "x-pms-event-type": "account.updated",
      "x-pms-delivery-attempt": "1",
    });

    const [delivery] = await deliveriesFor(ep.id);
    expect(delivery).toMatchObject({ status: "succeeded", attempt_count: 1, last_status_code: 200 });
    const attempts = await query("select attempt_number, status_code, response_body from public.webhook_delivery_attempts where delivery_id = $1", [
      delivery.id,
    ]);
    expect(attempts).toEqual([{ attempt_number: 1, status_code: 200, response_body: "ok" }]);

    // Nothing left to send.
    expect((await dispatch()).claimed).toBe(0);
  });

  it("retries failures with exponential backoff, then succeeds", async () => {
    const { accountId, admin } = await createAccount();
    const ep = await addEndpoint(accountId, "/flaky", ["account.updated"]);
    responses["/flaky"] = 500;
    await renameAccount(admin, accountId, "Flaky");

    expect(await dispatch()).toMatchObject({ claimed: 1, retrying: 1 });
    let [d] = await deliveriesFor(ep.id);
    expect(d).toMatchObject({ status: "pending", attempt_count: 1, last_status_code: 500, last_error: "HTTP 500" });
    expect(d.retry_in).toBeGreaterThan(30 * 0.8 - 2);
    expect(d.retry_in).toBeLessThan(30 * 1.2 + 1);

    // Not due yet.
    expect((await dispatch()).claimed).toBe(0);

    // Second failure doubles the delay.
    await query("update public.webhook_deliveries set next_attempt_at = now() where id = $1", [d.id]);
    await dispatch();
    [d] = await deliveriesFor(ep.id);
    expect(d.attempt_count).toBe(2);
    expect(d.retry_in).toBeGreaterThan(60 * 0.8 - 2);
    expect(d.retry_in).toBeLessThan(60 * 1.2 + 1);

    // Receiver recovers.
    responses["/flaky"] = 200;
    await query("update public.webhook_deliveries set next_attempt_at = now() where id = $1", [d.id]);
    expect(await dispatch()).toMatchObject({ succeeded: 1 });
    [d] = await deliveriesFor(ep.id);
    expect(d).toMatchObject({ status: "succeeded", attempt_count: 3 });
    const attempts = await query<{ status_code: number }>(
      "select status_code from public.webhook_delivery_attempts where delivery_id = $1 order by attempt_number",
      [d.id],
    );
    expect(attempts.map((a) => a.status_code)).toEqual([500, 500, 200]);
    expect(received.map((r) => r.headers["x-pms-delivery-attempt"])).toEqual(["1", "2", "3"]);
  });

  it("gives up once the 24-hour window is over", async () => {
    const { accountId, admin } = await createAccount();
    const ep = await addEndpoint(accountId, "/down", ["account.updated"]);
    responses["/down"] = 503;
    await renameAccount(admin, accountId, "Down");

    // A retry that would land after the window closes the delivery as failed.
    await query("update public.webhook_deliveries set expires_at = now() + interval '10 seconds' where endpoint_id = $1", [ep.id]);
    expect(await dispatch()).toMatchObject({ claimed: 1, failed: 1 });
    expect((await deliveriesFor(ep.id))[0]).toMatchObject({ status: "failed", attempt_count: 1 });

    // A pending delivery whose window passed (e.g. dispatcher was down) is closed without sending.
    await renameAccount(admin, accountId, "Down again");
    await query("update public.webhook_deliveries set expires_at = now() - interval '1 second' where endpoint_id = $1 and status = 'pending'", [ep.id]);
    received = [];
    expect((await dispatch()).claimed).toBe(0);
    expect(received).toHaveLength(0);
    const last = (await deliveriesFor(ep.id)).at(-1)!;
    expect(last).toMatchObject({ status: "failed", attempt_count: 0 });
    expect(last.last_error).toMatch(/24 hours/);
  });

  it("stops at once on 410 Gone and for disabled endpoints", async () => {
    const { accountId, admin } = await createAccount();
    await addEndpoint(accountId, "/gone", ["account.updated"]);
    responses["/gone"] = 410;
    await renameAccount(admin, accountId, "Gone");
    expect(await dispatch()).toMatchObject({ failed: 1 });

    const later = await addEndpoint(accountId, "/later", ["account.updated"]);
    await renameAccount(admin, accountId, "Disabled before send");
    await query("update public.webhook_endpoints set active = false where id = $1", [later.id]);
    received = [];
    await dispatch();
    expect(received.filter((r) => r.path === "/later")).toHaveLength(0);
    expect((await deliveriesFor(later.id))[0]).toMatchObject({ status: "failed", last_error: "endpoint disabled" });
  });

  it("sends each delivery exactly once when dispatchers run concurrently", async () => {
    const { accountId, admin } = await createAccount();
    const ep = await addEndpoint(accountId, "/concurrent", ["account.updated"]);
    for (let i = 0; i < 12; i++) await renameAccount(admin, accountId, `Concurrent ${i}`);

    const results = await Promise.all([dispatch(), dispatch(), dispatch()]);
    expect(results.reduce((n, r) => n + r.succeeded, 0)).toBe(12);
    const ids = received.map((r) => r.headers["x-pms-delivery-id"]);
    expect(new Set(ids).size).toBe(12);
    expect(ids).toHaveLength(12);
    expect((await deliveriesFor(ep.id)).every((d) => d.status === "succeeded" && d.attempt_count === 1)).toBe(true);
  });

  it("fails without sending when the endpoint secret cannot be decrypted", async () => {
    const { accountId, admin } = await createAccount();
    const ep = await addEndpoint(accountId, "/badkey", ["account.updated"]);
    await renameAccount(admin, accountId, "Bad key");
    await dispatchWebhooks({ store: pgDeliveryStore, encryptionKey: randomBytes(32), allowPrivateNetworks: true });
    expect(received).toHaveLength(0);
    expect((await deliveriesFor(ep.id))[0]).toMatchObject({ status: "failed", last_error: "could not decrypt endpoint secret" });
  });

  it("blocks private-network targets in production mode", async () => {
    const { accountId, admin } = await createAccount();
    const ep = await addEndpoint(accountId, "/ssrf", ["account.updated"]);
    await renameAccount(admin, accountId, "SSRF");
    await dispatchWebhooks({ store: pgDeliveryStore, encryptionKey: KEY });
    expect(received).toHaveLength(0);
    expect((await deliveriesFor(ep.id))[0].last_error).toMatch(/blocked destination/);
  });
});

describe("webhook management", () => {
  it("lets admins redeliver; managers cannot see or redeliver", async () => {
    const { accountId, admin } = await createAccount();
    const manager = await addMember(accountId, "manager");
    const ep = await addEndpoint(accountId, "/redeliver", ["account.updated"]);
    await renameAccount(admin, accountId, "Redeliver");
    await dispatch();
    const [original] = await deliveriesFor(ep.id);

    await expect(asUser(manager, (db) => db.query("select public.redeliver_webhook($1)", [original.id]))).rejects.toThrow(/forbidden/);
    const visible = await asUser(manager, (db) => db.query("select count(*)::int as n from public.webhook_deliveries where account_id = $1", [accountId]));
    expect(visible.rows[0].n).toBe(0);

    await asUser(admin, (db) => db.query("select public.redeliver_webhook($1)", [original.id]));
    received = [];
    await dispatch();
    expect(received).toHaveLength(1);
    const [{ event_id }] = await query<{ event_id: string }>("select event_id from public.webhook_deliveries where id = $1", [original.id]);
    expect(JSON.parse(received[0].body).id).toBe(event_id);
    const all = await deliveriesFor(ep.id);
    expect(all).toHaveLength(2);
  });

  it("never returns the encrypted secret to clients", async () => {
    const { accountId, admin } = await createAccount();
    await addEndpoint(accountId, "/secret");
    await expect(asUser(admin, (db) => db.query("select secret_ciphertext from public.webhook_endpoints"))).rejects.toThrow(/permission denied/);
    const { rows } = await asUser(admin, (db) => db.query("select id, secret_last4 from public.webhook_endpoints where account_id = $1", [accountId]));
    expect(rows).toHaveLength(1);
  });
});
