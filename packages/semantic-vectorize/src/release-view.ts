import type { SourceRecordChunkV1 } from "@oss-knowledge-base/search";

/** Where a stored vector says its passage lives. */
export interface VectorChunkRef {
  readonly projectId: string;
  readonly recordId: string;
  readonly ordinal: number;
  /** The group the passage had when it was embedded; a hint for locating it, not its answer. */
  readonly groupRootRecordId: string;
}

/**
 * The Search release a query is answered from, as far as semantic retrieval needs it
 * (Spec 016 Behavior 22). The vector index is mutable and releases are immutable, so every
 * candidate is read back from the release; the index only proposes where to look.
 */
export interface SemanticReleaseView {
  readonly indexRevision: string;
  readonly projectIds: readonly string[];
  /** For each ref, the release's own chunk of that project, record and ordinal, or `undefined`. */
  chunks(refs: readonly VectorChunkRef[], signal?: AbortSignal): Promise<readonly (SourceRecordChunkV1 | undefined)[]>;
}

const key = (projectId: string, recordId: string, ordinal: number) => [projectId, recordId, ordinal].join("\u0000");

/** A release held in memory, for tests and offline evaluation. */
export function createInMemoryReleaseView(indexRevision: string, chunks: readonly SourceRecordChunkV1[]): SemanticReleaseView {
  const byPassage = new Map(chunks.map((chunk) => [key(chunk.projectId, chunk.recordId, chunk.ordinal), chunk]));
  return {
    indexRevision,
    projectIds: [...new Set(chunks.map((chunk) => chunk.projectId))].sort(),
    chunks: async (refs) => refs.map((ref) => byPassage.get(key(ref.projectId, ref.recordId, ref.ordinal))),
  };
}
