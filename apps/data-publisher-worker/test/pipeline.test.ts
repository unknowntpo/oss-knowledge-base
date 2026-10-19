import { describe, expect, test } from "bun:test";
import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import type { GitHubPollResult } from "@oss-knowledge-base/github-publisher/github-connector";
import type { SerializedReferenceStateV1 } from "@oss-knowledge-base/reference-pipeline";
import {
  FEED_DETAIL_POOL,
  MANIFEST_KEY,
  SEARCH_CURRENT_KEY,
  SEARCH_DETAIL_POOL,
  searchReleaseHasShardRoots,
  searchShardForGroupRoot,
  searchTermsKey,
  type PublicationObjectStore,
  type SearchCurrentPointerV1,
  type SearchLexicalShardV2,
  type SearchReleaseManifestV3,
  type SearchTermsV1,
} from "@oss-knowledge-base/serving-contract";

import { createInMemoryReleaseView, VectorizeSemanticRetriever } from "@oss-knowledge-base/semantic-vectorize";
import { FakeVectorIndex } from "@oss-knowledge-base/semantic-vectorize/testing";

import fixture from "../../../packages/reference-pipeline/test/fixtures/github-events.v1.json";
import { runSearchEmbedding } from "../src/search-embedding/run";
import { EmbeddingState } from "../src/search-embedding/state";
import { FakeEmbedder, MemoryStorage, PROFILE } from "./support/search-embedding";
import { healthBody } from "../src/health";
import {
  resolveSearchLexicalRevision,
  resolveSearchShardRoots,
  runDataPublication,
  type PipelineRunStatus,
  type PipelineStateRepository,
  type PublicationDestination,
} from "../src/pipeline";
import { GitHubFetchTransport } from "../src/github-transport";
import { R2PublicationDestination } from "../src/r2-destination";
import { CountingR2Bucket } from "./support/counting-r2-bucket";

describe("Cloudflare data publication", () => {
  test.each([500, 502, 503, 504, 524])("bounds retries for HTTP %s", async (status) => {
    let attempts = 0;
    const transport = new GitHubFetchTransport("github_pat_test", {
      fetchImpl: async () => {
        attempts += 1;
        return new Response("temporary", { status });
      },
      delay: async () => undefined,
    });
    await expect(transport.getJson("https://api.github.com/repos/apache/kafka/issues"))
      .rejects.toThrow(`GitHub API ${status}`);
    expect(attempts).toBe(3);
  });

  test.each([401, 403, 404, 429])("does not retry HTTP %s", async (status) => {
    let attempts = 0;
    const transport = new GitHubFetchTransport("github_pat_test", {
      fetchImpl: async () => {
        attempts += 1;
        return new Response("rejected", { status });
      },
      delay: async () => { throw new Error("unexpected retry"); },
    });
    await expect(transport.getJson("https://api.github.com/repos/apache/kafka/issues"))
      .rejects.toThrow(status === 403 || status === 429 ? "GitHub rate limit" : `GitHub API ${status}`);
    expect(attempts).toBe(1);
  });

  test("retries transient GitHub gateway failures without calling them rate limits", async () => {
    const statuses = [524, 503, 200];
    const delays: number[] = [];
    const transport = new GitHubFetchTransport("github_pat_test", {
      fetchImpl: async (_input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const status = statuses.shift() ?? 500;
        return Response.json(status === 200 ? [{ id: 1 }] : { error: "temporary" }, { status });
      },
      delay: async (milliseconds) => { delays.push(milliseconds); },
    });

    await expect(transport.getJson("https://api.github.com/repos/apache/kafka/issues"))
      .resolves.toEqual([{ id: 1 }]);
    expect(delays).toEqual([250, 500]);

    const failing = new GitHubFetchTransport("github_pat_test", {
      fetchImpl: async () => Response.json({ error: "gateway" }, { status: 502 }),
      delay: async () => undefined,
    });
    await expect(failing.getJson("https://api.github.com/repos/apache/kafka/issues"))
      .rejects.toThrow("GitHub API 502");
  });

  test("keeps development and production deployment boundaries disjoint", async () => {
    const development = await config("development");
    const production = await config("production");

    expect(development.name).toBe("oss-knowledge-base-data-dev");
    expect(development.vars.PUBLICATION_ENVIRONMENT).toBe("development");
    expect(development.r2_buckets[0]?.bucket_name).toBe("oss-knowledge-base-dev");
    // The publisher's cron, then the digest's (`DIGEST_CRON`, Spec 014 D86).
    expect(development.triggers.crons).toEqual(["7 22 * * *", "47 22 * * *"]);
    expect(production.name).toBe("oss-knowledge-base-data-prod");
    expect(production.vars.PUBLICATION_ENVIRONMENT).toBe("production");
    expect(production.r2_buckets[0]?.bucket_name).toBe("oss-knowledge-base-prod");
    expect(production.triggers.crons).toEqual(["37 22 * * *"]);
    expect(development.name).not.toBe(production.name);
    expect(development.r2_buckets[0]?.bucket_name).not.toBe(production.r2_buckets[0]?.bucket_name);
  });

  test("publishes immutable objects before pointers and commits state last", async () => {
    const state = new MemoryState();
    const destination = new MemoryDestination();
    const events = fixture.events as DomainEventV1[];

    const result = await runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: connectorSuccess(events),
      state,
      destination,
    });

    expect(result.ok).toBe(true);
    expect(state.value.events.length).toBe(events.length);
    expect(state.value.checkpoint?.sources["kafka:github"]?.updatedAt).toBeDefined();
    expect(destination.objects.has(MANIFEST_KEY)).toBe(true);
    expect(destination.objects.has(SEARCH_CURRENT_KEY)).toBe(true);
    const searchPointer = destination.operations.indexOf(`current:${SEARCH_CURRENT_KEY}`);
    const lastSearchImmutable = destination.operations.findLastIndex((operation) =>
      operation.startsWith("immutable:public/search/v1/"));
    const feedPointer = destination.operations.indexOf(`current:${MANIFEST_KEY}`);
    const lastFeedImmutable = destination.operations.findLastIndex((operation) =>
      operation.startsWith("immutable:public/v2/"));
    expect(searchPointer).toBeGreaterThan(lastSearchImmutable);
    expect(feedPointer).toBeGreaterThan(lastFeedImmutable);
    expect(destination.operations.at(-1)?.startsWith("evidence:")).toBe(true);
  });

  test("a partial GitHub poll keeps pointers and checkpoint unchanged", async () => {
    const state = new MemoryState();
    const destination = new MemoryDestination();
    destination.objects.set(MANIFEST_KEY, new TextEncoder().encode("old-feed"));
    destination.objects.set(SEARCH_CURRENT_KEY, new TextEncoder().encode("old-search"));

    const result = await runDataPublication({
      environment: "production",
      materializedAt: "2026-09-02T10:00:00.000Z",
      connector: {
        poll: async (): Promise<GitHubPollResult> => ({
          complete: false,
          events: [],
          failureKind: "rate-limit",
          error: "GitHub API 403",
          retryAfterSeconds: 300,
        }),
      },
      state,
      destination,
    });

    expect(result).toMatchObject({ ok: false, failureKind: "rate-limit" });
    expect(new TextDecoder().decode(destination.objects.get(MANIFEST_KEY))).toBe("old-feed");
    expect(new TextDecoder().decode(destination.objects.get(SEARCH_CURRENT_KEY))).toBe("old-search");
    expect(state.value.events).toEqual([]);
    expect(destination.operations).toEqual([]);
  });

  test("rerunning the same scheduled timestamp is idempotent", async () => {
    const state = new MemoryState();
    const destination = new MemoryDestination();
    const events = fixture.events as DomainEventV1[];
    const connector = connectorSuccess(events);
    const input = {
      environment: "development" as const,
      materializedAt: fixture.config.materializedAt,
      connector,
      state,
      destination,
    };

    const first = await runDataPublication(input);
    const objectCount = destination.objects.size;
    const second = await runDataPublication(input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(destination.objects.size).toBe(objectCount);
    if (second.ok) expect(second.copiedObjectCount).toBe(0);
  });

  test("C1: a later release of the same content writes no new detail objects", async () => {
    const destination = new MemoryDestination();
    const events = fixture.events as DomainEventV1[];
    const first = await publishAt(destination, events, fixture.config.materializedAt);
    destination.operations.length = 0;

    const second = await publishAt(destination, events, laterHour(fixture.config.materializedAt));

    expect(first.ok && second.ok).toBe(true);
    expect(createdDetails(destination, FEED_DETAIL_POOL)).toEqual([]);
    expect(createdDetails(destination, SEARCH_DETAIL_POOL)).toEqual([]);
    expect(destination.operations.filter((operation) => operation.startsWith("immutable:")).length).toBeGreaterThan(0);
  });

  test("C2: one changed thread writes exactly one new Feed and one new Search detail", async () => {
    const destination = new MemoryDestination();
    const events = fixture.events as DomainEventV1[];
    await publishAt(destination, events, fixture.config.materializedAt);
    destination.operations.length = 0;
    const changed = events.map((event): DomainEventV1 => event.entityId === "kafka:github:issue:42"
      ? { ...event, data: { ...event.data, excerpt: "The coordinator recovery path is now bounded." } } as DomainEventV1
      : event);

    const second = await publishAt(destination, changed, laterHour(fixture.config.materializedAt));

    expect(second.ok).toBe(true);
    expect(createdDetails(destination, FEED_DETAIL_POOL)).toHaveLength(1);
    expect(createdDetails(destination, SEARCH_DETAIL_POOL)).toHaveLength(1);
  });
});

