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

  for (const path of ["/", "/dashboard", "/settings/members", "/settings/webhooks", "/settings/audit", "/mfa", "/onboarding"]) {
    test(`signed-out visit to ${path} redirects to sign-in`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?next=/);
      const next = new URL(page.url()).searchParams.get("next");
      expect(next).toBe(path === "/" ? "/dashboard" : path);
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

  test("bad email links land on sign-in with an error", async ({ page }) => {
    await page.goto("/auth/confirm?token_hash=bogus&type=magiclink&next=/dashboard");
    await expect(page).toHaveURL(/\/login\?error=link/);
    await expect(page.getByText("That link is invalid or has expired")).toBeVisible();
  });
});
