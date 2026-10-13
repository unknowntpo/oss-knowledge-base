/**
 * Spec 016 fusion (H75, H76): replays fusion revisions and the alternatives the spec weighed over
 * the committed capture of the public Dev API (`capture-search-replay.ts`), offline and
 * deterministically, and prints the ablation table committed as
 * `test/fixtures/hybrid-fusion-ablation.txt` (compared in CI).
 *
 *   bun run eval:search-fusion [--write] [--rows] [--time]
 *
 * `--write` rewrites the committed report, `--rows` prints each row's ranks, and `--time` prints
 * the CPU time of one fusion per revision over the captured rankings (H82).
 *
 * `rrf-group@1` and `rrf-group@2` run through the real `fuseRankings`; the replay of `@1`
 * reproduces every fused rank the live response held, and the replay of `@2` is exact for the
 * first 50 results (its order is the kept threads, then the `@1` order without them). The other
 * rows are alternatives scored here only: they are approximate wherever a semantic candidate the
 * response did not show (below its 50 results) would have entered the list.
 */
import {
  defaultFusionConfig,
  fuseRankings,
  leadingFullMatchFusionConfig,
  type FusionConfigV1,
  type LexicalSearchResultV1,
  type SemanticCandidateV1,
} from "@oss-knowledge-base/search";

import { testPlanRows as guardRows } from "../../../packages/search/test/real-corpus-guards.cases";
import { testPlanRows as realCorpusRows } from "../../../packages/search/test/real-corpus.cases";
import { testPlanRows as newRows } from "../test/search-fusion-new.cases";
import { testPlanRows as hybridRows } from "../test/search-hybrid-eval.cases";
import { REPLAY_DEPTH, type ReplayFixture, type ReplayQuery } from "./capture-search-replay";

export const REPLAY_FIXTURE = new URL("../test/fixtures/hybrid-replay.2026-10-13.json", import.meta.url);
export const NEW_QUERIES_FIXTURE = new URL("../test/fixtures/hybrid-replay.new-queries.2026-10-13.json", import.meta.url);
export const ABLATION_REPORT = new URL("../test/fixtures/hybrid-fusion-ablation.txt", import.meta.url);

export type RowSet = "tuning" | "held-out" | "new";
export const KINDS = ["real-corpus", "owner", "guard", "chinese", "vocabulary-gap", "lexical-right", "gap"] as const;

export interface ReplayRow {
  readonly set: RowSet;
  readonly kind: (typeof KINDS)[number];
  readonly query: string;
  readonly expected: readonly string[];
  readonly acceptable: readonly string[];
  readonly within: number;
  readonly replay: ReplayQuery;
  readonly projects: readonly string[];
}

const ids = (cell: string | null) => (cell === null || cell === "" ? [] : cell.split(" "));

/**
 * The labelled rows with their captured rankings. Hold-out: every third row of each kind, in
 * list order, of the 43 rows measured on 2026-10-13 (the owner's single row stays a tuning row);
 * parameters were compared on the tuning rows only. The 14 new queries are a set of their own.
 */
export async function replayRows(): Promise<readonly ReplayRow[]> {
  const measured = await Bun.file(REPLAY_FIXTURE).json() as ReplayFixture;
  const added = await Bun.file(NEW_QUERIES_FIXTURE).json() as ReplayFixture;
  const labelled = [
    ...realCorpusRows.map((row) => ({ kind: row.labels === "owner" ? "owner" as const : "real-corpus" as const, query: row.query, expected: ids(row.expected), acceptable: ids(row.acceptable), within: row.within })),
    ...guardRows.map((row) => ({ kind: "guard" as const, query: row.query, expected: ids(row.expected), acceptable: [], within: row.within })),
    ...hybridRows.map((row) => ({ kind: row.kind, query: row.query, expected: ids(row.expected), acceptable: ids(row.acceptable), within: row.within })),
  ];
  const seen: Record<string, number> = {};
  const rows: ReplayRow[] = labelled.map((row) => {
    const position = seen[row.kind] ?? 0;
    seen[row.kind] = position + 1;
    return { ...row, set: row.kind !== "owner" && position % 3 === 2 ? "held-out" : "tuning", replay: replayOf(measured, row.query), projects: measured.projects };
  });
  for (const row of newRows) {
    rows.push({ set: "new", kind: row.kind, query: row.query, expected: ids(row.expected), acceptable: [], within: row.within, replay: replayOf(added, row.query), projects: added.projects });
  }
  return rows;
}