describe("Spec 008 R2 operations of a publication (2026-10 Class A incident)", () => {
  // Every put is billed as Class A, also one whose if-none-match precondition fails.
  const POINTER_AND_EVIDENCE_WRITES = 3;

  async function publishToBucket(bucket: CountingR2Bucket, events: readonly DomainEventV1[], materializedAt: string) {
    const state = new MemoryState();
    const status = await runDataPublication({
      environment: "development",
      materializedAt,
      connector: connectorSuccess(events),
      state,
      destination: new R2PublicationDestination(bucket.asBucket(), async () => undefined),
    });
    return { status, state };
  }

  test("C8: a publication over an unchanged corpus spends Class A operations only on the objects it writes", async () => {
    const bucket = new CountingR2Bucket();
    const events = fixture.events as DomainEventV1[];
    const { status: first } = await publishToBucket(bucket, events, fixture.config.materializedAt);
    if (!first.ok) throw new Error(first.error);
    // Positive control: a first release writes every object, each with one put.
    expect(first.reusedObjectCount).toBe(0);
    expect(bucket.classA).toBe(first.copiedObjectCount + POINTER_AND_EVIDENCE_WRITES);
    const poolObjects = [...bucket.objects.keys()].filter((key) => key.includes("/objects/details/")).length;
    expect(poolObjects).toBeGreaterThan(0);
    bucket.reset();

    const { status: second } = await publishToBucket(bucket, events, laterHour(fixture.config.materializedAt));

    if (!second.ok) throw new Error(second.error);
    expect(second.reusedObjectCount).toBe(poolObjects);
    expect(second.copiedObjectCount).toBeGreaterThan(0);
    expect(bucket.classA).toBe(second.copiedObjectCount + POINTER_AND_EVIDENCE_WRITES);
    expect(bucket.count("put", FEED_DETAIL_POOL) + bucket.count("put", SEARCH_DETAIL_POOL)).toBe(0);
    // One existence check per object, the two pointer reads, and the evidence read.
    expect(bucket.classB).toBe(second.copiedObjectCount + second.reusedObjectCount + POINTER_AND_EVIDENCE_WRITES);
    expect(bucket.maxInFlight).toBeLessThanOrEqual(16);
    expect(bucket.maxInFlight).toBeGreaterThan(1);
  });

  test("C8: a changed thread costs one put per new object; each new object is put once with if-none-match and its sha256", async () => {
    const bucket = new CountingR2Bucket();
    const events = fixture.events as DomainEventV1[];
    await publishToBucket(bucket, events, fixture.config.materializedAt);
    bucket.reset();
    const changed = events.map((event): DomainEventV1 => event.entityId === "kafka:github:issue:42"
      ? { ...event, data: { ...event.data, excerpt: "The coordinator recovery path is now bounded." } } as DomainEventV1
      : event);

    const { status } = await publishToBucket(bucket, changed, laterHour(fixture.config.materializedAt));

    if (!status.ok) throw new Error(status.error);
    const detailPuts = bucket.calls.filter((call) => call.op === "put" && call.key.includes("/objects/details/"));
    expect(detailPuts).toHaveLength(2);
    for (const put of detailPuts) {
      expect(new Headers(put.options!.onlyIf as HeadersInit).get("if-none-match")).toBe("*");
      expect(put.key.endsWith(`/${put.options!.sha256 as string}.json`)).toBe(true);
    }
    expect(new Set(bucket.calls.filter((call) => call.op === "put").map((call) => call.key)).size).toBe(bucket.classA);
    expect(bucket.classA).toBe(status.copiedObjectCount + POINTER_AND_EVIDENCE_WRITES);
  });

  test("C8: an existing release key with different bytes still fails the run as a destination conflict and keeps the pointers", async () => {
    const bucket = new CountingR2Bucket();
    const events = fixture.events as DomainEventV1[];
    await publishToBucket(bucket, events, fixture.config.materializedAt);
    const later = laterHour(fixture.config.materializedAt);
    const pointers = [MANIFEST_KEY, SEARCH_CURRENT_KEY].map((key) => bucket.objects.get(key));
    const probe = new CountingR2Bucket();
    await publishToBucket(probe, events, later);
    const releaseKey = [...probe.objects.keys()].find((key) => key.endsWith("/feed/index.json") && !bucket.objects.has(key))!;
    bucket.objects.set(releaseKey, new TextEncoder().encode("{\"other\":true}"));

    const { status } = await publishToBucket(bucket, events, later);

    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.error).toContain("destination-conflict");
    expect([MANIFEST_KEY, SEARCH_CURRENT_KEY].map((key) => bucket.objects.get(key))).toEqual(pointers);
    expect(new TextDecoder().decode(bucket.objects.get(releaseKey))).toBe("{\"other\":true}");
  });

  test("C8: an existing pool key is reused by name without reading it back", async () => {
    const bucket = new CountingR2Bucket();
    const events = fixture.events as DomainEventV1[];
    await publishToBucket(bucket, events, fixture.config.materializedAt);
    bucket.reset();

    const { status } = await publishToBucket(bucket, events, laterHour(fixture.config.materializedAt));

    expect(status.ok).toBe(true);
    expect(bucket.count("get", FEED_DETAIL_POOL) + bucket.count("get", SEARCH_DETAIL_POOL)).toBe(0);
    expect(bucket.count("head", FEED_DETAIL_POOL) + bucket.count("head", SEARCH_DETAIL_POOL)).toBeGreaterThan(0);
  });

  test("C9: /health lastRun.r2 reports the Class A and Class B requests the run made, also for a failed run", async () => {
    const bucket = new CountingR2Bucket();
    const events = fixture.events as DomainEventV1[];
    const { status, state } = await publishToBucket(bucket, events, fixture.config.materializedAt);

    expect(status.r2).toEqual({ classA: bucket.classA, classB: bucket.classB });
    expect(status.r2!.classA).toBeGreaterThan(0);
    const health = healthBody({ environment: "development", running: false, scheduled: false, phase: undefined, status: state.statuses.at(-1) });
    expect(health.lastRun?.r2).toEqual(status.r2!);

    bucket.reset();
    bucket.failures.push(...[1, 2, 3].map(() => ({ op: "put" as const, message: "put: internal error (10001)" })));
    const failed = await publishToBucket(bucket, events, laterHour(fixture.config.materializedAt));
    expect(failed.status.ok).toBe(false);
    expect(failed.status.r2).toEqual({ classA: bucket.classA, classB: bucket.classB });
    expect(failed.status.r2!.classA).toBeGreaterThanOrEqual(3);
  });

  test("C9: lastRun.r2 counts one run, also when a destination serves several runs", async () => {
    const bucket = new CountingR2Bucket();
    const destination = new R2PublicationDestination(bucket.asBucket(), async () => undefined);
    const events = fixture.events as DomainEventV1[];
    const run = (materializedAt: string) => runDataPublication({
      environment: "development", materializedAt, connector: connectorSuccess(events), state: new MemoryState(), destination,
    });
    await run(fixture.config.materializedAt);
    bucket.reset();

    const second = await run(laterHour(fixture.config.materializedAt));

    expect(second.r2).toEqual({ classA: bucket.classA, classB: bucket.classB });
  });

  test("C9: a destination that does not count requests leaves the status without r2", async () => {
    const status = await publishAt(new MemoryDestination(), fixture.events as DomainEventV1[], fixture.config.materializedAt);
    expect(status.ok).toBe(true);
    expect("r2" in status).toBe(false);
  });
});

