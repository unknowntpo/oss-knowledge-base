import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

const workerUrl = process.env.DEV_WORKER_URL
  ?? "https://oss-knowledge-base-data-dev.unknowntpo.workers.dev";

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

test("development cron data reaches Feed, Search, facets, and immutable detail", async ({ page, request, publisherRequest }) => {
  type Health = {
    readonly environment: string;
    readonly running: boolean;
    readonly lastRun: null | {
      readonly ok: boolean;
      readonly completedAt: string;
      readonly feedReleaseId: string;
      readonly searchRevision: string;
      readonly logicalEventCount: number;
    };
  };
  let health: Health | undefined;
  await expect.poll(async () => {
    const response = await publisherRequest.get(`${workerUrl}/health`);
    health = response.status() === 200 ? await response.json() as Health : undefined;
    return {
      status: response.status(),
      environment: health?.environment,
      running: health?.running,
      lastRunOk: health?.lastRun?.ok,
    };
  }, {
    message: "wait for the serialized development Cron publication to finish",
    timeout: 15 * 60 * 1_000,
    intervals: [1_000, 5_000, 10_000],
  }).toEqual({ status: 200, environment: "development", running: false, lastRunOk: true });
  if (health?.lastRun === undefined || health.lastRun === null) throw new Error("Development has no completed run");
  expect(health.environment).toBe("development");
  expect(health.lastRun.ok).toBe(true);
  expect(health.lastRun.logicalEventCount).toBeGreaterThan(0);
  expect(Date.now() - Date.parse(health.lastRun.completedAt)).toBeLessThan(2 * 60 * 60 * 1_000);

  await expect.poll(async () => {
    const [feedResponse, searchResponse] = await Promise.all([
      request.get("/api/feed"),
      request.get("/api/search?q=Kafka%20Streams&limit=20"),
    ]);
    const feed = feedResponse.status() === 200 ? await feedResponse.json() : undefined;
    const search = searchResponse.status() === 200 ? await searchResponse.json() : undefined;
    return {
      feedStatus: feedResponse.status(),
      feedReleaseId: feed?.metadata?.manifest?.releaseId,
      searchStatus: searchResponse.status(),
      searchRevision: search?.retrieval?.indexRevision,
    };
  }, {
    message: "wait for both cached Pages projections to expose the completed Cron publication",
    timeout: 2 * 60 * 1_000,
    intervals: [1_000, 5_000, 10_000],
  }).toEqual({
    feedStatus: 200,
    feedReleaseId: health.lastRun.feedReleaseId,
    searchStatus: 200,
    searchRevision: health.lastRun.searchRevision,
  });

  const browserProblems = collectBrowserProblems(page);
  await page.addInitScript(() => localStorage.setItem("community-kb-locale", "en"));
  const feedResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/feed"));
  // Spec 014: the Feed is All threads at /#/<project>/threads; / opens This week.
  await page.goto("/#/kafka/threads", { waitUntil: "networkidle" });
  const feedResponse = await feedResponsePromise;
  expect(feedResponse.status()).toBe(200);
  // /api/feed exceeds Chromium's inspector body cache (~10 MB), so read it outside the page.
  const feed = await (await request.get("/api/feed")).json() as {
    readonly entries: readonly { readonly projectKey: string }[];
    readonly metadata: { readonly manifest: { readonly releaseId: string } };
  };
  expect(feed.metadata.manifest.releaseId).toBe(health.lastRun.feedReleaseId);
  await expect(page.locator("#view-feed")).toBeVisible();

  const searchResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/search?") && response.url().includes("Kafka"));
  await page.locator("#q").fill("Kafka Streams");
  const searchResponse = await searchResponsePromise;
  expect(searchResponse.status()).toBe(200);
  const search = await searchResponse.json() as {
    readonly results: readonly { readonly entry: { readonly projectId: string } }[];
    readonly facets: { readonly projects: readonly { readonly projectId: string; readonly count: number }[] };
    readonly retrieval: { readonly indexRevision: string };
  };
  expect(search.retrieval.indexRevision).toBe(health.lastRun.searchRevision);
  const kafkaFacet = search.facets.projects.find((facet) => facet.projectId === "apache-kafka")?.count ?? 0;
  const dataFusionFacet = search.facets.projects.find((facet) => facet.projectId === "apache-datafusion")?.count ?? 0;
  expect(kafkaFacet).toBeGreaterThan(0);
  expect(kafkaFacet).toBeLessThan(feed.entries.filter((entry) => entry.projectKey === "kafka").length);
  expect(dataFusionFacet).toBeLessThan(feed.entries.filter((entry) => entry.projectKey === "datafusion").length);
  await expect(page.locator(".search-card").first()).toBeVisible();

  const kafkaProject = page.getByRole("button", { name: /Apache Kafka/ });
  await expect(kafkaProject).toContainText(String(kafkaFacet));
  await expect(page.getByRole("button", { name: /Apache DataFusion/ })).toContainText(String(dataFusionFacet));
  const filteredResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/search?") && response.url().includes("projectId=apache-kafka"));
  await kafkaProject.click();
  const filteredResponse = await filteredResponsePromise;
  expect(filteredResponse.status()).toBe(200);
  const filtered = await filteredResponse.json() as typeof search;
  expect(filtered.results.length).toBeGreaterThan(0);
  expect(filtered.results.every((result) => result.entry.projectId === "apache-kafka")).toBe(true);

  const detailResponsePromise = page.waitForResponse((response) => response.url().includes("/api/search-detail/"));
  await page.locator(".search-card").first().click();
  expect((await detailResponsePromise).status()).toBe(200);
  await expect(page).toHaveURL(/#\/search\/sdr1\./);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.locator(".timeline .tl-item").count()).toBeGreaterThan(0);
  expect(browserProblems).toEqual([]);
});

test("H42: Search serves the lexical revision the publisher last wrote, and at @2 an identifier needs no hyphen", async ({ request, publisherRequest }, testInfo) => {
  type Search = {
    readonly results: readonly { readonly entry: { readonly sourceTitleRecordId: string } }[];
    readonly retrieval: { readonly indexRevision: string; readonly lexicalRevision: string };
  };
  type Health = {
    readonly running: boolean;
    readonly lastRun: null | { readonly ok: boolean; readonly searchRevision?: string; readonly search?: { readonly lexicalRevision: string } };
  };
  const search = async (query: string) => {
    const response = await request.get(`/api/search?q=${encodeURIComponent(query)}&limit=20`);
    expect(response.status(), query).toBe(200);
    return await response.json() as Search;
  };
  // One release for all three reads: retry when a publication switches the pointer in between.
  let hyphenated: Search | undefined;
  let plain: Search | undefined;
  let health: Health | undefined;
  await expect.poll(async () => {
    hyphenated = await search("KIP-770");
    plain = await search("KIP770");
    const response = await publisherRequest.get(`${workerUrl}/health`);
    health = response.status() === 200 ? await response.json() as Health : undefined;
    return health?.running === false && health.lastRun?.ok === true &&
      plain.retrieval.indexRevision === hyphenated.retrieval.indexRevision &&
      health.lastRun.searchRevision === hyphenated.retrieval.indexRevision;
  }, {
    message: "wait for Search and /health to name the same completed release",
    timeout: 15 * 60 * 1_000,
    intervals: [1_000, 5_000, 10_000],
  }).toBe(true);

  const served = hyphenated!.retrieval.lexicalRevision;
  // Spec 017: `@3` indexes like `@2` and ranks differently; the reader serves all three.
  expect(["bm25-reference@1", "bm25-reference@2", "bm25-reference@3"]).toContain(served);
  // What the reader serves is what the publisher says it wrote.
  expect(health!.lastRun!.search?.lexicalRevision).toBe(served);
  testInfo.annotations.push({ type: "lexicalRevision", description: served });
  if (served === "bm25-reference@1") {
    // The first deploy after the switch runs before the next hourly publication; a rollback
    // (variable removed) also lands here. `/health` `lastRun.search` is the runtime check.
    console.log(`Dev Search still serves ${served}; the @2 identifier check is skipped until an @2 release is current`);
    return;
  }
  const roots = (body: Search) => body.results.map((result) => result.entry.sourceTitleRecordId);
  expect(roots(plain!)).toEqual(roots(hyphenated!));
  // Spec 017 N17 is observed, not asserted: which thread ranks first depends on what is inside
  // the Feed window, so no ranking check on live content stays true. Record the evidence only.
  const words = await search("request manager");
  testInfo.annotations.push({ type: `request manager at ${words.retrieval.lexicalRevision}, first three`, description: roots(words).slice(0, 3).join(" ") });
});

test("H52: the Dev publisher reports search embedding enabled with no configuration error", async ({ publisherRequest }) => {
  // True from the deploy on, before any run: `enabled` and `configError` come from the Worker's
  // variables and bindings. Progress (`lastRun`, `pending`) depends on later hourly runs and is
  // read by hand (Spec 016 H52), not asserted here. `searchEmbedding` is null while the
  // embedding object does not answer, hence the poll.
  type Health = { readonly searchEmbedding: null | { readonly enabled: boolean; readonly configError?: string; readonly revision?: string } };
  let health: Health | undefined;
  await expect.poll(async () => {
    const response = await publisherRequest.get(`${workerUrl}/health`);
    health = response.status() === 200 ? await response.json() as Health : undefined;
    return health?.searchEmbedding?.enabled;
  }, {
    message: "wait for /health to carry the embedding object's status",
    timeout: 60 * 1_000,
    intervals: [1_000, 5_000, 10_000],
  }).toBe(true);
  expect(health!.searchEmbedding!.configError).toBeUndefined();
});

test("H32: the Dev query gate reports enabled with no configuration error, and visitors still get the lexical response", async ({ publisherRequest, request }) => {
  // True from the Worker deploy on: `enabled` and `configError` come from the Worker's variables
  // and bindings. `searchQuery` is null while the gate object does not answer, hence the poll.
  type Health = { readonly searchQuery: null | { readonly enabled: boolean; readonly configError?: string; readonly semanticRevision: string | null; readonly today: { readonly neuronCap: number; readonly indexQueryCap: number; readonly hourModelCallCap: number } } };
  let health: Health | undefined;
  await expect.poll(async () => {
    const response = await publisherRequest.get(`${workerUrl}/health`);
    health = response.status() === 200 ? await response.json() as Health : undefined;
    return health?.searchQuery?.enabled;
  }, {
    message: "wait for /health to carry the query gate's status",
    timeout: 60 * 1_000,
    intervals: [1_000, 5_000, 10_000],
  }).toBe(true);
  expect(health!.searchQuery!.configError).toBeUndefined();
  expect(health!.searchQuery!.semanticRevision).toBe("@cf/baai/bge-m3@1:1024:title-text@1");
  expect(health!.searchQuery!.today).toMatchObject({ neuronCap: 1_000, indexQueryCap: 1_000, hourModelCallCap: 100 });

  // The Pages flag is still off (the second enable PR sets it): no hybrid field, with or without `semantic=off`.
  for (const query of ["q=txn", "q=txn&semantic=off"]) {
    const body = await (await request.get(`/api/search?${query}`)).json() as { readonly retrieval: Record<string, unknown> };
    expect(Object.keys(body.retrieval).sort()).toEqual(["generatedAt", "indexRevision", "lexicalRevision", "stale"]);
  }
});

test("This week renders the digest, or the no-digest notice while Dev has no digest pointer", async ({ page, request }) => {
  const api = await request.get("/api/digest?projectId=apache-kafka&locale=en");
  // 404 until the digest job publishes on Dev (Spec 014 slice 2b); never a 5xx.
  expect([200, 404]).toContain(api.status());
  await page.addInitScript(() => localStorage.setItem("community-kb-locale", "en"));
  await page.goto("/#/kafka/");
  await expect(page.locator(".top-tabs")).toBeVisible();
  if (api.status() === 200) {
    await expect(page.locator("#digest")).toBeVisible();
    await expect(page.locator(".digest-freshness")).toBeVisible();
  } else {
    await expect(page.locator(".no-digest-notice")).toContainText("No weekly digest for this community yet");
    await expect(page.locator(".no-digest-notice a")).toHaveAttribute("href", "#/kafka/threads");
  }
});
