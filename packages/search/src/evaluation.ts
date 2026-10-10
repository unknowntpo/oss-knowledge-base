import { hybridSearch, type FusionConfigV1 } from "./fusion";
import type { GoldenRetrievalRequirement, GoldenSearchQueryV2, SearchGoldenFixtureV2 } from "./golden-fixture-v2";
import type { SourceRecordChunkV1 } from "./golden-fixture";
import { buildLexicalIndex, searchLexicalIndex, type LexicalSearchConfigV1 } from "./lexical-search";
import { mean, ndcgAtK, recallAtK, reciprocalRankAtK } from "./metrics";
import type { SemanticRetriever } from "./semantic";

export const GOLDEN_EVALUATION_SCHEMA = "osskb.search-golden-evaluation.v1" as const;
/** Results evaluated per query: Recall@20 and MRR read all of them, nDCG the first 10. */
export const EVALUATION_DEPTH = 20;

export interface EvaluatedGroupV1 {
  readonly groupRootRecordId: string;
  readonly evidenceRecordIds: readonly string[];
}

/** One retriever configuration under evaluation. */
export interface EvaluationConfigurationV1 {
  readonly id: string;
  /** False for lexical-only search: its failures on `semantic` queries are expected. */
  readonly semantic: boolean;
  readonly search: (query: GoldenSearchQueryV2, depth: number) => Promise<readonly EvaluatedGroupV1[]>;
}

/** `semantic-required`: a `semantic` query failed on a configuration without semantic retrieval. */
export type GoldenQueryStatus = "pass" | "fail" | "semantic-required";

export interface QueryEvaluationV1 {
  readonly queryId: string;
  readonly requires: GoldenRetrievalRequirement;
  readonly status: GoldenQueryStatus;
  readonly recallAt20: number;
  readonly mrr: number;
  readonly ndcgAt10: number;
  /** Only for `ordered` queries: the grade 2 groups rank in their listed order. Not part of `status`. */
  readonly orderCorrect?: boolean;
  readonly failures: readonly string[];
  /** The first five groups returned. */
  readonly top: readonly string[];
}

export interface EvaluationAggregateV1 {
  readonly queries: number;
  readonly pass: number;
  readonly semanticRequired: number;
  readonly fail: number;
  readonly recallAt20: number;
  readonly mrr: number;
  readonly ndcgAt10: number;
}

export interface ConfigurationEvaluationV1 {
  readonly id: string;
  readonly all: EvaluationAggregateV1;
  /** The queries that lexical retrieval alone must answer. */
  readonly lexicalQueries: EvaluationAggregateV1;
  /** The queries that need semantic retrieval. */
  readonly semanticQueries: EvaluationAggregateV1;
  readonly queries: readonly QueryEvaluationV1[];
}

export interface GoldenEvaluationReportV1 {
  readonly schema: typeof GOLDEN_EVALUATION_SCHEMA;
  readonly fixtureRevision: string;
  readonly depth: number;
  readonly configurations: readonly ConfigurationEvaluationV1[];
}

export async function evaluateGoldenFixture(
  fixture: SearchGoldenFixtureV2,
  configurations: readonly EvaluationConfigurationV1[],
): Promise<GoldenEvaluationReportV1> {
  const evaluated: ConfigurationEvaluationV1[] = [];
  for (const configuration of configurations) {
    const queries: QueryEvaluationV1[] = [];
    for (const query of fixture.queries) {
      queries.push(evaluateQuery(query, configuration.semantic, await configuration.search(query, EVALUATION_DEPTH)));
    }
    evaluated.push({
      id: configuration.id,
      all: aggregate(queries),
      lexicalQueries: aggregate(queries.filter((query) => query.requires === "lexical")),
      semanticQueries: aggregate(queries.filter((query) => query.requires === "semantic")),
      queries,
    });
  }
  return {
    schema: GOLDEN_EVALUATION_SCHEMA,
    fixtureRevision: fixture.revision,
    depth: EVALUATION_DEPTH,
    configurations: evaluated,
  };
}

/** Grades one ranking against one golden query. */
export function evaluateQuery(
  query: GoldenSearchQueryV2,
  semantic: boolean,
  results: readonly EvaluatedGroupV1[],
): QueryEvaluationV1 {
  const ranked = results.slice(0, EVALUATION_DEPTH).map((result) => result.groupRootRecordId);
  const grades = new Map(query.judgments.map((judgment) => [judgment.groupRootRecordId, judgment.grade] as const));
  const expected = query.judgments.filter((judgment) => judgment.grade === 2).map((judgment) => judgment.groupRootRecordId);
  const failures: string[] = [];
  const required = ranked.slice(0, query.requiredWithin);
  for (const groupRootRecordId of expected) {
    if (!required.includes(groupRootRecordId)) failures.push(`${groupRootRecordId} is not in the top ${query.requiredWithin}`);
  }
  for (const groupRootRecordId of query.negativeGroupRootRecordIds) {
    const rank = ranked.indexOf(groupRootRecordId) + 1;
    if (rank > 0 && rank <= query.negativeWithin) failures.push(`negative ${groupRootRecordId} ranks ${rank}`);
  }
  const evidence = new Set(results.slice(0, query.requiredWithin).flatMap((result) => result.evidenceRecordIds));
  for (const recordId of query.requiredEvidenceRecordIds) {
    if (!evidence.has(recordId)) failures.push(`evidence ${recordId} is not shown`);
  }
  const positions = expected.map((groupRootRecordId) => ranked.indexOf(groupRootRecordId));
  const orderCorrect = positions.every((position, index) =>
    position >= 0 && (index === 0 || position > positions[index - 1]!));
  return {
    queryId: query.id,
    requires: query.requires,
    status: failures.length === 0 ? "pass" : query.requires === "semantic" && !semantic ? "semantic-required" : "fail",
    recallAt20: round(recallAtK(ranked, grades, EVALUATION_DEPTH)),
    mrr: round(reciprocalRankAtK(ranked, grades, EVALUATION_DEPTH)),
    ndcgAt10: round(ndcgAtK(ranked, grades, 10)),
    ...(query.ordered ? { orderCorrect } : {}),
    failures,
    top: ranked.slice(0, 5),
  };
}

