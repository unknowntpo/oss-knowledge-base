/** Fakes for the Spec 016 embedding tests: a release in a bucket, object storage, and a model. */
import type { SourceRecordChunkV1 } from "@oss-knowledge-base/search";
import { searchEmbeddingProfile, type EmbedTexts } from "@oss-knowledge-base/semantic-vectorize";
import { FakeVectorIndex, hashingEmbed, testChunk } from "@oss-knowledge-base/semantic-vectorize/testing";
import {
  SEARCH_CURRENT_KEY,
  SEARCH_CURRENT_SCHEMA,
  SEARCH_LEXICAL_SHARD_SCHEMA_V2,
  SEARCH_RELEASE_SCHEMA,
  searchReleaseManifestKey,
  searchReleasePrefix,
} from "@oss-knowledge-base/serving-contract";

import { runSearchEmbedding, type EmbeddingLimits, type EmbeddingRunInput, type ReleaseReader } from "../../src/search-embedding/run";
import { EmbeddingState, type EmbeddingStorage } from "../../src/search-embedding/state";

export const DIMENSIONS = 8;
export const PROFILE = searchEmbeddingProfile("test@1", { model: "@cf/baai/bge-m3", modelRevision: "1", dimensions: DIMENSIONS, textAssemblyRevision: "title-text@1" });
export const DAY_1 = Date.parse("2026-10-10T08:00:00.000Z");
export const DAY_MS = 86_400_000;

export class MemoryBucket implements ReleaseReader {
  readonly objects = new Map<string, unknown>();
  readonly reads: string[] = [];
  fail: (key: string) => Error | undefined = () => undefined;

  async getJson(key: string): Promise<unknown> {
    this.reads.push(key);
    const error = this.fail(key);
    if (error !== undefined) throw error;
    const value = this.objects.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
}

/**
 * Writes a search-release.v3 the way the publisher lays it out: shards of whole projects in
 * project order, a manifest, and the current pointer. Returns the shard keys.
 */
export function publishRelease(
  bucket: MemoryBucket,
  indexRevision: string,
  chunks: readonly SourceRecordChunkV1[],
  options: { readonly shardChunks?: number } = {},
): readonly string[] {
  const shardChunks = options.shardChunks ?? 1_000;
  const projects = [...new Set(chunks.map((chunk) => chunk.projectId))].sort();
  const shards: { projectId: string; key: string }[] = [];
  for (const projectId of projects) {
    const own = chunks.filter((chunk) => chunk.projectId === projectId);
    for (let start = 0; start < own.length; start += shardChunks) {
      const shard = shards.length;
      const key = `${searchReleasePrefix(indexRevision)}/lexical/${projectId}/${shard}.json`;
      const slice = own.slice(start, start + shardChunks);
      bucket.objects.set(key, {
        schema: SEARCH_LEXICAL_SHARD_SCHEMA_V2, indexRevision, projectId, shard, chunks: slice, lengths: slice.map(() => 1), postings: {}, groups: [],
      });
      shards.push({ projectId, key });
    }
  }
  bucket.objects.set(searchReleaseManifestKey(indexRevision), {
    schema: SEARCH_RELEASE_SCHEMA, indexRevision, corpusRevision: "corpus", lexicalRevision: "bm25-reference@1", generatedAt: "2026-10-10T07:07:00.000Z",
    shards, chunkCount: chunks.length, totalChunkLength: chunks.length, groupCount: chunks.length, objectDigests: {},
  });
  bucket.objects.set(SEARCH_CURRENT_KEY, {
    schema: SEARCH_CURRENT_SCHEMA, indexRevision, releaseManifestKey: searchReleaseManifestKey(indexRevision), generatedAt: "2026-10-10T07:07:00.000Z",
  });
  return shards.map((shard) => shard.key);
}

export class MemoryStorage implements EmbeddingStorage {
  readonly values = new Map<string, unknown>();
  /** Every write, in order: `put <key>`, `putMany <n>`, `delete <key>`, `deleteMany <n>`, `setAlarm`. */
  readonly writes: string[] = [];
  alarm: number | null = null;
  /** Return an error (or a promise that never settles) to fail or hang that write. */
  fail: (write: string) => Error | Promise<never> | undefined = () => undefined;

