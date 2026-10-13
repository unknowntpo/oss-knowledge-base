/**
 * Spec 016 fusion `rrf-group@3` (H86, H88): what the similarity of a semantic candidate says, and
 * what a fusion rule can do with it, over the committed capture of 2026-10-13 that holds
 * `signals.semanticScore` (`test/fixtures/hybrid-replay.scored.2026-10-13.json`, and the ten
 * queries of `hybrid-replay.clean-3.2026-10-13.json`). Offline and deterministic; prints the
 * report committed as `test/fixtures/hybrid-similarity-report.txt` (compared in CI).
 *
 *   bun run eval:search-similarity [--write] [--rows]
 *
 * `rrf-group@1`, `@2`, and `@3` run through the real `fuseRankings`. The other rows are
 * alternatives scored here only. A semantic thread the response did not show (below its 50
 * results) has no recorded similarity: it is given the similarity of the shown thread before it,
 * an upper bound, so a background read at such a rank is an upper bound too.
 */
import { defaultFusionConfig, leadingFullMatchFusionConfig, lexicalHeadFusionConfig, type FusionConfigV1 } from "@oss-knowledge-base/search";

import { testPlanRows as guardRows } from "../../../packages/search/test/real-corpus-guards.cases";
import { testPlanRows as realCorpusRows } from "../../../packages/search/test/real-corpus.cases";
import { testPlanRows as cleanRows } from "../test/search-fusion-clean3.cases";
import { testPlanRows as newRows } from "../test/search-fusion-new.cases";
import { testPlanRows as verifierRows } from "../test/search-fusion-verifier.cases";
import { testPlanRows as hybridRows } from "../test/search-hybrid-eval.cases";
import { testPlanRows as labelRows } from "../test/search-similarity-labels.cases";
import { REPLAY_DEPTH, type ReplayFixture, type ReplayQuery, type ReplayThread } from "./capture-search-replay";
import { fuseReplay, isMet, isWorseThanLexical, lexicalOrder, ranksIn } from "./eval-search-fusion";

export const SCORED_FIXTURE = new URL("../test/fixtures/hybrid-replay.scored.2026-10-13.json", import.meta.url);
export const CLEAN_FIXTURE = new URL("../test/fixtures/hybrid-replay.clean-3.2026-10-13.json", import.meta.url);
export const SIMILARITY_REPORT = new URL("../test/fixtures/hybrid-similarity-report.txt", import.meta.url);

export const SETS = ["tuning", "held-out", "new", "verifier", "clean-3"] as const;
export type ScoredSet = (typeof SETS)[number];

export interface ScoredRow {
  readonly set: ScoredSet;
  readonly kind: string;
  readonly query: string;
  readonly expected: readonly string[];
  readonly acceptable: readonly string[];
  readonly within: number;
  readonly replay: ReplayQuery;
  readonly projects: readonly string[];
}

const ids = (cell: string | null) => (cell === null || cell === "" ? [] : cell.split(" "));

/**
 * Every labelled row with its scored capture. `tuning` and `held-out` are the 43 rows of the first
 * measurement, split as in `eval-search-fusion.ts`; `new` the 14 queries of H76; `verifier` the
 * verifier's 20 (H83; the one without a label is left out); `clean-3` the 10 of H84.
 */
export async function scoredRows(): Promise<readonly ScoredRow[]> {
  const scored = await Bun.file(SCORED_FIXTURE).json() as ReplayFixture;
  const clean = await Bun.file(CLEAN_FIXTURE).json() as ReplayFixture;
  const of = (fixture: ReplayFixture, query: string) => {
    const replay = fixture.queries.find((item) => item.query === query);
    if (replay === undefined) throw new Error(`The scored capture has no query "${query}"`);
    return { replay, projects: fixture.projects };
  };
  const measured = [
    ...realCorpusRows.map((row) => ({ kind: row.labels === "owner" ? "owner" : "real-corpus", query: row.query, expected: ids(row.expected), acceptable: ids(row.acceptable), within: row.within })),
    ...guardRows.map((row) => ({ kind: "guard", query: row.query, expected: ids(row.expected), acceptable: [] as string[], within: row.within })),
    ...hybridRows.map((row) => ({ kind: row.kind as string, query: row.query, expected: ids(row.expected), acceptable: ids(row.acceptable), within: row.within })),
  ];
  const seen: Record<string, number> = {};
  const rows: ScoredRow[] = measured.map((row) => {
    const position = seen[row.kind] ?? 0;
    seen[row.kind] = position + 1;
    return { ...row, set: row.kind !== "owner" && position % 3 === 2 ? "held-out" : "tuning", ...of(scored, row.query) };
  });
  for (const row of newRows) rows.push({ set: "new", kind: row.kind, query: row.query, expected: ids(row.expected), acceptable: [], within: row.within, ...of(scored, row.query) });
  for (const row of verifierRows) {
    if (row.expected !== null) rows.push({ set: "verifier", kind: row.kind, query: row.query, expected: ids(row.expected), acceptable: [], within: row.within, ...of(scored, row.query) });
  }
  for (const row of cleanRows) rows.push({ set: "clean-3", kind: row.kind, query: row.query, expected: ids(row.expected), acceptable: [], within: row.within, ...of(clean, row.query) });
  return rows;
}

