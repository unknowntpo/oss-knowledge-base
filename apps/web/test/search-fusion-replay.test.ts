import { describe, expect, test } from "bun:test";

import { defaultFusionConfig, leadingFullMatches, leadingFullMatchFusionConfig, lexicalQueryTerms, lexicalQueryWords, lexicalSearchConfigFor } from "@oss-knowledge-base/search";
import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import type { SearchResponseV1 } from "@oss-knowledge-base/serving-contract";

import { REPLAY_DEPTH, REPLAY_SCHEMA, replayQuery, type ReplayFixture, type ReplayQuery } from "../scripts/capture-search-replay";
import {
  ABLATION,
  ABLATION_REPORT,
  alternativeOrder,
  fuseReplay,
  fusionInput,
  isMet,
  isWorseThanLexical,
  keepsWin,
  lexicalOrder,
  loweredThreads,
  NEW_QUERIES_FIXTURE,
  ranksIn,
  renderAblation,
  REPLAY_FIXTURE,
  replayRows,
  summarize,
  WINS,
  type ReplayRow,
  type RowSet,
} from "../scripts/eval-search-fusion";
import { evalQueries } from "../scripts/measure-search-hybrid";
import { testPlanRows } from "./search-fusion-new.cases";

const newRows = testPlanRows;
const measured = await Bun.file(REPLAY_FIXTURE).json() as ReplayFixture;
const added = await Bun.file(NEW_QUERIES_FIXTURE).json() as ReplayFixture;
const rows = await replayRows();
const row = (query: string) => rows.find((item) => item.query === query)!;
const at1 = (item: ReplayRow) => fuseReplay(item.replay, item.projects, defaultFusionConfig);
const at2 = (item: ReplayRow) => fuseReplay(item.replay, item.projects, leadingFullMatchFusionConfig);
const lexical = (item: ReplayRow) => lexicalOrder(item.replay);
const ranks = (item: ReplayRow, order: readonly string[]) => ranksIn(order, item.expected);
const of = (set: RowSet) => rows.filter((item) => item.set === set);
const worse = (items: readonly ReplayRow[], order: (item: ReplayRow) => readonly string[]) =>
  items.filter((item) => isWorseThanLexical(ranks(item, lexical(item)), ranks(item, order(item)), item.within)).map((item) => item.query);

