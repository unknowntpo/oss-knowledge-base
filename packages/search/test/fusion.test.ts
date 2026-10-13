import { describe, expect, test } from "bun:test";

import {
  DEFAULT_FUSION_REVISION,
  LEADING_FULL_MATCH_FUSION_REVISION,
  SUPPORTED_FUSION_REVISIONS,
  buildLexicalIndex,
  createInMemorySemanticRetriever,
  defaultFusionConfig,
  fuseRankings,
  fusionConfigFor,
  hybridSearch,
  isFullLexicalMatch,
  leadingFullMatches,
  leadingFullMatchFusionConfig,
  lexicalHeadFusionConfig,
  lexicalQueryWords,
  lexicalSearchConfigFor,
  searchLexicalIndex,
  type LexicalSearchResultV1,
  type SemanticCandidateV1,
  type SemanticRetriever,
} from "../src";
import { FAKE_SEMANTIC_REVISION, fakeEmbed } from "./support/fake-embedder";
import { semanticRetrieverContract } from "./support/semantic-retriever-contract";
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

/** A lexical group whose returned passages matched these terms, one list a passage. */
function matched(groupRootRecordId: string, ...passages: readonly (readonly string[])[]): LexicalSearchResultV1 {
  return {
    groupRootRecordId,
    projectId: "p",
    score: 1,
    exactMatch: false,
    matches: passages.map((matchedTerms, index) => ({
      chunkId: `${groupRootRecordId}#${index}`, recordId: groupRootRecordId, excerpt: "", canonicalUrl: "", author: "", occurredAt: "", sourceVersion: "",
      matchedTerms, exactMatch: false, score: 1,
    })),
  };
}

