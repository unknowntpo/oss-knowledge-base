import { validateSearchFilters, type SearchFiltersV1 } from "./filters";

export const SEARCH_GOLDEN_FIXTURE_SCHEMA =
  "osskb.search-golden-fixture.v1" as const;
export const SOURCE_RECORD_CHUNK_SCHEMA =
  "osskb.source-record-chunk.v1" as const;

export const GOLDEN_QUERY_CATEGORIES = [
  "exact-identifier",
  "code-symbol",
  "source-body",
  "project-filter",
  "cross-source-question",
  "hard-negative",
  "vocabulary-gap",
] as const;

export type GoldenQueryCategory = (typeof GOLDEN_QUERY_CATEGORIES)[number];
export type GoldenSearchPhase = 1 | 2;

export interface SourceRecordChunkV1 {
  readonly schema: typeof SOURCE_RECORD_CHUNK_SCHEMA;
  readonly id: string;
  readonly projectId: string;
  readonly sourceInstanceId: string;
  readonly recordId: string;
  readonly groupRootRecordId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly text: string;
  readonly canonicalUrl: string;
  readonly author: string;
  readonly occurredAt: string;
  readonly sourceVersion: string;
  readonly tags: readonly string[];
  readonly contentHash: string;
}

/** Golden fixtures use the same index contract as production lexical builds. */
export type GoldenSourceRecordChunkV1 = SourceRecordChunkV1;

export type GoldenSearchFiltersV1 = SearchFiltersV1;

export interface GoldenSearchExpectationV1 {
  /** Accepted group roots that must occur within `topK`. */
  readonly requiredGroupRootRecordIds: readonly string[];
  /** Related group roots that are allowed but do not make a query pass. */
  readonly acceptableGroupRootRecordIds: readonly string[];
  /** Plausible distractors that must not occur within `topK`. */
  readonly forbiddenGroupRootRecordIds: readonly string[];
  /** Source records that must be exposed as visible matching evidence. */
  readonly requiredEvidenceRecordIds: readonly string[];
  readonly topK: number;
}

export interface GoldenSearchQueryV1 {
  readonly id: string;
  readonly minimumPhase: GoldenSearchPhase;
  readonly category: GoldenQueryCategory;
  readonly request: {
    readonly query: string;
    readonly filters?: SearchFiltersV1;
  };
  readonly expectation: GoldenSearchExpectationV1;
}

export interface SearchGoldenFixtureV1 {
  readonly schema: typeof SEARCH_GOLDEN_FIXTURE_SCHEMA;
  readonly revision: string;
  readonly indexRevision: string;
  readonly chunks: readonly GoldenSourceRecordChunkV1[];
  readonly queries: readonly GoldenSearchQueryV1[];
}

export function parseSearchGoldenFixture(value: unknown): SearchGoldenFixtureV1 {
  const fixture = asObject(value, "fixture");
  const schema = asString(fixture.schema, "fixture.schema");
  if (schema !== SEARCH_GOLDEN_FIXTURE_SCHEMA) {
    fail("fixture.schema", `expected ${SEARCH_GOLDEN_FIXTURE_SCHEMA}`);
  }

  const chunks = asArray(fixture.chunks, "fixture.chunks").map((chunk, index) =>
    parseGoldenChunk(chunk, `fixture.chunks[${index}]`),
  );
  const queries = asArray(fixture.queries, "fixture.queries").map((query, index) =>
    parseQuery(query, `fixture.queries[${index}]`),
  );

  requireUnique(chunks.map((chunk) => chunk.id), "chunk id");
  requireUnique(
    chunks.map((chunk) => chunk.recordId),
    "record id",
  );
  requireUnique(queries.map((query) => query.id), "query id");

  const recordIds = new Set(chunks.map((chunk) => chunk.recordId));
  const groupRootByRecordId = new Map(
    chunks.map((chunk) => [chunk.recordId, chunk.groupRootRecordId] as const),
  );
  const projectIds = new Set(chunks.map((chunk) => chunk.projectId));
  const sourceInstanceIds = new Set(chunks.map((chunk) => chunk.sourceInstanceId));
  for (const chunk of chunks) {
    requireRecord(recordIds, chunk.groupRootRecordId, `${chunk.id}.groupRootRecordId`);
  }

  for (const query of queries) {
    validateExpectation(query, recordIds, groupRootByRecordId);
    validateFilters(query, projectIds, sourceInstanceIds);
  }

  return {
    schema: SEARCH_GOLDEN_FIXTURE_SCHEMA,
    revision: asNonEmptyString(fixture.revision, "fixture.revision"),
    indexRevision: asNonEmptyString(
      fixture.indexRevision,
      "fixture.indexRevision",
    ),
    chunks,
    queries,
  };
}

