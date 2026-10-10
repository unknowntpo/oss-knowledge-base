import type { FeedDetail, FeedEntry } from "@oss-knowledge-base/domain";
import {
  DEFAULT_LEXICAL_REVISION,
  lexicalSearchConfigFor,
  lexicalShardPostings,
  type IdentifierProfilesV1,
  type SourceRecordChunkV1,
} from "@oss-knowledge-base/search";

import { isSha256Digest, type Sha256Digest } from "./digest";
import type { ImmutableProjectionObjectV1, SearchReleaseDescriptorV1 } from "./publication-set";
import { decodeBody, encodeProjectionObject, type EncodedProjectionObject, type ProjectionObject } from "./r2";

export const SEARCH_CURRENT_KEY = "public/search/v1/current.json";
export const SEARCH_CURRENT_SCHEMA = "osskb.search-current.v1" as const;
/** Written since Spec 013: bounded lexical shards with postings and a global terms object. */
export const SEARCH_RELEASE_SCHEMA = "osskb.search-release.v3" as const;
/** Read for rollback and older detailRefs (Spec 008). */
export const SEARCH_RELEASE_SCHEMA_V2 = "osskb.search-release.v2" as const;
export const SEARCH_RELEASE_SCHEMA_V1 = "osskb.search-release.v1" as const;
/** Shared Search detail objects, keyed by the SHA-256 of their bytes (ADR-0013). */
export const SEARCH_DETAIL_POOL = "public/search/v1/objects/details/";
/** One project's whole shard, read from search-release.v1/v2 releases. */
export const SEARCH_LEXICAL_SHARD_SCHEMA = "osskb.search-lexical-shard.v1" as const;
export const SEARCH_LEXICAL_SHARD_SCHEMA_V2 = "osskb.search-lexical-shard.v2" as const;
export const SEARCH_TERMS_SCHEMA = "osskb.search-terms.v1" as const;
/** Chunks per lexical shard; chunks are bounded by the 180-word chunking window (Spec 013). */
export const DEFAULT_MAX_SHARD_CHUNKS = 1_000;
export const SEARCH_RESPONSE_SCHEMA = "osskb.search-response.v1" as const;
const SEARCH_DETAIL_REF_SCHEMA = "osskb.search-detail-ref.v1" as const;
const SEARCH_DETAIL_REF_PREFIX = "sdr1.";

export interface SearchCurrentPointerV1 {
  readonly schema: typeof SEARCH_CURRENT_SCHEMA;
  readonly indexRevision: string;
  readonly releaseManifestKey: string;
  readonly generatedAt: string;
}

/** Release-scoped details (ADR-0010). Still read so older detailRefs and rollback work. */
export interface SearchReleaseManifestV1 {
  readonly schema: typeof SEARCH_RELEASE_SCHEMA_V1;
  readonly indexRevision: string;
  readonly corpusRevision: string;
  readonly lexicalRevision: string;
  readonly generatedAt: string;
  readonly shardKeys: Readonly<Record<string, string>>;
  readonly detailPrefix: string;
  readonly chunkCount: number;
  readonly groupCount: number;
  readonly objectDigests: Readonly<Record<string, string>>;
}

/**
 * Details live in the shared Search pool. Each shard group names its detail by
 * `detailSha256`, and `objectDigests` lists every key the release references.
 */
export interface SearchReleaseManifestV2 {
  readonly schema: typeof SEARCH_RELEASE_SCHEMA_V2;
  readonly indexRevision: string;
  readonly corpusRevision: string;
  readonly lexicalRevision: string;
  readonly generatedAt: string;
  readonly shardKeys: Readonly<Record<string, string>>;
  readonly chunkCount: number;
  readonly groupCount: number;
  readonly objectDigests: Readonly<Record<string, string>>;
}

/**
 * Bounded lexical shards (Spec 013). `shards[n]` is shard number n; `terms.json` under the
 * release prefix holds global document frequencies; N and avgdl come from the counts here.
 */
