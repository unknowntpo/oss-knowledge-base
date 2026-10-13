import type { SearchFiltersV1 } from "./filters";
import type { LexicalSearchResultV1 } from "./lexical-search";
import type { SemanticCandidateV1, SemanticRetriever } from "./semantic";

/** Reciprocal-rank fusion of group rankings, exact identifier matches first (Spec 016 Behavior 8). */
export const DEFAULT_FUSION_REVISION = "rrf-group@1";
/** `rrf-group@1` below the leading full lexical matches, which keep their places (Spec 016 Behavior 38). */
export const LEADING_FULL_MATCH_FUSION_REVISION = "rrf-group@2";
/** `rrf-group@2`, and only a semantic standout may pass the first lexical threads (Spec 016 Behavior 43). */
export const LEXICAL_HEAD_FUSION_REVISION = "rrf-group@3";
export const DEFAULT_SEMANTIC_TIMEOUT_MS = 1_000;

/** `rrf-group@3`: which lexical threads are the head, and which semantic threads stand out. */
export interface LexicalHeadConfigV1 {
  /** The lexical threads at ranks 1 to `threads` are the head. */
  readonly threads: number;
  /** The semantic thread at this rank gives the query's background similarity (the last one, when there are fewer). */
  readonly reference: number;
  /** A semantic thread stands out when its similarity is at least this far above the background. */
  readonly margin: number;
}

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
  /**
   * `rrf-group@3`: a head thread is preceded only by threads lexical search ranks above it and by
   * semantic standouts. A thread semantic retrieval did not return, or returned without standing
   * out, is missing evidence about the head, not evidence against it. Absent: no thread is moved.
   */
  readonly lexicalHead?: LexicalHeadConfigV1;
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

export const lexicalHeadFusionConfig: FusionConfigV1 = {
  ...leadingFullMatchFusionConfig,
  revision: LEXICAL_HEAD_FUSION_REVISION,
  lexicalHead: { threads: 3, reference: 20, margin: 0.04 },
};

export const SUPPORTED_FUSION_REVISIONS: readonly string[] = [DEFAULT_FUSION_REVISION, LEADING_FULL_MATCH_FUSION_REVISION, LEXICAL_HEAD_FUSION_REVISION];

/** The config of a fusion revision this code can run, or `undefined` for any other name. */
export function fusionConfigFor(revision: string): FusionConfigV1 | undefined {
  if (revision === DEFAULT_FUSION_REVISION) return defaultFusionConfig;
  if (revision === LEADING_FULL_MATCH_FUSION_REVISION) return leadingFullMatchFusionConfig;
  if (revision === LEXICAL_HEAD_FUSION_REVISION) return lexicalHeadFusionConfig;
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
  const head = config.lexicalHead;
  if (head !== undefined && !(Number.isInteger(head.threads) && head.threads > 0 && Number.isInteger(head.reference) && head.reference > 0 && head.margin > 0)) {
    throw new Error("lexicalHead needs positive integer threads and reference, and a positive margin");
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
  const ordered = [...groups.values()]
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
      left.group.groupRootRecordId.localeCompare(right.group.groupRootRecordId));
  return (head === undefined ? ordered : protectLexicalHead(ordered, head))
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

/**
 * `rrf-group@3`. A semantic thread stands out when the similarity of its best passage is at least
 * `margin` above the background: the similarity of the semantic thread at rank `reference`. The
 * fused order is walked once; before a thread that does not stand out, every head thread that
 * lexical search ranks above it (or any head thread, when it has no lexical rank) is placed.
 * Exact matches are never preceded. A similarity that is not a finite number never stands out.
 */
function protectLexicalHead<Item extends {
  readonly exactMatch: boolean;
  readonly group: { readonly lexicalRank?: number; readonly semanticRank?: number; readonly semanticMatches: readonly SemanticCandidateV1[] };
}>(ordered: readonly Item[], head: LexicalHeadConfigV1): readonly Item[] {
  const semantic = ordered.filter((item) => item.group.semanticRank !== undefined).sort((left, right) => left.group.semanticRank! - right.group.semanticRank!);
  const background = semantic[Math.min(head.reference, semantic.length) - 1]?.group.semanticMatches[0]?.score;
  const standsOut = (item: Item) => {
    const score = item.group.semanticMatches[0]?.score;
    return typeof score === "number" && typeof background === "number" && Number.isFinite(score) && Number.isFinite(background) && score - background >= head.margin;
  };
  const protectedThreads = ordered.filter((item) => item.group.lexicalRank !== undefined && item.group.lexicalRank <= head.threads)
    .sort((left, right) => left.group.lexicalRank! - right.group.lexicalRank!);
  const placed = new Set<Item>();
  const result: Item[] = [];
  const place = (item: Item) => {
    if (placed.has(item)) return;
    placed.add(item);
    result.push(item);
  };
  for (const item of ordered) {
    if (!item.exactMatch && !standsOut(item)) {
      for (const thread of protectedThreads) {
        if (item.group.lexicalRank === undefined || thread.group.lexicalRank! < item.group.lexicalRank) place(thread);
      }
    }
    place(item);
  }
  return result;
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
