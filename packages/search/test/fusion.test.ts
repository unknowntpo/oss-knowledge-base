import { describe, expect, test } from "bun:test";

import {
  DEFAULT_FUSION_REVISION,
  buildLexicalIndex,
  createInMemorySemanticRetriever,
  fuseRankings,
  hybridSearch,
  searchLexicalIndex,
  semanticRevisionId,
  type LexicalSearchResultV1,
  type SemanticCandidateV1,
  type SemanticRetriever,
} from "../src";
import { FAKE_SEMANTIC_REVISION, fakeEmbed, fakeSemanticRetriever } from "./support/fake-embedder";
import { codeTextConfig, loadGoldenV2 } from "./support/golden-v2";

function lexical(groupRootRecordId: string, exactMatch = false, projectId = "p"): LexicalSearchResultV1 {
  return { groupRootRecordId, projectId, score: 1, exactMatch, matches: [] };
}

function candidate(groupRootRecordId: string, chunk = "0", projectId = "p"): SemanticCandidateV1 {
  return { chunkId: `${groupRootRecordId}#${chunk}`, recordId: `${groupRootRecordId}/r${chunk}`, groupRootRecordId, projectId, score: 0.5 };
}

function retriever(candidates: readonly SemanticCandidateV1[]): SemanticRetriever {
  return { retrieve: async () => ({ semanticRevision: "fake@1", candidates }) };
}

const order = (results: readonly { readonly groupRootRecordId: string }[]) => results.map((result) => result.groupRootRecordId);

