import { describe, expect, test } from "bun:test";

import type { SearchResponseV1 } from "@oss-knowledge-base/serving-contract";

import { evalQueries, ranksOf, renderTable, reportQuery, RERANK_SHARE, summarize, type EvalQuery } from "../scripts/measure-search-hybrid";
import { testPlanRows } from "./search-hybrid-eval.cases";

const snapshotPath = new URL("../../../packages/search/test/fixtures/real-corpus-snapshot.v1.json", import.meta.url);

/** A response holding `threads` in rank order; `semanticOnly` are returned by semantic retrieval alone. */
function response(threads: readonly string[], semantic?: SearchResponseV1["retrieval"]["semantic"], semanticOnly: readonly string[] = []): SearchResponseV1 {
  return {
    schema: "osskb.search-response.v1",
    query: "q",
    results: threads.map((thread, index) => ({
      entry: { sourceTitleRecordId: thread } as never,
      matches: [{ signals: { exactIdentifier: false, ...(semanticOnly.includes(thread) ? { semanticRank: 1 } : { lexicalRank: index + 1 }), fusedRank: index + 1 } } as never],
      detailRef: "sdr1.x",
    })),
    facets: { projects: [] },
    retrieval: { indexRevision: "r", lexicalRevision: "bm25-reference@3", generatedAt: "2026-10-12T00:00:00Z", stale: false, ...(semantic === undefined ? {} : { fusionRevision: "rrf-group@1", semantic }) },
  };
}

const filler = (count: number) => Array.from({ length: count }, (_, index) => `other-${index}`);
const query = (within: number, expected: readonly string[]): EvalQuery => ({ kind: "chinese", labels: "implementer", query: `q ${expected.join(" ")} ${within}`, expected, acceptable: [], within });

