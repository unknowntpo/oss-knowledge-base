/**
 * Spec 026: the account-wide cost guard and its circuit breaker. No test calls the network: the
 * GraphQL answer is a fixture in the documented shape (CG19 replaces it with a recorded one).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { FakeVectorIndex, MemoryGateStorage } from "@oss-knowledge-base/semantic-vectorize/testing";
import { KAFKA_DIGEST_PROFILE } from "@oss-knowledge-base/reference-pipeline";

import r2Usage from "./fixtures/cost-guard/graphql-r2-usage.json";
import { testPlanRows } from "./cost-guard.cases";
import worker, { costGuardDecisionFor, SearchQueryGate } from "../src/index";
import { evaluateMetric, nextBreaker, type Breaker, type CostMetricKey, type MetricEvaluation } from "../src/cost-guard/evaluate";
import { COST_GUARD_OBJECT_NAME, COST_METRICS } from "../src/cost-guard/profile";
import { GRAPHQL_ENDPOINT, parseR2Usage, r2UsageRequest } from "../src/cost-guard/graphql";
import { CostGuardRunner, costGuardDecision, resolveCostGuardMode, type CostGuardRunnerDeps } from "../src/cost-guard/guard";
import { DigestRunner } from "../src/digest/runner";
import type { DigestBucket } from "../src/digest/store";
import { SearchEmbeddingRunner } from "../src/search-embedding/runner";
import { DAY_1, FIVE, MemoryBucket, MemoryStorage, publishRelease } from "./support/search-embedding";

const TOKEN = "cf-analytics-token-under-test-0123456789abcdefABCDEF";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TICK = new Date("2026-10-20T22:07:00.000Z");

class MapStorage {
  readonly values = new Map<string, unknown>();
  writes = 0;
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.writes += 1; this.values.set(key, structuredClone(value)); }
}

function graphqlFetch(answer: () => Response) {
  const calls: { readonly url: string; readonly init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => { calls.push({ url, init }); return answer(); };
  return { calls, fetch };
}

function guard(overrides: Partial<CostGuardRunnerDeps> = {}, answer: () => Response = () => Response.json(r2Usage)) {
  const storage = new MapStorage();
  const network = graphqlFetch(answer);
  const clock = { now: TICK };
  const inApp = {
    neuronsToday: async (): Promise<number | null> => 169,
    vectorize: async (_month: string): Promise<{ storedDimensions: number; queriedDimensions: number } | null> => ({ storedDimensions: 9_998_336, queriedDimensions: 10_244_096 }),
  };
  const runner = new CostGuardRunner({
    storage, flag: "monitor", token: TOKEN, accountId: ACCOUNT, fetch: network.fetch, now: () => clock.now, inApp,
    ...overrides,
  });
  return { storage, network, clock, runner };
}

/** Every metric at `value`% of its allowance (or unavailable when null). */
function metricsAt(percents: Partial<Record<CostMetricKey, number | null>>): Partial<Record<CostMetricKey, MetricEvaluation>> {
  return Object.fromEntries(Object.entries(percents).map(([key, percent]) => [key,
    evaluateMetric(key as CostMetricKey, percent === null ? null : (COST_METRICS[key as CostMetricKey].allowance * percent!) / 100, new Date("2026-10-31T22:07:00Z"))]));
}

