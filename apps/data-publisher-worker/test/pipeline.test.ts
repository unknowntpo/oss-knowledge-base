import { describe, expect, test } from "bun:test";
import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import type { GitHubPollResult } from "@oss-knowledge-base/github-publisher/github-connector";
import type { SerializedReferenceStateV1 } from "@oss-knowledge-base/reference-pipeline";
import {
  FEED_DETAIL_POOL,
  MANIFEST_KEY,
  SEARCH_CURRENT_KEY,
  SEARCH_DETAIL_POOL,
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
  runDataPublication,
  type PipelineRunStatus,
  type PipelineStateRepository,
  type PublicationDestination,
} from "../src/pipeline";
import { GitHubFetchTransport } from "../src/github-transport";

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
    expect(development.triggers.crons).toEqual(["7 * * * *"]);
    expect(production.name).toBe("oss-knowledge-base-data-prod");
    expect(production.vars.PUBLICATION_ENVIRONMENT).toBe("production");
    expect(production.r2_buckets[0]?.bucket_name).toBe("oss-knowledge-base-prod");
    expect(production.triggers.crons).toEqual(["37 * * * *"]);
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

  test.each(["bm25-reference@3", "bm25-reference", "2", "true"])("H38: SEARCH_LEXICAL_REVISION %p fails the run before any write", async (value) => {
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

  test("H39: the development publisher writes bm25-reference@2; production does not set the variable and writes @1", async () => {
    const development = (await config("development")).vars as Readonly<Record<string, string>>;
    const production = (await config("production")).vars as Readonly<Record<string, string>>;
    expect(development.PUBLICATION_ENVIRONMENT).toBe("development");
    expect(development.SEARCH_LEXICAL_REVISION).toBe("bm25-reference@2");
    expect(resolveSearchLexicalRevision(development.SEARCH_LEXICAL_REVISION)).toBe("bm25-reference@2");
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
