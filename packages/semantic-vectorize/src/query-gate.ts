/**
 * Spec 016 slice 3 (Behavior 32–35): the one place a search query may spend on the embedding
 * model and the vector index. It holds the day's ledger, the query-embedding cache, and the
 * match cache, so the caps are hard and a repeated query costs nothing. It imports no Workers
 * type: the Durable Object that hosts it passes storage, the embedder, and the index.
 */
import { parseSemanticMatch, proposeSemanticMatches, type SemanticMatchV1 } from "./matches";
import type { SearchEmbeddingProfile } from "./revision";
import { errorText, sanitizeErrorMessage } from "./sanitize";
import { VECTOR_LIMITS, type VectorIndex } from "./vector-index";
import { vectorNamespace } from "./vector";
import type { EmbedTexts } from "./workers-ai";

export interface SemanticQueryRequestV1 {
  readonly query: string;
  /** The namespaces to ask: every project of the served release, whatever the project filter. */
  readonly projectIds: readonly string[];
}

/** What a caller learns. No error text crosses this boundary. */
export type SemanticQueryAnswerV1 =
  | { readonly status: "ok"; readonly semanticRevision: string; readonly cached: boolean; readonly matches: readonly SemanticMatchV1[] }
  /** A cap is spent; no call before `retryAfterMs` from now can succeed. */
  | { readonly status: "over-budget"; readonly retryAfterMs: number }
  | { readonly status: "disabled" }
  | { readonly status: "failed" };

/** The seam the reader depends on; the Durable Object client and the gate itself both satisfy it. */
export interface SemanticQueryPort {
  query(request: SemanticQueryRequestV1, signal?: AbortSignal): Promise<SemanticQueryAnswerV1>;
}

export const MAX_SEMANTIC_QUERY_CHARACTERS = 500;

/** The name of the one gate object; the Pages reader and the data Worker address it by this name. */
export const SEARCH_QUERY_GATE_OBJECT_NAME = "search-query-gate-v1";

/**
 * The text that is embedded and that keys the caches: NFKC, runs of whitespace as one space,
 * trimmed. Case is kept, because it carries meaning for the model (`KRaft`, `EndTxn`).
 */
export function normalizeSemanticQuery(query: string): string {
  return query.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/**
 * An upper bound on the neurons one query embedding costs, not an estimate. The model's
 * tokenizer (SentencePiece over NFKC text) emits no more pieces than the text has characters,
 * plus the word-start marker and the two sentence markers. Every call counts at least 1, as in
 * the embedding job's ledger.
 */
export function queryNeuronCharge(normalizedQuery: string, neuronsPerMillionTokens: number): number {
  return Math.max(1, Math.ceil(((normalizedQuery.length + 3) * neuronsPerMillionTokens) / 1_000_000));
}

export interface QueryGateLimits {
  /** Upper-bound neurons of query embeddings per UTC day. */
  readonly dailyNeuronCap: number;
  /** Vector index queries (one per project namespace) per UTC day. */
  readonly maxIndexQueriesPerDay: number;
  /** Model calls per clock hour, so queries cannot use up the gateway's hourly rate for the embedding job. */
  readonly maxModelCallsPerHour: number;
  readonly topK: number;
  /** How long a namespace's matches for a query are reused; stale matches are harmless (Behavior 22). */
  readonly matchTtlMs: number;
  /** A cached query embedding is dropped this many UTC days after it was made. */
  readonly vectorRetentionDays: number;
  /** A model or index call is abandoned after this long. */
  readonly callTimeoutMs: number;
  /** After the platform refuses a call (rate or spend limit), no model call is made for this long. */
  readonly pauseAfterRefusalMs: number;
  readonly maxProjects: number;
  /** Expired cache entries removed by each query that embeds. */
  readonly evictPerMiss: number;
}

/** Arithmetic: Spec 016 Results (slice 3), "Query budget". */
export const DEFAULT_QUERY_GATE_LIMITS: QueryGateLimits = {
  dailyNeuronCap: 1_000,
  maxIndexQueriesPerDay: 1_000,
  maxModelCallsPerHour: 100,
  topK: VECTOR_LIMITS.topKWithMetadata,
  matchTtlMs: 3_600_000,
  vectorRetentionDays: 7,
  callTimeoutMs: 10_000,
  pauseAfterRefusalMs: 15 * 60_000,
  maxProjects: 8,
  evictPerMiss: 4,
};

/** The subset of Durable Object storage the gate uses. */
export interface QueryGateStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  /** Keys with `prefix`, ascending, at most `limit`. */
  list<T>(options: { readonly prefix: string; readonly limit?: number }): Promise<Map<string, T>>;
}

