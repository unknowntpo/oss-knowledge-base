import type { SearchFiltersV1 } from "./filters";
import { parseGoldenChunk, parseGoldenFilters, type SourceRecordChunkV1 } from "./golden-fixture";
import { compileIdentifierProfiles, type IdentifierPatternV1, type IdentifierProfilesV1 } from "./identifiers";

export const SEARCH_GOLDEN_FIXTURE_V2_SCHEMA = "osskb.search-golden-fixture.v2" as const;

/** Which retrieval a query needs: `semantic` queries are expected to fail on lexical-only search. */
export type GoldenRetrievalRequirement = "lexical" | "semantic";

/** 2 = expected, 1 = acceptable. Unjudged groups have grade 0. */
export type GoldenGrade = 1 | 2;

export interface GoldenJudgmentV2 {
  readonly groupRootRecordId: string;
  readonly grade: GoldenGrade;
}

export interface GoldenSearchQueryV2 {
  readonly id: string;
  readonly category: string;
  readonly requires: GoldenRetrievalRequirement;
  readonly request: { readonly query: string; readonly filters?: SearchFiltersV1 };
  /** Grade 2 judgments are listed in the expected order. */
  readonly judgments: readonly GoldenJudgmentV2[];
  /** Hard negatives: none may rank within `negativeWithin`. */
  readonly negativeGroupRootRecordIds: readonly string[];
  /** Records that must be shown as evidence of a result within `requiredWithin`. */
  readonly requiredEvidenceRecordIds: readonly string[];
  /** Every grade 2 group must rank within this many results. */
  readonly requiredWithin: number;
  readonly negativeWithin: number;
  /** When true, the grade 2 groups are also expected in their listed order (reported, not gated). */
  readonly ordered: boolean;
  readonly note?: string;
}

export interface SearchGoldenFixtureV2 {
  readonly schema: typeof SEARCH_GOLDEN_FIXTURE_V2_SCHEMA;
  readonly revision: string;
  readonly indexRevision: string;
  /** Records written by hand for the fixture rather than copied from golden v1. */
  readonly syntheticRecordIds: readonly string[];
  /** Community identifier patterns the fixture is indexed and queried with. */
  readonly identifierProfiles: IdentifierProfilesV1;
  readonly chunks: readonly SourceRecordChunkV1[];
  readonly queries: readonly GoldenSearchQueryV2[];
}

export function parseSearchGoldenFixtureV2(value: unknown): SearchGoldenFixtureV2 {
  const fixture = object(value, "fixture");
  if (fixture.schema !== SEARCH_GOLDEN_FIXTURE_V2_SCHEMA) {
    fail("fixture.schema", `expected ${SEARCH_GOLDEN_FIXTURE_V2_SCHEMA}`);
  }
  const chunks = array(fixture.chunks, "fixture.chunks").map((chunk, index) =>
    parseGoldenChunk(chunk, `fixture.chunks[${index}]`));
  unique(chunks.map((chunk) => chunk.id), "chunk id");
  unique(chunks.map((chunk) => chunk.recordId), "record id");
  const rootByRecord = new Map(chunks.map((chunk) => [chunk.recordId, chunk.groupRootRecordId] as const));
  for (const chunk of chunks) {
    if (!rootByRecord.has(chunk.groupRootRecordId)) {
      fail(`${chunk.id}.groupRootRecordId`, `references missing record ${chunk.groupRootRecordId}`);
    }
  }
  const projectIds = new Set(chunks.map((chunk) => chunk.projectId));

  const provenance = object(fixture.provenance, "fixture.provenance");
  const syntheticRecordIds = strings(provenance.syntheticRecordIds, "fixture.provenance.syntheticRecordIds");
  unique(syntheticRecordIds, "synthetic record id");
  for (const recordId of syntheticRecordIds) {
    if (!rootByRecord.has(recordId)) fail("fixture.provenance.syntheticRecordIds", `references missing record ${recordId}`);
  }

  const identifierProfiles = parseIdentifierProfiles(fixture.identifierProfiles, projectIds);
  const queries = array(fixture.queries, "fixture.queries").map((query, index) =>
    parseQuery(query, `fixture.queries[${index}]`, rootByRecord, projectIds));
  unique(queries.map((query) => query.id), "query id");

  return {
    schema: SEARCH_GOLDEN_FIXTURE_V2_SCHEMA,
    revision: text(fixture.revision, "fixture.revision"),
    indexRevision: text(fixture.indexRevision, "fixture.indexRevision"),
    syntheticRecordIds,
    identifierProfiles,
    chunks,
    queries,
  };
}