/** The semantic threads of a captured query that carry a similarity, best first. */
export function semanticThreads(replay: ReplayQuery): readonly ReplayThread[] {
  return replay.threads.filter((thread) => thread[3] > 0 && thread[7] !== null).sort((left, right) => left[3] - right[3]);
}

/** The similarity of the shown semantic thread at `reference`, or of the nearest shown one before it. */
export function backgroundOf(replay: ReplayQuery, reference: number): number | undefined {
  const shown = semanticThreads(replay);
  return (shown.filter((thread) => thread[3] <= reference).at(-1) ?? shown[0])?.[7] ?? undefined;
}

/** A score-aware alternative, on top of `rrf-group@2`. `rrf-group@3` is `{ head: 3, margin: 0.04 }`. */
export interface ScoreAlternative {
  /** Candidates with a similarity below this never enter fusion. */
  readonly floor?: number;
  /** Candidates more than this below the query's best similarity never enter fusion. */
  readonly belowBest?: number;
  /** The semantic contribution is multiplied by (similarity - background) / this, between 0 and 1. */
  readonly weightOver?: number;
  /** The semantic contribution counts only at or above this margin over the background. */
  readonly gateOver?: number;
  /** A lexical thread semantic retrieval did not return contributes as if at this semantic rank. */
  readonly absentRank?: number;
  /** The first `head` lexical threads are passed only by a thread at least `margin` above the background. */
  readonly head?: number;
  readonly margin?: number;
}

export function scoreAlternativeOrder(replay: ReplayQuery, alternative: ScoreAlternative, reference = 20): readonly string[] {
  const k = 60;
  const required = replay.words.map((word) => replay.terms.indexOf(word));
  const full = (masks: readonly number[]) => required.length > 0 && masks.some((mask) => required.every((bit) => bit >= 0 && (mask >> bit & 1) === 1));
  const lexical = replay.threads.filter((thread) => thread[2] > 0).sort((left, right) => left[2] - right[2]);
  const firstPartial = lexical.findIndex((thread) => !full(thread[5]));
  const kept = firstPartial < 0 ? lexical.length : firstPartial;
  const background = backgroundOf(replay, reference) ?? 0;
  const best = Math.max(0, ...semanticThreads(replay).map((thread) => thread[7]!));
  const weight = (thread: ReplayThread) => {
    const similarity = thread[7] ?? 0;
    if (alternative.floor !== undefined && similarity < alternative.floor) return 0;
    if (alternative.belowBest !== undefined && similarity < best - alternative.belowBest) return 0;
    if (alternative.gateOver !== undefined) return similarity - background >= alternative.gateOver ? 1 : 0;
    if (alternative.weightOver !== undefined) return Math.max(0, Math.min(1, (similarity - background) / alternative.weightOver));
    return 1;
  };
  const dropping = alternative.floor !== undefined || alternative.belowBest !== undefined;
  const fused = replay.threads
    .map((thread) => {
      const [id, , lexicalRank, semanticRank, , , exact] = thread;
      const semantic = semanticRank > 0 ? weight(thread) / (k + semanticRank) : lexicalRank > 0 && alternative.absentRank !== undefined ? 1 / (k + alternative.absentRank) : 0;
      return { id, thread, exact, kept: lexicalRank > 0 && lexicalRank <= kept, lexicalRank: lexicalRank > 0 ? lexicalRank : Infinity, score: (lexicalRank > 0 ? 1 / (k + lexicalRank) : 0) + semantic, dropped: dropping && lexicalRank === 0 && weight(thread) === 0 };
    })
    .filter((item) => !item.dropped)
    .sort((left, right) =>
      right.exact - left.exact ||
      Number(right.kept) - Number(left.kept) ||
      (left.kept && right.kept ? left.lexicalRank - right.lexicalRank : 0) ||
      right.score - left.score ||
      left.lexicalRank - right.lexicalRank ||
      left.id.localeCompare(right.id));
  if (alternative.head === undefined) return fused.slice(0, REPLAY_DEPTH).map((item) => item.id);
  const margin = alternative.margin ?? 0;
  const standsOut = (thread: ReplayThread) => thread[3] > 0 && thread[7] !== null && thread[7] - background >= margin;
  const head = fused.filter((item) => item.lexicalRank <= alternative.head!).sort((left, right) => left.lexicalRank - right.lexicalRank);
  const placed = new Set<string>();
  const order: string[] = [];
  const place = (id: string) => {
    if (placed.has(id)) return;
    placed.add(id);
    order.push(id);
  };
  for (const item of fused) {
    if (item.exact === 0 && !standsOut(item.thread)) {
      for (const thread of head) if (thread.lexicalRank < item.lexicalRank) place(thread.id);
    }
    place(item.id);
  }
  return order.slice(0, REPLAY_DEPTH);
}

