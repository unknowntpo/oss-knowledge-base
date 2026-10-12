/**
 * Spec 016 slice 4 preparation (H31, H33, H71): asks a deployed `/api/search` each labelled
 * query twice, `semantic=off` and hybrid, and reports the ranks of the expected threads, the
 * semantic status, and the latency. Not run in CI and not a gate. Only public GETs, one at a
 * time, `--delay` ms apart (default 1,000); it sends no credential.
 *
 *   bun run measure:search-hybrid [--base https://oss-knowledge-base-dev.pages.dev] [--out report.json]
 *
 * On a deployment where hybrid search is off, the response has no `retrieval.semantic`: the
 * script then reports the lexical ranks alone (the baseline) and says so.
 */
import type { SearchResponseV1 } from "@oss-knowledge-base/serving-contract";

import { testPlanRows as guardRows } from "../../../packages/search/test/real-corpus-guards.cases";
import { testPlanRows as realCorpusRows } from "../../../packages/search/test/real-corpus.cases";
import { testPlanRows as hybridRows } from "../test/search-hybrid-eval.cases";

export interface EvalQuery {
  readonly kind: string;
  readonly labels: string;
  readonly query: string;
  readonly expected: readonly string[];
  readonly acceptable: readonly string[];
  readonly within: number;
}

const ids = (cell: string | null) => (cell === null || cell === "" ? [] : cell.split(" "));

/** The Spec 017 rows, its guard rows, and this spec's Chinese and vocabulary-gap rows, each query once. */
export function evalQueries(): readonly EvalQuery[] {
  const queries: EvalQuery[] = [
    ...realCorpusRows.map((row) => ({ kind: "real-corpus", labels: row.labels, query: row.query, expected: ids(row.expected), acceptable: ids(row.acceptable), within: row.within })),
    ...guardRows.map((row) => ({ kind: "guard", labels: "implementer", query: row.query, expected: ids(row.expected), acceptable: [], within: row.within })),
    ...hybridRows.map((row) => ({ kind: row.kind, labels: row.labels, query: row.query, expected: ids(row.expected), acceptable: ids(row.acceptable), within: row.within })),
  ];
  const seen = new Set<string>();
  return queries.filter((query) => !seen.has(query.query) && seen.add(query.query) !== undefined);
}

/** The API returns at most 50 threads. */
export const DEPTH = 50;
/** Decision 5: a correct answer "in the top 20". */
export const RERANK_DEPTH = 20;

/** 1-based ranks of `threads` in a response, `null` beyond its depth. */
export function ranksOf(response: SearchResponseV1, threads: readonly string[]): readonly (number | null)[] {
  const order = response.results.map((result) => result.entry.sourceTitleRecordId);
  return threads.map((thread) => {
    const position = order.indexOf(thread);
    return position < 0 ? null : position + 1;
  });
}

export interface QueryReport {
  readonly kind: string;
  readonly labels: string;
  readonly query: string;
  readonly within: number;
  readonly expected: readonly string[];
  readonly lexicalRanks: readonly (number | null)[];
  /** `null` when the deployment answered without `retrieval.semantic` (hybrid search is off). */
  readonly hybridRanks: readonly (number | null)[] | null;
  readonly semantic: SearchResponseV1["retrieval"]["semantic"] | null;
  readonly lexicalMet: boolean;
  readonly hybridMet: boolean | null;
  /** Expected threads all within the top 20, and at least one outside `within`: what a reranker could fix. */
  readonly rerankCandidate: boolean | null;
  readonly semanticOnlyResults: number | null;
  readonly lexicalMs: number;
  readonly hybridMs: number | null;
  /** The same hybrid query asked again: its embedding and matches are cached. */
  readonly cachedMs: number | null;
}

const met = (ranks: readonly (number | null)[], within: number) => ranks.every((rank) => rank !== null && rank <= within);

export function reportQuery(
  query: EvalQuery,
  lexical: { readonly response: SearchResponseV1; readonly ms: number },
  hybrid?: { readonly response: SearchResponseV1; readonly ms: number; readonly cachedMs?: number },
): QueryReport {
  const lexicalRanks = ranksOf(lexical.response, query.expected);
  const on = hybrid !== undefined && hybrid.response.retrieval.semantic !== undefined;
  const hybridRanks = on ? ranksOf(hybrid.response, query.expected) : null;
  return {
    kind: query.kind,
    labels: query.labels,
    query: query.query,
    within: query.within,
    expected: query.expected,
    lexicalRanks,
    hybridRanks,
    semantic: on ? hybrid.response.retrieval.semantic! : null,
    lexicalMet: met(lexicalRanks, query.within),
    hybridMet: hybridRanks === null ? null : met(hybridRanks, query.within),
    rerankCandidate: hybridRanks === null ? null : met(hybridRanks, RERANK_DEPTH) && !met(hybridRanks, query.within),
    semanticOnlyResults: on ? hybrid.response.results.filter((result) => result.matches.every((match) => match.signals.lexicalRank === undefined)).length : null,
    lexicalMs: Math.round(lexical.ms),
    hybridMs: on ? Math.round(hybrid.ms) : null,
    cachedMs: on && hybrid.cachedMs !== undefined ? Math.round(hybrid.cachedMs) : null,
  };
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)]!;
};

