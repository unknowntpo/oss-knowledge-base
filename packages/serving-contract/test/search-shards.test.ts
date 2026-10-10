import { describe, expect, test } from "bun:test";

import { buildFeedDetail, type FeedEntry, type SourceRecordView } from "@oss-knowledge-base/domain";
import {
  buildLexicalIndex,
  lexicalSearchConfigFor,
  lexicalShardPostings,
  parseSearchGoldenFixture,
  parseSearchGoldenFixtureV2,
  rankLexicalShard,
  searchLexicalIndex,
  selectLexicalResults,
  type SourceRecordChunkV1,
} from "@oss-knowledge-base/search";

import {
  buildR2SearchProjection,
  feedProjectionObjects,
  MANIFEST_KEY,
  publishProjectionStreams,
  SEARCH_CURRENT_KEY,
  SEARCH_DETAIL_POOL,
  searchGroupsFromFeed,
  searchProjectionObjects,
  searchTermsKey,
  sha256Digest,
  type EncodedProjectionObject,
  type FeedPublication,
  type ProjectionStreams,
  type PublicationObjectStore,
  type SearchGroupSource,
  type SearchLexicalShardV2,
  type SearchTermsV1,
  type StreamedSearchRelease,
} from "../src";
import { feedFixture, fixtureGeneratedAt } from "./feed-fixture";
import { testPlanRows } from "./search-shards.cases";

const goldenPath = new URL("../../search/test/fixtures/golden-queries.v1.json", import.meta.url).pathname;
const goldenV2Path = new URL("../../search/test/fixtures/golden-queries.v2.json", import.meta.url).pathname;

const release = {
  indexRevision: "search-r1",
  corpusRevision: "corpus-r1",
  generatedAt: fixtureGeneratedAt,
} as const;

