import { validateSearchFilters, type SearchFiltersV1 } from "./filters";
import type { SourceRecordChunkV1 } from "./golden-fixture";
import { compileIdentifierProfiles, type IdentifierProfilesV1 } from "./identifiers";

export const LEXICAL_INDEX_SCHEMA = "osskb.lexical-index.v1" as const;
/** The revision deployed releases declare; readers and the publisher still use only this one. */
export const DEFAULT_LEXICAL_REVISION = "bm25-reference@1";
/**
 * Spec 016: `bm25-reference@1` scoring over code-text tokens (camelCase and PascalCase words are
 * also indexed as their parts) and, when the config carries identifier profiles, normalized
 * community identifiers. Postings differ from `@1`, so a release declares one or the other.
 */
export const CODE_TEXT_LEXICAL_REVISION = "bm25-reference@2";

export interface LexicalSearchConfigV1 {
  readonly revision: string;
  readonly k1: number;
  readonly b: number;
  readonly titleWeight: number;
  readonly tagWeight: number;
  readonly exactBoost: number;
  readonly additionalGroupMatchWeight: number;
  readonly maxEvidenceMatches: number;
  readonly excerptCharacters: number;
  /** Community identifier patterns by project; only valid with `bm25-reference@2`. */
  readonly identifiers?: IdentifierProfilesV1;
}

export const defaultLexicalSearchConfig: LexicalSearchConfigV1 = {
  revision: DEFAULT_LEXICAL_REVISION,
  k1: 1.2,
  b: 0.75,
  titleWeight: 4,
  tagWeight: 2,
  exactBoost: 1_000,
  additionalGroupMatchWeight: 0.25,
  maxEvidenceMatches: 5,
  excerptCharacters: 280,
};

/** `bm25-reference@2` with the `@1` weights; add `identifiers` from the community profiles. */
export const codeTextLexicalSearchConfig: LexicalSearchConfigV1 = {
  ...defaultLexicalSearchConfig,
  revision: CODE_TEXT_LEXICAL_REVISION,
};

interface IndexedChunk {
  readonly chunk: SourceRecordChunkV1;
  readonly terms: ReadonlyMap<string, number>;
  readonly titleTerms: ReadonlySet<string>;
  readonly length: number;
}

export interface LexicalIndexV1 {
  readonly schema: typeof LEXICAL_INDEX_SCHEMA;
  readonly indexRevision: string;
  readonly lexicalRevision: string;
  readonly chunks: readonly SourceRecordChunkV1[];
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly averageDocumentLength: number;
  readonly config: LexicalSearchConfigV1;
  /** Internal immutable representation owned by this package. */
  readonly documents: readonly IndexedChunk[];
}

export interface LexicalSearchRequestV1 {
  readonly query: string;
  readonly filters?: SearchFiltersV1;
  /** Internal group eligibility computed from group-level project status metadata. */
  readonly eligibleGroupRootRecordIds?: ReadonlySet<string>;
  readonly limit?: number;
}

export type LexicalSearchFacetRequestV1 = Omit<LexicalSearchRequestV1, "limit">;

export interface LexicalEvidenceMatchV1 {
  readonly chunkId: string;
  readonly recordId: string;
  readonly excerpt: string;
  readonly canonicalUrl: string;
  readonly author: string;
  readonly occurredAt: string;
  readonly sourceVersion: string;
  readonly matchedTerms: readonly string[];
  readonly exactMatch: boolean;
  readonly score: number;
}

export interface LexicalSearchResultV1 {
  readonly groupRootRecordId: string;
  readonly projectId: string;
  readonly score: number;
  readonly exactMatch: boolean;
  readonly matches: readonly LexicalEvidenceMatchV1[];
}

export interface BuildLexicalIndexInputV1 {
  readonly indexRevision: string;
  readonly chunks: readonly SourceRecordChunkV1[];
  readonly config?: LexicalSearchConfigV1;
}

export function buildLexicalIndex(input: BuildLexicalIndexInputV1): LexicalIndexV1 {
  const config = input.config ?? defaultLexicalSearchConfig;
  validateConfig(config);

  const chunks = uniqueChunks(input.chunks);
  const documents = chunks.map((chunk) => indexChunk(chunk, config));
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of document.terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageDocumentLength = documents.length === 0
    ? 0
    : documents.reduce((total, document) => total + document.length, 0) /
      documents.length;

  return {
    schema: LEXICAL_INDEX_SCHEMA,
    indexRevision: requireText(input.indexRevision, "indexRevision"),
    lexicalRevision: config.revision,
    chunks,
    documentFrequency,
    averageDocumentLength,
    config,
    documents,
  };
}