/**
 * The share of queries a reranker could help, above which Spec 016 Decision 5 says to consider
 * one (implementer's proposal, owner to confirm): the answers are retrieved but ranked low.
 */
export const RERANK_SHARE = 0.3;

export interface Summary {
  readonly queries: number;
  readonly hybrid: boolean;
  readonly statuses: Readonly<Record<string, number>>;
  readonly lexicalMet: number;
  readonly hybridMet: number | null;
  /** Queries met lexically and not under hybrid search: a regression to look at before anything else. */
  readonly regressions: readonly string[];
  readonly rerankCandidates: readonly string[];
  readonly rerank: "not measured" | "consider rerank" | "no case for rerank";
  /** Expected threads missing from the hybrid top 20: retrieval, not ranking, is the limit. */
  readonly notRetrieved: readonly string[];
  readonly medianLexicalMs: number | null;
  readonly medianHybridMs: number | null;
  readonly medianCachedMs: number | null;
  /** Median over queries of hybrid latency minus lexical latency (H31). */
  readonly medianAddedMs: number | null;
}

export function summarize(reports: readonly QueryReport[]): Summary {
  const measured = reports.filter((report) => report.hybridRanks !== null);
  const fused = measured.filter((report) => report.semantic?.status === "ok");
  const statuses: Record<string, number> = {};
  for (const report of measured) statuses[report.semantic!.status] = (statuses[report.semantic!.status] ?? 0) + 1;
  const rerankCandidates = fused.filter((report) => report.rerankCandidate).map((report) => report.query);
  return {
    queries: reports.length,
    hybrid: measured.length > 0,
    statuses,
    lexicalMet: reports.filter((report) => report.lexicalMet).length,
    hybridMet: measured.length === 0 ? null : measured.filter((report) => report.hybridMet).length,
    regressions: measured.filter((report) => report.lexicalMet && report.hybridMet === false).map((report) => report.query),
    rerankCandidates,
    rerank: fused.length === 0 ? "not measured" : rerankCandidates.length / fused.length >= RERANK_SHARE ? "consider rerank" : "no case for rerank",
    notRetrieved: fused.filter((report) => !met(report.hybridRanks!, RERANK_DEPTH)).map((report) => report.query),
    medianLexicalMs: median(reports.map((report) => report.lexicalMs)),
    medianHybridMs: median(fused.map((report) => report.hybridMs!)),
    medianCachedMs: median(fused.filter((report) => report.cachedMs !== null).map((report) => report.cachedMs!)),
    medianAddedMs: median(fused.map((report) => report.hybridMs! - report.lexicalMs)),
  };
}

const cell = (ranks: readonly (number | null)[] | null) => (ranks === null ? "—" : ranks.map((rank) => rank ?? `>${DEPTH}`).join(", "));

export function renderTable(reports: readonly QueryReport[]): string {
  return [
    "| kind | query | within | lexical ranks | hybrid ranks | semantic | lexical ms | hybrid ms | cached ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...reports.map((report) => `| ${report.kind} | ${report.query.replaceAll("|", "\\|")} | ${report.within} | ${cell(report.lexicalRanks)} | ${cell(report.hybridRanks)} | ${
      report.semantic === null ? "—" : `${report.semantic.status}${report.semantic.cached === true ? " (cached)" : ""}`} | ${report.lexicalMs} | ${report.hybridMs ?? "—"} | ${report.cachedMs ?? "—"} |`),
  ].join("\n");
}

if (import.meta.main) {
  const option = (name: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const base = option("--base") ?? "https://oss-knowledge-base-dev.pages.dev";
  const delay = Number(option("--delay") ?? 1_000);
  const pause = () => new Promise((resolve) => setTimeout(resolve, delay));
  const ask = async (query: string, lexicalOnly: boolean) => {
    const url = new URL("/api/search", base);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(DEPTH));
    if (lexicalOnly) url.searchParams.set("semantic", "off");
    const started = performance.now();
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const body = await response.json() as SearchResponseV1;
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return { response: body, ms: performance.now() - started };
  };

  const reports: QueryReport[] = [];
  let hybridOn: boolean | undefined;
  let release = "";
  for (const query of evalQueries()) {
    const lexical = await ask(query.query, true);
    release = lexical.response.retrieval.indexRevision;
    await pause();
    if (hybridOn === false) {
      reports.push(reportQuery(query, lexical));
      continue;
    }
    const hybrid = await ask(query.query, false);
    await pause();
    hybridOn ??= hybrid.response.retrieval.semantic !== undefined;
    if (!hybridOn) {
      reports.push(reportQuery(query, lexical));
      continue;
    }
    const cached = await ask(query.query, false);
    await pause();
    reports.push(reportQuery(query, lexical, { ...hybrid, cachedMs: cached.ms }));
  }
  const summary = summarize(reports);
  console.log(`${base} release ${release} at ${new Date().toISOString()}`);
  if (!summary.hybrid) console.log("Hybrid search is off on this deployment: lexical ranks only.");
  console.log(renderTable(reports));
  console.log(JSON.stringify(summary, null, 2));
  const out = option("--out");
  if (out !== undefined) await Bun.write(out, `${JSON.stringify({ base, release, measuredAt: new Date().toISOString(), summary, reports }, null, 2)}\n`);
}