function aggregate(queries: readonly QueryEvaluationV1[]): EvaluationAggregateV1 {
  const count = (status: GoldenQueryStatus) => queries.filter((query) => query.status === status).length;
  return {
    queries: queries.length,
    pass: count("pass"),
    semanticRequired: count("semantic-required"),
    fail: count("fail"),
    recallAt20: round(mean(queries.map((query) => query.recallAt20))),
    mrr: round(mean(queries.map((query) => query.mrr))),
    ndcgAt10: round(mean(queries.map((query) => query.ndcgAt10))),
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** A compact, deterministic text table of a report: aggregates, then every query that did not pass. */
export function formatEvaluationTable(report: GoldenEvaluationReportV1): string {
  const number = (value: number) => value.toFixed(4);
  const rows: string[][] = [["configuration", "queries", "n", "pass", "semantic-required", "fail", "Recall@20", "MRR", "nDCG@10"]];
  for (const configuration of report.configurations) {
    for (const [label, values] of [
      ["all", configuration.all],
      ["lexical", configuration.lexicalQueries],
      ["semantic", configuration.semanticQueries],
    ] as const) {
      rows.push([
        configuration.id, label, String(values.queries), String(values.pass), String(values.semanticRequired),
        String(values.fail), number(values.recallAt20), number(values.mrr), number(values.ndcgAt10),
      ]);
    }
  }
  const notPassing: string[][] = [["configuration", "query", "status", "Recall@20", "MRR", "nDCG@10", "why"]];
  for (const configuration of report.configurations) {
    for (const query of configuration.queries) {
      const orderNote = query.orderCorrect === false ? ["expected order not met"] : [];
      if (query.status === "pass" && orderNote.length === 0) continue;
      notPassing.push([
        configuration.id, query.queryId, query.status, number(query.recallAt20), number(query.mrr),
        number(query.ndcgAt10), [...query.failures, ...orderNote].join("; "),
      ]);
    }
  }
  return [
    `Golden evaluation ${report.fixtureRevision} (depth ${report.depth})`,
    "",
    table(rows),
    "",
    notPassing.length === 1 ? "Every query passed in every configuration." : table(notPassing),
  ].join("\n") + "\n";
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => [...row[column]!].length)));
  return rows
    .map((row) => row.map((cell, column) => cell + " ".repeat(widths[column]! - [...cell].length)).join("  ").trimEnd())
    .join("\n");
}

/** Lexical-only search over a set of chunks. */
export function lexicalEvaluationConfiguration(
  id: string,
  chunks: readonly SourceRecordChunkV1[],
  config: LexicalSearchConfigV1,
): EvaluationConfigurationV1 {
  const index = buildLexicalIndex({ indexRevision: id, chunks, config });
  return {
    id,
    semantic: false,
    search: async (query, depth) =>
      searchLexicalIndex(index, { ...query.request, limit: depth }).map((result) => ({
        groupRootRecordId: result.groupRootRecordId,
        evidenceRecordIds: result.matches.map((match) => match.recordId),
      })),
  };
}

/** Lexical search fused with a semantic retriever (`hybridSearch`). */
export function hybridEvaluationConfiguration(
  id: string,
  chunks: readonly SourceRecordChunkV1[],
  config: LexicalSearchConfigV1,
  semantic: SemanticRetriever,
  fusion?: FusionConfigV1,
): EvaluationConfigurationV1 {
  const index = buildLexicalIndex({ indexRevision: id, chunks, config });
  return {
    id,
    semantic: true,
    search: async (query, depth) => {
      const { results } = await hybridSearch({
        query: query.request.query,
        ...(query.request.filters === undefined ? {} : { filters: query.request.filters }),
        lexical: searchLexicalIndex(index, { ...query.request, limit: 50 }),
        semantic,
        limit: depth,
        ...(fusion === undefined ? {} : { config: fusion }),
      });
      return results.map((result) => ({
        groupRootRecordId: result.groupRootRecordId,
        evidenceRecordIds: [
          ...(result.lexical?.matches.map((match) => match.recordId) ?? []),
          ...result.semanticMatches.map((match) => match.recordId),
        ],
      }));
    },
  };
}
