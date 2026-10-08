import { expect, test, type Page } from "@playwright/test";

// Spec 014 slice 3 in the browser, against the digest fixtures seeded by `bun run e2e:prepare`
// (apps/web/test/fixtures/digest, generated 2026-10-07T01:37:00Z).
const generatedAt = Date.parse("2026-10-07T01:37:00.000Z");

async function open(page: Page, hash: string, locale = "en") {
  await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), locale);
  await page.clock.install({ time: generatedAt + 2 * 3_600_000 });
  await page.goto(`/#${hash}`);
}

async function noHorizontalOverflow(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(width);
  const topbar = await page.locator(".topbar").evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(topbar).toBe(true);
}

test("D12: This week shows the digest: headline, stats, proposals with badges, topic cards, closed routine", async ({ page }) => {
  await open(page, "/kafka/");
  await expect(page.locator("#digest")).toBeVisible();
  await expect(page.locator(".digest-headline")).toContainText("RC4");
  await expect(page.locator(".digest-freshness")).toHaveText("Digest updated 2 h ago");
  await expect(page.locator(".digest-kips .kip-row[data-stage]").first()).toBeVisible();
  await expect(page.locator('.kip-row:has(.kip-key:text("KIP-1349")) .stage-badge')).toHaveText(["Vote", "Discuss"]);
  await expect(page.locator(".topic-card").first()).toBeVisible();
  await expect(page.locator(".topic-card a.cite").first()).toHaveAttribute("href", /^(#\/feed\/|https:\/\/)/u);
  await expect(page.locator("details.digest-routine")).not.toHaveAttribute("open", /.*/u);
  await expect(page.locator(".ai-label")).toContainText("AI summary · unreviewed");
  await noHorizontalOverflow(page);
});

test("D62: routes carry the project; / opens the last project; DataFusion has no digest; Detail keeps its URL", async ({ page }) => {
  await open(page, "/");
  await expect(page).toHaveURL(/#\/kafka\/$/u);
  await page.locator(".community-switcher").selectOption("datafusion");
  await expect(page).toHaveURL(/#\/datafusion\/$/u);
  await expect(page.locator(".no-digest-notice")).toContainText("No weekly digest for this community yet");
  await expect(page.locator(".no-digest-notice a")).toHaveAttribute("href", "#/datafusion/threads");
  await expect(page.locator(".top-tab", { hasText: "Proposals" })).toHaveCount(0);
  await page.goto("/#/");
  await expect(page).toHaveURL(/#\/datafusion\/$/u);
  await page.goto("/#/kafka/threads");
  await expect(page.locator(".card")).toHaveCount(2);
  await page.locator(".card").first().click();
  await expect(page).toHaveURL(/#\/feed\//u);
});

test("D43: every view, including a topic page, has the top bar; filters match their lists", async ({ page }) => {
  await open(page, "/kafka/");
  await page.locator(".topic-card-title a").first().click();
  await expect(page.locator("#view-topic-page")).toBeVisible();
  for (const selector of [".community-switcher", ".top-tabs", ".locale-control", "#topbar-q"]) await expect(page.locator(selector)).toBeVisible();
  const all = await page.locator(".thread-card").count();
  await expect(page.locator('.thread-filter[data-filter="all"]')).toContainText(String(all));
  const pr = page.locator('.thread-filter[data-filter="pr"]');
  const prCount = Number((await pr.innerText()).replace(/\D+/gu, ""));
  await pr.click();
  await expect(page.locator(".thread-card")).toHaveCount(prCount);
  // Counts come from the whole card, not the filtered list: All still shows every thread.
  await expect(page.locator('.thread-filter[data-filter="all"]')).toContainText(String(all));
  await expect(pr).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".thread-card .thread-title").first()).toHaveAttribute("href", /^https:\/\/github\.com\//u);
  await noHorizontalOverflow(page);
});

test("D45: switching locale in the top bar loads the zh-Hant digest and chrome", async ({ page }) => {
  await open(page, "/kafka/");
  await expect(page.locator(".top-tab").first()).toHaveText("This week");
  const zhResponse = page.waitForResponse((response) => response.url().includes("/api/digest") && response.url().includes("locale=zh-Hant"));
  await page.locator(".locale-control select").selectOption("zh-Hant");
  expect((await zhResponse).status()).toBe(200);
  await expect(page.locator(".top-tab").first()).toHaveText("本週");
  await expect(page.locator(".digest-headline")).toContainText("推出 RC4");
  await expect(page.locator(".digest-window-range")).toContainText("過去 7 天");
  await expect(page.locator(".ai-label")).toContainText("翻譯");
});

test("D23: a failing /api/digest shows a notice and a link, and All threads still works", async ({ page }) => {
  await page.route("**/api/digest*", (route) => route.fulfill({ status: 503, json: { error: "down" } }));
  await open(page, "/kafka/");
  await expect(page.locator(".digest-unavailable")).toContainText("unavailable");
  await expect(page.locator(".card")).toHaveCount(0);
  await page.locator(".digest-unavailable a").click();
  await expect(page.locator(".card")).toHaveCount(2);
});

test("D53: an unknown project or topic shows a not-found state with the top bar", async ({ page }) => {
  await open(page, "/nope/");
  await expect(page.locator(".not-found")).toBeVisible();
  await expect(page.locator(".top-tabs")).toBeVisible();
  await page.goto("/#/kafka/topic/no-such-topic");
  await expect(page.locator(".not-found")).toBeVisible();
});

test("D58: /api/digest falls back and rejects bad parameters", async ({ request }) => {
  const zh = await request.get("/api/digest?projectId=apache-kafka&locale=zh-Hant");
  expect(zh.status()).toBe(200);
  expect(await zh.json()).toMatchObject({ locale: "zh-Hant", localeFallback: false });
  expect((await request.get("/api/digest?projectId=apache-kafka&locale=fr")).status()).toBe(400);
  expect((await request.get("/api/digest?projectId=apache-nope")).status()).toBe(400);
  expect((await request.get("/api/digest?projectId=apache-datafusion")).status()).toBe(404);
});

test("D62: the top-bar search hands its query to All threads", async ({ page }) => {
  await open(page, "/kafka/");
  const search = page.waitForResponse((response) => response.url().includes("/api/search?") && response.url().includes("KIP-405"));
  await page.locator("#topbar-q").fill("KIP-405");
  await page.locator("#topbar-q").press("Enter");
  await expect(page).toHaveURL(/#\/kafka\/threads$/u);
  expect((await search).status()).toBe(200);
  await expect(page.locator("#q")).toHaveValue("KIP-405");
  await expect(page.locator(".search-card").first()).toBeVisible();
});