describe("Spec 026 cost guard", () => {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realLog = console.log;
  afterEach(() => { globalThis.fetch = realFetch; console.error = realError; console.log = realLog; });

  test.each([...testPlanRows])("$id: $case", (row) => {
    const evaluation = evaluateMetric(row.metric, row.value, new Date(row.now));
    expect({ percent: evaluation.percent, projectedPercent: evaluation.projectedPercent, status: evaluation.status })
      .toEqual({ percent: row.percent, projectedPercent: row.projectedPercent, status: row.status });
    expect(evaluation.allowance).toBe(COST_METRICS[row.metric].allowance);
  });

  test("CG1: COST_GUARD unset, blank or off is off; monitor and enforce are modes; anything else is invalid", () => {
    expect([undefined, "", "  ", "off", "monitor", " enforce ", "on", "true"].map(resolveCostGuardMode))
      .toEqual(["off", "off", "off", "off", "monitor", "enforce", "invalid", "invalid"]);
  });

  test("CG1: while off a tick only schedules the publication, /health has no costGuard, and the cost routes answer 403", async () => {
    const run = (flag: string | undefined) => {
      const log: string[] = [];
      const stub = (body: unknown) => ({ idFromName: (name: string) => name, get: () => ({ fetch: async (url: string, init?: RequestInit) => { log.push(`${init?.method ?? "GET"} ${url}`); return Response.json(body, { status: url.endsWith("/run") ? 202 : 200 }); } }) });
      const env = {
        PUBLICATION_ENVIRONMENT: "development", MANUAL_TRIGGER_TOKEN: "manual-under-test",
        PIPELINE_STATE: stub({ environment: "development", running: false }), DIGEST_RUN: stub({ running: false }),
        COST_GUARD_STATE: stub({ refuse: false, pausePublication: false, mode: "monitor", status: "ok" }),
        CF_ANALYTICS_TOKEN: TOKEN, CF_ACCOUNT_ID: ACCOUNT,
        OSS_KB_BUCKET: { get: async () => null },
        ...(flag === undefined ? {} : { COST_GUARD: flag }),
      };
      return { env, log };
    };
    const tick = async (env: unknown) => {
      const pending: Promise<unknown>[] = [];
      await worker.scheduled({ cron: "7 22 * * *", scheduledTime: TICK.getTime() } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
      await Promise.all(pending);
    };
    const off = run(undefined);
    await tick(off.env);
    expect(off.log).toEqual(["POST https://pipeline.internal/run"]);
    const health = await (await worker.fetch(new Request("https://data.example/health"), off.env as never)).json() as Record<string, unknown>;
    expect(health).not.toHaveProperty("costGuard");
    for (const path of ["/cost-guard/check", "/cost-guard/reset"]) {
      const response = await worker.fetch(new Request(`https://data.example${path}`, { method: "POST", headers: { authorization: "Bearer manual-under-test" } }), off.env as never);
      expect(response.status).toBe(403);
      expect(await response.json() as unknown).toEqual({ ok: false, disabled: true });
    }
    expect(off.log.filter((line) => line.includes("cost-guard"))).toEqual([]);

    // Positive control: with monitor the same tick also asks the guard to check, and /health carries the block.
    const on = run("monitor");
    await tick(on.env);
    expect(on.log).toEqual(["POST https://pipeline.internal/run", "POST https://cost-guard.internal/check"]);
    const onHealth = await (await worker.fetch(new Request("https://data.example/health"), on.env as never)).json() as Record<string, unknown>;
    expect(onHealth).toHaveProperty("costGuard");
  });

  test("CG3: the documented-shape fixture parses to Class A, Class B and storage; free operations are left out and unknown ones count as Class A", () => {
    expect(parseR2Usage(r2Usage)).toEqual({ classA: 15_007, classB: 170_000, storageBytes: 1_501_200_000, unclassifiedActions: ["SomeNewAction"] });
    expect(() => parseR2Usage({ data: null, errors: [{ message: "not authorized for that account" }] })).toThrow("not authorized for that account");
    expect(() => parseR2Usage({ data: { viewer: { accounts: [] } } })).toThrow();
    expect(() => parseR2Usage("<html>")).toThrow();
  });

  test("CG4: one POST to the GraphQL endpoint with the bearer token, the account, the month start and now", async () => {
    const { runner, network } = guard();
    await runner.check({ dryRun: true });
    expect(network.calls).toHaveLength(1);
    const [call] = network.calls;
    expect(call!.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(GRAPHQL_ENDPOINT).toBe(call!.url);
    expect(call!.init.method).toBe("POST");
    expect(new Headers(call!.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(call!.init.body)) as { query: string; variables: Record<string, string> };
    expect(body).toEqual(r2UsageRequest(ACCOUNT, TICK));
    expect(body.variables).toEqual({ accountTag: ACCOUNT, start: "2026-10-01T00:00:00.000Z", end: "2026-10-20T22:07:00.000Z", storageStart: "2026-10-18T22:07:00.000Z" });
    expect(body.query).toContain("r2OperationsAdaptiveGroups");
    expect(body.query).toContain("r2StorageAdaptiveGroups");
    expect(body.query).toContain("accounts(filter: { accountTag: $accountTag })");
    expect(body.query).not.toContain(TOKEN);
  });

  test("CG5: a tripped metric opens a closed breaker; later trips are added; a calm check leaves it open", () => {
    const closed: Breaker = { tripped: false };
    const at = new Date("2026-10-20T22:07:00.000Z");
    expect(nextBreaker(closed, metricsAt({ r2ClassA: 10, workersAiNeurons: 70 }), at)).toEqual(closed);
    const open = nextBreaker(closed, metricsAt({ r2ClassA: 85, vectorizeQueriedDimensions: 90, workersAiNeurons: 70 }), at);
    expect(open).toEqual({
      tripped: true,
      reason: "vectorizeQueriedDimensions at 90% of 50000000 (trips at 80%)",
      metric: "vectorizeQueriedDimensions",
      value: 45_000_000,
      threshold: 40_000_000,
      trippedAt: "2026-10-20T22:07:00.000Z",
      metrics: ["r2ClassA", "vectorizeQueriedDimensions"],
    });
    const later = nextBreaker(open, metricsAt({ workersAiNeurons: 95, r2ClassA: 81 }), new Date("2026-10-21T22:07:00.000Z"));
    expect(later).toEqual({ ...open, metrics: ["r2ClassA", "vectorizeQueriedDimensions", "workersAiNeurons"] } as Breaker);
    expect(nextBreaker(later, metricsAt({ r2ClassA: 1 }), new Date("2026-11-01T22:07:00.000Z"))).toEqual(later);
    // A projection trip names the allowance as its threshold.
    const projected = nextBreaker(closed, { r2ClassA: evaluateMetric("r2ClassA", 300_000, new Date("2026-10-08T18:00:00Z")) }, at);
    expect(projected).toMatchObject({ tripped: true, metric: "r2ClassA", value: 300_000, threshold: 1_000_000, reason: "r2ClassA projected at 120% of 1000000 by the end of its period" });
    // Stored dimensions never trip, and unavailable values never trip.
    expect(nextBreaker(closed, metricsAt({ vectorizeStoredDimensions: 150, r2ClassB: null }), at)).toEqual(closed);
  });

  test("CG5, CG17: a real check over a threshold opens the breaker and survives a new month; a reset closes it; the next check reopens it", async () => {
    const { runner, storage, clock } = guard({ inApp: { neuronsToday: async () => 9_000, vectorize: async () => null } });
    const first = await runner.check({ dryRun: false }) as { breaker: Breaker; status: string };
    expect(first.status).toBe("tripped");
    expect(first.breaker).toMatchObject({ tripped: true, metric: "workersAiNeurons", value: 9_000, threshold: 8_000, trippedAt: TICK.toISOString() });
    expect(storage.writes).toBe(1);
    clock.now = new Date("2026-11-01T22:07:00.000Z");
    const calm = guard({ inApp: { neuronsToday: async () => 10, vectorize: async () => null } });
    calm.storage.values.set("state", storage.values.get("state"));
    calm.clock.now = clock.now;
    expect((await calm.runner.check({ dryRun: false }) as { breaker: Breaker }).breaker).toMatchObject({ tripped: true, metric: "workersAiNeurons" });

    clock.now = new Date("2026-10-21T01:00:00.000Z");
    expect(await runner.reset()).toEqual({ ok: true, breaker: { tripped: false }, lastResetAt: "2026-10-21T01:00:00.000Z" });
    expect((await runner.health()).breaker).toEqual({ tripped: false });
    expect((await runner.health()).lastResetAt).toBe("2026-10-21T01:00:00.000Z");
    clock.now = new Date("2026-10-21T22:07:00.000Z");
    expect((await runner.check({ dryRun: false }) as { breaker: Breaker }).breaker).toMatchObject({ tripped: true, trippedAt: "2026-10-21T22:07:00.000Z" });
  });

  test("CG6: the reset route needs the bearer token; without it the breaker stays open", async () => {
    const calls: string[] = [];
    const env = {
      PUBLICATION_ENVIRONMENT: "development", MANUAL_TRIGGER_TOKEN: "manual-under-test", COST_GUARD: "enforce",
      PIPELINE_STATE: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) },
      DIGEST_RUN: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) },
      COST_GUARD_STATE: { idFromName: (n: string) => { calls.push(`id ${n}`); return n; }, get: () => ({ fetch: async (url: string, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${url}`); return Response.json({ ok: true, breaker: { tripped: false } }); } }) },
    };
    const denied = await worker.fetch(new Request("https://data.example/cost-guard/reset", { method: "POST" }), env as never);
    expect(denied.status).toBe(401);
    const wrong = await worker.fetch(new Request("https://data.example/cost-guard/reset", { method: "POST", headers: { authorization: "Bearer nope" } }), env as never);
    expect(wrong.status).toBe(401);
    expect(calls).toEqual([]);
    const allowed = await worker.fetch(new Request("https://data.example/cost-guard/reset", { method: "POST", headers: { authorization: "Bearer manual-under-test" } }), env as never);
    expect(allowed.status).toBe(200);
    expect(calls).toEqual([`id ${COST_GUARD_OBJECT_NAME}`, "POST https://cost-guard.internal/reset"]);
  });

  test("CG7, CG8: enforce refuses while open; monitor never refuses; only an r2ClassA trip pauses the publication", () => {
    const open = (metrics: CostMetricKey[]): Breaker => ({ tripped: true, reason: "r", metric: metrics[0]!, value: 1, threshold: 1, trippedAt: TICK.toISOString(), metrics });
    expect(costGuardDecision("enforce", open(["vectorizeQueriedDimensions"]))).toEqual({ refuse: true, pausePublication: false });
    expect(costGuardDecision("enforce", open(["workersAiNeurons", "r2ClassA"]))).toEqual({ refuse: true, pausePublication: true });
    expect(costGuardDecision("monitor", open(["r2ClassA"]))).toEqual({ refuse: false, pausePublication: false });
    expect(costGuardDecision("enforce", { tripped: false })).toEqual({ refuse: false, pausePublication: false });
    expect(costGuardDecision("invalid", open(["r2ClassA"]))).toEqual({ refuse: false, pausePublication: false });
  });

  describe("CG7: guarded features", () => {
    class CountingDigestBucket implements DigestBucket {
      calls = 0;
      async getJson(): Promise<unknown> { this.calls += 1; return null; }
      async list(): Promise<string[]> { this.calls += 1; return []; }
      async putIfAbsent(): Promise<boolean> { this.calls += 1; return true; }
      async putPointer(): Promise<void> { this.calls += 1; }
    }
    function digest(refuse: boolean) {
      const values = new Map<string, unknown>();
      let alarm: number | null = null;
      const bucket = new CountingDigestBucket();
      const runner = new DigestRunner({
        storage: {
          get: async <T>(key: string) => values.get(key) as T | undefined,
          put: async (key, value) => { values.set(key, value); },
          delete: async (key) => values.delete(key),
          getAlarm: async () => alarm,
          setAlarm: async (time) => { alarm = time; },
        },
        bucket, profile: KAFKA_DIGEST_PROFILE, environment: "development", enabled: true,
        now: () => TICK, delay: async () => undefined, publisherBusy: async () => false,
        costGuardRefuses: async () => refuse,
      });
      return { runner, bucket, alarmAt: () => alarm };
    }

    test("CG7: the digest refuses its request (dry run too) and its alarm runs nothing; under monitor it runs", async () => {
      const refused = digest(true);
      expect(await refused.runner.request(false)).toEqual({ status: 503, body: { ok: false, skipped: "cost-guard" } });
      expect(await refused.runner.request(true)).toEqual({ status: 503, body: { ok: false, skipped: "cost-guard" } });
      expect(refused.alarmAt()).toBeNull();
      await refused.runner.alarm();
      expect(refused.bucket.calls).toBe(0);
      // Positive control: the same runner not refused reads the bucket on a dry run and schedules a real run.
      const allowed = digest(false);
      await allowed.runner.request(true);
      expect(allowed.bucket.calls).toBeGreaterThan(0);
      expect((await allowed.runner.request(false)).status).toBe(202);
    });

    function embedding(refuse: boolean | (() => Promise<boolean>)) {
      const storage = new MemoryStorage();
      const bucket = new MemoryBucket();
      const index = new FakeVectorIndex(1_024);
      const calls: string[] = [];
      const ai = { run: async (_model: string, inputs: Record<string, unknown>) => { calls.push("model"); return { data: (inputs.text as string[]).map(() => Array.from({ length: 1_024 }, () => 1)) }; } };
      publishRelease(bucket, "r1", FIVE);
      const runner = new SearchEmbeddingRunner({
        storage, bucket, flag: "bge-m3@1", gatewayId: "osskb-search-dev", digestGatewayId: "osskb-digest-dev", ai, index,
        now: () => new Date(DAY_1), delay: async () => undefined,
        costGuardRefuses: typeof refuse === "function" ? refuse : async () => refuse,
      });
      return { runner, storage, bucket, index, calls };
    }

    test("CG7: the embedding job refuses every request but a reset, and its alarm embeds nothing; under monitor it embeds", async () => {
      const refused = embedding(true);
      expect(await refused.runner.request()).toEqual({ status: 503, body: { ok: false, skipped: "cost-guard" } });
      expect(await refused.runner.request({ dryRun: true })).toEqual({ status: 503, body: { ok: false, skipped: "cost-guard" } });
      expect(await refused.runner.request({ reset: true })).toEqual({ status: 200, body: { ok: true, scheduled: false, forgotten: 0 } });
      expect(refused.storage.alarm).toBeNull();
      await refused.runner.alarm();
      expect(refused.calls).toEqual([]);
      expect(refused.index.calls).toEqual([]);
      expect(refused.bucket.reads).toEqual([]);
      const allowed = embedding(false);
      expect((await allowed.runner.request()).status).toBe(202);
      await allowed.runner.alarm();
      expect(allowed.calls.length).toBeGreaterThan(0);
      expect(allowed.index.vectors.size).toBe(5);
    });

    function gateEnv(decision: () => Promise<Response>) {
      const ai = { calls: 0, run: async (_m: string, inputs: Record<string, unknown>) => { ai.calls += 1; return { data: (inputs.text as string[]).map(() => Array.from({ length: 1_024 }, () => 1)) }; } };
      const index = new FakeVectorIndex(1_024);
      const storage = new MemoryGateStorage();
      const env = {
        COST_GUARD: "enforce", SEARCH_EMBEDDING: "bge-m3@1", SEARCH_GATEWAY_ID: "osskb-search-dev", DIGEST_GATEWAY_ID: "osskb-digest-dev", AI: ai, SEARCH_VECTORS: index,
        COST_GUARD_STATE: { idFromName: (n: string) => n, get: () => ({ fetch: decision }) },
      };
      const gate = new SearchQueryGate({ storage: { get: (k: string) => storage.get(k), put: (k: string, v: unknown) => storage.put(k, v), delete: (k: string[]) => storage.delete(k), list: (o: { prefix: string; limit?: number }) => storage.list(o) } } as never, env as never);
      const ask = async () => (await gate.fetch(new Request("https://search-query.internal/query", { method: "POST", body: JSON.stringify({ query: "transaction timeout", projectIds: ["apache-kafka"] }) }))).json();
      return { ai, index, ask, gate };
    }

    test("CG7: the query gate answers over-budget without touching its ledger, the model or the index; not refused it embeds", async () => {
      const refused = gateEnv(async () => Response.json({ refuse: true, pausePublication: false }));
      expect(await refused.ask()).toEqual({ status: "over-budget", retryAfterMs: 3_600_000 });
      expect(refused.ai.calls).toBe(0);
      expect(refused.index.calls).toEqual([]);
      const health = await (await refused.gate.fetch(new Request("https://search-query.internal/status"))).json() as { today: { neurons: number; indexQueries: number } };
      expect(health.today).toMatchObject({ neurons: 0, indexQueries: 0 });
      const allowed = gateEnv(async () => Response.json({ refuse: false, pausePublication: false }));
      expect(await allowed.ask()).toMatchObject({ status: "ok" });
      expect(allowed.ai.calls).toBe(1);
    });

    test("CG15: a guard that throws or answers 500 under enforce does not stop the gate, the digest or the embedding job", async () => {
      for (const failing of [async (): Promise<Response> => { throw new Error("object unreachable"); }, async () => new Response("boom", { status: 500 })]) {
        const gate = gateEnv(failing);
        expect(await gate.ask()).toMatchObject({ status: "ok" });
        const env = { COST_GUARD: "enforce", COST_GUARD_STATE: { idFromName: (n: string) => n, get: () => ({ fetch: failing }) } };
        expect(await costGuardDecisionFor(env as never)).toEqual({ refuse: false, pausePublication: false });
      }
      // Positive control: a guard answering refuse is obeyed through the same path.
      expect(await costGuardDecisionFor({ COST_GUARD: "enforce", COST_GUARD_STATE: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ refuse: true, pausePublication: true }) }) } } as never))
        .toEqual({ refuse: true, pausePublication: true });
      // Off or monitor never asks the object.
      let asked = 0;
      const counting = { idFromName: (n: string) => n, get: () => ({ fetch: async () => { asked += 1; return Response.json({ refuse: true, pausePublication: true }); } }) };
      expect(await costGuardDecisionFor({ COST_GUARD_STATE: counting } as never)).toEqual({ refuse: false, pausePublication: false });
      expect(await costGuardDecisionFor({ COST_GUARD: "monitor", COST_GUARD_STATE: counting } as never)).toEqual({ refuse: false, pausePublication: false });
      expect(asked).toBe(0);
    });
  });

  test("CG8: an r2ClassA pause makes POST /run answer 503 and the publication alarm do nothing; another trip lets it run", async () => {
    const { PipelineState } = await import("../src/index");
    const object = (decision: { refuse: boolean; pausePublication: boolean }) => {
      const values = new Map<string, unknown>();
      let alarm: number | null = null;
      const storage = {
        get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key), getAlarm: async () => alarm, setAlarm: async (time: number) => { alarm = time; },
      };
      const env = {
        PUBLICATION_ENVIRONMENT: "development", COST_GUARD: "enforce",
        COST_GUARD_STATE: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json(decision) }) },
      };
      return { state: new PipelineState({ storage } as never, env as never), alarmAt: () => alarm };
    };
    const post = () => new Request("https://pipeline.internal/run", { method: "POST" });
    const paused = object({ refuse: true, pausePublication: true });
    const response = await paused.state.fetch(post());
    expect(response.status).toBe(503);
    expect(await response.json() as unknown).toEqual({ ok: false, skipped: "cost-guard" });
    expect(paused.alarmAt()).toBeNull();
    let requested = 0;
    globalThis.fetch = (async () => { requested += 1; return new Response("not found", { status: 404 }); }) as unknown as typeof fetch;
    await paused.state.alarm();
    expect(requested).toBe(0);
    // Positive control: a breaker opened by another metric schedules the publication.
    const running = object({ refuse: true, pausePublication: false });
    expect((await running.state.fetch(post())).status).toBe(202);
    expect(running.alarmAt()).not.toBeNull();
  });

  test("CG8: an r2ClassA pause also skips the tick's review ingestion", async () => {
    const run = async (pausePublication: boolean) => {
      const outbound: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => { outbound.push(String(input)); return Response.json([]); }) as typeof fetch;
      const stub = (body: unknown) => ({ idFromName: (name: string) => name, get: () => ({ fetch: async (url: string) => Response.json(body, { status: url.endsWith("/run") ? 202 : 200 }) }) });
      const env = {
        PUBLICATION_ENVIRONMENT: "development", GITHUB_SOURCE_TOKEN: "t", GITHUB_REVIEWS: "metadata@1", COST_GUARD: "enforce",
        PIPELINE_STATE: stub({}), DIGEST_RUN: stub({}),
        COST_GUARD_STATE: stub({ refuse: true, pausePublication }),
        OSS_KB_BUCKET: { get: async () => null, put: async () => ({}) },
      };
      const pending: Promise<unknown>[] = [];
      await worker.scheduled({ cron: "7 22 * * *", scheduledTime: TICK.getTime() } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
      await Promise.all(pending);
      return outbound.filter((url) => url.startsWith("https://api.github.com/"));
    };
    expect(await run(true)).toEqual([]);
    expect((await run(false)).length).toBeGreaterThan(0);
  });

  test("CG9: in-app estimates: neurons today from the three ledgers; Vectorize stored and queried dimensions from the index and the gate's month", async () => {
    const { inAppSources } = await import("../src/index");
    const status = (body: unknown) => ({ idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json(body) }) });
    const index = { describe: async () => ({ vectorCount: 9_764, dimensions: 1_024 }) };
    const env = {
      AI: {}, SEARCH_VECTORS: index,
      DIGEST_RUN: status({ today: { date: "2026-10-20", estimatedNeurons: 120 } }),
      SEARCH_EMBEDDING_RUN: status({ today: { date: "2026-10-20", estimatedNeurons: 46 } }),
      SEARCH_QUERY_GATE: { idFromName: (n: string) => n, get: () => ({ fetch: async (url: string) => Response.json(url.includes("/month") ? { month: "2026-10", indexQueries: 240 } : { today: { date: "2026-10-20", neurons: 3 } }) }) },
    };
    const sources = inAppSources(env as never, () => TICK);
    expect(await sources.neuronsToday()).toBe(169);
    expect(await sources.vectorize("2026-10")).toEqual({ storedDimensions: 9_998_336, queriedDimensions: 10_244_096 });
    // A ledger of another day counts nothing (the object has not written today yet).
    const yesterday = inAppSources({ ...env, DIGEST_RUN: status({ today: { date: "2026-10-19", estimatedNeurons: 4_000 } }) } as never, () => TICK);
    expect(await yesterday.neuronsToday()).toBe(49);
    const prod = inAppSources({ DIGEST_RUN: status({ today: { date: "2026-10-20", estimatedNeurons: 0 } }) } as never, () => TICK);
    expect(await prod.neuronsToday()).toBeNull();
    expect(await prod.vectorize("2026-10")).toBeNull();
  });

  test("CG9: the gate reports its month-to-date index queries from its daily ledgers", async () => {
    const storage = new MemoryGateStorage();
    await storage.put("spend:2026-09-30", { neurons: 1, modelCalls: 1, indexQueries: 500, hour: "2026-09-30T10", hourModelCalls: 1 });
    await storage.put("spend:2026-10-01", { neurons: 1, modelCalls: 1, indexQueries: 200, hour: "2026-10-01T10", hourModelCalls: 1 });
    await storage.put("spend:2026-10-20", { neurons: 2, modelCalls: 2, indexQueries: 40, hour: "2026-10-20T10", hourModelCalls: 2 });
    const gate = new SearchQueryGate({ storage: { get: (k: string) => storage.get(k), put: (k: string, v: unknown) => storage.put(k, v), delete: (k: string[]) => storage.delete(k), list: (o: { prefix: string; limit?: number }) => storage.list(o) } } as never, {} as never);
    const answer = await (await gate.fetch(new Request("https://search-query.internal/month?month=2026-10"))).json();
    expect(answer).toEqual({ month: "2026-10", indexQueries: 240 });
    expect((await gate.fetch(new Request("https://search-query.internal/month?month=October"))).status).toBe(400);
  });

  test("CG9: a check combines GraphQL R2 numbers with the in-app estimates", async () => {
    const { runner } = guard();
    const result = await runner.check({ dryRun: true }) as { metrics: Record<CostMetricKey, MetricEvaluation> };
    expect(Object.fromEntries(Object.entries(result.metrics).map(([key, metric]) => [key, [metric.value, metric.status, metric.scope, metric.source]]))).toEqual({
      r2ClassA: [15_007, "ok", "account", "graphql"],
      r2ClassB: [170_000, "ok", "account", "graphql"],
      r2StorageBytes: [1_501_200_000, "ok", "account", "graphql"],
      vectorizeStoredDimensions: [9_998_336, "warn", "worker", "in-app"],
      vectorizeQueriedDimensions: [10_244_096, "ok", "worker", "in-app"],
      workersAiNeurons: [169, "ok", "worker", "in-app"],
    });
    const unavailable = guard({ inApp: { neuronsToday: async () => null, vectorize: async () => null } });
    const partial = await unavailable.runner.check({ dryRun: true }) as { metrics: Record<CostMetricKey, MetricEvaluation> };
    expect([partial.metrics.workersAiNeurons.status, partial.metrics.vectorizeStoredDimensions.status, partial.metrics.vectorizeQueriedDimensions.status]).toEqual(["unavailable", "unavailable", "unavailable"]);
  });

  test("CG10: a dry run returns the evaluation and writes nothing, also when a metric trips", async () => {
    const { runner, storage } = guard({ inApp: { neuronsToday: async () => 9_500, vectorize: async () => null } });
    const result = await runner.check({ dryRun: true }) as { dryRun: boolean; status: string; wouldTrip: boolean; metrics: Record<string, MetricEvaluation> };
    expect(result).toMatchObject({ dryRun: true, status: "tripped", wouldTrip: true });
    expect(result.metrics.workersAiNeurons!.status).toBe("tripped");
    expect(storage.writes).toBe(0);
    expect((await runner.health()).breaker).toEqual({ tripped: false });
    expect((await runner.health()).status).toBe("pending");
    // Positive control: the same check, not dry, writes once and opens the breaker.
    await runner.check({ dryRun: false });
    expect(storage.writes).toBe(1);
    expect((await runner.health()).breaker).toMatchObject({ tripped: true });
  });

  test("CG11: /health costGuard has the same keys for pending, ok, warn, tripped and unconfigured", async () => {
    const keys = ["breaker", "checkedAt", "lastError", "lastResetAt", "metrics", "mode", "reason", "status"];
    const pending = guard();
    const before = await pending.runner.health();
    expect(Object.keys(before).sort()).toEqual(keys);
    expect(before).toMatchObject({ mode: "monitor", status: "pending", reason: null, checkedAt: null, metrics: {}, breaker: { tripped: false }, lastResetAt: null, lastError: null });

    const ok = guard({ inApp: { neuronsToday: async () => 10, vectorize: async () => ({ storedDimensions: 1_000, queriedDimensions: 2_000 }) } });
    await ok.runner.check({ dryRun: false });
    const okHealth = await ok.runner.health();
    expect(okHealth).toMatchObject({ status: "ok", checkedAt: TICK.toISOString() });
    expect(Object.keys(okHealth.metrics).sort()).toEqual(["r2ClassA", "r2ClassB", "r2StorageBytes", "vectorizeQueriedDimensions", "vectorizeStoredDimensions", "workersAiNeurons"]);
    expect(Object.keys(okHealth.metrics.r2ClassA!).sort()).toEqual(["allowance", "percent", "period", "projectedPercent", "scope", "source", "status", "value"]);

    const warn = guard();
    await warn.runner.check({ dryRun: false });
    expect((await warn.runner.health()).status).toBe("warn");

    const tripped = guard({ inApp: { neuronsToday: async () => 9_000, vectorize: async () => null } });
    await tripped.runner.check({ dryRun: false });
    expect((await tripped.runner.health()).status).toBe("tripped");

    const unconfigured = guard({ token: undefined });
    const health = await unconfigured.runner.health();
    expect(Object.keys(health).sort()).toEqual(keys);
    expect(health).toMatchObject({ status: "unconfigured", reason: "CF_ANALYTICS_TOKEN is not set" });

    // The Worker's /health carries the object's body under costGuard; without the binding it reports unconfigured itself.
    const env = (binding: unknown) => ({
      PUBLICATION_ENVIRONMENT: "development", COST_GUARD: "monitor", CF_ANALYTICS_TOKEN: TOKEN, CF_ACCOUNT_ID: ACCOUNT,
      PIPELINE_STATE: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ environment: "development" }) }) },
      DIGEST_RUN: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) },
      OSS_KB_BUCKET: { get: async () => null },
      ...(binding === undefined ? {} : { COST_GUARD_STATE: binding }),
    });
    const unbound = await (await worker.fetch(new Request("https://data.example/health"), env(undefined) as never)).json() as { costGuard: Record<string, unknown> };
    expect(Object.keys(unbound.costGuard).sort()).toEqual(keys);
    expect(unbound.costGuard).toMatchObject({ mode: "monitor", status: "unconfigured", reason: "the COST_GUARD_STATE binding is missing" });
    const bound = await (await worker.fetch(new Request("https://data.example/health"), env({ idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json(okHealth) }) }) as never)).json() as { costGuard: unknown };
    expect(bound.costGuard).toEqual(JSON.parse(JSON.stringify(okHealth)));
  });

  test("CG13: a missing token, account id or an invalid flag is unconfigured: no fetch, no write, the reason names what is missing", async () => {
    for (const [overrides, reason] of [
      [{ token: undefined }, "CF_ANALYTICS_TOKEN is not set"],
      [{ token: "  " }, "CF_ANALYTICS_TOKEN is not set"],
      [{ accountId: undefined }, "CF_ACCOUNT_ID is not set"],
      [{ token: undefined, accountId: "" }, "CF_ANALYTICS_TOKEN is not set; CF_ACCOUNT_ID is not set"],
      [{ flag: "on" }, 'COST_GUARD "on" is not off, monitor or enforce'],
    ] as const) {
      let inApp = 0;
      const { runner, network, storage } = guard({ ...overrides, inApp: { neuronsToday: async () => { inApp += 1; return 1; }, vectorize: async () => { inApp += 1; return null; } } });
      expect(await runner.check({ dryRun: false })).toEqual({ ok: false, status: "unconfigured", reason });
      expect(network.calls).toEqual([]);
      expect(inApp).toBe(0);
      expect(storage.writes).toBe(0);
    }
    // Positive control: configured, the same check fetches once.
    const configured = guard();
    await configured.runner.check({ dryRun: false });
    expect(configured.network.calls).toHaveLength(1);
  });

  test("CG14: an HTTP 500, an errors[] body or a malformed body leaves R2 unavailable, records lastError, keeps in-app metrics and the breaker closed", async () => {
    for (const answer of [
      () => new Response("upstream error", { status: 500 }),
      () => Response.json({ data: null, errors: [{ message: "rate limited" }] }),
      () => new Response("<html>", { status: 200 }),
    ]) {
      const { runner } = guard({ inApp: { neuronsToday: async () => 50, vectorize: async () => null } }, answer);
      const result = await runner.check({ dryRun: false }) as { ok: boolean; metrics: Record<string, MetricEvaluation>; breaker: Breaker };
      expect(result.ok).toBe(false);
      expect([result.metrics.r2ClassA!.status, result.metrics.r2ClassB!.status, result.metrics.r2StorageBytes!.status]).toEqual(["unavailable", "unavailable", "unavailable"]);
      expect(result.metrics.workersAiNeurons!.value).toBe(50);
      expect(result.breaker).toEqual({ tripped: false });
      const health = await runner.health();
      expect(health.lastError).toMatchObject({ at: TICK.toISOString() });
      expect(typeof health.lastError!.message).toBe("string");
      expect(health.status).toBe("ok");
    }
  });

  test("CG14: a successful check after a failed one clears lastError", async () => {
    let fail = true;
    const { runner } = guard({}, () => (fail ? new Response("upstream error", { status: 500 }) : Response.json(r2Usage)));
    await runner.check({ dryRun: false });
    expect((await runner.health()).lastError).toMatchObject({ at: TICK.toISOString() });
    fail = false;
    const result = await runner.check({ dryRun: false }) as { ok: boolean; lastError: unknown };
    expect(result).toMatchObject({ ok: true, lastError: null });
    expect((await runner.health()).lastError).toBeNull();
  });

  test("CG16: the token is in no log line, stored state, health body or check response, on success or failure", async () => {
    const logged: string[] = [];
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    const outputs: string[] = [];
    for (const answer of [
      () => Response.json(r2Usage),
      () => new Response(`denied for Bearer ${TOKEN}`, { status: 403 }),
      () => Response.json({ errors: [{ message: `token ${TOKEN} is invalid` }] }),
      () => { throw new Error(`fetch failed with authorization Bearer ${TOKEN}`); },
    ]) {
      const { runner, storage } = guard({}, answer);
      outputs.push(JSON.stringify(await runner.check({ dryRun: false })));
      outputs.push(JSON.stringify(await runner.health()));
      outputs.push(JSON.stringify([...storage.values.values()]));
    }
    // A token shorter than the sanitizer's 32-character rule is still removed by name.
    const short = guard({ token: "short-token-1" }, () => Response.json({ errors: [{ message: "token short-token-1 is invalid" }] }));
    outputs.push(JSON.stringify(await short.runner.check({ dryRun: false })));
    expect(outputs.at(-1)).not.toContain("short-token-1");
    // Positive control: the failing paths did record an error, so the redaction was exercised.
    expect(outputs.join("\n")).toContain("[redacted]");
    expect(outputs.join("\n")).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  test("CG18: a real check is one GraphQL request, one in-app read of each kind and one storage write", async () => {
    let neurons = 0;
    let vectors = 0;
    const { runner, network, storage } = guard({ inApp: { neuronsToday: async () => { neurons += 1; return 1; }, vectorize: async () => { vectors += 1; return null; } } });
    await runner.check({ dryRun: false });
    expect([network.calls.length, neurons, vectors, storage.writes]).toEqual([1, 1, 1, 1]);
  });
});
