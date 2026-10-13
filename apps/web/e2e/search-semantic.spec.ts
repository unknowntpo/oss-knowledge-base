import { expect, test, type Page, type Route } from "@playwright/test";

// Spec 016 H70 as superseded on 2026-10-13, and Spec 005 S16–S18: a result card names no search
// method; exact matches come first with a divider before the rest; the count line says what is
// shown. The local Pages server is lexical (the flag is off), so the hybrid fields and the exact
// flags are added to its real response in the browser.

type Json = Record<string, any>;

const unbreakable = "org.apache.kafka.streams.processor.internals.StreamsPartitionAssignorRebalanceProtocolCompatibilityIntegrationTest";
const methodWording = /Evidence search|證據搜尋|Similar meaning|意思相近/u;
const locales = [
  { locale: "en", exact: "Exact match", others: "Other related results" },
  { locale: "zh-Hant", exact: "精確命中", others: "其他相關結果" },
] as const;
const widths = [375, 1280] as const;

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

/** The first `count` results become exact identifier matches; the facets say `total` threads match. */
function exactFirst(count: number, total?: number) {
  return (body: Json): void => {
    body.results.forEach((result: Json, index: number) => {
      result.matches.forEach((match: Json, position: number) => { match.signals.exactIdentifier = index < count && position === 0; });
    });
    if (total !== undefined) body.facets.projects = [{ projectId: body.results[0].entry.projectId, count: total }];
  };
}

async function search(page: Page, locale: string, query: string, width = 375): Promise<Json> {
  await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), locale);
  await page.setViewportSize({ width, height: 812 });
  // A second search in one test starts from a fresh page, so the box is empty and the query is sent again.
  await page.goto("about:blank");
  await page.goto("/#/kafka/threads");
  const answered = page.waitForResponse((response) => response.url().includes("/api/search?"));
  await page.locator("#q").fill(query);
  const body = await (await answered).json();
  if (body.results.length > 0) await expect(page.locator(".search-card").first()).toBeVisible();
  return body;
}

/** What follows what in the result list: `card` or `divider`, in document order. */
async function listOrder(page: Page): Promise<string[]> {
  return page.locator(".search-results > *").evaluateAll((nodes) =>
    nodes.map((node) => node.classList.contains("results-divider") ? "divider" : node.classList.contains("search-card") ? "card" : node.tagName));
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const widthsNow = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(widthsNow[0]).toBeLessThanOrEqual(widthsNow[1]!);
}

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "the viewport is set explicitly");
});

