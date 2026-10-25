import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

// Spec 030 in the browser. The E2E server runs with `PROJECT_TREND` unset (the local wrangler.jsonc
// keeps it off; only Dev sets it), so PT3 reads the real Pages Functions; PT4, PT6 and PT10 turn the card
// on in the page by adding the digest answer's trend header and answering `/api/activity` with a
// constructed `osskb.project-activity.v1` body (the Function itself is covered in
// test/project-trend.test.ts). Set TREND_SCREENSHOT_DIR to keep screenshots.

const now = Date.parse("2026-10-24T05:00:00.000Z");
const months = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
const reviews = [1390, 1270, 1480, 1350, 1520, 1440, 1490, 1310, 1380, 1460, 1420, 1080];
const LOG_FROM = "2026-09-10T02:45:16.847Z";
const recorded = (source: string, from: string) => ({ source, status: "recorded", from, until: "2026-10-24T02:45:16.847Z", storedFrom: from });
/** Constructed: review volumes near Spec 022's measured 1,425 a month, the activity log from Dev's 9/10. */
const body = {
  schema: "osskb.project-activity.v1",
  projectId: "apache-kafka",
  until: "2026-10-24T02:45:16.847Z",
  months: months.map((month, index) => ({
    month,
    reviews: reviews[index],
    github: index === 10 ? 820 : index === 11 ? 1010 : null,
    jira: index === 10 ? 310 : index === 11 ? 380 : null,
    mail: index === 10 ? 160 : index === 11 ? 190 : null,
  })),
  coverage: [recorded("github-reviews", "2025-11-01T00:00:00.000Z"), recorded("github", LOG_FROM), recorded("jira", LOG_FROM), recorded("mail", LOG_FROM)],
  unavailableMonths: [],
};

async function open(page: Page, options: { trend: boolean; activity?: "ok" | "fail"; locale?: string }) {
  const requests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/activity") requests.push(request.url()); });
  await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), options.locale ?? "zh-Hant");
  await page.clock.install({ time: now });
  if (options.trend) {
    await page.route("**/api/digest*", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "x-project-trend": "on" } });
    });
    await page.route("**/api/activity*", (route) => (options.activity === "fail"
      ? route.fulfill({ status: 503, json: { error: "down" } })
      : route.fulfill({ status: 200, json: body })));
  }
  await page.goto("/kafka/");
  await expect(page.locator(".digest-headline")).toBeVisible();
  return requests;
}

async function noHorizontalOverflow(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(width);
}

/** The whole page, or with `card` the viewport around the trend card. */
async function screenshot(page: Page, name: string, card = false) {
  const directory = process.env.TREND_SCREENSHOT_DIR;
  if (directory === undefined || directory === "") return;
  await mkdir(directory, { recursive: true });
  if (card) await page.locator(".project-trend").evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: `${directory}/${name}-${test.info().project.name}.png`, fullPage: !card });
}

test("PT3: with PROJECT_TREND unset This week renders as before: no card, no request to /api/activity, and the endpoint is a 404", async ({ page, request }) => {
  const requests = await open(page, { trend: false });
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".digest-stats")).toBeVisible();
  await expect(page.locator(".project-trend")).toHaveCount(0);
  expect(requests).toEqual([]);
  const digest = await request.get("/api/digest?projectId=apache-kafka&locale=en");
  expect(digest.headers()["x-project-trend"]).toBeUndefined();
  const activity = await request.get("/api/activity?projectId=apache-kafka");
  expect(activity.status()).toBe(404);
  expect(activity.headers()["x-robots-tag"]).toBe("noindex");
});

test("PT4: with the trend on, This week shows the stats, the trend card, then the highlights, without sideways scroll", async ({ page }) => {
  await open(page, { trend: true });
  await expect(page.locator(".project-trend [data-trend-bucket]")).toHaveCount(12);
  const tops = await Promise.all([".digest-stats", ".project-trend", ".digest-highlights"].map((selector) => page.locator(selector).first().evaluate((element) => element.getBoundingClientRect().top)));
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  await expect(page.locator(".project-trend [data-in-progress]")).toContainText("進行中 · 至 10/24");
  await noHorizontalOverflow(page);
  await screenshot(page, "compact");
});