describe("Spec 016 fusion: the replay fixture", () => {
  test.each([
    ["the 48 measured queries", REPLAY_FIXTURE, measured, evalQueries().map((query) => query.query)],
    ["the 14 new queries", NEW_QUERIES_FIXTURE, added, newRows.map((item) => item.query)],
  ] as const)("H72: the capture of %s is dated, bounded, and well-formed", async (_, path, fixture, queries) => {
    expect(fixture.schema).toBe(REPLAY_SCHEMA);
    expect(fixture.base).toBe("https://oss-knowledge-base-dev.pages.dev");
    expect(fixture.release).toBe("feed-2026-10-13T01-07-01-000Z");
    expect(fixture.capturedAt.startsWith("2026-10-13T01:3")).toBe(true);
    expect(path.pathname.endsWith(".2026-10-13.json")).toBe(true);
    expect({ lexical: fixture.lexicalRevision, semantic: fixture.semanticRevision, fusion: fixture.fusionRevision, depth: fixture.depth })
      .toEqual({ lexical: "bm25-reference@3", semantic: "@cf/baai/bge-m3@1:1024:title-text@1", fusion: "rrf-group@1", depth: 50 });
    expect(fixture.projects.slice().sort()).toEqual(["apache-datafusion", "apache-kafka"]);
    expect(fixture.queries.map((query) => query.query)).toEqual([...queries]);
    // Ranks, ids, and matched-term masks only: at most 200 bytes a thread, and no title or excerpt.
    const threads = fixture.queries.reduce((total, query) => total + query.threads.length, 0);
    const bytes = Bun.file(path).size;
    expect(bytes).toBeLessThan(200_000);
    expect(bytes / threads).toBeLessThan(200);
    expect(await Bun.file(path).text()).not.toMatch(/"title"|"excerpt"|"author"|canonicalUrl/u);

    const config = lexicalSearchConfigFor(fixture.lexicalRevision, searchIdentifierProfiles);
    for (const query of fixture.queries) {
      expect([query.query, query.terms]).toEqual([query.query, [...lexicalQueryTerms(query.query, config)]]);
      expect([query.query, query.words]).toEqual([query.query, [...lexicalQueryWords(query.query, config)]]);
      const lexicalRanks = query.threads.map((thread) => thread[2]).filter((rank) => rank > 0);
      expect(lexicalRanks).toEqual(lexicalRanks.map((_, index) => index + 1));
      expect(lexicalRanks.length).toBeLessThanOrEqual(REPLAY_DEPTH);
      const fused = query.threads.map((thread) => thread[4]).filter((rank) => rank > 0).sort((left, right) => left - right);
      expect(fused).toEqual(fused.map((_, index) => index + 1));
      expect(new Set(query.threads.map((thread) => thread[0])).size).toBe(query.threads.length);
      const semanticRanks = query.threads.map((thread) => thread[3]).filter((rank) => rank > 0);
      expect(new Set(semanticRanks).size).toBe(semanticRanks.length);
      for (const [id, project, lexicalRank, semanticRank, fusedRank, masks, exact, score] of query.threads) {
        expect(id.length).toBeGreaterThan(0);
        expect(fixture.projects[project]).toBeDefined();
        // Every thread was returned by a retriever, and a thread the hybrid response held has a fused rank.
        expect(lexicalRank > 0 || semanticRank > 0).toBe(true);
        if (semanticRank > 0) expect(fusedRank).toBeGreaterThan(0);
        expect(masks.length > 0).toBe(lexicalRank > 0);
        for (const mask of masks) expect(mask > 0 && mask < 2 ** query.terms.length).toBe(true);
        expect([0, 1]).toContain(exact);
        // The similarity was not served on 2026-10-13 (`signals.semanticScore` is added by this change).
        expect(score).toBeNull();
      }
      if (query.semantic !== "ok") expect(query.threads.every((thread) => thread[3] === 0)).toBe(true);
    }
  });

  test("H72: the measured capture holds 43 fused queries, 4 identifier queries, and the timed-out query answered", () => {
    const statuses: Record<string, number> = {};
    for (const query of measured.queries) statuses[query.semantic] = (statuses[query.semantic] ?? 0) + 1;
    // `RequestManager` timed out in the 01:26 measurement; nine minutes later its embedding was cached.
    expect(statuses).toEqual({ ok: 44, skipped: 4 });
    expect(added.queries.every((query) => query.semantic === "ok")).toBe(true);
    expect(rows.map((item) => item.set).reduce<Record<string, number>>((count, set) => ({ ...count, [set]: (count[set] ?? 0) + 1 }), {}))
      .toEqual({ tuning: 31, "held-out": 12, new: 14 });
  });

  test("H72: one captured query is its lexical ranks, semantic ranks, live fused ranks, and matched-term masks", () => {
    const result = (id: string, projectId: string, signals: Record<string, unknown>, terms: readonly (readonly string[])[]) => ({
      entry: { sourceTitleRecordId: id, projectId, title: "never recorded" },
      matches: (terms.length === 0 ? [[]] : terms).map((matchedTerms) => ({ matchedTerms, signals: { exactIdentifier: false, ...signals } })),
      detailRef: "sdr1.x",
    });
    const response = (results: readonly unknown[], semantic: string): SearchResponseV1 => ({
      schema: "osskb.search-response.v1", query: "q", results, facets: { projects: [] },
      retrieval: { indexRevision: "r", lexicalRevision: "bm25-reference@3", generatedAt: "", stale: false, fusionRevision: "rrf-group@1", semantic: { status: semantic } },
    }) as never;
    const off = response([
      result("a", "kafka", { lexicalRank: 1, fusedRank: 1 }, [["request", "manager"], ["manager"]]),
      result("b", "datafusion", { lexicalRank: 2, fusedRank: 2 }, [["requestmanager", "request", "manager"]]),
    ], "disabled");
    const hybrid = response([
      result("b", "datafusion", { lexicalRank: 2, semanticRank: 1, semanticScore: 0.61239, fusedRank: 1 }, [["requestmanager", "request", "manager"]]),
      result("s", "kafka", { semanticRank: 2, fusedRank: 2 }, []),
      result("a", "kafka", { lexicalRank: 1, fusedRank: 3 }, [["request", "manager"], ["manager"]]),
    ], "ok");
    const projects: string[] = [];
    expect(replayQuery("RequestManager", off, hybrid, projects)).toEqual({
      query: "RequestManager",
      semantic: "ok",
      terms: ["requestmanager", "request", "manager"],
      words: ["request", "manager"],
      threads: [
        ["a", 0, 1, 0, 3, [6, 4], 0, null],
        ["b", 1, 2, 1, 1, [7], 0, 0.6124],
        ["s", 0, 0, 2, 2, [], 0, null],
      ],
    } satisfies ReplayQuery);
    expect(projects).toEqual(["kafka", "datafusion"]);
  });

  test("H81: a capture whose two responses disagree on the lexical ranking, or match a word the query does not hold, is refused", () => {
    const result = (id: string, signals: Record<string, unknown>, matchedTerms: readonly string[]) => ({
      entry: { sourceTitleRecordId: id, projectId: "kafka" },
      matches: [{ matchedTerms, signals: { exactIdentifier: false, ...signals } }],
      detailRef: "sdr1.x",
    });
    const response = (results: readonly unknown[], semantic: string): SearchResponseV1 => ({
      schema: "osskb.search-response.v1", query: "q", results, facets: { projects: [] },
      retrieval: { indexRevision: "r", lexicalRevision: "bm25-reference@3", generatedAt: "", stale: false, fusionRevision: "rrf-group@1", semantic: { status: semantic } },
    }) as never;
    const off = response([result("a", { lexicalRank: 1, fusedRank: 1 }, ["manager"]), result("b", { lexicalRank: 2, fusedRank: 2 }, ["manager"])], "disabled");
    // Positive control: the same lexical ranking in both responses is accepted.
    const same = response([result("b", { lexicalRank: 2, semanticRank: 1, fusedRank: 1 }, ["manager"]), result("a", { lexicalRank: 1, fusedRank: 2 }, ["manager"])], "ok");
    expect(replayQuery("RequestManager", off, same, []).threads.map((thread) => thread.slice(0, 5))).toEqual([["a", 0, 1, 0, 2], ["b", 0, 2, 1, 1]]);
    const moved = response([result("a", { lexicalRank: 2, fusedRank: 1 }, ["manager"])], "ok");
    expect(() => replayQuery("RequestManager", off, moved, [])).toThrow("is lexical rank 1 alone and 2 in the hybrid response");
    const unknown = response([result("z", { lexicalRank: 3, fusedRank: 1 }, ["manager"])], "ok");
    expect(() => replayQuery("RequestManager", off, unknown, [])).toThrow("has lexical rank 3 but is not in the lexical response");
    // A response of another lexical revision or query would match terms the query does not have.
    const foreign = response([result("a", { lexicalRank: 1, fusedRank: 1 }, ["consumer"])], "disabled");
    expect(() => replayQuery("RequestManager", foreign, same, [])).toThrow("matched term consumer is not a query term");
  });
});