describe("Spec 016 reciprocal-rank fusion", () => {
  test("H6: a group's score is the sum of 1 / (60 + rank) over the rankings that hold it", () => {
    const fused = fuseRankings({
      lexical: [lexical("a"), lexical("b"), lexical("c")],
      semantic: [candidate("c"), candidate("d"), candidate("a")],
    });
    // a: 1/61 + 1/63, c: 1/63 + 1/61, b: 1/62, d: 1/62. a and c tie: lexical rank decides.
    expect(order(fused)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 63, 15);
    expect(fused[1]!.score).toBeCloseTo(1 / 61 + 1 / 63, 15);
    expect(fused[2]!.score).toBeCloseTo(1 / 62, 15);
    expect(fused[3]!.score).toBeCloseTo(1 / 62, 15);
    expect(fused.map((result) => result.signals)).toEqual([
      { lexicalRank: 1, semanticRank: 3, fusedRank: 1 },
      { lexicalRank: 3, semanticRank: 1, fusedRank: 2 },
      { lexicalRank: 2, fusedRank: 3 },
      { semanticRank: 2, fusedRank: 4 },
    ]);
    expect(fused[3]!.lexical).toBeUndefined();
    expect(fused[0]!.lexical).toEqual(lexical("a"));
  });

  test("H6: a group found by both retrievers outranks a group found by one at a better rank", () => {
    const fused = fuseRankings({ lexical: [lexical("a"), lexical("b")], semantic: [candidate("b")] });
    expect(order(fused)).toEqual(["b", "a"]);
    // k matters: with a tiny k the first lexical rank wins again.
    const sharp = fuseRankings({
      lexical: [lexical("a"), lexical("b"), lexical("c")],
      semantic: [candidate("x"), candidate("y"), candidate("c")],
      config: { revision: "rrf-test", k: 0.01, maxSemanticMatches: 5 },
    });
    expect(order(sharp).slice(0, 2)).toEqual(["a", "x"]);
  });

  test("H6: semantic chunks merge by thread, keep their passages, and rank the thread once", () => {
    const fused = fuseRankings({
      lexical: [],
      semantic: [candidate("t1", "0"), candidate("t2", "0"), candidate("t1", "1"), candidate("t1", "0"), candidate("t3", "0")],
      config: { revision: DEFAULT_FUSION_REVISION, k: 60, maxSemanticMatches: 2 },
    });
    expect(order(fused)).toEqual(["t1", "t2", "t3"]);
    expect(fused.map((result) => result.signals.semanticRank)).toEqual([1, 2, 3]);
    expect(fused[0]!.semanticMatches.map((match) => match.chunkId)).toEqual(["t1#0", "t1#1"]);
    expect(fused[0]!.semanticMatches[0]!.recordId).toBe("t1/r0");
    const capped = fuseRankings({
      lexical: [],
      semantic: [candidate("t1", "0"), candidate("t1", "1"), candidate("t1", "2")],
      config: { revision: DEFAULT_FUSION_REVISION, k: 60, maxSemanticMatches: 2 },
    });
    expect(capped[0]!.semanticMatches).toHaveLength(2);
  });

  test("H6: fusion is deterministic and breaks remaining ties by group id", () => {
    const input = { lexical: [], semantic: [candidate("b"), candidate("a")] } as const;
    expect(fuseRankings(input)).toEqual(fuseRankings(input));
    // Two groups that only one ranking holds at the same rank cannot occur; equal sums can.
    const tied = fuseRankings({ lexical: [lexical("z")], semantic: [candidate("y")] });
    expect(order(tied)).toEqual(["z", "y"]);
  });

  test("H19: invalid fusion input is rejected", () => {
    expect(() => fuseRankings({ lexical: [lexical("a"), lexical("a")], semantic: [] })).toThrow("repeats group a");
    expect(() => fuseRankings({ lexical: [lexical("a", false, "p")], semantic: [candidate("a", "0", "q")] })).toThrow("is in p and q");
    expect(() => fuseRankings({ lexical: [], semantic: [], config: { revision: "x", k: 0, maxSemanticMatches: 5 } })).toThrow("k must be positive");
    expect(() => fuseRankings({ lexical: [], semantic: [], config: { revision: " ", k: 60, maxSemanticMatches: 5 } })).toThrow("revision");
    expect(() => fuseRankings({ lexical: [], semantic: [], config: { revision: "x", k: 60, maxSemanticMatches: 0 } })).toThrow("maxSemanticMatches");
    expect(fuseRankings({ lexical: [], semantic: [] })).toEqual([]);
  });

  test("H7: an exact identifier match stays first when fusion would rank another group higher", () => {
    // Without the rule, b (1/62 + 1/61) would outrank the exact match a (1/61).
    const fused = fuseRankings({ lexical: [lexical("a", true), lexical("b")], semantic: [candidate("b"), candidate("c")] });
    expect(order(fused)).toEqual(["a", "b", "c"]);
    expect(fused[0]!.exactMatch).toBeTrue();
    // Positive control: the same rankings without the exact flag put b first.
    expect(order(fuseRankings({ lexical: [lexical("a"), lexical("b")], semantic: [candidate("b"), candidate("c")] })))
      .toEqual(["b", "a", "c"]);
    // A semantic-only group is never exact.
    expect(fused[2]!.exactMatch).toBeFalse();
  });

  test("H7: on the golden corpus KIP770 keeps its exact matches first under hybrid search", async () => {
    const golden = await loadGoldenV2();
    const index = buildLexicalIndex({ indexRevision: "test", chunks: golden.chunks, config: codeTextConfig(golden) });
    const lexicalResults = searchLexicalIndex(index, { query: "KIP770", limit: 50 });
    // A retriever that prefers everything except the exact matches.
    const adversarial = retriever(golden.chunks
      .filter((chunk) => !["kafka:github:pull:22458", "kafka:mail:dev:kip-770-discuss"].includes(chunk.groupRootRecordId))
      .map((chunk) => ({ chunkId: chunk.id, recordId: chunk.recordId, groupRootRecordId: chunk.groupRootRecordId, projectId: chunk.projectId, score: 1 })));
    const { results, retrieval } = await hybridSearch({ query: "KIP770", lexical: lexicalResults, semantic: adversarial });
    expect(retrieval.semantic).toBe("ok");
    expect(order(results).slice(0, 2)).toEqual(["kafka:github:pull:22458", "kafka:mail:dev:kip-770-discuss"]);
    expect(results.slice(0, 2).every((result) => result.exactMatch)).toBeTrue();
    expect(results[2]!.exactMatch).toBeFalse();
  });
});