function replayOf(fixture: ReplayFixture, query: string): ReplayQuery {
  const replay = fixture.queries.find((item) => item.query === query);
  if (replay === undefined) throw new Error(`The replay fixture has no query "${query}"`);
  return replay;
}

/** What `fuseRankings` is given for a captured query: its lexical ranking and its semantic candidates. */
export function fusionInput(replay: ReplayQuery, projects: readonly string[]): { readonly lexical: readonly LexicalSearchResultV1[]; readonly semantic: readonly SemanticCandidateV1[] } {
  const lexical = replay.threads.filter((thread) => thread[2] > 0).sort((left, right) => left[2] - right[2]).map((thread): LexicalSearchResultV1 => ({
    groupRootRecordId: thread[0],
    projectId: projects[thread[1]]!,
    score: 0,
    exactMatch: thread[6] === 1,
    matches: thread[5].map((mask, index) => ({
      chunkId: `${thread[0]}#${index}`, recordId: thread[0], excerpt: "", canonicalUrl: "", author: "", occurredAt: "", sourceVersion: "",
      matchedTerms: replay.terms.filter((_, bit) => (mask >> bit & 1) === 1), exactMatch: thread[6] === 1, score: 0,
    })),
  }));
  const ranked = new Map(replay.threads.filter((thread) => thread[3] > 0).map((thread) => [thread[3], thread]));
  const semantic: SemanticCandidateV1[] = [];
  for (let rank = 1; rank <= Math.max(0, ...ranked.keys()); rank += 1) {
    const thread = ranked.get(rank);
    // A rank the response did not show is a thread only semantic retrieval returned, below its 50 results.
    const id = thread?.[0] ?? `unseen:semantic:${rank}`;
    semantic.push({ chunkId: `${id}#s`, recordId: id, groupRootRecordId: id, projectId: projects[thread?.[1] ?? 0]!, score: thread?.[7] ?? 1 / rank });
  }
  return { lexical, semantic };
}

/** The first 50 threads a fusion revision returns for a captured query. */
export function fuseReplay(replay: ReplayQuery, projects: readonly string[], config: FusionConfigV1): readonly string[] {
  return fuseRankings({ ...fusionInput(replay, projects), config, queryWords: replay.words }).slice(0, REPLAY_DEPTH).map((result) => result.groupRootRecordId);
}

export const lexicalOrder = (replay: ReplayQuery): readonly string[] =>
  replay.threads.filter((thread) => thread[2] > 0).sort((left, right) => left[2] - right[2]).map((thread) => thread[0]);

/** An alternative the spec weighed, scored here only; `rrf-group@1` is all defaults. */
export interface Alternative {
  /** RRF constant of the lexical and of the semantic ranking. */
  readonly k?: number;
  /** Weight of the semantic contribution. */
  readonly semanticWeight?: number;
  /** Only the first `depth` semantic threads enter fusion. */
  readonly depth?: number;
  /** `leading`: `rrf-group@2`. `all`: every full match first. A number: that many lexical threads keep their places. */
  readonly keep?: "leading" | "all" | number;
  /** Lexical order, then the threads only semantic retrieval returned. */
  readonly append?: true;
}

