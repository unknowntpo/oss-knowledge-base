import { expect, test, type Page } from "@playwright/test";

import { OVERDUE_AFTER_MS, PUBLICATION_CADENCE_MS, STALE_AFTER_MS } from "../src/freshness";
import { testPlanRows } from "../test/publication-overdue.cases";

// Spec 021: a daily publication that has not arrived shows as overdue before the 27 h stale mark.
// The E2E Feed fixture was generated at this time (packages/reference-pipeline/test/fixtures).
const generatedAt = Date.parse("2026-08-25T12:00:00Z");
// Expected texts come from the case file so the E2E and unit plans cannot disagree.
const freshRow = testPlanRows.find((row) => row.id === "O1" && row.case === "exactly the allowance")!;
const overdueRow = testPlanRows.find((row) => row.id === "O2" && row.case === "one second past the allowance")!;
const overdueText = { en: overdueRow.en, "zh-Hant": overdueRow.zh } as const;

const desktopOnly = () => test.skip(test.info().project.name !== "desktop-chromium", "the pill is hidden while fresh on narrow screens; O9 covers them");

async function openFeed(page: Page, locale: "en" | "zh-Hant" = "en"): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), locale);
  await page.goto("/kafka/threads");
  await expect(page.locator(".card")).toHaveCount(2);
}

/** Counts reads of `/api/feed` from now on. */
function feedReads(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/feed") count += 1;
  });
  return () => count;
}

test("O6: an open page turns overdue 30 min after the next run was due, without a reload", async ({ page }) => {
  desktopOnly();
  await page.clock.install({ time: generatedAt + OVERDUE_AFTER_MS - 30_000 });
  await openFeed(page);
  const pill = page.locator(".demo-pill");
  await expect(pill).toHaveText(freshRow.en);
  await expect(pill).toHaveClass(/is-live/u);

  await page.clock.runFor(60_000);
  await expect(pill).toHaveText(overdueText.en);
  await expect(pill).toHaveClass(/is-overdue/u);
  await expect(pill).not.toHaveClass(/is-live|is-stale/u);
});

test("O7: a page left open over a normal run shows the new release, never the overdue warning", async ({ page }) => {
  desktopOnly();
  await page.clock.install({ time: generatedAt + OVERDUE_AFTER_MS - 30_000 });
  await openFeed(page);
  const pill = page.locator(".demo-pill");
  await expect(pill).toHaveText(freshRow.en);
  // Every class the pill takes from here on.
  await pill.evaluate((element) => {
    const seen: string[] = [];
    (window as unknown as { pillClasses: string[] }).pillClasses = seen;
    new MutationObserver(() => seen.push(element.className)).observe(element, { attributes: true, attributeFilter: ["class"] });
  });
  // The day's run published on time, 24 h after the loaded release.
  await page.route("**/api/feed", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.metadata.manifest.generatedAt = new Date(generatedAt + PUBLICATION_CADENCE_MS).toISOString();
    await route.fulfill({ response, json: body });
  });

  await page.clock.runFor(60_000);
  await expect(pill).toHaveText("Updated 30 min ago");
  await expect(pill).toHaveClass(/is-live/u);
  expect(await page.evaluate(() => (window as unknown as { pillClasses: string[] }).pillClasses)).toEqual([]);
});

test("O8: when the re-read fails the page keeps its Feed and shows the overdue warning", async ({ page }) => {
  desktopOnly();
  await page.clock.install({ time: generatedAt + OVERDUE_AFTER_MS - 30_000 });
  await openFeed(page);
  await page.route("**/api/feed", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));
  const reads = feedReads(page);

  await page.clock.runFor(60_000);
  const pill = page.locator(".demo-pill");
  await expect(pill).toHaveText(overdueText.en);
  await expect(pill).toHaveClass(/is-overdue/u);
  // Control: the failing read did happen, so the Feed below survived a failure, not a skipped read.
  expect(reads()).toBe(1);
  await expect(page.locator(".card")).toHaveCount(2);
});

test("O12: a re-read that answers with an older release keeps the loaded one", async ({ page }) => {
  desktopOnly();
  await page.clock.install({ time: generatedAt + OVERDUE_AFTER_MS - 30_000 });
  await openFeed(page);
  // A cache or replica behind: the release before the loaded one.
  await page.route("**/api/feed", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.metadata.manifest.generatedAt = new Date(generatedAt - PUBLICATION_CADENCE_MS).toISOString();
    await route.fulfill({ response, json: body });
  });
  // Control: the older release is read and answered; adopting it would read "Data may be out of date · 2 d ago".
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/feed");

  await page.clock.runFor(60_000);
  expect((await (await answered).json()).metadata.manifest.generatedAt).toBe(new Date(generatedAt - PUBLICATION_CADENCE_MS).toISOString());
  const pill = page.locator(".demo-pill");
  await expect(pill).toHaveText(overdueText.en);
  await expect(pill).toHaveClass(/is-overdue/u);
});

for (const width of [320, 375]) {
  for (const locale of ["en", "zh-Hant"] as const) {
    test(`O9: overdue pill at ${width} px, ${locale}`, async ({ page }) => {
      test.skip(test.info().project.name !== "mobile-chromium", "viewport widths are set explicitly");
      await page.setViewportSize({ width, height: 800 });
      // Control: at exactly the allowance the narrow pill is hidden, as while fresh.
      await page.clock.setFixedTime(generatedAt + OVERDUE_AFTER_MS);
      await openFeed(page, locale);
      const pill = page.locator(".demo-pill");
      await expect(pill).toBeHidden();

      await page.clock.setFixedTime(generatedAt + OVERDUE_AFTER_MS + 1_000);
      await page.reload();
      await expect(page.locator(".card")).toHaveCount(2);
      await expect(pill).toBeVisible();
      await expect(pill).toHaveText(overdueText[locale]);
      await expect(pill).toHaveClass(/is-overdue/u);
      const box = (await pill.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      const select = (await page.locator(".locale-control").boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(select.x);
      const mark = (await page.locator(".brand-mark").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(mark.x + mark.width);
      const topbar = await page.locator(".topbar").evaluate((element) => [element.scrollWidth, element.clientWidth]);
      expect(topbar[0]).toBeLessThanOrEqual(topbar[1]!);
      const text = await pill.evaluate((element) => [element.scrollWidth, element.clientWidth, element.scrollHeight, element.clientHeight]);
      expect(text[0]).toBeLessThanOrEqual(text[1]!);
      expect(text[2]).toBeLessThanOrEqual(text[3]!);
    });
  }
}

test("O10: an open page re-reads the Feed once per warning, not every minute", async ({ page }) => {
  desktopOnly();
  await page.clock.install({ time: generatedAt + OVERDUE_AFTER_MS - 30_000 });
  await openFeed(page);
  const reads = feedReads(page);
  const pill = page.locator(".demo-pill");

  await page.clock.runFor(60_000);
  await expect(pill).toHaveClass(/is-overdue/u);
  expect(reads()).toBe(1);
  // Ten more minutes of the minute timer while overdue: no further read.
  await page.clock.runFor(10 * 60_000);
  await expect(pill).toHaveClass(/is-overdue/u);
  expect(reads()).toBe(1);
  // Crossing the stale mark is the second and last read.
  await page.clock.runFor(STALE_AFTER_MS - OVERDUE_AFTER_MS);
  await expect(pill).toHaveClass(/is-stale/u);
  expect(reads()).toBe(2);
  await page.clock.runFor(10 * 60_000);
  expect(reads()).toBe(2);
});