export const REVISIONS: readonly (readonly [string, FusionConfigV1])[] = [
  ["rrf-group@1", defaultFusionConfig],
  ["rrf-group@2", leadingFullMatchFusionConfig],
  ["rrf-group@3", lexicalHeadFusionConfig],
];

export const SCORE_ABLATION: readonly (readonly [string, ScoreAlternative])[] = [
  ["rrf-group@2", {}],
  ["floor: similarity >= 0.45", { floor: 0.45 }],
  ["floor: similarity >= 0.50", { floor: 0.5 }],
  ["floor: similarity >= 0.54", { floor: 0.54 }],
  ["within 0.08 of the best", { belowBest: 0.08 }],
  ["within 0.06 of the best", { belowBest: 0.06 }],
  ["within 0.04 of the best", { belowBest: 0.04 }],
  ["weight by margin / 0.05", { weightOver: 0.05 }],
  ["counted only at margin >= 0.04", { gateOver: 0.04 }],
  ["absent lexical thread = rank 50", { absentRank: 50 }],
  ["absent lexical thread = rank 30", { absentRank: 30 }],
  ["head 1, margin 0.04", { head: 1, margin: 0.04 }],
  ["head 2, margin 0.04", { head: 2, margin: 0.04 }],
  ["head 3, margin 0.03", { head: 3, margin: 0.03 }],
  ["head 3, margin 0.04 = rrf-group@3", { head: 3, margin: 0.04 }],
  ["head 3, margin 0.05", { head: 3, margin: 0.05 }],
  ["head 5, margin 0.04", { head: 5, margin: 0.04 }],
  ["head 10, margin 0.04", { head: 10, margin: 0.04 }],
];

export interface ScoredSummary {
  readonly rows: number;
  readonly met: number;
  /** Rows with an expected thread lexical-only ranks within the bound and this does not. */
  readonly worseThanLexical: readonly string[];
  /** Rows with an expected thread `rrf-group@2` ranks within the bound and this does not. */
  readonly worseThanAt2: readonly string[];
  readonly ndcg: number;
}

export function summarizeScored(rows: readonly ScoredRow[], order: (row: ScoredRow) => readonly string[]): ScoredSummary {
  const at2 = (row: ScoredRow) => fuseReplay(row.replay, row.projects, leadingFullMatchFusionConfig);
  let met = 0;
  let ndcg = 0;
  const worseThanLexical: string[] = [];
  const worseThanAt2: string[] = [];
  for (const row of rows) {
    const fused = order(row);
    const ranks = ranksIn(fused, row.expected);
    if (isMet(ranks, row.within)) met += 1;
    if (isWorseThanLexical(ranksIn(lexicalOrder(row.replay), row.expected), ranks, row.within)) worseThanLexical.push(row.query);
    if (isWorseThanLexical(ranksIn(at2(row), row.expected), ranks, row.within)) worseThanAt2.push(row.query);
    const gain = (id: string) => (row.expected.includes(id) ? 3 : row.acceptable.includes(id) ? 1 : 0);
    const dcg = (gains: readonly number[]) => gains.slice(0, 10).reduce((total, value, index) => total + value / Math.log2(index + 2), 0);
    ndcg += dcg(fused.map(gain)) / dcg([...row.expected.map(() => 3), ...row.acceptable.map(() => 1)]);
  }
  return { rows: rows.length, met, worseThanLexical, worseThanAt2, ndcg: rows.length === 0 ? 0 : ndcg / rows.length };
}

