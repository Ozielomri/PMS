import { expect, test } from "@playwright/test";

/** Public behaviour of the reservation and calendar routes (no Supabase stack needed). */
test.describe("reservation and calendar routes", () => {
  for (const path of [
    "/calendar",
    "/calendar/bulk",
    "/calendar/00000000-0000-0000-0000-000000000000",
    "/reservations",
    "/reservations/new",
    "/reservations/quotes",
    "/reservations/quotes/new",
    "/reservations/00000000-0000-0000-0000-000000000000",
    "/reservations/00000000-0000-0000-0000-000000000000/alter",
    "/search",
    "/settings/reservations",
  ]) {
    test(`signed-out visit to ${path} redirects to sign-in`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?next=/);
      expect(new URL(page.url()).searchParams.get("next")).toBe(path);
    });
  }

  test("the reservation export never answers signed-out requests with data", async ({ request }) => {
    const res = await request.get("/reservations/export", { maxRedirects: 0 });
    expect(res.status()).not.toBe(200);
    expect(res.headers()["content-type"] ?? "").not.toContain("text/csv");
  });

  test("quote links are public and say so when the link is wrong", async ({ page }) => {
    await page.goto("/q/not-a-real-token");
    await expect(page).toHaveURL(/\/q\/not-a-real-token$/);
    await expect(page.getByText("Quote not found")).toBeVisible();
  });

  test("the expiry worker refuses calls without the cron secret", async ({ request }) => {
    const res = await request.post("/api/internal/reservations/expire");
    expect(res.status()).toBe(401);
  });
});