describe("Spec 016 fusion: rrf-group@1 replayed", () => {
  test("H74: replayed through `fuseRankings`, rrf-group@1 reproduces every fused rank the live responses held", () => {
    let reproduced = 0;
    for (const fixture of [measured, added]) {
      for (const query of fixture.queries) {
        const live = query.threads.filter((thread) => thread[4] > 0).sort((left, right) => left[4] - right[4]).map((thread) => thread[0]);
        expect([query.query, fuseReplay(query, fixture.projects, defaultFusionConfig)]).toEqual([query.query, live]);
        reproduced += live.length;
      }
    }
    // 48 + 14 responses of at most 50 threads (`770` holds two).
    expect(reproduced).toBe(3_052);
  });

  // Ranks of the expected threads, in their listed order: lexical only, rrf-group@1 live, rrf-group@2.
  test.each([
    ["RequestManager", "1 5 2 3 4", "15 4 1 2 6", "1 5 2 3 4"],
    ["CommitRequestManager", "3 2 1", "5 16 1", "3 2 1"],
    ["AsyncKafkaConsumer", "6 2 1 5 4 7 3", "5 2 1 7 4 12 3", "6 2 1 5 4 7 3"],
    ["txn", "1 2 3 4 5", "3 8 2 4 1", "1 2 3 4 5"],
    ["disk manager", "1 2 3", "4 2 1", "1 2 3"],
    ["transaction manager", "1 2", "20 21", "1 2"],
    ["SortMergeJoinExec", "4 6 3 5 1 2", "2 15 1 4 3 5", "4 6 3 5 1 2"],
    ["tiered storage", "1 2 4 3 5", "2 3 1 4 6", "1 2 4 3 5"],
    ["kafka release", "1 2 3", "2 1 16", "1 2 3"],
    ["record collector offsets", "1 2", "1 8", "1 2"],
  ])("H75: %s is worse than lexical-only under rrf-group@1 and not under rrf-group@2", (query, lexicalRanks, at1Ranks, at2Ranks) => {
    const item = row(query);
    const cells = (order: readonly string[]) => ranks(item, order).join(" ");
    expect(cells(lexical(item))).toBe(lexicalRanks);
    expect(cells(at1(item))).toBe(at1Ranks);
    expect(cells(at2(item))).toBe(at2Ranks);
    expect(isMet(ranks(item, lexical(item)), item.within)).toBe(true);
    // Fail first: the live fusion breaks the row.
    expect(isMet(ranks(item, at1(item)), item.within)).toBe(false);
    expect(isWorseThanLexical(ranks(item, lexical(item)), ranks(item, at1(item)), item.within)).toBe(true);
    expect(isMet(ranks(item, at2(item)), item.within)).toBe(true);
    expect(isWorseThanLexical(ranks(item, lexical(item)), ranks(item, at2(item)), item.within)).toBe(false);
  });
});

