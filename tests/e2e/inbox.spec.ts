import { createHmac } from "node:crypto";

import { expect, test } from "@playwright/test";

test.describe("inbox (step 6) without a session", () => {
  for (const path of ["/inbox", "/inbox?tab=mine", "/inbox/saved-replies", "/inbox/log"]) {
    test(`signed-out visit to ${path} redirects to sign-in`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?next=/);
      expect(new URL(page.url()).searchParams.get("next")).toBe(path);
    });
  }

  test("the outbound worker rejects requests without the cron secret", async ({ request }) => {
    expect((await request.post("/api/internal/inbox/send")).status()).toBe(401);
  });

  test("inbound email and delivery webhooks reject unsigned or wrongly signed calls", async ({ request }) => {
    const body = JSON.stringify({ message_id: "x", from: "a@b.co", to: [], text: "hi" });
    const t = Math.floor(Date.now() / 1000);
    const badSignature = `t=${t},v1=${createHmac("sha256", "not-the-secret").update(`${t}.${body}`).digest("hex")}`;
    for (const path of ["/api/internal/inbox/email/inbound", "/api/internal/inbox/email/events"]) {
      expect((await request.post(path, { data: body, headers: { "content-type": "application/json" } })).status()).toBe(401);
      expect((await request.post(path, { data: body, headers: { "content-type": "application/json", authorization: "Bearer guess" } })).status()).toBe(401);
      expect((await request.post(path, { data: body, headers: { "content-type": "application/json", "x-pms-signature": badSignature } })).status()).toBe(401);
    }
  });
});
