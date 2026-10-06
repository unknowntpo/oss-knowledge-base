import { expect, test } from "@playwright/test";

import { testPlanRows } from "../test/freshness.cases";

// The E2E Feed fixture was generated at this time (packages/reference-pipeline/test/fixtures).
const generatedAt = Date.parse("2026-08-25T12:00:00Z");
const hour = 60 * 60_000;
// Expected texts come from the case file so the E2E and unit plans cannot disagree.
const freshText = testPlanRows.find((row) => row.id === "F1" && row.en === "Updated 2 h ago")!.en;
const staleText = testPlanRows.find((row) => row.id === "F2" && row.stale === true)!.en;

test.beforeEach(async ({ page }, testInfo) => {
  // The topbar pill is hidden below 420 px, so freshness is a desktop concern (Spec 010).
  test.skip(testInfo.project.name.startsWith("mobile"), "the freshness pill is hidden on narrow screens");
  await page.addInitScript(() => window.localStorage.setItem("community-kb-locale", "en"));
});

test("F3: an open page turns stale when the three-hour mark passes", async ({ page }) => {
  await page.clock.install({ time: generatedAt + 3 * hour - 30_000 });
  await page.goto("/");
  const pill = page.locator(".demo-pill");
  await expect(pill).toHaveText(freshText);
  await expect(pill).toHaveClass(/is-live/u);

  await page.clock.runFor(60_000);
  await expect(pill).toHaveText(staleText);
  await expect(pill).toHaveClass(/is-stale/u);
});

test("F4: an unparsable generatedAt hides the age and keeps the Feed", async ({ page }) => {
  // Control: the same page shows an age for a valid generatedAt, so the check below can fail.
  await page.clock.install({ time: generatedAt + 2 * hour });
  await page.goto("/");
  await expect(page.locator(".demo-pill")).toContainText("ago");

  await page.route("**/api/feed", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.metadata.manifest.generatedAt = "not-a-time";
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(page.locator(".card")).toHaveCount(3);
  await expect(page.locator(".demo-pill")).toHaveText("Published snapshot");
});
