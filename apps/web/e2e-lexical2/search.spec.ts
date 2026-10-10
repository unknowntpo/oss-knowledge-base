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
    await page.goto("/#/kafka/threads");
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

    await cards.first().click();
    await expect(page).toHaveURL(/#\/search\/sdr1\./u);
    await expect(page.locator(".timeline .tl-item").first()).toBeVisible();
    expect(browserProblems).toEqual([]);
  });
}

test("H34: the @2 bucket is the one under test, and golden v1 queries still answer", async ({ request }) => {
  const response = await request.get("/api/search?q=RecordAccumulator.ready()&limit=5");
  expect(response.status()).toBe(200);
  const body = await response.json() as SearchBody;
  expect(body.retrieval.lexicalRevision).toBe("bm25-reference@2");
  expect(body.results[0]?.entry.sourceTitleRecordId).toBe("kafka:github:pr:23203");
});