export type QueryGateConfig =
  | { readonly state: "off" }
  | { readonly state: "error"; readonly error: string }
  | { readonly state: "on"; readonly profile: SearchEmbeddingProfile; readonly embed: EmbedTexts; readonly index: VectorIndex };

export interface QueryGateDeps {
  readonly storage: QueryGateStorage;
  /** Resolved per call from the object's variables and bindings. */
  readonly config: () => QueryGateConfig;
  /** Neurons per million input tokens of the profile's model. */
  readonly neuronsPerMillionTokens: number;
  /** Whether an error is the platform refusing the call (Workers AI 3036, a gateway 429, a spend limit). */
  readonly isRefusal: (error: unknown) => boolean;
  readonly now: () => Date;
  readonly limits?: Partial<QueryGateLimits>;
}

export interface QueryDayLedger {
  /** Upper-bound neurons of every model call started today (UTC), failed ones included. */
  readonly neurons: number;
  readonly modelCalls: number;
  readonly indexQueries: number;
  /** The clock hour `hourModelCalls` counts, as `YYYY-MM-DDTHH`. */
  readonly hour: string;
  readonly hourModelCalls: number;
}

export interface QueryGateError {
  readonly kind: "model" | "model-limit" | "vector-store" | "internal";
  readonly message: string;
  readonly at: string;
}

export interface QueryGateHealth {
  readonly enabled: boolean;
  readonly configError?: string;
  readonly semanticRevision: string | null;
  readonly today: QueryDayLedger & {
    readonly date: string;
    readonly neuronCap: number;
    readonly indexQueryCap: number;
    readonly hourModelCallCap: number;
  };
  /** Model calls are paused until this time after a refusal; null otherwise. */
  readonly pausedUntil: string | null;
  readonly lastError: QueryGateError | null;
  /** Counted in memory since the object last started; they reset when the platform evicts it. */
  readonly sinceStart: { readonly requests: number; readonly cached: number; readonly embedded: number; readonly overBudget: number; readonly failed: number };
}

interface StoredVector { readonly day: string; readonly vector: Float32Array | readonly number[] }
interface StoredMatches { readonly at: number; readonly matches: readonly unknown[] }

const LAST_ERROR = "last-error";
const PAUSED = "paused-until";
const HEX = 32;
const encoder = new TextEncoder();

async function cacheKey(semanticRevision: string, normalizedQuery: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${semanticRevision}\u0000${normalizedQuery}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, HEX);
}

const dayOf = (now: Date) => now.toISOString().slice(0, 10);
const hourOf = (now: Date) => now.toISOString().slice(0, 13);

/** Rejects after `ms` and aborts the call's signal. */
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

class Refused extends Error {
  constructor(readonly retryAfterMs: number) {
    super("over budget");
  }
}

export class SemanticQueryGate implements SemanticQueryPort {
  private readonly limits: QueryGateLimits;
  /** Identical concurrent queries share one answer, so they make one model call. */
  private readonly flights = new Map<string, Promise<SemanticQueryAnswerV1>>();
  /** Serializes ledger updates: check and write happen with nothing in between. */
  private ledgerLock: Promise<unknown> = Promise.resolve();
  private readonly counters = { requests: 0, cached: 0, embedded: 0, overBudget: 0, failed: 0 };

  constructor(private readonly deps: QueryGateDeps) {
    this.limits = { ...DEFAULT_QUERY_GATE_LIMITS, ...deps.limits };
  }

