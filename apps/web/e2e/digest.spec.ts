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
  await expect(page.locator(".topic-card a.cite").first()).toHaveAttribute("href", /^(\/feed\/|https:\/\/)/u);
  await expect(page.locator("details.digest-routine")).not.toHaveAttribute("open", /.*/u);
  await expect(page.locator(".ai-label")).toContainText("AI summary · unreviewed");
  await noHorizontalOverflow(page);
});

test("D62: routes carry the project; / opens the last project; DataFusion has no digest; Detail keeps its URL", async ({ page }) => {
  await open(page, "/");
  await expect(page).toHaveURL(/\/kafka\/$/u);
  await page.locator(".community-switcher").selectOption("datafusion");
  await expect(page).toHaveURL(/\/datafusion\/$/u);
  await expect(page.locator(".no-digest-notice")).toContainText("No weekly digest for this community yet");
  await expect(page.locator(".no-digest-notice a")).toHaveAttribute("href", "/datafusion/threads");
  await expect(page.locator(".top-tab", { hasText: "Proposals" })).toHaveCount(0);
  await page.goto("/");
  await expect(page).toHaveURL(/\/datafusion\/$/u);
  await page.goto("/kafka/threads");
  await expect(page.locator(".card")).toHaveCount(2);
  await page.locator(".card").first().click();
  await expect(page).toHaveURL(/\/feed\//u);
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
  await page.goto("/kafka/topic/no-such-topic");
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
  await expect(page).toHaveURL(/\/kafka\/threads$/u);
  expect((await search).status()).toBe(200);
  await expect(page.locator("#q")).toHaveValue("KIP-405");
  await expect(page.locator(".search-card").first()).toBeVisible();
});


// Spec 014 D109–D112: the experimental label (apps/web/src/experimental.ts) in the browser.
const LABEL = { en: "Experimental · Early access", "zh-Hant": "實驗中・搶先體驗" } as const;

test("D109: This week, the Proposals tab and a topic page show the digest's experimental label in en and zh-Hant", async ({ page }) => {
  await open(page, "/kafka/");
  const note = page.getByRole("note", { name: LABEL.en });
  await expect(note).toHaveCount(1);
  await expect(note).toContainText("machine-translated");
  await page.locator(".topic-card-title a").first().click();
  await expect(page.locator("#view-topic-page .experimental-label")).toHaveCount(1);
  await page.goto("/kafka/proposals");
  await expect(page.locator("#view-proposals").getByRole("note", { name: LABEL.en })).toBeVisible();
  await page.locator(".locale-control select").selectOption("zh-Hant");
  await expect(page.locator("#view-proposals").getByRole("note", { name: LABEL["zh-Hant"] })).toBeVisible();
  await page.locator(".top-tab").first().click();
  await expect(page.locator("#digest")).toBeVisible();
  const zh = page.getByRole("note", { name: LABEL["zh-Hant"] });
  await expect(zh).toBeVisible();
  await expect(zh.locator(".experimental-badge")).toHaveText(LABEL["zh-Hant"]);
  await expect(zh).toContainText("中文為機器翻譯");
  await noHorizontalOverflow(page);
});

test("D110: All threads, a thread's detail and a community without a digest show no experimental label", async ({ page }) => {
  await open(page, "/kafka/threads");
  await expect(page.locator(".card").first()).toBeVisible();
  await expect(page.locator(".experimental-label")).toHaveCount(0);
  await page.locator(".card").first().click();
  await expect(page).toHaveURL(/\/feed\//u);
  await expect(page.locator(".experimental-label")).toHaveCount(0);
  await page.goto("/datafusion/");
  await expect(page.locator(".no-digest-notice")).toBeVisible();
  await expect(page.locator(".experimental-label")).toHaveCount(0);
  // Positive control: the digest page of the same session has one.
  await page.goto("/kafka/");
  await expect(page.locator(".experimental-label")).toHaveCount(1);
});

test("D111: the label is a note whose accessible name is the badge text, with the note text readable", async ({ page }) => {
  await open(page, "/kafka/");
  const note = page.locator(".experimental-label");
  await expect(note).toHaveAttribute("role", "note");
  await expect(note).toHaveAccessibleName(LABEL.en);
  await expect(note.locator(".experimental-badge")).toHaveText(LABEL.en);
  await expect(note.locator(".experimental-note")).toBeVisible();
});

test("D112: the badge uses the light tokens, and the dark ones under a dark OS, with a 1px outline on every side", async ({ page }) => {
  const styles = async () => page.locator(".experimental-badge").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      background: style.backgroundColor,
      borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      outline: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
    };
  });
  await open(page, "/kafka/");
  const outline = Array(4).fill("rgb(139, 129, 195)");
  expect(await styles()).toEqual({ color: "rgb(87, 76, 150)", background: "rgba(139, 129, 195, 0.12)", borders: ["1px", "1px", "1px", "1px"], outline });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await styles()).toEqual({ color: "rgb(189, 181, 238)", background: "rgba(139, 129, 195, 0.18)", borders: ["1px", "1px", "1px", "1px"], outline });
});
