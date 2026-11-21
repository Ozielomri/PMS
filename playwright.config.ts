import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const fullStack = process.env.E2E_SUPABASE === "1";

/**
 * Smoke tests run against `next start` with placeholder Supabase settings (no network needed).
 * With E2E_SUPABASE=1 the full auth flow runs against a real stack (`supabase start`), using the
 * NEXT_PUBLIC_SUPABASE_* values from your environment.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Point at a preinstalled Chromium when it does not match this Playwright version.
        launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
      },
    },
  ],
  webServer: {
    command: `npx next build && npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: fullStack
      ? { NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${PORT}` }
      : {
          NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:59999",
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_e2e_placeholder",
          NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${PORT}`,
          NEXT_TELEMETRY_DISABLED: "1",
        },
  },
});