describe("Spec 009 bounded-memory publication", () => {
  test("M4: a failed immutable write keeps both pointers, and a rerun reuses the objects written", async () => {
    const state = new MemoryState();
    const destination = new MemoryDestination();
    const events = fixture.events as DomainEventV1[];
    const first = await runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: connectorSuccess(events),
      state,
      destination,
    });
    expect(first.ok).toBe(true);
    const pointers = () => [MANIFEST_KEY, SEARCH_CURRENT_KEY].map((key) => new TextDecoder().decode(destination.objects.get(key)));
    const previousPointers = pointers();
    const changed = events.map((event): DomainEventV1 => event.entityId === "kafka:github:issue:42"
      ? { ...event, data: { ...event.data, excerpt: "The coordinator recovery path is now bounded." } } as DomainEventV1
      : event);
    const rerun = {
      environment: "development" as const,
      materializedAt: laterHour(fixture.config.materializedAt),
      connector: connectorSuccess(changed),
      state: new MemoryState(),
      destination,
    };
    destination.operations.length = 0;
    destination.failOnImmutableWrite = destination.immutableWrites + 3;

    const failed = await runDataPublication(rerun);

    expect(failed).toMatchObject({ ok: false, failureKind: "pipeline" });
    expect(pointers()).toEqual(previousPointers);
    expect(rerun.state.value.events).toEqual([]);
    const writtenBeforeFailure = createdImmutables(destination);
    expect(writtenBeforeFailure.length).toBeGreaterThan(0);

    destination.operations.length = 0;
    destination.failOnImmutableWrite = undefined;
    const completed = await runDataPublication(rerun);

    expect(completed.ok).toBe(true);
    if (completed.ok) expect(completed.reusedObjectCount).toBeGreaterThanOrEqual(writtenBeforeFailure.length);
    expect(createdImmutables(destination).filter((key) => writtenBeforeFailure.includes(key))).toEqual([]);
    expect(pointers()).not.toEqual(previousPointers);
  });
});