  async query(request: SemanticQueryRequestV1): Promise<SemanticQueryAnswerV1> {
    this.counters.requests += 1;
    let answer: SemanticQueryAnswerV1;
    try {
      answer = await this.answer(request);
    } catch (error) {
      await this.recordError("internal", error);
      answer = { status: "failed" };
    }
    if (answer.status === "ok") this.counters[answer.cached ? "cached" : "embedded"] += 1;
    else if (answer.status === "over-budget") this.counters.overBudget += 1;
    else if (answer.status === "failed") this.counters.failed += 1;
    return answer;
  }

  private async answer(request: SemanticQueryRequestV1): Promise<SemanticQueryAnswerV1> {
    const config = this.deps.config();
    if (config.state === "off") return { status: "disabled" };
    if (config.state === "error") {
      await this.recordError("internal", config.error);
      return { status: "failed" };
    }
    const query = typeof request?.query === "string" ? normalizeSemanticQuery(request.query) : "";
    const projectIds = Array.isArray(request?.projectIds) ? [...new Set(request.projectIds)].sort() : [];
    if (query === "" || query.length > MAX_SEMANTIC_QUERY_CHARACTERS || projectIds.length === 0 || projectIds.length > this.limits.maxProjects) {
      return { status: "failed" };
    }
    for (const projectId of projectIds) {
      if (typeof projectId !== "string") return { status: "failed" };
      vectorNamespace(projectId);
    }
    const key = await cacheKey(config.profile.semanticRevision, query);
    const flightKey = `${key}|${projectIds.join("\u0000")}`;
    const running = this.flights.get(flightKey);
    if (running !== undefined) return running;
    const flight = this.resolve(config, key, query, projectIds).finally(() => this.flights.delete(flightKey));
    this.flights.set(flightKey, flight);
    return flight;
  }

  private async resolve(
    config: Extract<QueryGateConfig, { state: "on" }>,
    key: string,
    query: string,
    projectIds: readonly string[],
  ): Promise<SemanticQueryAnswerV1> {
    const semanticRevision = config.profile.semanticRevision;
    const now = this.deps.now().getTime();
    const matches: SemanticMatchV1[] = [];
    const missing: string[] = [];
    for (const projectId of projectIds) {
      const stored = await this.deps.storage.get<StoredMatches>(matchKey(key, projectId));
      if (stored === undefined || !(now - stored.at < this.limits.matchTtlMs) || !(now >= stored.at)) missing.push(projectId);
      else matches.push(...readMatches(stored.matches, projectId));
    }
    if (missing.length === 0) return { status: "ok", semanticRevision, cached: true, matches };

    const stored = await this.deps.storage.get<StoredVector>(vectorKey(key));
    let vector = stored === undefined || stored.vector.length !== config.profile.revision.dimensions ? undefined : [...stored.vector];
    const embedding = vector === undefined;
    try {
      await this.reserve(embedding ? queryNeuronCharge(query, this.deps.neuronsPerMillionTokens) : 0, missing.length);
    } catch (error) {
      if (error instanceof Refused) return { status: "over-budget", retryAfterMs: error.retryAfterMs };
      throw error;
    }

    if (vector === undefined) {
      try {
        const vectors = await withTimeout("The embedding model", this.limits.callTimeoutMs, (signal) => config.embed([query], signal));
        const [first, ...rest] = vectors;
        if (first === undefined || rest.length > 0) throw new Error("Query embedding did not return one vector");
        if (first.length !== config.profile.revision.dimensions) {
          throw new Error(`Embedding has ${first.length} dimensions, expected ${config.profile.revision.dimensions}`);
        }
        vector = [...first];
      } catch (error) {
        const refusal = this.deps.isRefusal(error);
        if (refusal) await this.deps.storage.put(PAUSED, this.deps.now().getTime() + this.limits.pauseAfterRefusalMs);
        await this.recordError(refusal ? "model-limit" : "model", error);
        return { status: "failed" };
      }
      // A cache write that fails costs a later model call, never this answer.
      await this.remember(key, vector).catch((error) => this.recordError("internal", error));
    }

    let proposed: readonly SemanticMatchV1[];
    try {
      const queryVector = vector;
      proposed = await withTimeout("The vector index", this.limits.callTimeoutMs, () => proposeSemanticMatches({
        index: config.index,
        vector: queryVector,
        projectIds: missing,
        topK: this.limits.topK,
        semanticRevision,
      }));
    } catch (error) {
      await this.recordError("vector-store", error);
      return { status: "failed" };
    }
    const at = this.deps.now().getTime();
    await Promise.all(missing.map((projectId) =>
      this.deps.storage.put(matchKey(key, projectId), { at, matches: proposed.filter((match) => match.projectId === projectId) } satisfies StoredMatches)))
      .catch((error) => this.recordError("internal", error));
    return { status: "ok", semanticRevision, cached: !embedding, matches: [...matches, ...proposed] };
  }

