import type { SearchFiltersV1 } from "./filters";
import type { SourceRecordChunkV1 } from "./golden-fixture";
import { chunkMatchesSearchFilters } from "./lexical-search";

/**
 * What produced a set of vectors (Spec 016 Behavior 6). Vectors of two different revisions are
 * never compared: a change to any field invalidates every stored vector.
 */
export interface SemanticRevisionV1 {
  /** Model identifier, for example `@cf/baai/bge-m3`. */
  readonly model: string;
  /** Declared by the publisher and bumped on any change to the model's weights or options. */
  readonly modelRevision: string;
  readonly dimensions: number;
  /** How a chunk becomes the embedded text. */
  readonly textAssemblyRevision: string;
}

export function semanticRevisionId(revision: SemanticRevisionV1): string {
  return `${revision.model}@${revision.modelRevision}:${revision.dimensions}:${revision.textAssemblyRevision}`;
}

/** One chunk a semantic retriever proposes; the list order is the ranking. */
export interface SemanticCandidateV1 {
  readonly chunkId: string;
  readonly recordId: string;
  readonly groupRootRecordId: string;
  readonly projectId: string;
  /** Retriever-specific similarity; fusion reads only the rank. */
  readonly score: number;
}

export interface SemanticRetrievalRequestV1 {
  readonly query: string;
  /** The retriever applies these; fusion re-checks only the project filter. */
  readonly filters?: SearchFiltersV1;
  /** Maximum number of chunk candidates. */
  readonly limit: number;
  /** Aborted when the caller stops waiting. */
  readonly signal?: AbortSignal;
}

export interface SemanticRetrievalV1 {
  readonly semanticRevision: string;
  /** Best first. */
  readonly candidates: readonly SemanticCandidateV1[];
}

/**
 * The replaceable semantic boundary (Spec 005 Phase 2). Cloudflare Vectorize is the first
 * implementation; nothing outside an adapter may depend on a vector store's API.
 */
export interface SemanticRetriever {
  retrieve(request: SemanticRetrievalRequestV1): Promise<SemanticRetrievalV1>;
}

export const TITLE_TEXT_ASSEMBLY_REVISION = "title-text@1";

/** The text one chunk is embedded as under `title-text@1`. */
export function chunkEmbeddingText(chunk: SourceRecordChunkV1): string {
  return `${chunk.title}\n${chunk.text}`;
}

export interface InMemorySemanticRetrieverInputV1 {
  readonly revision: SemanticRevisionV1;
  readonly chunks: readonly SourceRecordChunkV1[];
  /** Embeds chunk text and queries with the same model. */
  readonly embed: (text: string) => readonly number[] | Promise<readonly number[]>;
}

/**
 * Exact cosine similarity over vectors held in memory, for tests and the evaluation runner. It
 * calls no model itself: `embed` is injected.
 */
export function createInMemorySemanticRetriever(input: InMemorySemanticRetrieverInputV1): SemanticRetriever {
  const semanticRevision = semanticRevisionId(input.revision);
  const embedChecked = async (text: string): Promise<readonly number[]> => {
    const vector = await input.embed(text);
    if (vector.length !== input.revision.dimensions) {
      throw new Error(`Embedding has ${vector.length} dimensions, expected ${input.revision.dimensions}`);
    }
    return vector;
  };
  let vectors: Promise<readonly (readonly number[])[]> | undefined;
  return {
    async retrieve(request) {
      if (!Number.isInteger(request.limit) || request.limit <= 0) {
        throw new Error("Semantic limit must be a positive integer");
      }
      vectors ??= Promise.all(input.chunks.map((chunk) => embedChecked(chunkEmbeddingText(chunk))));
      const [chunkVectors, queryVector] = await Promise.all([vectors, embedChecked(request.query)]);
      const candidates = input.chunks
        .map((chunk, index) => ({ chunk, score: cosine(queryVector, chunkVectors[index]!) }))
        .filter(({ chunk, score }) => score > 0 && chunkMatchesSearchFilters(chunk, request.filters, undefined, false))
        .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
        .slice(0, request.limit)
        .map(({ chunk, score }) => ({
          chunkId: chunk.id,
          recordId: chunk.recordId,
          groupRootRecordId: chunk.groupRootRecordId,
          projectId: chunk.projectId,
          score,
        }));
      return { semanticRevision, candidates };
    },
  };
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}