describe("Spec 016 fusion: rrf-group@2 on the replay", () => {
  test("H75: its first 50 results are exactly the kept threads, then the live rrf-group@1 order without them", () => {
    let kept = 0;
    for (const item of rows) {
      const head = lexical(item).slice(0, leadingFullMatches(fusionInput(item.replay, item.projects).lexical, item.replay.words));
      // `at1` is the live order (H74). The live response held 50 threads, so the list below holds at least 50.
      const expected = [...head, ...at1(item).filter((id) => !head.includes(id))].slice(0, REPLAY_DEPTH);
      expect([item.query, at2(item)]).toEqual([item.query, expected]);
      expect(at2(item).some((id) => id.startsWith("unseen:"))).toBe(false);
      kept += head.length;
    }
    // The rule changes the order of 22 of the 57 rows; on the others it is rrf-group@1's.
    expect(rows.filter((item) => String(at2(item)) !== String(at1(item))).length).toBe(22);
    expect(kept).toBeGreaterThan(100);
  });

  test("H75: the alternatives' scorer agrees with `fuseRankings` for both revisions on every row", () => {
    for (const item of rows) {
      expect([item.query, alternativeOrder(item.replay, {})]).toEqual([item.query, at1(item)]);
      expect([item.query, alternativeOrder(item.replay, { keep: "leading" })]).toEqual([item.query, at2(item)]);
    }
  });

  test("H75: no row of any kind is worse than lexical-only, where rrf-group@1 makes ten worse", () => {
    expect(worse(rows, at1)).toEqual([
      "RequestManager", "CommitRequestManager", "AsyncKafkaConsumer", "txn", "disk manager", "transaction manager", "SortMergeJoinExec", "tiered storage",
      "kafka release", "record collector offsets",
    ]);
    expect(worse(rows, at2)).toEqual([]);
    // The rule on each side of the bound: within it and kept, pushed out, gone, and outside it either way.
    expect(isWorseThanLexical([2, 9], [3, 30], 3)).toBe(false);
    expect(isWorseThanLexical([3, 9], [4, 9], 3)).toBe(true);
    expect(isWorseThanLexical([3], [null], 3)).toBe(true);
    expect(isWorseThanLexical([4, null], [50, null], 3)).toBe(false);
    expect(isWorseThanLexical([null], [1], 3)).toBe(false);
  });

  test("H75: the owner's query keeps its thread inside the bound, and its other threads stay where rrf-group@1 put them (known limitation)", () => {
    const owner = row("consumer network thread request manager");
    expect(owner.kind).toBe("owner");
    expect(ranks(owner, lexical(owner))).toEqual([2, 21, 9]);
    expect(ranks(owner, at1(owner))).toEqual([3, 39, 24]);
    // No passage holds all five words, so nothing is kept and the order is rrf-group@1's.
    expect(ranks(owner, at2(owner))).toEqual([3, 39, 24]);
    expect(at2(owner)).toEqual(at1(owner));
    expect(isWorseThanLexical(ranks(owner, lexical(owner)), ranks(owner, at2(owner)), owner.within)).toBe(false);
    expect(loweredThreads(ranks(owner, lexical(owner)), ranks(owner, at2(owner)))).toBe(3);
  });

  test.each(WINS.map((query) => [query]))("H75: the win of rrf-group@1 on %s is kept", (query) => {
    const item = row(query);
    expect(["chinese", "vocabulary-gap"]).toContain(item.kind);
    expect(ranks(item, at2(item))).toEqual(ranks(item, at1(item)));
    expect(keepsWin(item, at2(item))).toBe(true);
    // Positive control: lexical-only is not a kept win.
    expect(keepsWin(item, lexical(item))).toBe(false);
  });

  test("H75: rows met, by kind and set: lexical-only, rrf-group@1, rrf-group@2", () => {
    const met = (set: RowSet, order: (item: ReplayRow) => readonly string[]) => summarize(of(set), order).met;
    expect(met("tuning", lexical)).toEqual({ "real-corpus": "14/14", owner: "0/1", guard: "2/4", chinese: "1/6", "vocabulary-gap": "1/6" });
    expect(met("tuning", at1)).toEqual({ "real-corpus": "8/14", owner: "0/1", guard: "1/4", chinese: "2/6", "vocabulary-gap": "3/6" });
    expect(met("tuning", at2)).toEqual({ "real-corpus": "14/14", owner: "0/1", guard: "2/4", chinese: "2/6", "vocabulary-gap": "3/6" });
    expect(met("held-out", lexical)).toEqual({ "real-corpus": "6/6", guard: "1/2", chinese: "0/2", "vocabulary-gap": "1/2" });
    expect(met("held-out", at1)).toEqual({ "real-corpus": "4/6", guard: "2/2", chinese: "1/2", "vocabulary-gap": "1/2" });
    expect(met("held-out", at2)).toEqual({ "real-corpus": "6/6", guard: "1/2", chinese: "1/2", "vocabulary-gap": "1/2" });
    // All 43: lexical 26, rrf-group@1 22 (23 in the 01:26 report, where `RequestManager` timed out), rrf-group@2 30.
    const total = (order: (item: ReplayRow) => readonly string[]) => rows.filter((item) => item.set !== "new" && isMet(ranks(item, order(item)), item.within)).length;
    expect([total(lexical), total(at1), total(at2)]).toEqual([26, 22, 30]);
  });

  test("H75: what rrf-group@2 gives up against rrf-group@1: two guard queries with their words reversed", () => {
    const reversed = row("manager request");
    expect(ranks(reversed, lexical(reversed))).toEqual([7, 21, 11, 18, 19]);
    expect(ranks(reversed, at1(reversed))).toEqual([1, 4, 8, 6, 9]);
    expect(ranks(reversed, at2(reversed))).toEqual([7, 9, 12, 10, 13]);
    const storage = row("storage tiered");
    expect(ranks(storage, at1(storage))).toEqual([3, 2, 5, 4, 8]);
    expect(ranks(storage, at2(storage))).toEqual(ranks(storage, lexical(storage)));
    // Expected threads below their lexical-only rank, outside every bound: 6 on the tuning rows, 1 held out, 0 new.
    expect([summarize(of("tuning"), at2).lowered, summarize(of("held-out"), at2).lowered, summarize(of("new"), at2).lowered]).toEqual([6, 1, 0]);
    expect([summarize(of("tuning"), at1).lowered, summarize(of("held-out"), at1).lowered, summarize(of("new"), at1).lowered]).toEqual([31, 8, 2]);
  });

  test("H75: the committed ablation is what the replay computes, and names every alternative", async () => {
    expect(await Bun.file(ABLATION_REPORT).text()).toBe(renderAblation(rows, measured.release));
    expect(ABLATION.map(([name]) => name)).toEqual([
      "lexical only (semantic=off)", "rrf-group@1 (k 60)", "1 weighted: semantic x 0.5", "1 weighted: semantic x 0.25", "k 10 for both rankings",
      "2 lexical first, semantic appended", "2 first 3 lexical threads kept", "5 first 20 semantic threads only", "5 first 10 semantic threads only",
      "4 every full match first", "4 leading full matches kept = rrf-group@2", "rrf-group@2 with k 10", "rrf-group@2 with semantic x 0.75",
    ]);
    // Of the alternatives, only the two that keep full matches have no worse row and no lost win on the tuning rows.
    const clean = ABLATION.filter(([, alternative]) => alternative !== "lexical").filter(([, alternative]) => {
      const summary = summarize(of("tuning"), (item) => alternativeOrder(item.replay, alternative as Exclude<typeof alternative, "lexical">));
      return summary.worse.length === 0 && summary.winsLost.length === 0;
    }).map(([name]) => name);
    expect(clean).toEqual(["4 every full match first", "4 leading full matches kept = rrf-group@2", "rrf-group@2 with k 10", "rrf-group@2 with semantic x 0.75"]);
  });
});

