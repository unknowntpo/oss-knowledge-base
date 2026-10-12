import {
  type SemanticCandidateV1,
  type SemanticRetrievalRequestV1,
  type SemanticRetrievalV1,
  type SemanticRetriever,
} from "@oss-knowledge-base/search";

import type { SemanticReleaseView } from "./release-view";
import type { SearchEmbeddingProfile } from "./revision";
import { acceptSemanticMatch, proposeSemanticMatches } from "./matches";
import type { VectorIndex } from "./vector-index";
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

    const proposed = await abortable(proposeSemanticMatches({
      index,
      vector,
      projectIds: request.filters?.projectIds ?? release.projectIds,
      topK: request.limit,
      semanticRevision: profile.semanticRevision,
    }), signal);

    const chunks = await abortable(release.chunks(proposed, signal), signal);
    const candidates = new Map<string, SemanticCandidateV1>();
    for (const [position, match] of proposed.entries()) {
      const chunk = chunks[position];
      if (chunk === undefined || !(await acceptSemanticMatch(match, chunk, request.filters))) continue;
      const previous = candidates.get(chunk.id);
      if (previous !== undefined && previous.score >= match.score) continue;
      candidates.set(chunk.id, {
        chunkId: chunk.id,
        recordId: chunk.recordId,
        groupRootRecordId: chunk.groupRootRecordId,
        projectId: chunk.projectId,
        score: match.score,
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
