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
}

export interface AcceptedMutation {
  readonly id: string;
  readonly acceptedAt: string;
}

const VECTOR_PREFIX = "v:";
const LAST_MUTATION = "last-mutation";
// Durable Object storage accepts at most 128 keys per put or delete.
const STORAGE_BATCH = 100;

export class EmbeddingState {
  constructor(private readonly storage: EmbeddingStorage) {}

  /** Every recorded vector by id. About 100 bytes each: 30,000 chunks are about 3 MB. */
  async entries(): Promise<Map<string, VectorStateEntry>> {
    const stored = await this.storage.list<VectorStateEntry>(VECTOR_PREFIX);
    return new Map([...stored].map(([key, entry]) => [key.slice(VECTOR_PREFIX.length), entry]));
  }

  async record(entries: readonly (readonly [string, VectorStateEntry])[]): Promise<void> {
    for (let index = 0; index < entries.length; index += STORAGE_BATCH) {
      await this.storage.putMany(Object.fromEntries(entries.slice(index, index + STORAGE_BATCH).map(([id, entry]) => [`${VECTOR_PREFIX}${id}`, entry])));
    }
  }

  async forget(ids: readonly string[]): Promise<void> {
    for (let index = 0; index < ids.length; index += STORAGE_BATCH) {
      await this.storage.deleteMany(ids.slice(index, index + STORAGE_BATCH).map((id) => `${VECTOR_PREFIX}${id}`));
    }
  }

  async ledger(date: string): Promise<DayLedger> {
    return (await this.storage.get<DayLedger>(`spend:${date}`)) ?? { neurons: 0, calls: 0 };
  }

  /** Counts one model call before it is made, so an attempt that dies is still counted. */
  async reserve(date: string, neurons: number): Promise<DayLedger> {
    const before = await this.ledger(date);
    const after = { neurons: before.neurons + neurons, calls: before.calls + 1 };
    await this.storage.put(`spend:${date}`, after);
    return after;
  }

  async lastMutation(): Promise<AcceptedMutation | undefined> {
    return this.storage.get<AcceptedMutation>(LAST_MUTATION);
  }

  async acceptMutation(mutation: AcceptedMutation): Promise<void> {
    await this.storage.put(LAST_MUTATION, mutation);
  }

  /** Forgets every vector, so the next run embeds every chunk again. The ledger stays. */
  async clear(): Promise<number> {
    const ids = [...(await this.entries()).keys()];
    await this.forget(ids);
    await this.storage.delete(LAST_MUTATION);
    return ids.length;
  }
}