export interface SearchReleaseManifestV3 {
  readonly schema: typeof SEARCH_RELEASE_SCHEMA;
  readonly indexRevision: string;
  readonly corpusRevision: string;
  readonly lexicalRevision: string;
  readonly generatedAt: string;
  readonly shards: readonly SearchShardRefV1[];
  readonly chunkCount: number;
  readonly totalChunkLength: number;
  readonly groupCount: number;
  readonly objectDigests: Readonly<Record<string, string>>;
}

export interface SearchShardRefV1 {
  readonly projectId: string;
  readonly key: string;
}

export type SearchReleaseManifest = SearchReleaseManifestV1 | SearchReleaseManifestV2 | SearchReleaseManifestV3;

export interface SearchGroupProjectionV1 {
  readonly groupRootRecordId: string;
  readonly entry: FeedEntry;
  /** Project-local status derived from the group's root SourceRecord. */
  readonly projectStatus?: string;
  /** Digest of the group's detail in the Search pool; required by `search-release.v2`. */
  readonly detailSha256?: Sha256Digest;
}

export interface SearchLexicalShardV1 {
  readonly schema: typeof SEARCH_LEXICAL_SHARD_SCHEMA;
  readonly indexRevision: string;
  readonly projectId: string;
  readonly chunks: readonly SourceRecordChunkV1[];
  readonly groups: readonly SearchGroupProjectionV1[];
}

/** A search-release.v3 shard: whole groups of one project, with BM25 postings. */
export interface SearchLexicalShardV2 {
  readonly schema: typeof SEARCH_LEXICAL_SHARD_SCHEMA_V2;
  readonly indexRevision: string;
  readonly projectId: string;
  readonly shard: number;
  readonly chunks: readonly SourceRecordChunkV1[];
  readonly lengths: readonly number[];
  readonly postings: Readonly<Record<string, readonly number[]>>;
  readonly groups: readonly SearchGroupProjectionV1[];
}

/** term -> [document frequency over the release, shard number, …] */
export interface SearchTermsV1 {
  readonly schema: typeof SEARCH_TERMS_SCHEMA;
  readonly indexRevision: string;
  readonly terms: Readonly<Record<string, readonly number[]>>;
}

/** One Search group as the publisher consumes it, one at a time (Spec 013). */
export interface SearchGroupSource {
  readonly projectId: string;
  readonly groupRootRecordId: string;
  readonly entry: FeedEntry;
  readonly detail: FeedDetail;
  readonly chunks: readonly SourceRecordChunkV1[];
}

/** Release identity; `SearchReleaseOptions` chooses the lexical revision postings are computed for. */
export interface SearchReleaseInput {
  readonly indexRevision: string;
  readonly corpusRevision: string;
  readonly generatedAt: string;
}

export interface SearchReleaseOptions {
  readonly maxShardChunks?: number;
  /** The revision postings, lengths, and term statistics are written for; `bm25-reference@1` when absent (Spec 016). */
  readonly lexicalRevision?: string;
  /** Community identifier patterns by project; indexed from `bm25-reference@2`, ignored at `@1`. */
  readonly identifiers?: IdentifierProfilesV1;
}

/** A whole Search publication in memory; used by fixtures and scripts, not by the publisher. */
export interface SearchPublicationV1 {
  readonly indexRevision: string;
  readonly corpusRevision: string;
  readonly lexicalRevision: string;
  readonly generatedAt: string;
  readonly shards: readonly SearchLexicalShardV1[];
  readonly details: readonly {
    readonly groupRootRecordId: string;
    readonly detail: FeedDetail;
  }[];
}

export interface SearchEvidenceMatchV1 {
  readonly chunkId: string;
  readonly recordId: string;
  readonly excerpt: string;
  readonly canonicalUrl: string;
  readonly author: string;
  readonly occurredAt: string;
  readonly sourceVersion: string;
  readonly matchedTerms: readonly string[];
  readonly signals: {
    readonly exactIdentifier: boolean;
    readonly lexicalRank: number;
    readonly fusedRank: number;
  };
}

export interface SearchResultV1 {
  readonly entry: FeedEntry;
  readonly projectStatus?: string;
  readonly matches: readonly SearchEvidenceMatchV1[];
  readonly detailRef: string;
}

