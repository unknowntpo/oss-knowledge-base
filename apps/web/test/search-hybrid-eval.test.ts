import { describe, expect, test } from "bun:test";

import type { SearchResponseV1 } from "@oss-knowledge-base/serving-contract";

import { evalQueries, GATE_QUERIES_AT_MOST, HOURLY_CALLS_LEFT_FOR_A_RUN, PROBE_QUERIES, ranksOf, renderTable, reportQuery, RERANK_SHARE, summarize, type EvalQuery } from "../scripts/measure-search-hybrid";
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
    expect([count("real-corpus"), count("guard"), count("chinese"), count("vocabulary-gap"), count("probe")]).toEqual([21, 6, 8, 8, 5]);
    expect(new Set(queries.map((item) => item.query)).size).toBe(queries.length);
    expect(queries.find((item) => item.labels === "owner")).toMatchObject({ query: "consumer network thread request manager", within: 3 });
    expect(queries.filter((item) => item.kind !== "probe").every((item) => item.expected.length > 0)).toBe(true);
  });

  test("H71: the owner's abbreviation probes are asked unlabelled, and one run fits the gate's hourly and daily caps", () => {
    expect(PROBE_QUERIES).toEqual(["RM", "ISR", "HW", "EOS", "LSO"]);
    const queries = evalQueries();
    // `txn`, the sixth abbreviation, is a labelled Spec 017 row.
    expect(queries.filter((item) => item.query === "txn").map((item) => item.kind)).toEqual(["real-corpus"]);
    expect(queries.filter((item) => item.kind === "probe")).toEqual(PROBE_QUERIES.map((query) => ({ kind: "probe", labels: "unlabelled", query, expected: [], acceptable: [], within: 0 })));
    // At most one model call a query and two index queries (two projects): 48 and 96.
    expect(GATE_QUERIES_AT_MOST).toBe(48);
    expect(GATE_QUERIES_AT_MOST).toBeLessThanOrEqual(HOURLY_CALLS_LEFT_FOR_A_RUN);
    expect(HOURLY_CALLS_LEFT_FOR_A_RUN).toBeLessThan(100);
    expect(2 * GATE_QUERIES_AT_MOST).toBeLessThan(1_000);

    // A probe is reported with its first threads and is never met, a regression, or a rerank candidate.
    const probe = queries.find((item) => item.kind === "probe")!;
    const titled = (threads: readonly string[], semantic?: { status: "ok"; cached: boolean }) => {
      const body = response(threads, semantic);
      return { ...body, results: body.results.map((result) => ({ ...result, entry: { ...result.entry, title: `Title of ${result.entry.sourceTitleRecordId}` } })) };
    };
    const report = reportQuery(probe, { response: titled(["a"]), ms: 10 }, { response: titled(["b", "a", "c", "d", "e", "f"], { status: "ok", cached: false }), ms: 20 });
    expect(report).toMatchObject({ kind: "probe", lexicalTop: ["a Title of a"], hybridTop: ["b Title of b", "a Title of a", "c Title of c", "d Title of d", "e Title of e"], rerankCandidate: false });
    const summary = summarize([report]);
    expect(summary).toMatchObject({ queries: 1, statuses: { ok: 1 }, lexicalMet: 0, hybridMet: null, regressions: [], rerankCandidates: [], rerank: "not measured", uncachedAsked: 1, timedOut: 0, timedOutShare: 0 });
    // A labelled row carries no first-thread lists.
    expect(reportQuery(query(3, ["a"]), { response: titled(["a"]), ms: 1 })).not.toHaveProperty("lexicalTop");
  });

  test("H71: the timed-out share counts only cold requests that reached the gate", () => {
    const lexical = { response: response([]), ms: 1 };
    const cold = (status: "ok" | "timed-out" | "failed" | "over-budget" | "skipped" | "uncovered" | "disabled", cached?: boolean) =>
      reportQuery(query(3, [`x-${status}-${cached}`]), lexical, { response: response([], { status, ...(cached === undefined ? {} : { cached }) }), ms: 1 });
    const summary = summarize([cold("ok", false), cold("ok", false), cold("timed-out"), cold("failed"), cold("over-budget"), cold("ok", true), cold("skipped"), cold("uncovered"), cold("disabled")]);
    // Asked: two fused, one timed out, one failed, one over budget. Not asked: cached, skipped, uncovered, disabled.
    expect([summary.uncachedAsked, summary.timedOut, summary.timedOutShare]).toEqual([5, 1, 0.2]);
    expect(summarize([cold("skipped")])).toMatchObject({ uncachedAsked: 0, timedOutShare: null });
    expect(summarize([cold("timed-out"), cold("timed-out"), cold("ok", false)]).timedOutShare).toBe(0.67);
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
      uncachedAsked: 5, timedOut: 0, timedOutShare: 0,
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
