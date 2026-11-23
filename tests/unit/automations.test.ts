import { describe, expect, it } from "vitest";

import { describeTiming, joinOffset, payloadFromForm, pickBody, splitOffset, STARTERS } from "@/lib/automations/rules";
import { runAutomations, type AutomationDeps, type ClaimedJob, type Completion } from "@/lib/automations/runner";

const job = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({
  job_id: "j1",
  attempts: 1,
  account_id: "a1",
  rule_id: "r1",
  reservation_id: "res1",
  run_at: "2026-12-01T15:00:00Z",
  action: { kind: "message", recipient: "guest", subject: "Hi {{guest.first_name}}", body: "Welcome {{guest.first_name}}", variants: { es: "Hola {{guest.first_name}}" } },
  override_body: null,
  created_by: "u1",
  guest_language: null,
  ...over,
});

function deps(jobs: ClaimedJob[], vars: Record<string, string> | null = { "guest.first_name": "Ana" }) {
  const completed: [string, Completion][] = [];
  const emails: string[] = [];
  const flushed: string[] = [];
  const d: AutomationDeps = {
    claim: async () => jobs,
    complete: async (j, c) => {
      completed.push([j.job_id, c]);
      return true;
    },
    variables: async () => vars,
    sendEmail: async (to) => {
      emails.push(to);
    },
    draft: async () => "proposal-1",
    flushOutbox: async (id) => {
      flushed.push(id);
    },
  };
  return { d, completed, emails, flushed };
}

describe("automation runner", () => {
  it("renders the guest's language variant and flushes the outbox once per account", async () => {
    const { d, completed, flushed } = deps([job({ guest_language: "es-MX" }), job({ job_id: "j2" })]);
    const s = await runAutomations(d);
    expect(s).toMatchObject({ claimed: 2, sent: 2 });
    expect(completed[0][1]).toEqual({ outcome: "sent", body: "Hola Ana", subject: "Hi Ana" });
    expect(completed[1][1]).toMatchObject({ body: "Welcome Ana" });
    expect(flushed).toEqual(["a1"]);
  });

  it("fails visibly on missing values instead of sending a broken message", async () => {
    const { d, completed } = deps([job()], {});
    const s = await runAutomations(d);
    expect(s.failed).toBe(1);
    expect(completed[0][1]).toEqual({ outcome: "failed", reason: "Missing values for: guest.first_name" });
  });

  it("uses an edited instance, emails fixed addresses, and asks the agent", async () => {
    const { d, completed, emails } = deps([
      job({ override_body: "Custom for {{guest.first_name}}" }),
      job({ job_id: "j2", action: { kind: "message", recipient: "email", email: "owner@example.test", body: "Booked: {{guest.first_name}}" } }),
      job({ job_id: "j3", action: { kind: "agent_draft", instructions: "Offer late check-out" } }),
    ]);
    await runAutomations(d);
    expect(completed[0][1]).toMatchObject({ body: "Custom for Ana" });
    expect(emails).toEqual(["owner@example.test"]);
    expect(completed[2][1]).toMatchObject({ outcome: "sent", proposalId: "proposal-1" });
  });

  it("records errors as failures and counts lost leases", async () => {
    const { d } = deps([job()]);
    d.variables = async () => {
      throw new Error("boom");
    };
    d.complete = async () => false;
    expect(await runAutomations(d)).toMatchObject({ lost: 1, sent: 0, failed: 0 });
  });
});

describe("automation rules", () => {
  it("splits and joins offsets", () => {
    expect(splitOffset(-2880)).toEqual({ amount: 2, unit: "days", direction: "before" });
    expect(splitOffset(90)).toEqual({ amount: 90, unit: "minutes", direction: "after" });
    expect(joinOffset(3, "hours", "before")).toBe(-180);
  });

  it("describes timing in words", () => {
    expect(describeTiming({ trigger: "check_in", offset_minutes: -2880, at_time: "10:00" })).toBe("2 days before check-in at 10:00");
    expect(describeTiming({ trigger: "reservation_confirmed", offset_minutes: 0, at_time: null })).toBe("Immediately when the reservation is confirmed");
    expect(describeTiming({ trigger: "check_out", offset_minutes: 1440, at_time: "11:00" })).toBe("1 day after check-out at 11:00");
  });

  it("picks language variants with base-language fallback", () => {
    const a = { kind: "message" as const, recipient: "guest" as const, body: "Hello", variants: { es: "Hola", "pt-BR": "Olá" } };
    expect(pickBody(a, "es-ES")).toBe("Hola");
    expect(pickBody(a, "pt-BR")).toBe("Olá");
    expect(pickBody(a, "de")).toBe("Hello");
  });

  it("builds a payload from the builder form", () => {
    const { payload } = payloadFromForm({
      name: "Instructions",
      trigger: "check_in",
      offset_amount: "2",
      offset_unit: "days",
      offset_direction: "before",
      at_time: "10:00",
      action_kind: "message",
      recipient: "guest",
      body: "Hi",
      variant_es: "Hola",
      tags: "beach, pool",
      min_nights: "3",
      expire_after_hours: "12",
    });
    expect(payload).toMatchObject({
      offset_minutes: -2880,
      at_time: "10:00",
      conditions: { tags: ["beach", "pool"], min_nights: 3 },
      action: { kind: "message", recipient: "guest", body: "Hi", variants: { es: "Hola" } },
      expire_after_hours: 12,
    });
    // Event triggers only run after the event.
    expect(payloadFromForm({ name: "x", trigger: "reservation_confirmed", offset_amount: "1", offset_unit: "hours", offset_direction: "before", body: "x" }).payload?.offset_minutes).toBe(60);
  });

  it("ships starter rules that only use known variables", () => {
    for (const s of STARTERS) {
      if (s.payload.action.kind !== "message") continue;
      for (const m of s.payload.action.body.matchAll(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g)) {
        expect(["guest.first_name", "listing.title", "listing.address", "listing.check_in_from", "listing.check_out_by", "reservation.check_in", "reservation.check_out", "reservation.code", "account.name"]).toContain(m[1]);
      }
    }
  });
});