for (const { locale } of locales) {
  test(`H70: S16 — lexical, semantic-only and mixed results show no method badge at 375 px, ${locale}`, async ({ page }, testInfo) => {
    await rewriteSearch(page, hybrid);
    await search(page, locale, "kafka");
    const cards = page.locator(".search-card");
    expect(await cards.count()).toBeGreaterThanOrEqual(3);

    // Card 1 is found by both retrievers, card 2 by meaning alone, card 3 by words alone.
    await expect(page.locator(".search-match-badge, .semantic-match-badge")).toHaveCount(0);
    for (const index of [0, 1, 2]) await expect(cards.nth(index)).not.toContainText(methodWording);
    // Positive control: the semantic-only card rendered its head, title and evidence.
    await expect(cards.nth(1).locator(".topic-id")).toHaveText("#2");
    await expect(cards.nth(1).locator(".card-title")).toContainText(unbreakable);
    await expect(cards.nth(1).locator(".evidence-text")).not.toBeEmpty();
    await expect(cards.nth(1).locator(".exact-match")).toHaveCount(0);

    // Spec 001 A13: the long title stays inside the card, and the page does not scroll sideways.
    const spill = await cards.nth(1).evaluate((card) => {
      const limit = Math.min(card.getBoundingClientRect().right, window.innerWidth);
      return [...card.querySelectorAll(".card-head > *, .card-title")].flatMap((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const right = Math.max(node.getBoundingClientRect().right, ...[...range.getClientRects()].map((rect) => rect.right));
        return right > limit + 0.5 ? [`${node.className} ends at ${Math.round(right)} px, limit ${Math.round(limit)} px`] : [];
      });
    });
    expect(spill).toEqual([]);
    await expectNoSidewaysScroll(page);
    const path = testInfo.outputPath(`semantic-only-${locale}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`semantic-only-${locale}`, { path, contentType: "image/png" });

    // The semantic-only result opens its detail like any other, and the detail names no method either.
    await page.goto(`/${await cards.nth(1).getAttribute("href")}`);
    await expect(page).toHaveURL(/#\/search\/sdr1\./u);
    await expect(page.locator("#topic-title")).toBeVisible();
    await expect(page.locator(".topic-meta > span")).toHaveCount(2);
    await expect(page.locator(".topic-meta")).not.toContainText(methodWording);
  });
}

for (const semantic of [{ status: "over-budget" }, { status: "timed-out" }, { status: "failed" }, { status: "skipped", reason: "identifier-query" }]) {
  test(`H70: a response whose semantic retrieval is ${semantic.status} renders the lexical results with no badge and no error`, async ({ page }) => {
    await rewriteSearch(page, (body) => {
      body.retrieval = { ...body.retrieval, fusionRevision: "rrf-group@1", semantic };
    });
    await search(page, "en", "storage");
    expect(await page.locator(".search-card").count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".search-match-badge, .semantic-match-badge")).toHaveCount(0);
    await expect(page.locator(".load-error")).toHaveCount(0);
    await expect(page.locator(".search-card .card-title").first()).not.toBeEmpty();
  });
}

for (const { locale, exact, others } of locales) {
  for (const width of widths) {
    test(`S17: one exact match, then "${others}" before the rest, ${locale} at ${width} px`, async ({ page }, testInfo) => {
      await rewriteSearch(page, exactFirst(1));
      const body = await search(page, locale, "kafka", width);
      expect(body.results.length).toBeGreaterThanOrEqual(3);

      // The cards keep the response's order; the divider is the only addition, after the exact card.
      expect(await listOrder(page)).toEqual(["card", "divider", ...body.results.slice(1).map(() => "card")]);
      const titles = await page.locator(".search-card .card-title").allInnerTexts();
      expect(titles).toEqual(body.results.map((result: Json) => result.entry.title));
      const divider = page.getByRole("heading", { name: others, exact: true });
      await expect(divider).toBeVisible();
      await expect(divider).toHaveClass("results-divider");
      // The marker is text a screen reader reads, on the exact card only.
      await expect(page.locator(".search-card").nth(0).locator(".exact-match")).toHaveText(exact);
      await expect(page.locator(".search-card:has(.exact-match)")).toHaveCount(1);
      // The divider spans the list and sits between the two groups.
      const boxes = await page.evaluate(() => {
        const box = (selector: string, index = 0) => document.querySelectorAll(selector)[index]!.getBoundingClientRect();
        const list = box(".search-results"), divider = box(".results-divider");
        return { list: [list.left, list.right], divider: [divider.left, divider.right, divider.top, divider.bottom], first: box(".search-card", 0).bottom, second: box(".search-card", 1).top };
      });
      expect(boxes.divider[0]).toBeCloseTo(boxes.list[0]!, 0);
      expect(boxes.divider[1]).toBeCloseTo(boxes.list[1]!, 0);
      expect(boxes.divider[2]).toBeGreaterThanOrEqual(boxes.first);
      expect(boxes.divider[3]).toBeLessThanOrEqual(boxes.second);
      await expectNoSidewaysScroll(page);
      const path = testInfo.outputPath(`divider-${locale}-${width}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`divider-${locale}-${width}`, { path, contentType: "image/png" });
    });
  }

  test(`S17: no divider when no result or every result is exact, ${locale}`, async ({ page }) => {
    await rewriteSearch(page, exactFirst(0));
    const none = await search(page, locale, "storage");
    expect(await listOrder(page)).toEqual(none.results.map(() => "card"));
    await expect(page.locator(".exact-match")).toHaveCount(0);

    await page.unroute("**/api/search?*");
    await rewriteSearch(page, exactFirst(Number.POSITIVE_INFINITY));
    const all = await search(page, locale, "storage");
    expect(all.results.length).toBeGreaterThanOrEqual(2);
    expect(await listOrder(page)).toEqual(all.results.map(() => "card"));
    // Positive control: these are exact cards, so the missing divider is not a missing list.
    await expect(page.locator(".search-card:has(.exact-match)")).toHaveCount(all.results.length);
  });
}

