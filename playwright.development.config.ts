import { defineConfig, devices } from "@playwright/test";

import { readAccessHeaders } from "./scripts/verify/access";

// With a Cloudflare Access token configured, traces would record its headers and
// be uploaded as a CI artifact of a public repository, so tracing is turned off.
// The token itself is attached per origin in apps/web/deployed-e2e/fixtures.ts.
const accessTokenConfigured = readAccessHeaders(process.env) !== undefined;

export default defineConfig({
  testDir: "./apps/web/deployed-e2e",
  outputDir: "./test-results/playwright-development",
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  timeout: 20 * 60 * 1_000,
  reporter: [
    ["github"],
    ["html", { outputFolder: "playwright-report-development", open: "never" }],
  ],
  use: {
    baseURL: process.env.DEV_BASE_URL ?? "https://oss-knowledge-base-dev.pages.dev",
    trace: accessTokenConfigured ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "development-chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