export function searchLexicalIndex(
  index: LexicalIndexV1,
  request: LexicalSearchRequestV1,
): readonly LexicalSearchResultV1[] {
  const limit = request.limit ?? 20;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error("Search limit must be an integer between 1 and 100");
  }

  return rankLexicalIndex(index, request, false).slice(0, limit);
}

/** Counts matching groups before the project filter and result limit are applied. */
export function facetLexicalIndexByProject(
  index: LexicalIndexV1,
  request: LexicalSearchFacetRequestV1,
): Readonly<Record<string, number>> {
  const facets: Record<string, number> = {};
  for (const result of rankLexicalIndex(index, request, true)) {
    facets[result.projectId] = (facets[result.projectId] ?? 0) + 1;
  }
  return facets;
}

function rankLexicalIndex(
  index: LexicalIndexV1,
  request: LexicalSearchFacetRequestV1,
  ignoreProjectIds: boolean,
): readonly LexicalSearchResultV1[] {
  const rawQuery = requireText(request.query, "query");
  validateSearchFilters(request.filters);
  const query = lexicalAnalyzer(index.config).query(rawQuery);
  if (query.terms.length === 0) return [];

  const statistics: CorpusStatistics = {
    chunkCount: index.documents.length,
    averageDocumentLength: index.averageDocumentLength,
    documentFrequency: (term) => index.documentFrequency.get(term) ?? 0,
  };
  const scored = index.documents
    .filter((document) => chunkMatchesSearchFilters(
      document.chunk,
      request.filters,
      request.eligibleGroupRootRecordIds,
      ignoreProjectIds,
    ))
    .map((document) => scoreDocument(statistics, index.config, {
      chunk: document.chunk,
      length: document.length,
      frequency: (term) => document.terms.get(term),
      titleTerms: () => document.titleTerms,
    }, query))
    .filter((result): result is ScoredDocument => result !== undefined);

  return assembleGroups(index.config, scored).sort(compareLexicalResults);
}

function assembleGroups(
  config: LexicalSearchConfigV1,
  scored: readonly ScoredDocument[],
): LexicalSearchResultV1[] {
  const byGroup = new Map<string, ScoredDocument[]>();
  for (const result of scored) {
    const group = byGroup.get(result.document.chunk.groupRootRecordId) ?? [];
    group.push(result);
    byGroup.set(result.document.chunk.groupRootRecordId, group);
  }
  return [...byGroup.entries()]
    .map(([groupRootRecordId, documents]) => assembleGroup(config, groupRootRecordId, documents));
}

/** The `bm25-reference@1` result order: exact matches, then score, then group root. */
export function compareLexicalResults(left: LexicalSearchResultV1, right: LexicalSearchResultV1): number {
  return Number(right.exactMatch) - Number(left.exactMatch) ||
    right.score - left.score ||
    left.groupRootRecordId.localeCompare(right.groupRootRecordId);
}

/** BM25 inputs stored with a lexical shard so a query need not tokenize the corpus (Spec 013). */
export interface LexicalShardPostingsV1 {
  /** Weighted token count of each chunk, in chunk order. */
  readonly lengths: readonly number[];
  /** term -> [chunk index, term frequency, chunk index, term frequency, …], chunk indexes ascending. */
  readonly postings: Readonly<Record<string, readonly number[]>>;
}

export interface LexicalShardV1 extends LexicalShardPostingsV1 {
  readonly chunks: readonly SourceRecordChunkV1[];
}

/** Corpus-wide statistics a shard is scored with; they span every shard of the release. */
export interface LexicalCorpusStatsV1 {
  readonly chunkCount: number;
  readonly totalChunkLength: number;
  readonly documentFrequency: (term: string) => number;
}

