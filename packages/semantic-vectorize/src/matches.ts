import { chunkMatchesSearchFilters, type SearchFiltersV1, type SourceRecordChunkV1 } from "@oss-knowledge-base/search";

import { chunkFingerprint, parseVectorMetadata, vectorNamespace } from "./vector";
import { VECTOR_LIMITS, type VectorIndex } from "./vector-index";

/**
 * One stored vector an index proposes for a query: where it says its passage lives and the
 * fingerprint it was embedded at. Plain data with no store type, so it can cross a binding. It is
 * a proposal only: `acceptSemanticMatch` decides against the release (Spec 016 Behavior 22).
 */
export interface SemanticMatchV1 {
  readonly projectId: string;
  readonly recordId: string;
  readonly ordinal: number;
  /** The group the passage had when it was embedded: names the release's shard, never the answer. */
  readonly groupRootRecordId: string;
  readonly fingerprint: string;
  readonly score: number;
}

/**
 * Asks each project's namespace for its `topK` nearest vectors and keeps the matches of
 * `semanticRevision` with well-formed metadata and a positive, finite score. One index query per
 * project.
 */
export async function proposeSemanticMatches(input: {
  readonly index: VectorIndex;
  readonly vector: readonly number[];
  readonly projectIds: readonly string[];
  readonly topK: number;
  readonly semanticRevision: string;
}): Promise<readonly SemanticMatchV1[]> {
  const projectIds = [...new Set(input.projectIds)];
  const topK = Math.min(input.topK, VECTOR_LIMITS.topKWithMetadata);
  const answers = await Promise.all(projectIds.map((projectId) =>
    input.index.query([...input.vector], { topK, namespace: vectorNamespace(projectId), returnMetadata: "all", returnValues: false })));
  const proposed: SemanticMatchV1[] = [];
  answers.forEach((answer, position) => {
    const projectId = projectIds[position]!;
    for (const match of answer.matches) {
      const metadata = parseVectorMetadata(match.metadata);
      if (metadata === undefined || metadata.r !== input.semanticRevision) continue;
      if (!(match.score > 0) || !Number.isFinite(match.score)) continue;
      proposed.push({
        projectId,
        recordId: metadata.record,
        ordinal: metadata.ord,
        groupRootRecordId: metadata.root,
        fingerprint: metadata.h,
        score: match.score,
      });
    }
  });
  return proposed;
}

/**
 * Whether the release's chunk is the passage a match was embedded from: same project, record,
 * and ordinal, an equal fingerprint (title, text, and group), and the evidence filters pass.
 * `eligibleGroupRootRecordIds` and `ignoreProjectIds` mean what they mean for lexical chunks.
 */
export async function acceptSemanticMatch(
  match: SemanticMatchV1,
  chunk: SourceRecordChunkV1 | undefined,
  filters?: SearchFiltersV1,
  eligibleGroupRootRecordIds?: ReadonlySet<string>,
  ignoreProjectIds = false,
): Promise<boolean> {
  if (chunk === undefined) return false;
  if (chunk.projectId !== match.projectId || chunk.recordId !== match.recordId || chunk.ordinal !== match.ordinal) return false;
  if (await chunkFingerprint(chunk) !== match.fingerprint) return false;
  return chunkMatchesSearchFilters(chunk, filters, eligibleGroupRootRecordIds, ignoreProjectIds);
}

/** A match read from another process, or `undefined` when any field is missing or of the wrong type. */
export function parseSemanticMatch(value: unknown): SemanticMatchV1 | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { projectId, recordId, ordinal, groupRootRecordId, fingerprint, score } = value as Record<string, unknown>;
  if (typeof projectId !== "string" || typeof recordId !== "string" || typeof groupRootRecordId !== "string" || typeof fingerprint !== "string") return undefined;
  if (projectId === "" || recordId === "" || groupRootRecordId === "") return undefined;
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0) return undefined;
  if (typeof score !== "number" || !Number.isFinite(score) || !(score > 0)) return undefined;
  return { projectId, recordId, ordinal, groupRootRecordId, fingerprint, score };
}