describe("Spec 016 hybrid search fallback", () => {
  const lexicalResults = [lexical("a"), lexical("b"), lexical("c")];

  test("H11: without a semantic retriever the lexical results pass through in order", async () => {
    const output = await hybridSearch({ query: "q", lexical: lexicalResults, limit: 2 });
    expect(order(output.results)).toEqual(["a", "b"]);
    expect(output.results.map((result) => result.lexical)).toEqual(lexicalResults.slice(0, 2));
    expect(output.retrieval).toEqual({ fusionRevision: "rrf-group@1", semantic: "disabled" });
    // Positive control: with a retriever the same call is hybrid and reorders.
    const hybrid = await hybridSearch({ query: "q", lexical: lexicalResults, semantic: retriever([candidate("c")]), limit: 2 });
    expect(order(hybrid.results)).toEqual(["c", "a"]);
    expect(hybrid.retrieval).toEqual({ fusionRevision: "rrf-group@1", semanticRevision: "fake@1", semantic: "ok" });
  });

  test("H11: passthrough keeps the lexical order on the golden corpus for every v2 query", async () => {
    const golden = await loadGoldenV2();
    const index = buildLexicalIndex({ indexRevision: "test", chunks: golden.chunks, config: codeTextConfig(golden) });
    let compared = 0;
    for (const query of golden.queries) {
      const expected = searchLexicalIndex(index, { ...query.request, limit: 20 });
      const output = await hybridSearch({ query: query.request.query, lexical: expected, limit: 20 });
      expect(output.results.map((result) => result.lexical), query.id).toEqual([...expected]);
      compared += expected.length;
    }
    expect(compared).toBeGreaterThan(40);
  });

  const brokenRetrievers: readonly (readonly [string, { readonly retrieve: () => unknown }, string])[] = [
    ["rejects", { retrieve: async () => { throw new Error("vector store unavailable"); } }, "vector store unavailable"],
    ["throws synchronously", { retrieve: () => { throw new Error("no binding"); } }, "no binding"],
    ["rejects with a non-error", { retrieve: () => Promise.reject("quota") }, "quota"],
    ["returns no candidate list", { retrieve: async () => ({ semanticRevision: "fake@1" }) }, "Semantic retriever returned a malformed answer"],
    ["returns no revision", { retrieve: async () => ({ candidates: [] }) }, "Semantic retriever returned a malformed answer"],
    ["returns nothing", { retrieve: async () => undefined }, "Semantic retriever returned a malformed answer"],
  ];

  test.each(brokenRetrievers)("H12: a retriever that %s falls back to lexical results", async (_case, broken, message) => {
    const output = await hybridSearch({ query: "q", lexical: lexicalResults, semantic: broken as unknown as SemanticRetriever });
    expect(order(output.results)).toEqual(["a", "b", "c"]);
    expect(output.retrieval).toEqual({ fusionRevision: "rrf-group@1", semantic: "failed", semanticError: message });
  });

  test("H12: an embedding of the wrong size fails the retriever, and search falls back", async () => {
    const golden = await loadGoldenV2();
    const wrongSize = createInMemorySemanticRetriever({
      revision: { ...FAKE_SEMANTIC_REVISION, dimensions: 1024 },
      chunks: golden.chunks,
      embed: fakeEmbed,
    });
    const output = await hybridSearch({ query: "txn", lexical: lexicalResults, semantic: wrongSize });
    expect(output.retrieval.semantic).toBe("failed");
    expect(output.retrieval.semanticError).toBe("Embedding has 4 dimensions, expected 1024");
    expect(order(output.results)).toEqual(["a", "b", "c"]);
  });

  test("H13: a retriever slower than the timeout falls back and is aborted", async () => {
    let signal: AbortSignal | undefined;
    const slow: SemanticRetriever = {
      retrieve: (request) => {
        signal = request.signal;
        return new Promise(() => {});
      },
    };
    const startedAt = performance.now();
    const output = await hybridSearch({ query: "q", lexical: lexicalResults, semantic: slow, timeoutMs: 20 });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(order(output.results)).toEqual(["a", "b", "c"]);
    expect(output.retrieval).toEqual({ fusionRevision: "rrf-group@1", semantic: "timed-out" });
    expect(signal?.aborted).toBeTrue();
    // Positive control: the same retriever shape answering in time is used and not aborted.
    let fastSignal: AbortSignal | undefined;
    const fast: SemanticRetriever = {
      retrieve: async (request) => {
        fastSignal = request.signal;
        return { semanticRevision: "fake@1", candidates: [candidate("c")] };
      },
    };
    const hybrid = await hybridSearch({ query: "q", lexical: lexicalResults, semantic: fast, timeoutMs: 20 });
    expect(hybrid.retrieval.semantic).toBe("ok");
    expect(order(hybrid.results)[0]).toBe("c");
    expect(fastSignal?.aborted).toBeFalse();
  });

  test("H14: semantic candidates outside the project filter or the eligible groups are dropped", async () => {
    const semantic = retriever([candidate("other", "0", "q"), candidate("closed"), candidate("c")]);
    const byProject = await hybridSearch({ query: "q", lexical: lexicalResults, semantic, filters: { projectIds: ["p"] } });
    expect(order(byProject.results)).toEqual(["c", "a", "closed", "b"]);
    const byEligibility = await hybridSearch({
      query: "q",
      lexical: lexicalResults,
      semantic,
      eligibleGroupRootRecordIds: new Set(["a", "b", "c", "other"]),
    });
    // c: 1/63 + 1/62. a and other: 1/61 each, lexical rank first. b: 1/62.
    expect(order(byEligibility.results)).toEqual(["c", "a", "other", "b"]);
    const both = await hybridSearch({
      query: "q",
      lexical: lexicalResults,
      semantic,
      filters: { projectIds: ["p"] },
      eligibleGroupRootRecordIds: new Set(["a", "b", "c", "other"]),
    });
    expect(order(both.results)).toEqual(["c", "a", "b"]);
    // Positive control: without the filter and eligibility the same candidates are fused.
    const open = await hybridSearch({ query: "q", lexical: lexicalResults, semantic });
    expect(order(open.results)).toEqual(["c", "a", "other", "b", "closed"]);
  });

  test("H14: the retriever receives the query, the filters and the candidate depth", async () => {
    const seen: unknown[] = [];
    const recording: SemanticRetriever = {
      retrieve: async ({ signal: _signal, ...request }) => {
        seen.push(request);
        return { semanticRevision: "fake@1", candidates: [] };
      },
    };
    await hybridSearch({ query: "txn", lexical: [], semantic: recording, filters: { projectIds: ["p"] }, semanticDepth: 7 });
    await hybridSearch({ query: "txn", lexical: [], semantic: recording });
    expect(seen).toEqual([{ query: "txn", filters: { projectIds: ["p"] }, limit: 7 }, { query: "txn", limit: 50 }]);
  });

  test("H19: invalid limits, depths and timeouts are rejected", async () => {
    await expect(hybridSearch({ query: "q", lexical: [], limit: 0 })).rejects.toThrow("between 1 and 100");
    await expect(hybridSearch({ query: "q", lexical: [], limit: 101 })).rejects.toThrow("between 1 and 100");
    await expect(hybridSearch({ query: "q", lexical: [], timeoutMs: 0 })).rejects.toThrow("timeout must be positive");
    await expect(hybridSearch({ query: "q", lexical: [], semanticDepth: 0 })).rejects.toThrow("depth must be a positive integer");
    expect((await hybridSearch({ query: "q", lexical: [], limit: 100 })).results).toEqual([]);
  });
});

