import { expect, test, type Page } from "@playwright/test";

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

test("evidence search opens its immutable FeedDetail timeline", async ({ page }) => {
  const browserProblems = collectBrowserProblems(page);
  const feedResponse = page.waitForResponse((response) => response.url().endsWith("/api/feed"));

  await page.goto("/#/kafka/threads");
  expect((await feedResponse).status()).toBe(200);
  await expect(page.locator("#view-feed")).toBeVisible();
  await expect(page.locator(".card")).toHaveCount(2);
  // Spec 014: All threads is the Feed for the route project.
  await expect(page.locator(".card-project")).toContainText([
    "Apache Kafka",
    "Apache Kafka",
  ]);

  const searchResponse = page.waitForResponse((response) =>
    response.url().includes("/api/search?") && response.url().includes("KIP-405"));
  await page.locator("#q").fill("KIP-405");
  expect((await searchResponse).status()).toBe(200);
  const result = page.locator(".search-card").first();
  await expect(result).toContainText("KIP-405: Kafka Tiered Storage");
  await expect(result.locator(".evidence").first()).toContainText("Tiered storage");
  await result.click();

  await expect(page).toHaveURL(/#\/search\/sdr1\./);
  await expect(page.getByRole("heading", {
    level: 1,
    name: "KIP-405: Kafka Tiered Storage",
  })).toBeVisible();
  await expect(page.locator(".timeline .tl-item")).toHaveCount(3);
  await expect(page.getByRole("button", { name: /Wiki\s*1/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Mailing list\s*1/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /GitHub\s*1/ })).toBeVisible();
  await expect(page.locator(".tl-link").first()).toHaveAttribute(
    "href",
    /^https:\/\//,
  );
  await expect(page.locator(".key-points-state")).toContainText(
    "No summarizer is configured",
  );
  expect(browserProblems).toEqual([]);
});

test("project facets shrink with the query and stay consistent when selected", async ({ page }) => {
  const browserProblems = collectBrowserProblems(page);
  await page.goto("/#/kafka/threads");
  await expect(page.locator("#view-feed")).toBeVisible();

  const initialResponse = page.waitForResponse((response) =>
    response.url().includes("/api/search?") &&
    response.url().includes("q=producer") &&
    !response.url().includes("projectId="));
  await page.locator("#q").fill("producer");
  expect((await initialResponse).status()).toBe(200);
  const filtersToggle = page.getByRole("button", { name: "Filters" });
  if (await filtersToggle.isVisible()) await filtersToggle.click();
  const kafkaProject = page.getByRole("button", { name: /Apache Kafka/ });
  const dataFusionProject = page.getByRole("button", { name: /Apache DataFusion/ });
  await expect(kafkaProject).toHaveText(/Apache Kafka\s*3/);
  await expect(dataFusionProject).toHaveText(/Apache DataFusion\s*0/);

  const projectResponse = page.waitForResponse((response) =>
    response.url().includes("/api/search?") &&
    response.url().includes("projectId=apache-kafka") &&
    !response.url().includes("projectStatus="));
  await kafkaProject.click();
  const projectBody = await (await projectResponse).json() as {
    readonly results: readonly unknown[];
    readonly facets: { readonly projects: readonly { readonly projectId: string; readonly count: number }[] };
  };
  expect(projectBody.results).toHaveLength(3);
  expect(projectBody.facets.projects.find((facet) => facet.projectId === "apache-kafka")?.count)
    .toBe(3);
  await expect(page.locator(".search-card")).toHaveCount(3);

  const filteredResponse = page.waitForResponse((response) =>
    response.url().includes("/api/search?") &&
    response.url().includes("projectStatus=merged"));
  await page.getByRole("button", { name: "Merged" }).click();
  expect((await filteredResponse).status()).toBe(200);

  const results = page.locator(".search-card");
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText("RecordAccumulator.ready()");
  await expect(results.first()).toContainText("Merged");
  expect(browserProblems).toEqual([]);
});
