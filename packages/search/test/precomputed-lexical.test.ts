import { describe, expect, test } from "bun:test";

import {
  buildLexicalIndex,
  facetLexicalIndexByProject,
  lexicalShardPostings,
  parseSearchGoldenFixture,
  rankLexicalShard,
  searchLexicalIndex,
  selectLexicalResults,
  type LexicalSearchRequestV1,
  type SourceRecordChunkV1,
} from "../src";

const fixturePath = new URL("./fixtures/golden-queries.v1.json", import.meta.url);

/** Splits chunks into shards of whole groups, like the Spec 013 publisher, then ranks every shard. */
function rankSharded(
  chunks: readonly SourceRecordChunkV1[],
  request: LexicalSearchRequestV1 & { readonly limit: number },
  maxShardChunks: number,
) {
  const byGroup = new Map<string, SourceRecordChunkV1[]>();
  for (const chunk of [...chunks].sort((left, right) =>
    left.projectId.localeCompare(right.projectId) ||
    left.groupRootRecordId.localeCompare(right.groupRootRecordId))) {
    byGroup.set(chunk.groupRootRecordId, [...byGroup.get(chunk.groupRootRecordId) ?? [], chunk]);
  }
  const shards: SourceRecordChunkV1[][] = [];
  for (const group of byGroup.values()) {
    const open = shards.at(-1);
    if (open !== undefined && open[0]!.projectId === group[0]!.projectId && open.length + group.length <= maxShardChunks) {
      open.push(...group);
    } else {
      shards.push([...group]);
    }
  }
  // Round-trip through JSON, as the shard is stored in R2.
  const prepared = shards.map((shardChunks) => JSON.parse(JSON.stringify({
    chunks: shardChunks,
    ...lexicalShardPostings(shardChunks),
  })) as { chunks: SourceRecordChunkV1[]; lengths: number[]; postings: Record<string, number[]> });
  const documentFrequency = new Map<string, number>();
  let totalChunkLength = 0;
  for (const shard of prepared) {
    totalChunkLength += shard.lengths.reduce((total, length) => total + length, 0);
    for (const [term, postings] of Object.entries(shard.postings)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + postings.length / 2);
    }
  }
  const stats = {
    chunkCount: prepared.reduce((total, shard) => total + shard.chunks.length, 0),
    totalChunkLength,
    documentFrequency: (term: string) => documentFrequency.get(term) ?? 0,
  };
  return {
    shardCount: prepared.length,
    ...selectLexicalResults(prepared.flatMap((shard) => rankLexicalShard(shard, stats, request)), request),
  };
}

const requests: readonly (LexicalSearchRequestV1 & { readonly limit: number })[] = [
  { query: "KAFKA-20983", limit: 5 },
  { query: "KIP-405", limit: 5 },
  { query: "RecordAccumulator.ready()", limit: 5 },
  { query: "cleaner rewrite segment in place", limit: 10 },
  { query: "issue 20983", filters: { projectIds: ["apache-datafusion"] }, limit: 1 },
  { query: "issue 20983", filters: { projectIds: ["apache-datafusion"], occurredAfter: "2026-08-22T00:00:00Z" }, limit: 10 },
  { query: "remote storage fetch latency compacted topics", limit: 10 },
  { query: "remote storage", filters: { projectIds: ["apache-kafka"], occurredAfter: "2025-01-01T00:00:00Z", occurredBefore: "2026-08-01T00:00:00Z" }, limit: 10 },
  { query: "RecordAccumulator ready batches Sender", limit: 10 },
  { query: "the", limit: 100 },
];

describe("Spec 013 precomputed lexical shards", () => {
  test.each(requests.map((request) => [request.query, request] as const))(
    "L2: %s ranks exactly like the in-memory bm25-reference@1 index",
    async (_query, request) => {
      const golden = parseSearchGoldenFixture(await Bun.file(fixturePath).json());
      const index = buildLexicalIndex({ indexRevision: golden.indexRevision, chunks: golden.chunks });
      const expected = searchLexicalIndex(index, request);
      const { limit: _limit, ...facetRequest } = request;
      const expectedFacets = facetLexicalIndexByProject(index, facetRequest);

      for (const maxShardChunks of [1, 2, 3, 1_000]) {
        const actual = rankSharded(golden.chunks, request, maxShardChunks);
        expect(actual.results).toEqual(expected);
        expect(actual.projectFacets).toEqual(expectedFacets);
      }
      expect(rankSharded(golden.chunks, request, 2).shardCount).toBeGreaterThan(2);
    },
  );

  test("L12: terms named like Object.prototype members are ordinary terms", () => {
    const chunk = (id: string, text: string): SourceRecordChunkV1 => ({
      schema: "osskb.source-record-chunk.v1",
      id,
      projectId: "apache-kafka",
      sourceInstanceId: "kafka:github",
      recordId: `record:${id}`,
      groupRootRecordId: `record:${id}`,
      ordinal: 0,
      title: `Title ${id}`,
      text,
      canonicalUrl: `https://example.test/${id}`,
      author: "author",
      occurredAt: "2026-10-01T00:00:00Z",
      sourceVersion: "v1",
      tags: [],
      contentHash: `sha256:${id.padEnd(64, "0")}`,
    } as SourceRecordChunkV1);
    const chunks = [
      chunk("a", "constructor __proto__ hasOwnProperty toString"),
      chunk("b", "constructor appears again"),
      chunk("c", "unrelated words only"),
    ];
    const postings = lexicalShardPostings(chunks);
    expect(Object.getPrototypeOf(postings.postings)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(postings)).postings.__proto__).toEqual([0, 1]);

    const index = buildLexicalIndex({ indexRevision: "r", chunks });
    for (const query of ["constructor", "__proto__", "hasOwnProperty toString", "valueOf"]) {
      const request = { query, limit: 10 };
      const expected = searchLexicalIndex(index, request);
      const actual = rankSharded(chunks, request, 1);
      expect(actual.results).toEqual(expected);
      if (query !== "valueOf") expect(actual.results.length).toBeGreaterThan(0);
    }
  });
});
