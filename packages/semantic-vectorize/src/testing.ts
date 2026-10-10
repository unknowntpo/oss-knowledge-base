/**
 * Test doubles for the vector store and the embedding model. The fake index enforces the limits
 * Vectorize documents, so a test that passes here does not send a request the real index refuses.
 * It measures nothing about Vectorize's ranking or `@cf/baai/bge-m3`.
 */
import { chunkEmbeddingText, SOURCE_RECORD_CHUNK_SCHEMA, type SourceRecordChunkV1 } from "@oss-knowledge-base/search";

import { chunkVectorRef, vectorRecord } from "./vector";
import { VECTOR_LIMITS, type StoredVector, type VectorIndex, type VectorIndexInfo, type VectorIndexMatch, type VectorIndexQueryOptions } from "./vector-index";

export type FakeIndexOperation = "describe" | "upsert" | "deleteByIds" | "query";

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export class FakeVectorIndex implements VectorIndex {
  readonly vectors = new Map<string, Required<StoredVector>>();
  /** Every call, in order: `describe`, `upsert:<n>`, `deleteByIds:<n>`, `query:<namespace>:<topK>`. */
  readonly calls: string[] = [];
  /** Accept mutations without applying them until `applyMutations()` (Vectorize is asynchronous). */
  deferMutations = false;
  /** Return an error to make that call fail; `callIndex` counts calls of the same operation from 0. */
  fail: (operation: FakeIndexOperation, callIndex: number) => Error | undefined = () => undefined;
  private readonly counts: Record<FakeIndexOperation, number> = { describe: 0, upsert: 0, deleteByIds: 0, query: 0 };
  private readonly queued: { readonly id: string; readonly apply: () => void }[] = [];
  private processed = "";
  private mutations = 0;

  constructor(readonly dimensions: number) {}

  private enter(operation: FakeIndexOperation, label: string): void {
    this.calls.push(label);
    const error = this.fail(operation, this.counts[operation]);
    this.counts[operation] += 1;
    if (error !== undefined) throw error;
  }

  private mutate(apply: () => void): { readonly mutationId: string } {
    this.mutations += 1;
    const id = `mutation-${this.mutations}`;
    this.queued.push({ id, apply });
    if (!this.deferMutations) this.applyMutations();
    return { mutationId: id };
  }

  applyMutations(): void {
    for (const mutation of this.queued.splice(0)) {
      mutation.apply();
      this.processed = mutation.id;
    }
  }

  async describe(): Promise<VectorIndexInfo> {
    this.enter("describe", "describe");
    return { vectorCount: this.vectors.size, dimensions: this.dimensions, processedUpToMutation: this.processed };
  }

  async upsert(vectors: StoredVector[]): Promise<{ readonly mutationId: string }> {
    this.enter("upsert", `upsert:${vectors.length}`);
    if (vectors.length === 0 || vectors.length > VECTOR_LIMITS.upsertBatch) throw new Error(`upsert of ${vectors.length} vectors is outside 1–${VECTOR_LIMITS.upsertBatch}`);
    const checked = vectors.map((vector) => {
      if (bytes(vector.id) > VECTOR_LIMITS.idBytes || vector.id.length === 0) throw new Error(`vector id is not 1–${VECTOR_LIMITS.idBytes} bytes: ${vector.id}`);
      if (vector.values.length !== this.dimensions) throw new Error(`vector has ${vector.values.length} dimensions, index has ${this.dimensions}`);
      const namespace = vector.namespace ?? "";
      if (bytes(namespace) > VECTOR_LIMITS.namespaceBytes) throw new Error(`namespace is over ${VECTOR_LIMITS.namespaceBytes} bytes`);
      const metadata = vector.metadata ?? {};
      if (bytes(JSON.stringify(metadata)) > VECTOR_LIMITS.metadataBytes) throw new Error(`metadata is over ${VECTOR_LIMITS.metadataBytes} bytes`);
      return { id: vector.id, values: [...vector.values], namespace, metadata: structuredClone(metadata) };
    });
    return this.mutate(() => {
      for (const vector of checked) this.vectors.set(vector.id, vector);
    });
  }

  async deleteByIds(ids: string[]): Promise<{ readonly mutationId: string }> {
    this.enter("deleteByIds", `deleteByIds:${ids.length}`);
    if (ids.length === 0 || ids.length > VECTOR_LIMITS.upsertBatch) throw new Error(`delete of ${ids.length} ids is outside 1–${VECTOR_LIMITS.upsertBatch}`);
    const copy = [...ids];
    return this.mutate(() => {
      for (const id of copy) this.vectors.delete(id);
    });
  }

  async query(vector: number[], options: VectorIndexQueryOptions): Promise<{ readonly matches: VectorIndexMatch[] }> {
    this.enter("query", `query:${options.namespace}:${options.topK}`);
    if (vector.length !== this.dimensions) throw new Error(`query has ${vector.length} dimensions, index has ${this.dimensions}`);
    if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > VECTOR_LIMITS.topKWithMetadata) {
      throw new Error(`topK ${options.topK} is outside 1–${VECTOR_LIMITS.topKWithMetadata} with metadata`);
    }
    const matches = [...this.vectors.values()]
      .filter((stored) => stored.namespace === options.namespace)
      .map((stored) => ({ id: stored.id, namespace: stored.namespace, metadata: structuredClone(stored.metadata), score: cosine(vector, stored.values) }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, options.topK);
    return { matches };
  }
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

/** A deterministic bag-of-words embedding: equal texts get equal vectors, shared words raise cosine. */
export function hashingEmbed(dimensions: number): (text: string) => number[] {
  return (text) => {
    const vector = new Array<number>(dimensions).fill(0);
    for (const word of text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []) {
      let hash = 2_166_136_261;
      for (let index = 0; index < word.length; index += 1) hash = Math.imul(hash ^ word.charCodeAt(index), 16_777_619) >>> 0;
      vector[hash % dimensions]! += 1;
    }
    return vector;
  };
}

/** A chunk with the given fields and plausible defaults for the rest. */
export function testChunk(fields: Partial<SourceRecordChunkV1> & { readonly recordId: string }): SourceRecordChunkV1 {
  const ordinal = fields.ordinal ?? 0;
  const sourceVersion = fields.sourceVersion ?? "v1";
  return {
    schema: SOURCE_RECORD_CHUNK_SCHEMA,
    id: `chunk:${fields.recordId}:${ordinal}:${sourceVersion}`,
    projectId: "apache-kafka",
    sourceInstanceId: "github:apache/kafka",
    groupRootRecordId: fields.recordId,
    ordinal,
    title: `Title of ${fields.recordId}`,
    text: `Text of ${fields.recordId}`,
    canonicalUrl: `https://example.org/${encodeURIComponent(fields.recordId)}`,
    author: "author",
    occurredAt: "2026-10-01T00:00:00.000Z",
    sourceVersion,
    tags: [],
    contentHash: "sha256:test",
    ...fields,
  };
}

/** Stores one vector per chunk exactly as the publisher does: same id, namespace, and metadata. */
export async function storeChunkVectors(
  index: VectorIndex,
  chunks: readonly SourceRecordChunkV1[],
  embed: (text: string) => readonly number[],
  semanticRevision: string,
): Promise<void> {
  const records: StoredVector[] = [];
  for (const chunk of chunks) {
    records.push(vectorRecord(await chunkVectorRef(chunk), chunk, embed(chunkEmbeddingText(chunk)), semanticRevision));
  }
  for (let start = 0; start < records.length; start += VECTOR_LIMITS.upsertBatch) {
    await index.upsert(records.slice(start, start + VECTOR_LIMITS.upsertBatch));
  }
}