describe("Spec 013 lexical shard layout", () => {
  test.each(testPlanRows)("$id: $case", async (row) => {
    const groups = row.groups.split(" ").filter(Boolean).map((token) => {
      const [, projectId, root, chunks] = /^([^/]+)\/([^:]+):(\d+)$/u.exec(token)!;
      return groupSource(projectId!, root!, Number(chunks));
    });
    const { objects, value } = await drain(searchProjectionObjects(release, groups, {
      maxShardChunks: row.maxShardChunks,
    }));

    const layout = value.manifest.shards.map((shard, index) => {
      const body = JSON.parse(objects.get(shard.key)!) as SearchLexicalShardV2;
      expect(body.shard).toBe(index);
      expect(body.projectId).toBe(shard.projectId);
      expect(body.lengths).toHaveLength(body.chunks.length);
      return `${index} ${shard.projectId} [${body.groups.map((group) => group.groupRootRecordId).join(" ")}]`;
    });
    expect(layout.join("; ")).toBe(row.shards);
    expect(value.manifest.groupCount).toBe(groups.length);
    expect(value.manifest.chunkCount).toBe(groups.reduce((total, group) => total + group.chunks.length, 0));
    const terms = JSON.parse(objects.get(searchTermsKey(release.indexRevision))!) as SearchTermsV1;
    expect(Object.keys(terms.terms).length > 0).toBe(value.manifest.chunkCount > 0);
  });

  test("L1: shards carry postings, global statistics, and pool details for the Feed fixture", async () => {
    const { objects, value } = await drain(searchProjectionObjects(release, searchGroupsFromFeed(feedFixture())));
    const terms = JSON.parse(objects.get(searchTermsKey(release.indexRevision))!) as SearchTermsV1;
    const shards = value.manifest.shards.map((shard) => JSON.parse(objects.get(shard.key)!) as SearchLexicalShardV2);

    expect(value.manifest.schema).toBe("osskb.search-release.v3");
    expect(shards.map((shard) => shard.projectId)).toEqual(["apache-datafusion", "apache-kafka"]);
    expect(value.manifest.totalChunkLength)
      .toBe(shards.flatMap((shard) => shard.lengths).reduce((total, length) => total + length, 0));
    // "consumer" is a tag and body term of the Kafka group only: df counts chunks, shards list where.
    expect(terms.terms.consumer).toEqual([2, 1]);
    expect(shards[1]!.postings.consumer).toHaveLength(4);
    expect(shards[1]!.groups[0]).toMatchObject({ projectStatus: "open" });
    for (const group of shards.flatMap((shard) => shard.groups)) {
      expect(objects.has(`${SEARCH_DETAIL_POOL}${group.detailSha256!.slice("sha256:".length)}.json`)).toBe(true);
    }
    expect(Object.keys(value.manifest.objectDigests).sort()).toEqual(
      [...objects.keys()].filter((key) => !key.endsWith("/manifest.json")).sort(),
    );
  });

  test("L1: a repeated group is rejected", async () => {
    await expect(drain(searchProjectionObjects(release, [groupSource("kafka", "a", 1), groupSource("kafka", "a", 1)])))
      .rejects.toThrow("without repeats: a");
    await drain(searchProjectionObjects(release, [groupSource("kafka", "a", 1), groupSource("kafka", "b", 1)]));
  });

  test.each([0, -1, 1.5, Number.NaN])("L1: maxShardChunks %p is rejected", async (maxShardChunks) => {
    await expect(drain(searchProjectionObjects(release, [groupSource("kafka", "a", 1)], { maxShardChunks })))
      .rejects.toThrow("maxShardChunks must be a positive integer");
  });

  test("L1: a shard's bytes do not depend on the order of a group's chunks", async () => {
    const group = groupSource("kafka", "a", 3);
    const forward = await drain(searchProjectionObjects(release, [group]));
    const reversed = await drain(searchProjectionObjects(release, [{ ...group, chunks: [...group.chunks].reverse() }]));
    const shardKey = forward.value.manifest.shards[0]!.key;
    expect(reversed.objects.get(shardKey)).toBe(forward.objects.get(shardKey)!);
    const shard = JSON.parse(forward.objects.get(shardKey)!) as SearchLexicalShardV2;
    expect(shard.chunks.map((chunk) => chunk.id)).toEqual(["a#0", "a#1", "a#2"]);
  });

  test.each([1, 2, 3, 1_000])("L2: published statistics and shard postings score like the whole-corpus index (maxShardChunks %p)", async (maxShardChunks) => {
    const golden = parseSearchGoldenFixture(await Bun.file(goldenPath).json());
    const { objects, value } = await drain(searchProjectionObjects(release, goldenGroups(golden.chunks), { maxShardChunks }));
    const terms = JSON.parse(objects.get(searchTermsKey(release.indexRevision))!) as SearchTermsV1;
    const shards = value.manifest.shards.map((shard) => JSON.parse(objects.get(shard.key)!) as SearchLexicalShardV2);
    const index = buildLexicalIndex({ indexRevision: "golden", chunks: golden.chunks });
    if (maxShardChunks <= 2) expect(shards.length).toBeGreaterThan(3);

    expect(value.manifest.chunkCount).toBe(index.documents.length);
    expect(value.manifest.totalChunkLength).toBe(index.documents.reduce((total, document) => total + document.length, 0));
    expect(Object.fromEntries(Object.entries(terms.terms).map(([term, entry]) => [term, entry[0]])))
      .toEqual(Object.fromEntries(index.documentFrequency));
    for (const [term, entry] of Object.entries(terms.terms)) {
      expect(entry.slice(1)).toEqual(shards.flatMap((shard, number) => Object.hasOwn(shard.postings, term) ? [number] : []));
    }
    const corpus = {
      chunkCount: value.manifest.chunkCount,
      totalChunkLength: value.manifest.totalChunkLength,
      documentFrequency: (term: string) => Object.hasOwn(terms.terms, term) ? terms.terms[term]![0]! : 0,
    };
    for (const query of ["storage broker latency", "KIP-405", "aggregate optimizer schema", "the"]) {
      const request = { query, limit: 100 };
      const actual = selectLexicalResults(shards.flatMap((shard) => rankLexicalShard(shard, corpus, { query })), request);
      // Scores included: a wrong df, N, or length changes them even when the order survives.
      expect(actual.results).toEqual(searchLexicalIndex(index, request));
    }
  });

  test("L1: groups out of project and root order are rejected", async () => {
    const groups = [groupSource("kafka", "b", 1), groupSource("kafka", "a", 1)];
    await expect(drain(searchProjectionObjects(release, groups))).rejects.toThrow("ordered by project and group root");
    // Positive control: the same groups in order publish.
    await drain(searchProjectionObjects(release, [...groups].reverse()));
  });
});

