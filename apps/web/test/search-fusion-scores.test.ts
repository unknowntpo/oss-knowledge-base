import { describe, expect, test } from "bun:test";

import { defaultFusionConfig, leadingFullMatchFusionConfig, lexicalHeadFusionConfig } from "@oss-knowledge-base/search";

import { REPLAY_DEPTH, REPLAY_SCHEMA, type ReplayFixture } from "../scripts/capture-search-replay";
import { fuseReplay, isMet, isWorseThanLexical, lexicalOrder, ranksIn } from "../scripts/eval-search-fusion";
import {
  auc,
  backgroundOf,
  CLEAN_FIXTURE,
  judgedCandidates,
  renderReport,
  SCORE_ABLATION,
  SCORED_FIXTURE,
  scoreAlternativeOrder,
  scoredRows,
  semanticThreads,
  SETS,
  SIMILARITY_REPORT,
  summarizeScored,
  type ScoredRow,
  type ScoredSet,
} from "../scripts/eval-search-similarity";
import { evalQueries } from "../scripts/measure-search-hybrid";
import { testPlanRows as cleanRows } from "./search-fusion-clean3.cases";
import { testPlanRows as newRows } from "./search-fusion-new.cases";
import { testPlanRows as verifierRows } from "./search-fusion-verifier.cases";
import { testPlanRows as labelRows } from "./search-similarity-labels.cases";

const scored = await Bun.file(SCORED_FIXTURE).json() as ReplayFixture;
const clean = await Bun.file(CLEAN_FIXTURE).json() as ReplayFixture;
const rows = await scoredRows();
const row = (query: string) => rows.find((item) => item.query === query)!;
const of = (set: ScoredSet) => rows.filter((item) => item.set === set);
const lexical = (item: ScoredRow) => lexicalOrder(item.replay);
const at1 = (item: ScoredRow) => fuseReplay(item.replay, item.projects, defaultFusionConfig);
const at2 = (item: ScoredRow) => fuseReplay(item.replay, item.projects, leadingFullMatchFusionConfig);
const at3 = (item: ScoredRow) => fuseReplay(item.replay, item.projects, lexicalHeadFusionConfig);
const ranks = (item: ScoredRow, order: readonly string[]) => ranksIn(order, item.expected);
const worseThanLexical = (items: readonly ScoredRow[], order: (item: ScoredRow) => readonly string[]) => summarizeScored(items, order).worseThanLexical;

describe("Spec 016 fusion: the scored capture", () => {
  test.each([
    ["the 82 queries asked before", SCORED_FIXTURE, scored, [...evalQueries().map((query) => query.query), ...newRows.map((item) => item.query), ...verifierRows.map((item) => item.query)], 330_000],
    ["the 10 clean queries", CLEAN_FIXTURE, clean, cleanRows.map((item) => item.query), 50_000],
  ] as const)("H90: the capture of %s is dated, bounded, and holds a similarity for every shown semantic thread", async (_, path, fixture, queries, bytes) => {
    expect(fixture.schema).toBe(REPLAY_SCHEMA);
    expect(fixture.release).toBe("feed-2026-10-13T02-07-01-000Z");
    expect(fixture.capturedAt.startsWith("2026-10-13T02:")).toBe(true);
    expect(path.pathname.endsWith(".2026-10-13.json")).toBe(true);
    expect({ lexical: fixture.lexicalRevision, semantic: fixture.semanticRevision, fusion: fixture.fusionRevision, depth: fixture.depth })
      .toEqual({ lexical: "bm25-reference@3", semantic: "@cf/baai/bge-m3@1:1024:title-text@1", fusion: "rrf-group@1", depth: 50 });
    expect(fixture.queries.map((query) => query.query)).toEqual([...queries]);
    expect(Bun.file(path).size).toBeLessThan(bytes);
    expect(await Bun.file(path).text()).not.toMatch(/"title"|"excerpt"|"author"|canonicalUrl/u);
    let similarities = 0;
    for (const query of fixture.queries) {
      for (const [, , lexicalRank, semanticRank, fusedRank, , , similarity] of query.threads) {
        // Present exactly with a semantic rank: a cosine similarity, never above 1.
        expect(similarity !== null).toBe(semanticRank > 0);
        if (similarity !== null) {
          expect(similarity > 0 && similarity <= 1).toBe(true);
          similarities += 1;
        }
        expect(lexicalRank > 0 || semanticRank > 0).toBe(true);
        if (semanticRank > 0) expect(fusedRank).toBeGreaterThan(0);
      }
      // The similarity never rises with the semantic rank.
      const shown = semanticThreads(query).map((thread) => thread[7]!);
      expect(shown).toEqual([...shown].sort((left, right) => right - left));
      if (query.semantic !== "ok") expect(shown).toEqual([]);
    }
    expect(similarities).toBeGreaterThan(fixture.queries.length * 20);
  });

  test("H90: the rows are the 43 measured ones, the 14 new, the verifier's 19 labelled, and the 10 clean; rrf-group@1 replays every live rank", () => {
    expect(Object.fromEntries(SETS.map((set) => [set, of(set).length]))).toEqual({ tuning: 31, "held-out": 12, new: 14, verifier: 19, "clean-3": 10 });
    for (const fixture of [scored, clean]) {
      for (const query of fixture.queries) {
        const live = query.threads.filter((thread) => thread[4] > 0).sort((left, right) => left[4] - right[4]).map((thread) => thread[0]);
        expect([query.query, fuseReplay(query, fixture.projects, defaultFusionConfig)]).toEqual([query.query, live]);
      }
    }
    // The background is read from a shown thread: the 20th itself in most queries, an earlier one otherwise (an upper bound).
    const fused = [...scored.queries, ...clean.queries].filter((query) => query.semantic === "ok");
    expect(fused).toHaveLength(86);
    expect(fused.filter((query) => semanticThreads(query).some((thread) => thread[3] === 20)).length).toBeGreaterThanOrEqual(80);
    for (const query of fused) expect(backgroundOf(query, 20)).toBeGreaterThan(0.3);
  });
});

