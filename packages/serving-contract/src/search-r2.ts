import type { FeedDetail, FeedEntry } from "@oss-knowledge-base/domain";
import type { SourceRecordChunkV1 } from "@oss-knowledge-base/search";

import { isSha256Digest, type Sha256Digest } from "./digest";
import type { ImmutableProjectionObjectV1, SearchReleaseDescriptorV1 } from "./publication-set";
import { decodeBody, encodeProjectionObject, type EncodedProjectionObject, type ProjectionObject } from "./r2";

export const SEARCH_CURRENT_KEY = "public/search/v1/current.json";
export const SEARCH_CURRENT_SCHEMA = "osskb.search-current.v1" as const;
export const SEARCH_RELEASE_SCHEMA = "osskb.search-release.v2" as const;
export const SEARCH_RELEASE_SCHEMA_V1 = "osskb.search-release.v1" as const;
/** Shared Search detail objects, keyed by the SHA-256 of their bytes (ADR-0013). */
export const SEARCH_DETAIL_POOL = "public/search/v1/objects/details/";
export const SEARCH_LEXICAL_SHARD_SCHEMA = "osskb.search-lexical-shard.v1" as const;
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
  readonly schema: typeof SEARCH_RELEASE_SCHEMA;
  readonly indexRevision: string;
  readonly corpusRevision: string;
  readonly lexicalRevision: string;
  readonly generatedAt: string;
  readonly shardKeys: Readonly<Record<string, string>>;
  readonly chunkCount: number;
  readonly groupCount: number;
  readonly objectDigests: Readonly<Record<string, string>>;
}

export type SearchReleaseManifest = SearchReleaseManifestV1 | SearchReleaseManifestV2;

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
}

/** What a streamed Search release declares once every object has been produced. */
export interface StreamedSearchRelease {
  readonly descriptor: SearchReleaseDescriptorV1;
  readonly manifest: SearchReleaseManifestV2;
  /** Each shard's groups as written, so cross-object checks need not re-read shard bodies. */
  readonly shardGroups: ReadonlyMap<string, readonly SearchGroupProjectionV1[]>;
}

