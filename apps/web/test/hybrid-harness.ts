/**
 * Spec 016 slice 3 test harness: golden v2 published as a search-release.v3 with shard roots, an
 * in-memory bucket that records its reads, and the real query gate over a fake embedder and a
 * fake vector index. Nothing here calls Workers AI, Vectorize, or a Durable Object.
 */
import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import { searchEmbeddingProfile, SemanticQueryGate, type QueryGateLimits, type SemanticMatchV1, type SemanticQueryAnswerV1, type SemanticQueryPort } from "@oss-knowledge-base/semantic-vectorize";
import { FakeVectorIndex, MemoryGateStorage, storeChunkVectors } from "@oss-knowledge-base/semantic-vectorize/testing";
import { THREAD_PHRASE_LEXICAL_REVISION, type SourceRecordChunkV1 } from "@oss-knowledge-base/search";
import {
  buildR2SearchProjection,
  type ProjectionObject,
  type SearchLexicalShardV2,
  type SearchReleaseManifestV3,
} from "@oss-knowledge-base/serving-contract";

import { FAKE_SEMANTIC_REVISION, fakeEmbed } from "../../../packages/search/test/support/fake-embedder";
import { buildGoldenV2SearchPublication } from "../scripts/build-search-fixture";

export const goldenV2Path = new URL("../../../packages/search/test/fixtures/golden-queries.v2.json", import.meta.url).pathname;
export const fakeProfile = searchEmbeddingProfile("fake-concepts@1", FAKE_SEMANTIC_REVISION);

export class MemoryBucket {
  readonly reads: string[] = [];
  /** The most reads in flight at once. */
  peak = 0;
  private inFlight = 0;
  private readonly values: Map<string, string>;

  constructor(objects: readonly { readonly key: string; readonly body: string }[]) {
    this.values = new Map(objects.map((object) => [object.key, object.body]));
  }

  get = async (key: string) => {
    this.reads.push(key);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    // A real read yields; without this every read would finish before the next starts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.inFlight -= 1;
    const body = this.values.get(key);
    return body === undefined ? null : { json: async <T>() => JSON.parse(body) as T };
  };

  asR2(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

/** Golden v2 at `bm25-reference@3`, 2 chunks per shard, with or without shard roots. */
export async function goldenRelease(options: { readonly shardRoots?: boolean; readonly maxShardChunks?: number; readonly indexRevision?: string } = {}): Promise<readonly ProjectionObject[]> {
  const publication = await buildGoldenV2SearchPublication(goldenV2Path, options.indexRevision ?? "release-hybrid", THREAD_PHRASE_LEXICAL_REVISION);
  return buildR2SearchProjection(publication, {
    maxShardChunks: options.maxShardChunks ?? 2,
    identifiers: searchIdentifierProfiles,
    ...(options.shardRoots === false ? {} : { shardRoots: true }),
  });
}

export function manifestOf(objects: readonly ProjectionObject[]): SearchReleaseManifestV3 {
  return JSON.parse(objects.find((object) => object.key.endsWith("/manifest.json"))!.body) as SearchReleaseManifestV3;
}

export function shardsOf(objects: readonly ProjectionObject[]): readonly SearchLexicalShardV2[] {
  return manifestOf(objects).shards.map((shard) => JSON.parse(objects.find((object) => object.key === shard.key)!.body) as SearchLexicalShardV2);
}

export function chunksOf(objects: readonly ProjectionObject[]): readonly SourceRecordChunkV1[] {
  return shardsOf(objects).flatMap((shard) => shard.chunks);
}

/** A gate that counts what it is asked; `answer` may be replaced per test. */
export class RecordingGate implements SemanticQueryPort {
  readonly requests: { readonly query: string; readonly projectIds: readonly string[] }[] = [];
  readonly signals: AbortSignal[] = [];

  constructor(public answer: (request: { readonly query: string; readonly projectIds: readonly string[] }, signal?: AbortSignal) => Promise<SemanticQueryAnswerV1>) {}

  async query(request: { readonly query: string; readonly projectIds: readonly string[] }, signal?: AbortSignal): Promise<SemanticQueryAnswerV1> {
    this.requests.push(request);
    if (signal !== undefined) this.signals.push(signal);
    return this.answer(request, signal);
  }
}

/** Fails the test if hybrid search asks it anything. */
export const untouchableGate: SemanticQueryPort = {
  query: async () => {
    throw new Error("the semantic gate must not be called");
  },
};

/**
 * The real gate, holding one vector per chunk as the publisher stores them, embedded with the
 * fake concept embedder (it measures nothing about `@cf/baai/bge-m3`).
 */
export async function fakeGate(chunks: readonly SourceRecordChunkV1[], limits?: Partial<QueryGateLimits>) {
  const index = new FakeVectorIndex(FAKE_SEMANTIC_REVISION.dimensions);
  await storeChunkVectors(index, chunks, fakeEmbed, fakeProfile.semanticRevision);
  index.calls.length = 0;
  const model = { calls: 0 };
  const storage = new MemoryGateStorage();
  const gate = new SemanticQueryGate({
    storage,
    config: () => ({
      state: "on",
      profile: fakeProfile,
      embed: async (texts) => {
        model.calls += 1;
        return texts.map(fakeEmbed);
      },
      index,
    }),
    neuronsPerMillionTokens: 1_091,
    isRefusal: () => false,
    now: () => new Date("2026-10-12T10:00:00.000Z"),
    ...(limits === undefined ? {} : { limits }),
  });
  const recording = new RecordingGate((request) => gate.query(request));
  return { gate: recording, index, model, storage };
}

/** A match exactly as the gate would report the release's own chunk, with any field overridden. */
export async function matchFor(chunk: SourceRecordChunkV1, score: number, override: Partial<SemanticMatchV1> = {}): Promise<SemanticMatchV1> {
  const { chunkFingerprint } = await import("@oss-knowledge-base/semantic-vectorize");
  return {
    projectId: chunk.projectId,
    recordId: chunk.recordId,
    ordinal: chunk.ordinal,
    groupRootRecordId: chunk.groupRootRecordId,
    fingerprint: await chunkFingerprint(chunk),
    score,
    ...override,
  };
}

export const okAnswer = (matches: readonly SemanticMatchV1[], cached = false): SemanticQueryAnswerV1 =>
  ({ status: "ok", semanticRevision: fakeProfile.semanticRevision, cached, matches });