export function alternativeOrder(replay: ReplayQuery, alternative: Alternative): readonly string[] {
  const k = alternative.k ?? 60;
  const depth = alternative.depth ?? Infinity;
  const required = replay.words.map((word) => replay.terms.indexOf(word));
  const full = (masks: readonly number[]) => required.length > 0 && masks.some((mask) => required.every((bit) => bit >= 0 && (mask >> bit & 1) === 1));
  const lexical = replay.threads.filter((thread) => thread[2] > 0).sort((left, right) => left[2] - right[2]);
  const firstPartial = lexical.findIndex((thread) => !full(thread[5]));
  const leading = alternative.keep === "leading" ? (firstPartial < 0 ? lexical.length : firstPartial) : typeof alternative.keep === "number" ? alternative.keep : 0;
  return replay.threads
    .filter((thread) => thread[2] > 0 || (thread[3] > 0 && thread[3] <= depth))
    .map((thread) => {
      const [id, , lexicalRank, semanticRank, , masks, exact] = thread;
      const kept = lexicalRank > 0 && (lexicalRank <= leading || (alternative.keep === "all" && full(masks)) || alternative.append === true);
      const semantic = semanticRank > 0 && semanticRank <= depth ? (alternative.semanticWeight ?? 1) / (k + semanticRank) : 0;
      return { id, exact, kept, lexicalRank: lexicalRank > 0 ? lexicalRank : Infinity, score: (lexicalRank > 0 ? 1 / (k + lexicalRank) : 0) + semantic };
    })
    .sort((left, right) =>
      right.exact - left.exact ||
      Number(right.kept) - Number(left.kept) ||
      (left.kept && right.kept ? left.lexicalRank - right.lexicalRank : 0) ||
      right.score - left.score ||
      left.lexicalRank - right.lexicalRank ||
      left.id.localeCompare(right.id))
    .slice(0, REPLAY_DEPTH)
    .map((item) => item.id);
}

/** 1-based ranks of a row's expected threads, `null` beyond the 50 results. */
export function ranksIn(order: readonly string[], threads: readonly string[]): readonly (number | null)[] {
  return threads.map((thread) => {
    const position = order.indexOf(thread);
    return position < 0 || position >= REPLAY_DEPTH ? null : position + 1;
  });
}

export const isMet = (ranks: readonly (number | null)[], within: number) => ranks.every((rank) => rank !== null && rank <= within);

/**
 * The acceptance rule (H75): a row is worse than lexical-only when an expected thread that
 * lexical-only ranks within the row's bound is outside the bound, or gone.
 */
export function isWorseThanLexical(lexicalRanks: readonly (number | null)[], ranks: readonly (number | null)[], within: number): boolean {
  return lexicalRanks.some((rank, index) => rank !== null && rank <= within && !(ranks[index] !== null && ranks[index]! <= within));
}

/** Expected threads lexical-only returns that rank lower (or are gone): reported, not a gate. */
export function loweredThreads(lexicalRanks: readonly (number | null)[], ranks: readonly (number | null)[]): number {
  return lexicalRanks.filter((rank, index) => rank !== null && !(ranks[index] !== null && ranks[index]! <= rank)).length;
}

/**
 * The Chinese and vocabulary-gap rows `rrf-group@1` improved on Dev (2026-10-13). A win is kept
 * when a row that `@1` met and lexical-only did not is still met, and otherwise when no expected
 * thread ranks below its lexical-only rank and one ranks above it.
 */
export const WINS: readonly string[] = [
  "分層儲存的配額沒有生效",
  "重新認證失敗後 CPU 使用率過高",
  "反向 DNS 查詢阻塞網路執行緒",
  "心跳請求的初始間隔",
  "controller sign-up retried after timing out",
  "SMJ spill",
  "client spins at 100% cpu",
  "remote storage file handle not closed",
  "hash join that fits in limited RAM",
];

