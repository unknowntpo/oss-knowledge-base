import { expect, test, type Page, type Route } from "@playwright/test";

// Spec 001 A13: upstream-authored text with no break opportunity (URLs, class names, config
// keys, file paths) wraps inside its card on a phone instead of running off the screen.
// The local fixtures carry no such text, so every API response gets it appended in the browser.

/** Reported from an iPhone (Dev, zh-Hant): the excerpt of KAFKA-PR-22458's root record. */
const reportedExcerpt = "Ref : https://issues.apache.org/jira/browse/KAFKA 13152 Kip 770 : " +
  "https://cwiki.apache.org/confluence/pages/viewpage.action?pageId=186878390 " +
  "This PR continues PR #20292 (which became inactive).";
const reportedTitle = "PR #22458: KAFKA-13152: Add input.buffer.max.bytes based on KIP-770";

/** One unbreakable string per kind of upstream text; the last word of each proves the text rendered. */
const unbreakable = {
  url: "https://cwiki.apache.org/confluence/pages/viewpage.action?pageId=186878390&src=contextnavpagetreemode",
  className: "org.apache.kafka.streams.processor.internals.StreamsPartitionAssignorRebalanceProtocolCompatibilityIntegrationTest",
  configKey: "remote.log.manager.copier.thread.pool.size.max.bytes.per.second.quota.window.size.seconds",
  filePath: "clients/src/main/java/org/apache/kafka/clients/consumer/internals/AbstractMembershipManagerTest.java",
  identifier: "KAFKA_STREAMS_INPUT_BUFFER_MAX_BYTES_AND_STATESTORE_CACHE_MAX_BYTES_DEFAULT_CONFIG_DOCUMENTATION",
} as const;
const longText = Object.values(unbreakable).join(" ");
const marker = "CONFIG_DOCUMENTATION";

type Json = Record<string, any>;

function longFeedEntry(entry: Json): void {
  entry.entry.title += ` ${longText}`;
  entry.entry.summary += ` ${longText}`;
  entry.tags.push(unbreakable.configKey, unbreakable.identifier);
  entry.authors.push(unbreakable.identifier);
  entry.releaseLabel += ` ${unbreakable.filePath}`;
}

function longDetail(detail: Json): void {
  detail.entry.title += ` ${longText}`;
  detail.entry.summary += ` ${longText}`;
  for (const record of detail.records) {
    record.title += ` ${longText}`;
    record.excerpt += ` ${longText}`;
    record.author += unbreakable.identifier;
    record.kind += ` ${unbreakable.className}`;
  }
  detail.records[0].title = reportedTitle;
  detail.records[0].excerpt = reportedExcerpt;
  detail.keyPoints = {
    status: "generated",
    points: [{ id: "key-point:long", text: longText, evidenceRecordIds: [detail.records[0].id] }],
    derivation: { kind: "source-extract", revision: "github-source-extract@1" },
  };
  detail.related = [{ displayId: "KAFKA-13152", title: longText, source: "jira", rule: "key-in-title", ruleRevision: "e2e" }];
}

function longSearch(body: Json): void {
  for (const result of body.results) {
    result.entry.title += ` ${longText}`;
    result.entry.summary = `${longText} ${result.entry.summary}`;
    for (const match of result.matches) {
      match.excerpt = `${longText} ${match.excerpt}`;
      match.author += unbreakable.identifier;
    }
  }
}

function longDigest(digest: Json): void {
  digest.headline.text += ` ${longText}`;
  for (const highlight of digest.highlights) {
    highlight.title += ` ${longText}`;
    highlight.body.text += ` ${longText}`;
  }
  for (const proposal of digest.proposals) if (proposal.line) proposal.line.text += ` ${longText}`;
  for (const card of digest.cards) {
    for (const sentence of card.sentences) sentence.text += ` ${longText}`;
    card.keywords.push(unbreakable.configKey, unbreakable.identifier);
  }
  for (const thread of Object.values<Json>(digest.threads)) {
    thread.title += ` ${longText}`;
    if (thread.excerpt) thread.excerpt += ` ${longText}`;
    if (thread.author) thread.author += unbreakable.identifier;
  }
}

async function rewrite(page: Page, url: string, change: (body: Json) => void): Promise<void> {
  await page.route(url, async (route: Route) => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const body = await response.json();
    change(body);
    await route.fulfill({ response, json: body });
  });
}

