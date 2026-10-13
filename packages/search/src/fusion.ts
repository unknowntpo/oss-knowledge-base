import type { SearchFiltersV1 } from "./filters";
import type { LexicalSearchResultV1 } from "./lexical-search";
import type { SemanticCandidateV1, SemanticRetriever } from "./semantic";

/** Reciprocal-rank fusion of group rankings, exact identifier matches first (Spec 016 Behavior 8). */
export const DEFAULT_FUSION_REVISION = "rrf-group@1";
/** `rrf-group@1` below the leading full lexical matches, which keep their places (Spec 016 Behavior 38). */
export const LEADING_FULL_MATCH_FUSION_REVISION = "rrf-group@2";
export const DEFAULT_SEMANTIC_TIMEOUT_MS = 1_000;

export interface FusionConfigV1 {
  readonly revision: string;
  /** The RRF constant: a group at rank r adds 1 / (k + r). */
  readonly k: number;
  /** Semantic passages kept per group as evidence. */
  readonly maxSemanticMatches: number;
  /**
   * `rrf-group@2`: a lexical group is a full match when one of its returned passages matched every
   * word of the query. The full matches that lead the lexical ranking, up to its first group that
   * is not one, keep their lexical places; every other group follows in score order. Needs
   * `queryWords`. Absent: `rrf-group@1`, where only the score decides.
   */
  readonly keepLeadingFullMatches?: true;
}

export const defaultFusionConfig: FusionConfigV1 = {
  revision: DEFAULT_FUSION_REVISION,
  k: 60,
  maxSemanticMatches: 5,
};

export const leadingFullMatchFusionConfig: FusionConfigV1 = {
  ...defaultFusionConfig,
  revision: LEADING_FULL_MATCH_FUSION_REVISION,
  keepLeadingFullMatches: true,
};

export const SUPPORTED_FUSION_REVISIONS: readonly string[] = [DEFAULT_FUSION_REVISION, LEADING_FULL_MATCH_FUSION_REVISION];

/** The config of a fusion revision this code can run, or `undefined` for any other name. */
export function fusionConfigFor(revision: string): FusionConfigV1 | undefined {
  if (revision === DEFAULT_FUSION_REVISION) return defaultFusionConfig;
  if (revision === LEADING_FULL_MATCH_FUSION_REVISION) return leadingFullMatchFusionConfig;
  return undefined;
}

export interface FusedSearchResultV1 {
  readonly groupRootRecordId: string;
  readonly projectId: string;
  /** True only for a lexical exact identifier or symbol match. */
  readonly exactMatch: boolean;
  /** Sum of 1 / (k + rank) over the retrievers that returned the group. */
  readonly score: number;
  readonly signals: {
    readonly lexicalRank?: number;
    readonly semanticRank?: number;
    readonly fusedRank: number;
  };
  /** Present when lexical retrieval returned the group; carries its excerpts. */
  readonly lexical?: LexicalSearchResultV1;
  /** The group's semantic passages, best first; empty when only lexical retrieval returned it. */
  readonly semanticMatches: readonly SemanticCandidateV1[];
}

export interface FuseRankingsInputV1 {
  /** Lexical groups, best first. */
  readonly lexical: readonly LexicalSearchResultV1[];
  /** Semantic chunks, best first; a group takes the rank of its first chunk. */
  readonly semantic: readonly SemanticCandidateV1[];
  readonly config?: FusionConfigV1;
  /**
   * The distinct words of the query (`lexicalQueryWords`). Read only by a config with
   * `keepLeadingFullMatches`, which requires it; with no word no group is a full match.
   */
  readonly queryWords?: readonly string[];
}

/** Whether one returned passage of a lexical group matched every word of the query. */
export function isFullLexicalMatch(result: LexicalSearchResultV1, queryWords: readonly string[]): boolean {
  if (queryWords.length === 0) return false;
  return result.matches.some((match) => queryWords.every((word) => match.matchedTerms.includes(word)));
}

/**
 * How many groups at the head of a lexical ranking are full matches: the length of its longest
 * prefix in which every group is one.
 */