describe("Spec 016 fusion: what the similarity separates", () => {
  test("H88: an absolute floor does not separate relevant from irrelevant candidates; a margin over the query's 20th does, for those that stand out", async () => {
    const judged = await judgedCandidates();
    const count = (judgement: string, keep: (item: (typeof judged)[number]) => boolean = () => true) => judged.filter((item) => item.judgement === judgement && keep(item)).length;
    expect([judged.length, count("R"), count("P"), count("I")]).toEqual([112, 19, 23, 70]);
    const relevant = judged.filter((item) => item.judgement === "R");
    const irrelevant = judged.filter((item) => item.judgement === "I");
    expect(auc(relevant.map((item) => item.similarity), irrelevant.map((item) => item.similarity))).toBeCloseTo(0.737, 3);
    expect(auc(relevant.map((item) => -item.belowBest), irrelevant.map((item) => -item.belowBest))).toBeCloseTo(0.759, 3);
    expect(auc(relevant.map((item) => item.margin), irrelevant.map((item) => item.margin))).toBeCloseTo(0.876, 3);
    // No floor: 0.50 already loses relevant candidates and keeps four fifths of the irrelevant ones.
    expect([count("R", (item) => item.similarity >= 0.5), count("I", (item) => item.similarity >= 0.5)]).toEqual([17, 55]);
    expect([count("R", (item) => item.similarity >= 0.56), count("I", (item) => item.similarity >= 0.56)]).toEqual([13, 21]);
    // An irrelevant candidate of one query is above the relevant one of another.
    expect(Math.max(...irrelevant.map((item) => item.similarity))).toBeGreaterThan(0.6);
    expect(Math.min(...relevant.map((item) => item.similarity))).toBeLessThan(0.47);
    // The margin, on each side of the chosen 0.04.
    expect([count("R", (item) => item.margin >= 0.03), count("I", (item) => item.margin >= 0.03)]).toEqual([17, 34]);
    expect([count("R", (item) => item.margin >= 0.04), count("I", (item) => item.margin >= 0.04)]).toEqual([17, 16]);
    expect([count("R", (item) => item.margin >= 0.05), count("I", (item) => item.margin >= 0.05)]).toEqual([15, 1]);
    // What the margin cannot do: half of all expected threads with a similarity are in the pack.
    const expected = rows.filter((item) => item.set !== "clean-3").flatMap((item) => item.expected.map((id) => ({ item, thread: item.replay.threads.find((thread) => thread[0] === id) })))
      .filter((entry) => entry.thread !== undefined && entry.thread[7] !== null);
    expect(expected).toHaveLength(148);
    expect(expected.filter((entry) => entry.thread![7]! - backgroundOf(entry.item.replay, 20)! >= 0.04)).toHaveLength(77);
  });

  test("H88: Chinese queries are not scored lower: the best and the 20th similarity are within 0.02 of other queries' at the median", () => {
    const han = (query: string) => /\p{Script=Han}/u.test(query);
    const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor((values.length - 1) / 2)]!;
    const fused = scored.queries.filter((query) => query.semantic === "ok");
    const best = (chinese: boolean) => median(fused.filter((query) => han(query.query) === chinese).map((query) => backgroundOf(query, 1)!));
    const twentieth = (chinese: boolean) => median(fused.filter((query) => han(query.query) === chinese).map((query) => backgroundOf(query, 20)!));
    expect(fused.filter((query) => han(query.query))).toHaveLength(14);
    expect(Math.abs(best(true) - best(false))).toBeLessThan(0.02);
    expect(Math.abs(twentieth(true) - twentieth(false))).toBeLessThan(0.02);
  });

  test("H88: the committed report is what the capture computes", async () => {
    expect(await Bun.file(SIMILARITY_REPORT).text()).toBe(await renderReport());
  });
});

