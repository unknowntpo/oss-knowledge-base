/**
 * Spec 016 slice 2b: one embedding run (Behavior 16–20). Pins the current Search release, embeds
 * the chunks the state does not hold at the profile's revision, upserts them into the project's
 * namespace, and deletes the vectors of chunks the release no longer holds. Every bound stops the
 * run with its progress recorded; the next run continues from the state.
 */
import { estimateTokens, neurons, PRICES, USD_PER_NEURON, type PricedModel } from "@oss-knowledge-base/reference-pipeline";
import { chunkEmbeddingText, type SourceRecordChunkV1 } from "@oss-knowledge-base/search";
import {
  chunkVectorRef,
  vectorRecord,
  type ChunkVectorRef,
  type EmbedTexts,
  type SearchEmbeddingProfile,
  type StoredVector,
  type VectorIndex,
} from "@oss-knowledge-base/semantic-vectorize";
import {
  isSearchCurrentPointer,
  isSearchLexicalShardV2,
  isSearchReleaseManifest,
  SEARCH_CURRENT_KEY,
  SEARCH_RELEASE_SCHEMA,
} from "@oss-knowledge-base/serving-contract";

import { errorShape, modelErrorKind, RETRY_DELAY_MS, type ModelErrorShape } from "../digest/model";
import { toModelCallError } from "../digest/workers-ai";
import type { EmbeddingState } from "./state";

export interface EmbeddingLimits {
  readonly maxChunksPerRun: number;
  /** Model requests per run, retries included; the search gateway allows 600 per hour. */
  readonly maxCallsPerRun: number;
  readonly maxCallsPerDay: number;
  /** Estimated neurons per UTC day; with the digest's 4,500 it stays under the 10,000 included. */
  readonly dailyNeuronCap: number;
  readonly batchTexts: number;
  readonly batchTokens: number;
  readonly deleteBatch: number;
  readonly maxDeletesPerRun: number;
  /** No batch starts after this long; an alarm has 15 minutes of wall time. */
  readonly deadlineMs: number;
  readonly callTimeoutMs: number;
}

export const DEFAULT_EMBEDDING_LIMITS: EmbeddingLimits = {
  maxChunksPerRun: 3_000,
  maxCallsPerRun: 80,
  maxCallsPerDay: 400,
  dailyNeuronCap: 3_000,
  batchTexts: 50,
  batchTokens: 20_000,
  deleteBatch: 100,
  maxDeletesPerRun: 2_000,
  deadlineMs: 10 * 60_000,
  callTimeoutMs: 60_000,
};

export type EmbeddingLimit =
  | "chunks-per-run" | "calls-per-run" | "calls-per-day" | "daily-neurons" | "deadline"
  | "model-limit" | "vector-store";

export type EmbeddingFailureKind = "config" | "release-read" | "model" | "model-limit" | "vector-store" | "internal";

/** What is left to embed and what it would cost under the bounds. */
export interface EmbeddingEstimate {
  readonly chunks: number;
  readonly calls: number;
  readonly inputTokens: number;
  readonly neurons: number;
  readonly usd: number;
  /** Runs needed under the per-run bounds, and UTC days under the daily ones. */
  readonly runs: number;
  readonly days: number;
}

export interface EmbeddingRunResult {
  readonly ok: boolean;
  readonly failureKind?: EmbeddingFailureKind;
  readonly error?: string;
  readonly dryRun: boolean;
  readonly completedAt: string;
  readonly durationMs: number;
  /** The Search release (`indexRevision`) the run read; null when it could not be read. */
  readonly releaseId: string | null;
  readonly model: string | null;
  readonly revision: string | null;
  readonly semanticRevision: string | null;
  /** Chunks read from the release, those with an accepted vector of this revision, and the rest. */
  readonly chunks: number;
  readonly embedded: number;
  readonly pending: number;
  readonly embeddedThisRun: number;
  readonly deletedThisRun: number;
  readonly deletePending: number;
  readonly storedVectors: number;
  readonly storedDimensions: number;
  readonly modelCalls: number;
  readonly estimatedInputTokens: number;
  readonly estimatedNeurons: number;
  readonly spentToday: { readonly date: string; readonly estimatedNeurons: number; readonly calls: number };
  readonly limited: EmbeddingLimit | null;
  /** Shapes of failed model calls (at most 10). */
  readonly modelErrors: readonly ModelErrorShape[];
  /** The index at the start of the run; `mutationsProcessed` is about the last mutation accepted before it. */
  readonly index: { readonly vectorCount: number; readonly mutationsProcessed: boolean | null } | null;
  readonly lastMutationId: string | null;
  readonly estimate: EmbeddingEstimate;
}