describe("Spec 016 hybrid measurement (slice 4 preparation)", () => {
  test.each([...testPlanRows])("H71: $kind query $query names threads of the Dev snapshot, within a stated rank", async (row) => {
    const snapshot = await Bun.file(snapshotPath).json() as { readonly chunks: readonly { readonly recordId: string; readonly groupRootRecordId: string }[] };
    const roots = new Set(snapshot.chunks.map((chunk) => chunk.groupRootRecordId));
    const expected = row.expected.split(" ");
    const acceptable = row.acceptable === null ? [] : row.acceptable.split(" ");
    expect(expected.length).toBeGreaterThan(0);
    for (const thread of [...expected, ...acceptable]) expect([thread, roots.has(thread)]).toEqual([thread, true]);
    expect(new Set([...expected, ...acceptable]).size).toBe(expected.length + acceptable.length);
    expect(row.within).toBeGreaterThanOrEqual(expected.length);
    expect(row.within).toBeLessThanOrEqual(20);
    expect(row.labels).toBe("implementer");
    expect(row.why.length).toBeGreaterThan(20);
  });

  test("H71: the list holds 8 Chinese and 8 vocabulary-gap queries beside the Spec 017 rows and guard rows, each query once", () => {
    const queries = evalQueries();
    const count = (kind: string) => queries.filter((item) => item.kind === kind).length;
    expect(testPlanRows.filter((row) => row.kind === "chinese")).toHaveLength(8);
    expect(testPlanRows.filter((row) => row.kind === "vocabulary-gap")).toHaveLength(8);
    expect(testPlanRows.filter((row) => row.kind === "chinese").every((row) => /\p{Script=Han}/u.test(row.query))).toBe(true);
    expect([count("real-corpus"), count("guard"), count("chinese"), count("vocabulary-gap")]).toEqual([21, 6, 8, 8]);
    expect(new Set(queries.map((item) => item.query)).size).toBe(queries.length);
    expect(queries.find((item) => item.labels === "owner")).toMatchObject({ query: "consumer network thread request manager", within: 3 });
    expect(queries.every((item) => item.expected.length > 0)).toBe(true);
  });

  test("H71: ranks are 1-based, and null beyond what the response holds", () => {
    expect(ranksOf(response(["a", "b", "c"]), ["c", "a", "zz"])).toEqual([3, 1, null]);
    expect(ranksOf(response([]), ["a"])).toEqual([null]);
  });

  test("H71: a query's report compares lexical and hybrid ranks, and marks what a reranker could fix", () => {
    const lexical = { response: response([...filler(30), "a"]), ms: 900.4 };
    // Hybrid search brings `a` to rank 7 and `b` to rank 2: retrieved, but `a` is outside the top 5.
    const hybrid = { response: response(["x", "b", ...filler(4), "a"], { status: "ok", candidates: 9, cached: false }, ["b"]), ms: 1_150.6, cachedMs: 950.2 };
    expect(reportQuery(query(5, ["a", "b"]), lexical, hybrid)).toEqual({
      kind: "chinese", labels: "implementer", query: "q a b 5", within: 5, expected: ["a", "b"],
      lexicalRanks: [31, null], hybridRanks: [7, 2], semantic: { status: "ok", candidates: 9, cached: false },
      lexicalMet: false, hybridMet: false, rerankCandidate: true, semanticOnlyResults: 1,
      lexicalMs: 900, hybridMs: 1_151, cachedMs: 950,
    });
    // Each side of both bounds: rank 5 is within 5; rank 20 is in the top 20 and rank 21 is not.
    const at = (rank: number) => reportQuery(query(5, ["a"]), lexical, { ...hybrid, response: response([...filler(rank - 1), "a"], { status: "ok" }) });
    expect([at(5).hybridMet, at(5).rerankCandidate]).toEqual([true, false]);
    expect([at(6).hybridMet, at(6).rerankCandidate]).toEqual([false, true]);
    expect([at(20).hybridMet, at(20).rerankCandidate]).toEqual([false, true]);
    expect([at(21).hybridMet, at(21).rerankCandidate]).toEqual([false, false]);
    // A deployment with hybrid search off answers without `retrieval.semantic`.
    expect(reportQuery(query(5, ["a"]), lexical, { response: response(["a"]), ms: 1 })).toMatchObject({ hybridRanks: null, semantic: null, hybridMet: null, rerankCandidate: null, hybridMs: null, cachedMs: null });
    expect(reportQuery(query(5, ["a"]), lexical)).toMatchObject({ lexicalRanks: [31], hybridRanks: null });
  });

  test("H71: the summary counts statuses, regressions, and rerank candidates, and applies the 30% rule to fused queries only", () => {
    const ok = { status: "ok" } as const;
    const lexical = (threads: readonly string[]) => ({ response: response(threads), ms: 1_000 });
    const reports = [
      // Met by both.
      reportQuery(query(3, ["a"]), lexical(["a"]), { response: response(["a"], ok), ms: 1_200, cachedMs: 1_050 }),
      // Retrieved but ranked low: a rerank candidate.
      reportQuery(query(3, ["b"]), lexical([]), { response: response([...filler(9), "b"], ok), ms: 1_400, cachedMs: 1_100 }),
      // Not retrieved in the top 20.
      reportQuery(query(3, ["c"]), lexical([]), { response: response([...filler(25), "c"], ok), ms: 1_300, cachedMs: 1_000 }),
      // Met lexically, lost under hybrid search: a regression.
      reportQuery(query(3, ["d"]), lexical(["d"]), { response: response([...filler(3), "d"], ok), ms: 1_100, cachedMs: 1_000 }),
      // Not fused: outside the rule.
      reportQuery(query(3, ["e"]), lexical([]), { response: response([], { status: "over-budget" }), ms: 1_010 }),
    ];
    const summary = summarize(reports);
    expect(summary).toEqual({
      queries: 5, hybrid: true, statuses: { ok: 4, "over-budget": 1 }, lexicalMet: 2, hybridMet: 1,
      regressions: ["q d 3"], rerankCandidates: ["q b 3", "q d 3"], rerank: "consider rerank", notRetrieved: ["q c 3"],
      medianLexicalMs: 1_000, medianHybridMs: 1_200, medianCachedMs: 1_000, medianAddedMs: 200,
    });
    expect(RERANK_SHARE).toBe(0.3);
    // One candidate among four fused queries is under 30%.
    const fewer = summarize([reports[0]!, reports[1]!, reports[2]!, reportQuery(query(3, ["f"]), lexical(["f"]), { response: response(["f"], ok), ms: 1_000 })]);
    expect([fewer.rerankCandidates, fewer.rerank]).toEqual([["q b 3"], "no case for rerank"]);
    // With hybrid search off nothing is decided.
    expect(summarize([reportQuery(query(3, ["a"]), lexical(["a"]))])).toMatchObject({ hybrid: false, statuses: {}, hybridMet: null, rerank: "not measured", medianHybridMs: null, medianAddedMs: null });
    expect(renderTable(reports).split("\n")[3]).toBe("| chinese | q b 3 | 3 | >50 | 10 | ok | 1000 | 1400 | 1100 |");
  });
});
