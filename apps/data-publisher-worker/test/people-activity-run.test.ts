/**
 * Spec 019 slice 2b: the activity log's append inside the publication (W2, W9, W17, W22) and its
 * flag (W25 for the publisher: off writes nothing). Events: the recorded Dev fixture of
 * `packages/reference-pipeline/test/fixtures/people-activity/kafka-dev.json`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import type { GitHubPollResult } from "@oss-knowledge-base/github-publisher/github-connector";
import {
  parseActivityMonth,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  peopleActivitySummaryKey,
  type SerializedReferenceStateV1,
} from "@oss-knowledge-base/reference-pipeline";

import { fixtureEvents, peopleActivityFixture } from "../../../packages/reference-pipeline/test/support/people-activity-fixture";
import { activityLogFor } from "../src/index";
import { appendActivityLog, peopleActivitySet, type ActivityBucket } from "../src/people-activity/run";
import { runDataPublication, type PipelineRunStatus, type PipelineStateRepository, type PublicationDestination } from "../src/pipeline";

const RELEASE = peopleActivityFixture.release;
const PROJECTS = ["apache-kafka", "apache-datafusion"];

class MemoryBucket implements ActivityBucket {
  readonly objects = new Map<string, string>();
  readonly operations: string[] = [];
  failPutsAfter: number | undefined;
  async get(key: string) {
    this.operations.push(`get ${key}`);
    return this.objects.get(key);
  }
  async put(key: string, body: string) {
    this.operations.push(`put ${key}`);
    if (this.failPutsAfter !== undefined && this.operations.filter((operation) => operation.startsWith("put ")).length > this.failPutsAfter) {
      throw new Error(`injected R2 failure at ${key}`);
    }
    this.objects.set(key, body);
  }
}

const append = (bucket: ActivityBucket, materializedAt = RELEASE, events: readonly DomainEventV1[] = fixtureEvents(), flag = "log@1") =>
  appendActivityLog({ flag, bucket, events, materializedAt, projectIds: PROJECTS });

describe("Spec 019 slice 2b: the activity log's append", () => {
  test("W22: the first append writes each month with rows, its summary and state.json, and reports what it did", async () => {
    const bucket = new MemoryBucket();
    const status = await append(bucket);
    expect(status).toMatchObject({
      ok: true, revision: "log@1", monthsRead: 2, monthsWritten: 2, monthsUnchanged: 0,
      earliestMonth: { "apache-kafka": "2026-09" },
      coverageFrom: { "apache-kafka": "2026-09-09T22:07:43.000Z", "apache-datafusion": "2026-09-09T22:07:43.000Z" },
      // W17: 2 projects' state.json + 2 months read; 2 months + 2 summaries + 2 state.json written.
      r2: { classA: 6, classB: 4 },
    });
    if (!status.ok) throw new Error(status.error);
    expect(status.rows).toBeGreaterThan(300);
    expect(status.identities).toBeGreaterThan(50);
    expect([...bucket.objects.keys()].sort()).toEqual([
      peopleActivityMonthKey("apache-kafka", "2026-09"), peopleActivitySummaryKey("apache-kafka", "2026-09"),
      peopleActivityMonthKey("apache-kafka", "2026-10"), peopleActivitySummaryKey("apache-kafka", "2026-10"),
      peopleActivityStateKey("apache-datafusion"), peopleActivityStateKey("apache-kafka"),
    ].sort());
    expect(JSON.parse(bucket.objects.get(peopleActivityStateKey("apache-kafka"))!)).toEqual({
      schema: "osskb.people-activity-state.v1", firstAppendAt: RELEASE, coverageFrom: "2026-09-09T22:07:43.000Z", updatedAt: RELEASE, months: ["2026-09", "2026-10"],
    });
  });

  test("W2 and W17: a second run with the same records writes no month (only state.json); a new record rewrites only its month", async () => {
    const bucket = new MemoryBucket();
    await append(bucket);
    const before = new Map(bucket.objects);
    const again = await append(bucket, "2026-10-15T22:07:00.000Z");
    expect(again).toMatchObject({ ok: true, monthsWritten: 0, monthsUnchanged: 2, r2: { classA: 2, classB: 4 } });
    for (const [key, body] of before) if (!key.endsWith("state.json")) expect(bucket.objects.get(key)).toBe(body);
    const state = JSON.parse(bucket.objects.get(peopleActivityStateKey("apache-kafka"))!);
    // The coverage start and the first append stay; only the end moves.
    expect(state).toMatchObject({ firstAppendAt: RELEASE, coverageFrom: "2026-09-09T22:07:43.000Z", updatedAt: "2026-10-15T22:07:00.000Z" });

    // Positive control: one more comment in October rewrites October and its summary, nothing else.
    const events = fixtureEvents();
    const comment = events.find((event) => event.entityId.includes(":comment:") && event.sourceInstanceId === "kafka:github")!;
    const extra = { ...comment, id: "extra", entityId: `${comment.entityId}0`, data: { ...comment.data, occurredAt: "2026-10-15T10:00:00Z", createdAt: "2026-10-15T10:00:00Z" } } as DomainEventV1;
    const third = await append(bucket, "2026-10-16T22:07:00.000Z", [...events, extra]);
    expect(third).toMatchObject({ ok: true, monthsWritten: 1, monthsUnchanged: 1, r2: { classA: 4, classB: 4 } });
    const october = parseActivityMonth(JSON.parse(bucket.objects.get(peopleActivityMonthKey("apache-kafka", "2026-10"))!), "apache-kafka", "2026-10");
    expect(october.rows.filter((row) => row.id === extra.entityId).length).toBe(1);
  });

  test("W9: a failed write leaves the publication's state for the next run, which writes the missed rows; state.json does not advance", async () => {
    const bucket = new MemoryBucket();
    bucket.failPutsAfter = 1;
    const failed = await append(bucket);
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining("injected R2 failure") });
    expect(bucket.objects.has(peopleActivityStateKey("apache-kafka"))).toBe(false);
    bucket.failPutsAfter = undefined;
    const retried = await append(bucket, "2026-10-15T22:07:00.000Z");
    // The first attempt wrote September's summary only; its month bytes were never written, so both are written now.
    expect(retried).toMatchObject({ ok: true, monthsWritten: 2 });
    // The retry's coverage starts 35 days before the retry: nothing stored before it is counted.
    expect(JSON.parse(bucket.objects.get(peopleActivityStateKey("apache-kafka"))!).coverageFrom).toBe("2026-09-10T22:07:00.000Z");
  });

  test("an unsupported flag value fails the append with its reason and sends no R2 request", async () => {
    const bucket = new MemoryBucket();
    expect(await append(bucket, RELEASE, fixtureEvents(), "log@2")).toMatchObject({ ok: false, error: expect.stringContaining("log@2"), r2: { classA: 0, classB: 0 } });
    expect(bucket.operations).toEqual([]);
    expect([peopleActivitySet(undefined), peopleActivitySet(" "), peopleActivitySet("log@1"), peopleActivitySet("x")]).toEqual([false, false, true, true]);
  });

  test("W9: inside the publication, an append that throws or fails still commits the state and records the run; positive control writes", async () => {
    const throwing = await publish(async () => { throw new Error("boom"); });
    expect(throwing.status).toMatchObject({ ok: true, activity: { ok: false, error: "boom" } });
    expect(throwing.state.value.events.length).toBeGreaterThan(0);
    expect(throwing.state.phases).toContain("appending-activity");
    expect(throwing.state.phases.indexOf("appending-activity")).toBeLessThan(throwing.state.phases.indexOf("committing-state"));

    const bucket = new MemoryBucket();
    const working = await publish((events, materializedAt) => appendActivityLog({ flag: "log@1", bucket, events, materializedAt, projectIds: PROJECTS }));
    expect(working.status).toMatchObject({ ok: true, activity: { ok: true, monthsWritten: 2 } });
    expect(bucket.objects.has(peopleActivityMonthKey("apache-kafka", "2026-10"))).toBe(true);
  });

  test("W25 (publisher): without PEOPLE_ACTIVITY the publication has no append, no phase and no `activity` field", async () => {
    const off = await publish(undefined);
    expect(off.status.ok).toBe(true);
    expect("activity" in off.status).toBe(false);
    expect(off.state.phases).not.toContain("appending-activity");
  });

  test("W25 (publisher): PEOPLE_ACTIVITY is log@1 on Dev only (the enable PR); Prod leaves it unset", () => {
    const vars = (name: string) => (JSON.parse(readFileSync(join(import.meta.dir, "..", name), "utf8")) as { vars?: Record<string, string> }).vars ?? {};
    expect(vars("wrangler.development.jsonc").PEOPLE_ACTIVITY).toBe("log@1");
    expect(vars("wrangler.production.jsonc").PEOPLE_ACTIVITY).toBeUndefined();
  });

  test("the Worker's append writes to the bound bucket through R2's get and put", async () => {
    const objects = new Map<string, string>();
    const r2 = {
      get: async (key: string) => (objects.has(key) ? { text: async () => objects.get(key)! } : null),
      put: async (key: string, body: string) => { objects.set(key, body); return {}; },
    };
    const status = await activityLogFor({ PEOPLE_ACTIVITY: "log@1", OSS_KB_BUCKET: r2 as unknown as R2Bucket })(fixtureEvents(), RELEASE);
    expect(status.ok).toBe(true);
    expect(objects.has(peopleActivityStateKey("apache-datafusion"))).toBe(true);
  });
});

class MemoryState implements PipelineStateRepository {
  value: SerializedReferenceStateV1 = { schema: "osskb.reference-state.v1", events: [] };
  statuses: PipelineRunStatus[] = [];
  phases: string[] = [];
  async read() { return this.value; }
  async commit(state: SerializedReferenceStateV1) { this.value = state; }
  async recordStatus(status: PipelineRunStatus) { this.statuses.push(status); }
  async recordPhase(marker: { readonly phase: string }) { this.phases.push(marker.phase); }
}

class MemoryDestination implements PublicationDestination {
  readonly objects = new Map<string, Uint8Array>();
  async get(key: string) { return this.objects.get(key); }
  async putImmutableIfAbsent(key: string, body: Uint8Array) {
    if (this.objects.has(key)) return "exists" as const;
    this.objects.set(key, body);
    return "created" as const;
  }
  async putCurrent(key: string, body: Uint8Array) { this.objects.set(key, body); }
  async putEvidence(key: string, body: Uint8Array) { this.objects.set(key, body); }
}

async function publish(activityLog: Parameters<typeof runDataPublication>[0]["activityLog"]) {
  const state = new MemoryState();
  const events = fixtureEvents().filter((event) => event.sourceInstanceId === "kafka:github");
  const status = await runDataPublication({
    environment: "development",
    materializedAt: RELEASE,
    connector: {
      poll: async (): Promise<GitHubPollResult> => ({
        complete: true,
        events,
        candidateCheckpoint: { schema: "osskb.github-checkpoint.v1", connectorRevision: "github@1", sources: { "kafka:github": { updatedAt: RELEASE } } },
        pageCount: 1,
        truncated: false,
      }),
    },
    state,
    destination: new MemoryDestination(),
    ...(activityLog === undefined ? {} : { activityLog }),
  });
  return { status, state };
}
