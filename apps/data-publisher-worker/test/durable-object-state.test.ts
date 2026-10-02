import { describe, expect, test } from "bun:test";
import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import type { GitHubPollResult } from "@oss-knowledge-base/github-publisher/github-connector";
import type { ImmutableProjectionObjectV1 } from "@oss-knowledge-base/serving-contract";

import fixture from "../../../packages/reference-pipeline/test/fixtures/github-events.v1.json";
import { DurableObjectPipelineState } from "../src/durable-object-state";
import { PipelineState } from "../src/index";
import { runDataPublication, type PipelinePhaseMarker, type PublicationDestination } from "../src/pipeline";
import { STALE_ALARM_MS } from "../src/run-schedule";

const events = fixture.events as DomainEventV1[];

describe("Durable Object pipeline state", () => {
  test("M7: a run killed during promotion leaves its phase on /health until a later run completes", async () => {
    const storage = new MemoryStorage();
    const hung = new HangingDestination(3);
    void runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: connector(),
      state: new DurableObjectPipelineState(storage.asDurableObjectStorage()),
      destination: hung,
    });
    await hung.reached;

    // A fresh object instance stands in for the isolate that replaced the killed one.
    const killed = await health(storage);
    expect(killed.running).toBe(false);
    expect(killed.lastRun).toBeNull();
    expect(killed.phase).toMatchObject({
      phase: "writing-search",
      materializedAt: fixture.config.materializedAt,
      counts: { events: events.length, feedEntries: expect.any(Number) },
    });
    expect(Number.isNaN(Date.parse(killed.phase!.startedAt))).toBe(false);

    const completed = await runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: connector(),
      state: new DurableObjectPipelineState(storage.asDurableObjectStorage()),
      destination: new HangingDestination(Number.POSITIVE_INFINITY),
    });
    expect(completed.ok).toBe(true);
    const after = await health(storage);
    expect(after.phase).toBeNull();
    expect(after.lastRun).toMatchObject({ ok: true });
  });

  test("M9: POST /run replaces an alarm stale for 30 minutes but not a recent one", async () => {
    const now = Date.now();
    const stale = new MemoryStorage(now - STALE_ALARM_MS - 1_000);
    const staleResponse = await pipelineState(stale).fetch(new Request("https://pipeline.internal/run", { method: "POST" }));
    expect(staleResponse.status).toBe(202);
    expect(stale.alarm).toBeGreaterThanOrEqual(now);

    const recent = new MemoryStorage(now - STALE_ALARM_MS + 60_000);
    const recentResponse = await pipelineState(recent).fetch(new Request("https://pipeline.internal/run", { method: "POST" }));
    expect(recentResponse.status).toBe(409);
    expect(recent.alarm).toBe(now - STALE_ALARM_MS + 60_000);
  });
});

async function health(storage: MemoryStorage): Promise<{
  readonly running: boolean;
  readonly phase: PipelinePhaseMarker | null;
  readonly lastRun: unknown;
}> {
  const response = await pipelineState(storage).fetch(new Request("https://pipeline.internal/status"));
  return response.json() as never;
}

function pipelineState(storage: MemoryStorage): PipelineState {
  return new PipelineState(
    { storage: storage.asDurableObjectStorage() } as unknown as DurableObjectState,
    { PUBLICATION_ENVIRONMENT: "development" } as never,
  );
}

function connector() {
  return {
    poll: async (): Promise<GitHubPollResult> => ({
      complete: true,
      events,
      candidateCheckpoint: {
        schema: "osskb.github-checkpoint.v1",
        connectorRevision: "github@1",
        sources: { "kafka:github": { updatedAt: fixture.config.materializedAt } },
      },
      pageCount: 1,
      truncated: false,
    }),
  };
}

/** Durable Object storage that keeps structured clones and records event-key writes. */
class MemoryStorage {
  readonly values = new Map<string, unknown>();
  readonly operations: string[] = [];

  constructor(public alarm: number | null = null) {}

  asDurableObjectStorage(): DurableObjectStorage {
    return this as unknown as DurableObjectStorage;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async list<T>(options: { readonly prefix?: string } = {}): Promise<Map<string, T>> {
    this.operations.push(`list ${options.prefix ?? ""}`);
    return new Map([...this.values]
      .filter(([key]) => key.startsWith(options.prefix ?? ""))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, structuredClone(value) as T]));
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof keyOrEntries === "string" ? { [keyOrEntries]: value } : keyOrEntries;
    const keys = Object.keys(entries);
    if (keys.length > 128) throw new Error("put accepts at most 128 keys");
    if (keys.some((key) => key.startsWith("event:"))) this.operations.push(`put ${keys.join(",")}`);
    for (const [key, entry] of Object.entries(entries)) this.values.set(key, structuredClone(entry));
  }

  async delete(keys: string | readonly string[]): Promise<boolean | number> {
    const list = typeof keys === "string" ? [keys] : keys;
    if (list.length > 128) throw new Error("delete accepts at most 128 keys");
    if (list.some((key) => key.startsWith("event:"))) this.operations.push(`delete ${list.join(",")}`);
    const deleted = list.filter((key) => this.values.delete(key)).length;
    return typeof keys === "string" ? deleted > 0 : deleted;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }
}

/** Never settles the n-th immutable write, as when the platform kills the isolate mid-promotion. */
class HangingDestination implements PublicationDestination {
  readonly reached: Promise<void>;
  private readonly objects = new Map<string, Uint8Array>();
  private writes = 0;
  private resolveReached!: () => void;

  constructor(private readonly hangAt: number) {
    this.reached = new Promise((resolve) => { this.resolveReached = resolve; });
  }

  async get(key: string): Promise<Uint8Array | undefined> { return this.objects.get(key); }
  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    return this.putVerifiedImmutableIfAbsent({ key, sha256: "sha256:", byteLength: body.byteLength }, body);
  }
  async putVerifiedImmutableIfAbsent(object: ImmutableProjectionObjectV1, body: Uint8Array): Promise<"created" | "exists"> {
    this.writes += 1;
    if (this.writes === this.hangAt) {
      this.resolveReached();
      return new Promise(() => undefined);
    }
    if (this.objects.has(object.key)) return "exists";
    this.objects.set(object.key, body);
    return "created";
  }
  async putCurrent(key: string, body: Uint8Array): Promise<void> { this.objects.set(key, body); }
  async putEvidence(key: string, body: Uint8Array): Promise<void> { this.objects.set(key, body); }
}
