import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { dummyId, dummySecret } from "../../apps/web/access-e2e/dummy-token";
import { findSecrets } from "../verify/redact-artifacts";

const root = resolve(import.meta.dir, "../..");
const out = mkdtempSync(join(tmpdir(), "access-leak-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

test("a forced connection failure with a dummy token leaves the token in no uploaded file after the CI redaction step", () => {
  const env = { ...process.env, ACCESS_LEAK_OUT: out, CF_ACCESS_CLIENT_ID: dummyId, CF_ACCESS_CLIENT_SECRET: dummySecret };
  const run = spawnSync("bunx", ["playwright", "test", "-c", "apps/web/access-e2e/leak.config.ts"], { cwd: root, env, encoding: "utf8" });
  const console_ = `${run.stdout}${run.stderr}`;
  expect(run.status).toBe(1); // the test fails as intended
  expect(console_).toContain("ECONNREFUSED");
  expect(console_).not.toContain(dummySecret);
  expect(console_).not.toContain(dummyId);

  const dirs = [join(out, "test-results"), join(out, "report")];
  // Positive control: Playwright's own trace still records the headers, so the checker sees real output.
  expect(findSecrets(dirs, [dummyId, dummySecret]).length).toBeGreaterThan(0);

  const redact = spawnSync("bun", ["scripts/verify/redact-artifacts.ts", ...dirs], { cwd: root, env, encoding: "utf8" });
  expect(redact.status).toBe(0);
  expect(`${redact.stdout}${redact.stderr}`).not.toContain(dummySecret);
  expect(findSecrets(dirs, [dummyId, dummySecret])).toEqual([]);
}, 60_000);
