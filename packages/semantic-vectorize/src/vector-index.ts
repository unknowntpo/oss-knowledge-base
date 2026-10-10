/**
 * The part of a vector store the search adapter uses. Cloudflare's `Vectorize` binding satisfies
 * it structurally; no Cloudflare type is imported, so the store stays replaceable (Spec 005).
 */
export type VectorMetadataValue = string | number | boolean | string[];

export interface StoredVector {
  readonly id: string;
  readonly values: number[];
  readonly namespace?: string;
  readonly metadata?: Record<string, VectorMetadataValue>;
}

export interface VectorIndexMatch {
  readonly id: string;
  readonly score: number;
  readonly namespace?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface VectorIndexInfo {
  readonly vectorCount: number;
  readonly dimensions: number;
  /** The last mutation the index has applied; everything accepted before it is queryable. */
  readonly processedUpToMutation?: unknown;
}

export interface VectorIndexQueryOptions {
  readonly topK: number;
  readonly namespace: string;
  readonly returnMetadata: "all";
  readonly returnValues: false;
}

/** Mutations are asynchronous: the answer is a mutation id, and the change is queryable later. */
export interface VectorIndex {
  describe(): Promise<VectorIndexInfo>;
  upsert(vectors: StoredVector[]): Promise<{ readonly mutationId: string }>;
  deleteByIds(ids: string[]): Promise<{ readonly mutationId: string }>;
  query(vector: number[], options: VectorIndexQueryOptions): Promise<{ readonly matches: VectorIndexMatch[] }>;
}

/** Vectorize limits this adapter must stay within (Cloudflare documentation, read 2026-10-10). */
export const VECTOR_LIMITS = {
  idBytes: 64,
  namespaceBytes: 64,
  metadataBytes: 10 * 1_024,
  upsertBatch: 1_000,
  topKWithMetadata: 50,
} as const;
