import {
  chunkMatchesSearchFilters,
  type SemanticCandidateV1,
  type SemanticRetrievalRequestV1,
  type SemanticRetrievalV1,
  type SemanticRetriever,
} from "@oss-knowledge-base/search";

import type { SemanticReleaseView } from "./release-view";
import type { SearchEmbeddingProfile } from "./revision";
import { chunkFingerprint, parseVectorMetadata, vectorNamespace, type VectorMetadataV1 } from "./vector";
import { VECTOR_LIMITS, type VectorIndex } from "./vector-index";
import type { EmbedTexts } from "./workers-ai";

export interface VectorizeSemanticRetrieverInput {
  readonly index: VectorIndex;
  /** The publisher's model through the search gateway; the same profile on both sides. */
  readonly embed: EmbedTexts;
  readonly profile: SearchEmbeddingProfile;
  /** The release this query is answered from. */
  readonly release: SemanticReleaseView;
}

/** Rejects when `signal` aborts, so a caller that stopped waiting is not kept by a slow call. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new Error("Semantic retrieval was aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Semantic retrieval was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * `SemanticRetriever` over a vector index with one namespace per project (Spec 016 Behavior 21).
 * A match is a candidate only when the release holds its passage with the same fingerprint
 * (Behavior 22); every candidate field comes from the release's chunk.
 */
export class VectorizeSemanticRetriever implements SemanticRetriever {
  constructor(private readonly input: VectorizeSemanticRetrieverInput) {}

  async retrieve(request: SemanticRetrievalRequestV1): Promise<SemanticRetrievalV1> {
    const { index, embed, profile, release } = this.input;
    if (!Number.isInteger(request.limit) || request.limit <= 0) {
      throw new Error("Semantic limit must be a positive integer");
    }
    const signal = request.signal;
    const [vector, ...rest] = await abortable(embed([request.query], signal), signal);
    if (vector === undefined || rest.length > 0) throw new Error("Query embedding did not return one vector");
    if (vector.length !== profile.revision.dimensions) {
      throw new Error(`Embedding has ${vector.length} dimensions, expected ${profile.revision.dimensions}`);
    }

    const projectIds = [...new Set(request.filters?.projectIds ?? release.projectIds)];
    const topK = Math.min(request.limit, VECTOR_LIMITS.topKWithMetadata);
    const answers = await abortable(Promise.all(projectIds.map((projectId) =>
      index.query([...vector], { topK, namespace: vectorNamespace(projectId), returnMetadata: "all", returnValues: false }))), signal);

    const proposed: { readonly projectId: string; readonly score: number; readonly metadata: VectorMetadataV1 }[] = [];
    answers.forEach((answer, position) => {
      const projectId = projectIds[position]!;
      for (const match of answer.matches) {
        const metadata = parseVectorMetadata(match.metadata);
        if (metadata === undefined || metadata.r !== profile.semanticRevision) continue;
        if (!(match.score > 0) || !Number.isFinite(match.score)) continue;
        proposed.push({ projectId, score: match.score, metadata });
      }
    });

    const chunks = await abortable(release.chunks(proposed.map(({ projectId, metadata }) => ({
      projectId,
      recordId: metadata.record,
      ordinal: metadata.ord,
      groupRootRecordId: metadata.root,
    })), signal), signal);
    const candidates = new Map<string, SemanticCandidateV1>();
    for (const [position, { projectId, score, metadata }] of proposed.entries()) {
      const chunk = chunks[position];
      if (chunk === undefined) continue;
      if (chunk.projectId !== projectId || chunk.recordId !== metadata.record || chunk.ordinal !== metadata.ord) continue;
      if (await chunkFingerprint(chunk) !== metadata.h) continue;
      if (!chunkMatchesSearchFilters(chunk, request.filters, undefined, false)) continue;
      const previous = candidates.get(chunk.id);
      if (previous !== undefined && previous.score >= score) continue;
      candidates.set(chunk.id, {
        chunkId: chunk.id,
        recordId: chunk.recordId,
        groupRootRecordId: chunk.groupRootRecordId,
        projectId: chunk.projectId,
        score,
      });
    }
    return {
      semanticRevision: profile.semanticRevision,
      candidates: [...candidates.values()]
        .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
        .slice(0, request.limit),
    };
  }
}
