// Forces a connection failure on the token-bearing request context (a proxy on a closed
// port) with a dummy token, writing the same evidence CI uploads into $ACCESS_LEAK_OUT.
// Run by scripts/test/access-leak.test.ts, which checks that no output file keeps the token.
// Traces are on here on purpose, to exercise redaction of trace zips.
import { join } from "node:path";

import { defineConfig } from "@playwright/test";

import { useDummyToken } from "./dummy-token";

useDummyToken();
const out = process.env.ACCESS_LEAK_OUT ?? "test-results/access-leak";

export default defineConfig({
  testDir: ".",
  testMatch: "leak.spec.ts",
  outputDir: join(out, "test-results"),
  retries: 0,
  workers: 1,
  timeout: 15_000,
  reporter: [["line"], ["html", { outputFolder: join(out, "report"), open: "never" }]],
  use: {
    baseURL: "https://oss-knowledge-base-dev.pages.dev",
    proxy: { server: "http://127.0.0.1:9" },
    trace: "on",
  },
});