export function leadingFullMatches(lexical: readonly LexicalSearchResultV1[], queryWords: readonly string[]): number {
  const first = lexical.findIndex((result) => !isFullLexicalMatch(result, queryWords));
  return first < 0 ? lexical.length : first;
}

/**
 * Pure: the same rankings always fuse to the same list. With no semantic candidates the result
 * keeps the lexical order under every revision, so a failed semantic retriever cannot reorder
 * lexical results.
 */
export function fuseRankings(input: FuseRankingsInputV1): readonly FusedSearchResultV1[] {
  const config = input.config ?? defaultFusionConfig;
  if (config.revision.trim().length === 0) throw new Error("Fusion revision must not be empty");
  if (!(config.k > 0)) throw new Error("RRF k must be positive");
  if (!Number.isInteger(config.maxSemanticMatches) || config.maxSemanticMatches <= 0) {
    throw new Error("maxSemanticMatches must be a positive integer");
  }
  if (config.keepLeadingFullMatches === true && input.queryWords === undefined) {
    throw new Error(`Fusion ${config.revision} needs the query's words`);
  }
  const kept = config.keepLeadingFullMatches === true ? leadingFullMatches(input.lexical, input.queryWords!) : 0;

  interface Fused {
    groupRootRecordId: string;
    projectId: string;
    lexicalRank?: number;
    semanticRank?: number;
    lexical?: LexicalSearchResultV1;
    semanticMatches: SemanticCandidateV1[];
  }
  const groups = new Map<string, Fused>();
  input.lexical.forEach((result, index) => {
    if (groups.has(result.groupRootRecordId)) {
      throw new Error(`Lexical ranking repeats group ${result.groupRootRecordId}`);
    }
    groups.set(result.groupRootRecordId, {
      groupRootRecordId: result.groupRootRecordId,
      projectId: result.projectId,
      lexicalRank: index + 1,
      lexical: result,
      semanticMatches: [],
    });
  });
  let semanticGroups = 0;
  const seenChunks = new Set<string>();
  for (const candidate of input.semantic) {
    if (seenChunks.has(candidate.chunkId)) continue;
    seenChunks.add(candidate.chunkId);
    const group = groups.get(candidate.groupRootRecordId) ?? {
      groupRootRecordId: candidate.groupRootRecordId,
      projectId: candidate.projectId,
      semanticMatches: [],
    };
    if (group.projectId !== candidate.projectId) {
      throw new Error(`Group ${candidate.groupRootRecordId} is in ${group.projectId} and ${candidate.projectId}`);
    }
    if (group.semanticRank === undefined) {
      semanticGroups += 1;
      group.semanticRank = semanticGroups;
    }
    if (group.semanticMatches.length < config.maxSemanticMatches) group.semanticMatches.push(candidate);
    groups.set(candidate.groupRootRecordId, group);
  }

  const contribution = (rank: number | undefined) => rank === undefined ? 0 : 1 / (config.k + rank);
  return [...groups.values()]
    .map((group) => ({
      group,
      exactMatch: group.lexical?.exactMatch ?? false,
      kept: group.lexicalRank !== undefined && group.lexicalRank <= kept,
      score: contribution(group.lexicalRank) + contribution(group.semanticRank),
    }))
    .sort((left, right) =>
      Number(right.exactMatch) - Number(left.exactMatch) ||
      // `rrf-group@2`: the leading full matches are never demoted, and keep the lexical order.
      Number(right.kept) - Number(left.kept) ||
      (left.kept && right.kept ? left.group.lexicalRank! - right.group.lexicalRank! : 0) ||
      right.score - left.score ||
      // Equal scores: the lexical order decides before the id, so passthrough keeps lexical ties.
      (left.group.lexicalRank ?? Infinity) - (right.group.lexicalRank ?? Infinity) ||
      left.group.groupRootRecordId.localeCompare(right.group.groupRootRecordId))
    .map(({ group, exactMatch, score }, index) => ({
      groupRootRecordId: group.groupRootRecordId,
      projectId: group.projectId,
      exactMatch,
      score,
      signals: {
        ...(group.lexicalRank === undefined ? {} : { lexicalRank: group.lexicalRank }),
        ...(group.semanticRank === undefined ? {} : { semanticRank: group.semanticRank }),
        fusedRank: index + 1,
      },
      ...(group.lexical === undefined ? {} : { lexical: group.lexical }),
      semanticMatches: group.semanticMatches,
    }));
}