export async function buildR2SearchProjection(
  publication: SearchPublicationV1,
): Promise<readonly ProjectionObject[]> {
  const produced = new Map<string, ProjectionObject>();
  const stream = searchProjectionObjects(publication);
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
 * Produces a Search release one immutable object at a time (Spec 009). Details come first,
 * because each shard group names its detail's digest; the descriptor still lists shards,
 * then details, then the release manifest. Byte-identical details share one pool object.
 */
export async function* searchProjectionObjects(
  publication: SearchPublicationV1,
): AsyncGenerator<EncodedProjectionObject, StreamedSearchRelease> {
  requireSegment(publication.indexRevision, "indexRevision");
  requireText(publication.corpusRevision, "corpusRevision");
  requireText(publication.lexicalRevision, "lexicalRevision");
  requireTimestamp(publication.generatedAt, "generatedAt");

  const prefix = searchReleasePrefix(publication.indexRevision);
  const releaseManifestKey = `${prefix}/manifest.json`;
  const inputShards = [...publication.shards].sort((left, right) =>
    left.projectId.localeCompare(right.projectId));
  requireUnique(inputShards.map((shard) => shard.projectId), "Search shard projectId");

  const groups = inputShards.flatMap((shard) => {
    validateShard(shard, publication.indexRevision);
    return shard.groups.map((group) => ({ ...group, projectId: shard.projectId }));
  });
  requireUnique(groups.map((group) => group.groupRootRecordId), "Search group root");
  const details = new Map(publication.details.map((item) => [item.groupRootRecordId, item.detail]));
  requireUnique(publication.details.map((item) => item.groupRootRecordId), "Search detail group root");

  const groupRoots = new Set(groups.map((group) => group.groupRootRecordId));
  const missing = [...groupRoots].filter((groupRoot) => !details.has(groupRoot));
  const orphan = [...details.keys()].filter((groupRoot) => !groupRoots.has(groupRoot));
  if (missing.length > 0 || orphan.length > 0) {
    throw new Error(`Search publication membership mismatch: missing=[${missing.join(", ")}], orphan=[${orphan.join(", ")}]`);
  }
  for (const group of groups) {
    validateDetail(group.entry, details.get(group.groupRootRecordId)!, group.groupRootRecordId, group.projectId);
  }

  const detailObjects = new Map<string, ImmutableProjectionObjectV1>();
  const detailDigests = new Map<string, Sha256Digest>();
  for (const group of groups) {
    const object = await encodeProjectionObject(undefined, details.get(group.groupRootRecordId)!, SEARCH_DETAIL_POOL);
    detailDigests.set(group.groupRootRecordId, object.sha256);
    if (detailObjects.has(object.key)) continue;
    detailObjects.set(object.key, describe(object));
    yield object;
  }

  const shardObjects: ImmutableProjectionObjectV1[] = [];
  const shardKeys: Record<string, string> = {};
  const shardGroups = new Map<string, readonly SearchGroupProjectionV1[]>();
  let chunkCount = 0;
  for (const inputShard of inputShards) {
    const shard: SearchLexicalShardV1 = {
      ...inputShard,
      groups: inputShard.groups.map((group) => {
        const detail = details.get(group.groupRootRecordId)!;
        const root = detail.records.find((record) => record.id === group.groupRootRecordId);
        const projectStatus = root?.artifactStatus?.trim();
        return {
          groupRootRecordId: group.groupRootRecordId,
          entry: group.entry,
          ...(projectStatus === undefined || projectStatus.length === 0
            ? {}
            : { projectStatus }),
          detailSha256: detailDigests.get(group.groupRootRecordId)!,
        };
      }),
    };
    const key = `${prefix}/lexical/${encodeURIComponent(shard.projectId)}.json`;
    const object = await encodeProjectionObject(key, shard, SEARCH_DETAIL_POOL);
    shardKeys[shard.projectId] = key;
    shardGroups.set(key, shard.groups);
    shardObjects.push(describe(object));
    chunkCount += shard.chunks.length;
    yield object;
  }

  const dataObjects = [...shardObjects, ...detailObjects.values()];
  const manifest: SearchReleaseManifestV2 = {
    schema: SEARCH_RELEASE_SCHEMA,
    indexRevision: publication.indexRevision,
    corpusRevision: publication.corpusRevision,
    lexicalRevision: publication.lexicalRevision,
    generatedAt: publication.generatedAt,
    shardKeys,
    chunkCount,
    groupCount: groups.length,
    objectDigests: Object.fromEntries(dataObjects.map((object) => [object.key, object.sha256])),
  };
  const manifestObject = await encodeProjectionObject(releaseManifestKey, manifest, SEARCH_DETAIL_POOL);
  yield manifestObject;
  const current: SearchCurrentPointerV1 = {
    schema: SEARCH_CURRENT_SCHEMA,
    indexRevision: publication.indexRevision,
    releaseManifestKey,
    generatedAt: publication.generatedAt,
  };
  return {
    descriptor: {
      kind: "search",
      releaseId: publication.indexRevision,
      currentKey: SEARCH_CURRENT_KEY,
      current,
      immutableObjects: [...dataObjects, describe(manifestObject)],
    },
    manifest,
    shardGroups,
  };
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
  if (!isObject(value) || !isObject(value.shardKeys) || !isObject(value.objectDigests)) return false;
  const versioned = value.schema === SEARCH_RELEASE_SCHEMA ||
    (value.schema === SEARCH_RELEASE_SCHEMA_V1 && isNonEmptyString(value.detailPrefix));
  return versioned &&
    isNonEmptyString(value.indexRevision) &&
    isNonEmptyString(value.corpusRevision) &&
    isNonEmptyString(value.lexicalRevision) &&
    isNonEmptyString(value.generatedAt) &&
    typeof value.chunkCount === "number" &&
    typeof value.groupCount === "number" &&
    Object.values(value.shardKeys).every(isNonEmptyString) &&
    Object.values(value.objectDigests).every(isSha256Digest);
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
  return { schema: SEARCH_DETAIL_REF_SCHEMA, indexRevision, projectId, groupRootRecordId, query, matchedRecordIds };
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
