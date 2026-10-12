import type { FeedDetail } from "@oss-knowledge-base/domain";
import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import {
  buildLexicalIndex,
  DEFAULT_FUSION_REVISION,
  DEFAULT_SEMANTIC_TIMEOUT_MS,
  facetLexicalIndexByProject,
  fuseRankings,
  isExactLexicalQuery,
  lexicalQueryTerms,
  lexicalSearchConfigFor,
  passageExcerpt,
  rankLexicalShard,
  searchLexicalIndex,
  selectLexicalResults,
  SUPPORTED_LEXICAL_REVISIONS,
  validateSearchFilters,
  type LexicalSearchConfigV1,
  type LexicalSearchResultV1,
  type SearchFiltersV1,
  type SourceRecordChunkV1,
} from "@oss-knowledge-base/search";
import {
  acceptSemanticMatch,
  errorText,
  type SemanticMatchV1,
  type SemanticQueryAnswerV1,
  type SemanticQueryPort,
} from "@oss-knowledge-base/semantic-vectorize";
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
  searchReleaseHasShardRoots,
  searchReleaseManifestKey,
  searchReleasePrefix,
  searchShardForGroupRoot,
  searchShardKeys,
  searchTermsKey,
  type SearchLexicalShardV1,
  type SearchLexicalShardV2,
  type SearchGroupProjectionV1,
  type SearchReleaseManifest,
  type SearchReleaseManifestV3,
  type SearchResponseV1,
  type SearchSemanticRetrievalV1,
} from "@oss-knowledge-base/serving-contract";

import { readJsonObject } from "./r2-projection";

export interface R2SearchRequestV1 {
  readonly query: string;
  readonly filters?: SearchFiltersV1;
  readonly limit: number;
}

/**
 * Hybrid search for one request (Spec 016 slice 3). Absent, the reader is lexical and its
 * response is what it was before this slice, byte for byte.
 */
export type SemanticSearchOptions =
  /** The flag is set but cannot be honoured (an unknown value, or no gate binding). */
  | { readonly unavailable: true }
  | {
      readonly gate: SemanticQueryPort;
      /** The request asked for lexical results only (`semantic=off`). */
      readonly off?: boolean;
      /** How long the gate may take; lexical results are returned alone after it. */
      readonly timeoutMs?: number;
      /** Remembers, per isolate, until when the gate said its budget is spent, so it is not asked again. */
      readonly refusal?: { until: number };
      readonly now?: () => number;
    };

/** Lexical threads ranked per request when hybrid search is on: the depth RRF reads lexical ranks to. */
export const HYBRID_LEXICAL_DEPTH = 50;

/** A semantic passage the served release holds, with what a result needs to show it. */
interface SemanticPassage {
  readonly chunk: SourceRecordChunkV1;
  readonly score: number;
  readonly group: SearchGroupProjectionV1;
  readonly shard: number;
  /** Whether lexical retrieval matched the passage's thread, so facets count it once. */
  readonly lexicalThread: boolean;
}

type SemanticOutcome =
  | { readonly status: "ok"; readonly semanticRevision: string; readonly cached: boolean; readonly matches: readonly SemanticMatchV1[] }
  | { readonly status: Exclude<SearchSemanticRetrievalV1["status"], "ok">; readonly reason?: SearchSemanticRetrievalV1["reason"] };

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

/**
 * Decides whether this query may ask the gate, and asks it. Never rejects, and answers within
 * the timeout: every way semantic retrieval can be missing is a status, not an error
 * (Behavior 31).
 */
