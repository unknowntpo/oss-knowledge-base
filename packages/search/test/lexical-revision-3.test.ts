import { describe, expect, test } from "bun:test";

import {
  buildLexicalIndex,
  codeTextLexicalSearchConfig,
  defaultLexicalSearchConfig,
  evaluateGoldenFixture,
  facetLexicalIndexByProject,
  lexicalEvaluationConfiguration,
  lexicalQueryTerms,
  lexicalSearchConfigFor,
  lexicalShardPostings,
  lexicalTokenizer,
  parseSearchGoldenFixture,
  rankLexicalShard,
  searchLexicalIndex,
  selectLexicalResults,
  SUPPORTED_LEXICAL_REVISIONS,
  THREAD_PHRASE_LEXICAL_REVISION,
  threadPhraseLexicalSearchConfig,
  type LexicalSearchConfigV1,
  type SourceRecordChunkV1,
} from "../src";
import { fillerChunks, testChunk } from "./support/chunks";
import { codeTextConfig, loadGoldenV2 } from "./support/golden-v2";
import { loadRealCorpus } from "./support/real-corpus";
import { rankSharded } from "./support/sharded";

const goldenV1Path = new URL("./fixtures/golden-queries.v1.json", import.meta.url);
const sha256 = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
const PINNED_QUERIES = [
  "RequestManager", "request manager", "consumer network thread request manager", "KIP770", "KIP-770", "770", "#770",
  "txn", "KAFKA-19804", "RecordAccumulator.ready()", "release manager", "manager", "tiered storage",
];

function ranking(chunks: readonly SourceRecordChunkV1[], config: LexicalSearchConfigV1) {
  const index = buildLexicalIndex({ indexRevision: "pin", chunks, config });
  return PINNED_QUERIES.map((query) => [searchLexicalIndex(index, { query, limit: 100 }), facetLexicalIndexByProject(index, { query })]);
}

