/**
 * Runs one full publication under Node/V8 and records the live heap at each boundary.
 * Bundled and started by measure-publication-memory.ts with `node --expose-gc`.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";

import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import type { GitHubPollResult } from "@oss-knowledge-base/github-publisher/github-connector";
import type { ImmutableProjectionObjectV1 } from "@oss-knowledge-base/serving-contract";

import { DurableObjectPipelineState } from "../src/durable-object-state";
import { runDataPublication, type PipelineStateRepository, type PublicationDestination } from "../src/pipeline";
import { generateSeededGitHubEvents } from "./seeded-github-events";
import { generateSeededKafkaEvents } from "./seeded-kafka-events";

export interface PhaseMeasurement {
  readonly phase: string;
  readonly peakMB: number;
  readonly samples: number;
}

export interface MemoryMeasurement {
  /** Spec 012 dev@ and Jira events stored besides the GitHub events. */
  readonly kafkaEvents: number;
  readonly events: number;
  readonly polledEvents: number;
  readonly seed: number;
  readonly runtime: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly baselineMB: number;
  readonly peakMB: number;
  readonly peakPhase: string;
  readonly phases: readonly PhaseMeasurement[];
  readonly writtenObjects: number;
  readonly writtenMB: number;
  readonly searchShards: number;
  readonly largestSearchShardMB: number;
  /** Order-independent fingerprint of every written key and its bytes, for before/after parity. */
  readonly outputFingerprint: string;
  readonly durationMs: number;
}

const MATERIALIZED_AT = "2026-10-02T01:42:16.361Z";
const MB = (bytes: number) => Math.round(bytes / 104_857.6) / 10;

const [countArg, seedArg, pollArg, outputPath, kafkaArg] = process.argv.slice(2);
const count = Number(countArg);
const seed = Number(seedArg ?? 9);
const polledEvents = Number(pollArg ?? 500);
const kafkaScale = Number(kafkaArg ?? 0);
let kafkaEvents = 0;
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("Run with node --expose-gc");
if (!Number.isInteger(count) || count <= 0 || outputPath === undefined) {
  throw new Error("usage: runner <events> <seed> <polledEvents> <output.json>");
}

const peaks = new Map<string, { peak: number; samples: number }>();
let phase = "setup";
let peak = { value: 0, phase };
function sample(label = phase): void {
  gc!();
  const usage = process.memoryUsage();
  const live = usage.heapUsed + usage.arrayBuffers;
  const current = peaks.get(label) ?? { peak: 0, samples: 0 };
  peaks.set(label, { peak: Math.max(current.peak, live), samples: current.samples + 1 });
  if (live > peak.value) peak = { value: live, phase: label };
}

/** Durable Object storage stand-in. Values live on disk, as in the SQLite-backed object, not in the heap. */
class DiskDurableObjectStorage {
  private readonly keys = new Map<string, number>();
  private nextFile = 0;

  constructor(private readonly directory: string) {}

  async get<T>(key: string): Promise<T | undefined> {
    const file = this.keys.get(key);
    return file === undefined ? undefined : deserialize(readFileSync(this.path(file))) as T;
  }

  async list<T>(options: { readonly prefix?: string } = {}): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const key of [...this.keys.keys()].sort()) {
      if (key.startsWith(options.prefix ?? "")) result.set(key, deserialize(readFileSync(this.path(this.keys.get(key)!))) as T);
    }
    return result;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof keyOrEntries === "string" ? { [keyOrEntries]: value } : keyOrEntries;
    for (const [key, entry] of Object.entries(entries)) {
      const file = this.keys.get(key) ?? this.nextFile++;
      writeFileSync(this.path(file), serialize(entry));
      this.keys.set(key, file);
    }
  }

  async delete(keys: string | readonly string[]): Promise<boolean | number> {
    const list = typeof keys === "string" ? [keys] : keys;
    let deleted = 0;
    for (const key of list) if (this.keys.delete(key)) deleted += 1;
    return typeof keys === "string" ? deleted > 0 : deleted;
  }

  private path(file: number): string {
    return join(this.directory, String(file));
  }
}

/** R2 stand-in that keeps only each key's length, verifying digests on write as R2 does. */
class LengthOnlyDestination implements PublicationDestination {
  readonly lengths = new Map<string, number>();
  private readonly pointers = new Map<string, Uint8Array>();
  private writes = 0;
  private readonly fingerprintBytes = new Uint8Array(32);

  get fingerprint(): string {
    return Buffer.from(this.fingerprintBytes).toString("hex");
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.pointers.get(key);
  }

  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    this.measureWrite(key, body);
    if (this.lengths.has(key)) return "exists";
    this.record(key, body);
    return "created";
  }

  async putVerifiedImmutableIfAbsent(object: ImmutableProjectionObjectV1, body: Uint8Array): Promise<"created" | "exists"> {
    this.measureWrite(object.key, body);
    if (this.lengths.has(object.key)) return "exists";
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    if (digest !== object.sha256) throw new Error(`R2 rejected ${object.key}: checksum mismatch`);
    this.record(object.key, body);
    return "created";
  }

  async putCurrent(key: string, body: Uint8Array): Promise<void> {
    phase = `pointer ${key.startsWith("public/search/") ? "search" : "feed"}`;
    sample();
    this.pointers.set(key, body);
    this.record(key, body);
  }

  async putEvidence(key: string, body: Uint8Array): Promise<void> {
    phase = "evidence";
    sample();
    this.record(key, body);
  }

  private record(key: string, body: Uint8Array): void {
    this.lengths.set(key, body.byteLength);
    const entry = createHash("sha256").update(key).update("\0").update(body).digest();
    for (let index = 0; index < 32; index += 1) this.fingerprintBytes[index]! ^= entry[index]!;
  }

  /** Samples every large body while it is held, plus a regular cadence of small ones. */
  private measureWrite(key: string, body: Uint8Array): void {
    this.writes += 1;
    phase = `write ${key.startsWith("public/search/") ? "search" : "feed"}`;
    if (body.byteLength >= 64 * 1024 || this.writes % 100 === 1) sample();
  }
}