async function prepare(page: Page, locale: string, width: number): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), locale);
  await page.setViewportSize({ width, height: width === 375 ? 812 : 844 });
  await rewrite(page, "**/api/feed", (body) => body.entries.forEach(longFeedEntry));
  await rewrite(page, "**/api/detail/*", longDetail);
  await rewrite(page, "**/api/search-detail/*", (detail) => {
    longDetail(detail);
    // A detail published before Spec 012 has no display id: `.topic-id` shows the root title up to its first colon.
    delete detail.displayId;
    detail.records.find((record: Json) => record.id === detail.entry.sourceTitleRecordId).title = `${unbreakable.className}${marker}`;
  });
  await rewrite(page, "**/api/search?*", longSearch);
  await rewrite(page, "**/api/digest*", longDigest);
}

/** Opens the first matching link by its href. Controls are driven with dispatched events for the same
 * reason: an overflowing layout must fail a measured row, not time out on a covered button. */
async function follow(page: Page, selector: string): Promise<void> {
  await page.goto(`/${await page.locator(selector).first().getAttribute("href")}`);
}

interface Row {
  /** Element that renders upstream text. */
  readonly selector: string;
  /** Closest ancestor the text must stay inside. */
  readonly within: string;
  /** Text the measured elements must show; the long-text marker when omitted. */
  readonly contains?: string;
}

/**
 * Every glyph of every matched element stays inside its container's padding box and the viewport,
 * and the page does not scroll sideways. Text is measured with a Range, so text spilling out of a
 * box that itself stays in place is still caught.
 */
async function expectWrapped(page: Page, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    const elements = page.locator(row.selector);
    await expect(elements.first(), row.selector).toBeVisible();
    // Only elements showing the row's text are measured, so a row cannot pass on an empty element.
    const shown = elements.filter({ hasText: row.contains ?? marker });
    await expect(shown.first(), `${row.selector} shows the long text`).toBeVisible();
    const spill = await shown.evaluateAll((nodes, within) => nodes.flatMap((node) => {
      const container = node.closest(within);
      if (container === null) return [`no ${within} ancestor`];
      const range = document.createRange();
      range.selectNodeContents(node);
      const right = Math.max(node.getBoundingClientRect().right, ...[...range.getClientRects()].map((rect) => rect.right));
      const box = container.getBoundingClientRect();
      const limit = Math.min(box.right - parseFloat(getComputedStyle(container).borderRightWidth), window.innerWidth);
      return right > limit + 0.5 ? [`text ends at ${Math.round(right)} px, limit ${Math.round(limit)} px`] : [];
    }), row.within);
    expect.soft(spill, `${row.selector} inside ${row.within}`).toEqual([]);
  }
  const pageWidth = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect.soft(pageWidth[0], "page scrolls sideways").toBeLessThanOrEqual(pageWidth[1]!);
}

const cardRows: readonly Row[] = [
  { selector: ".card:not(.search-card) .card-title", within: ".card" },
  { selector: ".card:not(.search-card) .card-summary", within: ".card" },
  { selector: ".card:not(.search-card) .tag-pill", within: ".card" },
];
const filterRows: readonly Row[] = [
  { selector: "#filters .tag-chip", within: "#filters" },
];
const searchRows: readonly Row[] = [
  { selector: ".search-card .card-title", within: ".search-card" },
  { selector: ".search-card .card-summary", within: ".search-card", contains: "https://cwiki" },
  { selector: ".search-card .evidence-text", within: ".search-card", contains: "https://cwiki" },
  { selector: ".search-card .evidence-meta", within: ".search-card" },
  { selector: ".search-card .search-match-badge", within: ".search-card", contains: "" },
];
const detailRows: readonly Row[] = [
  { selector: "#topic-title", within: ".topic-wrap" },
  { selector: ".topic-lede", within: ".topic-wrap" },
  { selector: ".topic-meta", within: ".topic-wrap" },
  { selector: ".ai-item p", within: ".ai-card" },
  { selector: ".tl-meta .author", within: ".tl-card" },
  { selector: ".tl-meta .tl-kind", within: ".tl-card", contains: "IntegrationTest" },
  { selector: ".tl-title", within: ".tl-card" },
  { selector: ".tl-excerpt", within: ".tl-card" },
  { selector: ".related-item .rtitle", within: ".rail" },
];
const feedDetailRows: readonly Row[] = [
  ...detailRows,
  { selector: ".tl-title", within: ".tl-card", contains: reportedTitle },
  { selector: ".tl-excerpt", within: ".tl-card", contains: "pageId=186878390 This PR continues" },
  { selector: ".rail .tag-chip", within: ".rail" },
];
const searchDetailRows: readonly Row[] = [
  ...detailRows,
  { selector: ".topic-head .topic-id", within: ".topic-wrap" },
];
const weekRows: readonly Row[] = [
  { selector: ".digest-headline", within: "#digest" },
  { selector: ".highlight-title", within: ".digest-highlight" },
  { selector: ".digest-highlight .digest-sentence", within: ".digest-highlight" },
  { selector: ".kip-row .kip-title", within: ".kip-row" },
  { selector: ".kip-row .digest-sentence", within: ".kip-row" },
  { selector: ".topic-card .digest-sentence", within: ".topic-card" },
  { selector: ".topic-card .keyword", within: ".topic-card" },
];
const proposalRows: readonly Row[] = [
  { selector: ".kip-row .kip-title", within: ".kip-row" },
  { selector: ".kip-row .digest-sentence", within: ".kip-row" },
];
const topicRows: readonly Row[] = [
  { selector: ".topic-summary .digest-sentence", within: "#view-topic-page" },
  { selector: "#view-topic-page .keyword", within: "#view-topic-page" },
  { selector: ".thread-title", within: ".thread-card" },
  { selector: ".thread-excerpt", within: ".thread-card" },
  { selector: ".thread-meta", within: ".thread-card" },
];