  /**
   * Counts a model call and index queries before they are made, or throws `Refused` and counts
   * nothing. One at a time, so concurrent distinct queries cannot pass a cap together.
   */
  private reserve(neurons: number, indexQueries: number): Promise<void> {
    const run = async (): Promise<void> => {
      const now = this.deps.now();
      const date = dayOf(now);
      const hour = hourOf(now);
      const before = await this.ledger(now);
      const untilTomorrow = Date.parse(`${date}T00:00:00.000Z`) + 86_400_000 - now.getTime();
      if (before.indexQueries + indexQueries > this.limits.maxIndexQueriesPerDay) throw new Refused(untilTomorrow);
      if (neurons > 0) {
        const pausedUntil = (await this.deps.storage.get<number>(PAUSED)) ?? 0;
        if (pausedUntil > now.getTime()) throw new Refused(pausedUntil - now.getTime());
        if (before.neurons + neurons > this.limits.dailyNeuronCap) throw new Refused(untilTomorrow);
        if (before.hourModelCalls + 1 > this.limits.maxModelCallsPerHour) {
          throw new Refused(Date.parse(`${hour}:00:00.000Z`) + 3_600_000 - now.getTime());
        }
      }
      await this.deps.storage.put(`spend:${date}`, {
        neurons: before.neurons + neurons,
        modelCalls: before.modelCalls + (neurons > 0 ? 1 : 0),
        indexQueries: before.indexQueries + indexQueries,
        hour,
        hourModelCalls: before.hourModelCalls + (neurons > 0 ? 1 : 0),
      } satisfies QueryDayLedger);
    };
    const result = this.ledgerLock.then(run, run);
    this.ledgerLock = result.catch(() => undefined);
    return result;
  }

  private async ledger(now: Date): Promise<QueryDayLedger> {
    const hour = hourOf(now);
    const stored = (await this.deps.storage.get<QueryDayLedger>(`spend:${dayOf(now)}`)) ?? { neurons: 0, modelCalls: 0, indexQueries: 0, hour, hourModelCalls: 0 };
    return stored.hour === hour ? stored : { ...stored, hour, hourModelCalls: 0 };
  }

  /** Stores a query embedding with the day it was made, then drops a few entries past retention. */
  private async remember(key: string, vector: readonly number[]): Promise<void> {
    const day = dayOf(this.deps.now());
    await this.deps.storage.put(vectorKey(key), { day, vector: Float32Array.from(vector) } satisfies StoredVector);
    await this.deps.storage.put(`${MARKER}${day}:${key}`, 1);
    const cutoff = dayOf(new Date(this.deps.now().getTime() - this.limits.vectorRetentionDays * 86_400_000));
    const oldest = await this.deps.storage.list<number>({ prefix: MARKER, limit: this.limits.evictPerMiss });
    for (const marker of oldest.keys()) {
      const [markerDay, markerKey] = [marker.slice(MARKER.length, MARKER.length + 10), marker.slice(MARKER.length + 11)];
      if (!(markerDay < cutoff)) break;
      const current = await this.deps.storage.get<StoredVector>(vectorKey(markerKey));
      // A query embedded again after it expired has a newer marker: only the old marker goes.
      const stale = current !== undefined && current.day !== markerDay
        ? [marker]
        : [marker, vectorKey(markerKey), ...(await this.deps.storage.list({ prefix: `${MATCHES}${markerKey}:` })).keys()];
      await this.deps.storage.delete(stale);
    }
  }

