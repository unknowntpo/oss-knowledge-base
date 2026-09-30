import type { FeedDetail } from "@oss-knowledge-base/domain";
import {
  buildLexicalIndex,
  facetLexicalIndexByProject,
  searchLexicalIndex,
  validateSearchFilters,
  type SearchFiltersV1,
} from "@oss-knowledge-base/search";
import {
  createSearchDetailRef,
  detailPoolKey,
  feedEntryObjectName,
  isSha256Digest,
  isSearchCurrentPointer,
  isSearchLexicalShard,
  isSearchReleaseManifest,
  parseSearchDetailRef,
  SEARCH_CURRENT_KEY,
  SEARCH_DETAIL_POOL,
  SEARCH_RELEASE_SCHEMA_V1,
  SEARCH_RESPONSE_SCHEMA,
  searchReleaseManifestKey,
  searchReleasePrefix,
  type SearchLexicalShardV1,
  type SearchGroupProjectionV1,
  type SearchReleaseManifest,
  type SearchResponseV1,
} from "@oss-knowledge-base/serving-contract";

import { readJsonObject } from "./r2-projection";

export interface R2SearchRequestV1 {
  readonly query: string;
  readonly filters?: SearchFiltersV1;
  readonly limit: number;
}

export async function searchR2Projection(
  bucket: R2Bucket,
  request: R2SearchRequestV1,
): Promise<SearchResponseV1> {
  const query = validateQuery(request.query);
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
    throw new SearchClientError("Search limit must be between 1 and 50");
  }
  try {
    validateSearchFilters(request.filters);
  } catch (error) {
    throw new SearchClientError(error instanceof Error ? error.message : "Search filters are invalid");
  }
  const manifest = await readSearchManifest(bucket);
  const selectedKeys = Object.entries(manifest.shardKeys)
    .sort(([left], [right]) => left.localeCompare(right));
  const shards = await Promise.all(selectedKeys.map(async ([projectId, key]) =>
    readSearchShard(bucket, manifest, projectId, key)));
  const chunks = shards.flatMap((shard) => shard.chunks);
  const groups = new Map(shards.flatMap((shard) =>
    shard.groups.map((group) => [group.groupRootRecordId, group] as const)));
  const projectStatuses = request.filters?.projectStatuses;
  const eligibleGroupRootRecordIds = projectStatuses === undefined
    ? undefined
    : new Set([...groups.values()]
        .filter((group) =>
          group.projectStatus !== undefined && projectStatuses.includes(group.projectStatus))
        .map((group) => group.groupRootRecordId));
  const index = buildLexicalIndex({
    indexRevision: manifest.indexRevision,
    chunks,
    config: {
      revision: manifest.lexicalRevision,
      k1: 1.2,
      b: 0.75,
      titleWeight: 4,
      tagWeight: 2,
      exactBoost: 1_000,
      additionalGroupMatchWeight: 0.25,
      maxEvidenceMatches: 5,
      excerptCharacters: 280,
    },
  });
  const ranked = searchLexicalIndex(index, {
    query,
    ...(request.filters === undefined ? {} : { filters: request.filters }),
    ...(eligibleGroupRootRecordIds === undefined ? {} : { eligibleGroupRootRecordIds }),
    limit: request.limit,
  });
  const projectFacetCounts = facetLexicalIndexByProject(index, {
    query,
    ...(request.filters === undefined ? {} : { filters: request.filters }),
    ...(eligibleGroupRootRecordIds === undefined ? {} : { eligibleGroupRootRecordIds }),
  });

  return {
    schema: SEARCH_RESPONSE_SCHEMA,
    query,
    results: ranked.map((result, index) => {
      const group = groups.get(result.groupRootRecordId);
      if (group === undefined) throw new Error(`Search result ${result.groupRootRecordId} has no group projection`);
      const matchedRecordIds = [...new Set(result.matches.map((match) => match.recordId))];
      const entry = {
        ...group.entry,
        highlightedRecordIds: matchedRecordIds,
        reason: {
          kind: "search-match",
          label: `${matchedRecordIds.length} matching source record${matchedRecordIds.length === 1 ? "" : "s"}`,
          query,
          matchedRecordIds,
        },
      } as const;
      return {
        entry,
        ...(group.projectStatus === undefined ? {} : { projectStatus: group.projectStatus }),
        matches: result.matches.map((match) => ({
          chunkId: match.chunkId,
          recordId: match.recordId,
          excerpt: match.excerpt,
          canonicalUrl: match.canonicalUrl,
          author: match.author,
          occurredAt: match.occurredAt,
          sourceVersion: match.sourceVersion,
          matchedTerms: match.matchedTerms,
          signals: {
            exactIdentifier: match.exactMatch,
            lexicalRank: index + 1,
            fusedRank: index + 1,
          },
        })),
        detailRef: createSearchDetailRef({
          indexRevision: manifest.indexRevision,
          projectId: result.projectId,
          groupRootRecordId: result.groupRootRecordId,
          query,
          matchedRecordIds,
        }),
      };
    }),
    facets: {
      projects: Object.keys(manifest.shardKeys).sort().map((projectId) => ({
        projectId,
        count: projectFacetCounts[projectId] ?? 0,
      })),
    },
    retrieval: {
      indexRevision: manifest.indexRevision,
      lexicalRevision: manifest.lexicalRevision,
      generatedAt: manifest.generatedAt,
      stale: false,
    },
  };
}

