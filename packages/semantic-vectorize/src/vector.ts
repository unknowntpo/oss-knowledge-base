import { chunkEmbeddingText, type SourceRecordChunkV1 } from "@oss-knowledge-base/search";

import { VECTOR_LIMITS, type StoredVector } from "./vector-index";

/** Stored with each vector: enough to find the release's chunk and to tell a stale vector. */
export type VectorMetadataV1 = {
  /** Semantic revision id the vector was embedded with. */
  readonly r: string;
  /** Fingerprint of the embedded text and its group. */
  readonly h: string;
  readonly record: string;
  readonly ord: number;
  /** The group root when embedded: a hint for finding the release's shard, never an answer. */
  readonly root: string;
};

export interface ChunkVectorRef {
  readonly id: string;
  readonly namespace: string;
  readonly fingerprint: string;
}

const ID_HEX = 48;
const FINGERPRINT_HEX = 32;
const encoder = new TextEncoder();

async function sha256Hex(parts: readonly (string | number)[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(parts.join("\u0000")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * One id per passage of a record. A chunk id is `chunk:sha256:<64 hex>` (76 bytes, over the
 * 64-byte limit) and changes with every source version; this id stays with the passage.
 */
export async function vectorId(projectId: string, recordId: string, ordinal: number): Promise<string> {
  return (await sha256Hex([projectId, recordId, ordinal])).slice(0, ID_HEX);
}

/** Changes when the embedded text or the group it is cited under changes. */
export async function chunkFingerprint(chunk: SourceRecordChunkV1): Promise<string> {
  return (await sha256Hex([chunkEmbeddingText(chunk), chunk.groupRootRecordId])).slice(0, FINGERPRINT_HEX);
}

/** One namespace per project. */
export function vectorNamespace(projectId: string): string {
  if (projectId.length === 0 || encoder.encode(projectId).byteLength > VECTOR_LIMITS.namespaceBytes) {
    throw new Error(`Project id "${projectId}" is not a valid vector namespace (1–${VECTOR_LIMITS.namespaceBytes} bytes)`);
  }
  return projectId;
}

export async function chunkVectorRef(chunk: SourceRecordChunkV1): Promise<ChunkVectorRef> {
  return {
    id: await vectorId(chunk.projectId, chunk.recordId, chunk.ordinal),
    namespace: vectorNamespace(chunk.projectId),
    fingerprint: await chunkFingerprint(chunk),
  };
}

/** The vector the publisher stores for a chunk; refuses metadata over the store's limit. */
export function vectorRecord(
  ref: ChunkVectorRef,
  chunk: SourceRecordChunkV1,
  values: readonly number[],
  semanticRevision: string,
): StoredVector & { readonly namespace: string; readonly metadata: VectorMetadataV1 } {
  const metadata: VectorMetadataV1 = {
    r: semanticRevision,
    h: ref.fingerprint,
    record: chunk.recordId,
    ord: chunk.ordinal,
    root: chunk.groupRootRecordId,
  };
  const bytes = encoder.encode(JSON.stringify(metadata)).byteLength;
  if (bytes > VECTOR_LIMITS.metadataBytes) {
    throw new Error(`Vector metadata of ${chunk.recordId} is ${bytes} bytes, over ${VECTOR_LIMITS.metadataBytes}`);
  }
  return { id: ref.id, namespace: ref.namespace, values: [...values], metadata: { ...metadata } };
}

export function parseVectorMetadata(value: unknown): VectorMetadataV1 | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { r, h, record, ord, root } = value as Record<string, unknown>;
  if (typeof r !== "string" || typeof h !== "string" || typeof record !== "string" || typeof root !== "string") return undefined;
  if (typeof ord !== "number" || !Number.isInteger(ord) || ord < 0) return undefined;
  return { r, h, record, ord, root };
}