const countRows = [
  { name: "exact and others, more matching than shown", exact: 1, extra: 132, en: (shown: number) => `1 exact match · showing ${shown} of ${shown + 132} matching threads`, zh: (shown: number) => `1 個精確命中 · 顯示 ${shown + 132} 個相符討論中的前 ${shown} 個` },
  { name: "no exact match, more matching than shown", exact: 0, extra: 132, en: (shown: number) => `Showing ${shown} of ${shown + 132} matching threads`, zh: (shown: number) => `顯示 ${shown + 132} 個相符討論中的前 ${shown} 個` },
  { name: "every matching thread shown", exact: 0, extra: 0, en: (shown: number) => `${shown} matching threads`, zh: (shown: number) => `${shown} 個相符的討論` },
] as const;
for (const row of countRows) {
  test(`S18: the count line — ${row.name}, both locales`, async ({ page }) => {
    for (const locale of ["en", "zh-Hant"] as const) {
      await page.unroute("**/api/search?*");
      let shown = 0;
      await rewriteSearch(page, (body) => {
        shown = body.results.length;
        exactFirst(row.exact, shown + row.extra)(body);
      });
      await search(page, locale, "storage");
      expect(shown).toBeGreaterThanOrEqual(2);
      await expect(page.locator(".results-count")).toHaveText((locale === "en" ? row.en : row.zh)(shown));
      await expect(page.locator(".results-count")).not.toContainText(/related entries|matching source records/u);
      await expectNoSidewaysScroll(page);
    }
  });
}

test("S18: zero results read as no matching threads, and the unfiltered count is the sum of the project facets", async ({ page }) => {
  const empty = await search(page, "en", "zzzznomatchzzzz");
  expect(empty.results).toEqual([]);
  await expect(page.locator(".results-count")).toHaveText("No matching threads");
  await expect(page.locator(".search-card")).toHaveCount(0);

  // Unmodified response of the local fixture: fewer threads than the limit, every one shown.
  const body = await search(page, "en", "storage");
  const total = body.facets.projects.reduce((sum: number, facet: Json) => sum + facet.count, 0);
  expect(body.results.length).toBe(total);
  expect(total).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".results-count")).toHaveText(`${total} matching threads`);
});

test("S18: the count line is empty while a search is loading and after it failed", async ({ page }) => {
  // Positive control: an answered search has a count line, so the empty ones below are not a missing element.
  await search(page, "en", "kafka");
  await expect(page.locator(".results-count")).toHaveText(/matching threads$/u);

  // The next search is held open, then answered 503. The previous response is still in memory.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let asked = false;
  await page.route("**/api/search?*", async (route: Route) => {
    asked = true;
    await held;
    await route.fulfill({ status: 503, json: { error: "unavailable" } });
  });
  await page.locator("#q").fill("storage");
  await expect.poll(() => asked).toBe(true);
  await expect(page.locator(".empty")).toHaveText("Searching source evidence…");
  await expect(page.locator(".results-count")).toHaveText("");
  await expect(page.locator(".results-count")).toHaveCount(1);

  release();
  await expect(page.locator(".load-error")).toBeVisible();
  await expect(page.locator(".search-card")).toHaveCount(0);
  await expect(page.locator(".results-count")).toHaveText("");
});