export interface SearchProjectFacetV1 {
  readonly projectId: string;
  readonly count: number;
}

export interface SearchResponseV1 {
  readonly schema: typeof SEARCH_RESPONSE_SCHEMA;
  readonly query: string;
  readonly results: readonly SearchResultV1[];
  readonly facets: {
    /** Query matches after non-project filters, before project filtering and limiting. */
    readonly projects: readonly SearchProjectFacetV1[];
  };
  readonly retrieval: {
    readonly indexRevision: string;
    readonly lexicalRevision: string;
    readonly generatedAt: string;
    readonly stale: boolean;
  };
}

export interface SearchDetailRefV1 {
  readonly schema: typeof SEARCH_DETAIL_REF_SCHEMA;
  readonly indexRevision: string;
  readonly projectId: string;
  readonly groupRootRecordId: string;
  readonly query: string;
  readonly matchedRecordIds: readonly string[];
  /** The shard holding the group; required for search-release.v3 releases. */
  readonly shard?: number;
}

/** The pool detail a group names; all that pre-switch verification needs (Spec 013). */
export interface SearchGroupDetailRef {
  readonly groupRootRecordId: string;
  readonly detailSha256?: Sha256Digest;
}

/** What a streamed Search release declares once every object has been produced. */
export interface StreamedSearchRelease {
  readonly descriptor: SearchReleaseDescriptorV1;
  readonly manifest: SearchReleaseManifestV3;
  /** Each shard's group digests as written, so cross-object checks need not re-read shards. */
  readonly shardGroups: ReadonlyMap<string, readonly SearchGroupDetailRef[]>;
}

/** Publishes an in-memory publication at its own `lexicalRevision`; `options.lexicalRevision` is not read. */
export async function buildR2SearchProjection(
  publication: SearchPublicationV1,
  options: Omit<SearchReleaseOptions, "lexicalRevision"> = {},
): Promise<readonly ProjectionObject[]> {
  const produced = new Map<string, ProjectionObject>();
  const stream = searchProjectionObjects(publication, searchGroupsFromPublication(publication), {
    ...options,
    lexicalRevision: publication.lexicalRevision,
  });
  let next = await stream.next();
  for (; !next.done; next = await stream.next()) {
    produced.set(next.value.key, immutableObject(next.value.key, decodeBody(next.value.body)));
  }
  const { descriptor } = next.value;
  return [
    ...descriptor.immutableObjects.map((object) => produced.get(object.key)!),
    {
      key: SEARCH_CURRENT_KEY,
      body: JSON.stringify(descriptor.current),
      cacheControl: "public, max-age=30, must-revalidate",
    },
  ];
}

/**
 * Orders an in-memory publication's groups for `searchProjectionObjects` and checks that its
 * shards, groups, chunks, and details agree.
 */
export function* searchGroupsFromPublication(publication: SearchPublicationV1): Generator<SearchGroupSource> {
  const shards = [...publication.shards].sort((left, right) => left.projectId.localeCompare(right.projectId));
  requireUnique(shards.map((shard) => shard.projectId), "Search shard projectId");
  const details = new Map(publication.details.map((item) => [item.groupRootRecordId, item.detail]));
  requireUnique(publication.details.map((item) => item.groupRootRecordId), "Search detail group root");
  const groupRoots = new Set<string>();
  for (const shard of shards) {
    validateShard(shard, publication.indexRevision);
    for (const group of shard.groups) groupRoots.add(group.groupRootRecordId);
  }
  const missing = [...groupRoots].filter((groupRoot) => !details.has(groupRoot));
  const orphan = [...details.keys()].filter((groupRoot) => !groupRoots.has(groupRoot));
  if (missing.length > 0 || orphan.length > 0) {
    throw new Error(`Search publication membership mismatch: missing=[${missing.join(", ")}], orphan=[${orphan.join(", ")}]`);
  }
  for (const shard of shards) {
    const chunks = new Map<string, SourceRecordChunkV1[]>();
    for (const chunk of shard.chunks) {
      chunks.set(chunk.groupRootRecordId, [...chunks.get(chunk.groupRootRecordId) ?? [], chunk]);
    }
    const groups = [...shard.groups].sort((left, right) => left.groupRootRecordId.localeCompare(right.groupRootRecordId));
    for (const group of groups) {
      yield {
        projectId: shard.projectId,
        groupRootRecordId: group.groupRootRecordId,
        entry: group.entry,
        detail: details.get(group.groupRootRecordId)!,
        chunks: chunks.get(group.groupRootRecordId) ?? [],
      };
    }
  }
}

