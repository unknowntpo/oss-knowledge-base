// Header-scoping harness for the Cloudflare Access token (apps/web/access-e2e).
// Runs offline against a local proxy; uses a dummy token, overriding the environment.
import { defineConfig, devices } from "@playwright/test";

import { useDummyToken } from "./apps/web/access-e2e/dummy-token";

useDummyToken();

export default defineConfig({
  testDir: "./apps/web/access-e2e",
  testMatch: "scoping.spec.ts",
  outputDir: "./test-results/playwright-access",
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  reporter: [["list"]],
  use: { trace: "off" },
  projects: [{ name: "access-chromium", use: { ...devices["Desktop Chrome"] } }],
});