function startSemantic(
  options: SemanticSearchOptions,
  manifest: SearchReleaseManifest,
  query: string,
  config: LexicalSearchConfigV1,
): Promise<SemanticOutcome> {
  if ("unavailable" in options) return Promise.resolve({ status: "failed" });
  if (options.off === true) return Promise.resolve({ status: "disabled" });
  if (!searchReleaseHasShardRoots(manifest)) return Promise.resolve({ status: "uncovered" });
  if (isExactLexicalQuery(query, config)) return Promise.resolve({ status: "skipped", reason: "identifier-query" });
  if ((query.match(LETTER_OR_DIGIT) ?? []).length < 2) return Promise.resolve({ status: "skipped", reason: "short-query" });
  const now = options.now ?? Date.now;
  if (options.refusal !== undefined && options.refusal.until > now()) return Promise.resolve({ status: "over-budget" });

  const projectIds = [...new Set(manifest.shards.map((shard) => shard.projectId))].sort();
  if (projectIds.length === 0) return Promise.resolve({ status: "uncovered" });
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const asked: Promise<SemanticQueryAnswerV1> = (async () => options.gate.query({ query, projectIds }, abort.signal))();
  return Promise.race([
    asked,
    new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), timeoutMs);
    }),
  ]).then((answer): SemanticOutcome => {
    if (answer === "timed-out") {
      abort.abort();
      // The abandoned call may still reject; nobody is waiting for it.
      asked.catch(() => undefined);
      return { status: "timed-out" };
    }
    if (answer.status === "over-budget") {
      if (options.refusal !== undefined) options.refusal.until = now() + answer.retryAfterMs;
      return { status: "over-budget" };
    }
    return answer.status === "ok" ? answer : { status: answer.status };
  }, (error): SemanticOutcome => {
    console.error(`semantic retrieval failed: ${errorText(error)}`);
    return { status: "failed" };
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function searchR2Projection(
  bucket: R2Bucket,
  request: R2SearchRequestV1,
  semantic?: SemanticSearchOptions,
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
  // Asked before the terms object and the shards are read, so the gate's time overlaps theirs.
  const outcome = semantic === undefined ? undefined : startSemantic(semantic, manifest, query, config);
  const ranked = manifest.schema === SEARCH_RELEASE_SCHEMA
    ? await rankShardedRelease(bucket, manifest, query, request, config, outcome)
    : await rankWholeRelease(bucket, manifest, query, request, config);

  const lexicalResult = ({ result, group, shard }: RankedRelease["results"][number], ranks: { readonly lexicalRank: number; readonly semanticRank?: number; readonly fusedRank: number }) => {
    const matchedRecordIds = [...new Set(result.matches.map((match) => match.recordId))];
    return {
      entry: searchMatchEntry(group, query, matchedRecordIds),
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
          lexicalRank: ranks.lexicalRank,
          ...(ranks.semanticRank === undefined ? {} : { semanticRank: ranks.semanticRank }),
          fusedRank: ranks.fusedRank,
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
  };
  const facets = (extra: Readonly<Record<string, number>> = {}) => ({
    projects: ranked.projectIds.map((projectId) => ({
      projectId,
      count: (ranked.projectFacets[projectId] ?? 0) + (extra[projectId] ?? 0),
    })),
  });
  const retrieval = {
    indexRevision: manifest.indexRevision,
    lexicalRevision: manifest.lexicalRevision,
    generatedAt: manifest.generatedAt,
    stale: false,
  };

  const settled = outcome === undefined ? undefined : await outcome;
  if (settled === undefined || settled.status !== "ok") {
    return {
      schema: SEARCH_RESPONSE_SCHEMA,
      query,
      results: ranked.results.slice(0, request.limit).map((item, index) => lexicalResult(item, { lexicalRank: index + 1, fusedRank: index + 1 })),
      facets: facets(),
      retrieval: settled === undefined ? retrieval : {
        ...retrieval,
        fusionRevision: DEFAULT_FUSION_REVISION,
        semantic: { status: settled.status, ...(settled.reason === undefined ? {} : { reason: settled.reason }) },
      },
    };
  }

  // Hybrid (Behavior 28–29): the project filter applies to semantic passages as to lexical threads.
  const projectIds = request.filters?.projectIds;
  const passages = ranked.semanticPassages
    .filter((passage) => projectIds === undefined || projectIds.includes(passage.chunk.projectId))
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
  const byChunk = new Map(passages.map((passage) => [passage.chunk.id, passage]));
  const byRoot = new Map(ranked.results.map((item) => [item.result.groupRootRecordId, item]));
  const fused = fuseRankings({
    lexical: ranked.results.map((item) => item.result),
    semantic: passages.map(({ chunk, score }) => ({
      chunkId: chunk.id,
      recordId: chunk.recordId,
      groupRootRecordId: chunk.groupRootRecordId,
      projectId: chunk.projectId,
      score,
    })),
  }).slice(0, request.limit);
  // A thread only semantic retrieval found is counted in its project's facet, before the project filter.
  const semanticOnly: Record<string, Set<string>> = {};
  for (const passage of ranked.semanticPassages) {
    if (passage.lexicalThread) continue;
    (semanticOnly[passage.chunk.projectId] ??= new Set()).add(passage.chunk.groupRootRecordId);
  }

  return {
    schema: SEARCH_RESPONSE_SCHEMA,
    query,
    results: fused.map((item) => {
      const ranks = { ...(item.signals.semanticRank === undefined ? {} : { semanticRank: item.signals.semanticRank }), fusedRank: item.signals.fusedRank };
      const lexical = byRoot.get(item.groupRootRecordId);
      if (lexical !== undefined) return lexicalResult(lexical, { lexicalRank: item.signals.lexicalRank!, ...ranks });
      const shown = item.semanticMatches.map((match) => byChunk.get(match.chunkId)!);
      const matchedRecordIds = [...new Set(shown.map((passage) => passage.chunk.recordId))];
      const { group, shard } = shown[0]!;
      return {
        entry: searchMatchEntry(group, query, matchedRecordIds),
        ...(group.projectStatus === undefined ? {} : { projectStatus: group.projectStatus }),
        // No query term located these passages: each is shown from its start and links to its source.
        matches: shown.map(({ chunk }) => ({
          chunkId: chunk.id,
          recordId: chunk.recordId,
          excerpt: passageExcerpt(chunk.text, config),
          canonicalUrl: chunk.canonicalUrl,
          author: chunk.author,
          occurredAt: chunk.occurredAt,
          sourceVersion: chunk.sourceVersion,
          matchedTerms: [],
          signals: { exactIdentifier: false, ...ranks },
        })),
        detailRef: createSearchDetailRef({
          indexRevision: manifest.indexRevision,
          projectId: item.projectId,
          groupRootRecordId: item.groupRootRecordId,
          query,
          matchedRecordIds,
          shard,
        }),
      };
    }),
    facets: facets(Object.fromEntries(Object.entries(semanticOnly).map(([projectId, roots]) => [projectId, roots.size]))),
    retrieval: {
      ...retrieval,
      fusionRevision: DEFAULT_FUSION_REVISION,
      semanticRevision: settled.semanticRevision,
      semantic: { status: "ok", candidates: passages.length, cached: settled.cached },
    },
  };
}

/** The transient `search-match` entry of a thread (Spec 005), for a lexical or a semantic result. */
function searchMatchEntry(group: SearchGroupProjectionV1, query: string, matchedRecordIds: readonly string[]) {
  return {
    ...group.entry,
    highlightedRecordIds: matchedRecordIds,
    reason: {
      kind: "search-match",
      label: `${matchedRecordIds.length} matching source record${matchedRecordIds.length === 1 ? "" : "s"}`,
      query,
      matchedRecordIds,
    },
  } as const;
}

interface RankedRelease {
  readonly results: readonly {
    readonly result: LexicalSearchResultV1;
    readonly group: SearchGroupProjectionV1;
    readonly shard?: number;
  }[];
  readonly projectFacets: Readonly<Record<string, number>>;
  readonly projectIds: readonly string[];
  /** Semantic passages the release holds, before the project filter; empty unless hybrid search answered. */
  readonly semanticPassages: readonly SemanticPassage[];
}

/**
 * The config the release was written with (Spec 016): its revision's tokenizer and, from
 * `bm25-reference@2`, the community identifier profiles the publisher indexes with; at `@3`
 * (Spec 017) also its thread score and phrase bonus. A release of any other revision is not
 * answered (HTTP 503) rather than scored with the wrong tokens.
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
  outcome?: Promise<SemanticOutcome>,
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
  // Hybrid search ranks lexical threads to a fixed depth, so fusion reads the same lexical ranks
  // whatever `limit` the request has; lexical search keeps the request's limit, as before.
  const depth = { ...(request.filters === undefined ? {} : { filters: request.filters }), limit: outcome === undefined ? request.limit : HYBRID_LEXICAL_DEPTH };

  // The shard of each semantic match, known once the gate has answered (Behavior 27).
  const matchesByShard = outcome?.then((settled) => {
    const byShard = new Map<number, SemanticMatchV1[]>();
    for (const match of settled.status === "ok" ? settled.matches : []) {
      const shard = searchShardForGroupRoot(manifest, match.projectId, match.groupRootRecordId);
      if (shard === undefined) continue;
      byShard.set(shard, [...byShard.get(shard) ?? [], match]);
    }
    return byShard;
  });

  const kept: RankedRelease["results"][number][] = [];
  const projectFacets: Record<string, number> = {};
  const passages = new Map<string, SemanticPassage>();
  const done = new Set<number>();
  const pending = [...selected].sort((left, right) => left - right);
  const rankNext = async (): Promise<void> => {
    for (let shardNumber = pending.shift(); shardNumber !== undefined; shardNumber = pending.shift()) {
      done.add(shardNumber);
      const lexical = selected.has(shardNumber);
      const shard = await readSearchShardV2(bucket, manifest, shardNumber);
      // The read above overlapped the gate's answer; a shard is ranked, resolved, and released once.
      const matches = (await matchesByShard)?.get(shardNumber) ?? [];
      const groups = new Map(shard.groups.map((group) => [group.groupRootRecordId, group]));
      const eligibleGroupRootRecordIds = projectStatuses === undefined
        ? undefined
        : new Set(shard.groups
            .filter((group) => group.projectStatus !== undefined && projectStatuses.includes(group.projectStatus))
            .map((group) => group.groupRootRecordId));
      const threads = lexical ? rankLexicalShard(shard, corpus, {
        ...rankRequest,
        ...(eligibleGroupRootRecordIds === undefined ? {} : { eligibleGroupRootRecordIds }),
      }, config) : [];
      const ranked = selectLexicalResults(threads, depth);
      for (const [projectId, count] of Object.entries(ranked.projectFacets)) {
        projectFacets[projectId] = (projectFacets[projectId] ?? 0) + count;
      }
      for (const result of ranked.results) {
        const group = groups.get(result.groupRootRecordId);
        if (group === undefined) throw new Error(`Search result ${result.groupRootRecordId} has no group projection`);
        kept.push({ result, group, shard: shardNumber });
      }
      if (matches.length === 0) continue;

      // Behavior 22: a match counts only as the release's own chunk, with an equal fingerprint,
      // under the filters lexical chunks pass. The project filter waits, as it does for facets.
      const lexicalThreads = new Set(threads.map((thread) => thread.groupRootRecordId));
      const byPassage = new Map(shard.chunks.map((chunk) => [`${chunk.recordId}\u0000${chunk.ordinal}`, chunk]));
      for (const match of matches) {
        const chunk = byPassage.get(`${match.recordId}\u0000${match.ordinal}`);
        if (chunk === undefined || !(await acceptSemanticMatch(match, chunk, request.filters, eligibleGroupRootRecordIds, true))) continue;
        const group = groups.get(chunk.groupRootRecordId);
        const previous = passages.get(chunk.id);
        if (group === undefined || (previous !== undefined && previous.score >= match.score)) continue;
        passages.set(chunk.id, { chunk, score: match.score, group, shard: shardNumber, lexicalThread: lexicalThreads.has(chunk.groupRootRecordId) });
      }
    }
  };
  const drain = () => Promise.all(Array.from({ length: Math.min(SHARD_READ_CONCURRENCY, pending.length) }, rankNext));
  await drain();
  // Shards that hold a semantic match and none of the query's terms.
  pending.push(...[...((await matchesByShard)?.keys() ?? [])].filter((shard) => !done.has(shard)).sort((left, right) => left - right));
  await drain();

  const byRoot = new Map(kept.map((item) => [item.result.groupRootRecordId, item]));
  const { results } = selectLexicalResults(kept.map((item) => item.result), depth);
  return {
    results: results.map((result) => byRoot.get(result.groupRootRecordId)!),
    projectFacets,
    projectIds,
    semanticPassages: [...passages.values()],
  };
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
    semanticPassages: [],
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