export async function readSearchDetailProjection(
  bucket: R2Bucket,
  encodedRef: string,
): Promise<FeedDetail | undefined> {
  const reference = parseSearchDetailRef(encodedRef);
  const manifest = await readSearchManifest(bucket, reference.indexRevision);
  const shardKey = manifest.shardKeys[reference.projectId];
  if (shardKey === undefined) return undefined;
  const shard = await readSearchShard(bucket, manifest, reference.projectId, shardKey);
  const group = shard.groups.find((candidate) =>
    candidate.groupRootRecordId === reference.groupRootRecordId);
  if (group === undefined) return undefined;

  const key = searchDetailKey(manifest, group);
  const detail = await readJsonObject<FeedDetail>(bucket, key);
  if (detail === undefined) return undefined;
  const recordIds = new Set(detail.records.map((record) => record.id));
  if (
    detail.entry.id !== group.entry.id ||
    detail.entry.projectId !== reference.projectId ||
    reference.matchedRecordIds.some((recordId) => !recordIds.has(recordId))
  ) {
    throw new Error("Search detail projection does not match its immutable reference");
  }
  return {
    ...detail,
    entry: {
      ...group.entry,
      highlightedRecordIds: reference.matchedRecordIds,
      reason: {
        kind: "search-match",
        label: `${reference.matchedRecordIds.length} matching source record${reference.matchedRecordIds.length === 1 ? "" : "s"}`,
        query: reference.query,
        matchedRecordIds: reference.matchedRecordIds,
      },
    },
  };
}

export async function readSearchManifest(
  bucket: R2Bucket,
  indexRevision?: string,
): Promise<SearchReleaseManifest> {
  const manifestKey = indexRevision === undefined
    ? await readCurrentManifestKey(bucket)
    : searchReleaseManifestKey(indexRevision);
  const value = await readJsonObject<unknown>(bucket, manifestKey);
  if (!isSearchReleaseManifest(value)) throw new Error("R2 Search release manifest is missing or invalid");
  if (indexRevision !== undefined && value.indexRevision !== indexRevision) {
    throw new Error("R2 Search release revision mismatch");
  }
  const prefix = `${searchReleasePrefix(value.indexRevision)}/`;
  if (manifestKey !== `${prefix}manifest.json`) throw new Error("R2 Search manifest key escaped its release");
  if (value.schema === SEARCH_RELEASE_SCHEMA_V1 && value.detailPrefix !== `${prefix}details/`) {
    throw new Error("R2 Search detail prefix escaped its release");
  }
  for (const key of Object.values(value.shardKeys)) assertReleaseObjectKey(value, key);
  return value;
}

async function readCurrentManifestKey(bucket: R2Bucket): Promise<string> {
  const current = await readJsonObject<unknown>(bucket, SEARCH_CURRENT_KEY);
  if (!isSearchCurrentPointer(current)) throw new Error("R2 Search current pointer is missing or invalid");
  const expected = searchReleaseManifestKey(current.indexRevision);
  if (current.releaseManifestKey !== expected) throw new Error("R2 Search current pointer escaped its release");
  return current.releaseManifestKey;
}

async function readSearchShard(
  bucket: R2Bucket,
  manifest: SearchReleaseManifest,
  projectId: string,
  key: string,
): Promise<SearchLexicalShardV1> {
  assertReleaseObjectKey(manifest, key);
  const value = await readJsonObject<unknown>(bucket, key);
  if (
    !isSearchLexicalShard(value) ||
    value.indexRevision !== manifest.indexRevision ||
    value.projectId !== projectId
  ) {
    throw new Error(`R2 Search shard is missing or invalid for ${projectId}`);
  }
  return value;
}

/**
 * search-release.v1 keeps details under the release; v2 resolves the pinned shard group's
 * digest into the Search pool and requires the release to declare that key.
 */
function searchDetailKey(manifest: SearchReleaseManifest, group: SearchGroupProjectionV1): string {
  if (manifest.schema === SEARCH_RELEASE_SCHEMA_V1) {
    const key = `${manifest.detailPrefix}${feedEntryObjectName(group.groupRootRecordId)}.json`;
    assertReleaseObjectKey(manifest, key);
    return key;
  }
  if (!isSha256Digest(group.detailSha256)) throw new Error("R2 Search group has no detail digest");
  const key = detailPoolKey(SEARCH_DETAIL_POOL, group.detailSha256);
  if (manifest.objectDigests[key] !== group.detailSha256) throw new Error("R2 Search detail is not declared by its release");
  return key;
}

function assertReleaseObjectKey(manifest: SearchReleaseManifest, key: string): void {
  const prefix = `${searchReleasePrefix(manifest.indexRevision)}/`;
  if (!key.startsWith(prefix) || key.includes("..")) throw new Error("R2 Search object key escaped its release");
}

function validateQuery(value: string): string {
  const query = value.trim();
  if (query.length === 0) throw new SearchClientError("Search query must not be empty");
  if (query.length > 500) throw new SearchClientError("Search query is too long");
  return query;
}

export class SearchClientError extends Error {}