/** Computes a shard's postings with the same weighted tokens as `buildLexicalIndex`. */
export function lexicalShardPostings(
  chunks: readonly SourceRecordChunkV1[],
  config: LexicalSearchConfigV1 = defaultLexicalSearchConfig,
): LexicalShardPostingsV1 {
  validateConfig(config);
  const lengths: number[] = [];
  const postings = new Map<string, number[]>();
  chunks.forEach((chunk, chunkIndex) => {
    const { terms, length } = chunkTerms(chunk, config);
    lengths.push(length);
    for (const [term, frequency] of terms) {
      const list = postings.get(term);
      if (list === undefined) postings.set(term, [chunkIndex, frequency]);
      else list.push(chunkIndex, frequency);
    }
  });
  // fromEntries defines own properties, so "__proto__" stays an ordinary term.
  return { lengths, postings: Object.fromEntries(postings) };
}

/**
 * Ranks one shard's matching groups with corpus-wide statistics. The project filter is not
 * applied, so the same pass also yields project facets; `selectLexicalResults` applies it.
 * Every chunk of a group must be in the same shard.
 */
export function rankLexicalShard(
  shard: LexicalShardV1,
  corpus: LexicalCorpusStatsV1,
  request: LexicalSearchFacetRequestV1,
  config: LexicalSearchConfigV1 = defaultLexicalSearchConfig,
): readonly LexicalSearchResultV1[] {
  const rawQuery = requireText(request.query, "query");
  validateSearchFilters(request.filters);
  validateConfig(config);
  const analyzer = lexicalAnalyzer(config);
  const query = analyzer.query(rawQuery);
  if (query.terms.length === 0) return [];

  const frequencies = new Map<number, Map<string, number>>();
  for (const term of query.terms) {
    if (!Object.hasOwn(shard.postings, term)) continue;
    const list = shard.postings[term]!;
    for (let position = 0; position + 1 < list.length; position += 2) {
      const chunkIndex = list[position]!;
      const terms = frequencies.get(chunkIndex) ?? new Map<string, number>();
      terms.set(term, list[position + 1]!);
      frequencies.set(chunkIndex, terms);
    }
  }
  const statistics: CorpusStatistics = {
    chunkCount: corpus.chunkCount,
    averageDocumentLength: corpus.chunkCount === 0 ? 0 : corpus.totalChunkLength / corpus.chunkCount,
    documentFrequency: corpus.documentFrequency,
  };
  const scored: ScoredDocument[] = [];
  for (const [chunkIndex, terms] of frequencies) {
    const chunk = shard.chunks[chunkIndex];
    const length = shard.lengths[chunkIndex];
    if (chunk === undefined || length === undefined) throw new Error(`Lexical shard has no chunk ${chunkIndex}`);
    if (!chunkMatchesSearchFilters(chunk, request.filters, request.eligibleGroupRootRecordIds, true)) continue;
    const result = scoreDocument(statistics, config, {
      chunk,
      length,
      frequency: (term) => terms.get(term),
      titleTerms: () => new Set(analyzer.titleTokens(chunk)),
    }, query);
    if (result !== undefined) scored.push(result);
  }
  return assembleGroups(config, scored);
}

/** Applies the project filter and limit to every shard's groups, and counts project facets. */
export function selectLexicalResults(
  groups: readonly LexicalSearchResultV1[],
  request: { readonly filters?: SearchFiltersV1; readonly limit?: number },
): { readonly results: readonly LexicalSearchResultV1[]; readonly projectFacets: Readonly<Record<string, number>> } {
  const limit = request.limit ?? 20;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error("Search limit must be an integer between 1 and 100");
  }
  const projectFacets: Record<string, number> = {};
  for (const group of groups) projectFacets[group.projectId] = (projectFacets[group.projectId] ?? 0) + 1;
  const projectIds = request.filters?.projectIds;
  const results = groups
    .filter((group) => projectIds === undefined || projectIds.includes(group.projectId))
    .sort(compareLexicalResults)
    .slice(0, limit);
  return { results, projectFacets };
}

/** The `bm25-reference@1` tokenizer. Deployed shards and their readers depend on its exact output. */
export function tokenizeLexical(value: string): readonly string[] {
  return tokenize(value, false);
}

/**
 * The tokenizer a lexical revision indexes and queries with. `bm25-reference@2` adds the parts of
 * camelCase and PascalCase words after the token they come from; every other revision is `@1`.
 */
export function lexicalTokenizer(revision: string): (value: string) => readonly string[] {
  return revision === CODE_TEXT_LEXICAL_REVISION ? (value) => tokenize(value, true) : tokenizeLexical;
}

/** The distinct terms a query selects postings with, after identifier normalization. */
export function lexicalQueryTerms(
  query: string,
  config: LexicalSearchConfigV1 = defaultLexicalSearchConfig,
): readonly string[] {
  validateConfig(config);
  return lexicalAnalyzer(config).query(query).terms;
}