/**
 * Produces a search-release.v3 one immutable object at a time (Spec 009, Spec 013). Groups
 * arrive ordered by project, then group root; each group's detail is written as it arrives,
 * and whole groups fill a shard of at most `maxShardChunks` chunks (a larger group fills one
 * alone) that is written and released before the next starts. Only term statistics and
 * per-group digests outlive a shard. The terms object and the manifest come last. An
 * unsupported `lexicalRevision` fails before the first object.
 */
export async function* searchProjectionObjects(
  release: SearchReleaseInput,
  groups: Iterable<SearchGroupSource> | AsyncIterable<SearchGroupSource>,
  options: SearchReleaseOptions = {},
): AsyncGenerator<EncodedProjectionObject, StreamedSearchRelease> {
  const lexical = lexicalSearchConfigFor(options.lexicalRevision ?? DEFAULT_LEXICAL_REVISION, options.identifiers);
  requireSegment(release.indexRevision, "indexRevision");
  requireText(release.corpusRevision, "corpusRevision");
  requireTimestamp(release.generatedAt, "generatedAt");
  const maxShardChunks = options.maxShardChunks ?? DEFAULT_MAX_SHARD_CHUNKS;
  if (!Number.isSafeInteger(maxShardChunks) || maxShardChunks < 1) throw new Error("maxShardChunks must be a positive integer");

  const prefix = searchReleasePrefix(release.indexRevision);
  const detailObjects = new Map<string, ImmutableProjectionObjectV1>();
  const shardObjects: ImmutableProjectionObjectV1[] = [];
  const shards: SearchShardRefV1[] = [];
  const shardGroups = new Map<string, readonly SearchGroupDetailRef[]>();
  const terms = new Map<string, number[]>();
  let chunkCount = 0;
  let totalChunkLength = 0;
  let groupCount = 0;
  let open: { readonly projectId: string; readonly groups: SearchGroupProjectionV1[]; readonly chunks: SourceRecordChunkV1[] } | undefined;
  let previous: SearchGroupSource | undefined;

  const closeShard = async (): Promise<EncodedProjectionObject> => {
    const { projectId, groups: shardGroupProjections, chunks } = open!;
    open = undefined;
    const shard = shards.length;
    chunks.sort((left, right) => left.id.localeCompare(right.id));
    const { lengths, postings } = lexicalShardPostings(chunks, lexical);
    for (const [term, list] of Object.entries(postings)) {
      const statistics = terms.get(term);
      if (statistics === undefined) terms.set(term, [list.length / 2, shard]);
      else {
        statistics[0] += list.length / 2;
        statistics.push(shard);
      }
    }
    chunkCount += chunks.length;
    for (const length of lengths) totalChunkLength += length;
    const key = `${prefix}/lexical/${encodeURIComponent(projectId)}/${shard}.json`;
    const body: SearchLexicalShardV2 = {
      schema: SEARCH_LEXICAL_SHARD_SCHEMA_V2,
      indexRevision: release.indexRevision,
      projectId,
      shard,
      chunks,
      lengths,
      postings,
      groups: shardGroupProjections,
    };
    const object = await encodeProjectionObject(key, body, SEARCH_DETAIL_POOL);
    shards.push({ projectId, key });
    shardObjects.push(describe(object));
    shardGroups.set(key, shardGroupProjections.map((group) => ({
      groupRootRecordId: group.groupRootRecordId,
      detailSha256: group.detailSha256!,
    })));
    return object;
  };

  for await (const group of groups) {
    requireText(group.projectId, "group.projectId");
    if (previous !== undefined && (group.projectId.localeCompare(previous.projectId) ||
        group.groupRootRecordId.localeCompare(previous.groupRootRecordId)) <= 0) {
      throw new Error(`Search groups must be ordered by project and group root without repeats: ${group.groupRootRecordId}`);
    }
    previous = group;
    validateDetail(group.entry, group.detail, group.groupRootRecordId, group.projectId);
    const chunks = groupChunks(group);

    const detailObject = await encodeProjectionObject(undefined, group.detail, SEARCH_DETAIL_POOL);
    if (!detailObjects.has(detailObject.key)) {
      detailObjects.set(detailObject.key, describe(detailObject));
      yield detailObject;
    }

    if (open !== undefined && (open.projectId !== group.projectId || open.chunks.length + chunks.length > maxShardChunks)) {
      yield await closeShard();
    }
    open ??= { projectId: group.projectId, groups: [], chunks: [] };
    const root = group.detail.records.find((record) => record.id === group.groupRootRecordId);
    const projectStatus = root?.artifactStatus?.trim();
    open.groups.push({
      groupRootRecordId: group.groupRootRecordId,
      entry: group.entry,
      ...(projectStatus === undefined || projectStatus.length === 0 ? {} : { projectStatus }),
      detailSha256: detailObject.sha256,
    });
    open.chunks.push(...chunks);
    groupCount += 1;
  }
  if (open !== undefined) yield await closeShard();

  const termsObject = await encodeProjectionObject(searchTermsKey(release.indexRevision), {
    schema: SEARCH_TERMS_SCHEMA,
    indexRevision: release.indexRevision,
    terms: Object.fromEntries(terms),
  } satisfies SearchTermsV1, SEARCH_DETAIL_POOL);
  terms.clear();
  yield termsObject;

  const dataObjects = [...shardObjects, describe(termsObject), ...detailObjects.values()];
  const manifest: SearchReleaseManifestV3 = {
    schema: SEARCH_RELEASE_SCHEMA,
    indexRevision: release.indexRevision,
    corpusRevision: release.corpusRevision,
    lexicalRevision: lexical.revision,
    generatedAt: release.generatedAt,
    shards,
    chunkCount,
    totalChunkLength,
    groupCount,
    objectDigests: Object.fromEntries(dataObjects.map((object) => [object.key, object.sha256])),
  };
  const releaseManifestKey = searchReleaseManifestKey(release.indexRevision);
  const manifestObject = await encodeProjectionObject(releaseManifestKey, manifest, SEARCH_DETAIL_POOL);
  yield manifestObject;
  const current: SearchCurrentPointerV1 = {
    schema: SEARCH_CURRENT_SCHEMA,
    indexRevision: release.indexRevision,
    releaseManifestKey,
    generatedAt: release.generatedAt,
  };
  return {
    descriptor: {
      kind: "search",
      releaseId: release.indexRevision,
      currentKey: SEARCH_CURRENT_KEY,
      current,
      immutableObjects: [...dataObjects, describe(manifestObject)],
    },
    manifest,
    shardGroups,
  };
}

