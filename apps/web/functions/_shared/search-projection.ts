import type { FeedDetail } from "@oss-knowledge-base/domain";
import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import {
  buildLexicalIndex,
  facetLexicalIndexByProject,
  lexicalQueryTerms,
  lexicalSearchConfigFor,
  rankLexicalShard,
  searchLexicalIndex,
  selectLexicalResults,
  SUPPORTED_LEXICAL_REVISIONS,
  validateSearchFilters,
  type LexicalSearchConfigV1,
  type LexicalSearchResultV1,
  type SearchFiltersV1,
} from "@oss-knowledge-base/search";
import {
  createSearchDetailRef,
  detailPoolKey,
  feedEntryObjectName,
  isSha256Digest,
  isSearchCurrentPointer,
  isSearchLexicalShard,
  isSearchLexicalShardV2,
  isSearchReleaseManifest,
  isSearchTerms,
  parseSearchDetailRef,
  SEARCH_CURRENT_KEY,
  SEARCH_DETAIL_POOL,
  SEARCH_RELEASE_SCHEMA,
  SEARCH_RELEASE_SCHEMA_V1,
  SEARCH_RESPONSE_SCHEMA,
  searchReleaseManifestKey,
  searchReleasePrefix,
  searchShardKeys,
  searchTermsKey,
  type SearchLexicalShardV1,
  type SearchLexicalShardV2,
  type SearchGroupProjectionV1,
  type SearchReleaseManifest,
  type SearchReleaseManifestV3,
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
  const config = releaseLexicalConfig(manifest.lexicalRevision);
  const ranked = manifest.schema === SEARCH_RELEASE_SCHEMA
    ? await rankShardedRelease(bucket, manifest, query, request, config)
    : await rankWholeRelease(bucket, manifest, query, request, config);

  return {
    schema: SEARCH_RESPONSE_SCHEMA,
    query,
    results: ranked.results.map(({ result, group, shard }, index) => {
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
          ...(shard === undefined ? {} : { shard }),
        }),
      };
    }),
    facets: {
      projects: ranked.projectIds.map((projectId) => ({
        projectId,
        count: ranked.projectFacets[projectId] ?? 0,
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

interface RankedRelease {
  readonly results: readonly {
    readonly result: LexicalSearchResultV1;
    readonly group: SearchGroupProjectionV1;
    readonly shard?: number;
  }[];
  readonly projectFacets: Readonly<Record<string, number>>;
  readonly projectIds: readonly string[];
}

/**
 * The config the release was written with (Spec 016): its revision's tokenizer and, from
 * `bm25-reference@2`, the community identifier profiles the publisher indexes with. A release
 * of any other revision is not answered (HTTP 503) rather than scored with the wrong tokens.
 */
function releaseLexicalConfig(revision: string): LexicalSearchConfigV1 {
  if (!SUPPORTED_LEXICAL_REVISIONS.includes(revision)) {
    throw new Error(`R2 Search release uses unsupported lexical revision ${revision}`);
  }
  return lexicalSearchConfigFor(revision, searchIdentifierProfiles);
}

/** Shards fetched at once; each is ranked and released before more are read (Spec 013). */
const SHARD_READ_CONCURRENCY = 4;

/**
 * search-release.v3: reads only the shards that hold a term of the query, as the release's
 * revision tokenizes it, and scores their stored postings with the release-wide statistics, so
 * results equal the whole-corpus oracle. Each shard keeps only its facet counts and its best
 * `limit` groups.
 */
async function rankShardedRelease(
  bucket: R2Bucket,
  manifest: SearchReleaseManifestV3,
  query: string,
  request: R2SearchRequestV1,
  config: LexicalSearchConfigV1,
): Promise<RankedRelease> {
  const projectIds = [...new Set(manifest.shards.map((shard) => shard.projectId))].sort();
  const terms = await readJsonObject<unknown>(bucket, searchTermsKey(manifest.indexRevision));
  if (!isSearchTerms(terms) || terms.indexRevision !== manifest.indexRevision) {
    throw new Error("R2 Search terms object is missing or invalid");
  }
  const statistics = (term: string): readonly number[] | undefined => {
    if (!Object.hasOwn(terms.terms, term)) return undefined;
    const value = terms.terms[term];
    if (!Array.isArray(value) || value.length < 2 || !value.every((item) => Number.isSafeInteger(item) && item >= 0)) {
      throw new Error(`R2 Search terms entry is invalid for ${term}`);
    }
    return value;
  };
  const selected = new Set<number>();
  for (const term of lexicalQueryTerms(query, config)) {
    for (const shard of statistics(term)?.slice(1) ?? []) {
      if (shard >= manifest.shards.length) throw new Error(`R2 Search terms name an undeclared shard ${shard}`);
      selected.add(shard);
    }
  }
  const corpus = {
    chunkCount: manifest.chunkCount,
    totalChunkLength: manifest.totalChunkLength,
    documentFrequency: (term: string) => statistics(term)?.[0] ?? 0,
  };
  const projectStatuses = request.filters?.projectStatuses;
  const rankRequest = { query, ...(request.filters === undefined ? {} : { filters: request.filters }) };

  const kept: RankedRelease["results"][number][] = [];
  const projectFacets: Record<string, number> = {};
  const pending = [...selected].sort((left, right) => left - right);
  const rankNext = async (): Promise<void> => {
    for (let shardNumber = pending.shift(); shardNumber !== undefined; shardNumber = pending.shift()) {
      const shard = await readSearchShardV2(bucket, manifest, shardNumber);
      const groups = new Map(shard.groups.map((group) => [group.groupRootRecordId, group]));
      const eligibleGroupRootRecordIds = projectStatuses === undefined
        ? undefined
        : new Set(shard.groups
            .filter((group) => group.projectStatus !== undefined && projectStatuses.includes(group.projectStatus))
            .map((group) => group.groupRootRecordId));
      const ranked = selectLexicalResults(rankLexicalShard(shard, corpus, {
        ...rankRequest,
        ...(eligibleGroupRootRecordIds === undefined ? {} : { eligibleGroupRootRecordIds }),
      }, config), request);
      for (const [projectId, count] of Object.entries(ranked.projectFacets)) {
        projectFacets[projectId] = (projectFacets[projectId] ?? 0) + count;
      }
      for (const result of ranked.results) {
        const group = groups.get(result.groupRootRecordId);
        if (group === undefined) throw new Error(`Search result ${result.groupRootRecordId} has no group projection`);
        kept.push({ result, group, shard: shardNumber });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SHARD_READ_CONCURRENCY, pending.length) }, rankNext));

  const byRoot = new Map(kept.map((item) => [item.result.groupRootRecordId, item]));
  const { results } = selectLexicalResults(kept.map((item) => item.result), request);
  return { results: results.map((result) => byRoot.get(result.groupRootRecordId)!), projectFacets, projectIds };
}

/** search-release.v1/v2: one shard per project, indexed in memory per request. */
async function rankWholeRelease(
  bucket: R2Bucket,
  manifest: Exclude<SearchReleaseManifest, SearchReleaseManifestV3>,
  query: string,
  request: R2SearchRequestV1,
  config: LexicalSearchConfigV1,
): Promise<RankedRelease> {
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
    config,
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
    results: ranked.map((result) => {
      const group = groups.get(result.groupRootRecordId);
      if (group === undefined) throw new Error(`Search result ${result.groupRootRecordId} has no group projection`);
      return { result, group };
    }),
    projectFacets: projectFacetCounts,
    projectIds: Object.keys(manifest.shardKeys).sort(),
  };
}

export async function readSearchDetailProjection(
  bucket: R2Bucket,
  encodedRef: string,
): Promise<FeedDetail | undefined> {
  const reference = parseSearchDetailRef(encodedRef);
  const manifest = await readSearchManifest(bucket, reference.indexRevision);
  let shard: SearchLexicalShardV1 | SearchLexicalShardV2;
  if (manifest.schema === SEARCH_RELEASE_SCHEMA) {
    // A v3 group is found through the shard its detailRef names, never by scanning shards.
    if (reference.shard === undefined || reference.shard >= manifest.shards.length) return undefined;
    if (manifest.shards[reference.shard]!.projectId !== reference.projectId) return undefined;
    shard = await readSearchShardV2(bucket, manifest, reference.shard);
  } else {
    const shardKey = Object.hasOwn(manifest.shardKeys, reference.projectId) ? manifest.shardKeys[reference.projectId] : undefined;
    if (shardKey === undefined) return undefined;
    shard = await readSearchShard(bucket, manifest, reference.projectId, shardKey);
  }
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
  for (const key of searchShardKeys(value)) assertReleaseObjectKey(value, key);
  return value;
}

async function readCurrentManifestKey(bucket: R2Bucket): Promise<string> {
  const current = await readJsonObject<unknown>(bucket, SEARCH_CURRENT_KEY);
  if (!isSearchCurrentPointer(current)) throw new Error("R2 Search current pointer is missing or invalid");
  const expected = searchReleaseManifestKey(current.indexRevision);
  if (current.releaseManifestKey !== expected) throw new Error("R2 Search current pointer escaped its release");
  return current.releaseManifestKey;
}

async function readSearchShardV2(
  bucket: R2Bucket,
  manifest: SearchReleaseManifestV3,
  shardNumber: number,
): Promise<SearchLexicalShardV2> {
  const reference = manifest.shards[shardNumber]!;
  assertReleaseObjectKey(manifest, reference.key);
  const value = await readJsonObject<unknown>(bucket, reference.key);
  if (
    !isSearchLexicalShardV2(value) ||
    value.indexRevision !== manifest.indexRevision ||
    value.projectId !== reference.projectId ||
    value.shard !== shardNumber
  ) {
    throw new Error(`R2 Search shard ${shardNumber} is missing or invalid for ${reference.projectId}`);
  }
  return value;
}

async function readSearchShard(
  bucket: R2Bucket,
  manifest: Exclude<SearchReleaseManifest, SearchReleaseManifestV3>,
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
