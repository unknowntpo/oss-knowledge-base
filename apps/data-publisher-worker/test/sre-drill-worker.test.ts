/**
 * Spec 027 "Dev fault-injection drill" in the data publisher Worker (sre-drill-worker.cases.ts): the
 * arm and cancel route, the Prod guard, the `throw` and `skip` faults in `kip-pages`, the manual tick,
 * expiry and errors, and the end-to-end budget. Fakes only: a recording bucket, a fake Analytics
 * Engine (points written are what the history query reads), a scripted mock model; no network.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { DRILL_POINTER_KEY, PLAYBOOK_LIBRARY, armDrill, drillExpectations, drillRecordKey, type DrillRecord, type PlaybookLibrary } from "@oss-knowledge-base/sre-agent";
import worker, { tickHealth } from "../src/index";
import { r2Store, sreAgentTick, type SreAgentEnv } from "../src/sre-agent/run";
import { testPlanRows } from "./sre-drill-worker.cases";

const T0 = Date.parse("2026-10-25T09:30:00.000Z");
const at = (minutes: number) => T0 + minutes * 60_000;
const DRILL_ID = "throw-20261025T0930Z";
const TOKEN = "manual-under-test";
const KIP_CRON = "43 3 * * *";
const SRE_CRONS = "30 0 * * *;0 11 * * *";
const MODEL = "@cf/zai-org/glm-4.7-flash";
const LAST_RUN_KEY = "internal/kips/v1/last-run.json";
const CWIKI_EMPTY = { results: [], start: 0, limit: 50, size: 0, _links: { base: "https://cwiki.apache.org/confluence" } };

const r2KeysOf = (calls: readonly string[], op: "get" | "put") => calls.filter((call) => call.startsWith(`${op} `)).map((call) => call.slice(op.length + 1));

class MemoryBucket {
  readonly objects = new Map<string, string>();
  readonly calls: string[] = [];
  failGet?: (key: string) => boolean;
  failPut?: (key: string) => boolean;
  async get(key: string) {
    this.calls.push(`get ${key}`);
    if (this.failGet?.(key) === true) throw new Error(`R2 get failed for ${key}`);
    const body = this.objects.get(key);
    return body === undefined ? null : { text: async () => body, json: async () => JSON.parse(body) as unknown };
  }
  async put(key: string, body: string) {
    this.calls.push(`put ${key}`);
    if (this.failPut?.(key) === true) throw new Error(`R2 put failed for ${key}`);
    this.objects.set(key, String(body));
    return { key };
  }
  async delete(key: string) {
    this.calls.push(`delete ${key}`);
    this.objects.delete(key);
  }
  json<T = Record<string, unknown>>(key: string): T { return JSON.parse(this.objects.get(key)!) as T; }
  count(op: "get" | "put" | "delete") { return this.calls.filter((call) => call.startsWith(`${op} `)).length; }
}

interface Point { indexes: string[]; blobs: string[]; doubles: number[] }

/** Analytics Engine: the history query reads back the points written, as the real dataset would. */
class FakeWae {
  readonly points: Point[] = [];
  readonly sink = { writeDataPoint: (point: Point) => { this.points.push(point); } };
  readonly sql = {
    query: async (input: { query: string; params?: Record<string, unknown> }) => {
      const params = input.params ?? {};
      const rows = this.points.filter((point) => (params.job === undefined || point.blobs[0] === params.job) && (!input.query.includes("GROUP BY") || point.indexes[0] !== params.runId));
      if (input.query.includes("GROUP BY")) {
        return { data: rows.map((point) => ({ index1: point.indexes[0], blob3: point.blobs[2], ...Object.fromEntries(point.doubles.map((value, index) => [`double${index + 1}`, value])), timestamp: new Date(point.doubles[5]!).toISOString(), weight: 1 })) };
      }
      return { data: rows.map((point) => ({ runId: point.indexes[0], job: point.blobs[0], status: point.blobs[2], ok: point.doubles[0] })) };
    },
  };
}