/** A group's chunks: in its project and group, of its records, identical duplicates dropped. */
function groupChunks(group: SearchGroupSource): readonly SourceRecordChunkV1[] {
  const byId = new Map<string, SourceRecordChunkV1>();
  for (const chunk of group.chunks) {
    if (chunk.projectId !== group.projectId) throw new Error(`Chunk ${chunk.id} crossed shard project scope`);
    if (chunk.groupRootRecordId !== group.groupRootRecordId) throw new Error(`Chunk ${chunk.id} has no Search group projection`);
    if (!group.entry.recordIds.includes(chunk.recordId)) throw new Error(`Chunk ${chunk.id} record is absent from its FeedEntry`);
    const previous = byId.get(chunk.id);
    if (previous !== undefined && previous.contentHash !== chunk.contentHash) throw new Error(`Conflicting chunks share id ${chunk.id}`);
    byId.set(chunk.id, previous ?? chunk);
  }
  return [...byId.values()];
}

function describe(object: EncodedProjectionObject): ImmutableProjectionObjectV1 {
  return { key: object.key, sha256: object.sha256, byteLength: object.byteLength };
}

export function searchReleasePrefix(indexRevision: string): string {
  return `public/search/v1/releases/${requireSegment(indexRevision, "indexRevision")}`;
}

