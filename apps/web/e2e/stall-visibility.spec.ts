import { expect, test, type Page } from "@playwright/test";

import { testPlanRows } from "../test/freshness.cases";

// Spec 011: a stalled publication is visible on narrow screens on every view.
// The E2E Feed fixture was generated at this time (packages/reference-pipeline/test/fixtures).
const generatedAt = Date.parse("2026-08-25T12:00:00Z");
const hour = 60 * 60_000;
// Expected texts come from Spec 010's case file so the plans cannot disagree.
const staleRow = testPlanRows.find((row) => row.id === "F2" && row.stale === true)!;
const boundaryRow = testPlanRows.find((row) => row.id === "F2" && row.stale === false)!;
const staleText = { en: staleRow.en, "zh-Hant": staleRow.zh } as const;

type Locale = keyof typeof staleText;
type View = "feed" | "feed detail" | "search detail";

test.beforeEach(({}, testInfo) => {
  // Widths are set per test; one project is enough.
  test.skip(testInfo.project.name !== "mobile-chromium", "viewport widths are set explicitly");
});

async function prepare(page: Page, locale: Locale, width: number, time: number, frozen = false): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), locale);
  await page.setViewportSize({ width, height: 800 });
  // A boundary check freezes the clock; otherwise time runs from `time` so the minute timer fires.
  if (frozen) await page.clock.setFixedTime(time);
  else await page.clock.install({ time });
}

async function open(page: Page, view: View): Promise<void> {
  await page.goto("/#/kafka/threads");
  await expect(page.locator(".card")).toHaveCount(2);
  if (view === "feed detail") {
    await page.locator(".card").first().click();
    await expect(page).toHaveURL(/#\/feed\//u);
  }
  if (view === "search detail") {
    await page.locator("#q").fill("KIP-405");
    await page.locator(".search-card").first().click();
    await expect(page).toHaveURL(/#\/search\/sdr1\./u);
  }
}

async function expectStalePillInside(page: Page, locale: Locale, width: number): Promise<void> {
  const pill = page.locator(".demo-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText(staleText[locale]);
  await expect(pill).toHaveClass(/is-stale/u);
  const box = (await pill.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  const topbar = await page.locator(".topbar").evaluate((element) => [element.scrollWidth, element.clientWidth]);
  expect(topbar[0]).toBeLessThanOrEqual(topbar[1]!);
  // The full text must be readable: not overflowing the pill, not running under the locale select.
  const text = await pill.evaluate((element) => [element.scrollWidth, element.clientWidth]);
  expect(text[0]).toBeLessThanOrEqual(text[1]!);
  const select = (await page.locator(".locale-control").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(select.x);
  // Not drawn over the brand mark, and not clipped vertically (former gardening G2/G12).
  const mark = (await page.locator(".brand-mark").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(mark.x + mark.width);
  const height = await pill.evaluate((element) => [element.scrollHeight, element.clientHeight]);
  expect(height[0]).toBeLessThanOrEqual(height[1]!);
}

for (const width of [320, 375, 420]) {
  for (const locale of ["en", "zh-Hant"] as const) {
    test(`V1: stale pill at ${width} px, ${locale}, on every view`, async ({ page }) => {
      await prepare(page, locale, width, generatedAt + 3 * hour + 1_000);
      for (const view of ["feed", "feed detail", "search detail"] as const) {
        await test.step(view, async () => {
          await open(page, view);
          await expectStalePillInside(page, locale, width);
        });
      }
    });
  }
}

test("V2: at exactly three hours the narrow pill stays hidden", async ({ page }) => {
  // Control: above 420 px the same page shows the pill, so "hidden" is not "never rendered".
  await prepare(page, "en", 421, generatedAt + 3 * hour, true);
  await open(page, "feed");
  await expect(page.locator(".demo-pill")).toBeVisible();
  await expect(page.locator(".demo-pill")).toHaveText(boundaryRow.en);
  for (const width of [375, 420]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator(".demo-pill")).toBeHidden();
  }
});

test("V3: an open narrow page shows the stall without a reload", async ({ page }) => {
  await prepare(page, "en", 375, generatedAt + 3 * hour - 30_000);
  await open(page, "feed");
  await expect(page.locator(".demo-pill")).toBeHidden();
  await page.clock.runFor(60_000);
  await expectStalePillInside(page, "en", 375);
});

test("V4: an unparsable generatedAt shows no stall on a narrow screen", async ({ page }) => {
  // Control: the same width and path show the pill for a stale generatedAt.
  await prepare(page, "en", 375, generatedAt + 3 * hour + 1_000);
  await open(page, "feed");
  await expectStalePillInside(page, "en", 375);

  await page.route("**/api/feed", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.metadata.manifest.generatedAt = "not-a-time";
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(page.locator(".card")).toHaveCount(2);
  await expect(page.locator(".demo-pill")).toBeHidden();
});

test("V6: a cached feed (metadata.stale) shows the stale pill on a narrow screen", async ({ page }) => {
  // Fresh generatedAt, so only metadata.stale can make the pill stale.
  await prepare(page, "en", 375, generatedAt + 2 * hour);
  // Control: without metadata.stale the same page hides the pill.
  await open(page, "feed");
  await expect(page.locator(".demo-pill")).toBeHidden();

  await page.route("**/api/feed", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.metadata.stale = true;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(page.locator(".card")).toHaveCount(2);
  await expect(page.locator(".demo-pill")).toBeVisible();
  await expect(page.locator(".demo-pill")).toHaveClass(/is-stale/u);
});