describe("Spec 016 fusion: queries written before rrf-group@2 existed", () => {
  test("H76: fourteen new queries, seven where lexical search is right and seven where it is not, none of them measured before", () => {
    expect(newRows).toHaveLength(14);
    expect(newRows.filter((item) => item.kind === "lexical-right")).toHaveLength(7);
    expect(newRows.filter((item) => item.kind === "gap")).toHaveLength(7);
    expect(new Set(newRows.map((item) => item.query)).size).toBe(14);
    const before = new Set(evalQueries().map((query) => query.query));
    for (const item of newRows) {
      expect(before.has(item.query)).toBe(false);
      expect(item.labels).toBe("implementer");
      expect(item.expected.split(" ").length).toBeGreaterThan(0);
      expect(item.within).toBeGreaterThanOrEqual(item.expected.split(" ").length);
      expect(item.within).toBeLessThanOrEqual(5);
      expect(item.why.length).toBeGreaterThan(20);
    }
    expect(newRows.filter((item) => item.kind === "gap" && /\p{Script=Han}/u.test(item.query))).toHaveLength(3);
  });

  test.each([...testPlanRows])("H76: $kind query $query is not worse than lexical-only under rrf-group@2", (item) => {
    const replayed = row(item.query);
    expect(replayed.set).toBe("new");
    const lexicalRanks = ranks(replayed, lexical(replayed));
    expect(isWorseThanLexical(lexicalRanks, ranks(replayed, at2(replayed)), replayed.within)).toBe(false);
    expect(loweredThreads(lexicalRanks, ranks(replayed, at2(replayed)))).toBe(0);
    if (item.kind === "lexical-right") {
      // Lexical search is right, as the label said, and stays right.
      expect(isMet(lexicalRanks, replayed.within)).toBe(true);
      expect(ranks(replayed, at2(replayed))).toEqual(lexicalRanks);
    }
  });

  test("H76: on the new queries rrf-group@2 keeps the 7 lexical rows rrf-group@1 breaks one of, and the 2 gap rows it wins", () => {
    expect(summarize(of("new"), lexical).met).toEqual({ "lexical-right": "7/7", gap: "1/7" });
    expect(summarize(of("new"), at1).met).toEqual({ "lexical-right": "6/7", gap: "2/7" });
    expect(summarize(of("new"), at2).met).toEqual({ "lexical-right": "7/7", gap: "2/7" });
    expect(worse(of("new"), at1)).toEqual(["record collector offsets"]);
    const gap = (query: string) => [ranks(row(query), lexical(row(query))), ranks(row(query), at2(row(query)))];
    expect(gap("abandon a hanging transaction from the command line")).toEqual([[8, 2], [2, 1]]);
    expect(gap("commit markers lost when a partition is unavailable")).toEqual([[4], [1]]);
    // Not retrieved within the bound by either retriever: recorded, not hidden.
    expect(gap("how to report a vulnerability")).toEqual([[null], [null]]);
    expect(gap("out of memory during a long rebalance")).toEqual([[null], [null]]);
    expect(gap("交易協調器回傳過期的快取結果")).toEqual([[null, null], [6, 29]]);
  });
});