describe("Spec 016 fusion rrf-group@2: the leading full lexical matches keep their places", () => {
  const at2 = leadingFullMatchFusionConfig;
  const words = ["transaction", "manager"];
  const both = ["transaction", "manager"];

  test("H73: threads holding every query word at the head of the lexical ranking stay there; the rest is fused as in rrf-group@1", () => {
    const input = {
      // a and b hold both words; c holds one; d holds both but comes after c.
      lexical: [matched("a", both), matched("b", both), matched("c", ["manager"]), matched("d", both)],
      semantic: [candidate("d"), candidate("c"), candidate("x"), candidate("a")],
      queryWords: words,
    };
    // @1, k = 60. a: 1/61 + 1/64. d: 1/64 + 1/61 (a tie: the lexical rank decides). c: 1/63 + 1/62.
    // b: 1/62. x: 1/63. The first lexical result that semantic retrieval missed falls to fourth.
    expect(order(fuseRankings(input))).toEqual(["a", "d", "c", "b", "x"]);
    // @2: a and b lead and hold both words, so they keep places 1 and 2; c ends the run, so d is
    // not kept; d, c, x follow by score.
    const fused = fuseRankings({ ...input, config: at2 });
    expect(order(fused)).toEqual(["a", "b", "d", "c", "x"]);
    expect(fused.map((result) => result.signals)).toEqual([
      { lexicalRank: 1, semanticRank: 4, fusedRank: 1 },
      { lexicalRank: 2, fusedRank: 2 },
      { lexicalRank: 4, semanticRank: 1, fusedRank: 3 },
      { lexicalRank: 3, semanticRank: 2, fusedRank: 4 },
      { semanticRank: 3, fusedRank: 5 },
    ]);
    // The score is still the RRF sum; only the order of the kept threads ignores it.
    expect(fused[1]!.score).toBeCloseTo(1 / 62, 15);
    expect(fused[2]!.score).toBeCloseTo(1 / 64 + 1 / 61, 15);
  });

  test("H73: a kept thread is not passed by a thread both retrievers rank well, at any depth", () => {
    // The measured failure: lexical 1 and 2 absent from 100 semantic candidates, behind 19 threads found twice.
    const lexicalRanking = [matched("first", both), matched("second", both), ...Array.from({ length: 30 }, (_, index) => matched(`l${String(index).padStart(2, "0")}`, ["manager"]))];
    const semantic = Array.from({ length: 30 }, (_, index) => candidate(`l${String(29 - index).padStart(2, "0")}`));
    const at1 = order(fuseRankings({ lexical: lexicalRanking, semantic }));
    expect(at1.indexOf("first")).toBeGreaterThan(20);
    // 1/61 = 0.0164 loses to a thread at lexical 32 and semantic 1: 1/92 + 1/61 = 0.0273.
    expect(at1[0]).toBe("l29");
    const fused = order(fuseRankings({ lexical: lexicalRanking, semantic, queryWords: words, config: at2 }));
    expect(fused.slice(0, 3)).toEqual(["first", "second", "l29"]);
    expect(fused.slice(2)).toEqual(at1.filter((id) => id !== "first" && id !== "second"));
  });

  test("H73: a full match is one passage holding every word, not words spread over passages", () => {
    expect(isFullLexicalMatch(matched("a", ["transaction", "manager", "kafka"]), words)).toBe(true);
    expect(isFullLexicalMatch(matched("a", ["manager"], ["manager", "transaction"]), words)).toBe(true);
    expect(isFullLexicalMatch(matched("a", ["transaction"], ["manager"]), words)).toBe(false);
    expect(isFullLexicalMatch(matched("a", ["transaction"]), words)).toBe(false);
    expect(isFullLexicalMatch(matched("a"), words)).toBe(false);
    // No word, no full match: an empty requirement is not met by everything.
    expect(isFullLexicalMatch(matched("a", both), [])).toBe(false);

    expect(leadingFullMatches([], words)).toBe(0);
    expect(leadingFullMatches([matched("a", ["manager"]), matched("b", both)], words)).toBe(0);
    expect(leadingFullMatches([matched("a", both), matched("b", ["manager"]), matched("c", both)], words)).toBe(1);
    expect(leadingFullMatches([matched("a", both), matched("b", both)], words)).toBe(2);
    expect(leadingFullMatches([matched("a", both)], [])).toBe(0);
  });

  test("H73: when the first lexical thread is not a full match, or no word matched, rrf-group@2 is rrf-group@1", () => {
    const semantic = [candidate("c"), candidate("x"), candidate("b")];
    for (const lexicalRanking of [
      [matched("a", ["manager"]), matched("b", both), matched("c", both)],
      [matched("a", ["dns"]), matched("b", ["dns"]), matched("c", ["dns"])],
      [],
    ]) {
      const at1 = fuseRankings({ lexical: lexicalRanking, semantic });
      expect(fuseRankings({ lexical: lexicalRanking, semantic, queryWords: words, config: at2 })).toEqual(at1);
    }
    // A Chinese query: none of its words is in any passage, so semantic retrieval leads.
    expect(order(fuseRankings({ lexical: [], semantic, queryWords: ["交易逾時"], config: at2 }))).toEqual(["c", "x", "b"]);
  });

  test("H73: without semantic candidates every lexical ranking passes through in its own order", () => {
    const rankings = [
      [matched("a", both), matched("b", ["manager"]), matched("c", both), matched("d", ["transaction"])],
      [matched("a", ["manager"]), matched("b", both)],
      [matched("b", both), matched("a", both)],
    ];
    for (const lexicalRanking of rankings) {
      expect(order(fuseRankings({ lexical: lexicalRanking, semantic: [], queryWords: words, config: at2 }))).toEqual(order(lexicalRanking));
    }
  });

  test("H73: an exact identifier match stays ahead of a kept thread, and kept threads ahead of everything else", () => {
    const exact: LexicalSearchResultV1 = { ...matched("exact", ["manager"]), exactMatch: true };
    // Lexical search puts exact matches first, so they are part of the head only when they hold every word.
    const fused = fuseRankings({
      lexical: [matched("a", both), exact, matched("b", ["manager"])],
      semantic: [candidate("b"), candidate("x")],
      queryWords: words,
      config: at2,
    });
    expect(order(fused)).toEqual(["exact", "a", "b", "x"]);
    expect(fused[0]!.exactMatch).toBe(true);
  });

  test("H80: fusion is deterministic, breaks ties by lexical rank then id, and a poisoned or absent similarity changes no order", () => {
    const lexicalRanking = [matched("m", both), matched("k", ["manager"]), matched("j", ["manager"])];
    const semantic = [candidate("z"), candidate("y"), candidate("j"), candidate("k")];
    const first = fuseRankings({ lexical: lexicalRanking, semantic, queryWords: words, config: at2 });
    expect(fuseRankings({ lexical: lexicalRanking, semantic, queryWords: [...words].reverse(), config: at2 })).toEqual(first);
    // k: 1/62 + 1/64, j: 1/63 + 1/63: k wins by 1e-7. z: 1/61, y: 1/62.
    expect(order(first)).toEqual(["m", "k", "j", "z", "y"]);
    // Two semantic-only threads cannot tie (ranks differ); equal scores across retrievers go to the lexical one.
    const tie = fuseRankings({ lexical: [matched("a", ["manager"]), matched("b", ["manager"])], semantic: [candidate("s1"), candidate("s2")], queryWords: words, config: at2 });
    expect(order(tie)).toEqual(["a", "s1", "b", "s2"]);
    // Poisoned or absent similarities change nothing: no revision reads `score`.
    for (const score of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      const poisoned = semantic.map((item) => ({ ...item, score }));
      expect(order(fuseRankings({ lexical: lexicalRanking, semantic: poisoned, queryWords: words, config: at2 }))).toEqual(order(first));
      expect(order(fuseRankings({ lexical: lexicalRanking, semantic: poisoned }))).toEqual(order(fuseRankings({ lexical: lexicalRanking, semantic })));
    }
  });

  test("H80: rrf-group@2 without the query's words is rejected, and with them every fallback is still the lexical order", async () => {
    expect(() => fuseRankings({ lexical: [matched("a", both)], semantic: [], config: at2 })).toThrow("Fusion rrf-group@2 needs the query's words");
    await expect(hybridSearch({ query: "transaction manager", lexical: [matched("a", both)], config: at2 })).rejects.toThrow("Fusion rrf-group@2 needs the query's words");
    // With them, hybrid search applies the rule, and every fallback is still the lexical order.
    const lexicalRanking = [matched("a", both), matched("b", ["manager"]), matched("c", ["manager"])];
    const hybrid = await hybridSearch({ query: "transaction manager", lexical: lexicalRanking, semantic: retriever([candidate("c"), candidate("b")]), config: at2, queryWords: words });
    expect(hybrid.retrieval).toEqual({ fusionRevision: "rrf-group@2", semanticRevision: "fake@1", semantic: "ok" });
    expect(order(hybrid.results)).toEqual(["a", "c", "b"]);
    const disabled = await hybridSearch({ query: "transaction manager", lexical: lexicalRanking, config: at2, queryWords: words });
    expect(disabled.retrieval).toEqual({ fusionRevision: "rrf-group@2", semantic: "disabled" });
    expect(order(disabled.results)).toEqual(["a", "b", "c"]);
    const failed = await hybridSearch({ query: "transaction manager", lexical: lexicalRanking, semantic: { retrieve: async () => { throw new Error("down"); } }, config: at2, queryWords: words });
    expect(failed.retrieval.semantic).toBe("failed");
    expect(order(failed.results)).toEqual(["a", "b", "c"]);
  });

  test.each([
    ["RequestManager", ["request", "manager"]],
    ["CommitRequestManager", ["commit", "request", "manager"]],
    ["two-phase commit", ["two", "phase", "commit"]],
    ["manager  Manager request", ["manager", "request"]],
    ["KIP770 transaction", ["kip", "770", "transaction"]],
    ["反向 DNS 查詢阻塞網路執行緒", ["反向", "dns", "查詢阻塞網路執行緒"]],
    ["RecordAccumulator.ready()", ["record", "accumulator", "ready"]],
    ["?? !!", []],
  ])("H73: the words of %s", (query, expected) => {
    const config = lexicalSearchConfigFor("bm25-reference@3", { p: [{ kind: "kip", canonicalPrefix: "KIP-", textPattern: "\\bKIP-?(\\d+)\\b" }] });
    const queryWords = lexicalQueryWords(query, config);
    expect(queryWords).toEqual(expected);
  });

  test("H73: without identifier profiles the words are the distinct words of the query as typed", () => {
    expect(lexicalQueryWords("manager  Manager request")).toEqual(["manager", "request"]);
    expect(lexicalQueryWords("KIP770 RequestManager")).toEqual(["kip770", "request", "manager"]);
  });
});