export function keepsWin(row: ReplayRow, order: readonly string[]): boolean {
  const beyond = REPLAY_DEPTH + 1;
  const lexical = ranksIn(lexicalOrder(row.replay), row.expected).map((rank) => rank ?? beyond);
  const ranks = ranksIn(order, row.expected).map((rank) => rank ?? beyond);
  const gained = isMet(ranksIn(alternativeOrder(row.replay, {}), row.expected), row.within) && !isMet(ranksIn(lexicalOrder(row.replay), row.expected), row.within);
  if (gained) return isMet(ranks, row.within);
  return ranks.every((rank, index) => rank <= lexical[index]!) && ranks.some((rank, index) => rank < lexical[index]!);
}

export function ndcgAt10(row: ReplayRow, order: readonly string[]): number {
  const gain = (id: string) => (row.expected.includes(id) ? 3 : row.acceptable.includes(id) ? 1 : 0);
  const dcg = (gains: readonly number[]) => gains.slice(0, 10).reduce((total, value, index) => total + value / Math.log2(index + 2), 0);
  const ideal = dcg([...row.expected.map(() => 3), ...row.acceptable.map(() => 1)]);
  return ideal === 0 ? 0 : dcg(order.map(gain)) / ideal;
}

export function reciprocalRank(row: ReplayRow, order: readonly string[]): number {
  const found = ranksIn(order, row.expected).filter((rank): rank is number => rank !== null);
  return found.length === 0 ? 0 : 1 / Math.min(...found);
}

export interface SetSummary {
  readonly rows: number;
  /** `met/rows` of each kind the set holds. */
  readonly met: Readonly<Record<string, string>>;
  readonly worse: readonly string[];
  readonly lowered: number;
  readonly winsLost: readonly string[];
  readonly ndcg: number;
  readonly mrr: number;
}

export function summarize(rows: readonly ReplayRow[], order: (row: ReplayRow) => readonly string[]): SetSummary {
  const judged = rows.map((row) => {
    const fused = order(row);
    const lexical = ranksIn(lexicalOrder(row.replay), row.expected);
    const ranks = ranksIn(fused, row.expected);
    return { row, fused, lexical, ranks };
  });
  const met: Record<string, string> = {};
  for (const kind of KINDS) {
    const of = judged.filter((item) => item.row.kind === kind);
    if (of.length > 0) met[kind] = `${of.filter((item) => isMet(item.ranks, item.row.within)).length}/${of.length}`;
  }
  const mean = (values: readonly number[]) => (values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length);
  return {
    rows: rows.length,
    met,
    worse: judged.filter((item) => isWorseThanLexical(item.lexical, item.ranks, item.row.within)).map((item) => item.row.query),
    lowered: judged.reduce((total, item) => total + loweredThreads(item.lexical, item.ranks), 0),
    winsLost: judged.filter((item) => WINS.includes(item.row.query) && !keepsWin(item.row, item.fused)).map((item) => item.row.query),
    ndcg: mean(judged.map((item) => ndcgAt10(item.row, item.fused))),
    mrr: mean(judged.map((item) => reciprocalRank(item.row, item.fused))),
  };
}

/** The alternatives of the spec's ablation, in the order of its table. `lexical` is `semantic=off`. */
export const ABLATION: readonly (readonly [string, Alternative | "lexical"])[] = [
  ["lexical only (semantic=off)", "lexical"],
  ["rrf-group@1 (k 60)", {}],
  ["1 weighted: semantic x 0.5", { semanticWeight: 0.5 }],
  ["1 weighted: semantic x 0.25", { semanticWeight: 0.25 }],
  ["k 10 for both rankings", { k: 10 }],
  ["2 lexical first, semantic appended", { append: true }],
  ["2 first 3 lexical threads kept", { keep: 3 }],
  ["5 first 20 semantic threads only", { depth: 20 }],
  ["5 first 10 semantic threads only", { depth: 10 }],
  ["4 every full match first", { keep: "all" }],
  ["4 leading full matches kept = rrf-group@2", { keep: "leading" }],
  ["rrf-group@2 with k 10", { keep: "leading", k: 10 }],
  ["rrf-group@2 with semantic x 0.75", { keep: "leading", semanticWeight: 0.75 }],
];

