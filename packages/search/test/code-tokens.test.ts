import { describe, expect, test } from "bun:test";

import {
  CODE_TEXT_LEXICAL_REVISION,
  DEFAULT_LEXICAL_REVISION,
  buildLexicalIndex,
  codeTextLexicalSearchConfig,
  defaultLexicalSearchConfig,
  lexicalQueryTerms,
  lexicalShardPostings,
  lexicalTokenizer,
  parseSearchGoldenFixture,
  rankLexicalShard,
  searchLexicalIndex,
  selectLexicalResults,
  tokenizeLexical,
  type LexicalSearchConfigV1,
  type SourceRecordChunkV1,
} from "../src";
import { testPlanRows } from "./code-tokens.cases";
import { codeTextConfig, loadGoldenV2 } from "./support/golden-v2";

const goldenV1Path = new URL("./fixtures/golden-queries.v1.json", import.meta.url);
const FAMILY = ["kafka:jira:issue:KAFKA-19804", "kafka:github:pull:22747", "kafka:jira:issue:KAFKA-19738"];
const RELEASE_MANAGER = "kafka:mail:dev:release-manager-4-4-0";

function roots(chunks: readonly SourceRecordChunkV1[], config: LexicalSearchConfigV1, query: string): readonly string[] {
  const index = buildLexicalIndex({ indexRevision: "test", chunks, config });
  return searchLexicalIndex(index, { query, limit: 20 }).map((result) => result.groupRootRecordId);
}

/** Ranks through stored shard postings, as the Spec 013 reader does. */
function rankSharded(chunks: readonly SourceRecordChunkV1[], config: LexicalSearchConfigV1, query: string, maxShardChunks: number) {
  const byGroup = new Map<string, SourceRecordChunkV1[]>();
  for (const chunk of [...chunks].sort((left, right) =>
    left.projectId.localeCompare(right.projectId) || left.groupRootRecordId.localeCompare(right.groupRootRecordId) ||
    left.id.localeCompare(right.id))) {
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
  const stored = shards.map((shardChunks) => JSON.parse(JSON.stringify({
    chunks: shardChunks,
    ...lexicalShardPostings(shardChunks, config),
  })) as { chunks: SourceRecordChunkV1[]; lengths: number[]; postings: Record<string, number[]> });
  const documentFrequency = new Map<string, number>();
  for (const shard of stored) {
    for (const [term, postings] of Object.entries(shard.postings)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + postings.length / 2);
    }
  }
  const corpus = {
    chunkCount: chunks.length,
    totalChunkLength: stored.flatMap((shard) => shard.lengths).reduce((total, length) => total + length, 0),
    documentFrequency: (term: string) => documentFrequency.get(term) ?? 0,
  };
  return selectLexicalResults(stored.flatMap((shard) => rankLexicalShard(shard, corpus, { query }, config)), { limit: 20 }).results;
}

