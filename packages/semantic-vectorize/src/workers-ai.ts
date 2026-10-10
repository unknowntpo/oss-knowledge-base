/**
 * Embeddings from Workers AI through an AI Gateway (Spec 016 Behavior 16 and 21).
 * `ai.run(model, { text: [...] }, { gateway: { id } })` routes the binding call through the named
 * gateway, as the digest does; the search gateway is its own, never the digest's.
 */
import type { SearchEmbeddingProfile } from "./revision";

/** The part of the `Ai` binding used here. */
export interface EmbeddingAiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

/** Embeds texts with one model, one vector per text, in order. */
export type EmbedTexts = (texts: readonly string[], signal?: AbortSignal) => Promise<readonly (readonly number[])[]>;

/** The `data` of an embedding response, checked: one finite vector of `dimensions` per text. */
export function embeddingVectors(response: unknown, expected: number, dimensions: number): number[][] {
  const data = (response ?? {}) as { data?: unknown };
  if (!Array.isArray(data.data)) throw new Error("Embedding response has no data array");
  if (data.data.length !== expected) throw new Error(`Embedding response has ${data.data.length} vectors, expected ${expected}`);
  return data.data.map((vector: unknown) => {
    if (!Array.isArray(vector) || vector.length !== dimensions) {
      throw new Error(`Embedding has ${Array.isArray(vector) ? vector.length : 0} dimensions, expected ${dimensions}`);
    }
    if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) throw new Error("Embedding holds a value that is not a finite number");
    return vector as number[];
  });
}

export function workersAiEmbedder(
  ai: EmbeddingAiBinding,
  gatewayId: string,
  profile: SearchEmbeddingProfile,
  options: { readonly skipCache?: boolean } = {},
): EmbedTexts {
  if (gatewayId.trim() === "") throw new Error("An AI Gateway id is required for embeddings");
  return async (texts, signal) => {
    // `signal` is an `AiOptions` field of the binding (workers-types): the publisher aborts a call
    // it stopped waiting for, and hybrid search aborts a query that timed out.
    const response = await ai.run(profile.revision.model, { text: [...texts], truncate_inputs: true }, {
      gateway: { id: gatewayId, ...(options.skipCache === undefined ? {} : { skipCache: options.skipCache }) },
      ...(signal === undefined ? {} : { signal }),
    });
    return embeddingVectors(response, texts.length, profile.revision.dimensions);
  };
}