const SETS: readonly RowSet[] = ["tuning", "held-out", "new"];

export function renderAblation(rows: readonly ReplayRow[], captured: string): string {
  const lines = [
    `Replayed over the capture of ${captured} (apps/web/test/fixtures/hybrid-replay*.json). met: rows whose expected threads all rank within the bound,`,
    "by kind (rc real-corpus, ow owner, gd guard, zh chinese, vg vocabulary-gap, lr lexical-right, gp gap). worse: rows with an expected thread that",
    "lexical-only ranks within the bound and this does not. lowered: expected threads ranked below their lexical-only rank. lost: wins of @1 not kept.",
    "Candidate 3 (a similarity threshold) is not in the table: the response did not serve the similarity when this was captured.",
  ];
  for (const set of SETS) {
    const of = rows.filter((row) => row.set === set);
    lines.push("", `${set} (${of.length} rows)`, `${"variant".padEnd(44)}${"met".padEnd(42)}worse  lowered  lost  nDCG@10  MRR`);
    for (const [name, alternative] of ABLATION) {
      const summary = summarize(of, (row) => (alternative === "lexical" ? lexicalOrder(row.replay) : alternativeOrder(row.replay, alternative)));
      const met = Object.entries(summary.met).map(([kind, value]) => `${SHORT[kind]} ${value}`).join(" ");
      lines.push(`${name.padEnd(44)}${met.padEnd(42)}${String(summary.worse.length).padEnd(7)}${String(summary.lowered).padEnd(9)}${String(summary.winsLost.length).padEnd(6)}${summary.ndcg.toFixed(4).padEnd(9)}${summary.mrr.toFixed(4)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const SHORT: Readonly<Record<string, string>> = { "real-corpus": "rc", owner: "ow", guard: "gd", chinese: "zh", "vocabulary-gap": "vg", "lexical-right": "lr", gap: "gp" };

const cell = (ranks: readonly (number | null)[]) => ranks.map((rank) => rank ?? `>${REPLAY_DEPTH}`).join(", ") || "—";

/** Each labelled row's ranks: lexical-only, `rrf-group@1`, `rrf-group@2`. */
export function renderRows(rows: readonly ReplayRow[]): string {
  return [
    "| set | kind | query | within | lexical only | rrf-group@1 | rrf-group@2 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.set} | ${row.kind} | ${row.query.replaceAll("|", "\\|")} | ${row.within} | ${cell(ranksIn(lexicalOrder(row.replay), row.expected))} | ${
      cell(ranksIn(fuseReplay(row.replay, row.projects, defaultFusionConfig), row.expected))} | ${cell(ranksIn(fuseReplay(row.replay, row.projects, leadingFullMatchFusionConfig), row.expected))} |`),
  ].join("\n");
}

if (import.meta.main) {
  const rows = await replayRows();
  const captured = (await Bun.file(REPLAY_FIXTURE).json() as ReplayFixture).release;
  const table = renderAblation(rows, captured);
  if (process.argv.includes("--write")) await Bun.write(ABLATION_REPORT, table);
  console.log(table);
  if (process.argv.includes("--rows")) console.log(renderRows(rows));
  if (process.argv.includes("--time")) {
    const inputs = rows.filter((row) => row.replay.semantic === "ok").map((row) => ({ ...fusionInput(row.replay, row.projects), queryWords: row.replay.words }));
    const rounds = 200;
    // Twice each, interleaved: the first pass warms the code up.
    for (const config of [defaultFusionConfig, leadingFullMatchFusionConfig, defaultFusionConfig, leadingFullMatchFusionConfig]) {
      const started = performance.now();
      for (let round = 0; round < rounds; round += 1) for (const input of inputs) fuseRankings({ ...input, config });
      console.log(`${config.revision}: ${((performance.now() - started) / (rounds * inputs.length) * 1_000).toFixed(1)} µs a fusion (${inputs.length} captured queries x ${rounds})`);
    }
  }
}
