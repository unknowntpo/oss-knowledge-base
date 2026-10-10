/**
 * Spec 016 Behavior 18: what the embedding object remembers. One small entry per stored vector,
 * the day's ledger, and the last accepted mutation. Durable Object storage is strongly
 * consistent and written per batch, so progress survives a run that dies; the vector index is
 * never asked which chunks it holds, because its mutations are applied asynchronously.
 */
export interface EmbeddingStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  putMany(entries: Readonly<Record<string, unknown>>): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteMany(keys: readonly string[]): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/** A vector the index accepted: its project (namespace), fingerprint, and semantic revision. */
export interface VectorStateEntry {
  readonly p: string;
  readonly h: string;
  readonly r: string;
}

export interface DayLedger {
  /** Estimated neurons of every model call started today (UTC), failed ones included. */
  readonly neurons: number;
  readonly calls: number;
  /** How many of `calls` were retries of texts that failed alone before (and their probes). */
  readonly retryCalls?: number;
}

export interface AcceptedMutation {
  readonly id: string;
  readonly acceptedAt: string;
}

/** Consecutive runs in which a chunk's batch failed, for the fingerprint and revision it failed at. */
export interface FailureEntry {
  readonly h: string;
  readonly r: string;
  readonly n: number;
  readonly at: string;
}

/** Consecutive releases that held no chunk of a project, and the last release counted. */
export interface AbsenceEntry {
  readonly releases: number;
  readonly releaseId: string;
}

/** The last model or vector-store failure, kept until a later run embeds successfully. */
export interface LastEmbeddingError {
  readonly kind: "model" | "model-limit" | "vector-store";
  readonly message: string;
  readonly at: string;
  /** Texts or vectors in the call that failed; 0 when no batch was involved. */
  readonly batchSize: number;
}

const VECTOR_PREFIX = "v:";
const FAILURE_PREFIX = "f:";
const ABSENCE_PREFIX = "absent:";
const LAST_MUTATION = "last-mutation";
const LAST_ERROR = "last-error";
// Durable Object storage accepts at most 128 keys per put or delete.
const STORAGE_BATCH = 100;

export class EmbeddingState {
  constructor(private readonly storage: EmbeddingStorage) {}

  /** Every recorded vector by id. About 100 bytes each: 30,000 chunks are about 3 MB. */
  async entries(): Promise<Map<string, VectorStateEntry>> {
    return this.listAt<VectorStateEntry>(VECTOR_PREFIX);
  }

  private async listAt<T>(prefix: string): Promise<Map<string, T>> {
    return new Map([...(await this.storage.list<T>(prefix))].map(([key, value]) => [key.slice(prefix.length), value]));
  }

  private async putAt(prefix: string, entries: readonly (readonly [string, unknown])[]): Promise<void> {
    for (let index = 0; index < entries.length; index += STORAGE_BATCH) {
      await this.storage.putMany(Object.fromEntries(entries.slice(index, index + STORAGE_BATCH).map(([id, entry]) => [`${prefix}${id}`, entry])));
    }
  }

  private async deleteAt(prefix: string, ids: readonly string[]): Promise<void> {
    for (let index = 0; index < ids.length; index += STORAGE_BATCH) {
      await this.storage.deleteMany(ids.slice(index, index + STORAGE_BATCH).map((id) => `${prefix}${id}`));
    }
  }

  async record(entries: readonly (readonly [string, VectorStateEntry])[]): Promise<void> {
    await this.putAt(VECTOR_PREFIX, entries);
  }

  async forget(ids: readonly string[]): Promise<void> {
    await this.deleteAt(VECTOR_PREFIX, ids);
  }

  failures(): Promise<Map<string, FailureEntry>> {
    return this.listAt<FailureEntry>(FAILURE_PREFIX);
  }

  async recordFailures(entries: readonly (readonly [string, FailureEntry])[]): Promise<void> {
    await this.putAt(FAILURE_PREFIX, entries);
  }

  async forgetFailures(ids: readonly string[]): Promise<void> {
    await this.deleteAt(FAILURE_PREFIX, ids);
  }

  absences(): Promise<Map<string, AbsenceEntry>> {
    return this.listAt<AbsenceEntry>(ABSENCE_PREFIX);
  }

  async recordAbsence(projectId: string, entry: AbsenceEntry): Promise<void> {
    await this.storage.put(`${ABSENCE_PREFIX}${projectId}`, entry);
  }

  async forgetAbsences(projectIds: readonly string[]): Promise<void> {
    await this.deleteAt(ABSENCE_PREFIX, projectIds);
  }

  async lastError(): Promise<LastEmbeddingError | undefined> {
    return this.storage.get<LastEmbeddingError>(LAST_ERROR);
  }

  async recordError(error: LastEmbeddingError): Promise<void> {
    await this.storage.put(LAST_ERROR, error);
  }

  async clearError(): Promise<void> {
    if (await this.lastError() !== undefined) await this.storage.delete(LAST_ERROR);
  }

  async ledger(date: string): Promise<DayLedger> {
    return (await this.storage.get<DayLedger>(`spend:${date}`)) ?? { neurons: 0, calls: 0 };
  }

  /** Counts one model call before it is made, so an attempt that dies is still counted. */
  async reserve(date: string, neurons: number, retry = false): Promise<DayLedger> {
    const before = await this.ledger(date);
    const retryCalls = (before.retryCalls ?? 0) + (retry ? 1 : 0);
    const after: DayLedger = { neurons: before.neurons + neurons, calls: before.calls + 1, ...(retryCalls > 0 ? { retryCalls } : {}) };
    await this.storage.put(`spend:${date}`, after);
    return after;
  }

  async lastMutation(): Promise<AcceptedMutation | undefined> {
    return this.storage.get<AcceptedMutation>(LAST_MUTATION);
  }

  async acceptMutation(mutation: AcceptedMutation): Promise<void> {
    await this.storage.put(LAST_MUTATION, mutation);
  }

  /**
   * Forgets every vector, with the failure counts and absences that refer to them, so the next
   * run embeds every chunk again. The ledger and the last error stay.
   */
  async clear(): Promise<number> {
    const ids = [...(await this.entries()).keys()];
    await this.forget(ids);
    await this.forgetFailures([...(await this.failures()).keys()]);
    await this.forgetAbsences([...(await this.absences()).keys()]);
    await this.storage.delete(LAST_MUTATION);
    return ids.length;
  }
}