function tokenize(value: string, splitCase: boolean): readonly string[] {
  const tokens = value
    .normalize("NFKC")
    .match(
      /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?|[\p{L}\p{N}_$]+(?:-[\p{L}\p{N}_$]+)*/gu,
    ) ?? [];
  const result: string[] = [];
  for (const raw of tokens) {
    const token = raw.toLocaleLowerCase("en-US");
    result.push(token);
    if (token.includes(".")) {
      result.push(...token.replace(/\(\)$/u, "").split("."));
    }
    if (token.includes("-")) result.push(...token.split("-"));
    if (splitCase) {
      for (const part of raw.replace(/\(\)$/u, "").split(/[.-]/u)) {
        const words = caseWords(part);
        if (words.length > 1) result.push(...words.map((word) => word.toLocaleLowerCase("en-US")));
      }
    }
  }
  return result.filter((token) => token.length > 0);
}

/**
 * Splits `HeartbeatRequestManager` into its words and `HTTPServer` into `HTTP`, `Server`. A
 * single letter stays with its neighbour (`KRaft`, `IDs`), so no one-letter term is indexed.
 */
function caseWords(part: string): readonly string[] {
  const pieces = part.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u);
  const words: string[] = [];
  let carried = "";
  for (const piece of pieces) {
    const word = carried + piece;
    if ([...word].length === 1) {
      carried = word;
    } else {
      words.push(word);
      carried = "";
    }
  }
  if (carried.length > 0) {
    if (words.length === 0) words.push(carried);
    else words[words.length - 1] += carried;
  }
  return words;
}

export function isExactStructuredQuery(query: string): boolean {
  const trimmed = query.trim();
  return /^[A-Z][A-Z0-9]+-\d+$/u.test(trimmed) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/u.test(trimmed);
}

/** A query after tokenization: its distinct terms and how a chunk matches it exactly, if it can. */
interface AnalyzedQuery {
  readonly terms: readonly string[];
  readonly exact?: (document: ScoringDocument) => boolean;
}

interface LexicalAnalyzer {
  readonly tokenize: (value: string) => readonly string[];
  /** Title tokens, followed by the identifiers a profile recognizes in the title or record id. */
  readonly titleTokens: (chunk: SourceRecordChunkV1) => readonly string[];
  readonly query: (query: string) => AnalyzedQuery;
}

function lexicalAnalyzer(config: LexicalSearchConfigV1): LexicalAnalyzer {
  const tokenizeText = lexicalTokenizer(config.revision);
  const profiles = config.identifiers === undefined ? undefined : compileIdentifierProfiles(config.identifiers);
  const structured = (query: string): AnalyzedQuery["exact"] => {
    if (!isExactStructuredQuery(query)) return undefined;
    const normalized = query.trim().toLocaleLowerCase("en-US");
    if (/^[a-z][a-z0-9]+-\d+$/u.test(normalized)) return (document) => document.titleTerms().has(normalized);
    return (document) =>
      document.chunk.title.toLocaleLowerCase("en-US").includes(normalized) ||
      document.chunk.text.toLocaleLowerCase("en-US").includes(normalized);
  };
  if (profiles === undefined) {
    return {
      tokenize: tokenizeText,
      titleTokens: (chunk) => tokenizeText(chunk.title),
      query: (query) => {
        const exact = structured(query);
        return { terms: [...new Set(tokenizeText(query))], ...(exact === undefined ? {} : { exact }) };
      },
    };
  }
  return {
    tokenize: tokenizeText,
    titleTokens: (chunk) => {
      const tokens = [...tokenizeText(chunk.title)];
      const seen = new Set(tokens);
      for (const identifier of profiles.identifiersOf(chunk.projectId, chunk.title, chunk.recordId)) {
        // The canonical spelling is indexed even when the title wrote another one, or none.
        for (const token of [identifier, ...tokenizeText(identifier)]) {
          if (seen.has(token)) continue;
          seen.add(token);
          tokens.push(token);
        }
      }
      return tokens;
    },
    query: (query) => {
      const canonical = profiles.canonicalizeQuery(query).trim();
      const terms = [...new Set(tokenizeText(canonical))];
      const lowered = canonical.toLocaleLowerCase("en-US");
      if (/^\d+$/u.test(canonical)) {
        // A bare number names every identifier with that number, in every project (R1).
        return {
          terms,
          exact: (document) => profiles.numberCandidates(document.chunk.projectId, canonical)
            .some((identifier) => document.titleTerms().has(identifier)),
        };
      }
      if (profiles.isCanonical(lowered)) {
        return { terms: [...new Set([lowered, ...terms])], exact: (document) => document.titleTerms().has(lowered) };
      }
      const exact = structured(canonical);
      return { terms, ...(exact === undefined ? {} : { exact }) };
    },
  };
}

