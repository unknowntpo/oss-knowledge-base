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
  test("M8: a commit that adds and removes one event puts and deletes one key without listing", async () => {
    const storage = new MemoryStorage();
    await storage.put(Object.fromEntries(events.map((event) => [`event:${event.id}`, event])));
    const state = new DurableObjectPipelineState(storage.asDurableObjectStorage());
    const read = await state.read();
    storage.operations.length = 0;
    const [removed, ...kept] = read.events;
    const added = { ...removed!, id: `sha256:${"f".repeat(64)}` } as DomainEventV1;

    await state.commit({ ...read, events: [...kept, added] });

    expect(storage.operations).toEqual([`delete event:${removed!.id}`, `put event:${added.id}`]);
    expect([...storage.values.keys()].filter((key) => key.startsWith("event:")).sort())
      .toEqual([...kept, added].map((event) => `event:${event.id}`).sort());
  });

  test("M8: a changed event under the same id is put; unchanged events are not", async () => {
    const storage = new MemoryStorage();
    await storage.put(Object.fromEntries(events.map((event) => [`event:${event.id}`, event])));
    const state = new DurableObjectPipelineState(storage.asDurableObjectStorage());
    const read = await state.read();
    storage.operations.length = 0;
    const copies = read.events.map((event) => structuredClone(event));
    copies[1] = { ...copies[1]!, observedAt: "2026-08-24T00:00:00Z" };

    await state.commit({ ...read, events: copies });

    expect(storage.operations).toEqual([`put event:${copies[1]!.id}`]);
  });

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

  test("M10: a rerun of a killed attempt's release whose sources changed is a destination conflict on a Search shard", async () => {
    // The 2026-10-06 12:07 Dev incident: the attempt that died had written this release's shards.
    const storage = new MemoryStorage();
    const killed = new KeyHangingDestination((key) => key.includes("/lexical/apache-datafusion/"));
    void runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: connector(),
      state: new DurableObjectPipelineState(storage.asDurableObjectStorage()),
      destination: killed,
    });
    await killed.reached;

    const edited = events.map((event) => event.projectId !== "apache-datafusion" ? event : {
      ...event,
      data: { ...(event.data as Record<string, unknown>), excerpt: "Edited on GitHub between the two attempts." },
    }) as DomainEventV1[];
    const retried = await runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: connector(edited),
      state: new DurableObjectPipelineState(storage.asDurableObjectStorage()),
      destination: killed.reopened(),
    });
    expect(retried).toMatchObject({ ok: false });
    expect((retried as { readonly error: string }).error)
      .toMatch(/^destination-conflict: .*\/releases\/feed-2026-08-25T12-00-00-000Z\/lexical\/apache-datafusion\/0\.json/u);

    // Positive control: the same changed sources under a new release id publish.
    const fresh = await runDataPublication({
      environment: "development",
      materializedAt: "2026-08-25T12:05:00.000Z",
      connector: connector(edited),
      state: new DurableObjectPipelineState(storage.asDurableObjectStorage()),
      destination: killed.reopened(),
    });
    expect(fresh.ok).toBe(true);
  });

  test("M10: after an alarm attempt is killed mid-run, the retry publishes under a new materializedAt", async () => {
    const storage = new MemoryStorage();
    const requestedAt = "2026-10-06T12:07:37.000Z";
    await storage.put("requested-at", requestedAt);
    const realFetch = globalThis.fetch;
    let reachedFetch!: () => void;
    const fetched = new Promise<void>((resolve) => { reachedFetch = resolve; });
    // The first attempt hangs on its first source request and is abandoned, as when the
    // platform kills the isolate: no catch, finally, or status write of that attempt runs.
    globalThis.fetch = (() => {
      reachedFetch();
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    try {
      void alarmState(storage).alarm();
      await fetched;
      expect(await storage.get("status")).toBeUndefined();

      // The runtime retries the alarm in a fresh isolate, without a new POST /run.
      globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
      await alarmState(storage).alarm();
      const retry = await storage.get<{ readonly completedAt: string }>("status");

      expect(retry?.completedAt).toBeDefined();
      expect(retry!.completedAt).not.toBe(requestedAt);
      expect(Date.parse(retry!.completedAt)).toBeGreaterThan(Date.parse(requestedAt));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("M10: a retried alarm publishes under a new materializedAt, not the release of the attempt that died", async () => {
    const storage = new MemoryStorage();
    const requestedAt = "2026-10-06T12:07:37.000Z";
    await storage.put("requested-at", requestedAt);
    const realFetch = globalThis.fetch;
    // Every source fails, so each attempt records a status naming the materializedAt it used.
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    try {
      await alarmState(storage).alarm();
      const first = await storage.get<{ readonly completedAt: string }>("status");
      // The runtime re-invokes the alarm without a new POST /run.
      await alarmState(storage).alarm();
      const retry = await storage.get<{ readonly completedAt: string }>("status");

      expect(first?.completedAt).toBe(requestedAt);
      expect(retry?.completedAt).not.toBe(requestedAt);
      expect(Date.parse(retry!.completedAt)).toBeGreaterThan(Date.parse(requestedAt));
    } finally {
      globalThis.fetch = realFetch;
    }
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

/** An object whose alarm can run; the token is a placeholder, every fetch is stubbed. */
function alarmState(storage: MemoryStorage): PipelineState {
  return new PipelineState(
    { storage: storage.asDurableObjectStorage() } as unknown as DurableObjectState,
    { PUBLICATION_ENVIRONMENT: "development", GITHUB_SOURCE_TOKEN: "placeholder" } as never,
  );
}

function connector(polled: readonly DomainEventV1[] = events) {
  return {
    poll: async (): Promise<GitHubPollResult> => ({
      complete: true,
      events: polled,
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

/** Writes until the first key matching `hangOn`, which it writes and then never settles. */
class KeyHangingDestination implements PublicationDestination {
  readonly reached: Promise<void>;
  private resolveReached!: () => void;
  private hung = false;

  constructor(
    private readonly hangOn: (key: string) => boolean,
    private readonly objects = new Map<string, Uint8Array>(),
  ) {
    this.reached = new Promise((resolve) => { this.resolveReached = resolve; });
  }

  /** The same bucket, as seen by the next attempt. */
  reopened(): KeyHangingDestination {
    return new KeyHangingDestination(() => false, this.objects);
  }

  async get(key: string): Promise<Uint8Array | undefined> { return this.objects.get(key); }
  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    return this.putVerifiedImmutableIfAbsent({ key, sha256: "sha256:", byteLength: body.byteLength }, body);
  }
  async putVerifiedImmutableIfAbsent(object: ImmutableProjectionObjectV1, body: Uint8Array): Promise<"created" | "exists"> {
    if (this.hung) return new Promise(() => undefined);
    if (this.objects.has(object.key)) return "exists";
    this.objects.set(object.key, body);
    if (this.hangOn(object.key)) {
      this.hung = true;
      this.resolveReached();
      return new Promise(() => undefined);
    }
    return "created";
  }
  async putCurrent(key: string, body: Uint8Array): Promise<void> { this.objects.set(key, body); }
  async putEvidence(key: string, body: Uint8Array): Promise<void> { this.objects.set(key, body); }
}