export function searchReleaseManifestKey(indexRevision: string): string {
  return `${searchReleasePrefix(indexRevision)}/manifest.json`;
}

export function searchTermsKey(indexRevision: string): string {
  return `${searchReleasePrefix(indexRevision)}/terms.json`;
}

export function createSearchDetailRef(
  value: Omit<SearchDetailRefV1, "schema">,
): string {
  const parsed = validateDetailRef({ schema: SEARCH_DETAIL_REF_SCHEMA, ...value });
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${SEARCH_DETAIL_REF_PREFIX}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

export function parseSearchDetailRef(value: string): SearchDetailRefV1 {
  if (!value.startsWith(SEARCH_DETAIL_REF_PREFIX) || value.length > 4096) {
    throw new Error("Search detailRef is invalid");
  }
  const encoded = value.slice(SEARCH_DETAIL_REF_PREFIX.length).replaceAll("-", "+").replaceAll("_", "/");
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return validateDetailRef(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch {
    throw new Error("Search detailRef is invalid");
  }
}

export function isSearchCurrentPointer(value: unknown): value is SearchCurrentPointerV1 {
  if (!isObject(value)) return false;
  return value.schema === SEARCH_CURRENT_SCHEMA &&
    isNonEmptyString(value.indexRevision) &&
    isNonEmptyString(value.releaseManifestKey) &&
    isNonEmptyString(value.generatedAt);
}

export function isSearchReleaseManifest(value: unknown): value is SearchReleaseManifest {
  if (!isObject(value) || !isObject(value.objectDigests)) return false;
  const common = isNonEmptyString(value.indexRevision) &&
    isNonEmptyString(value.corpusRevision) &&
    isNonEmptyString(value.lexicalRevision) &&
    isNonEmptyString(value.generatedAt) &&
    isCount(value.chunkCount) &&
    isCount(value.groupCount) &&
    Object.values(value.objectDigests).every(isSha256Digest);
  if (!common) return false;
  if (value.schema === SEARCH_RELEASE_SCHEMA) {
    return isCount(value.totalChunkLength) &&
      Array.isArray(value.shards) &&
      value.shards.every((shard) => isObject(shard) && isNonEmptyString(shard.projectId) && isNonEmptyString(shard.key));
  }
  const versioned = value.schema === SEARCH_RELEASE_SCHEMA_V2 ||
    (value.schema === SEARCH_RELEASE_SCHEMA_V1 && isNonEmptyString(value.detailPrefix));
  return versioned && isObject(value.shardKeys) && Object.values(value.shardKeys).every(isNonEmptyString);
}

/** Shard keys of any release version, in shard order for v3. */
export function searchShardKeys(manifest: SearchReleaseManifest): readonly string[] {
  return manifest.schema === SEARCH_RELEASE_SCHEMA
    ? manifest.shards.map((shard) => shard.key)
    : Object.values(manifest.shardKeys);
}

export function isSearchLexicalShardV2(value: unknown): value is SearchLexicalShardV2 {
  if (!isObject(value)) return false;
  return value.schema === SEARCH_LEXICAL_SHARD_SCHEMA_V2 &&
    isNonEmptyString(value.indexRevision) &&
    isNonEmptyString(value.projectId) &&
    isCount(value.shard) &&
    Array.isArray(value.chunks) &&
    Array.isArray(value.lengths) &&
    value.lengths.length === value.chunks.length &&
    isObject(value.postings) &&
    Array.isArray(value.groups);
}

export function isSearchTerms(value: unknown): value is SearchTermsV1 {
  return isObject(value) &&
    value.schema === SEARCH_TERMS_SCHEMA &&
    isNonEmptyString(value.indexRevision) &&
    isObject(value.terms);
}

export function isSearchLexicalShard(value: unknown): value is SearchLexicalShardV1 {
  if (!isObject(value)) return false;
  return value.schema === SEARCH_LEXICAL_SHARD_SCHEMA &&
    isNonEmptyString(value.indexRevision) &&
    isNonEmptyString(value.projectId) &&
    Array.isArray(value.chunks) &&
    Array.isArray(value.groups);
}

function validateShard(shard: SearchLexicalShardV1, indexRevision: string): void {
  if (shard.schema !== SEARCH_LEXICAL_SHARD_SCHEMA) throw new Error("Search shard schema is invalid");
  if (shard.indexRevision !== indexRevision) throw new Error("Search shard index revision mismatch");
  requireText(shard.projectId, "shard.projectId");
  requireUnique(shard.groups.map((group) => group.groupRootRecordId), `${shard.projectId} group root`);
  for (const group of shard.groups) {
    if (group.projectStatus !== undefined) requireText(group.projectStatus, "group.projectStatus");
  }
  const groups = new Map(shard.groups.map((group) => [group.groupRootRecordId, group]));
  for (const chunk of shard.chunks) {
    if (chunk.projectId !== shard.projectId) throw new Error(`Chunk ${chunk.id} crossed shard project scope`);
    const group = groups.get(chunk.groupRootRecordId);
    if (group === undefined) throw new Error(`Chunk ${chunk.id} has no Search group projection`);
    if (!group.entry.recordIds.includes(chunk.recordId)) {
      throw new Error(`Chunk ${chunk.id} record is absent from its FeedEntry`);
    }
  }
}

function validateDetail(
  entry: FeedEntry,
  detail: FeedDetail,
  groupRootRecordId: string,
  projectId: string,
): void {
  if (entry.id !== detail.entry.id) throw new Error(`Search detail entry mismatch for ${groupRootRecordId}`);
  if (entry.projectId !== projectId || detail.entry.projectId !== projectId) {
    throw new Error(`Search detail crossed project scope for ${groupRootRecordId}`);
  }
  if (!entry.recordIds.includes(groupRootRecordId)) {
    throw new Error(`Search group root ${groupRootRecordId} is absent from FeedEntry records`);
  }
  const expected = [...entry.recordIds].sort();
  const actual = detail.records.map((record) => record.id).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`Search detail records mismatch for ${groupRootRecordId}`);
  }
}

