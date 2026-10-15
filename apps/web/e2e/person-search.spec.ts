import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

// Spec 019 slice 3 in the browser: person results above the thread results of Search, against the
// constructed review store of `people-e2e-fixture.ts` (Kafka: alice, bob, carol, dave, erin).
// Set PEOPLE_SCREENSHOT_DIR to keep screenshots of a search with a person result.

async function typeQuery(page: Page, query: string, options: { locale?: string; width?: number } = {}) {
  await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), options.locale ?? "en");
  if (options.width !== undefined) await page.setViewportSize({ width: options.width, height: 812 });
  await page.goto("/#/kafka/threads");
  const threads = page.waitForResponse((response) => response.url().includes("/api/search?"));
  const people = page.waitForResponse((response) => response.url().includes("/api/people/kafka?"));
  await page.locator("#q").fill(query);
  return { threads: await (await threads).json(), people: await (await people).json() };
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.PEOPLE_SCREENSHOT_DIR;
  if (directory === undefined || directory === "") return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}-${test.info().project.name}.png` });
}

test("W7: an exact login shows its person result first; the thread list is the /api/search answer", async ({ page }) => {
  const { threads, people } = await typeQuery(page, "Alice");
  expect(people.people).toEqual([{ id: "github:alice", source: "github", display: "alice", match: "exact" }]);
  const person = page.locator(".person-result");
  await expect(person).toHaveCount(1);
  await expect(person.first()).toHaveAttribute("href", `#/kafka/people/${encodeURIComponent("github:alice")}`);
  await expect(person.first()).toContainText("Exact login");
  // The person block comes before the thread list, which is unchanged: same cards, numbered from #1.
  const before = await page.evaluate(() => {
    const block = document.querySelector(".person-results");
    const list = document.querySelector(".search-results");
    return block !== null && (list === null || Boolean(block.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(before).toBe(true);
  await expect(page.locator(".search-results .search-card")).toHaveCount(threads.results.length);
  if (threads.results.length > 0) await expect(page.locator(".search-results .topic-id").first()).toHaveText("#1");
  await expect(page.locator(".search-results .person-result")).toHaveCount(0);
  await screenshot(page, "search-person-alice");
});

test("W7: a prefix shows prefix matches; the person result opens the profile", async ({ page }) => {
  const { people } = await typeQuery(page, "ca");
  expect(people.people.map((person: { id: string; match: string }) => `${person.id} ${person.match}`)).toEqual(["github:carol prefix"]);
  await page.locator(".person-result").first().click();
  await expect(page).toHaveURL(new RegExp(`#/kafka/people/${encodeURIComponent("github:carol")}$`, "u"));
  await expect(page.locator(".person-name")).toHaveText("carol");
});

test("W7: a query that is not a login sends no person request and shows no person result", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/people/kafka?")) requests.push(request.url()); });
  await page.addInitScript(() => window.localStorage.setItem("community-kb-locale", "en"));
  await page.goto("/#/kafka/threads");
  const threads = page.waitForResponse((response) => response.url().includes("/api/search?"));
  await page.locator("#q").fill("alice bob");
  await threads;
  await page.waitForTimeout(400);
  expect(requests).toEqual([]);
  await expect(page.locator(".person-result")).toHaveCount(0);
});

test("W42: the person API answers noindex", async ({ request }) => {
  const response = await request.get("/api/people/kafka?q=alice");
  expect(response.status()).toBe(200);
  expect(response.headers()["x-robots-tag"]).toBe("noindex");
});

for (const width of [320, 375]) {
  test(`W45: at ${width} px a search with a person result has no horizontal overflow`, async ({ page }) => {
    await typeQuery(page, "alice", { locale: "zh-Hant", width });
    await expect(page.locator(".person-result").first()).toContainText("帳號完全相符");
    await expect(page.locator(".person-results .results-divider").first()).toHaveText("貢獻者");
    const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(scroll).toBeLessThanOrEqual(inner);
    if (width === 375) await screenshot(page, "search-person-alice-375-zh");
  });
}