export interface Judged {
  readonly query: string;
  readonly type: string;
  readonly judgement: "R" | "P" | "I";
  readonly similarity: number;
  /** Below the query's best similarity. */
  readonly belowBest: number;
  /** Above the query's 20th semantic thread. */
  readonly margin: number;
}

/** The hand-labelled candidates with their similarity, from the scored capture. */
export async function judgedCandidates(): Promise<readonly Judged[]> {
  const scored = await Bun.file(SCORED_FIXTURE).json() as ReplayFixture;
  const judged: Judged[] = [];
  for (const row of labelRows) {
    const replay = scored.queries.find((item) => item.query === row.query)!;
    const shown = semanticThreads(replay);
    const background = backgroundOf(replay, 20)!;
    [...row.judgements].forEach((judgement, index) => {
      const thread = shown.find((item) => item[3] === index + 1);
      if (thread === undefined) throw new Error(`"${row.query}" has no semantic thread at rank ${index + 1}`);
      judged.push({ query: row.query, type: row.type, judgement: judgement as Judged["judgement"], similarity: thread[7]!, belowBest: shown[0]![7]! - thread[7]!, margin: thread[7]! - background });
    });
  }
  return judged;
}

/** The chance that a value drawn from `positive` is above one drawn from `negative` (ties count half). */
export function auc(positive: readonly number[], negative: readonly number[]): number {
  let wins = 0;
  for (const left of positive) for (const right of negative) wins += left > right ? 1 : left === right ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}

const quantiles = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (share: number) => sorted[Math.floor(share * (sorted.length - 1))]!.toFixed(3);
  return `n ${String(sorted.length).padStart(3)}  min ${at(0)}  p25 ${at(0.25)}  median ${at(0.5)}  p75 ${at(0.75)}  max ${at(1)}`;
};

export async function renderSeparation(): Promise<string> {
  const judged = await judgedCandidates();
  const scored = await Bun.file(SCORED_FIXTURE).json() as ReplayFixture;
  const of = (judgement: string) => judged.filter((item) => item.judgement === judgement);
  const lines = [
    `Similarity of semantic candidates, capture of ${scored.release} (${scored.capturedAt}).`,
    `Hand labels: the first 7 semantic threads of ${labelRows.length} queries, ${judged.length} candidates: R relevant ${of("R").length}, P partly ${of("P").length}, I irrelevant ${of("I").length}.`,
    "margin: similarity minus the similarity of the query's 20th semantic thread. below best: the best similarity of the query minus this one.",
    "",
  ];
  for (const [name, read, sign] of [["similarity", (item: Judged) => item.similarity, 1], ["below best", (item: Judged) => item.belowBest, -1], ["margin", (item: Judged) => item.margin, 1]] as const) {
    lines.push(name);
    for (const judgement of ["R", "P", "I"]) lines.push(`  ${judgement}  ${quantiles(of(judgement).map(read))}`);
    lines.push(`  AUC, R against I: ${auc(of("R").map((item) => sign * read(item)), of("I").map((item) => sign * read(item))).toFixed(3)}`);
  }
  const kept = (read: (item: Judged) => number, threshold: number) => {
    const above = judged.filter((item) => read(item) >= threshold);
    return `R ${above.filter((item) => item.judgement === "R").length}/${of("R").length}  P ${above.filter((item) => item.judgement === "P").length}/${of("P").length}  I ${above.filter((item) => item.judgement === "I").length}/${of("I").length}`;
  };
  lines.push("", "kept by an absolute floor");
  for (const floor of [0.45, 0.5, 0.52, 0.54, 0.56, 0.58, 0.6]) lines.push(`  similarity >= ${floor.toFixed(2)}  ${kept((item) => item.similarity, floor)}`);
  lines.push("kept by a margin over the query's 20th semantic thread");
  for (const margin of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08]) lines.push(`  margin >= ${margin.toFixed(2)}  ${kept((item) => item.margin, margin)}`);
  lines.push("", "by query type: similarity of R | of I");
  for (const type of [...new Set(labelRows.map((row) => row.type))]) {
    const relevant = judged.filter((item) => item.type === type && item.judgement === "R").map((item) => item.similarity);
    const irrelevant = judged.filter((item) => item.type === type && item.judgement === "I").map((item) => item.similarity);
    lines.push(`  ${type.padEnd(15)} R ${relevant.length === 0 ? "none" : quantiles(relevant)} | I ${irrelevant.length === 0 ? "none" : quantiles(irrelevant)}`);
  }
  const han = (query: string) => /\p{Script=Han}/u.test(query);
  const fusedQueries = scored.queries.filter((query) => query.semantic === "ok");
  const at = (queries: readonly ReplayQuery[], rank: number) => queries.map((query) => backgroundOf(query, rank)!);
  lines.push("", "every fused query: similarity of its best and of its 20th semantic thread");
  for (const [name, queries] of [["queries with Han characters", fusedQueries.filter((query) => han(query.query))], ["other queries", fusedQueries.filter((query) => !han(query.query))]] as const) {
    lines.push(`  ${name.padEnd(28)} best ${quantiles(at(queries, 1))} | 20th ${quantiles(at(queries, 20))}`);
  }
  const rows = (await scoredRows()).filter((row) => row.set !== "clean-3");
  const expected = rows.flatMap((row) => row.expected.map((id) => ({ row, thread: row.replay.threads.find((thread) => thread[0] === id) })));
  const withSimilarity = expected.filter((item) => item.thread !== undefined && item.thread[7] !== null);
  lines.push(
    "",
    `expected threads of the labelled rows: ${expected.length}; with a similarity ${withSimilarity.length}; lexical only (no semantic rank) ${expected.filter((item) => item.thread !== undefined && item.thread[3] === 0).length}; in neither response ${expected.filter((item) => item.thread === undefined).length}`,
    `  similarity ${quantiles(withSimilarity.map((item) => item.thread![7]!))}`,
    `  margin     ${quantiles(withSimilarity.map((item) => item.thread![7]! - backgroundOf(item.row.replay, 20)!))}`,
    `  margin >= 0.04: ${withSimilarity.filter((item) => item.thread![7]! - backgroundOf(item.row.replay, 20)! >= 0.04).length} of ${withSimilarity.length}`,
  );
  return `${lines.join("\n")}\n`;
}

