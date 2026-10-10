/**
 * A stand-in for the embedding model, for tests and the evaluation runner only. It maps a few
 * surface forms to concepts by hand and returns one dimension per concept, so `txn`, `交易` and
 * `transaction` land on the same axis the way a multilingual model would place them close.
 *
 * It measures nothing about `@cf/baai/bge-m3`: hybrid numbers produced with it show that fusion,
 * fallback and reporting work, not how good semantic retrieval will be (Spec 016 Behavior 11).
 */
import {
  createInMemorySemanticRetriever,
  type SemanticRetriever,
  type SemanticRevisionV1,
  type SourceRecordChunkV1,
} from "../../src";

const CONCEPTS: readonly (readonly string[])[] = [
  ["transaction", "txn", "交易"],
  ["timeout", "timed out", "逾時"],
  ["tiered storage", "cold data", "older log segments", "remote object storage"],
  ["broker disk", "local disk"],
];

export const FAKE_SEMANTIC_REVISION: SemanticRevisionV1 = {
  model: "fake-concepts",
  modelRevision: "1",
  dimensions: CONCEPTS.length,
  textAssemblyRevision: "title-text@1",
};

export function fakeEmbed(text: string): readonly number[] {
  const lowered = text.normalize("NFKC").toLocaleLowerCase("en-US");
  return CONCEPTS.map((forms) => forms.some((form) => lowered.includes(form)) ? 1 : 0);
}

export function fakeSemanticRetriever(chunks: readonly SourceRecordChunkV1[]): SemanticRetriever {
  return createInMemorySemanticRetriever({ revision: FAKE_SEMANTIC_REVISION, chunks, embed: fakeEmbed });
}