describe("Spec 013 failure and retry", () => {
  test("L13: a repeated chunk id counts once, and a conflicting one fails the release", async () => {
    const group = groupSource("kafka", "a", 2);
    const repeated = { ...group, chunks: [...group.chunks, group.chunks[0]!] };
    const { value } = await drain(searchProjectionObjects(release, [repeated]));
    expect(value.manifest.chunkCount).toBe(2);

    const conflicting = { ...group, chunks: [...group.chunks, { ...group.chunks[0]!, contentHash: `sha256:${"f".repeat(64)}` }] };
    await expect(drain(searchProjectionObjects(release, [conflicting]))).rejects.toThrow("Conflicting chunks share id a#0");
  });

  test("L13: a record owned by two groups fails the release", async () => {
    const feed = feedFixture();
    const [kafka, datafusion] = feed.details;
    const reused = { ...kafka!.records[1]!, projectId: datafusion!.entry.projectId };
    const invalid = {
      ...datafusion!,
      entry: { ...datafusion!.entry, recordIds: [...datafusion!.entry.recordIds, reused.id] },
      records: [...datafusion!.records, reused],
    };
    const stream = searchProjectionObjects(release, searchGroupsFromFeed({
      index: { ...feed.index, entries: [feed.index.entries[0]!, { ...feed.index.entries[1]!, entry: invalid.entry }] },
      details: [kafka!, invalid],
    }));
    await expect(drain(stream)).rejects.toThrow("belongs to both");
  });

  test.each(["shard", "terms"] as const)("L6: a failure writing the %s leaves pointers unchanged and a rerun reuses objects", async (target) => {
    const probe = new MemoryStore();
    await publishProjectionStreams(setInput(), await streams(feedFixture()), probe);
    const writes = probe.writeOrder();
    const failAt = writes.findIndex((key) => target === "shard" ? key.includes("/lexical/") : key.endsWith("/terms.json")) + 1;
    expect(failAt).toBeGreaterThan(0);

    const destination = new MemoryStore({ failOnWrite: failAt });
    destination.seedPointers();
    const failed = await publishProjectionStreams(setInput(), await streams(feedFixture()), destination);
    expect(failed.ok).toBe(false);
    expect(destination.pointers()).toEqual(["old-search", "old-feed"]);

    const retried = await publishProjectionStreams(setInput(), await streams(feedFixture()), destination);
    expect(retried).toMatchObject({ ok: true, switchedProjections: ["search", "feed"] });
    expect(retried.ok && retried.reusedObjectCount).toBe(failAt - 1);
  });

  const edits: readonly [string, (release: StreamedSearchRelease) => StreamedSearchRelease, string][] = [
    ["the manifest omits the terms object", (value) => ({
      ...value,
      manifest: { ...value.manifest, objectDigests: withoutKey(value.manifest.objectDigests, searchTermsKey(value.manifest.indexRevision)) },
      descriptor: { ...value.descriptor, immutableObjects: value.descriptor.immutableObjects.filter((object) => !object.key.endsWith("/terms.json")) },
    }), "does not declare its terms object"],
    ["a group names an undeclared detail", (value) => ({
      ...value,
      shardGroups: new Map([...value.shardGroups].map(([key, groups]) => [key, groups.map((group) => ({
        ...group,
        detailSha256: `sha256:${"c".repeat(64)}` as const,
      }))])),
    }), "names an undeclared detail"],
    ["the group count disagrees", (value) => ({ ...value, manifest: { ...value.manifest, groupCount: value.manifest.groupCount + 1 } }), "group count does not match"],
    ["a shard is not declared", (value) => ({
      ...value,
      manifest: { ...value.manifest, shards: [...value.manifest.shards, { projectId: "apache-kafka", key: `${value.manifest.shards[0]!.key}.extra` }] },
    }), "names an undeclared shard"],
    ["a shard key is listed twice", (value) => ({
      ...value,
      manifest: { ...value.manifest, shards: [...value.manifest.shards, value.manifest.shards[0]!] },
    }), "names an undeclared shard"],
  ];

  test.each(edits)("L10: publication fails before any pointer switch when %s", async (_label, edit, message) => {
    const destination = new MemoryStore();
    destination.seedPointers();
    const input = await streams(feedFixture());
    input.search = withRelease(input.search!, edit);
    const result = await publishProjectionStreams(setInput(), input, destination);

    expect(result).toMatchObject({ ok: false, kind: "source-manifest-invalid" });
    expect(result.ok === false && result.message).toContain(message);
    expect(destination.pointers()).toEqual(["old-search", "old-feed"]);
  });

  test("L10: positive control — the unedited release switches both pointers", async () => {
    const destination = new MemoryStore();
    destination.seedPointers();
    const input = await streams(feedFixture());
    input.search = withRelease(input.search!, (value) => value);
    expect(await publishProjectionStreams(setInput(), input, destination))
      .toMatchObject({ ok: true, switchedProjections: ["search", "feed"] });
  });

  test("L11: a Feed with no entries publishes an empty, valid Search release", async () => {
    const empty: FeedPublication = { index: { ...feedFixture().index, entries: [] }, details: [] };
    const destination = new MemoryStore();
    const result = await publishProjectionStreams(setInput(), await streams(empty), destination);

    expect(result).toMatchObject({ ok: true, switchedProjections: ["search", "feed"] });
    const terms = JSON.parse(new TextDecoder().decode(destination.body(searchTermsKey("search-r1"))!)) as SearchTermsV1;
    expect(terms.terms).toEqual({});
  });
});