function validateDetailRef(value: unknown): SearchDetailRefV1 {
  if (!isObject(value) || value.schema !== SEARCH_DETAIL_REF_SCHEMA) {
    throw new Error("Search detailRef is invalid");
  }
  const indexRevision = requireSegment(value.indexRevision, "detailRef.indexRevision");
  const projectId = requireText(value.projectId, "detailRef.projectId");
  const groupRootRecordId = requireText(value.groupRootRecordId, "detailRef.groupRootRecordId");
  const query = requireText(value.query, "detailRef.query");
  if (query.length > 500) throw new Error("Search detailRef query is too long");
  if (!Array.isArray(value.matchedRecordIds) || value.matchedRecordIds.length === 0 || value.matchedRecordIds.length > 20) {
    throw new Error("Search detailRef matchedRecordIds are invalid");
  }
  const matchedRecordIds = value.matchedRecordIds.map((recordId) => requireText(recordId, "detailRef.matchedRecordId"));
  requireUnique(matchedRecordIds, "Search detailRef matchedRecordId");
  if (value.shard !== undefined && !isCount(value.shard)) throw new Error("Search detailRef shard is invalid");
  return {
    schema: SEARCH_DETAIL_REF_SCHEMA,
    indexRevision,
    projectId,
    groupRootRecordId,
    query,
    matchedRecordIds,
    ...(value.shard === undefined ? {} : { shard: value.shard as number }),
  };
}

function immutableObject(key: string, body: string): ProjectionObject {
  return { key, body, cacheControl: "public, max-age=31536000, immutable" };
}

function requireSegment(value: unknown, label: string): string {
  const result = requireText(value, label);
  if (!/^[A-Za-z0-9._-]+$/u.test(result)) throw new Error(`${label} is not a safe object-key segment`);
  return result;
}

function requireTimestamp(value: unknown, label: string): string {
  const result = requireText(value, label);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label} must be a timestamp`);
  return result;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must not be empty`);
  return value.trim();
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} values must be unique`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