test.beforeEach(({}, testInfo) => {
  // Viewports are set per test; one project is enough.
  test.skip(testInfo.project.name !== "mobile-chromium", "viewport widths are set explicitly");
});

for (const width of [375, 390]) {
  for (const locale of ["en", "zh-Hant"] as const) {
    test(`A13: unbreakable upstream text wraps inside its card at ${width} px, ${locale}`, async ({ page }, testInfo) => {
      await prepare(page, locale, width);
      const shot = async (name: string) => {
        const path = testInfo.outputPath(`${name}-${width}-${locale}.png`);
        await page.screenshot({ path, fullPage: true });
        await testInfo.attach(`${name}-${width}-${locale}`, { path, contentType: "image/png" });
      };

      await test.step("feed", async () => {
        await page.goto("/#/kafka/threads");
        await expect(page.locator(".card")).toHaveCount(2);
        await page.locator(".filters-toggle").dispatchEvent("click");
        await expectWrapped(page, [...cardRows, ...filterRows]);
      });
      await test.step("feed detail", async () => {
        await follow(page, ".card");
        await expect(page).toHaveURL(/#\/feed\//u);
        await page.locator(".ai-actions .btn").dispatchEvent("click");
        await shot("feed-detail");
        await expectWrapped(page, feedDetailRows);
      });
      await test.step("search", async () => {
        await page.goto("/#/kafka/threads");
        await page.locator("#q").fill("KIP-405");
        await expect(page.locator(".search-card").first()).toBeVisible();
        await expectWrapped(page, searchRows);
      });
      await test.step("search detail", async () => {
        await follow(page, ".search-card");
        await expect(page).toHaveURL(/#\/search\/sdr1\./u);
        await page.locator(".ai-actions .btn").dispatchEvent("click");
        await expectWrapped(page, searchDetailRows);
      });
      await test.step("this week", async () => {
        await page.goto("/#/kafka/");
        await expect(page.locator("#digest")).toBeVisible();
        await shot("week");
        await expectWrapped(page, weekRows);
        for (const details of await page.locator("details.digest-routine").all()) await details.locator("summary").dispatchEvent("click");
        await expectWrapped(page, []);
      });
      await test.step("proposals", async () => {
        await page.goto("/#/kafka/proposals");
        await expect(page.locator("#view-proposals .kip-row").first()).toBeVisible();
        await expectWrapped(page, proposalRows);
      });
      await test.step("topic page", async () => {
        await page.goto("/#/kafka/");
        await follow(page, ".topic-card-title a");
        await expect(page.locator("#view-topic-page")).toBeVisible();
        await expectWrapped(page, topicRows);
      });
    });
  }
}

test("A13: the same text stays inside its card on the detail page at 1280 px", async ({ page }) => {
  await prepare(page, "en", 375);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/kafka/threads");
  await follow(page, ".card");
  await expect(page).toHaveURL(/#\/feed\//u);
  await page.locator(".ai-actions .btn").dispatchEvent("click");
  await expectWrapped(page, feedDetailRows);
});
