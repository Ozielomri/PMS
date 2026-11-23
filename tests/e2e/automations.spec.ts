import { expect, test } from "@playwright/test";

// Step 7: the automations screens need a session; the worker needs the cron secret.

test.describe("automations (step 7) without a session", () => {
  for (const path of ["/automations", "/automations/new", "/automations/log", "/automations/00000000-0000-0000-0000-000000000000"]) {
    test(`${path} redirects to sign-in`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?next=/);
      expect(new URL(page.url()).searchParams.get("next")).toBe(path);
    });
  }

  test("the automations worker rejects calls without the cron secret", async ({ request }) => {
    expect((await request.post("/api/internal/automations/run")).status()).toBe(401);
    expect((await request.get("/api/internal/automations/run", { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);
  });
});