describe("Spec 016 lexical revision of the published Search release", () => {
  const events = fixture.events as DomainEventV1[];
  const run = (destination: MemoryDestination, state: MemoryState, searchLexicalRevision: string | undefined, materializedAt = fixture.config.materializedAt) =>
    runDataPublication({
      environment: "development",
      materializedAt,
      connector: connectorSuccess(events),
      state,
      destination,
      ...(searchLexicalRevision === undefined ? {} : { searchLexicalRevision }),
    });
  const json = <T>(destination: MemoryDestination, key: string) => JSON.parse(new TextDecoder().decode(destination.objects.get(key))) as T;
  const published = (destination: MemoryDestination) => {
    const manifest = json<SearchReleaseManifestV3>(destination, json<SearchCurrentPointerV1>(destination, SEARCH_CURRENT_KEY).releaseManifestKey);
    return {
      manifest,
      terms: json<SearchTermsV1>(destination, searchTermsKey(manifest.indexRevision)).terms,
      shards: manifest.shards.map((shard) => json<SearchLexicalShardV2>(destination, shard.key)),
    };
  };

  test.each([undefined, "", "  ", "bm25-reference@1"])("H36: SEARCH_LEXICAL_REVISION %p publishes bm25-reference@1, as before", async (value) => {
    expect(resolveSearchLexicalRevision(value)).toBe("bm25-reference@1");
    const destination = new MemoryDestination();
    const unset = new MemoryDestination();
    expect((await run(destination, new MemoryState(), value)).ok).toBe(true);
    expect((await run(unset, new MemoryState(), undefined)).ok).toBe(true);
    expect(published(destination).manifest.lexicalRevision).toBe("bm25-reference@1");
    // The same objects, byte for byte, as a run that is not told a revision.
    expect([...destination.objects].map(([key, body]) => [key, new TextDecoder().decode(body)]))
      .toEqual([...unset.objects].map(([key, body]) => [key, new TextDecoder().decode(body)]));
    expect(Object.hasOwn(published(destination).terms, "#42")).toBe(false);
  });

  test("H36: SEARCH_LEXICAL_REVISION bm25-reference@2 publishes @2 postings with the community search profiles", async () => {
    expect(resolveSearchLexicalRevision(" bm25-reference@2 ")).toBe("bm25-reference@2");
    const destination = new MemoryDestination();
    const result = await run(destination, new MemoryState(), "bm25-reference@2");
    expect(result.ok).toBe(true);
    const { manifest, terms, shards } = published(destination);
    expect(manifest.lexicalRevision).toBe("bm25-reference@2");
    // The record ids name issue 42 in both projects and pull request 43; a comment title cites #42.
    expect(terms["#42"]![0]).toBe(4);
    expect(terms["#43"]![0]).toBe(1);
    expect(shards.map((shard) => `${shard.projectId} ${Object.hasOwn(shard.postings, "#42")}`))
      .toEqual(["apache-datafusion true", "apache-kafka true"]);
  });

  test("H36: a later run without the flag writes @1 again (rollback), leaving the @2 release in place", async () => {
    const destination = new MemoryDestination();
    await run(destination, new MemoryState(), "bm25-reference@2");
    const second = published(destination).manifest;
    await run(destination, new MemoryState(), undefined, laterHour(fixture.config.materializedAt));
    const third = published(destination).manifest;
    expect([second.lexicalRevision, third.lexicalRevision]).toEqual(["bm25-reference@2", "bm25-reference@1"]);
    expect(third.indexRevision).not.toBe(second.indexRevision);
    expect(json<SearchReleaseManifestV3>(destination, `public/search/v1/releases/${second.indexRevision}/manifest.json`).lexicalRevision)
      .toBe("bm25-reference@2");
  });

  test.each(["bm25-reference@4", "bm25-reference", "2", "true"])("H38: SEARCH_LEXICAL_REVISION %p fails the run before any write", async (value) => {
    expect(() => resolveSearchLexicalRevision(value)).toThrow(`SEARCH_LEXICAL_REVISION "${value}" is not a supported lexical revision`);
    const state = new MemoryState();
    const destination = new MemoryDestination();
    destination.objects.set(MANIFEST_KEY, new TextEncoder().encode("old-feed"));
    destination.objects.set(SEARCH_CURRENT_KEY, new TextEncoder().encode("old-search"));
    let polls = 0;
    const result = await runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: { poll: async () => { polls += 1; return connectorSuccess(events).poll(); } },
      state,
      destination,
      searchLexicalRevision: value,
    });

    expect(result).toMatchObject({ ok: false, failureKind: "pipeline" });
    expect(result.ok === false && result.error).toContain(`SEARCH_LEXICAL_REVISION "${value}"`);
    expect(destination.operations).toEqual([]);
    expect(polls).toBe(0);
    // The check runs before the `polling` marker, so `/health` never shows this run as polling.
    expect(state.phases).toEqual(["reading-state"]);
    expect(state.value.events).toEqual([]);
    expect(new TextDecoder().decode(destination.objects.get(SEARCH_CURRENT_KEY))).toBe("old-search");
    // `/health` carries the failure; a run with a supported value then publishes.
    expect(healthBody({ environment: "development", running: false, scheduled: false, phase: undefined, status: state.statuses.at(-1) }).lastRun)
      .toMatchObject({ ok: false, error: expect.stringContaining("SEARCH_LEXICAL_REVISION") });
    expect((await run(destination, state, "bm25-reference@2")).ok).toBe(true);
    expect(published(destination).manifest.lexicalRevision).toBe("bm25-reference@2");
    // Positive control: a supported value moves on to `polling`.
    expect(state.phases.slice(0, 3)).toEqual(["reading-state", "reading-state", "polling"]);
  });

  const runWithRoots = (destination: MemoryDestination, state: MemoryState, searchShardRoots: string | undefined) =>
    runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: connectorSuccess(events),
      state,
      destination,
      searchLexicalRevision: "bm25-reference@3",
      ...(searchShardRoots === undefined ? {} : { searchShardRoots }),
    });

  test.each([undefined, "", "  "])("H57: SEARCH_SHARD_ROOTS %p publishes every object as before, and /health names no shard roots", async (value) => {
    expect(resolveSearchShardRoots(value)).toBe(false);
    const destination = new MemoryDestination();
    const unset = new MemoryDestination();
    const result = await runWithRoots(destination, new MemoryState(), value);
    expect((await run(unset, new MemoryState(), "bm25-reference@3")).ok).toBe(true);
    expect(result.ok).toBe(true);
    expect([...destination.objects.keys()]).toEqual([...unset.objects.keys()]);
    for (const [key, body] of destination.objects) expect(Buffer.from(body).equals(Buffer.from(unset.objects.get(key)!))).toBe(true);
    expect(published(destination).manifest.shards.every((shard) => !Object.hasOwn(shard, "firstGroupRootRecordId"))).toBe(true);
    expect(result.ok && Object.hasOwn(result.search, "shardRoots")).toBe(false);
  });

  test("H57: SEARCH_SHARD_ROOTS true adds each shard's first group root to the manifest and nothing else; a later run without it leaves them out again", async () => {
    expect(resolveSearchShardRoots(" true ")).toBe(true);
    const destination = new MemoryDestination();
    const plain = new MemoryDestination();
    const state = new MemoryState();
    const result = await runWithRoots(destination, state, "true");
    expect((await runWithRoots(plain, new MemoryState(), undefined)).ok).toBe(true);
    expect(result.ok && result.search.shardRoots).toBe(true);

    const { manifest, shards } = published(destination);
    expect(manifest.shards.length).toBe(2);
    expect(manifest.shards.map((shard) => shard.firstGroupRootRecordId)).toEqual(shards.map((shard) => shard.groups[0]!.groupRootRecordId));
    expect(searchReleaseHasShardRoots(manifest)).toBe(true);
    for (const shard of shards) {
      for (const group of shard.groups) expect(searchShardForGroupRoot(manifest, shard.projectId, group.groupRootRecordId)).toBe(shard.shard);
    }
    const manifestKey = `public/search/v1/releases/${manifest.indexRevision}/manifest.json`;
    const changed = [...destination.objects].filter(([key, body]) => !Buffer.from(body).equals(Buffer.from(plain.objects.get(key) ?? new Uint8Array())))
      .map(([key]) => key);
    // The manifest, and the publication evidence, which records the manifest's digest.
    expect(changed).toEqual([manifestKey, "publication-sets/v1/github-2026-08-25T12-00-00-000Z.json"]);
    expect(healthBody({ environment: "development", running: false, scheduled: false, phase: undefined, status: state.statuses.at(-1) }).lastRun)
      .toMatchObject({ ok: true, search: { lexicalRevision: "bm25-reference@3", shardRoots: true } });

    // Turning the flag off: the next release has no roots, and the release with them stays.
    const later = await runDataPublication({
      environment: "development", materializedAt: "2026-08-25T13:00:00.000Z", connector: connectorSuccess(events), state, destination, searchLexicalRevision: "bm25-reference@3",
    });
    expect(later.ok && Object.hasOwn(later.search, "shardRoots")).toBe(false);
    expect(searchReleaseHasShardRoots(published(destination).manifest)).toBe(false);
    expect(destination.objects.has(manifestKey)).toBe(true);
  });

  test.each(["1", "yes", "TRUE", "false", "bm25-reference@3"])("H66: SEARCH_SHARD_ROOTS %p fails the run before any write", async (value) => {
    expect(() => resolveSearchShardRoots(value)).toThrow(`SEARCH_SHARD_ROOTS "${value}" is not supported`);
    const state = new MemoryState();
    const destination = new MemoryDestination();
    destination.objects.set(SEARCH_CURRENT_KEY, new TextEncoder().encode("old-search"));
    let polls = 0;
    const result = await runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: { poll: async () => { polls += 1; return connectorSuccess(events).poll(); } },
      state,
      destination,
      searchShardRoots: value,
    });
    expect(result).toMatchObject({ ok: false, failureKind: "pipeline" });
    expect(result.ok === false && result.error).toContain(`SEARCH_SHARD_ROOTS "${value}"`);
    expect(destination.operations).toEqual([]);
    expect(polls).toBe(0);
    expect(state.phases).toEqual(["reading-state"]);
    expect(new TextDecoder().decode(destination.objects.get(SEARCH_CURRENT_KEY))).toBe("old-search");
    // Positive control: the supported value publishes.
    expect((await runWithRoots(destination, state, "true")).ok).toBe(true);
  });

  test("N6: SEARCH_LEXICAL_REVISION bm25-reference@3 publishes the @2 objects under a manifest that names @3", async () => {
    expect(resolveSearchLexicalRevision(" bm25-reference@3 ")).toBe("bm25-reference@3");
    const at2 = new MemoryDestination();
    const at3 = new MemoryDestination();
    const state = new MemoryState();
    expect((await run(at2, new MemoryState(), "bm25-reference@2")).ok).toBe(true);
    const result = await run(at3, state, "bm25-reference@3");
    expect(result.ok).toBe(true);

    const { manifest, terms } = published(at3);
    expect(manifest.lexicalRevision).toBe("bm25-reference@3");
    expect({ ...manifest, lexicalRevision: "bm25-reference@2" }).toEqual(published(at2).manifest);
    expect(terms["#42"]![0]).toBe(4);
    const text = (destination: MemoryDestination) => new Map([...destination.objects].map(([key, body]) => [key, new TextDecoder().decode(body)]));
    const manifestKey = `public/search/v1/releases/${manifest.indexRevision}/manifest.json`;
    expect([...text(at3).keys()]).toEqual([...text(at2).keys()]);
    // Only the manifest and the objects that embed its digest or the run's revision differ.
    const different = [...text(at3)].filter(([key, body]) => body !== text(at2).get(key)).map(([key]) => key);
    expect(different).toContain(manifestKey);
    expect(different.filter((key) => key.includes("/lexical/") || key.endsWith("/terms.json") || key.includes("/details/"))).toEqual([]);
    // `/health` names the revision the run wrote, with the @2 sizes.
    expect(healthBody({ environment: "development", running: false, scheduled: false, phase: undefined, status: state.statuses.at(-1) }).lastRun)
      .toMatchObject({ ok: true, search: { lexicalRevision: "bm25-reference@3", chunkCount: manifest.chunkCount, shardCount: manifest.shards.length } });
  });

  test("N10: after an @3 run, a run at @2 (rollback) or without the variable writes that revision and leaves the @3 release in place", async () => {
    const destination = new MemoryDestination();
    await run(destination, new MemoryState(), "bm25-reference@3");
    const first = published(destination).manifest;
    await run(destination, new MemoryState(), "bm25-reference@2", laterHour(fixture.config.materializedAt));
    const second = published(destination).manifest;
    await run(destination, new MemoryState(), undefined, laterHour(laterHour(fixture.config.materializedAt)));
    const third = published(destination).manifest;
    expect([first.lexicalRevision, second.lexicalRevision, third.lexicalRevision])
      .toEqual(["bm25-reference@3", "bm25-reference@2", "bm25-reference@1"]);
    expect(new Set([first.indexRevision, second.indexRevision, third.indexRevision]).size).toBe(3);
    expect(json<SearchReleaseManifestV3>(destination, `public/search/v1/releases/${first.indexRevision}/manifest.json`).lexicalRevision)
      .toBe("bm25-reference@3");
  });

  test.each(["bm25-reference@4", "bm25-reference@3.1", "@3", "3"])("N10: SEARCH_LEXICAL_REVISION %p fails the run before a source is polled or an object written", async (value) => {
    expect(() => resolveSearchLexicalRevision(value)).toThrow(`SEARCH_LEXICAL_REVISION "${value}" is not a supported lexical revision (bm25-reference@1, bm25-reference@2, bm25-reference@3)`);
    const state = new MemoryState();
    const destination = new MemoryDestination();
    destination.objects.set(SEARCH_CURRENT_KEY, new TextEncoder().encode("old-search"));
    let polls = 0;
    const result = await runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: { poll: async () => { polls += 1; return connectorSuccess(events).poll(); } },
      state,
      destination,
      searchLexicalRevision: value,
    });
    expect(result).toMatchObject({ ok: false, failureKind: "pipeline" });
    expect([destination.operations, polls]).toEqual([[], 0]);
    expect(new TextDecoder().decode(destination.objects.get(SEARCH_CURRENT_KEY))).toBe("old-search");
    expect(healthBody({ environment: "development", running: false, scheduled: false, phase: undefined, status: state.statuses.at(-1) }).lastRun)
      .toMatchObject({ ok: false, error: expect.stringContaining(`SEARCH_LEXICAL_REVISION "${value}"`) });
    // Positive control: @3 then publishes from the same state and destination.
    expect((await run(destination, state, "bm25-reference@3")).ok).toBe(true);
    expect(published(destination).manifest.lexicalRevision).toBe("bm25-reference@3");
  });

  test("H39: the development publisher writes bm25-reference@3 (Spec 017 N17); production does not set the variable and writes @1", async () => {
    const development = (await config("development")).vars as Readonly<Record<string, string>>;
    const production = (await config("production")).vars as Readonly<Record<string, string>>;
    expect(development.PUBLICATION_ENVIRONMENT).toBe("development");
    expect(development.SEARCH_LEXICAL_REVISION).toBe("bm25-reference@3");
    expect(resolveSearchLexicalRevision(development.SEARCH_LEXICAL_REVISION)).toBe("bm25-reference@3");
    expect(production.PUBLICATION_ENVIRONMENT).toBe("production");
    expect(Object.hasOwn(production, "SEARCH_LEXICAL_REVISION")).toBe(false);
    expect(resolveSearchLexicalRevision(production.SEARCH_LEXICAL_REVISION)).toBe("bm25-reference@1");
  });

  test.each(["bm25-reference@1", "bm25-reference@2"])("H41: /health lastRun.search reports the %s release's revision, chunk count, and lexical bytes", async (revision) => {
    const state = new MemoryState();
    const destination = new MemoryDestination();
    const result = await run(destination, state, revision);
    const { manifest, shards } = published(destination);
    const bytes = (key: string) => destination.objects.get(key)!.byteLength;
    const shardBytes = manifest.shards.map((shard) => bytes(shard.key));

    expect(manifest.chunkCount).toBe(shards.reduce((total, shard) => total + shard.chunks.length, 0));
    expect(manifest.chunkCount).toBe(5);
    const expected = {
      lexicalRevision: revision,
      chunkCount: 5,
      shardCount: 2,
      shardBytes: shardBytes.reduce((total, value) => total + value, 0),
      largestShardBytes: Math.max(...shardBytes),
      termsBytes: bytes(searchTermsKey(manifest.indexRevision)),
    };
    expect(result).toMatchObject({ ok: true, search: expected });
    expect(healthBody({ environment: "development", running: false, scheduled: false, phase: undefined, status: state.statuses.at(-1) }).lastRun)
      .toMatchObject({ search: expected });
  });
});

