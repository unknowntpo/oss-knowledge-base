import { expect, test, type Page, type Route } from "@playwright/test";

// Spec 016 H70: a thread only semantic retrieval found carries a "Similar meaning" badge, and a
// response whose semantic retrieval was skipped renders as it always did. The local Pages server
// is lexical (the flag is off), so the hybrid fields are added to its real response in the browser.

type Json = Record<string, any>;

const unbreakable = "org.apache.kafka.streams.processor.internals.StreamsPartitionAssignorRebalanceProtocolCompatibilityIntegrationTest";

async function rewriteSearch(page: Page, change: (body: Json) => void): Promise<void> {
  await page.route("**/api/search?*", async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json();
    change(body);
    await route.fulfill({ response, json: body });
  });
}

/** Result 2 becomes a thread found by meaning alone; result 1 is found by both retrievers. */
function hybrid(body: Json): void {
  body.retrieval = { ...body.retrieval, fusionRevision: "rrf-group@1", semanticRevision: "@cf/baai/bge-m3@1:1024:title-text@1", semantic: { status: "ok", candidates: 2, cached: false } };
  body.results[0].matches.forEach((match: Json) => { match.signals.semanticRank = 2; });
  const only = body.results[1];
  only.entry.title += ` ${unbreakable}`;
  only.matches = only.matches.slice(0, 1).map((match: Json) => ({
    ...match,
    matchedTerms: [],
    signals: { exactIdentifier: false, semanticRank: 1, fusedRank: 2 },
  }));
}

async function search(page: Page, locale: string, query: string): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), locale);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#/kafka/threads");
  await page.locator("#q").fill(query);
  await expect(page.locator(".search-card").first()).toBeVisible();
}

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "the viewport is set explicitly");
});

for (const [locale, label, lexicalLabel] of [["en", "Similar meaning", "Evidence search"], ["zh-Hant", "意思相近", "證據搜尋"]] as const) {
  test(`H70: a semantic-only result shows "${label}" inside its card at 375 px, ${locale}`, async ({ page }, testInfo) => {
    await rewriteSearch(page, hybrid);
    await search(page, locale, "storage");
    const cards = page.locator(".search-card");
    expect(await cards.count()).toBeGreaterThanOrEqual(2);

    // Only the thread no lexical match returned carries the badge; every card keeps its own.
    await expect(cards.nth(0).locator(".semantic-match-badge")).toHaveCount(0);
    await expect(cards.nth(1).locator(".semantic-match-badge")).toHaveText(label);
    await expect(page.locator(".semantic-match-badge")).toHaveCount(1);
    await expect(cards.nth(1).locator(".search-match-badge").first()).toHaveText(lexicalLabel);
    await expect(cards.nth(1).locator(".evidence-text")).not.toBeEmpty();
    await expect(cards.nth(1).locator(".exact-match")).toHaveCount(0);

    // Spec 001 A13: the badge and the long title stay inside the card, and the page does not scroll sideways.
    const spill = await cards.nth(1).evaluate((card) => {
      const limit = Math.min(card.getBoundingClientRect().right, window.innerWidth);
      return [...card.querySelectorAll(".semantic-match-badge, .search-match-badge, .card-title")].flatMap((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const right = Math.max(node.getBoundingClientRect().right, ...[...range.getClientRects()].map((rect) => rect.right));
        return right > limit + 0.5 ? [`${node.className} ends at ${Math.round(right)} px, limit ${Math.round(limit)} px`] : [];
      });
    });
    expect(spill).toEqual([]);
    const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(widths[0]).toBeLessThanOrEqual(widths[1]!);
    const path = testInfo.outputPath(`semantic-badge-${locale}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`semantic-badge-${locale}`, { path, contentType: "image/png" });

    // The semantic-only result opens its detail like any other.
    await page.goto(`/${await cards.nth(1).getAttribute("href")}`);
    await expect(page).toHaveURL(/#\/search\/sdr1\./u);
    await expect(page.locator("#topic-title")).toBeVisible();
  });
}

for (const semantic of [{ status: "over-budget" }, { status: "timed-out" }, { status: "failed" }, { status: "skipped", reason: "identifier-query" }]) {
  test(`H70: a response whose semantic retrieval is ${semantic.status} renders the lexical results with no badge and no error`, async ({ page }) => {
    await rewriteSearch(page, (body) => {
      body.retrieval = { ...body.retrieval, fusionRevision: "rrf-group@1", semantic };
    });
    await search(page, "en", "storage");
    expect(await page.locator(".search-card").count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".semantic-match-badge")).toHaveCount(0);
    await expect(page.locator(".load-error")).toHaveCount(0);
    await expect(page.locator(".search-card .search-match-badge").first()).toHaveText("Evidence search");
  });
}