describe("Spec 017 bm25-reference@3: the revision", () => {
  test("N4: @3 indexes exactly what @2 indexes: tokens, postings, lengths, and query terms", async () => {
    const golden = await loadGoldenV2();
    const real = await loadRealCorpus();
    expect(THREAD_PHRASE_LEXICAL_REVISION).toBe("bm25-reference@3");
    for (const [chunks, identifiers] of [[golden.chunks, golden.identifierProfiles], [real.fixture.chunks, real.identifierProfiles]] as const) {
      const at2 = lexicalSearchConfigFor("bm25-reference@2", identifiers);
      const at3 = lexicalSearchConfigFor("bm25-reference@3", identifiers);
      expect(lexicalShardPostings(chunks, at3)).toEqual(lexicalShardPostings(chunks, at2));
      for (const query of PINNED_QUERIES) expect(lexicalQueryTerms(query, at3)).toEqual(lexicalQueryTerms(query, at2));
    }
    expect(lexicalTokenizer("bm25-reference@3")("HeartbeatRequestManager KIP770"))
      .toEqual(lexicalTokenizer("bm25-reference@2")("HeartbeatRequestManager KIP770"));
    // Positive control: @1 does index differently.
    expect(lexicalShardPostings(golden.chunks, defaultLexicalSearchConfig)).not.toEqual(lexicalShardPostings(golden.chunks, codeTextLexicalSearchConfig));
  });

  test.each([1, 2, 3, 1_000])("N4: shards of at most %i chunks rank like the in-memory @3 index", async (maxShardChunks) => {
    const golden = await loadGoldenV2();
    const config = lexicalSearchConfigFor("bm25-reference@3", golden.identifierProfiles);
    const index = buildLexicalIndex({ indexRevision: "test", chunks: golden.chunks, config });
    for (const query of PINNED_QUERIES) {
      const expected = searchLexicalIndex(index, { query, limit: 20 });
      const sharded = rankSharded(golden.chunks, config, query, maxShardChunks);
      expect(sharded.results, query).toEqual(expected);
      expect(sharded.projectFacets, query).toEqual(facetLexicalIndexByProject(index, { query }));
    }
    expect(searchLexicalIndex(index, { query: "request manager", limit: 20 }).length).toBeGreaterThan(5);
  });

  test("N4: the 1,134 real chunks rank the same in shards of 50 as in one index", async () => {
    const { fixture, identifierProfiles } = await loadRealCorpus();
    const config = lexicalSearchConfigFor("bm25-reference@3", identifierProfiles);
    const index = buildLexicalIndex({ indexRevision: "test", chunks: fixture.chunks, config });
    for (const { request } of fixture.queries) {
      const expected = searchLexicalIndex(index, { query: request.query, limit: 20 });
      expect(expected.length, request.query).toBeGreaterThan(0);
      expect(rankSharded(fixture.chunks, config, request.query, 50).results, request.query).toEqual(expected);
    }
  });

  test("N7: @1 and @2 postings and rankings are what origin/main e9984d0 produces", async () => {
    const golden = await loadGoldenV2();
    const real = await loadRealCorpus();
    // Digests computed with packages/search/src of e9984d0, the commit before Spec 017.
    expect(sha256(lexicalShardPostings(golden.chunks, defaultLexicalSearchConfig)))
      .toBe("3eaa363c9b7fd5ad78aa4b48e05652b4f2bbf4a1892088f3afea1070d23f4547");
    expect(sha256(ranking(golden.chunks, defaultLexicalSearchConfig)))
      .toBe("9f20a3aa089fa09afc1cefd9517078b8aa86f45f1bd4d9585b7acd946988e21f");
    expect(sha256(lexicalShardPostings(golden.chunks, codeTextConfig(golden))))
      .toBe("0bad69cb7ed8611518121b50dba50c169b9225141d34026efc413343ff96be15");
    expect(sha256(ranking(golden.chunks, codeTextConfig(golden))))
      .toBe("3fb91753e5468be1b493b0bb92c7777335bd4ddea7115ff909bd3a5951791e32");
    // The real snapshot at @2 (a refreshed snapshot needs these two recomputed at e9984d0).
    const at2 = lexicalSearchConfigFor("bm25-reference@2", real.identifierProfiles);
    expect(sha256(lexicalShardPostings(real.fixture.chunks, at2)))
      .toBe("a6f40d66c150f9b26a13e6317d7f10cf71da7c8fec60207fbf36df5523b536be");
    const shard = { chunks: real.fixture.chunks, ...lexicalShardPostings(real.fixture.chunks, at2) };
    const own = {
      chunkCount: shard.chunks.length,
      totalChunkLength: shard.lengths.reduce((total, length) => total + length, 0),
      documentFrequency: (term: string) => (shard.postings[term]?.length ?? 0) / 2,
    };
    expect(sha256(PINNED_QUERIES.map((query) => selectLexicalResults(rankLexicalShard(shard, own, { query }, at2), { limit: 100 }))))
      .toBe("0cdddc1c8bf7281b8d7de23f1f84b350efcde50580e73c70877fb95e5aeec469");
    // Positive control: @3 ranks the same chunks differently.
    expect(sha256(ranking(golden.chunks, lexicalSearchConfigFor("bm25-reference@3", golden.identifierProfiles))))
      .not.toBe("3fb91753e5468be1b493b0bb92c7777335bd4ddea7115ff909bd3a5951791e32");
  });

  test("N7: the configs of @1 and @2 carry neither Spec 017 field, and @1 is still the default", () => {
    expect(lexicalSearchConfigFor("bm25-reference@1")).toBe(defaultLexicalSearchConfig);
    expect(lexicalSearchConfigFor("bm25-reference@2")).toBe(codeTextLexicalSearchConfig);
    for (const config of [defaultLexicalSearchConfig, codeTextLexicalSearchConfig]) {
      expect(Object.keys(config)).not.toContain("furtherChunkWeighting");
      expect(Object.keys(config)).not.toContain("phraseWeight");
    }
    expect(SUPPORTED_LEXICAL_REVISIONS).toEqual(["bm25-reference@1", "bm25-reference@2", "bm25-reference@3"]);
    expect(lexicalSearchConfigFor("bm25-reference@3")).toBe(threadPhraseLexicalSearchConfig);
    expect(threadPhraseLexicalSearchConfig).toEqual({
      ...codeTextLexicalSearchConfig, revision: "bm25-reference@3", furtherChunkWeighting: "geometric", phraseWeight: 1,
    });
  });

  test("N8: no golden v2 query is worse at @3 than at @2, and no golden v1 query loses its grade", async () => {
    const golden = await loadGoldenV2();
    const report = await evaluateGoldenFixture(golden, ["bm25-reference@2", "bm25-reference@3"].map((revision) =>
      lexicalEvaluationConfiguration(revision, golden.chunks, lexicalSearchConfigFor(revision, golden.identifierProfiles))));
    const [before, after] = report.configurations as [typeof report.configurations[number], typeof report.configurations[number]];
    expect(before.queries).toHaveLength(16);
    let improved = 0;
    for (const [index, old] of before.queries.entries()) {
      const now = after.queries[index]!;
      expect(now.recallAt20, old.queryId).toBeGreaterThanOrEqual(old.recallAt20);
      expect(now.mrr, old.queryId).toBeGreaterThanOrEqual(old.mrr);
      expect(now.ndcgAt10, old.queryId).toBeGreaterThanOrEqual(old.ndcgAt10);
      if (old.status === "pass") expect(now.status, old.queryId).toBe("pass");
      if (now.ndcgAt10 > old.ndcgAt10) improved += 1;
    }
    // The three request-manager queries improve; the 25-chunk fixture cannot show more.
    expect(improved).toBe(3);
    expect([before.lexicalQueries.mrr, after.lexicalQueries.mrr]).toEqual([0.8077, 0.9231]);
    expect([before.lexicalQueries.ndcgAt10, after.lexicalQueries.ndcgAt10]).toEqual([0.9042, 0.9587]);

    const v1 = parseSearchGoldenFixture(await Bun.file(goldenV1Path).json());
    const index = buildLexicalIndex({ indexRevision: "test", chunks: v1.chunks, config: threadPhraseLexicalSearchConfig });
    const phaseOne = v1.queries.filter((candidate) => candidate.minimumPhase === 1);
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

  test("N12: neither Spec 017 change can be switched on for @1 or @2, and a bad value is rejected", () => {
    const chunks = [...fillerChunks];
    const build = (config: LexicalSearchConfigV1) => () => buildLexicalIndex({ indexRevision: "test", chunks, config });
    for (const base of [defaultLexicalSearchConfig, codeTextLexicalSearchConfig]) {
      expect(build({ ...base, phraseWeight: 1 })).toThrow(`require bm25-reference@3, not ${base.revision}`);
      expect(build({ ...base, furtherChunkWeighting: "geometric" })).toThrow(`require bm25-reference@3, not ${base.revision}`);
      expect(() => lexicalShardPostings(chunks, { ...base, phraseWeight: 1 })).toThrow("require bm25-reference@3");
      expect(() => lexicalQueryTerms("request manager", { ...base, phraseWeight: 1 })).toThrow("require bm25-reference@3");
    }
    for (const phraseWeight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(build({ ...threadPhraseLexicalSearchConfig, phraseWeight })).toThrow("phraseWeight must be a positive number");
    }
    expect(build({ ...threadPhraseLexicalSearchConfig, furtherChunkWeighting: "sum" as "geometric" })).toThrow("must be geometric");
    for (const revision of ["bm25-reference@4", "bm25-reference@03", "bm25-reference@3 ", ""]) {
      expect(() => lexicalSearchConfigFor(revision)).toThrow(`Unsupported lexical revision ${revision}`);
    }
    // Positive control: the shipped configs build.
    for (const config of [defaultLexicalSearchConfig, codeTextLexicalSearchConfig, threadPhraseLexicalSearchConfig]) {
      expect(build(config)).not.toThrow();
    }
  });
});

describe("Spec 017 bm25-reference@3: what does not change", () => {
  test("N14: an exact identifier match stays first, whatever phrase bonus another thread earns", async () => {
    const { identifierProfiles } = await loadGoldenV2();
    const config = lexicalSearchConfigFor("bm25-reference@3", identifierProfiles);
    const chunks = [
      ...Array.from({ length: 100 }, (_, index) => testChunk(`other-${index}`, `Topic ${index}`, `Discussion number ${index}.`)),
      testChunk("exact", "Notes on a buffer limit, as proposed in KIP-770", "A long record about many other things than the proposal named in its title. ".repeat(4)),
      // Not exact: its title names another KIP and writes `kip 770`, which is not a spelling of the identifier.
      testChunk("loud", "KIP-771 follows kip 770", "kip 770 again."),
    ];
    const search = (revision: string) => searchLexicalIndex(
      buildLexicalIndex({ indexRevision: "test", chunks, config: lexicalSearchConfigFor(revision, identifierProfiles) }),
      { query: "KIP770", limit: 20 },
    );
    const results = search("bm25-reference@3");
    expect(results.map((result) => [result.groupRootRecordId, result.exactMatch])).toEqual([
      ["test:record:exact", true],
      ["test:record:loud", false],
    ]);
    // The loud record earns the phrase bonus and outscores the exact one before the exact boost.
    expect(results[1]!.score).toBeGreaterThan(search("bm25-reference@2")[1]!.score);
    expect(results[1]!.score).toBeGreaterThan(results[0]!.score - config.exactBoost);
    expect(results[0]!.score).toBeGreaterThan(config.exactBoost);
  });

  test("N14: the matching threads, project facets, filters, and limit are those of @2; only the order differs", async () => {
    const { fixture, identifierProfiles } = await loadRealCorpus();
    const at2 = buildLexicalIndex({ indexRevision: "test", chunks: fixture.chunks, config: lexicalSearchConfigFor("bm25-reference@2", identifierProfiles) });
    const at3 = buildLexicalIndex({ indexRevision: "test", chunks: fixture.chunks, config: lexicalSearchConfigFor("bm25-reference@3", identifierProfiles) });
    let reordered = 0;
    for (const query of ["request manager", "SortMergeJoinExec", "KIP770", "release manager", "txn"]) {
      expect(facetLexicalIndexByProject(at3, { query }), query).toEqual(facetLexicalIndexByProject(at2, { query }));
      const filters = { projectIds: ["apache-datafusion"] };
      const before = searchLexicalIndex(at2, { query, limit: 100 });
      const after = searchLexicalIndex(at3, { query, limit: 100 });
      if (before.length < 100) {
        expect(after.map((result) => result.groupRootRecordId).sort(), query).toEqual(before.map((result) => result.groupRootRecordId).sort());
      }
      expect(after.filter((result) => result.exactMatch).length, query).toBe(before.filter((result) => result.exactMatch).length);
      const filtered = searchLexicalIndex(at3, { query, filters, limit: 100 });
      expect(filtered.every((result) => result.projectId === "apache-datafusion"), query).toBeTrue();
      expect(filtered.length, query).toBe(Math.min(100, facetLexicalIndexByProject(at3, { query })["apache-datafusion"] ?? 0));
      expect(searchLexicalIndex(at3, { query, limit: 3 }), query).toEqual(after.slice(0, 3));
      if (JSON.stringify(after.map((result) => result.groupRootRecordId)) !== JSON.stringify(before.map((result) => result.groupRootRecordId))) reordered += 1;
    }
    expect(reordered).toBeGreaterThan(0);
  });

  test("N14: equal scores are ordered by thread id, and two runs give the same answer", () => {
    const twins = ["b", "c", "a"].map((key) => testChunk(`twin-${key}`, "Request manager cleanup", "The same text."));
    const chunks = [...fillerChunks, ...twins];
    const run = () => searchLexicalIndex(buildLexicalIndex({ indexRevision: "test", chunks, config: threadPhraseLexicalSearchConfig }), { query: "request manager", limit: 20 });
    const results = run();
    expect(new Set(results.slice(0, 3).map((result) => result.score)).size).toBe(1);
    expect(results.slice(0, 3).map((result) => result.groupRootRecordId))
      .toEqual(["test:record:twin-a", "test:record:twin-b", "test:record:twin-c"]);
    expect(run()).toEqual(results);
    expect(rankSharded([...chunks].reverse(), threadPhraseLexicalSearchConfig, "request manager", 2).results).toEqual(results);
  });

  test("N14: a one-word query has no pair: its chunk scores are the @2 scores", async () => {
    const { fixture, identifierProfiles } = await loadRealCorpus();
    const score = (revision: string, query: string) => {
      const index = buildLexicalIndex({ indexRevision: "test", chunks: fixture.chunks, config: lexicalSearchConfigFor(revision, identifierProfiles) });
      return new Map(searchLexicalIndex(index, { query, limit: 100 }).flatMap((result) => result.matches.map((match) => [match.chunkId, match.score] as const)));
    };
    for (const query of ["txn", "770", "manager"]) {
      const before = score("bm25-reference@2", query);
      const after = score("bm25-reference@3", query);
      expect(after.size, query).toBeGreaterThan(0);
      for (const [chunkId, value] of after) if (before.has(chunkId)) expect(value, `${query} ${chunkId}`).toBe(before.get(chunkId)!);
    }
    // Positive control: a two-word query does change chunk scores.
    const before = score("bm25-reference@2", "request manager");
    const after = score("bm25-reference@3", "request manager");
    expect([...after].some(([chunkId, value]) => before.has(chunkId) && value > before.get(chunkId)!)).toBeTrue();
  });
});