describe("Spec 016 in-memory semantic retriever", () => {
  test("H5: it ranks chunks by cosine similarity and reports its revision", async () => {
    const golden = await loadGoldenV2();
    const semantic = fakeSemanticRetriever(golden.chunks);
    const { semanticRevision, candidates } = await semantic.retrieve({ query: "交易逾時", limit: 10 });
    expect(semanticRevision).toBe("fake-concepts@1:4:title-text@1");
    expect(semanticRevision).toBe(semanticRevisionId(FAKE_SEMANTIC_REVISION));
    // KAFKA-20785 names both concepts (cosine 1); KAFKA-20734 names one (cosine 1/sqrt(2)).
    expect(candidates.map((item) => item.groupRootRecordId)).toEqual(["kafka:jira:issue:KAFKA-20785", "kafka:jira:issue:KAFKA-20734"]);
    expect(candidates[0]!.score).toBeCloseTo(1, 12);
    expect(candidates[1]!.score).toBeCloseTo(Math.SQRT1_2, 12);
    expect(candidates[0]).toEqual({
      chunkId: "chunk:kafka:jira:issue:KAFKA-20785:0",
      recordId: "kafka:jira:issue:KAFKA-20785",
      groupRootRecordId: "kafka:jira:issue:KAFKA-20785",
      projectId: "apache-kafka",
      score: candidates[0]!.score,
    });
    expect((await semantic.retrieve({ query: "交易逾時", limit: 1 })).candidates).toHaveLength(1);
    expect((await semantic.retrieve({ query: "unrelated words", limit: 10 })).candidates).toEqual([]);
  });

  test("H5: equal similarities rank by chunk id, whatever order the chunks arrive in", async () => {
    const golden = await loadGoldenV2();
    const constant = (chunks: typeof golden.chunks) => createInMemorySemanticRetriever({
      revision: { ...FAKE_SEMANTIC_REVISION, dimensions: 1 },
      chunks,
      embed: () => [1],
    });
    const forward = await constant(golden.chunks).retrieve({ query: "q", limit: 100 });
    const reversed = await constant([...golden.chunks].reverse()).retrieve({ query: "q", limit: 100 });
    const ids = golden.chunks.map((chunk) => chunk.id).sort((left, right) => left.localeCompare(right));
    expect(forward.candidates.map((item) => item.chunkId)).toEqual(ids);
    expect(reversed.candidates).toEqual(forward.candidates);
  });

  test("H5: it applies the evidence filters", async () => {
    const golden = await loadGoldenV2();
    const semantic = fakeSemanticRetriever(golden.chunks);
    const all = await semantic.retrieve({ query: "txn", limit: 10 });
    expect(all.candidates).toHaveLength(2);
    const after = await semantic.retrieve({ query: "txn", limit: 10, filters: { occurredAfter: "2026-10-01T00:00:00Z" } });
    expect(after.candidates.map((item) => item.recordId)).toEqual(["kafka:jira:issue:KAFKA-20734"]);
    const otherProject = await semantic.retrieve({ query: "txn", limit: 10, filters: { projectIds: ["apache-datafusion"] } });
    expect(otherProject.candidates).toEqual([]);
    await expect(semantic.retrieve({ query: "txn", limit: 0 })).rejects.toThrow("positive integer");
  });
});
