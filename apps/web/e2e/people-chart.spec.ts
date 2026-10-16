import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

// Spec 019 amendment (5) in the browser: the chart's tooltip and table (W61), the layout at 320
// and 375 px (W64), and no request beyond the profile (W65). Data: the constructed store that
// `bun run e2e:prepare` seeds (apps/web/scripts/people-e2e-fixture.ts). Set PEOPLE_SCREENSHOT_DIR
// to keep screenshots.

const aliceRoute = `/#/kafka/people/${encodeURIComponent("github:alice")}`;
const danaRoute = `/#/kafka/people/${encodeURIComponent("mail:dana mailer")}`;

async function open(page: Page, hash: string, locale = "en") {
  await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), locale);
  await page.goto(hash);
  await expect(page.locator(".person-chart-svg")).toBeVisible();
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.PEOPLE_SCREENSHOT_DIR;
  if (directory === undefined || directory === "") return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}-${test.info().project.name}.png`, fullPage: true });
}

const columns = (page: Page) => page.locator(".person-tiles").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);

test("W61: a column shows its values on hover; 'Show as table' lists every bucket, 'not recorded yet' for null", async ({ page }) => {
  await open(page, aliceRoute);
  const svg = page.locator(".person-chart-svg");
  await expect(svg).toHaveAttribute("role", "img");
  await expect(svg).toHaveAttribute("aria-label", /^Activity of Alice Example, past 12 months, per month: Reviews given, GitHub PRs and comments stacked above the axis, Reviews received below it\. Busiest /u);
  await expect(page.locator("[data-bucket]")).toHaveCount(12);
  const box = (await page.locator(".person-chart-hit").nth(11).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("[data-tip]")).toContainText("Reviews given");
  await expect(page.locator("[data-tip]")).toContainText("Reviews received");
  await page.getByRole("button", { name: "Show as table" }).click();
  await expect(page.locator("[data-chart-table] tbody tr")).toHaveCount(12);
  await expect(page.locator("[data-chart-table] thead th")).toHaveText(["Month", "Reviews given", "GitHub PRs and comments", "Reviews received"]);
  // The activity log starts 35 days before its first append: older months are not recorded for GitHub activity.
  await expect(page.locator("[data-chart-table] tbody tr").first().locator("td").nth(1)).toHaveText("Not recorded yet");
  await page.getByRole("button", { name: "90 days" }).click();
  await expect(page.locator("[data-chart-table] thead th").first()).toHaveText("Week");
  expect(await page.locator("[data-chart-table] tbody tr").count()).toBeGreaterThanOrEqual(13);
  await page.getByRole("button", { name: "Hide table" }).click();
  await expect(page.locator("[data-chart-table]")).toHaveCount(0);
});

test("W61: a dev@ page's chart is its own series with a 'not recorded yet' band", async ({ page }) => {
  await open(page, danaRoute, "zh-Hant");
  await expect(page.locator("[data-legend]")).toHaveText(["dev@ 郵件", "尚未記錄"]);
  await expect(page.locator("[data-band]")).toHaveCount(1);
  await expect(page.locator("[data-band]")).toContainText("尚未記錄");
  await expect(page.locator(".person-tiles .person-tile")).toHaveCount(3);
});

for (const width of [320, 375]) {
  test(`W64: at ${width} px the chart fits its card, the tiles are in columns, and nothing overflows`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    for (const [route, name, tiles] of [[aliceRoute, "alice", 2], [danaRoute, "dana-mail", width === 375 ? 3 : 2]] as const) {
      await open(page, route, "zh-Hant");
      const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(scroll).toBeLessThanOrEqual(inner);
      const chart = (await page.locator(".person-chart-svg").boundingBox())!;
      const card = (await page.locator('[data-section="over-time"]').boundingBox())!;
      expect(chart.x).toBeGreaterThanOrEqual(card.x);
      expect(chart.x + chart.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
      expect(await columns(page)).toBe(tiles);
      await screenshot(page, `profile-chart-${name}-${width}-zh`);
    }
  });
}

test("W64: the desktop profile, both identities", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, aliceRoute);
  expect(await columns(page)).toBe(4);
  await screenshot(page, "profile-chart-alice-desktop");
  await open(page, danaRoute);
  expect(await columns(page)).toBe(3);
  await screenshot(page, "profile-chart-dana-mail-desktop");
});

test("W65: the profile sends one profile request; switching the period and the table sends none", async ({ page }) => {
  const api: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) api.push(new URL(request.url()).pathname); });
  await open(page, aliceRoute);
  await page.waitForLoadState("networkidle");
  expect(api.filter((path) => path.startsWith("/api/people/kafka/"))).toEqual([`/api/people/kafka/${encodeURIComponent("github:alice")}`]);
  const before = api.length;
  await page.getByRole("button", { name: "90 days" }).click();
  await page.getByRole("button", { name: "Show as table" }).click();
  await page.getByRole("button", { name: "12 months" }).click();
  await page.waitForLoadState("networkidle");
  expect(api.slice(before)).toEqual([]);
});