function namespace(body: () => unknown, calls: string[]) {
  return { idFromName: (name: string) => name, get: () => ({ fetch: async (input: string | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push(`${request.method} ${request.url}`);
    return Response.json(body(), { status: request.url.endsWith("/run") ? 202 : 200 });
  } }) };
}

let outbound: string[] = [];
let cwiki: "ok" | 503 = "ok";
const logs: { level: string; value: unknown }[] = [];
const real = { fetch: globalThis.fetch, log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  setSystemTime(new Date(T0));
  outbound = [];
  cwiki = "ok";
  logs.length = 0;
  for (const level of ["log", "warn", "error"] as const) console[level] = (value: unknown) => { logs.push({ level, value }); };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    outbound.push(url);
    if (url.startsWith("https://cwiki.apache.org/")) return cwiki === 503 ? new Response("unavailable", { status: 503 }) : Response.json(CWIKI_EMPTY);
    // GitHub (ci.release) is unavailable: `unknown`, never a firing.
    return new Response("unavailable", { status: 500 });
  }) as typeof fetch;
});
afterEach(() => {
  setSystemTime();
  globalThis.fetch = real.fetch;
  console.log = real.log;
  console.warn = real.warn;
  console.error = real.error;
});

function workerEnv(vars: Record<string, unknown> = {}) {
  const bucket = new MemoryBucket();
  const wae = new FakeWae();
  const calls: string[] = [];
  const env = {
    PUBLICATION_ENVIRONMENT: "development",
    MANUAL_TRIGGER_TOKEN: TOKEN,
    KIP_PAGES: "authors@1",
    KIP_PAGES_CRON: KIP_CRON,
    SRE_DRILL: "on",
    SRE_AGENT: "dry",
    SRE_AGENT_CRON: SRE_CRONS,
    SRE_AGENT_MODEL: MODEL,
    OBSERVABILITY_SIGNALS: "on",
    SIGNALS: wae.sink,
    ANALYTICS_SQL: wae.sql,
    // The publication ran an hour ago: no publication rule fires.
    PIPELINE_STATE: namespace(() => ({ environment: "development", running: false, scheduled: false, followUp: null, phase: null, lastRun: { ok: true, runId: "publication-x", completedAt: new Date(T0 - 3_600_000).toISOString(), copiedObjectCount: 1, reusedObjectCount: 1, r2: { classA: 4, classB: 1 } }, sources: null }), calls),
    DIGEST_RUN: namespace(() => ({ enabled: false, lastRun: null }), calls),
    OSS_KB_BUCKET: bucket,
    ...vars,
  };
  const request = (path: string, init: RequestInit & { token?: boolean } = {}) => {
    const { token = true, ...rest } = init;
    return worker.fetch(new Request(`https://data.example${path}`, { ...rest, headers: { ...(token ? { authorization: `Bearer ${TOKEN}` } : {}), ...(rest.body === undefined ? {} : { "content-type": "application/json" }) } }), env as never);
  };
  const arm = (kind: unknown, job: unknown = "kip-pages", token = true) => request("/sre-agent/drill", { method: "POST", body: JSON.stringify({ job, kind }), token });
  const runKip = async (minutes?: number) => {
    if (minutes !== undefined) setSystemTime(new Date(at(minutes)));
    return request("/kip-pages/run", { method: "POST" });
  };
  const tick = async (cron: string) => {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron, scheduledTime: Date.now() } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
    await Promise.all(pending);
  };
  return { env, bucket, wae, calls, request, arm, runKip, tick };
}

const drillLines = (level?: string) => logs.filter((line) => (level === undefined || line.level === level) && typeof (line.value as { message?: unknown })?.message === "string" && (line.value as { message: string }).message.startsWith("drill:"));
const record = (bucket: MemoryBucket, id = DRILL_ID) => bucket.json<DrillRecord>(drillRecordKey(id));

