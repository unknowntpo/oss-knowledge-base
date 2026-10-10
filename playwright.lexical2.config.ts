// Spec 016: the local E2E against a bucket whose current Search release is `bm25-reference@2`
// (seeded by apps/web/scripts/prepare-e2e-r2.ts). The default config keeps serving `@1`.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e-lexical2",
  outputDir: "./test-results/playwright-lexical2",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8789",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun run e2e:server:lexical2",
    url: "http://127.0.0.1:8789/api/feed",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } }],
});