/** Marks a phase on every state call, including phase markers when the pipeline records them. */
function instrumentState(state: PipelineStateRepository): PipelineStateRepository {
  return new Proxy(state, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const marker = args[0] as { readonly phase?: unknown } | undefined;
        phase = property === "recordPhase" && typeof marker?.phase === "string"
          ? `phase ${marker.phase}`
          : `state.${String(property)}`;
        sample();
        const result = await (value as (...values: unknown[]) => Promise<unknown>).apply(target, args);
        sample();
        return result;
      };
    },
  });
}

/** Persists all but the newest events; a separate frame so the generated array is not kept alive. */
async function seedStorage(storage: DiskDurableObjectStorage): Promise<DomainEventV1[]> {
  // Spec 012: dev@ and Jira events at `kafkaScale` × the 2026-10-06 volume, already stored.
  const kafka = kafkaScale > 0 ? generateSeededKafkaEvents({ scale: kafkaScale, seed, materializedAt: MATERIALIZED_AT }) : [];
  for (let index = 0; index < kafka.length; index += 100) {
    await storage.put(Object.fromEntries(kafka.slice(index, index + 100).map((event) => [`event:${event.id}`, event])));
  }
  kafkaEvents = kafka.length;
  const events = generateSeededGitHubEvents({ count, seed, materializedAt: MATERIALIZED_AT })
    .sort((left, right) => left.sourceTimestamp.localeCompare(right.sourceTimestamp));
  const persisted = events.slice(0, Math.max(0, events.length - polledEvents));
  for (let index = 0; index < persisted.length; index += 100) {
    await storage.put(Object.fromEntries(persisted.slice(index, index + 100).map((event) => [`event:${event.id}`, event])));
  }
  // Fresh objects, as a GitHub poll would parse them.
  return structuredClone(events.slice(persisted.length));
}

const directory = mkdtempSync(join(tmpdir(), "osskb-memory-"));
try {
  const storage = new DiskDurableObjectStorage(directory);
  let pollEvents = await seedStorage(storage);
  const connector = {
    poll: async (): Promise<GitHubPollResult> => {
      phase = "connector.poll";
      sample();
      const events = pollEvents;
      pollEvents = [];
      return {
        complete: true,
        events,
        candidateCheckpoint: {
          schema: "osskb.github-checkpoint.v1",
          connectorRevision: "github@1",
          sources: { "kafka:github": { updatedAt: MATERIALIZED_AT }, "datafusion:github": { updatedAt: MATERIALIZED_AT } },
        },
        pageCount: 1,
        truncated: false,
      };
    },
  };
  const destination = new LengthOnlyDestination();
  const state = instrumentState(new DurableObjectPipelineState(storage as unknown as DurableObjectStorage));
  sample("baseline");
  const baseline = peaks.get("baseline")!.peak;
  peak = { value: 0, phase };

  const originalLog = console.log;
  console.log = () => undefined;
  const started = Date.now();
  const status = await runDataPublication({
    environment: "development",
    materializedAt: MATERIALIZED_AT,
    connector,
    state,
    destination,
  });
  const durationMs = Date.now() - started;
  console.log = originalLog;
  phase = "done";
  sample();
  if (process.env.MEMORY_DEBUG === "1") {
    console.error([...destination.lengths].filter(([, length]) => length > 1_000_000).map(([key, length]) => `${key} ${MB(length)} MB`));
  }

  const searchShardLengths = [...destination.lengths]
    .filter(([key]) => key.startsWith("public/search/v1/releases/") && key.includes("/lexical/"))
    .map(([, length]) => length);
  const result: MemoryMeasurement = {
    events: count,
    kafkaEvents,
    polledEvents,
    seed,
    runtime: `node ${process.version}`,
    ok: status.ok,
    ...(status.ok ? {} : { error: status.error }),
    baselineMB: MB(baseline),
    peakMB: MB(peak.value),
    peakPhase: peak.phase,
    phases: [...peaks].map(([name, value]) => ({ phase: name, peakMB: MB(value.peak), samples: value.samples })),
    writtenObjects: destination.lengths.size,
    searchShards: searchShardLengths.length,
    largestSearchShardMB: MB(Math.max(0, ...searchShardLengths)),
    writtenMB: MB([...destination.lengths.values()].reduce((total, length) => total + length, 0)),
    outputFingerprint: destination.fingerprint,
    durationMs,
  };
  writeFileSync(outputPath, JSON.stringify(result));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
