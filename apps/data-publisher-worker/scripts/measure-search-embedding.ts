/**
 * Spec 016 H27: what embedding a Search release costs, offline.
 *
 *   bun run measure:search-embedding [--fixture <recorded Feed fixture>] [--chunks 8586]
 *
 * Publishes the version-controlled recorded Feed snapshot (real GitHub records of both projects)
 * as the publisher does, then runs the real embedding run against it: once dry (the estimate an
 * operator sees from `POST /search-embedding/run?dryRun=1`) and then to completion with a fake
 * model and an in-memory index, counting runs, model calls, estimated tokens, neurons and
 * dollars, and stored dimensions under the default bounds. `--chunks` scales the per-chunk
 * averages to another corpus size (default: the Dev corpus of Spec 016 Evidence). No network, no
 * Workers AI, no Vectorize; token counts are the publisher's estimate, not the model's tokenizer.
 */
import { parseArgs } from "node:util";

import { estimateTokens, neurons, USD_PER_NEURON } from "@oss-knowledge-base/reference-pipeline";
import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import { chunkEmbeddingText } from "@oss-knowledge-base/search";
import { resolveSearchEmbedding } from "@oss-knowledge-base/semantic-vectorize";
import { FakeVectorIndex } from "@oss-knowledge-base/semantic-vectorize/testing";
import {
  SEARCH_CURRENT_KEY,
  searchGroupsFromFeed,
  searchProjectionObjects,
  type FeedPublication,
  type SearchLexicalShardV2,
} from "@oss-knowledge-base/serving-contract";

import { DEFAULT_EMBEDDING_LIMITS, embeddingModel, runSearchEmbedding, type EmbeddingRunResult } from "../src/search-embedding/run";
import { EmbeddingState, type EmbeddingStorage } from "../src/search-embedding/state";

const DEFAULT_FIXTURE = "apps/web/test/fixtures/recorded-feed-publication.v1.json";
const { values } = parseArgs({ options: { fixture: { type: "string" }, chunks: { type: "string" } } });
const targetChunks = Number(values.chunks ?? 8_586);
if (!Number.isInteger(targetChunks) || targetChunks <= 0) throw new Error("--chunks must be a positive integer");
const profile = resolveSearchEmbedding("bge-m3@1")!;
const model = embeddingModel(profile);
const limits = DEFAULT_EMBEDDING_LIMITS;

// workers-types replaces the global Blob, so BunFile loses json() when both type sets load.
const recorded = JSON.parse(await Bun.file(values.fixture ?? new URL(`../../../${DEFAULT_FIXTURE}`, import.meta.url)).text()) as {
  readonly releaseId: string;
  readonly publication: FeedPublication;
};
const objects = new Map<string, unknown>();
const stream = searchProjectionObjects({
  indexRevision: `feed-${recorded.releaseId}`,
  corpusRevision: `feed:${recorded.releaseId}`,
  generatedAt: recorded.publication.index.generatedAt,
}, searchGroupsFromFeed(recorded.publication), { identifiers: searchIdentifierProfiles });
let next = await stream.next();
for (; !next.done; next = await stream.next()) objects.set(next.value.key, JSON.parse(new TextDecoder().decode(next.value.body)));
objects.set(SEARCH_CURRENT_KEY, next.value.descriptor.current);

const tokens = [...objects.values()]
  .filter((value): value is SearchLexicalShardV2 => Array.isArray((value as { chunks?: unknown }).chunks))
  .flatMap((shard) => shard.chunks.map((chunk) => estimateTokens(chunkEmbeddingText(chunk))))
  .sort((left, right) => left - right);
const totalTokens = tokens.reduce((sum, value) => sum + value, 0);