describe("Spec 016 lexical revision of a release", () => {
  test.each([1, 2, 1_000])("H35: bm25-reference@2 stamps the manifest and writes @2 postings and statistics (maxShardChunks %p)", async (maxShardChunks) => {
    const golden = parseSearchGoldenFixtureV2(await Bun.file(goldenV2Path).json());
    const lexical = { lexicalRevision: "bm25-reference@2", identifiers: golden.identifierProfiles };
    const config = lexicalSearchConfigFor(lexical.lexicalRevision, lexical.identifiers);
    const { objects, value } = await drain(searchProjectionObjects(release, goldenGroups(golden.chunks), { maxShardChunks, ...lexical }));
    const terms = JSON.parse(objects.get(searchTermsKey(release.indexRevision))!) as SearchTermsV1;
    const shards = value.manifest.shards.map((shard) => JSON.parse(objects.get(shard.key)!) as SearchLexicalShardV2);
    const index = buildLexicalIndex({ indexRevision: "golden", chunks: golden.chunks, config });

    expect(value.manifest.lexicalRevision).toBe("bm25-reference@2");
    expect(JSON.parse(objects.get(value.descriptor.current.releaseManifestKey)!).lexicalRevision).toBe("bm25-reference@2");
    expect(value.manifest.chunkCount).toBe(golden.chunks.length);
    expect(value.manifest.totalChunkLength).toBe(index.documents.reduce((total, document) => total + document.length, 0));
    expect(Object.fromEntries(Object.entries(terms.terms).map(([term, entry]) => [term, entry[0]])))
      .toEqual(Object.fromEntries(index.documentFrequency));
    for (const shard of shards) {
      const expected = lexicalShardPostings(shard.chunks, config);
      expect(shard.lengths).toEqual([...expected.lengths]);
      expect(shard.postings).toEqual(expected.postings);
    }
    // Code-text parts and identifiers a title or record id names are terms; `@1` has neither.
    expect(terms.terms.manager![0]).toBeGreaterThan(terms.terms.offsetsrequestmanager![0]!);
    expect(terms.terms["kip-770"]![0]).toBe(2);
    expect(terms.terms["#770"]![0]).toBe(1);

    const corpus = {
      chunkCount: value.manifest.chunkCount,
      totalChunkLength: value.manifest.totalChunkLength,
      documentFrequency: (term: string) => Object.hasOwn(terms.terms, term) ? terms.terms[term]![0]! : 0,
    };
    for (const query of ["KIP770", "770", "RequestManager", "request manager", "KIP-405"]) {
      const request = { query, limit: 100 };
      const actual = selectLexicalResults(shards.flatMap((shard) => rankLexicalShard(shard, corpus, { query }, config)), request);
      expect(actual.results.length).toBeGreaterThan(0);
      expect(actual.results).toEqual(searchLexicalIndex(index, request));
    }
  });

  test("H35: without a revision a release is bm25-reference@1, byte for byte, with or without profiles", async () => {
    const golden = parseSearchGoldenFixtureV2(await Bun.file(goldenV2Path).json());
    const plain = await drain(searchProjectionObjects(release, goldenGroups(golden.chunks), { maxShardChunks: 2 }));
    const explicit = await drain(searchProjectionObjects(release, goldenGroups(golden.chunks), {
      maxShardChunks: 2,
      lexicalRevision: "bm25-reference@1",
      identifiers: golden.identifierProfiles,
    }));
    expect(plain.value.manifest.lexicalRevision).toBe("bm25-reference@1");
    expect([...explicit.objects]).toEqual([...plain.objects]);
    const terms = JSON.parse(plain.objects.get(searchTermsKey(release.indexRevision))!) as SearchTermsV1;
    expect(Object.hasOwn(terms.terms, "kip-770")).toBe(true);
    expect(Object.hasOwn(terms.terms, "#770")).toBe(false);
    expect(Object.hasOwn(terms.terms, "manager")).toBe(true);
    expect(terms.terms.manager![0]).toBeLessThan(
      (JSON.parse((await drain(searchProjectionObjects(release, goldenGroups(golden.chunks), { lexicalRevision: "bm25-reference@2" })))
        .objects.get(searchTermsKey(release.indexRevision))!) as SearchTermsV1).terms.manager![0]!,
    );
  });

  test.each(["bm25-reference@3", "bm25:v1", ""])("H38: a release of the unknown revision %p is not written", async (lexicalRevision) => {
    const golden = parseSearchGoldenFixtureV2(await Bun.file(goldenV2Path).json());
    const groups = goldenGroups(golden.chunks);
    const stream = searchProjectionObjects(release, groups, { lexicalRevision });
    await expect(stream.next()).rejects.toThrow(`Unsupported lexical revision ${lexicalRevision}`);
    await expect(buildR2SearchProjection({ ...release, lexicalRevision, shards: [], details: [] }))
      .rejects.toThrow(`Unsupported lexical revision ${lexicalRevision}`);
    // Positive control: the same groups publish at a supported revision.
    expect((await drain(searchProjectionObjects(release, groups, { lexicalRevision: "bm25-reference@2" }))).value.manifest.groupCount)
      .toBe(groups.length);
    expect((await buildR2SearchProjection({ ...release, lexicalRevision: "bm25-reference@2", shards: [], details: [] })).length).toBeGreaterThan(0);
  });
});