describe("Spec 016 embedding after a publication", () => {
  const events = fixture.events as DomainEventV1[];
  const publish = async (extra: Partial<Parameters<typeof runDataPublication>[0]> = {}, state = new MemoryState(), destination = new MemoryDestination()) => {
    const result = await runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: connectorSuccess(events),
      state,
      destination,
      ...extra,
    });
    return { state, destination, result };
  };
  const bytes = (destination: MemoryDestination) => Object.fromEntries([...destination.objects].map(([key, body]) => [key, new TextDecoder().decode(body)]));

  test("H45: a publication with an embedding trigger writes byte-identical objects, and calls the trigger once after it is recorded", async () => {
    const plain = await publish();
    const seen: string[] = [];
    const state = new MemoryState();
    const destination = new MemoryDestination();
    const triggered = await publish({
      onPublished: async (status) => {
        // The publication is complete and recorded before the embedding object hears of it.
        seen.push(`${status.ok} recorded=${state.statuses.length} current=${destination.objects.has(SEARCH_CURRENT_KEY)} committed=${state.value.events.length > 0}`);
      },
    }, state, destination);
    expect(seen).toEqual(["true recorded=1 current=true committed=true"]);
    expect(plain.result.ok).toBe(true);
    expect(triggered.result).toEqual(plain.result);
    expect(triggered.destination.operations).toEqual(plain.destination.operations);
    expect(bytes(triggered.destination)).toEqual(bytes(plain.destination));
    expect(Object.keys(bytes(plain.destination)).length).toBeGreaterThan(10);
  });

  test("H45: a failed publication does not trigger an embedding run", async () => {
    let calls = 0;
    const failed = await publish({ searchLexicalRevision: "bm25-reference@9", onPublished: async () => { calls += 1; } });
    expect(failed.result.ok).toBe(false);
    expect(calls).toBe(0);
    const partial = await publish({
      connector: { poll: async () => ({ complete: false as const, events: [], error: "rate limited", failureKind: "rate-limit", retryAfterSeconds: 60 }) },
      onPublished: async () => { calls += 1; },
    });
    expect(partial.result.ok).toBe(false);
    expect(calls).toBe(0);
    // Positive control: the same hook is called by a publication that succeeds.
    expect((await publish({ onPublished: async () => { calls += 1; } })).result.ok).toBe(true);
    expect(calls).toBe(1);
  });

  test.each([
    ["rejects", async () => { throw new Error("embedding object unavailable"); }],
    ["throws before returning a promise", (() => { throw new Error("embedding object unavailable"); }) as unknown as () => Promise<void>],
    ["never answers", () => new Promise<void>(() => undefined)],
  ])("H23: a trigger that %s leaves the publication, its objects, and its recorded status as they are", async (_name, onPublished) => {
    const plain = await publish();
    const started = Date.now();
    const withTrigger = await publish({ onPublished, onPublishedTimeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(withTrigger.result).toEqual(plain.result);
    expect(withTrigger.result.ok).toBe(true);
    expect(withTrigger.state.statuses).toEqual([withTrigger.result]);
    expect(bytes(withTrigger.destination)).toEqual(bytes(plain.destination));
    expect(withTrigger.state.value.events.length).toBe(plain.state.value.events.length);
    expect(withTrigger.state.value.events.length).toBeGreaterThan(0);
  });

  test("H54: a failing trigger is logged without its bearer token or token-like strings", async () => {
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
    try {
      const { result } = await publish({ onPublished: async () => { throw new Error(`object said Bearer s3cr3t.t0ken ${"Zm9v+/8=".repeat(6)}`); } });
      expect(result.ok).toBe(true);
    } finally {
      console.error = realError;
    }
    expect(logged).toEqual(["after-publication hook failed: object said Bearer [redacted] [redacted]"]);
  });

  test("H21: an embedding run over the release the publisher wrote stores one vector per chunk in each project's namespace", async () => {
    const { destination, result } = await publish();
    const { manifest, shards } = (() => {
      const pointer = JSON.parse(new TextDecoder().decode(destination.objects.get(SEARCH_CURRENT_KEY)!)) as SearchCurrentPointerV1;
      const manifestValue = JSON.parse(new TextDecoder().decode(destination.objects.get(pointer.releaseManifestKey)!)) as SearchReleaseManifestV3;
      return { manifest: manifestValue, shards: manifestValue.shards.map((shard) => JSON.parse(new TextDecoder().decode(destination.objects.get(shard.key)!)) as SearchLexicalShardV2) };
    })();
    const index = new FakeVectorIndex(PROFILE.revision.dimensions);
    const model = new FakeEmbedder();
    const storage = new MemoryStorage();
    const run = () => runSearchEmbedding({
      bucket: { getJson: async (key) => { const body = destination.objects.get(key); return body === undefined ? undefined : JSON.parse(new TextDecoder().decode(body)); } },
      index, embed: model.embed, profile: PROFILE, state: new EmbeddingState(storage),
      now: () => new Date(fixture.config.materializedAt), delay: async () => undefined, dryRun: false,
    });
    const embedded = await run();

    expect(result.ok && result.search.chunkCount).toBe(5);
    expect(embedded).toMatchObject({ ok: true, releaseId: manifest.indexRevision, chunks: 5, embedded: 5, pending: 0, modelCalls: 1, storedVectors: 5 });
    const chunks = shards.flatMap((shard) => shard.chunks);
    expect(model.calls).toEqual([chunks.map((chunk) => `${chunk.title}\n${chunk.text}`)]);
    expect([...index.vectors.values()].map((vector) => `${vector.namespace} ${vector.metadata.record}`).sort())
      .toEqual(chunks.map((chunk) => `${chunk.projectId} ${chunk.recordId}`).sort());
    expect(new Set([...index.vectors.values()].map((vector) => vector.namespace))).toEqual(new Set(["apache-datafusion", "apache-kafka"]));
    for (const id of index.vectors.keys()) expect(new TextEncoder().encode(id).byteLength).toBeLessThanOrEqual(64);
    // The release is unchanged by the run, and a second run has nothing to do.
    expect((await run()).modelCalls).toBe(0);

    // A semantic match is answered with the release's own chunk.
    const retriever = new VectorizeSemanticRetriever({ index, embed: model.embed, profile: PROFILE, release: createInMemoryReleaseView(manifest.indexRevision, chunks) });
    const target = chunks[0]!;
    const { candidates } = await retriever.retrieve({ query: `${target.title} ${target.text}`, limit: 5, filters: { projectIds: [target.projectId] } });
    expect(candidates[0]).toMatchObject({ chunkId: target.id, recordId: target.recordId, groupRootRecordId: target.groupRootRecordId, projectId: target.projectId });
    expect(candidates.every((candidate) => candidate.projectId === target.projectId)).toBe(true);
  });
});