function memoryStorage(): EmbeddingStorage {
  const stored = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => stored.get(key) as T | undefined,
    put: async (key, value) => { stored.set(key, value); },
    putMany: async (entries) => { for (const [key, value] of Object.entries(entries)) stored.set(key, value); },
    delete: async (key) => stored.delete(key),
    deleteMany: async (keys) => { for (const key of keys) stored.delete(key); },
    list: async <T>(prefix: string) => new Map([...stored].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
  };
}

const index = new FakeVectorIndex(profile.revision.dimensions);
const state = new EmbeddingState(memoryStorage());
const zero = new Array<number>(profile.revision.dimensions).fill(0);
let hour = 0;
const run = (dryRun: boolean): Promise<EmbeddingRunResult> => runSearchEmbedding({
  bucket: { getJson: async (key) => objects.get(key) },
  index,
  embed: async (texts) => texts.map(() => zero),
  profile,
  state,
  now: () => new Date(Date.parse("2026-10-10T00:00:00.000Z") + hour * 3_600_000),
  delay: async () => undefined,
  dryRun,
});

const dry = await run(true);
const runs: EmbeddingRunResult[] = [];
do {
  runs.push(await run(false));
  hour += 1;
} while (runs.at(-1)!.pending > 0 && runs.at(-1)!.ok && runs.length < 100);
const backfillIndexCalls = index.calls.length;
const steady = await run(false);

const perChunk = totalTokens / tokens.length;
const scaledTokens = Math.round(perChunk * targetChunks);
// Whichever bound fills a call first: 50 texts, or 20,000 estimated tokens.
const scaledCalls = Math.max(Math.ceil(targetChunks / limits.batchTexts), Math.ceil(scaledTokens / limits.batchTokens));
const scaledNeurons = Math.max(scaledCalls, neurons(model, scaledTokens, 0));

console.log(JSON.stringify({
  source: values.fixture ?? DEFAULT_FIXTURE,
  releaseId: recorded.releaseId,
  profile: { key: profile.key, model: profile.revision.model, dimensions: profile.revision.dimensions, semanticRevision: profile.semanticRevision },
  bounds: limits,
  measured: {
    chunks: tokens.length,
    estimatedTokensPerChunk: { mean: Math.round(perChunk * 10) / 10, median: tokens[Math.floor(tokens.length / 2)], p95: tokens[Math.floor(tokens.length * 0.95)], max: tokens.at(-1) },
    dryRunEstimate: dry.estimate,
    backfill: {
      runs: runs.length,
      perRun: runs.map((result) => ({ embedded: result.embeddedThisRun, modelCalls: result.modelCalls, estimatedInputTokens: result.estimatedInputTokens, estimatedNeurons: result.estimatedNeurons, limited: result.limited })),
      modelCalls: runs.reduce((sum, result) => sum + result.modelCalls, 0),
      estimatedInputTokens: runs.reduce((sum, result) => sum + result.estimatedInputTokens, 0),
      estimatedNeurons: runs.reduce((sum, result) => sum + result.estimatedNeurons, 0),
      storedVectors: runs.at(-1)!.storedVectors,
      storedDimensions: runs.at(-1)!.storedDimensions,
      vectorIndexCalls: backfillIndexCalls,
    },
    unchangedReleaseRun: { modelCalls: steady.modelCalls, embedded: steady.embeddedThisRun, vectorIndexCalls: index.calls.length - backfillIndexCalls },
  },
  scaled: {
    chunks: targetChunks,
    storedDimensions: targetChunks * profile.revision.dimensions,
    estimatedInputTokens: scaledTokens,
    modelCalls: scaledCalls,
    estimatedNeurons: scaledNeurons,
    usd: Math.round(scaledNeurons * USD_PER_NEURON * 1e4) / 1e4,
    runs: Math.max(Math.ceil(targetChunks / limits.maxChunksPerRun), Math.ceil(scaledCalls / limits.maxCallsPerRun)),
    days: Math.max(Math.ceil(scaledCalls / limits.maxCallsPerDay), Math.ceil(scaledNeurons / limits.dailyNeuronCap)),
  },
}, null, 2));
