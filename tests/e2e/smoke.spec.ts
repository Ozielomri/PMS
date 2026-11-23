import { expect, test } from "@playwright/test";

test.describe("public pages and the auth gate", () => {
  test("sign-in page offers password and magic link", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();

    await page.getByRole("tab", { name: "Email link" }).click();
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
    await expect(page.getByLabel("Password")).toHaveCount(0);
  });

  test("sign-up page asks for name, email and a 12+ character password", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
    await expect(page.getByLabel("Password")).toHaveAttribute("minlength", "12");
  });

  for (const path of ["/dashboard", "/settings/members", "/settings/webhooks", "/settings/audit", "/mfa", "/onboarding"]) {
    test(`signed-out visit to ${path} redirects to sign-in`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?next=/);
      const next = new URL(page.url()).searchParams.get("next");
      expect(next).toBe(path);
    });
  }

  test("keeps next= through to the sign-up link", async ({ page }) => {
    await page.goto("/login?next=%2Fsettings%2Fmembers");
    await expect(page.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/signup?next=%2Fsettings%2Fmembers");
  });

  test("sends security headers", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("internal worker endpoints reject requests without the cron secret", async ({ request }) => {
    for (const path of ["/api/internal/webhooks/dispatch", "/api/internal/events/process"]) {
      const res = await request.post(path);
      expect(res.status()).toBe(401);
    }
  });

  test("the iCal sync worker rejects requests without the cron secret", async ({ request }) => {
    expect((await request.post("/api/internal/ical/sync")).status()).toBe(401);
    expect((await request.get("/api/internal/ical/sync", { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);
  });

  test("iCal export URLs are public routes that never redirect to sign-in", async ({ request }) => {
    const bad = await request.get("/ical/not-a-token.ics", { maxRedirects: 0 });
    expect(bad.status()).toBe(404);
    expect(bad.headers()["x-robots-tag"]).toContain("noindex");
    // A well-formed but unknown token reaches the database lookup (unreachable in this smoke
    // setup, so 503); either way it is answered by the route, not by the sign-in gate.
    const unknown = await request.get(`/ical/pmsical_${"a".repeat(43)}.ics`, { maxRedirects: 0 });
    expect([404, 503]).toContain(unknown.status());
    expect(unknown.headers()["cache-control"]).toContain("private");
  });

  test("the listing iCal tab needs sign-in", async ({ page }) => {
    await page.goto("/properties/00000000-0000-4000-8000-000000000000?tab=ical");
    await expect(page).toHaveURL(/\/login\?next=/);
  });

  test("bad email links land on sign-in with an error", async ({ page }) => {
    await page.goto("/auth/confirm?token_hash=bogus&type=magiclink&next=/dashboard");
    await expect(page).toHaveURL(/\/login\?error=link/);
    await expect(page.getByText("That link is invalid or has expired")).toBeVisible();
  });

  test("an email link sent to the home page is handed to the confirm route", async ({ request }) => {
    const res = await request.get("/?code=bogus", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(new URL(res.headers().location, "http://x").pathname + new URL(res.headers().location, "http://x").search).toBe("/auth/confirm?code=bogus");
  });

  test("the home page is the public marketing site", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("One calendar");
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute("href", "/login");
    await expect(page.getByRole("link", { name: "Start free" }).first()).toHaveAttribute("href", "/signup");
    for (const id of ["features", "ai", "pricing", "faq"]) await expect(page.locator(`#${id}`)).toBeAttached();
  });
});
