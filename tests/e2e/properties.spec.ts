import { expect, test } from "@playwright/test";

/** Public behaviour of the Properties routes (no Supabase stack needed). */
test.describe("properties routes", () => {
  for (const path of ["/properties", "/properties/new", "/properties/custom-fields", "/properties/00000000-0000-0000-0000-000000000000?tab=photos"]) {
    test(`signed-out visit to ${path} redirects to sign-in`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?next=/);
      expect(new URL(page.url()).searchParams.get("next")).toBe(path);
    });
  }

  test("the CSV export never answers signed-out requests with data", async ({ request }) => {
    const res = await request.get("/properties/export", { maxRedirects: 0 });
    expect(res.status()).not.toBe(200);
    expect(res.headers()["content-type"] ?? "").not.toContain("text/csv");
  });
});