interface ScoringDocument {
  readonly chunk: SourceRecordChunkV1;
  readonly length: number;
  readonly frequency: (term: string) => number | undefined;
  readonly titleTerms: () => ReadonlySet<string>;
}

/** Corpus-wide BM25 statistics; per-shard values would change IDF and therefore ranking. */
interface CorpusStatistics {
  readonly chunkCount: number;
  readonly averageDocumentLength: number;
  readonly documentFrequency: (term: string) => number;
}

interface ScoredDocument {
  readonly document: ScoringDocument;
  readonly score: number;
  readonly exactMatch: boolean;
  readonly matchedTerms: readonly string[];
}

function scoreDocument(
  statistics: CorpusStatistics,
  config: LexicalSearchConfigV1,
  document: ScoringDocument,
  query: AnalyzedQuery,
): ScoredDocument | undefined {
  const matchedTerms = query.terms.filter((term) => document.frequency(term) !== undefined);
  if (matchedTerms.length === 0) return undefined;

  let score = 0;
  for (const term of matchedTerms) {
    const frequency = document.frequency(term) ?? 0;
    const documentFrequency = statistics.documentFrequency(term);
    const idf = Math.log(
      1 +
        (statistics.chunkCount - documentFrequency + 0.5) /
          (documentFrequency + 0.5),
    );
    const normalization = statistics.averageDocumentLength === 0
      ? 1
      : 1 - config.b +
        config.b * (document.length / statistics.averageDocumentLength);
    score += idf * ((frequency * (config.k1 + 1)) /
      (frequency + config.k1 * normalization));
  }

  const exactMatch = query.exact?.(document) ?? false;
  if (exactMatch) score += config.exactBoost;
  return { document, score, exactMatch, matchedTerms };
}

function assembleGroup(
  config: LexicalSearchConfigV1,
  groupRootRecordId: string,
  documents: readonly ScoredDocument[],
): LexicalSearchResultV1 {
  const ordered = [...documents].sort(
    (left, right) =>
      Number(right.exactMatch) - Number(left.exactMatch) ||
      right.score - left.score ||
      left.document.chunk.id.localeCompare(right.document.chunk.id),
  );
  const [best, ...additional] = ordered;
  if (best === undefined) throw new Error("Cannot assemble an empty search group");
  const score = best.score +
    additional.reduce((total, result) => total + result.score, 0) *
      config.additionalGroupMatchWeight;

  return {
    groupRootRecordId,
    projectId: best.document.chunk.projectId,
    score,
    exactMatch: ordered.some((result) => result.exactMatch),
    matches: ordered.slice(0, config.maxEvidenceMatches).map((result) => ({
      chunkId: result.document.chunk.id,
      recordId: result.document.chunk.recordId,
      excerpt: matchedExcerpt(
        result.document.chunk.text,
        result.matchedTerms,
        config.excerptCharacters,
      ),
      canonicalUrl: result.document.chunk.canonicalUrl,
      author: result.document.chunk.author,
      occurredAt: result.document.chunk.occurredAt,
      sourceVersion: result.document.chunk.sourceVersion,
      matchedTerms: result.matchedTerms,
      exactMatch: result.exactMatch,
      score: result.score,
    })),
  };
}

function indexChunk(
  chunk: SourceRecordChunkV1,
  config: LexicalSearchConfigV1,
): IndexedChunk {
  const { terms, length, titleTokens } = chunkTerms(chunk, config);
  return { chunk, terms, titleTerms: new Set(titleTokens), length };
}