  private async recordError(kind: QueryGateError["kind"], error: unknown): Promise<void> {
    const entry: QueryGateError = { kind, message: typeof error === "string" ? sanitizeErrorMessage(error) : errorText(error), at: this.deps.now().toISOString() };
    console.error(`semantic query gate: ${entry.kind}: ${entry.message}`);
    await this.deps.storage.put(LAST_ERROR, entry).catch(() => undefined);
  }

  async health(): Promise<QueryGateHealth> {
    const config = this.deps.config();
    const now = this.deps.now();
    const pausedUntil = (await this.deps.storage.get<number>(PAUSED)) ?? 0;
    return {
      enabled: config.state === "on",
      ...(config.state === "error" ? { configError: sanitizeErrorMessage(config.error) } : {}),
      semanticRevision: config.state === "on" ? config.profile.semanticRevision : null,
      today: {
        date: dayOf(now),
        ...(await this.ledger(now)),
        neuronCap: this.limits.dailyNeuronCap,
        indexQueryCap: this.limits.maxIndexQueriesPerDay,
        hourModelCallCap: this.limits.maxModelCallsPerHour,
      },
      pausedUntil: pausedUntil > now.getTime() ? new Date(pausedUntil).toISOString() : null,
      lastError: (await this.deps.storage.get<QueryGateError>(LAST_ERROR)) ?? null,
      sinceStart: { ...this.counters },
    };
  }
}

const VECTORS = "q:";
const MATCHES = "m:";
const MARKER = "e:";
const vectorKey = (key: string) => `${VECTORS}${key}`;
const matchKey = (key: string, projectId: string) => `${MATCHES}${key}:${projectId}`;

function readMatches(values: readonly unknown[], projectId: string): SemanticMatchV1[] {
  const matches: SemanticMatchV1[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const match = parseSemanticMatch(value);
    if (match !== undefined && match.projectId === projectId) matches.push(match);
  }
  return matches;
}

/** `/health` `searchQuery` where the gate object is not bound (Prod, local, Dev before the enable). */
export function unboundQueryGateHealth(now: Date, limits: QueryGateLimits = DEFAULT_QUERY_GATE_LIMITS): QueryGateHealth {
  return {
    enabled: false,
    semanticRevision: null,
    today: {
      date: dayOf(now), neurons: 0, modelCalls: 0, indexQueries: 0, hour: hourOf(now), hourModelCalls: 0,
      neuronCap: limits.dailyNeuronCap, indexQueryCap: limits.maxIndexQueriesPerDay, hourModelCallCap: limits.maxModelCallsPerHour,
    },
    pausedUntil: null,
    lastError: null,
    sinceStart: { requests: 0, cached: 0, embedded: 0, overBudget: 0, failed: 0 },
  };
}

/** An answer read from another process: anything malformed is `failed`, and bad matches are dropped. */
export function parseSemanticQueryAnswer(value: unknown): SemanticQueryAnswerV1 {
  if (value === null || typeof value !== "object") return { status: "failed" };
  const answer = value as Record<string, unknown>;
  if (answer.status === "disabled") return { status: "disabled" };
  if (answer.status === "over-budget") {
    const retryAfterMs = typeof answer.retryAfterMs === "number" && Number.isFinite(answer.retryAfterMs) && answer.retryAfterMs > 0 ? answer.retryAfterMs : 0;
    return { status: "over-budget", retryAfterMs };
  }
  if (answer.status !== "ok" || typeof answer.semanticRevision !== "string" || answer.semanticRevision === "" || !Array.isArray(answer.matches)) {
    return { status: "failed" };
  }
  const matches: SemanticMatchV1[] = [];
  for (const item of answer.matches) {
    const match = parseSemanticMatch(item);
    if (match !== undefined) matches.push(match);
  }
  return { status: "ok", semanticRevision: answer.semanticRevision, cached: answer.cached === true, matches };
}