export function renderScoreAblation(rows: readonly ScoredRow[]): string {
  const lines = [
    "Score-aware alternatives on top of rrf-group@2. Per set: rows met / rows, w = rows worse than lexical-only at the bound,",
    "b = rows worse than rrf-group@2 at the bound, and nDCG@10.",
    "",
    `${"variant".padEnd(36)}${SETS.map((set) => set.padEnd(24)).join("")}`,
  ];
  const cell = (summary: ScoredSummary) => `${summary.met}/${summary.rows} w${summary.worseThanLexical.length} b${summary.worseThanAt2.length} ${summary.ndcg.toFixed(3)}`.padEnd(24);
  const line = (name: string, order: (row: ScoredRow) => readonly string[]) => `${name.padEnd(36)}${SETS.map((set) => cell(summarizeScored(rows.filter((row) => row.set === set), order))).join("")}`;
  lines.push(line("lexical only (semantic=off)", (row) => lexicalOrder(row.replay)));
  lines.push(line("rrf-group@1", (row) => fuseReplay(row.replay, row.projects, defaultFusionConfig)));
  for (const [name, alternative] of SCORE_ABLATION) lines.push(line(name, (row) => scoreAlternativeOrder(row.replay, alternative)));
  return `${lines.join("\n")}\n`;
}

const cells = (ranks: readonly (number | null)[]) => ranks.map((rank) => rank ?? `>${REPLAY_DEPTH}`).join(", ") || "—";

/** Each labelled row's ranks: lexical-only, then the three revisions. */
export function renderScoredRows(rows: readonly ScoredRow[]): string {
  return [
    "| set | kind | query | within | lexical only | rrf-group@1 | rrf-group@2 | rrf-group@3 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.set} | ${row.kind} | ${row.query.replaceAll("|", "\\|")} | ${row.within} | ${cells(ranksIn(lexicalOrder(row.replay), row.expected))} | ${
      REVISIONS.map(([, config]) => cells(ranksIn(fuseReplay(row.replay, row.projects, config), row.expected))).join(" | ")} |`),
  ].join("\n");
}

export async function renderReport(): Promise<string> {
  return `${await renderSeparation()}\n${renderScoreAblation(await scoredRows())}`;
}

if (import.meta.main) {
  const report = await renderReport();
  if (process.argv.includes("--write")) await Bun.write(SIMILARITY_REPORT, report);
  console.log(report);
  if (process.argv.includes("--rows")) console.log(renderScoredRows(await scoredRows()));
}