function createdImmutables(destination: MemoryDestination): readonly string[] {
  return destination.operations
    .filter((operation) => operation.startsWith("immutable:"))
    .map((operation) => operation.slice("immutable:".length));
}

async function config(environment: "development" | "production") {
  const file = Bun.file(new URL(`../wrangler.${environment}.jsonc`, import.meta.url));
  // workers-types replaces the global Blob, so BunFile loses json() when both type sets load.
  return JSON.parse(await file.text()) as {
    readonly name: string;
    readonly vars: { readonly PUBLICATION_ENVIRONMENT: string };
    readonly r2_buckets: readonly { readonly bucket_name: string }[];
    readonly triggers: { readonly crons: readonly string[] };
  };
}

async function publishAt(
  destination: MemoryDestination,
  events: readonly DomainEventV1[],
  materializedAt: string,
): Promise<PipelineRunStatus> {
  return runDataPublication({
    environment: "development",
    materializedAt,
    connector: connectorSuccess(events),
    state: new MemoryState(),
    destination,
  });
}

function laterHour(timestamp: string): string {
  return new Date(Date.parse(timestamp) + 3_600_000).toISOString();
}

function createdDetails(destination: MemoryDestination, pool: string): readonly string[] {
  return destination.operations.filter((operation) => operation.startsWith(`immutable:${pool}`));
}