function chunkTerms(
  chunk: SourceRecordChunkV1,
  config: LexicalSearchConfigV1,
): { readonly terms: ReadonlyMap<string, number>; readonly length: number; readonly titleTokens: readonly string[] } {
  const analyzer = lexicalAnalyzer(config);
  const titleTokens = analyzer.titleTokens(chunk);
  const bodyTokens = analyzer.tokenize(chunk.text);
  const tagTokens = chunk.tags.flatMap((tag) => analyzer.tokenize(tag));
  const authorTokens = analyzer.tokenize(chunk.author);
  const weightedTokens = [
    ...repeat(titleTokens, config.titleWeight),
    ...bodyTokens,
    ...repeat(tagTokens, config.tagWeight),
    ...authorTokens,
  ];
  const terms = new Map<string, number>();
  for (const term of weightedTokens) terms.set(term, (terms.get(term) ?? 0) + 1);
  return { terms, length: weightedTokens.length, titleTokens };
}

function repeat(values: readonly string[], weight: number): readonly string[] {
  if (!Number.isInteger(weight) || weight < 1) {
    throw new Error("Lexical field weights must be positive integers");
  }
  return Array.from({ length: weight }, () => values).flat();
}

function matchedExcerpt(
  text: string,
  matchedTerms: readonly string[],
  maximumCharacters: number,
): string {
  const normalized = text.toLocaleLowerCase("en-US");
  const positions = matchedTerms
    .map((term) => normalized.indexOf(term))
    .filter((position) => position >= 0);
  const first = positions.length === 0 ? 0 : Math.min(...positions);
  const start = Math.max(0, first - Math.floor(maximumCharacters / 3));
  const end = Math.min(text.length, start + maximumCharacters);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Whether one chunk passes the evidence filters; `ignoreProjectIds` is for project facets. */
export function chunkMatchesSearchFilters(
  chunk: SourceRecordChunkV1,
  filters: SearchFiltersV1 | undefined,
  eligibleGroupRootRecordIds: ReadonlySet<string> | undefined,
  ignoreProjectIds: boolean,
): boolean {
  if (
    eligibleGroupRootRecordIds !== undefined &&
    !eligibleGroupRootRecordIds.has(chunk.groupRootRecordId)
  ) return false;
  if (filters === undefined) return true;
  if (
    !ignoreProjectIds &&
    filters.projectIds !== undefined &&
    !filters.projectIds.includes(chunk.projectId)
  ) return false;
  if (
    filters.sourceInstanceIds !== undefined &&
    !filters.sourceInstanceIds.includes(chunk.sourceInstanceId)
  ) return false;
  if (
    filters.tags !== undefined &&
    !filters.tags.every((tag) => chunk.tags.includes(tag))
  ) return false;
  const occurredAt = Date.parse(chunk.occurredAt);
  if (
    filters.occurredAfter !== undefined &&
    occurredAt <= Date.parse(filters.occurredAfter)
  ) return false;
  if (
    filters.occurredBefore !== undefined &&
    occurredAt >= Date.parse(filters.occurredBefore)
  ) return false;
  return true;
}

function uniqueChunks(
  chunks: readonly SourceRecordChunkV1[],
): readonly SourceRecordChunkV1[] {
  const byId = new Map<string, SourceRecordChunkV1>();
  for (const chunk of chunks) {
    const previous = byId.get(chunk.id);
    if (previous !== undefined && previous.contentHash !== chunk.contentHash) {
      throw new Error(`Conflicting chunks share id ${chunk.id}`);
    }
    if (previous === undefined) byId.set(chunk.id, chunk);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function validateConfig(config: LexicalSearchConfigV1): void {
  requireText(config.revision, "config.revision");
  if (config.identifiers !== undefined) {
    if (config.revision !== CODE_TEXT_LEXICAL_REVISION) {
      throw new Error(`Identifier profiles require ${CODE_TEXT_LEXICAL_REVISION}, not ${config.revision}`);
    }
    compileIdentifierProfiles(config.identifiers);
  }
  if (config.k1 <= 0) throw new Error("BM25 k1 must be positive");
  if (config.b < 0 || config.b > 1) throw new Error("BM25 b must be between 0 and 1");
  if (config.exactBoost <= 0) throw new Error("exactBoost must be positive");
  if (config.additionalGroupMatchWeight < 0) {
    throw new Error("additionalGroupMatchWeight must not be negative");
  }
  if (!Number.isInteger(config.maxEvidenceMatches) || config.maxEvidenceMatches <= 0) {
    throw new Error("maxEvidenceMatches must be a positive integer");
  }
  if (!Number.isInteger(config.excerptCharacters) || config.excerptCharacters < 40) {
    throw new Error("excerptCharacters must be an integer of at least 40");
  }
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  return trimmed;
}