describe("Spec 016 code-text tokens (bm25-reference@2)", () => {
  test.each([...testPlanRows] as { id: string; case: string; input: string; tokens: string }[])("$id: $case", ({ input, tokens }) => {
    expect(lexicalTokenizer(CODE_TEXT_LEXICAL_REVISION)(input).join(" ")).toBe(tokens);
  });

  test("H1: a query and a document produce the same tokens for the same text", () => {
    expect(lexicalQueryTerms("HeartbeatRequestManager RequestManager", codeTextLexicalSearchConfig))
      .toEqual(["heartbeatrequestmanager", "heartbeat", "request", "manager", "requestmanager"]);
  });

  test("H2: RequestManager and request manager find the request-manager family, which @1 does not", async () => {
    const golden = await loadGoldenV2();
    for (const query of ["RequestManager", "request manager"]) {
      const before = roots(golden.chunks, defaultLexicalSearchConfig, query);
      const after = roots(golden.chunks, codeTextConfig(golden), query);
      // Positive control: @1 already finds the title that spells the two words.
      expect(FAMILY.filter((root) => !before.includes(root)).length, `${query} at @1`).toBeGreaterThan(0);
      for (const root of FAMILY) expect(after, `${query} at @2`).toContain(root);
    }
    expect(roots(golden.chunks, defaultLexicalSearchConfig, "RequestManager")).toEqual([]);
    expect(roots(golden.chunks, defaultLexicalSearchConfig, "request manager")).toContain(FAMILY[0]!);
  });

  test("H2: the Release Manager thread leaves the top 3 of the user-labelled query", async () => {
    const golden = await loadGoldenV2();
    const query = "consumer network thread request manager";
    const before = roots(golden.chunks, defaultLexicalSearchConfig, query);
    const after = roots(golden.chunks, codeTextConfig(golden), query);
    expect(before.indexOf(RELEASE_MANAGER)).toBe(2);
    expect(after.indexOf(RELEASE_MANAGER)).toBe(3);
    expect(after.slice(0, 3)).toContain("kafka:jira:issue:KAFKA-19804");
    expect(after.slice(0, 3)).toContain("kafka:jira:issue:KAFKA-19738");
  });

  test.each([1, 2, 3, 1_000])("H18: shards of at most %i chunks rank like the in-memory @2 index", async (maxShardChunks) => {
    const golden = await loadGoldenV2();
    const config = codeTextConfig(golden);
    const index = buildLexicalIndex({ indexRevision: "test", chunks: golden.chunks, config });
    for (const query of ["RequestManager", "KIP770", "770", "#770", "consumer network thread request manager", "txn", "RecordAccumulator.ready()"]) {
      const expected = searchLexicalIndex(index, { query, limit: 20 });
      expect(expected.length, query).toBeGreaterThan(0);
      expect(rankSharded(golden.chunks, config, query, maxShardChunks), query).toEqual(expected);
    }
  });

  test("H10: bm25-reference@1 stays the default and keeps its tokens", () => {
    expect(DEFAULT_LEXICAL_REVISION).toBe("bm25-reference@1");
    expect(defaultLexicalSearchConfig.revision).toBe("bm25-reference@1");
    expect(lexicalTokenizer("bm25-reference@1")).toBe(tokenizeLexical);
    // Only @2 opts in: an unknown or later revision keeps the @1 tokens.
    for (const revision of ["bm25-reference@3", "bm25:v1", ""]) {
      expect(lexicalTokenizer(revision)("HeartbeatRequestManager")).toEqual(["heartbeatrequestmanager"]);
    }
    expect(tokenizeLexical("HeartbeatRequestManager KIP770")).toEqual(["heartbeatrequestmanager", "kip770"]);
    expect(lexicalQueryTerms("HeartbeatRequestManager")).toEqual(["heartbeatrequestmanager"]);
    // Positive control: the same input does split at @2.
    expect(lexicalTokenizer(CODE_TEXT_LEXICAL_REVISION)("HeartbeatRequestManager")).toContain("manager");
  });

  test("H10: @1 postings do not change, and @2 postings differ", async () => {
    const golden = await loadGoldenV2();
    const chunk = golden.chunks.find((candidate) => candidate.recordId === "kafka:jira:issue:KAFKA-19738")!;
    const before = lexicalShardPostings([chunk]);
    expect(Object.keys(before.postings)).toContain("offsetsrequestmanager");
    expect(Object.keys(before.postings)).not.toContain("manager");
    expect(before.lengths).toEqual([75]);
    // The digest of every @1 posting of the v2 corpus, computed with origin/main 899283f.
    expect(new Bun.CryptoHasher("sha256").update(JSON.stringify(lexicalShardPostings(golden.chunks))).digest("hex"))
      .toBe("3eaa363c9b7fd5ad78aa4b48e05652b4f2bbf4a1892088f3afea1070d23f4547");
    const after = lexicalShardPostings([chunk], codeTextLexicalSearchConfig);
    expect(after.postings.manager).toEqual([0, 5]);
    expect(after.lengths[0]).toBeGreaterThan(75);
  });

  test("H10: every Phase 1 golden v1 query keeps its grade at @2", async () => {
    const golden = parseSearchGoldenFixture(await Bun.file(goldenV1Path).json());
    const index = buildLexicalIndex({ indexRevision: "test", chunks: golden.chunks, config: codeTextLexicalSearchConfig });
    const phaseOne = golden.queries.filter((candidate) => candidate.minimumPhase === 1);
    expect(phaseOne).toHaveLength(7);
    for (const query of phaseOne) {
      const results = searchLexicalIndex(index, { ...query.request, limit: query.expectation.topK });
      const found = results.map((result) => result.groupRootRecordId);
      const evidence = results.flatMap((result) => result.matches.map((match) => match.recordId));
      for (const required of query.expectation.requiredGroupRootRecordIds) expect(found, query.id).toContain(required);
      for (const forbidden of query.expectation.forbiddenGroupRootRecordIds) expect(found, query.id).not.toContain(forbidden);
      for (const required of query.expectation.requiredEvidenceRecordIds) expect(evidence, query.id).toContain(required);
    }
  });
});