/** Why a response is or is not hybrid; `ok` is the only state with a `semanticRevision`. */
export type SemanticStatusV1 = "ok" | "disabled" | "failed" | "timed-out";

export interface HybridSearchInputV1 {
  readonly query: string;
  readonly filters?: SearchFiltersV1;
  readonly eligibleGroupRootRecordIds?: ReadonlySet<string>;
  /** Lexical groups, best first, to the candidate depth the caller retrieved. */
  readonly lexical: readonly LexicalSearchResultV1[];
  /** Absent when semantic retrieval is disabled. */
  readonly semantic?: SemanticRetriever;
  readonly limit?: number;
  /** Semantic chunk candidates requested. */
  readonly semanticDepth?: number;
  readonly timeoutMs?: number;
  readonly config?: FusionConfigV1;
  /** Passed to `fuseRankings`: required by a config with `keepLeadingFullMatches`. */
  readonly queryWords?: readonly string[];
}

export interface HybridSearchOutputV1 {
  readonly results: readonly FusedSearchResultV1[];
  readonly retrieval: {
    readonly fusionRevision: string;
    readonly semanticRevision?: string;
    readonly semantic: SemanticStatusV1;
    /** The retriever's error message when `semantic` is `failed`. */
    readonly semanticError?: string;
  };
}

/**
 * Fuses lexical results with a semantic retriever's candidates. When the retriever is absent,
 * throws, returns a malformed answer, or does not answer within `timeoutMs`, the lexical results
 * pass through in their own order and `retrieval.semantic` says why.
 */
export async function hybridSearch(input: HybridSearchInputV1): Promise<HybridSearchOutputV1> {
  const config = input.config ?? defaultFusionConfig;
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error("Search limit must be an integer between 1 and 100");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS;
  if (!(timeoutMs > 0)) throw new Error("Semantic timeout must be positive");
  const semanticDepth = input.semanticDepth ?? 50;
  if (!Number.isInteger(semanticDepth) || semanticDepth <= 0) {
    throw new Error("Semantic depth must be a positive integer");
  }

  const queryWords = input.queryWords === undefined ? {} : { queryWords: input.queryWords };
  const lexicalOnly = (semantic: Exclude<SemanticStatusV1, "ok">, semanticError?: string): HybridSearchOutputV1 => ({
    results: fuseRankings({ lexical: input.lexical, semantic: [], config, ...queryWords }).slice(0, limit),
    retrieval: {
      fusionRevision: config.revision,
      semantic,
      ...(semanticError === undefined ? {} : { semanticError }),
    },
  });
  if (input.semantic === undefined) return lexicalOnly("disabled");

  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timed-out");
  try {
    const retrieval = await Promise.race([
      input.semantic.retrieve({
        query: input.query,
        ...(input.filters === undefined ? {} : { filters: input.filters }),
        limit: semanticDepth,
        signal: abort.signal,
      }),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (retrieval === timedOut) {
      abort.abort();
      return lexicalOnly("timed-out");
    }
    const semanticRevision = retrieval?.semanticRevision;
    if (typeof semanticRevision !== "string" || semanticRevision.length === 0 || !Array.isArray(retrieval.candidates)) {
      return lexicalOnly("failed", "Semantic retriever returned a malformed answer");
    }
    const projectIds = input.filters?.projectIds;
    const eligible = input.eligibleGroupRootRecordIds;
    const candidates = retrieval.candidates.filter((candidate) =>
      (projectIds === undefined || projectIds.includes(candidate.projectId)) &&
      (eligible === undefined || eligible.has(candidate.groupRootRecordId)));
    return {
      results: fuseRankings({ lexical: input.lexical, semantic: candidates, config, ...queryWords }).slice(0, limit),
      retrieval: { fusionRevision: config.revision, semanticRevision, semantic: "ok" },
    };
  } catch (error) {
    return lexicalOnly("failed", error instanceof Error ? error.message : String(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