describe("Spec 016 fusion revisions", () => {
  test("H74: rrf-group@1 is what it was: its config, its name, and its order whatever words it is given", () => {
    expect(DEFAULT_FUSION_REVISION).toBe("rrf-group@1");
    expect(defaultFusionConfig).toEqual({ revision: "rrf-group@1", k: 60, maxSemanticMatches: 5 });
    expect(Object.keys(defaultFusionConfig).sort()).toEqual(["k", "maxSemanticMatches", "revision"]);
    const input = {
      lexical: [matched("a", ["x", "y"]), matched("b", ["x", "y"]), matched("c", ["x"])],
      semantic: [candidate("c"), candidate("b"), candidate("z")],
    };
    const plain = fuseRankings(input);
    // c: 1/63 + 1/61 = 0.032266, b: 1/62 + 1/62 = 0.032258, a: 1/61, z: 1/63.
    expect(order(plain)).toEqual(["c", "b", "a", "z"]);
    expect(fuseRankings({ ...input, queryWords: ["x", "y"] })).toEqual(plain);
    expect(fuseRankings({ ...input, queryWords: ["x", "y"], config: defaultFusionConfig })).toEqual(plain);
    // The same input under @2 differs, so the comparison above can fail.
    expect(order(fuseRankings({ ...input, queryWords: ["x", "y"], config: leadingFullMatchFusionConfig }))).toEqual(["a", "b", "c", "z"]);
  });

  test("H74: a revision name selects its config, and an unknown name selects nothing", () => {
    expect(SUPPORTED_FUSION_REVISIONS).toEqual(["rrf-group@1", "rrf-group@2", "rrf-group@3"]);
    expect(fusionConfigFor("rrf-group@3")).toBe(lexicalHeadFusionConfig);
    expect(fusionConfigFor("rrf-group@1")).toBe(defaultFusionConfig);
    expect(fusionConfigFor("rrf-group@2")).toBe(leadingFullMatchFusionConfig);
    expect(LEADING_FULL_MATCH_FUSION_REVISION).toBe("rrf-group@2");
    expect(leadingFullMatchFusionConfig).toEqual({ revision: "rrf-group@2", k: 60, maxSemanticMatches: 5, keepLeadingFullMatches: true });
    for (const name of ["rrf-group@4", "rrf-group", "RRF-GROUP@2", " rrf-group@2", "true", ""]) expect(fusionConfigFor(name)).toBeUndefined();
  });
});