/** A model that cites the bundle's kip-pages /health fields (the error) and its Q-window item. */
function goldenModel() {
  const usage = { inputTokens: { total: 3000, noCache: 3000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 200, text: 200, reasoning: undefined } };
  return new MockLanguageModelV4({
    modelId: MODEL,
    doGenerate: async (options) => {
      const text = JSON.stringify(options.prompt).replaceAll("\\\"", "\"");
      const id = (label: string) => new RegExp(`id="(E\\d+)" source="[a-z]+" label="${label}"`, "u").exec(text)![1]!;
      const output = {
        verdict: "explained", cause: "upstream-unavailable", confidence: "high",
        evidence: [{ id: id("kip-pages /health fields"), quote: "\"error\": \"cwiki.apache.org answered 503\"" }, { id: id("Q-window"), quote: "\"job\": \"kip-pages\"" }],
        runbook: drillExpectations.throw.runbook, ownerAction: "Run kip-pages by hand once cwiki answers.",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] };
    },
  });
}

const scenarios: Record<string, () => Promise<void>> = {
  async arm() {
    const { arm, bucket } = workerEnv();
    const response = await arm("throw");
    expect(response.status).toBe(201);
    expect(await response.json() as unknown).toEqual({ drillId: DRILL_ID, job: "kip-pages", kind: "throw", runs: 2, armedAt: "2026-10-25T09:30:00.000Z", expiresAt: "2026-10-27T09:30:00.000Z" });
    expect(record(bucket)).toMatchObject({ drillId: DRILL_ID, state: "armed", applied: 0, runIds: [] });
    expect(bucket.json(DRILL_POINTER_KEY)).toMatchObject({ drillId: DRILL_ID, kind: "throw", runs: 2 });
    expect(r2KeysOf(bucket.calls, "put")).toEqual([drillRecordKey(DRILL_ID), DRILL_POINTER_KEY]);
  },

  async "arm refused"() {
    const { arm, bucket, request } = workerEnv();
    expect((await arm("throw", "kip-pages", false)).status).toBe(401);
    expect((await arm("throw", "digest")).status).toBe(400);
    expect((await arm("slow")).status).toBe(400);
    expect((await request("/sre-agent/drill", { method: "POST", body: "not json" })).status).toBe(400);
    expect(bucket.calls).toEqual([]);
    expect((await arm("skip")).status).toBe(201);
    const second = await arm("throw");
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ ok: false, reason: "drill-active", drillId: "skip-20261025T0930Z" });
    const off = workerEnv({ SRE_DRILL: undefined });
    expect((await off.arm("throw")).status).toBe(404);
    expect(off.bucket.calls).toEqual([]);
    // B41: a kind whose rule's playbook does not list the expected cause is refused, before any R2 call.
    const library: PlaybookLibrary = { ...PLAYBOOK_LIBRARY, playbooks: { ...PLAYBOOK_LIBRARY.playbooks, "job.failures": PLAYBOOK_LIBRARY.playbooks["job.failures"]!.replace("`upstream-unavailable`", "`upstream-down`") } };
    const store = new MemoryBucket();
    const refused = await armDrill(r2Store(store as never), { kind: "throw", now: new Date(T0), library });
    expect(refused).toMatchObject({ status: 409, body: { ok: false, reason: "playbook-missing-cause" } });
    expect(store.calls).toEqual([]);
  },

  async cancel() {
    const { arm, request, bucket, runKip } = workerEnv();
    await arm("throw");
    const cancelled = await request("/sre-agent/drill", { method: "DELETE" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json() as unknown).toEqual({ ok: true, drillId: DRILL_ID, state: "cancelled" });
    expect(bucket.objects.has(DRILL_POINTER_KEY)).toBe(false);
    expect(record(bucket).state).toBe("cancelled");
    expect((await runKip(1)).status).toBe(200);
    expect(outbound.filter((url) => url.startsWith("https://cwiki.apache.org/"))).toHaveLength(1);
    expect((await request("/sre-agent/drill", { method: "DELETE" })).status).toBe(409);
  },

  async "Prod guard"() {
    const pointer = (bucket: MemoryBucket) => {
      bucket.objects.set(DRILL_POINTER_KEY, JSON.stringify({ drillId: DRILL_ID, job: "kip-pages", kind: "throw", runs: 2, armedAt: "2026-10-25T09:00:00.000Z", expiresAt: "2026-10-27T09:00:00.000Z" }));
      bucket.objects.set(drillRecordKey(DRILL_ID), JSON.stringify({ drillId: DRILL_ID, job: "kip-pages", kind: "throw", runs: 2, armedAt: "2026-10-25T09:00:00.000Z", expiresAt: "2026-10-27T09:00:00.000Z", state: "armed", applied: 0, runIds: [], firedAt: null, result: null, reasons: [], gradedAt: null, diagnosis: null }));
    };
    for (const environment of ["production", "staging"]) {
      const { arm, request, bucket, runKip } = workerEnv({ PUBLICATION_ENVIRONMENT: environment, OBSERVABILITY_SIGNALS: undefined });
      pointer(bucket);
      outbound = [];
      expect((await arm("throw")).status).toBe(404);
      expect((await request("/sre-agent/drill", { method: "DELETE" })).status).toBe(404);
      expect((await runKip()).status).toBe(200);
      expect(outbound).toHaveLength(1);
      expect(bucket.calls.filter((call) => call.includes("internal/sre/"))).toEqual([]);
    }
    // Positive control: development with the same pointer applies the fault.
    const dev = workerEnv({ OBSERVABILITY_SIGNALS: undefined });
    pointer(dev.bucket);
    outbound = [];
    expect((await dev.runKip()).status).toBe(502);
    expect(outbound).toEqual([]);
    expect(record(dev.bucket).applied).toBe(1);
  },

  async config() {
    const read = async (name: string) => JSON.parse((await Bun.file(new URL(`../${name}`, import.meta.url)).text()).replace(/^\s*\/\/.*$/gmu, "")) as { vars?: Record<string, string> };
    const prod = await read("wrangler.production.jsonc");
    const dev = await read("wrangler.development.jsonc");
    expect(prod.vars?.SRE_DRILL).toBeUndefined();
    expect(prod.vars?.SRE_AGENT).toBe("off");
    expect(dev.vars?.SRE_DRILL).toBe("on");
    expect(dev.vars?.SRE_AGENT).toBe("live");
    expect(dev.vars?.PUBLICATION_ENVIRONMENT).toBe("development");
  },

  async throw() {
    const drill = workerEnv();
    // The same runs against a transport that really answers 503, at the same times.
    const real503 = workerEnv({ SRE_DRILL: undefined });
    expect((await drill.arm("throw")).status).toBe(201);
    for (const [index, minutes] of [[0, 1], [1, 6]] as const) {
      setSystemTime(new Date(at(minutes)));
      cwiki = 503;
      outbound = [];
      expect((await real503.runKip()).status).toBe(502);
      expect(outbound).toHaveLength(1);
      cwiki = "ok";
      outbound = [];
      logs.length = 0;
      const response = await drill.runKip();
      expect(response.status).toBe(502);
      expect(outbound).toEqual([]);
      const faulted = drill.bucket.json<{ lastRun: { runId: string; error: string; trends: { rules: { id: string; status: string }[] } } }>(LAST_RUN_KEY);
      expect(faulted).toEqual(real503.bucket.json(LAST_RUN_KEY));
      expect(faulted.lastRun.error).toBe("cwiki.apache.org answered 503");
      expect(drill.wae.points[index]).toEqual(real503.wae.points[index]!);
      expect(faulted.lastRun.trends.rules.find((rule) => rule.id === "job.failures")?.status).toBe(index === 0 ? "warn" : "firing");
      const errors = logs.filter((line) => line.level === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.value).toMatchObject({ message: expect.stringMatching(new RegExp(`^drill:${DRILL_ID} run ${index + 1} of 2`, "u")), runId: faulted.lastRun.runId, job: "kip-pages" });
    }
    const fired = record(drill.bucket);
    expect(fired).toMatchObject({ state: "fired", applied: 2, firedAt: new Date(at(6)).toISOString() });
    expect(fired.runIds).toEqual(drill.wae.points.map((point) => point.indexes[0]!));
    // The pointer marks the fired drill until the grader removes it; the fault is used up.
    expect(drill.bucket.objects.has(DRILL_POINTER_KEY)).toBe(true);
    outbound = [];
    expect((await drill.runKip(11)).status).toBe(200);
    expect(outbound).toHaveLength(1);
    expect(record(drill.bucket).applied).toBe(2);
    // /health shows the drill's state to the owner (never to the agent: tickHealth has no sreAgent).
    const health = await (await drill.request("/health", { method: "GET", token: false })).json() as { sreAgent: { lastDrill: unknown } };
    expect(health.sreAgent.lastDrill).toEqual({ drillId: DRILL_ID, kind: "throw", state: "fired", result: null, reasons: [], runIds: fired.runIds });
    expect(JSON.stringify(await tickHealth(drill.env as never))).not.toMatch(/drill/iu);
  },

  async "throw dry run"() {
    const { arm, bucket, request } = workerEnv();
    expect((await arm("throw")).status).toBe(201);
    setSystemTime(new Date(at(1)));
    outbound = [];
    logs.length = 0;
    const response = await request("/kip-pages/run?dryRun=1", { method: "POST" });
    expect(response.status).toBe(200);
    // The dry run reaches the real upstream: no 503 fault was applied.
    expect(outbound.length).toBeGreaterThan(0);
    expect(logs.filter((line) => JSON.stringify(line.value).includes("drill:"))).toEqual([]);
    expect(record(bucket, DRILL_ID)).toMatchObject({ state: "armed", applied: 0, runIds: [] });
    expect(bucket.objects.has("internal/sre/v1/dev/drills/armed/kip-pages.json")).toBe(true);
  },

  async "skip manual run"() {
    const { arm, bucket, runKip } = workerEnv();
    expect((await arm("skip")).status).toBe(201);
    outbound = [];
    const response = await runKip(1);
    expect(response.status).toBe(409);
    expect(await response.json() as unknown).toEqual({ ok: false, skipped: "drill" });
    expect(outbound).toEqual([]);
    expect(bucket.objects.has(LAST_RUN_KEY)).toBe(false);
    expect(record(bucket, "skip-20261025T0930Z")).toMatchObject({ state: "fired", applied: 1, runIds: [] });
  },

  async skip() {
    const { arm, bucket, wae, tick, runKip } = workerEnv();
    expect((await arm("skip")).status).toBe(201);
    setSystemTime(new Date(at(60)));
    outbound = [];
    logs.length = 0;
    await tick(KIP_CRON);
    expect(outbound).toEqual([]);
    expect(bucket.objects.has(LAST_RUN_KEY)).toBe(false);
    expect(wae.points).toEqual([]);
    expect(logs.filter((line) => line.level === "warn")).toEqual([{ level: "warn", value: { message: expect.stringMatching(/^drill:skip-20261025T0930Z run 1 of 1: skipped/u), job: "kip-pages" } }]);
    expect(record(bucket, "skip-20261025T0930Z")).toMatchObject({ state: "fired", applied: 1, runIds: [], firedAt: new Date(at(60)).toISOString() });
    expect((await runKip(61)).status).toBe(200);
    expect(outbound).toHaveLength(1);
    expect(wae.points).toHaveLength(1);
  },

  async "manual tick"() {
    const { request, bucket } = workerEnv();
    expect((await request("/sre-agent/run", { method: "POST", token: false })).status).toBe(401);
    const response = await request("/sre-agent/run", { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; runRecord: { runId: string; mode: string } };
    expect(body).toMatchObject({ status: "ok", runRecord: { mode: "dry", runId: "sre-agent-2026-10-25T09-30-00-000Z" } });
    expect(bucket.calls).toContain("put internal/sre/v1/dev/state.json");
    const off = workerEnv({ SRE_AGENT: "off" });
    expect((await off.request("/sre-agent/run", { method: "POST" })).status).toBe(404);
    expect(off.bucket.calls).toEqual([]);
  },

  async "expiry and errors"() {
    const expired = workerEnv();
    await expired.arm("throw");
    outbound = [];
    expect((await expired.runKip(49 * 60)).status).toBe(200);
    expect(outbound).toHaveLength(1);
    expect(expired.bucket.objects.has(DRILL_POINTER_KEY)).toBe(false);
    expect(record(expired.bucket).state).toBe("expired");

    setSystemTime(new Date(T0));
    const unreadable = workerEnv();
    await unreadable.arm("throw");
    unreadable.bucket.failGet = (key) => key === DRILL_POINTER_KEY;
    outbound = [];
    logs.length = 0;
    expect((await unreadable.runKip(1)).status).toBe(200);
    expect(outbound).toHaveLength(1);
    expect(drillLines()).toHaveLength(1);
    expect(record(unreadable.bucket).applied).toBe(0);

    setSystemTime(new Date(T0));
    const unwritable = workerEnv();
    unwritable.bucket.failPut = (key) => key.startsWith("internal/sre/v1/dev/drills/throw-");
    const response = await unwritable.arm("throw");
    expect(response.status).toBe(503);
    expect(await response.json() as unknown).toEqual({ ok: false, reason: "record-unwritable" });
    expect(unwritable.bucket.objects.has(DRILL_POINTER_KEY)).toBe(false);
  },

  async budget() {
    const { env, arm, runKip, bucket, calls, request } = workerEnv({ SRE_AGENT: "live" });
    const before = (await (await request("/health", { method: "GET", token: false })).json() as { lastRun: unknown }).lastRun;
    calls.length = 0;
    bucket.calls.length = 0;
    expect((await arm("throw")).status).toBe(201);
    outbound = [];
    await runKip(1);
    await runKip(6);
    const faultedOutbound = outbound.length;
    const model = goldenModel();
    setSystemTime(new Date(at(10)));
    const tick = await sreAgentTick(env as unknown as SreAgentEnv, { now: new Date(at(10)), readHealth: () => tickHealth(env as never), model });
    const runRecord = tick!.runRecord!;
    expect(record(bucket)).toMatchObject({ state: "graded", result: "pass", reasons: [] });
    expect(bucket.objects.has(DRILL_POINTER_KEY)).toBe(false);
    const modelCalls = model.doGenerateCalls.length;
    const measured = { classA: bucket.count("put"), classB: bucket.count("get"), deletes: bucket.count("delete"), upstream: faultedOutbound, modelCalls, neurons: runRecord.neurons };
    console.info(`SRE75 measured: ${JSON.stringify(measured)}`);
    expect(measured).toMatchObject({ classA: 10 + modelCalls, upstream: 0, modelCalls: 1 });
    expect(measured.classB).toBeLessThanOrEqual(14);
    expect(runRecord.neurons).toBeLessThanOrEqual(1500);
    for (const key of r2KeysOf(bucket.calls, "put")) expect(key.startsWith("internal/sre/v1/dev/") || key === LAST_RUN_KEY).toBe(true);
    // No publication, digest or cost-guard request other than reading their status for /health.
    expect(calls.filter((call) => !call.startsWith("GET "))).toEqual([]);
    expect((await (await request("/health", { method: "GET", token: false })).json() as { lastRun: unknown }).lastRun).toEqual(before);
  },
};

describe("Spec 027 drill: the Worker", () => {
  test("every row has a scenario", () => {
    expect(testPlanRows.filter((row) => scenarios[row.case] === undefined).map((row) => row.case)).toEqual([]);
  });

  test.each(testPlanRows)("$id: $case", async (row) => {
    await scenarios[row.case]!();
  });
});