/** Shared with the v2 fixture, which indexes the same chunk contract. */
export function parseGoldenChunk(value: unknown, path: string): GoldenSourceRecordChunkV1 {
  const chunk = asObject(value, path);
  const schema = asString(chunk.schema, `${path}.schema`);
  if (schema !== SOURCE_RECORD_CHUNK_SCHEMA) {
    fail(`${path}.schema`, `expected ${SOURCE_RECORD_CHUNK_SCHEMA}`);
  }

  const canonicalUrl = asNonEmptyString(chunk.canonicalUrl, `${path}.canonicalUrl`);
  if (!canonicalUrl.startsWith("https://")) {
    fail(`${path}.canonicalUrl`, "must use https");
  }

  const occurredAt = asNonEmptyString(chunk.occurredAt, `${path}.occurredAt`);
  if (Number.isNaN(Date.parse(occurredAt))) {
    fail(`${path}.occurredAt`, "must be an ISO-compatible timestamp");
  }

  const ordinal = asNumber(chunk.ordinal, `${path}.ordinal`);
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    fail(`${path}.ordinal`, "must be a non-negative integer");
  }

  const contentHash = asNonEmptyString(chunk.contentHash, `${path}.contentHash`);
  if (!/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
    fail(`${path}.contentHash`, "must be a sha256-prefixed lowercase digest");
  }

  return {
    schema: SOURCE_RECORD_CHUNK_SCHEMA,
    id: asNonEmptyString(chunk.id, `${path}.id`),
    projectId: asNonEmptyString(chunk.projectId, `${path}.projectId`),
    sourceInstanceId: asNonEmptyString(
      chunk.sourceInstanceId,
      `${path}.sourceInstanceId`,
    ),
    recordId: asNonEmptyString(chunk.recordId, `${path}.recordId`),
    groupRootRecordId: asNonEmptyString(
      chunk.groupRootRecordId,
      `${path}.groupRootRecordId`,
    ),
    ordinal,
    title: asNonEmptyString(chunk.title, `${path}.title`),
    text: asNonEmptyString(chunk.text, `${path}.text`),
    canonicalUrl,
    author: asNonEmptyString(chunk.author, `${path}.author`),
    occurredAt,
    sourceVersion: asNonEmptyString(chunk.sourceVersion, `${path}.sourceVersion`),
    tags: asStringArray(chunk.tags, `${path}.tags`),
    contentHash,
  };
}

function parseQuery(value: unknown, path: string): GoldenSearchQueryV1 {
  const query = asObject(value, path);
  const category = asString(query.category, `${path}.category`);
  if (!(GOLDEN_QUERY_CATEGORIES as readonly string[]).includes(category)) {
    fail(`${path}.category`, `unknown category ${category}`);
  }

  const minimumPhase = asNumber(query.minimumPhase, `${path}.minimumPhase`);
  if (minimumPhase !== 1 && minimumPhase !== 2) {
    fail(`${path}.minimumPhase`, "must be 1 or 2");
  }

  const request = asObject(query.request, `${path}.request`);
  const filters =
    request.filters === undefined
      ? undefined
      : parseGoldenFilters(request.filters, `${path}.request.filters`);
  const expectation = parseExpectation(query.expectation, `${path}.expectation`);

  return {
    id: asNonEmptyString(query.id, `${path}.id`),
    minimumPhase,
    category: category as GoldenQueryCategory,
    request: {
      query: asNonEmptyString(request.query, `${path}.request.query`),
      ...(filters === undefined ? {} : { filters }),
    },
    expectation,
  };
}

/** Shared with the v2 fixture. */
export function parseGoldenFilters(value: unknown, path: string): SearchFiltersV1 {
  const filters = asObject(value, path);
  const projectIds = optionalStringArray(filters.projectIds, `${path}.projectIds`);
  const sourceInstanceIds = optionalStringArray(
    filters.sourceInstanceIds,
    `${path}.sourceInstanceIds`,
  );
  const tags = optionalStringArray(filters.tags, `${path}.tags`);
  const projectStatuses = optionalStringArray(
    filters.projectStatuses,
    `${path}.projectStatuses`,
  );
  const occurredAfter = optionalString(filters.occurredAfter, `${path}.occurredAfter`);
  const occurredBefore = optionalString(filters.occurredBefore, `${path}.occurredBefore`);

  const parsed = {
    ...(projectIds === undefined ? {} : { projectIds }),
    ...(sourceInstanceIds === undefined ? {} : { sourceInstanceIds }),
    ...(projectStatuses === undefined ? {} : { projectStatuses }),
    ...(tags === undefined ? {} : { tags }),
    ...(occurredAfter === undefined ? {} : { occurredAfter }),
    ...(occurredBefore === undefined ? {} : { occurredBefore }),
  };
  try {
    validateSearchFilters(parsed);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : "invalid filters");
  }
  return parsed;
}