export interface ReleaseReader {
  getJson(key: string): Promise<unknown>;
}

export interface EmbeddingRunInput {
  readonly bucket: ReleaseReader;
  readonly index: VectorIndex;
  readonly embed: EmbedTexts;
  readonly profile: SearchEmbeddingProfile;
  readonly state: EmbeddingState;
  readonly now: () => Date;
  readonly delay: (ms: number) => Promise<void>;
  readonly dryRun: boolean;
  readonly limits?: Partial<EmbeddingLimits>;
}

class RunFailure extends Error {
  constructor(readonly kind: EmbeddingFailureKind, message: string) {
    super(message);
  }
}

const MAX_RECORDED_ERRORS = 10;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Rejects after `ms`, aborting the call's signal; the platform gives no other way to leave a hung call. */
async function withTimeout<T>(label: string, ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} did not answer within ${ms} ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Greedy batches of at most `batchTexts` texts and `batchTokens` estimated tokens. */
class BatchCount {
  batches = 0;
  private texts = 0;
  private tokens = 0;
  constructor(private readonly limits: EmbeddingLimits) {}
  add(tokens: number): void {
    if (this.texts > 0 && (this.texts + 1 > this.limits.batchTexts || this.tokens + tokens > this.limits.batchTokens)) {
      this.batches += 1;
      this.texts = 0;
      this.tokens = 0;
    }
    this.texts += 1;
    this.tokens += tokens;
  }
  get total(): number {
    return this.batches + (this.texts > 0 ? 1 : 0);
  }
}

interface PendingChunk {
  readonly ref: ChunkVectorRef;
  readonly chunk: SourceRecordChunkV1;
  readonly text: string;
  readonly tokens: number;
}

export function embeddingModel(profile: SearchEmbeddingProfile): PricedModel {
  if (!Object.hasOwn(PRICES, profile.revision.model)) throw new RunFailure("config", `No Workers AI price is recorded for ${profile.revision.model}`);
  return profile.revision.model as PricedModel;
}

/** Cost of embedding `tokens` in `calls` requests: every request counts at least one neuron. */
function estimatedNeurons(model: PricedModel, tokens: number, calls: number): number {
  return Math.max(calls, neurons(model, tokens, 0));
}

export function emptyEstimate(): EmbeddingEstimate {
  return { chunks: 0, calls: 0, inputTokens: 0, neurons: 0, usd: 0, runs: 0, days: 0 };
}

/** A result for a run that could not start. */
export function failedEmbeddingRun(kind: EmbeddingFailureKind, error: string, now: Date, dryRun: boolean, profile?: SearchEmbeddingProfile): EmbeddingRunResult {
  return {
    ok: false,
    failureKind: kind,
    error,
    dryRun,
    completedAt: now.toISOString(),
    durationMs: 0,
    releaseId: null,
    model: profile?.revision.model ?? null,
    revision: profile?.key ?? null,
    semanticRevision: profile?.semanticRevision ?? null,
    chunks: 0,
    embedded: 0,
    pending: 0,
    embeddedThisRun: 0,
    deletedThisRun: 0,
    deletePending: 0,
    storedVectors: 0,
    storedDimensions: 0,
    modelCalls: 0,
    estimatedInputTokens: 0,
    estimatedNeurons: 0,
    spentToday: { date: now.toISOString().slice(0, 10), estimatedNeurons: 0, calls: 0 },
    limited: null,
    modelErrors: [],
    index: null,
    lastMutationId: null,
    estimate: emptyEstimate(),
  };
}