  private async enter(write: string): Promise<void> {
    const outcome = this.fail(write);
    if (outcome instanceof Error) throw outcome;
    if (outcome !== undefined) await outcome;
    this.writes.push(write);
  }

  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { await this.enter(`put ${key}`); this.values.set(key, structuredClone(value)); }
  async putMany(entries: Readonly<Record<string, unknown>>) {
    if (Object.keys(entries).length > 128) throw new Error("Durable Object storage accepts at most 128 keys per put");
    await this.enter(`putMany ${Object.keys(entries).length}`);
    for (const [key, value] of Object.entries(entries)) this.values.set(key, structuredClone(value));
  }
  async delete(key: string) { await this.enter(`delete ${key}`); return this.values.delete(key); }
  async deleteMany(keys: readonly string[]) {
    if (keys.length > 128) throw new Error("Durable Object storage accepts at most 128 keys per delete");
    await this.enter(`deleteMany ${keys.length}`);
    for (const key of keys) this.values.delete(key);
  }
  async list<T>(prefix: string) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).sort(([left], [right]) => left.localeCompare(right))) as Map<string, T>; }
  async getAlarm() { return this.alarm; }
  async setAlarm(time: number) { this.writes.push("setAlarm"); this.alarm = time; }

  vectorIds(): string[] {
    return [...this.values.keys()].filter((key) => key.startsWith("v:")).map((key) => key.slice(2)).sort();
  }
}

export type ModelAnswer = readonly (readonly number[])[] | Error | Promise<never> | undefined;

export class FakeEmbedder {
  /** The texts of every request, in order. */
  readonly calls: (readonly string[])[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  /** Decides the answer of the n-th request (from 0); `undefined` embeds normally. */
  respond: (call: number, texts: readonly string[]) => ModelAnswer = () => undefined;
  onCall: () => void = () => undefined;
  private readonly embedOne = hashingEmbed(DIMENSIONS);

  readonly embed: EmbedTexts = async (texts, signal) => {
    const call = this.calls.length;
    this.calls.push([...texts]);
    this.signals.push(signal);
    this.onCall();
    const answer = this.respond(call, texts);
    if (answer instanceof Error) throw answer;
    if (answer !== undefined) return answer;
    return texts.map(this.embedOne);
  };
}

export const projectA = (recordId: string, fields: Partial<SourceRecordChunkV1> = {}) => testChunk({ recordId, projectId: "p-a", sourceInstanceId: "source-a", ...fields });
export const projectB = (recordId: string, fields: Partial<SourceRecordChunkV1> = {}) => testChunk({ recordId, projectId: "p-b", sourceInstanceId: "source-b", ...fields });

/** Five chunks in two projects, so two shards: with two texts per batch that is three batches. */
export const FIVE = [projectA("a1"), projectA("a2"), projectA("a3"), projectB("b1"), projectB("b2")];

export function harness(base: Partial<EmbeddingLimits> = {}) {
  const bucket = new MemoryBucket();
  const storage = new MemoryStorage();
  const index = new FakeVectorIndex(DIMENSIONS);
  const model = new FakeEmbedder();
  const clock = { now: DAY_1 };
  const run = (overrides: Partial<EmbeddingRunInput> = {}) => runSearchEmbedding({
    bucket,
    index,
    embed: model.embed,
    profile: PROFILE,
    state: new EmbeddingState(storage),
    now: () => new Date(clock.now),
    delay: async () => undefined,
    dryRun: false,
    ...overrides,
    limits: { ...base, ...overrides.limits },
  });
  return { bucket, storage, index, model, clock, run };
}