function parseExpectation(
  value: unknown,
  path: string,
): GoldenSearchExpectationV1 {
  const expectation = asObject(value, path);
  const topK = asNumber(expectation.topK, `${path}.topK`);
  if (!Number.isInteger(topK) || topK <= 0) {
    fail(`${path}.topK`, "must be a positive integer");
  }

  return {
    requiredGroupRootRecordIds: asStringArray(
      expectation.requiredGroupRootRecordIds,
      `${path}.requiredGroupRootRecordIds`,
    ),
    acceptableGroupRootRecordIds: asStringArray(
      expectation.acceptableGroupRootRecordIds,
      `${path}.acceptableGroupRootRecordIds`,
    ),
    forbiddenGroupRootRecordIds: asStringArray(
      expectation.forbiddenGroupRootRecordIds,
      `${path}.forbiddenGroupRootRecordIds`,
    ),
    requiredEvidenceRecordIds: asStringArray(
      expectation.requiredEvidenceRecordIds,
      `${path}.requiredEvidenceRecordIds`,
    ),
    topK,
  };
}

function validateExpectation(
  query: GoldenSearchQueryV1,
  recordIds: ReadonlySet<string>,
  groupRootByRecordId: ReadonlyMap<string, string>,
): void {
  const { expectation } = query;
  const gradedLists = [
    expectation.requiredGroupRootRecordIds,
    expectation.acceptableGroupRootRecordIds,
    expectation.forbiddenGroupRootRecordIds,
  ];
  const allGraded = gradedLists.flat();
  requireUnique(allGraded, `${query.id} graded group root`);

  for (const recordId of [
    ...allGraded,
    ...expectation.requiredEvidenceRecordIds,
  ]) {
    requireRecord(recordIds, recordId, `${query.id} expectation`);
  }

  for (const groupRootRecordId of allGraded) {
    if (groupRootByRecordId.get(groupRootRecordId) !== groupRootRecordId) {
      fail(
        `${query.id}.expectation`,
        `${groupRootRecordId} is not a group root record`,
      );
    }
  }

  const requiredGroups = new Set(expectation.requiredGroupRootRecordIds);
  for (const evidenceRecordId of expectation.requiredEvidenceRecordIds) {
    const groupRootRecordId = groupRootByRecordId.get(evidenceRecordId);
    if (groupRootRecordId === undefined || !requiredGroups.has(groupRootRecordId)) {
      fail(
        `${query.id}.expectation.requiredEvidenceRecordIds`,
        `${evidenceRecordId} does not belong to a required group`,
      );
    }
  }

  if (expectation.requiredGroupRootRecordIds.length > expectation.topK) {
    fail(
      `${query.id}.expectation`,
      "cannot require more group roots than topK can contain",
    );
  }
  if (
    query.minimumPhase === 1 &&
    expectation.requiredGroupRootRecordIds.length === 0
  ) {
    fail(`${query.id}.expectation`, "Phase 1 queries require a direct answer");
  }
}

function validateFilters(
  query: GoldenSearchQueryV1,
  projectIds: ReadonlySet<string>,
  sourceInstanceIds: ReadonlySet<string>,
): void {
  for (const projectId of query.request.filters?.projectIds ?? []) {
    if (!projectIds.has(projectId)) {
      fail(`${query.id}.request.filters.projectIds`, `unknown project ${projectId}`);
    }
  }
  for (const sourceInstanceId of query.request.filters?.sourceInstanceIds ?? []) {
    if (!sourceInstanceIds.has(sourceInstanceId)) {
      fail(
        `${query.id}.request.filters.sourceInstanceIds`,
        `unknown source instance ${sourceInstanceId}`,
      );
    }
  }
}

function requireRecord(
  recordIds: ReadonlySet<string>,
  recordId: string,
  path: string,
): void {
  if (!recordIds.has(recordId)) {
    fail(path, `references missing record ${recordId}`);
  }
}

function requireUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      fail(label, `duplicate value ${value}`);
    }
    seen.add(value);
  }
}

function optionalStringArray(value: unknown, path: string): readonly string[] | undefined {
  return value === undefined ? undefined : asStringArray(value, path);
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : asNonEmptyString(value, path);
}

function asStringArray(value: unknown, path: string): readonly string[] {
  return asArray(value, path).map((item, index) =>
    asNonEmptyString(item, `${path}[${index}]`),
  );
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(path, "must be an array");
  }
  return value;
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, path: string): string {
  const result = asString(value, path).trim();
  if (result.length === 0) {
    fail(path, "must not be empty");
  }
  return result;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail(path, "must be a string");
  }
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number") {
    fail(path, "must be a number");
  }
  return value;
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid search golden fixture at ${path}: ${message}`);
}
