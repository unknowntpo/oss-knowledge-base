/**
 * What every `SemanticRetriever` must do (Spec 016 Behavior 4), written once and run against the
 * in-memory retriever (H5) and the Vectorize adapter (H24). `make` builds a retriever holding the
 * given chunks, embedded with `embed` under `revision`.
 */
import { expect } from "bun:test";

import { semanticRevisionId, type SemanticRetriever, type SemanticRevisionV1, type SourceRecordChunkV1 } from "../../src";
import { FAKE_SEMANTIC_REVISION, fakeEmbed } from "./fake-embedder";
import { loadGoldenV2 } from "./golden-v2";

export interface SemanticRetrieverFactoryInput {
  readonly revision: SemanticRevisionV1;
  readonly chunks: readonly SourceRecordChunkV1[];
  readonly embed: (text: string) => readonly number[];
}

export type SemanticRetrieverFactory = (input: SemanticRetrieverFactoryInput) => SemanticRetriever | Promise<SemanticRetriever>;

export const semanticRetrieverContract: readonly { readonly name: string; readonly run: (make: SemanticRetrieverFactory) => Promise<void> }[] = [
  {
    name: "it ranks chunks by cosine similarity and reports its revision",
    run: async (make) => {
      const golden = await loadGoldenV2();
      const semantic = await make({ revision: FAKE_SEMANTIC_REVISION, chunks: golden.chunks, embed: fakeEmbed });
      const { semanticRevision, candidates } = await semantic.retrieve({ query: "交易逾時", limit: 10 });
      expect(semanticRevision).toBe("fake-concepts@1:4:title-text@1");
      expect(semanticRevision).toBe(semanticRevisionId(FAKE_SEMANTIC_REVISION));
      // KAFKA-20785 names both concepts (cosine 1); KAFKA-20734 names one (cosine 1/sqrt(2)).
      expect(candidates.map((item) => item.groupRootRecordId)).toEqual(["kafka:jira:issue:KAFKA-20785", "kafka:jira:issue:KAFKA-20734"]);
      expect(candidates[0]!.score).toBeCloseTo(1, 12);
      expect(candidates[1]!.score).toBeCloseTo(Math.SQRT1_2, 12);
      expect(candidates[0]).toEqual({
        chunkId: "chunk:kafka:jira:issue:KAFKA-20785:0",
        recordId: "kafka:jira:issue:KAFKA-20785",
        groupRootRecordId: "kafka:jira:issue:KAFKA-20785",
        projectId: "apache-kafka",
        score: candidates[0]!.score,
      });
      expect((await semantic.retrieve({ query: "交易逾時", limit: 1 })).candidates).toHaveLength(1);
      expect((await semantic.retrieve({ query: "unrelated words", limit: 10 })).candidates).toEqual([]);
    },
  },
  {
    name: "equal similarities rank by chunk id, whatever order the chunks arrive in",
    run: async (make) => {
      const golden = await loadGoldenV2();
      const constant = (chunks: readonly SourceRecordChunkV1[]) => make({
        revision: { ...FAKE_SEMANTIC_REVISION, dimensions: 1 },
        chunks,
        embed: () => [1],
      });
      const forward = await (await constant(golden.chunks)).retrieve({ query: "q", limit: 100 });
      const reversed = await (await constant([...golden.chunks].reverse())).retrieve({ query: "q", limit: 100 });
      const ids = golden.chunks.map((chunk) => chunk.id).sort((left, right) => left.localeCompare(right));
      expect(forward.candidates.map((item) => item.chunkId)).toEqual(ids);
      expect(reversed.candidates).toEqual(forward.candidates);
    },
  },
  {
    name: "it applies the evidence filters and refuses a limit that is not positive",
    run: async (make) => {
      const golden = await loadGoldenV2();
      const semantic = await make({ revision: FAKE_SEMANTIC_REVISION, chunks: golden.chunks, embed: fakeEmbed });
      const all = await semantic.retrieve({ query: "txn", limit: 10 });
      expect(all.candidates).toHaveLength(2);
      const after = await semantic.retrieve({ query: "txn", limit: 10, filters: { occurredAfter: "2026-10-01T00:00:00Z" } });
      expect(after.candidates.map((item) => item.recordId)).toEqual(["kafka:jira:issue:KAFKA-20734"]);
      const otherProject = await semantic.retrieve({ query: "txn", limit: 10, filters: { projectIds: ["apache-datafusion"] } });
      expect(otherProject.candidates).toEqual([]);
      await expect(semantic.retrieve({ query: "txn", limit: 0 })).rejects.toThrow("positive integer");
    },
  },
];