export async function runSearchEmbedding(input: EmbeddingRunInput): Promise<EmbeddingRunResult> {
  const limits: EmbeddingLimits = { ...DEFAULT_EMBEDDING_LIMITS, ...input.limits };
  const { profile, state, index, dryRun } = input;
  const startedAt = input.now().getTime();
  const today = () => input.now().toISOString().slice(0, 10);
  const dimensions = profile.revision.dimensions;

  // Assigned inside the helpers below, so it is held in an object the compiler does not narrow.
  const run: { failure?: { readonly kind: EmbeddingFailureKind; readonly error: string }; limited: EmbeddingLimit | null } = { limited: null };
  let releaseId: string | null = null;
  let chunks = 0;
  let embedded = 0;
  let embeddedThisRun = 0;
  let deletedThisRun = 0;
  let deletePending = 0;
  let modelCalls = 0;
  let inputTokens = 0;
  let spentNeurons = 0;
  let modelFailures = 0;
  let lastModelError = "";
  let indexInfo: EmbeddingRunResult["index"] = null;
  let lastMutationId: string | null = null;
  let entries = new Map<string, { readonly p: string; readonly h: string; readonly r: string }>();
  const modelErrors: ModelErrorShape[] = [];
  const left = { chunks: 0, tokens: 0, batches: new BatchCount(limits) };
  const leave = (items: readonly PendingChunk[]) => {
    for (const item of items) {
      left.chunks += 1;
      left.tokens += item.tokens;
      left.batches.add(item.tokens);
    }
  };

  const read = async (key: string): Promise<unknown> => {
    let value: unknown;
    try {
      value = await input.bucket.getJson(key);
    } catch (error) {
      throw new RunFailure("release-read", `Reading ${key} failed: ${message(error)}`);
    }
    if (value === undefined || value === null) throw new RunFailure("release-read", `${key} is missing`);
    return value;
  };

  /** One model request, counted in the ledger before it is made; `undefined` when it must not or did not succeed. */
  const embedBatch = async (model: PricedModel, texts: readonly string[], tokens: number): Promise<readonly (readonly number[])[] | undefined> => {
    const estimate = Math.max(1, neurons(model, tokens, 0));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const date = today();
      const ledger = await state.ledger(date);
      if (modelCalls >= limits.maxCallsPerRun) run.limited = "calls-per-run";
      else if (ledger.calls >= limits.maxCallsPerDay) run.limited = "calls-per-day";
      else if (ledger.neurons + estimate > limits.dailyNeuronCap) run.limited = "daily-neurons";
      if (run.limited !== null) return undefined;
      await state.reserve(date, estimate);
      modelCalls += 1;
      inputTokens += tokens;
      spentNeurons += estimate;
      try {
        const vectors = await withTimeout("The embedding model", limits.callTimeoutMs, (signal) => input.embed(texts, signal));
        if (vectors.length !== texts.length) throw new Error(`Embedding response has ${vectors.length} vectors, expected ${texts.length}`);
        for (const vector of vectors) {
          if (vector.length !== dimensions) throw new Error(`Embedding has ${vector.length} dimensions, expected ${dimensions}`);
        }
        return vectors;
      } catch (error) {
        const mapped = toModelCallError(error);
        const kind = modelErrorKind(mapped);
        lastModelError = mapped.message;
        if (modelErrors.length < MAX_RECORDED_ERRORS) modelErrors.push(errorShape(model, kind, mapped));
        if (kind === "limit") {
          run.limited = "model-limit";
          return undefined;
        }
        if (attempt === 0) await input.delay(RETRY_DELAY_MS);
      }
    }
    modelFailures += 1;
    return undefined;
  };

  /** A mutation the index accepted, or `undefined` after two failures. */
  const mutate = async (label: string, call: () => Promise<{ readonly mutationId: string }>): Promise<string | undefined> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let mutationId: string;
      try {
        ({ mutationId } = await withTimeout(label, limits.callTimeoutMs, call));
      } catch (error) {
        if (attempt === 0) await input.delay(RETRY_DELAY_MS);
        else run.failure = { kind: "vector-store", error: `${label} failed: ${message(error)}` };
        continue;
      }
      await state.acceptMutation({ id: mutationId, acceptedAt: input.now().toISOString() });
      lastMutationId = mutationId;
      return mutationId;
    }
    return undefined;
  };

  try {
    const model = embeddingModel(profile);
    entries = await state.entries();
    lastMutationId = (await state.lastMutation())?.id ?? null;
    if (!dryRun) {
      let info: Awaited<ReturnType<VectorIndex["describe"]>>;
      try {
        info = await withTimeout("The vector index", limits.callTimeoutMs, () => index.describe());
      } catch (error) {
        throw new RunFailure("vector-store", `The vector index did not answer: ${message(error)}`);
      }
      if (info.dimensions !== dimensions) {
        throw new RunFailure("config", `The vector index has ${info.dimensions} dimensions; ${profile.key} needs ${dimensions}`);
      }
      indexInfo = {
        vectorCount: info.vectorCount,
        mutationsProcessed: lastMutationId === null ? null : String(info.processedUpToMutation) === lastMutationId,
      };
    }

    const pointer = await read(SEARCH_CURRENT_KEY);
    if (!isSearchCurrentPointer(pointer)) throw new RunFailure("release-read", "The Search current pointer is invalid");
    const manifest = await read(pointer.releaseManifestKey);
    if (!isSearchReleaseManifest(manifest) || manifest.schema !== SEARCH_RELEASE_SCHEMA) {
      throw new RunFailure("release-read", `Search release ${pointer.indexRevision} is not an ${SEARCH_RELEASE_SCHEMA}`);
    }
    releaseId = manifest.indexRevision;

    const seen = new Set<string>();
    let queue: PendingChunk[] = [];
    const drain = async (final: boolean): Promise<void> => {
      while (queue.length > 0) {
        if (dryRun || run.limited !== null) {
          leave(queue);
          queue = [];
          return;
        }
        const room = limits.maxChunksPerRun - embeddedThisRun;
        if (room <= 0) {
          run.limited = "chunks-per-run";
          continue;
        }
        let size = 0;
        let tokens = 0;
        while (size < queue.length && size < limits.batchTexts && size < room && (size === 0 || tokens + queue[size]!.tokens <= limits.batchTokens)) {
          tokens += queue[size]!.tokens;
          size += 1;
        }
        // A batch the next shard could still fill waits for it.
        if (!final && size === queue.length && size < limits.batchTexts && size < room) return;
        if (input.now().getTime() - startedAt >= limits.deadlineMs) {
          run.limited = "deadline";
          continue;
        }
        const batch = queue.slice(0, size);
        queue = queue.slice(size);
        const vectors = await embedBatch(model, batch.map((item) => item.text), tokens);
        if (vectors === undefined) {
          leave(batch);
          continue;
        }
        const records: StoredVector[] = batch.map((item, position) => vectorRecord(item.ref, item.chunk, vectors[position]!, profile.semanticRevision));
        if (await mutate("The vector upsert", () => index.upsert(records)) === undefined) {
          // The store is down: more model calls would be paid for and lost.
          run.limited = "vector-store";
          leave(batch);
          continue;
        }
        const recorded = batch.map((item) => [item.ref.id, { p: item.chunk.projectId, h: item.ref.fingerprint, r: profile.semanticRevision }] as const);
        await state.record(recorded);
        for (const [id, entry] of recorded) entries.set(id, entry);
        embeddedThisRun += batch.length;
        embedded += batch.length;
      }
    };

    for (const shardRef of manifest.shards) {
      const shard = await read(shardRef.key);
      if (!isSearchLexicalShardV2(shard) || shard.indexRevision !== manifest.indexRevision) {
        throw new RunFailure("release-read", `Search shard ${shardRef.key} is invalid`);
      }
      for (const chunk of shard.chunks) {
        const ref = await chunkVectorRef(chunk);
        if (seen.has(ref.id)) throw new RunFailure("release-read", `Search release ${releaseId} holds two chunks for ${chunk.recordId} #${chunk.ordinal}`);
        seen.add(ref.id);
        chunks += 1;
        const entry = entries.get(ref.id);
        if (entry !== undefined && entry.h === ref.fingerprint && entry.r === profile.semanticRevision) {
          embedded += 1;
          continue;
        }
        const text = chunkEmbeddingText(chunk);
        queue.push({ ref, chunk, text, tokens: estimateTokens(text) });
      }
      await drain(false);
    }
    await drain(true);
    // Nothing is deleted from a release that was not read whole.
    if (chunks !== manifest.chunkCount) {
      throw new RunFailure("release-read", `Search release ${releaseId} declares ${manifest.chunkCount} chunks; its shards hold ${chunks}`);
    }

    const stale = [...entries.keys()].filter((id) => !seen.has(id));
    deletePending = stale.length;
    if (!dryRun && run.limited !== "vector-store") {
      for (let start = 0; start < stale.length && start < limits.maxDeletesPerRun; start += limits.deleteBatch) {
        if (input.now().getTime() - startedAt >= limits.deadlineMs) {
          run.limited ??= "deadline";
          break;
        }
        const ids = stale.slice(start, Math.min(start + limits.deleteBatch, limits.maxDeletesPerRun));
        if (await mutate("The vector delete", () => index.deleteByIds([...ids])) === undefined) break;
        await state.forget(ids);
        for (const id of ids) entries.delete(id);
        deletedThisRun += ids.length;
        deletePending -= ids.length;
      }
    }
    if (run.failure === undefined && run.limited === "model-limit") run.failure = { kind: "model-limit", error: lastModelError };
    if (run.failure === undefined && modelFailures > 0) run.failure = { kind: "model", error: lastModelError };
  } catch (error) {
    run.failure = error instanceof RunFailure ? { kind: error.kind, error: error.message } : { kind: "internal", error: message(error) };
  }

  const now = input.now();
  const ledger = await state.ledger(now.toISOString().slice(0, 10)).catch(() => ({ neurons: 0, calls: 0 }));
  const model = Object.hasOwn(PRICES, profile.revision.model) ? profile.revision.model as PricedModel : undefined;
  const leftCalls = left.batches.total;
  const leftNeurons = model === undefined ? 0 : estimatedNeurons(model, left.tokens, leftCalls);
  return {
    ok: run.failure === undefined,
    ...(run.failure === undefined ? {} : { failureKind: run.failure.kind, error: run.failure.error }),
    dryRun,
    completedAt: now.toISOString(),
    durationMs: now.getTime() - startedAt,
    releaseId,
    model: profile.revision.model,
    revision: profile.key,
    semanticRevision: profile.semanticRevision,
    chunks,
    embedded,
    pending: chunks - embedded,
    embeddedThisRun,
    deletedThisRun,
    deletePending,
    storedVectors: entries.size,
    storedDimensions: entries.size * dimensions,
    modelCalls,
    estimatedInputTokens: inputTokens,
    estimatedNeurons: spentNeurons,
    spentToday: { date: now.toISOString().slice(0, 10), estimatedNeurons: ledger.neurons, calls: ledger.calls },
    limited: run.limited,
    modelErrors,
    index: indexInfo,
    lastMutationId,
    estimate: {
      chunks: left.chunks,
      calls: leftCalls,
      inputTokens: left.tokens,
      neurons: leftNeurons,
      usd: Math.round(leftNeurons * USD_PER_NEURON * 1e6) / 1e6,
      runs: Math.max(Math.ceil(left.chunks / limits.maxChunksPerRun), Math.ceil(leftCalls / limits.maxCallsPerRun)),
      days: Math.max(Math.ceil(leftCalls / limits.maxCallsPerDay), Math.ceil(leftNeurons / limits.dailyNeuronCap)),
    },
  };
}