for (const scheme of ["light", "dark"] as const) {
  for (const [locale, first, last] of [["zh-Hant", "2025/11", "2026/10 · 進行中 · 至 10/24"], ["en", "Nov 2025", "Oct 2026 · in progress · to 10/24"]] as const) {
    test(`PT17: at 375 px (${scheme}, ${locale}) the end labels carry the year and the 2026 marker sits at January without overlap`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, { trend: true, locale });
      await expect(page.locator(".project-trend [data-trend-label]")).toHaveText([first, last]);
      await expect(page.locator(".project-trend [data-trend-year]")).toHaveText(["2026"]);
      const boxes = await page.locator(".project-trend [data-trend-label], .project-trend [data-trend-year] text").evaluateAll((elements) =>
        elements.map((element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; }));
      const svg = await page.locator(".project-trend-svg").evaluate((element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right }; });
      expect(boxes).toHaveLength(3);
      for (const [index, box] of boxes.entries()) {
        expect(box.left).toBeGreaterThanOrEqual(svg.left - 0.5);
        expect(box.right).toBeLessThanOrEqual(svg.right + 0.5);
        for (const other of boxes.slice(index + 1)) {
          const apart = box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top;
          expect(apart).toBe(true);
        }
      }
      await noHorizontalOverflow(page);
      await screenshot(page, `axis-375-${scheme}-${locale}`, true);
    });
  }
}

test("PT6: pressing 「查看完整趨勢」 shows the full chart in place and sends no second request; collapsing returns to the card", async ({ page }) => {
  const requests = await open(page, { trend: true });
  await expect(page.locator(".project-trend [data-trend-bucket]")).toHaveCount(12);
  await page.getByRole("button", { name: "查看完整趨勢" }).click();
  await expect(page.locator(".project-trend .person-chart-svg[role=img]")).toBeVisible();
  await expect(page.locator(".project-trend [data-legend]")).toHaveText(["GitHub 審查", "GitHub PR 與留言", "Jira issue 與留言", "dev@ 郵件", "尚未記錄"]);
  await expect(page.locator(".project-trend [data-marker]")).toHaveText("PR 與留言自此記錄");
  await expect(page.locator(".project-trend [data-range] summary")).toHaveText("資料範圍：GitHub 審查 11/1 起 · GitHub 留言與 PR、Jira、dev@ 9/10 起");
  // PT7 in the browser: the September column's tooltip names the partial start.
  // A press shows the tooltip on touch screens too (the chart listens to pointerdown).
  await page.locator(".project-trend .person-chart-hit").nth(10).dispatchEvent("pointerdown");
  await expect(page.locator(".project-trend [data-tip]")).toContainText("GitHub PR 與留言自 9/10 起記錄");
  await noHorizontalOverflow(page);
  await screenshot(page, "expanded");
  await page.getByRole("button", { name: "以表格檢視" }).click();
  await expect(page.locator(".project-trend [data-chart-table] tbody tr")).toHaveCount(12);
  await page.getByRole("button", { name: "收合" }).click();
  await expect(page.locator(".project-trend [data-trend-bucket]")).toHaveCount(12);
  await page.waitForLoadState("networkidle");
  expect(requests).toHaveLength(1);
});

test("PT10: a failing /api/activity leaves the digest as it is and one line on the card, with no retry", async ({ page }) => {
  const requests = await open(page, { trend: true, activity: "fail" });
  await expect(page.locator(".project-trend")).toHaveText("活動趨勢暫時無法取得");
  await expect(page.locator(".digest-highlights")).toBeVisible();
  await expect(page.locator(".topic-card").first()).toBeVisible();
  await page.clock.runFor(120_000);
  await page.waitForLoadState("networkidle");
  expect(requests).toHaveLength(1);
});