function connectorSuccess(events: readonly DomainEventV1[]) {
  const watermarks = Object.fromEntries(
    [...new Set(events.map((event) => event.sourceInstanceId))].map((source) => [source, { updatedAt: "2026-08-25T08:00:00.000Z" }]),
  );
  return {
    poll: async (): Promise<GitHubPollResult> => ({
      complete: true,
      events,
      candidateCheckpoint: {
        schema: "osskb.github-checkpoint.v1",
        connectorRevision: "github@1",
        sources: watermarks,
      },
      pageCount: 4,
      truncated: false,
    }),
  };
}

class MemoryState implements PipelineStateRepository {
  value: SerializedReferenceStateV1 = { schema: "osskb.reference-state.v1", events: [] };
  statuses: PipelineRunStatus[] = [];

  async read(): Promise<SerializedReferenceStateV1> { return this.value; }
  async commit(state: SerializedReferenceStateV1): Promise<void> { this.value = state; }
  async recordStatus(status: PipelineRunStatus): Promise<void> { this.statuses.push(status); }
  phases: string[] = [];
  async recordPhase(marker: { readonly phase: string }): Promise<void> { this.phases.push(marker.phase); }
}

class MemoryDestination implements PublicationDestination, PublicationObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly operations: string[] = [];

  async get(key: string): Promise<Uint8Array | undefined> { return this.objects.get(key); }
  failOnImmutableWrite: number | undefined;
  immutableWrites = 0;

  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    this.immutableWrites += 1;
    if (this.immutableWrites === this.failOnImmutableWrite) throw new Error(`injected R2 failure at ${key}`);
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, body);
    this.operations.push(`immutable:${key}`);
    return "created";
  }
  async putCurrent(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
    this.operations.push(`current:${key}`);
  }
  async putEvidence(key: string, body: Uint8Array): Promise<void> {
    const existing = this.objects.get(key);
    if (existing !== undefined && !bytesEqual(existing, body)) throw new Error(`conflict:${key}`);
    if (existing === undefined) this.objects.set(key, body);
    this.operations.push(`evidence:${key}`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