describe("Spec 016 fusion: rrf-group@3 on the scored replay", () => {
  // Ranks of the expected threads: lexical only, rrf-group@2 (as live rrf-group@1 here), rrf-group@3.
  test.each([
    ["StreamsPartitionAssignor", "2 8 1", "26 7 6", "3 8 2", true],
    ["deduplicate strings when spilling", "4 1", "1 21", "1 2", true],
    ["LogManager cleanup", "1 3 2 4", "23 3 1 6", "3 4 1 7", false],
  ])("H86: %s, worse than lexical-only under rrf-group@2", (query, lexicalRanks, at2Ranks, at3Ranks, fixed) => {
    const item = row(query);
    const cells = (order: readonly string[]) => ranks(item, order).join(" ");
    expect(cells(lexical(item))).toBe(lexicalRanks);
    expect(cells(at2(item))).toBe(at2Ranks);
    expect(at2(item)).toEqual(at1(item));
    // Fail first: rrf-group@2 leaves the row worse than lexical-only.
    expect(isWorseThanLexical(ranks(item, lexical(item)), ranks(item, at2(item)), item.within)).toBe(true);
    expect(cells(at3(item))).toBe(at3Ranks);
    expect(isWorseThanLexical(ranks(item, lexical(item)), ranks(item, at3(item)), item.within)).toBe(!fixed);
  });

  test("H86: rows worse than lexical-only fall from 4 to 2 on the verifier's set, and none appears in any other set", () => {
    expect(worseThanLexical(of("verifier"), at2)).toEqual(["LogManager cleanup", "StreamsPartitionAssignor", "ListingTable partition pruning", "deduplicate strings when spilling"]);
    // Known limitations: one thread of each stays outside the bound of 5 (7th, lexical 4th; 6th, lexical 1st).
    expect(worseThanLexical(of("verifier"), at3)).toEqual(["LogManager cleanup", "ListingTable partition pruning"]);
    expect(ranks(row("ListingTable partition pruning"), at3(row("ListingTable partition pruning")))).toEqual([6, 1, 3, 2, 5]);
    for (const set of ["tuning", "held-out", "new", "clean-3"] as const) expect([set, worseThanLexical(of(set), at3)]).toEqual([set, []]);
    // Positive control: rrf-group@1 on the same capture.
    expect(worseThanLexical(of("tuning"), at1)).toHaveLength(7);
  });

  test("H86: no row of any set is worse than rrf-group@2 at its bound, and rows met do not fall", () => {
    const met = (set: ScoredSet, order: (item: ScoredRow) => readonly string[]) => summarizeScored(of(set), order).met;
    for (const set of SETS) {
      expect([set, summarizeScored(of(set), at3).worseThanAt2]).toEqual([set, []]);
      expect(met(set, at3)).toBeGreaterThanOrEqual(met(set, at2));
    }
    expect(SETS.map((set) => `${met(set, lexical)}/${met(set, at1)}/${met(set, at2)}/${met(set, at3)} of ${of(set).length}`))
      .toEqual(["18/14/21/21 of 31", "8/8/9/9 of 12", "8/8/9/9 of 14", "7/7/7/8 of 19", "8/10/10/10 of 10"]);
  });

  test("H86: the owner's first thread is back at its lexical rank, and every gain of rrf-group@2 on a Chinese or gap row is still within its bound", () => {
    const owner = row("consumer network thread request manager");
    expect([ranks(owner, lexical(owner)), ranks(owner, at2(owner)), ranks(owner, at3(owner))]).toEqual([[2, 21, 9], [3, 39, 24], [2, 39, 24]]);
    const kept: Record<string, readonly (number | null)[]> = {
      "分層儲存的配額沒有生效": [8, null],
      "反向 DNS 查詢阻塞網路執行緒": [5, 2],
      "心跳請求的初始間隔": [2, 1],
      "SMJ spill": [16, 35, 14],
      "hash join that fits in limited RAM": [1],
      "commit markers lost when a partition is unavailable": [1],
      "分區領導者選舉": [1, null],
      "config value validation for client quotas": [2, 4],
      "安全性政策": [2, 1],
      "CPU busy loop after login failure": [3, 2],
    };
    for (const [query, expected] of Object.entries(kept)) {
      expect([query, ranks(row(query), at3(row(query)))]).toEqual([query, expected]);
      expect([query, ranks(row(query), at2(row(query)))]).toEqual([query, expected]);
    }
    // What it costs: threads that rrf-group@2 ranked higher, each still within its bound, or outside it either way.
    const lowered: Record<string, readonly [readonly (number | null)[], readonly (number | null)[]]> = {
      "controller sign-up retried after timing out": [[3], [5]],
      "重新認證失敗後 CPU 使用率過高": [[13], [15]],
      "client spins at 100% cpu": [[1, null, null, null], [3, null, null, null]],
      "abandon a hanging transaction from the command line": [[2, 1], [4, 1]],
      "producer blocked on metadata": [[3, 2, 1], [4, 2, 1]],
      "unclean leader election": [[4, 1], [5, 1]],
    };
    for (const [query, [before, after]] of Object.entries(lowered)) {
      expect([query, ranks(row(query), at2(row(query))), ranks(row(query), at3(row(query)))]).toEqual([query, before, after]);
      expect(isMet(ranks(row(query), at3(row(query))), row(query).within)).toBe(isMet(ranks(row(query), at2(row(query))), row(query).within));
    }
  });

  test("H86: the alternatives' scorer agrees with `fuseRankings` for rrf-group@2 and rrf-group@3 on every row", () => {
    for (const item of rows) {
      expect([item.query, scoreAlternativeOrder(item.replay, {})]).toEqual([item.query, at2(item)]);
      expect([item.query, scoreAlternativeOrder(item.replay, { head: 3, margin: 0.04 })]).toEqual([item.query, at3(item)]);
      expect(at3(item).some((id) => id.startsWith("unseen:"))).toBe(false);
      expect(at3(item)).toHaveLength(Math.min(REPLAY_DEPTH, at2(item).length));
    }
    // The rule reorders a minority of the rows.
    expect(rows.filter((item) => String(at3(item)) !== String(at2(item))).length).toBeLessThan(rows.length / 2);
  });

  test("H86: of the score-aware alternatives, only a protected head of 2 or 3 at a margin of 0.03 or 0.04 has no row worse than rrf-group@2 and fewer worse than lexical-only", () => {
    const measured = rows.filter((item) => item.set !== "clean-3");
    const base = summarizeScored(measured, at2).worseThanLexical.length;
    const clean = SCORE_ABLATION.filter(([, alternative]) => {
      const summary = summarizeScored(measured, (item) => scoreAlternativeOrder(item.replay, alternative));
      return summary.worseThanAt2.length === 0 && summary.worseThanLexical.length < base;
    }).map(([name]) => name);
    expect(clean).toEqual(["head 2, margin 0.04", "head 3, margin 0.03", "head 3, margin 0.04 = rrf-group@3"]);
  });
});

