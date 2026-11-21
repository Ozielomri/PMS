import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { totp } from "./totp";

/**
 * Full X-01/X-02 journey against a real Supabase stack. Requires:
 *   supabase start   (Docker; email confirmations off in supabase/config.toml)
 *   E2E_SUPABASE=1 NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... npm run test:e2e
 */
test.skip(process.env.E2E_SUPABASE !== "1", "needs a running Supabase stack (E2E_SUPABASE=1)");

const password = "correct horse battery staple 42";

test("admin signs up, enrols TOTP, invites a cleaner who joins with limited access", async ({ page, browser }) => {
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const cleanerEmail = `cleaner-${randomUUID().slice(0, 8)}@example.test`;

  // Sign up → onboarding
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Ada Admin");
  await page.getByLabel("Work email").fill(adminEmail);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding/);

  // Create the company → forced to MFA enrolment (X-02)
  await page.getByLabel("Company name").fill("E2E Rentals");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/mfa/);
  await expect(page.getByText("Admins must use two-factor authentication")).toBeVisible();

  // Trying to skip MFA bounces back
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/mfa/);

  await page.getByText("Can’t scan? Enter this key instead").click();
  const secret = (await page.locator("details code").innerText()).trim();
  await page.getByLabel("Code").fill(totp(secret));
  await page.getByRole("button", { name: "Turn on two-factor" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: "E2E Rentals" })).toBeVisible();

  // Invite a cleaner
  await page.getByRole("link", { name: "Team" }).click();
  await page.getByLabel("Email").fill(cleanerEmail);
  await page.getByLabel("Role").selectOption("cleaner");
  await page.getByRole("button", { name: "Create invite" }).click();
  const inviteUrl = (await page.locator("code", { hasText: "/invite/" }).innerText()).trim();

  // Audit log shows the invitation, without the token
  await page.getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByText("invitations/").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(new URL(inviteUrl).pathname.split("/").pop()!);

  // Cleaner accepts in a separate browser context
  const cleanerContext = await browser.newContext();
  const cleaner = await cleanerContext.newPage();
  await cleaner.goto(inviteUrl);
  await expect(cleaner.getByText("Join E2E Rentals as Cleaner / field staff")).toBeVisible();
  await cleaner.getByRole("link", { name: "Create account" }).click();
  await cleaner.getByLabel("Full name").fill("Cleo Cleaner");
  await cleaner.getByLabel("Work email").fill(cleanerEmail);
  await cleaner.getByLabel("Password").fill(password);
  await cleaner.getByRole("button", { name: "Create account" }).click();
  await expect(cleaner).toHaveURL(/\/invite\//);
  await cleaner.getByRole("button", { name: "Accept invitation" }).click();
  await expect(cleaner).toHaveURL(/\/dashboard/);
  await expect(cleaner.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText(["Dashboard"]);

  // Admin-only pages are refused
  await cleaner.goto("/settings/members");
  await expect(cleaner).toHaveURL(/\/dashboard\?denied=1/);
  await cleanerContext.close();
});