/** The golden chunks as ordered Search groups, one SourceRecord per chunk record. */
function goldenGroups(chunks: readonly SourceRecordChunkV1[]): SearchGroupSource[] {
  const byRoot = new Map<string, SourceRecordChunkV1[]>();
  for (const chunk of chunks) byRoot.set(chunk.groupRootRecordId, [...byRoot.get(chunk.groupRootRecordId) ?? [], chunk]);
  return [...byRoot.values()]
    .sort((left, right) => left[0]!.projectId.localeCompare(right[0]!.projectId) ||
      left[0]!.groupRootRecordId.localeCompare(right[0]!.groupRootRecordId))
    .map((groupChunks) => {
      const root = groupChunks[0]!.groupRootRecordId;
      const projectId = groupChunks[0]!.projectId;
      const records: SourceRecordView[] = [...new Map(groupChunks.map((chunk) => [chunk.recordId, chunk])).values()]
        .map((chunk) => ({
          id: chunk.recordId,
          projectId,
          sourceInstanceId: chunk.sourceInstanceId,
          source: "github",
          sourceType: "code-host",
          kind: "record",
          role: "Community contributor",
          title: chunk.title,
          excerpt: chunk.text,
          author: chunk.author,
          occurredAt: chunk.occurredAt,
          canonicalUrl: chunk.canonicalUrl,
          sourceVersion: chunk.sourceVersion,
        }));
      if (!records.some((record) => record.id === root)) records.push({ ...records[0]!, id: root });
      const entry: FeedEntry = {
        id: `feed-entry:${root}`,
        projectId,
        title: root,
        summary: root,
        sourceTitleRecordId: root,
        recordIds: records.map((record) => record.id),
        highlightedRecordIds: [root],
        reason: { kind: "trending", label: "fixture", evidenceEventIds: [] },
        activity: { score: 1, evidenceEventIds: [] },
        grouping: { relationshipIds: [], clusteringRevision: "fixture@1" },
      };
      return { projectId, groupRootRecordId: root, entry, detail: buildFeedDetail({ entry, records }), chunks: groupChunks };
    });
}

