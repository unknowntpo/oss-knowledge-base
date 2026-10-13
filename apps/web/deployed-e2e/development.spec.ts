import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

const workerUrl = process.env.DEV_WORKER_URL
  ?? "https://oss-knowledge-base-data-dev.unknowntpo.workers.dev";

/**
 * The fusion revision the committed Dev Pages configuration sets (Spec 016 H77): the deployment
 * must answer with it, so switching the revision is a change to that one file. Run from the
 * repository root, as `bun run test:e2e:development` does.
 */
const FUSION_REVISION = (JSON.parse(readFileSync(join(process.cwd(), "apps/web/wrangler.development.jsonc"), "utf8")) as { readonly vars: { readonly SEARCH_SEMANTIC: string } }).vars.SEARCH_SEMANTIC;

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

test("H32: Dev serves hybrid search: the gate is enabled, a text query carries a semantic status, an identifier and `semantic=off` never reach the gate", async ({ publisherRequest, request }, testInfo) => {
  // What this test spends at the query gate: one fixed text query (`交易逾時`), so its embedding is
  // cached after the first run ever and its matches for an hour. Per CI run: 0 model calls and
  // at most 2 index queries (one per project, when the hour-old matches have expired); the
  // first run, and a run after the 7-day embedding cache lapsed, add 1 model call (1 neuron).
  // The other tests' `Kafka Streams` and `request manager` cost the same each.
  const TEXT_QUERY = "交易逾時";
  type GateHealth = {
    readonly enabled: boolean;
    readonly configError?: string;
    readonly semanticRevision: string | null;
    readonly today: { readonly neurons: number; readonly neuronCap: number; readonly indexQueries: number; readonly indexQueryCap: number; readonly hourModelCallCap: number };
    readonly pausedUntil: string | null;
    readonly lastError: null | { readonly kind: string; readonly message: string; readonly at: string };
  };
  type Health = { readonly searchQuery: null | GateHealth };
  type Search = {
    readonly results: readonly { readonly matches: readonly { readonly signals: { readonly lexicalRank?: number; readonly semanticRank?: number; readonly semanticScore?: number; readonly fusedRank: number } }[] }[];
    readonly retrieval: {
      readonly lexicalRevision: string;
      readonly fusionRevision?: string;
      readonly semanticRevision?: string;
      readonly semantic?: { readonly status: string; readonly reason?: string; readonly candidates?: number; readonly cached?: boolean };
    };
  };
  const readHealth = async () => {
    const response = await publisherRequest.get(`${workerUrl}/health`);
    return response.status() === 200 ? await response.json() as Health : undefined;
  };
  // `/api/search` answers `max-age=30, stale-while-revalidate=120`: a cache between the test and
  // the function may hold the previous deployment's body for 150 s. The test asks for a fresh one,
  // and still waits (below) in case a cache ignores that.
  const STALE_FOR_AT_MOST_MS = 180 * 1_000;
  const search = async (query: string) => {
    const response = await request.get(`/api/search?${query}`, { headers: { "cache-control": "no-cache", pragma: "no-cache" } });
    expect(response.status(), query).toBe(200);
    return await response.json() as Search;
  };

  // The gate: true from the Worker deploy on. `searchQuery` is null while the object does not answer.
  let health: Health | undefined;
  await expect.poll(async () => {
    health = await readHealth();
    return health?.searchQuery?.enabled;
  }, { message: "wait for /health to carry the query gate's status", timeout: 60 * 1_000, intervals: [1_000, 5_000, 10_000] }).toBe(true);
  expect(health!.searchQuery!.configError).toBeUndefined();
  expect(health!.searchQuery!.semanticRevision).toBe("@cf/baai/bge-m3@1:1024:title-text@1");
  expect(health!.searchQuery!.today).toMatchObject({ neuronCap: 1_000, indexQueryCap: 1_000, hourModelCallCap: 100 });

  // An identifier query is answered lexically and never asks the gate. The field's presence also
  // shows that the Pages deployment with the flag is the one answering, hence the poll.
  let identifier: Search | undefined;
  expect(["rrf-group@1", "rrf-group@2", "rrf-group@3"]).toContain(FUSION_REVISION);
  // The status alone does not show the new deployment (the previous one skips too): the revision
  // must be the committed one. A deployment that never answers with it fails here after the bound.
  await expect.poll(async () => {
    identifier = await search("q=KIP770&limit=5");
    return `${identifier.retrieval.semantic?.status} ${identifier.retrieval.fusionRevision}`;
  }, { message: `wait for the Pages deployment that sets SEARCH_SEMANTIC=${FUSION_REVISION}`, timeout: STALE_FOR_AT_MOST_MS, intervals: [1_000, 5_000, 10_000] }).toBe(`skipped ${FUSION_REVISION}`);
  expect(identifier!.retrieval.semantic).toEqual({ status: "skipped", reason: "identifier-query" });
  expect(identifier!.retrieval.fusionRevision).toBe(FUSION_REVISION);
  expect(identifier!.retrieval.semanticRevision).toBeUndefined();

  // `semantic=off`: the lexical ranking, said to be so, with the four lexical fields unchanged.
  // Each URL is cached by itself, so this one waits for the revision too; it never reaches the gate.
  let off: Search | undefined;
  await expect.poll(async () => {
    off = await search(`q=${encodeURIComponent(TEXT_QUERY)}&limit=5&semantic=off`);
    return off.retrieval.fusionRevision;
  }, { message: `wait for semantic=off to answer with ${FUSION_REVISION}`, timeout: STALE_FOR_AT_MOST_MS, intervals: [1_000, 5_000, 10_000] }).toBe(FUSION_REVISION);
  expect(off!.retrieval.semantic).toEqual({ status: "disabled" });
  expect(Object.keys(off!.retrieval).sort()).toEqual(["fusionRevision", "generatedAt", "indexRevision", "lexicalRevision", "semantic", "stale"]);
  expect(off!.results.every((result) => result.matches.every((match) => match.signals.semanticRank === undefined && match.signals.lexicalRank !== undefined))).toBe(true);

  // A text query. Live, every one of these is a legitimate answer: a cold query may time out
  // once and be cached on its repeat, the day's budget may be spent, a release may lack shard
  // roots right after a rollback. So the same query is asked up to four times for `ok`.
  const LEGITIMATE = ["ok", "timed-out", "over-budget", "failed", "uncovered"];
  const seen: string[] = [];
  let fused: Search | undefined;
  // A body of another revision is a cached body of the previous deployment: it did not reach the
  // function or the gate, so it is waited out (within the bound) and is not one of the four attempts.
  const staleUntil = Date.now() + STALE_FOR_AT_MOST_MS;
  for (let attempt = 0; attempt < 4 && fused === undefined; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    const body = await search(`q=${encodeURIComponent(TEXT_QUERY)}&limit=5`);
    const semantic = body.retrieval.semantic;
    // Hard signals: the field is missing, or a status this query cannot have.
    expect(semantic, "retrieval.semantic").toBeDefined();
    expect(LEGITIMATE, `status ${semantic!.status}`).toContain(semantic!.status);
    if (body.retrieval.fusionRevision !== FUSION_REVISION && Date.now() < staleUntil) {
      seen.push(`stale (${body.retrieval.fusionRevision})`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      attempt -= 1;
      continue;
    }
    expect(body.retrieval.fusionRevision).toBe(FUSION_REVISION);
    seen.push(`${semantic!.status}${semantic!.cached === true ? " (cached)" : ""}`);
    if (semantic!.status === "ok") fused = body;
  }
  const after = (await readHealth())?.searchQuery ?? null;
  testInfo.annotations.push({ type: `semantic status of ${TEXT_QUERY}, per attempt`, description: seen.join(", ") });
  testInfo.annotations.push({ type: "searchQuery after", description: JSON.stringify(after === null ? null : { today: after.today, pausedUntil: after.pausedUntil, lastError: after.lastError }) });
  // A gate that lost its configuration is a hard failure whatever the statuses were.
  expect(after?.enabled, "the gate is still enabled").toBe(true);
  expect(after?.configError).toBeUndefined();
  expect(after!.today.neurons).toBeLessThanOrEqual(after!.today.neuronCap);
  expect(after!.today.indexQueries).toBeLessThanOrEqual(after!.today.indexQueryCap);
  // `failed` every time is a hard signal too: a missing Pages binding, or a model or index that
  // does not answer at all (`lastError` above says which). One `failed` among other answers is not.
  expect(seen.every((status) => status === "failed"), `every attempt failed: ${JSON.stringify(after?.lastError ?? null)}`).toBe(false);
  if (fused === undefined) {
    // Not fused in four attempts and no hard signal: recorded for whoever reads the run, not failed.
    // Persistent `timed-out`, `failed`, or a set `pausedUntil` are the revert thresholds of Spec 016
    // rollout step 3, judged by a person with `bun run measure:search-hybrid`.
    console.log(`Dev did not fuse ${TEXT_QUERY} in four attempts: ${seen.join(", ")}; searchQuery ${JSON.stringify(after)}`);
    return;
  }
  expect(fused.retrieval.semanticRevision).toBe("@cf/baai/bge-m3@1:1024:title-text@1");
  expect(typeof fused.retrieval.semantic!.candidates).toBe("number");
  expect(typeof fused.retrieval.semantic!.cached).toBe("boolean");
  // Every result was returned by lexical retrieval, semantic retrieval, or both.
  expect(fused.results.every((result) => result.matches.length > 0 && result.matches.every((match) =>
    match.signals.lexicalRank !== undefined || match.signals.semanticRank !== undefined))).toBe(true);
  expect(fused.results.map((result) => result.matches[0]!.signals.fusedRank)).toEqual(fused.results.map((_, index) => index + 1));
  // H78: a thread semantic retrieval returned reports its similarity, and no other thread does.
  // Asked again (the gate answers from its cache) for up to a minute, until the Pages deployment
  // that serves the field answers. Only a fused answer is judged: a repeat that timed out, found
  // the budget spent, or met a release without shard roots is recorded and ends the check, as in
  // the block above, so a budget that runs out mid-test cannot fail `main`.
  const scored = (body: Search) => body.results.flatMap((result) => result.matches.map((match) => match.signals)).every((signal) => (signal.semanticRank === undefined
    ? signal.semanticScore === undefined
    : typeof signal.semanticScore === "number" && signal.semanticScore > 0 && signal.semanticScore <= 1.0001));
  let similarity: "served" | "missing" | string = scored(fused) ? "served" : "missing";
  for (const wait of [2_000, 5_000, 10_000, 10_000, 10_000, 10_000, 10_000]) {
    if (similarity !== "missing") break;
    await new Promise((resolve) => setTimeout(resolve, wait));
    const body = await search(`q=${encodeURIComponent(TEXT_QUERY)}&limit=5`);
    const status = body.retrieval.semantic?.status;
    expect(LEGITIMATE, `status ${status}`).toContain(status);
    similarity = status !== "ok" ? `not judged: ${status}` : scored(body) ? "served" : "missing";
  }
  testInfo.annotations.push({ type: "signals.semanticScore", description: similarity });
  // Fused for a minute and never with a valid similarity on every semantic thread: the contract is broken.
  expect(similarity, "signals.semanticScore on a fused response").not.toBe("missing");
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