function parseIdentifierProfiles(value: unknown, projectIds: ReadonlySet<string>): IdentifierProfilesV1 {
  const profiles: Record<string, readonly IdentifierPatternV1[]> = {};
  for (const [projectId, patterns] of Object.entries(object(value, "fixture.identifierProfiles"))) {
    const path = `fixture.identifierProfiles.${projectId}`;
    if (!projectIds.has(projectId)) fail(path, `unknown project ${projectId}`);
    profiles[projectId] = array(patterns, path).map((pattern, index) => {
      const item = object(pattern, `${path}[${index}]`);
      return {
        kind: text(item.kind, `${path}[${index}].kind`),
        canonicalPrefix: text(item.canonicalPrefix, `${path}[${index}].canonicalPrefix`),
        ...(item.textPattern === undefined ? {} : { textPattern: text(item.textPattern, `${path}[${index}].textPattern`) }),
        ...(item.recordIdPattern === undefined
          ? {}
          : { recordIdPattern: text(item.recordIdPattern, `${path}[${index}].recordIdPattern`) }),
      };
    });
  }
  try {
    compileIdentifierProfiles(profiles);
  } catch (error) {
    fail("fixture.identifierProfiles", error instanceof Error ? error.message : "invalid patterns");
  }
  return profiles;
}

function parseQuery(
  value: unknown,
  path: string,
  rootByRecord: ReadonlyMap<string, string>,
  projectIds: ReadonlySet<string>,
): GoldenSearchQueryV2 {
  const query = object(value, path);
  const id = text(query.id, `${path}.id`);
  const requires = query.requires;
  if (requires !== "lexical" && requires !== "semantic") fail(`${path}.requires`, "must be lexical or semantic");
  const request = object(query.request, `${path}.request`);
  const filters = request.filters === undefined ? undefined : parseGoldenFilters(request.filters, `${path}.request.filters`);
  for (const projectId of filters?.projectIds ?? []) {
    if (!projectIds.has(projectId)) fail(`${path}.request.filters.projectIds`, `unknown project ${projectId}`);
  }

  const judgments = array(query.judgments, `${path}.judgments`).map((judgment, index) => {
    const item = object(judgment, `${path}.judgments[${index}]`);
    if (item.grade !== 1 && item.grade !== 2) fail(`${path}.judgments[${index}].grade`, "must be 1 or 2");
    return {
      groupRootRecordId: text(item.groupRootRecordId, `${path}.judgments[${index}].groupRootRecordId`),
      grade: item.grade,
    } satisfies GoldenJudgmentV2;
  });
  const negatives = strings(query.negativeGroupRootRecordIds, `${path}.negativeGroupRootRecordIds`);
  const graded = [...judgments.map((judgment) => judgment.groupRootRecordId), ...negatives];
  unique(graded, `${id} graded group root`);
  for (const groupRootRecordId of graded) {
    if (rootByRecord.get(groupRootRecordId) !== groupRootRecordId) {
      fail(`${id}.judgments`, `${groupRootRecordId} is not a group root record`);
    }
  }
  const expected = new Set(judgments.filter((judgment) => judgment.grade === 2).map((judgment) => judgment.groupRootRecordId));
  if (expected.size === 0) fail(`${id}.judgments`, "needs at least one grade 2 group");
  const evidence = strings(query.requiredEvidenceRecordIds, `${path}.requiredEvidenceRecordIds`);
  for (const recordId of evidence) {
    const root = rootByRecord.get(recordId);
    if (root === undefined || !expected.has(root)) {
      fail(`${id}.requiredEvidenceRecordIds`, `${recordId} does not belong to a grade 2 group`);
    }
  }
  const requiredWithin = positiveInteger(query.requiredWithin, `${path}.requiredWithin`);
  if (expected.size > requiredWithin) fail(`${id}.requiredWithin`, "cannot hold every grade 2 group");
  if (typeof query.ordered !== "boolean") fail(`${path}.ordered`, "must be a boolean");

  return {
    id,
    category: text(query.category, `${path}.category`),
    requires,
    request: { query: text(request.query, `${path}.request.query`), ...(filters === undefined ? {} : { filters }) },
    judgments,
    negativeGroupRootRecordIds: negatives,
    requiredEvidenceRecordIds: evidence,
    requiredWithin,
    negativeWithin: positiveInteger(query.negativeWithin, `${path}.negativeWithin`),
    ordered: query.ordered,
    ...(query.note === undefined ? {} : { note: text(query.note, `${path}.note`) }),
  };
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) fail(path, "must be a positive integer");
  return value;
}

function strings(value: unknown, path: string): readonly string[] {
  return array(value, path).map((item, index) => text(item, `${path}[${index}]`));
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(path, "must be a non-empty string");
  return value;
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(label, `duplicate value ${value}`);
    seen.add(value);
  }
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid search golden fixture at ${path}: ${message}`);
}