describe("Spec 016 fusion: queries written for rrf-group@3", () => {
  test("H83: the verifier's set is 9 lexical-right, 8 gap, and 3 Chinese queries, one of them unlabelled", () => {
    expect(verifierRows.map((item) => item.kind).reduce<Record<string, number>>((count, kind) => ({ ...count, [kind]: (count[kind] ?? 0) + 1 }), {}))
      .toEqual({ "lexical-right": 9, gap: 8, chinese: 3 });
    expect(verifierRows.filter((item) => item.expected === null).map((item) => item.query)).toEqual(["ReplicaManager fetch"]);
  });

  test("H84: on the ten clean queries rrf-group@3 ties rrf-group@2 on nine and moves one thread up", () => {
    const changed = of("clean-3").filter((item) => String(ranks(item, at3(item))) !== String(ranks(item, at2(item))));
    expect(changed.map((item) => [item.query, ranks(item, lexical(item)), ranks(item, at2(item)), ranks(item, at3(item))]))
      .toEqual([["windowed restore optimisation backport", [3, 1, 2], [2, 1, 5], [2, 1, 4]]]);
    expect(cleanRows.filter((item) => item.kind === "lexical-right")).toHaveLength(7);
    expect(cleanRows.filter((item) => item.kind === "gap")).toHaveLength(3);
  });
});