function groupSource(projectId: string, root: string, chunkCount: number): SearchGroupSource {
  const record: SourceRecordView = {
    id: root,
    projectId,
    sourceInstanceId: `${projectId}:github`,
    source: "github",
    sourceType: "code-host",
    kind: "GitHub record",
    role: "Community contributor",
    title: `Group ${root}`,
    excerpt: `words of ${root}`,
    author: "author",
    occurredAt: fixtureGeneratedAt,
    canonicalUrl: `https://github.com/apache/example/${root}`,
    sourceVersion: `${root}:v1`,
  };
  const entry: FeedEntry = {
    id: `feed-entry:${projectId}:${root}`,
    projectId,
    title: record.title,
    summary: record.excerpt,
    sourceTitleRecordId: root,
    recordIds: [root],
    highlightedRecordIds: [root],
    reason: { kind: "trending", label: "fixture", evidenceEventIds: [] },
    activity: { score: 1, evidenceEventIds: [] },
    grouping: { relationshipIds: [], clusteringRevision: "fixture@1" },
  };
  const chunks = Array.from({ length: chunkCount }, (_, ordinal): SourceRecordChunkV1 => ({
    schema: "osskb.source-record-chunk.v1",
    id: `${root}#${ordinal}`,
    projectId,
    sourceInstanceId: record.sourceInstanceId,
    recordId: root,
    groupRootRecordId: root,
    ordinal,
    title: record.title,
    text: `${root} chunk ${ordinal} shared`,
    canonicalUrl: record.canonicalUrl,
    author: record.author,
    occurredAt: record.occurredAt,
    sourceVersion: record.sourceVersion,
    tags: [],
    contentHash: `sha256:${String(ordinal).padStart(64, "0")}`,
  }));
  return { projectId, groupRootRecordId: root, entry, detail: buildFeedDetail({ entry, records: [record] }), chunks };
}

async function drain(
  stream: AsyncGenerator<EncodedProjectionObject, StreamedSearchRelease>,
): Promise<{ readonly objects: Map<string, string>; readonly value: StreamedSearchRelease }> {
  const objects = new Map<string, string>();
  for (let next = await stream.next(); ; next = await stream.next()) {
    if (next.done) return { objects, value: next.value };
    objects.set(next.value.key, new TextDecoder().decode(next.value.body));
  }
}

function setInput() {
  return {
    id: "streamed-fixture",
    generatedAt: fixtureGeneratedAt,
    inputDigest: `sha256:${"1".repeat(64)}` as const,
    materializerRevision: "fixture@1",
  };
}

async function streams(feed: FeedPublication): Promise<ProjectionStreams> {
  return {
    search: searchProjectionObjects(release, searchGroupsFromFeed(feed), { maxShardChunks: 1 }),
    feed: feedProjectionObjects(feed, "r1"),
  };
}

async function* withRelease(
  stream: AsyncGenerator<EncodedProjectionObject, StreamedSearchRelease>,
  edit: (value: StreamedSearchRelease) => StreamedSearchRelease,
): AsyncGenerator<EncodedProjectionObject, StreamedSearchRelease> {
  for (let next = await stream.next(); ; next = await stream.next()) {
    if (next.done) return edit(next.value);
    yield next.value;
  }
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

class MemoryStore implements PublicationObjectStore {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly order: string[] = [];
  private writes = 0;

  constructor(private readonly options: { readonly failOnWrite?: number } = {}) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key);
  }

  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    this.writes += 1;
    if (this.writes === this.options.failOnWrite) throw new Error(`injected failure at ${key}`);
    this.order.push(key);
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, body.slice());
    return "created";
  }

  async putVerifiedImmutableIfAbsent(object: { readonly key: string; readonly sha256: string }, body: Uint8Array): Promise<"created" | "exists"> {
    if (await sha256Digest(body) !== object.sha256) throw new Error(`checksum mismatch: ${object.key}`);
    return this.putImmutableIfAbsent(object.key, body);
  }

  async putCurrent(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body.slice());
  }

  body(key: string): Uint8Array | undefined {
    return this.objects.get(key);
  }

  writeOrder(): readonly string[] {
    return this.order;
  }

  seedPointers(): void {
    this.objects.set(SEARCH_CURRENT_KEY, new TextEncoder().encode("old-search"));
    this.objects.set(MANIFEST_KEY, new TextEncoder().encode("old-feed"));
  }

  pointers(): readonly string[] {
    return [SEARCH_CURRENT_KEY, MANIFEST_KEY].map((key) => new TextDecoder().decode(this.objects.get(key)));
  }
}
