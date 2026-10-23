/**
 * Spec 028 slice 1, Worker wiring: the flag end to end, `runId` across a publication's follow-ups,
 * one point per job run in its own status write, the log objects, and a `/health` that reads nothing
 * new. Fakes only: no network, no Cloudflare binding.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import type { GitHubPollResult } from "@oss-knowledge-base/github-publisher/github-connector";
import { FakeVectorIndex } from "@oss-knowledge-base/semantic-vectorize/testing";
import { KAFKA_DIGEST_PROFILE, PEOPLE_IDENTITY_PROFILES } from "@oss-knowledge-base/reference-pipeline";
import { MANIFEST_KEY } from "@oss-knowledge-base/serving-contract";

import fixture from "../../../packages/reference-pipeline/test/fixtures/github-events.v1.json";
import r2Usage from "./fixtures/cost-guard/graphql-r2-usage.json";
import { CountingR2Bucket } from "./support/counting-r2-bucket";
import { FIVE, MemoryBucket as ReleaseBucket, MemoryStorage as EmbeddingMemoryStorage, publishRelease } from "./support/search-embedding";
import worker, { CostGuard, PipelineState } from "../src/index";
import { DurableObjectPipelineState } from "../src/durable-object-state";
import { DigestRunner, type DigestStorage } from "../src/digest/runner";
import { R2DigestBucket, type DigestBucket } from "../src/digest/store";
import { runIdentityLinks, R2IdentityLinksBucket } from "../src/identity-links/run";
import { kipPagesRun } from "../src/kip-pages/run";
import { runDataPublication } from "../src/pipeline";
import { R2PublicationDestination } from "../src/r2-destination";
import { SearchEmbeddingRunner } from "../src/search-embedding/runner";
import { healthBody } from "../src/health";
import { PUBLICATION_RUN_KEY, signalingPipelineState, sourceRunIdFrom } from "../src/signals/publication";
import { SignalRecorder, type AnalyticsSql } from "../src/signals/recorder";
import { signalsHealth } from "../src/signals/rules";
import { resolveSignalsMode } from "../src/signals/profile";

const TICK = "2026-10-20T22:07:00.000Z";
const RUN_ID = "publication-2026-10-20T22-07-00-000Z";
const TOKEN = "cf-analytics-token-under-test-0123456789abcdefABCDEF";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

class FakeSink {
  readonly points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
  failFor?: string;
  writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }) {
    if (point.blobs[0] === this.failFor) throw new Error(`dataset write refused for ${this.failFor}`);
    this.points.push(point);
  }
}

class FakeSql implements AnalyticsSql {
  readonly calls: { readonly query: string; readonly params: Record<string, unknown> }[] = [];
  async query(input: { readonly query: string; readonly params?: Record<string, string | number | boolean | null> }) {
    this.calls.push({ query: input.query, params: { ...input.params } });
    return { data: [] as unknown[] };
  }
}

/** Durable Object storage: structured clones, and every put/delete call counted. */
class DoStorage {
  readonly values = new Map<string, unknown>();
  puts = 0;
  deletes = 0;
  /** A copy, so an assertion cannot change what is stored. */
  peek(key: string): unknown { return structuredClone(this.values.get(key)); }
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async list<T>(options: { readonly prefix?: string } = {}): Promise<Map<string, T>> {
    return new Map([...this.values].filter(([key]) => key.startsWith(options.prefix ?? "")).map(([key, value]) => [key, structuredClone(value) as T]));
  }
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    this.puts += 1;
    const entries = typeof keyOrEntries === "string" ? { [keyOrEntries]: value } : keyOrEntries;
    for (const [key, entry] of Object.entries(entries)) this.values.set(key, structuredClone(entry));
  }
  async delete(keys: string | readonly string[]): Promise<boolean | number> {
    this.deletes += 1;
    const list = typeof keys === "string" ? [keys] : keys;
    const deleted = list.filter((key) => this.values.delete(key)).length;
    return typeof keys === "string" ? deleted > 0 : deleted;
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(time: number) { this.alarm = time; }
}

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
let logs: { readonly level: "log" | "error"; readonly value: unknown }[] = [];
beforeEach(() => {
  logs = [];
  console.log = (value: unknown) => { logs.push({ level: "log", value }); };
  console.error = (value: unknown) => { logs.push({ level: "error", value }); };
  // Every source answers 404: each publication run fails and plans a retry (Spec 018).
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://api.cloudflare.com/client/v4/graphql") return Response.json(r2Usage);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; console.log = realLog; console.error = realError; });

function signalVars(sink = new FakeSink(), sql = new FakeSql()) {
  return { vars: { OBSERVABILITY_SIGNALS: "on", SIGNALS: sink, ANALYTICS_SQL: sql }, sink, sql };
}

function publicationObject(storage: DoStorage, variables: Record<string, unknown> = {}) {
  return new PipelineState({ storage } as unknown as DurableObjectState, { PUBLICATION_ENVIRONMENT: "development", GITHUB_SOURCE_TOKEN: "placeholder", ...variables } as never);
}

const trigger = (state: PipelineState, at = TICK) =>
  state.fetch(new Request("https://pipeline.internal/run", { method: "POST", headers: { "x-scheduled-at": at } }));

/** A trigger and every alarm until no follow-up is left (a failed run is retried three times). */
async function wholeRun(storage: DoStorage, variables: Record<string, unknown> = {}, at = TICK) {
  const state = publicationObject(storage, variables);
  expect((await trigger(state, at)).status).toBe(202);
  const statuses: Record<string, unknown>[] = [];
  for (let alarm = 0; alarm < 4; alarm += 1) {
    await state.alarm();
    statuses.push((await storage.get<Record<string, unknown>>("status"))!);
  }
  expect(await storage.get("follow-up")).toBeUndefined();
  return { state, statuses };
}

const normalized = (message: string) => message.replace(/\d+ms/gu, "Nms");
const messages = () => logs.map((entry) => (typeof entry.value === "string" ? entry.value : (entry.value as { message: string }).message)).map(normalized);

function namespace(object: { fetch(request: Request): Promise<Response> }, calls: string[] = []) {
  return { idFromName: (name: string) => name, get: () => ({ fetch: (input: string | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push(`${request.method} ${request.url}`);
    return object.fetch(request);
  } }) };
}

const jsonObject = (body: unknown, status = 200) => ({ fetch: async () => Response.json(body, { status }) });

describe("Spec 028 slice 1: the flag", () => {
  test("OB1: off (unset, blank, off) writes no point, makes no query, adds no key, no field and no log object; on is the positive control; any other value is unconfigured", async () => {
    const off = async (flag: string | undefined) => {
      const { sink, sql } = signalVars();
      const storage = new DoStorage();
      logs = [];
      await wholeRun(storage, { ...(flag === undefined ? {} : { OBSERVABILITY_SIGNALS: flag }), SIGNALS: sink, ANALYTICS_SQL: sql });
      return { sink, sql, storage, logs: [...logs] };
    };
    const baseline = await off(undefined);
    for (const flag of [undefined, "", "off", "yes"]) {
      const run = await off(flag);
      expect(run.sink.points).toEqual([]);
      expect(run.sql.calls).toEqual([]);
      expect([...run.storage.values.keys()]).not.toContain(PUBLICATION_RUN_KEY);
      expect(run.storage.peek("status")).not.toHaveProperty("runId");
      expect(run.storage.peek("status")).not.toHaveProperty("trends");
      expect(run.logs.every((entry) => typeof entry.value === "string")).toBe(true);
      expect(run.storage.puts).toBe(baseline.storage.puts);
    }

    // Positive control: `on` on the same path writes one point, queries once, and keys the record.
    const { vars, sink, sql } = signalVars();
    const storage = new DoStorage();
    logs = [];
    await wholeRun(storage, vars);
    expect(sink.points).toHaveLength(1);
    expect(sql.calls).toHaveLength(1);
    expect(storage.peek("status")).toMatchObject({ runId: RUN_ID, trends: { rules: expect.any(Array) } });
    // OB4/OB17: no Durable Object write of its own: the marker rides the trigger's put, the trend result the status put.
    expect(storage.puts).toBe(baseline.storage.puts);

    const health = async (variables: Record<string, unknown>) => {
      const env = {
        PUBLICATION_ENVIRONMENT: "development",
        PIPELINE_STATE: namespace(publicationObject(storage, variables)),
        DIGEST_RUN: namespace(jsonObject({ enabled: false, lastRun: null })),
        OSS_KB_BUCKET: { get: async () => null },
        ...variables,
      };
      return await (await worker.fetch(new Request("https://data.example/health"), env as never)).json() as Record<string, unknown>;
    };
    expect(await health({})).not.toHaveProperty("signals");
    expect(await health({ OBSERVABILITY_SIGNALS: "off" })).not.toHaveProperty("signals");
    expect((await health({ OBSERVABILITY_SIGNALS: "yes" })).signals).toEqual({ status: "unconfigured", reason: 'OBSERVABILITY_SIGNALS "yes" is not off or on' });
    expect((await health(vars)).signals).toMatchObject({ status: expect.stringMatching(/^(ok|warn|firing)$/u), rules: expect.any(Array) });
  });

  test("OB1 (Dev enable): Dev sets the flag on and binds SIGNALS (osskb_signals_dev) and ANALYTICS_SQL; Prod leaves the flag unset and binds neither", async () => {
    type Config = {
      readonly vars?: Readonly<Record<string, string>>;
      readonly analytics_engine_datasets?: readonly { readonly binding: string; readonly dataset: string }[];
      readonly analytics?: { readonly binding: string };
    };
    const config = async (name: string) => JSON.parse(await Bun.file(new URL(`../${name}`, import.meta.url)).text()) as Config;
    const dev = await config("wrangler.development.jsonc");
    const prod = await config("wrangler.production.jsonc");
    expect(resolveSignalsMode(dev.vars?.OBSERVABILITY_SIGNALS)).toBe("on");
    expect(dev.analytics_engine_datasets).toEqual([{ binding: "SIGNALS", dataset: "osskb_signals_dev" }]);
    expect(dev.analytics).toEqual({ binding: "ANALYTICS_SQL" });
    expect(prod.vars?.OBSERVABILITY_SIGNALS).toBeUndefined();
    expect(resolveSignalsMode(prod.vars?.OBSERVABILITY_SIGNALS)).toBe("off");
    expect(prod).not.toHaveProperty("analytics_engine_datasets");
    expect(prod).not.toHaveProperty("analytics");
  });
});

describe("Spec 028 slice 1: runId and one point per run", () => {
  test("OB2: a publication triggered at 2026-10-20T22:07:00.000Z keeps its runId over its follow-ups and alarm retries; /health lastRun.runId equals it", async () => {
    const { vars, sink } = signalVars();
    const storage = new DoStorage();
    const { state, statuses } = await wholeRun(storage, vars);
    expect(statuses.map((status) => status.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID, RUN_ID]);
    // Only the last invocation ends the run: one point, after the third retry.
    expect(sink.points.map((point) => point.indexes)).toEqual([[RUN_ID]]);
    expect(statuses.slice(0, 3).every((status) => status.trends === undefined)).toBe(true);
    expect(statuses[3]!.trends).toBeDefined();
    const body = await (await state.fetch(new Request("https://pipeline.internal/status"))).json() as { lastRun: { runId: string } };
    expect(body.lastRun.runId).toBe(RUN_ID);

    // The next trigger starts a new run with its own id.
    await wholeRun(storage, vars, "2026-10-21T22:07:00.000Z");
    expect(sink.points.map((point) => point.indexes[0])).toEqual([RUN_ID, "publication-2026-10-21T22-07-00-000Z"]);
  });

  test("OB2: a digest over that publication's release records its runId as sourceRunId (and the embedding job over its Search release)", async () => {
    const publisher = { lastRun: { ok: true, runId: RUN_ID, feedReleaseId: "2026-10-20T22-07-00-000Z", searchRevision: "feed-2026-10-20T22-07-00-000Z" } };
    expect(sourceRunIdFrom(publisher, "2026-10-20T22-07-00-000Z")).toBe(RUN_ID);
    expect(sourceRunIdFrom(publisher, "feed-2026-10-20T22-07-00-000Z")).toBe(RUN_ID);
    // A release another run published is not attributed to this one.
    expect(sourceRunIdFrom(publisher, "2026-10-19T22-07-00-000Z")).toBe("");
    expect(sourceRunIdFrom({ lastRun: null }, "2026-10-20T22-07-00-000Z")).toBe("");

    const { digest, sink } = digestRunner(publisher);
    await digest.runner.alarm();
    const lastRun = digest.storage.peek("lastRun") as Record<string, unknown>;
    expect(lastRun).toMatchObject({ sourceReleaseId: "2026-10-20T22-07-00-000Z", sourceRunId: RUN_ID, runId: expect.stringMatching(/^digest-2026-10-20T22-47-00-000Z$/u) });
    expect(sink.points).toHaveLength(1);
    expect(sink.points[0]!.blobs).toEqual(["digest", "development", lastRun.ok ? "ok" : "failed", RUN_ID]);
  });
});

class DigestStorageFake implements DigestStorage {
  readonly values = new Map<string, unknown>();
  puts = 0;
  alarm: number | null = null;
  peek(key: string): unknown { return structuredClone(this.values.get(key)); }
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown) { this.puts += 1; this.values.set(key, value); }
  async delete(key: string) { return this.values.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(time: number) { this.alarm = time; }
}

/** An R2-like digest bucket holding an empty Feed release; counts its own requests. */
class DigestBucketFake implements DigestBucket {
  readonly objects = new Map<string, string>();
  puts = 0;
  classA = 0;
  classB = 0;
  operationCounts() { return { classA: this.classA, classB: this.classB }; }
  constructor(releaseId: string) {
    const prefix = `public/v2/releases/${releaseId}/feed/`;
    this.objects.set(`${prefix}index.json`, JSON.stringify({ entries: [] }));
    this.objects.set(`${prefix}details.json`, JSON.stringify({ schema: "osskb.feed-detail-map.v1", releaseId, details: {} }));
    this.objects.set(MANIFEST_KEY, JSON.stringify({ schema: "osskb.feed-manifest.v3", releaseId, generatedAt: TICK, feedIndexKey: `${prefix}index.json`, detailMapKey: `${prefix}details.json`, entryCount: 0 }));
  }
  async getJson(key: string) { this.classB += 1; const body = this.objects.get(key); return body === undefined ? undefined : JSON.parse(body); }
  async list(prefix: string) { this.classA += 1; return [...this.objects.keys()].filter((key) => key.startsWith(prefix)); }
  async putIfAbsent(key: string, body: string) { this.puts += 1; this.classA += 1; if (this.objects.has(key)) return false; this.objects.set(key, body); return true; }
  async putPointer(key: string, body: string) { this.puts += 1; this.classA += 1; this.objects.set(key, body); }
}

function digestRunner(publisher: unknown, options: { readonly signals?: boolean; readonly sink?: FakeSink } = {}) {
  const sink = options.sink ?? new FakeSink();
  const sql = new FakeSql();
  const storage = new DigestStorageFake();
  const bucket = new DigestBucketFake("2026-10-20T22-07-00-000Z");
  const recorder = new SignalRecorder({ environment: "development", sink, sql, now: () => Date.parse("2026-10-20T22:47:05.000Z"), delay: async () => {} });
  const runner = new DigestRunner({
    storage, bucket, profile: KAFKA_DIGEST_PROFILE, environment: "development", enabled: true,
    now: () => new Date("2026-10-20T22:47:00.000Z"), delay: async () => {}, publisherBusy: async () => false,
    ...(options.signals === false ? {} : { signals: { recorder, sourceRunId: async (release: string) => sourceRunIdFrom(publisher, release) } }),
  });
  return { digest: { runner, storage, bucket }, sink, sql };
}

function embeddingRunner(publisher: unknown, options: { readonly signals?: boolean; readonly sink?: FakeSink } = {}) {
  const sink = options.sink ?? new FakeSink();
  const sql = new FakeSql();
  const storage = new EmbeddingMemoryStorage();
  const bucket = new ReleaseBucket();
  publishRelease(bucket, "feed-2026-10-20T22-07-00-000Z", FIVE);
  const recorder = new SignalRecorder({ environment: "development", sink, sql, now: () => Date.parse("2026-10-20T22:08:00.000Z"), delay: async () => {} });
  const ai = { run: async (_model: string, inputs: Record<string, unknown>) => {
    const text = (inputs as { text: string[] }).text;
    return { shape: [text.length, 1_024], data: text.map(() => Array.from({ length: 1_024 }, () => 1)) };
  } };
  const runner = new SearchEmbeddingRunner({
    storage, bucket, flag: "bge-m3@1", gatewayId: "osskb-search-dev", digestGatewayId: "osskb-digest-dev", ai, index: new FakeVectorIndex(1_024),
    now: () => new Date("2026-10-20T22:08:00.000Z"), delay: async () => undefined,
    ...(options.signals === false ? {} : { signals: { recorder, sourceRunId: async (release: string) => sourceRunIdFrom(publisher, release) } }),
  });
  return { runner, storage, sink, sql };
}

describe("Spec 028 slice 1: every job its own point", () => {
  test("OB23: a publication tick with COST_GUARD=monitor writes publication-… and cost-guard-… once each; the digest and the embedding job point at the publication's runId; a refused write changes no result", async () => {
    const tick = async (sink: FakeSink) => {
      const sql = new FakeSql();
      const vars = { OBSERVABILITY_SIGNALS: "on", SIGNALS: sink, ANALYTICS_SQL: sql };
      const publicationStorage = new DoStorage();
      const guardStorage = new DoStorage();
      const env: Record<string, unknown> = { PUBLICATION_ENVIRONMENT: "development", GITHUB_SOURCE_TOKEN: "placeholder", COST_GUARD: "monitor", CF_ANALYTICS_TOKEN: TOKEN, CF_ACCOUNT_ID: ACCOUNT, OSS_KB_BUCKET: { get: async () => null }, ...vars };
      const publication = publicationObject(publicationStorage, env);
      const guard = new CostGuard({ storage: guardStorage } as unknown as DurableObjectState, env as never);
      env.PIPELINE_STATE = namespace(publication);
      env.COST_GUARD_STATE = namespace(guard);
      const pending: Promise<unknown>[] = [];
      await worker.scheduled({ cron: "7 22 * * *", scheduledTime: Date.parse(TICK) } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
      await Promise.all(pending);
      for (let alarm = 0; alarm < 4; alarm += 1) await publication.alarm();
      const guardHealth = await (await guard.fetch(new Request("https://cost-guard.internal/status"))).json() as Record<string, unknown>;
      return { sink, publicationStorage, guardHealth };
    };
    const healthy = await tick(new FakeSink());
    expect(healthy.sink.points.map((point) => [point.blobs[0], point.indexes[0]])).toEqual([
      ["cost-guard", "cost-guard-2026-10-20T22-07-00-000Z"],
      ["publication", RUN_ID],
    ]);
    expect(healthy.guardHealth).toMatchObject({ runId: "cost-guard-2026-10-20T22-07-00-000Z", trends: { rules: expect.any(Array) } });

    const publisher = { lastRun: { ok: true, runId: RUN_ID, feedReleaseId: "2026-10-20T22-07-00-000Z", searchRevision: "feed-2026-10-20T22-07-00-000Z" } };
    const digest = digestRunner(publisher);
    await digest.digest.runner.alarm();
    const embedding = embeddingRunner(publisher);
    await embedding.runner.alarm();
    for (const [job, sink] of [["digest", digest.sink], ["embedding", embedding.sink]] as const) {
      expect(sink.points).toHaveLength(1);
      expect(sink.points[0]!.blobs[0]).toBe(job);
      expect(sink.points[0]!.blobs[3]).toBe(RUN_ID);
    }

    // The cost guard's write is refused: its check, its /health record and the publication's point are unchanged.
    const refusing = new FakeSink();
    refusing.failFor = "cost-guard";
    logs = [];
    const refused = await tick(refusing);
    expect(refused.sink.points.map((point) => point.indexes[0])).toEqual([RUN_ID]);
    const strip = (health: Record<string, unknown>) => ({ ...health, trends: undefined, checkedAt: undefined, metrics: undefined });
    expect(strip(refused.guardHealth)).toEqual(strip(healthy.guardHealth));
    expect(refused.publicationStorage.values.get("status")).toMatchObject({ ok: false, runId: RUN_ID });
    const logged = logs.map((entry) => entry.value).find((value) => typeof value === "object" && String((value as { message: string }).message).includes("dataset write refused"));
    expect(logged).toMatchObject({ runId: "cost-guard-2026-10-20T22-07-00-000Z", job: "cost-guard" });
  });

  test("OB14: writeDataPoint throwing, or a binding missing: the publication completes ok, the state rules judge, the analytics rules are unknown with a reason, the error carries the runId", async () => {
    const run = async (sink: { writeDataPoint(point: unknown): void } | undefined, sql: AnalyticsSql | undefined) => {
      const storage = new DoStorage();
      const recorder = new SignalRecorder({ environment: "development", sink: sink as never, sql, now: () => Date.parse(fixture.config.materializedAt) + 30_000, delay: async () => {} });
      const status = await runDataPublication({
        environment: "development",
        materializedAt: fixture.config.materializedAt,
        connector: { poll: async (): Promise<GitHubPollResult> => ({ complete: true, events: fixture.events as DomainEventV1[], candidateCheckpoint: { schema: "osskb.github-checkpoint.v1", connectorRevision: "github@1", sources: { "kafka:github": { updatedAt: fixture.config.materializedAt } } }, pageCount: 1, truncated: false }) },
        state: signalingPipelineState(new DurableObjectPipelineState(storage as unknown as DurableObjectStorage), {
          storage, run: { runId: RUN_ID, startedAt: fixture.config.materializedAt }, signals: recorder, now: () => Date.parse(fixture.config.materializedAt) + 30_000,
        }),
        destination: new R2PublicationDestination(new CountingR2Bucket().asBucket()),
      });
      const recorded = storage.peek("status") as Record<string, unknown>;
      const signals = signalsHealth(healthBody({ environment: "development", running: false, scheduled: false, phase: undefined, status: recorded as never }), Date.parse(fixture.config.materializedAt) + 60_000);
      return { status, recorded, signals };
    };
    const throwing = { writeDataPoint() { throw new Error("analytics engine unavailable"); } };
    for (const [sink, sql, reason] of [[throwing, new FakeSql(), "analytics engine unavailable"], [undefined, new FakeSql(), "SIGNALS"], [new FakeSink(), undefined, "ANALYTICS_SQL"]] as const) {
      logs = [];
      const { status, recorded, signals } = await run(sink, sql);
      expect(status.ok).toBe(true);
      expect(recorded).toMatchObject({ ok: true, runId: RUN_ID });
      const state = signals.rules.filter((rule) => rule.source === "state");
      expect(state.find((rule) => rule.id === "publication.freshness")!.status).toBe("ok");
      const analytics = signals.rules.filter((rule) => rule.source === "analytics");
      expect(analytics.length).toBeGreaterThan(0);
      expect(analytics.every((rule) => rule.status === "unknown" && String(rule.reason).includes(reason))).toBe(true);
      expect(signals.lastError).toContain(reason);
      if (sink === throwing) expect(logs.map((entry) => entry.value)).toContainEqual(expect.objectContaining({ runId: RUN_ID, job: "publication" }));
    }
    // Positive control: with both bindings working the analytics rules are judged.
    const working = await run(new FakeSink(), new FakeSql());
    expect(working.signals.rules.find((rule) => rule.id === "job.failures")!.status).toBe("ok");
  });

  test("OB29: each job's trend result lands in its existing status write: Durable Object puts and R2 puts unchanged", async () => {
    const publisher = { lastRun: { ok: true, runId: RUN_ID, feedReleaseId: "2026-10-20T22-07-00-000Z", searchRevision: "feed-2026-10-20T22-07-00-000Z" } };
    const digestOff = digestRunner(publisher, { signals: false });
    await digestOff.digest.runner.alarm();
    const digestOn = digestRunner(publisher);
    await digestOn.digest.runner.alarm();
    expect(digestOn.digest.storage.puts).toBe(digestOff.digest.storage.puts);
    expect(digestOn.digest.bucket.puts).toBe(digestOff.digest.bucket.puts);
    expect(digestOn.digest.storage.peek("lastRun")).toMatchObject({ trends: { rules: expect.any(Array) }, r2: { classA: expect.any(Number), classB: expect.any(Number) } });
    expect(digestOff.digest.storage.peek("lastRun")).not.toHaveProperty("trends");
    expect(digestOn.sql.calls).toHaveLength(1);
    expect(digestOn.sql.calls[0]!.params.job).toBe("digest");

    const embeddingOff = embeddingRunner(publisher, { signals: false });
    await embeddingOff.runner.alarm();
    const embeddingOn = embeddingRunner(publisher);
    await embeddingOn.runner.alarm();
    expect(embeddingOn.storage.writes).toEqual(embeddingOff.storage.writes);
    expect((await embeddingOn.runner.health()).lastRun).toMatchObject({ runId: "embedding-2026-10-20T22-08-00-000Z", sourceRunId: RUN_ID, trends: { rules: expect.any(Array) } });
    expect(embeddingOn.sql.calls.map((call) => call.params.job)).toEqual(["embedding"]);

    // identity-links and kip-pages write last-run.json; the trend result rides that one put.
    const identity = async (signals: boolean) => {
      const bucket = new KeyBucket();
      const { sink, sql } = signalVars();
      const record = await runIdentityLinks({
        flag: "corroborated@1", bucket: new R2IdentityLinksBucket(bucket as never), profiles: PEOPLE_IDENTITY_PROFILES, bots: () => [], suppressed: {}, digest: async () => "",
        now: () => Date.parse("2026-10-21T02:17:00.000Z"),
        ...(signals ? { signals: new SignalRecorder({ environment: "development", sink, sql, now: () => Date.parse("2026-10-21T02:17:01.000Z"), delay: async () => {} }) } : {}),
      });
      return { bucket, record, sink, sql };
    };
    const [identityOff, identityOn] = [await identity(false), await identity(true)];
    expect(identityOn.bucket.puts).toEqual(identityOff.bucket.puts);
    expect(identityOn.record.lastRun).toMatchObject({ runId: "identity-links-2026-10-21T02-17-00-000Z", trends: { rules: expect.any(Array) } });
    expect(identityOn.sink.points).toHaveLength(1);
    expect(identityOn.sql.calls.map((call) => call.params.job)).toEqual(["identity-links"]);
    expect(identityOff.record.lastRun).not.toHaveProperty("runId");

    const kip = async (signals: boolean) => {
      const bucket = new KeyBucket();
      const { vars, sink, sql } = signalVars();
      const health = await kipPagesRun({ PUBLICATION_ENVIRONMENT: "development", KIP_PAGES: "authors@1", OSS_KB_BUCKET: bucket as never, ...(signals ? vars : {}) } as never, false);
      return { bucket, health, sink, sql };
    };
    const [kipOff, kipOn] = [await kip(false), await kip(true)];
    expect(kipOn.bucket.puts).toEqual(kipOff.bucket.puts);
    expect(kipOn.health.lastRun).toMatchObject({ runId: expect.stringMatching(/^kip-pages-/u), trends: { rules: expect.any(Array) } });
    expect(kipOn.sink.points).toHaveLength(1);
    expect(kipOn.sql.calls.map((call) => call.params.job)).toEqual(["kip-pages"]);
    expect(kipOff.health.lastRun).not.toHaveProperty("runId");
  });
});

/** An R2 bucket of string objects that records the keys it puts. */
class KeyBucket {
  readonly objects = new Map<string, string>();
  readonly puts: string[] = [];
  gets = 0;
  async get(key: string) {
    this.gets += 1;
    const body = this.objects.get(key);
    return body === undefined ? null : { text: async () => body, json: async () => JSON.parse(body) };
  }
  async put(key: string, body: string) { this.puts.push(key); this.objects.set(key, body); return { key }; }
}

describe("Spec 028 slice 1: R2 counting in the digest and the embedding job (D8)", () => {
  test("OB22: the bucket both jobs read through counts a get as Class B and each put and list page as Class A", async () => {
    let pages = 0;
    const r2 = {
      get: async () => ({ json: async () => ({}) }),
      list: async () => { pages += 1; return pages === 1 ? { objects: [{ key: "a" }], truncated: true, cursor: "c" } : { objects: [{ key: "b" }], truncated: false }; },
      put: async () => ({}),
    };
    const bucket = new R2DigestBucket(r2 as never);
    expect(bucket.operationCounts()).toEqual({ classA: 0, classB: 0 });
    await bucket.getJson("k");
    expect(await bucket.list("p/")).toEqual(["a", "b"]);
    await bucket.putIfAbsent("x", "{}");
    await bucket.putPointer("y", "{}");
    expect(bucket.operationCounts()).toEqual({ classA: 4, classB: 1 });
  });
});

describe("Spec 028 slice 1: /health and logs", () => {
  test("OB28: with every job enabled one /health read makes 0 queries, 0 writes and the same object and R2 reads as with the flag off, and keeps HTTP status and job statuses whether a rule is ok or firing", async () => {
    // /health judges ages against the real clock: the records are a minute old.
    const RECENT = new Date(Date.now() - 60_000).toISOString();
    const read = async (variables: Record<string, unknown>, classA: number) => {
      const calls: string[] = [];
      const bucket = new KeyBucket();
      bucket.objects.set("internal/kips/v1/last-run.json", JSON.stringify({ revision: "authors@1", lastRun: { ok: true, status: "ok", at: RECENT, durationMs: 1 }, lastGoodAt: RECENT, coverageFrom: null }));
      bucket.objects.set("internal/identity/v1/last-run.json", JSON.stringify({ revision: "corroborated@1", lastRun: { ok: true, status: "ok", at: RECENT, durationMs: 1 }, lastGoodAt: RECENT }));
      const publisherBody = { environment: "development", running: false, scheduled: false, followUp: null, phase: null, lastRun: { ok: true, completedAt: RECENT, copiedObjectCount: 10, r2: { classA, classB: 1 }, runId: RUN_ID }, sources: null };
      const env = {
        PUBLICATION_ENVIRONMENT: "development",
        PIPELINE_STATE: namespace(jsonObject(publisherBody), calls),
        DIGEST_RUN: namespace(jsonObject({ enabled: true, running: false, lastRun: { ok: true, completedAt: RECENT } }), calls),
        SEARCH_EMBEDDING_RUN: namespace(jsonObject({ enabled: true, lastRun: { ok: true, pending: 0, completedAt: RECENT } }), calls),
        SEARCH_EMBEDDING: "bge-m3@1",
        COST_GUARD: "monitor",
        COST_GUARD_STATE: namespace(jsonObject({ mode: "monitor", status: "ok", checkedAt: RECENT }), calls),
        IDENTITY_LINKS: "corroborated@1",
        KIP_PAGES: "authors@1",
        OSS_KB_BUCKET: bucket,
        ...variables,
      };
      const response = await worker.fetch(new Request("https://data.example/health"), env as never);
      const body = await response.json() as Record<string, unknown>;
      return { status: response.status, body, calls, gets: bucket.gets, puts: bucket.puts.length };
    };
    const off = await read({}, 10);
    const { vars, sink, sql } = signalVars();
    const ok = await read(vars, 10);
    const firing = await read(vars, 9_000);
    expect(sink.points).toEqual([]);
    expect(sql.calls).toEqual([]);
    for (const on of [ok, firing]) {
      expect(on.calls).toEqual(off.calls);
      expect(on.gets).toBe(off.gets);
      expect(on.puts).toBe(0);
      expect(on.status).toBe(off.status);
    }
    expect((ok.body.signals as { status: string }).status).not.toBe("firing");
    expect((firing.body.signals as { status: string }).status).toBe("firing");
    // Positive control for the comparison: every enabled job has a job.missed entry, so each record was read.
    const missed = (firing.body.signals as { rules: { id: string; job: string }[] }).rules.filter((rule) => rule.id === "job.missed").map((rule) => rule.job).sort();
    expect(missed).toEqual(["cost-guard", "digest", "embedding", "identity-links", "kip-pages", "publication"]);
    const jobStatus = (body: Record<string, unknown>) => ({
      lastRun: (body.lastRun as { ok: boolean }).ok, digest: (body.digest as { lastRun: { ok: boolean } }).lastRun.ok,
      costGuard: (body.costGuard as { status: string }).status, kipPages: (body.kipPages as { lastRun: { status: string } }).lastRun.status,
      identityLinks: (body.identityLinks as { lastRun: { status: string } }).lastRun.status,
    });
    expect(jobStatus(firing.body)).toEqual(jobStatus(off.body));
    expect(jobStatus(ok.body)).toEqual(jobStatus(off.body));
  });

  test("OB12: every log call of a run receives {message, runId, job}, and message is today's text for the same event", async () => {
    await wholeRun(new DoStorage(), {});
    const today = messages();
    expect(today.length).toBeGreaterThan(0);
    logs = [];
    const { vars } = signalVars();
    await wholeRun(new DoStorage(), vars);
    expect(logs.length).toBe(today.length);
    // Field by field: Bun's toMatchObject with asymmetric matchers writes them into the received object.
    for (const entry of logs) {
      const value = entry.value as Record<string, unknown>;
      expect(Object.keys(value).sort()).toEqual(["job", "message", "runId"]);
      expect([typeof value.message, value.runId, value.job]).toEqual(["string", RUN_ID, "publication"]);
    }
    expect(messages()).toEqual(today);
  });

  test("OB18: a run's log objects add ≤ 100 bytes per line and stay ≤ 20 lines per invocation", async () => {
    const { vars } = signalVars();
    const state = publicationObject(new DoStorage(), vars);
    await trigger(state);
    let worstAdded = 0;
    let worstLines = 0;
    for (let alarm = 0; alarm < 4; alarm += 1) {
      logs = [];
      await state.alarm();
      worstLines = Math.max(worstLines, logs.length);
      for (const entry of logs) {
        const value = entry.value as { message: string };
        worstAdded = Math.max(worstAdded, JSON.stringify(value).length - value.message.length);
      }
    }
    realLog(`OB18 measured: at most ${worstAdded} bytes added per line, ${worstLines} lines per invocation`);
    expect(worstAdded).toBeLessThanOrEqual(100);
    expect(worstLines).toBeLessThanOrEqual(20);
  });
});
