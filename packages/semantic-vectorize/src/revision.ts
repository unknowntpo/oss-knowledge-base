import { semanticRevisionId, TITLE_TEXT_ASSEMBLY_REVISION, type SemanticRevisionV1 } from "@oss-knowledge-base/search";

/** One embedding configuration: what `SEARCH_EMBEDDING` selects (Spec 016 Behavior 14). */
export interface SearchEmbeddingProfile {
  /** The flag value that selects this profile. */
  readonly key: string;
  readonly revision: SemanticRevisionV1;
  /** `semanticRevisionId(revision)`: stored with every vector and returned by the retriever. */
  readonly semanticRevision: string;
}

/**
 * A change to any field of a revision invalidates every stored vector (Behavior 6), so a changed
 * model, pooling option, or text assembly is a new key here, never an edit of an existing one.
 */
const REVISIONS: Readonly<Record<string, SemanticRevisionV1>> = {
  "bge-m3@1": {
    model: "@cf/baai/bge-m3",
    modelRevision: "1",
    dimensions: 1_024,
    textAssemblyRevision: TITLE_TEXT_ASSEMBLY_REVISION,
  },
};

export const SUPPORTED_SEARCH_EMBEDDINGS: readonly string[] = Object.keys(REVISIONS);

export function searchEmbeddingProfile(key: string, revision: SemanticRevisionV1): SearchEmbeddingProfile {
  if (!Number.isInteger(revision.dimensions) || revision.dimensions <= 0) throw new Error("Embedding dimensions must be a positive integer");
  return { key, revision, semanticRevision: semanticRevisionId(revision) };
}

/**
 * `SEARCH_EMBEDDING` unset or blank is off (`undefined`). Any value that is not a supported
 * profile throws instead of silently embedding with another model.
 */
export function resolveSearchEmbedding(value: string | undefined): SearchEmbeddingProfile | undefined {
  const key = value?.trim() ?? "";
  if (key === "") return undefined;
  const revision = Object.hasOwn(REVISIONS, key) ? REVISIONS[key] : undefined;
  if (revision === undefined) {
    throw new Error(`SEARCH_EMBEDDING "${value}" is not a supported embedding profile (${SUPPORTED_SEARCH_EMBEDDINGS.join(", ")})`);
  }
  return searchEmbeddingProfile(key, revision);
}
