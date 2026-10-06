import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

// Smoke run of the verification CLI (docs/process/workflow.md, "Verification kit")
// against this run's fixture server, so the kit cannot rot unnoticed.
test("verify:ui captures the stale pill on Feed and Search detail at 375 px", ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the CLI sets its own viewport");
  const out = testInfo.outputPath("verify-ui");
  const repoRoot = resolve(testInfo.project.testDir, "../../..");
  execFileSync(
    "bun",
    ["scripts/verify/ui.ts", "--target", "local", "--view", "feed,search-detail", "--width", "375",
      "--locale", "en", "--at", "+3h1s", "--out", out],
    { cwd: repoRoot, stdio: "pipe", timeout: 90_000 },
  );
  const summary = JSON.parse(readFileSync(resolve(out, "summary.json"), "utf8"));
  expect(summary.clock).toBe("2026-08-25T15:00:01.000Z");
  expect(summary.captures.map((capture: { view: string }) => capture.view)).toEqual(["feed", "search-detail"]);
  for (const capture of summary.captures) {
    expect(existsSync(capture.screenshot)).toBe(true);
    const pill = capture.elements.find((element: { selector: string }) => element.selector === ".demo-pill");
    expect(pill).toMatchObject({ count: 1, visible: true, className: "demo-pill is-stale" });
  }
});
