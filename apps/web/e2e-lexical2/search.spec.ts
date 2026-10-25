import { expect, test, type Page } from "@playwright/test";

import { testPlanRows } from "../test/search-lexical-revisions.cases";

interface SearchBody {
  readonly results: readonly {
    readonly entry: { readonly sourceTitleRecordId: string };
    readonly matches: readonly { readonly signals: { readonly exactIdentifier: boolean } }[];
  }[];
  readonly retrieval: { readonly lexicalRevision: string };
}

function collectBrowserProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => problems.push(
    `request: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
  ));
  return problems;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("community-kb-locale", "en");
  });
});

// Rows the search box can type as they are; a project filter is covered by the reader tests.
const rows = testPlanRows.filter((row) => row.revision === "bm25-reference@2" && row.projects === null);

for (const row of rows) {
  test(`H34: ${row.case} — "${row.query}" searches the @2 release in the browser`, async ({ page }) => {
    const browserProblems = collectBrowserProblems(page);
    await page.goto("/kafka/threads");
    await expect(page.locator("#view-feed")).toBeVisible();

    const searchResponse = page.waitForResponse((response) =>
      response.url().includes("/api/search?") && new URL(response.url()).searchParams.get("q") === row.query);
    await page.locator("#q").fill(row.query);
    const response = await searchResponse;
    expect(response.status()).toBe(200);
    const body = await response.json() as SearchBody;

    expect(body.retrieval.lexicalRevision).toBe("bm25-reference@2");
    const roots = body.results.map((result) => result.entry.sourceTitleRecordId);
    const exact = body.results.filter((result) => result.matches.some((match) => match.signals.exactIdentifier))
      .map((result) => result.entry.sourceTitleRecordId);
    expect(exact.join(" ")).toBe(row.exact ?? "");
    expect(roots.slice(0, exact.length)).toEqual(exact);
    for (const required of (row.includes ?? "").split(" ").filter(Boolean)) expect(roots).toContain(required);

    const cards = page.locator(".search-card");
    await expect(cards).toHaveCount(row.results);
    // Exact matches are the first cards and carry the badge; no later card does.
    await expect(page.locator(".search-card:has(.exact-match)")).toHaveCount(exact.length);
    for (let index = 0; index < exact.length; index += 1) {
      await expect(cards.nth(index).locator(".exact-match").first()).toBeVisible();
    }

    // Spec 005 S17: a divider follows the exact cards when other results follow them, and only then.
    const order = await page.locator(".search-results > *").evaluateAll((nodes) =>
      nodes.map((node) => node.classList.contains("results-divider") ? "divider" : "card"));
    const mixed = exact.length > 0 && exact.length < row.results;
    expect(order).toEqual(body.results.flatMap((_, index) => mixed && index === exact.length ? ["divider", "card"] : ["card"]));
    await expect(page.locator(".search-match-badge")).toHaveCount(0);

    await cards.first().click();
    await expect(page).toHaveURL(/\/search\/sdr1\./u);
    await expect(page.locator(".timeline .tl-item").first()).toBeVisible();
    expect(browserProblems).toEqual([]);
  });
}

// Spec 005 S16–S18 on the real response for `KIP770`: two exact threads, then five that only share a word.
for (const [locale, others, count, kafkaCount] of [
  ["en", "Other related results", "2 exact matches · 7 matching threads", "2 exact matches · 6 matching threads"],
  ["zh-Hant", "其他相關結果", "2 個精確命中 · 7 個相符的討論", "2 個精確命中 · 6 個相符的討論"],
] as const) {
  for (const width of [375, 1280]) {
    test(`S17: KIP770 lists its exact matches, "${others}", then the rest, ${locale} at ${width} px`, async ({ page }, testInfo) => {
      await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), locale);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/kafka/threads");
      const answered = page.waitForResponse((response) => response.url().includes("/api/search?"));
      await page.locator("#q").fill("KIP770");
      const body = await (await answered).json() as SearchBody;
      await expect(page.locator(".search-card")).toHaveCount(7);

      // The response already has the exact threads first; the page keeps that order and adds one heading.
      expect(body.results.map((result) => result.matches.some((match) => match.signals.exactIdentifier)))
        .toEqual([true, true, false, false, false, false, false]);
      const order = await page.locator(".search-results > *").evaluateAll((nodes) =>
        nodes.map((node) => node.classList.contains("results-divider") ? "divider" : "card"));
      expect(order).toEqual(["card", "card", "divider", "card", "card", "card", "card", "card"]);
      await expect(page.getByRole("heading", { name: others, exact: true })).toBeVisible();
      await expect(page.locator(".results-count")).toHaveText(count);
      await expect(page.locator(".search-results")).not.toContainText(/Evidence search|證據搜尋|Similar meaning|意思相近/u);
      const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(widths[0]).toBeLessThanOrEqual(widths[1]!);
      const path = testInfo.outputPath(`kip770-${locale}-${width}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`kip770-${locale}-${width}`, { path, contentType: "image/png" });

      // S18: under a project filter the total is that project's facet (6 Kafka threads), not the sum (7).
      if (width === 1280) {
        await page.getByRole("button", { name: /Apache Kafka/u }).click();
        await expect(page.locator(".search-card")).toHaveCount(6);
        await expect(page.locator(".results-count")).toHaveText(kafkaCount);
      }
    });
  }
}

test("H34: the @2 bucket is the one under test, and golden v1 queries still answer", async ({ request }) => {
  const response = await request.get("/api/search?q=RecordAccumulator.ready()&limit=5");
  expect(response.status()).toBe(200);
  const body = await response.json() as SearchBody;
  expect(body.retrieval.lexicalRevision).toBe("bm25-reference@2");
  expect(body.results[0]?.entry.sourceTitleRecordId).toBe("kafka:github:pr:23203");
});