describe("Spec 016 fusion rrf-group@3: only a semantic standout passes the first lexical threads", () => {
  const at3 = lexicalHeadFusionConfig;
  const words = ["log", "manager", "cleanup"];
  const two = ["log", "manager"];
  /** Semantic threads with these similarities, best first; `x0`, `x1`, … fill the list to the reference rank. */
  const scored = (...entries: readonly (readonly [string, number])[]) => entries.map(([id, score]) => ({ ...candidate(id), score }));
  const pack = (count: number, score: number) => Array.from({ length: count }, (_, index) => [`x${String(index).padStart(2, "0")}`, score] as const);

  test("H85: its config is rrf-group@2 with a head of 3, the 20th semantic thread as background, and a margin of 0.04", () => {
    expect(at3).toEqual({ revision: "rrf-group@3", k: 60, maxSemanticMatches: 5, keepLeadingFullMatches: true, lexicalHead: { threads: 3, reference: 20, margin: 0.04 } });
  });

  test("H85: a head thread semantic retrieval missed is passed by a standout and by no thread of the pack", () => {
    // No lexical thread holds `cleanup`, so rrf-group@2 keeps nothing. `a` (lexical 1) is not a
    // semantic candidate. `d` (lexical 4) is the best semantic thread, 0.10 above the background
    // of 0.50; `e` and `f` (lexical 5, 6) are in the pack, 0.02 above it.
    const input = {
      lexical: [matched("a", two), matched("b", two), matched("c", two), matched("d", two), matched("e", two), matched("f", two)],
      semantic: scored(["d", 0.6], ["e", 0.52], ["f", 0.52], ["c", 0.51], ...pack(16, 0.5)),
      queryWords: words,
    };
    // rrf-group@2 = rrf-group@1 here: d, e, c, f are in both lists and precede a; b is behind the pack's first threads.
    const at2 = order(fuseRankings({ ...input, config: leadingFullMatchFusionConfig }));
    expect(at2.slice(0, 5)).toEqual(["d", "e", "c", "f", "a"]);
    expect(at2).toEqual(order(fuseRankings(input)));
    // rrf-group@3: d stands out and stays first; before e (not a standout) the head threads lexical
    // search ranks above it, a, b, c, are placed in lexical order.
    const fused = fuseRankings({ ...input, config: at3 });
    expect(order(fused).slice(0, 6)).toEqual(["d", "a", "b", "c", "e", "f"]);
    expect(fused.slice(0, 4).map((result) => result.signals)).toEqual([
      { lexicalRank: 4, semanticRank: 1, fusedRank: 1 },
      { lexicalRank: 1, fusedRank: 2 },
      { lexicalRank: 2, fusedRank: 3 },
      { lexicalRank: 3, semanticRank: 4, fusedRank: 4 },
    ]);
    // Nothing is dropped, and the threads behind the head keep their rrf-group@2 order.
    expect(order(fused).filter((id) => !["a", "b", "c"].includes(id))).toEqual(at2.filter((id) => !["a", "b", "c"].includes(id)));
  });

  test("H85: the margin is measured from the semantic thread at the reference rank, on each side of 0.04", () => {
    const lexicalRanking = [matched("a", two), matched("b", two)];
    const run = (similarity: number, background = 0.5, fill = 19) =>
      order(fuseRankings({ lexical: lexicalRanking, semantic: scored(["s", similarity], ...pack(fill, background)), queryWords: words, config: at3 })).slice(0, 3);
    // A thread found by meaning alone, first semantically: 1/61 ties with lexical rank 1 and loses the tie.
    // Under rrf-group@2 it is second; rrf-group@3 lets it stay there only when it stands out.
    expect(order(fuseRankings({ lexical: lexicalRanking, semantic: scored(["s", 0.55], ...pack(19, 0.5)), queryWords: words, config: leadingFullMatchFusionConfig })).slice(0, 3)).toEqual(["a", "s", "b"]);
    expect(run(0.55)).toEqual(["a", "s", "b"]);
    expect(run(0.54)).toEqual(["a", "s", "b"]);
    expect(run(0.5399)).toEqual(["a", "b", "s"]);
    // Exactly at the margin: 0.08 - 0.04 is 0.04 in floating point too, and stands out; a hair below does not.
    expect(0.08 - 0.04).toBe(0.04);
    expect(run(0.08, 0.04)).toEqual(["a", "s", "b"]);
    expect(run(0.0799999, 0.04)).toEqual(["a", "b", "s"]);
    // The reference is the 20th semantic thread: with a 21st, lower one, the background does not move.
    expect(order(fuseRankings({ lexical: lexicalRanking, semantic: scored(["s", 0.5399], ...pack(19, 0.5), ["low", 0.3]), queryWords: words, config: at3 })).slice(0, 3)).toEqual(["a", "b", "s"]);
    // With fewer than 20 semantic threads the last one is the background.
    expect(run(0.5399, 0.5, 3)).toEqual(["a", "b", "s"]);
    expect(run(0.5399, 0.4, 3)).toEqual(["a", "s", "b"]);
    // A lone candidate is its own background and never stands out.
    expect(run(0.9, 0.5, 0)).toEqual(["a", "b", "s"]);
  });

  test("H85: only the first three lexical threads are protected, and a thread never passes one it outranks lexically", () => {
    const lexicalRanking = ["a", "b", "c", "d", "e"].map((id) => matched(id, two));
    const fused = order(fuseRankings({ lexical: lexicalRanking, semantic: scored(["e", 0.52], ["x", 0.52], ...pack(18, 0.5)), queryWords: words, config: at3 }));
    // e (lexical 5, in the pack) scores 1/65 + 1/61 and would lead; a, b, c come first. d (lexical 4) is not
    // protected: it stays where its score puts it, behind e, x, and the third semantic thread (a tie at 1/64 is d's).
    expect(fused.slice(0, 8)).toEqual(["a", "b", "c", "e", "x", "x00", "d", "x01"]);
    // b in the pack with a better semantic rank than a: b is preceded by a, which lexical search ranks above it.
    expect(order(fuseRankings({ lexical: lexicalRanking, semantic: scored(["b", 0.52], ...pack(19, 0.5)), queryWords: words, config: at3 })).slice(0, 3)).toEqual(["a", "b", "c"]);
    // A standout among the head threads passes the others: semantic evidence still reorders the head.
    expect(order(fuseRankings({ lexical: lexicalRanking, semantic: scored(["c", 0.6], ...pack(19, 0.5)), queryWords: words, config: at3 })).slice(0, 3)).toEqual(["c", "a", "b"]);
  });

  test("H85: kept full matches and exact matches stay where rrf-group@2 puts them, and without candidates the order is lexical", () => {
    const exact: LexicalSearchResultV1 = { ...matched("exact", ["log"]), exactMatch: true };
    // s is found by meaning alone and stands out: it passes the head threads a and b, and never the exact match.
    const withExact = [exact, matched("a", two), matched("b", two), matched("c", two)];
    expect(order(fuseRankings({ lexical: withExact, semantic: scored(["s", 0.7], ...pack(19, 0.5)), queryWords: words, config: at3 })).slice(0, 4)).toEqual(["exact", "s", "a", "b"]);
    // a holds every word and leads: rrf-group@2 keeps it, and not even a standout passes it.
    const withFull = [matched("a", words), matched("b", two), matched("c", two)];
    expect(order(fuseRankings({ lexical: withFull, semantic: scored(["c", 0.6], ...pack(19, 0.5)), queryWords: words, config: at3 })).slice(0, 3)).toEqual(["a", "c", "b"]);
    expect(order(fuseRankings({ lexical: withFull, semantic: scored(["c", 0.52], ...pack(19, 0.5)), queryWords: words, config: at3 })).slice(0, 3)).toEqual(["a", "b", "c"]);
    expect(order(fuseRankings({ lexical: withExact, semantic: [], queryWords: words, config: at3 }))).toEqual(["exact", "a", "b", "c"]);
    // An exact match is first even when a head thread outranks it lexically and nothing stands out.
    expect(order(fuseRankings({ lexical: [matched("a", two), exact, matched("b", two)], semantic: scored(...pack(20, 0.5)), queryWords: words, config: at3 })).slice(0, 3)).toEqual(["exact", "a", "b"]);
    // A thread stands out by its best passage: 0.56 and 0.40 against a background of 0.50.
    const passages = [{ ...candidate("s", "0"), score: 0.56 }, { ...candidate("s", "1"), score: 0.4 }, ...scored(...pack(19, 0.5))];
    expect(order(fuseRankings({ lexical: [matched("a", two), matched("b", two)], semantic: passages, queryWords: words, config: at3 })).slice(0, 3)).toEqual(["a", "s", "b"]);
    // A Chinese query: no lexical thread, so there is no head and the semantic order stands.
    expect(order(fuseRankings({ lexical: [], semantic: scored(["s1", 0.6], ["s2", 0.5]), queryWords: ["交易逾時"], config: at3 }))).toEqual(["s1", "s2"]);
  });

  test("H89: a similarity that is not a finite number never stands out, an invalid head is rejected, and rrf-group@2 reads no similarity", () => {
    const lexicalRanking = [matched("a", two), matched("b", two)];
    const semantic = (score: number) => [{ ...candidate("s"), score }, ...scored(...pack(19, 0.5))];
    for (const poisoned of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number, "0.9" as unknown as number]) {
      expect(order(fuseRankings({ lexical: lexicalRanking, semantic: semantic(poisoned), queryWords: words, config: at3 })).slice(0, 3)).toEqual(["a", "b", "s"]);
    }
    // A background that is not a number: nothing stands out, and nothing is thrown.
    const brokenBackground = [{ ...candidate("s"), score: 0.9 }, ...Array.from({ length: 19 }, (_, index) => ({ ...candidate(`y${index}`), score: Number.NaN }))];
    expect(order(fuseRankings({ lexical: lexicalRanking, semantic: brokenBackground, queryWords: words, config: at3 })).slice(0, 3)).toEqual(["a", "b", "s"]);
    // Positive control: the same thread with a valid similarity stands out.
    expect(order(fuseRankings({ lexical: lexicalRanking, semantic: semantic(0.9), queryWords: words, config: at3 })).slice(0, 3)).toEqual(["a", "s", "b"]);
    for (const lexicalHead of [{ threads: 0, reference: 20, margin: 0.04 }, { threads: 3, reference: 0, margin: 0.04 }, { threads: 3, reference: 20, margin: 0 }, { threads: 1.5, reference: 20, margin: 0.04 }]) {
      expect(() => fuseRankings({ lexical: lexicalRanking, semantic: [], queryWords: words, config: { ...at3, lexicalHead } })).toThrow("lexicalHead needs positive integer threads and reference, and a positive margin");
    }
    expect(() => fuseRankings({ lexical: lexicalRanking, semantic: [], config: at3 })).toThrow("Fusion rrf-group@3 needs the query's words");
    // rrf-group@1 and @2 are unchanged by any similarity.
    for (const config of [undefined, leadingFullMatchFusionConfig]) {
      const base = order(fuseRankings({ lexical: lexicalRanking, semantic: semantic(0.9), queryWords: words, ...(config === undefined ? {} : { config }) }));
      expect(order(fuseRankings({ lexical: lexicalRanking, semantic: semantic(0.1), queryWords: words, ...(config === undefined ? {} : { config }) }))).toEqual(base);
    }
  });

  test("H89: fusion at rrf-group@3 is deterministic and returns every thread once", () => {
    const lexicalRanking = ["a", "b", "c", "d"].map((id) => matched(id, two));
    const semantic = scored(["d", 0.6], ["c", 0.52], ["s", 0.56], ...pack(17, 0.5));
    const first = fuseRankings({ lexical: lexicalRanking, semantic, queryWords: words, config: at3 });
    expect(fuseRankings({ lexical: lexicalRanking, semantic, queryWords: words, config: at3 })).toEqual(first);
    expect(new Set(order(first)).size).toBe(first.length);
    expect(first).toHaveLength(4 + 1 + 17);
    expect(first.map((result) => result.signals.fusedRank)).toEqual(first.map((_, index) => index + 1));
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
  test.each([...semanticRetrieverContract])("H5: $name", async ({ run }) => {
    await run((input) => createInMemorySemanticRetriever(input));
  });
});
