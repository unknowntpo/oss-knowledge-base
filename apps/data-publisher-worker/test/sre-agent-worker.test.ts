/**
 * Spec 027 Amendment (2), A2-9 slice 2: the `sre-agent` job in the data publisher Worker. Each row of
 * sre-agent-worker.cases.ts has one scenario here. Fakes only: no network, no Cloudflare binding.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { generateText } from "ai";
import { JOB_HEALTH_FIELDS, SRE_JOBS } from "@oss-knowledge-base/sre-agent";
import worker, { cronTarget, inAppSources, tickHealth } from "../src/index";
import { SIGNAL_JOBS } from "../src/signals/profile";
import { sreAgentModel, sreAgentTick, type SreAgentEnv } from "../src/sre-agent/run";
import { testPlanRows } from "./sre-agent-worker.cases";

const NOW = "2026-10-23T00:30:00.000Z";
const NOW_MS = Date.parse(NOW);
const SRE_CRONS = "30 0 * * *;0 11 * * *";
const RUN_ID = "sre-agent-2026-10-23T00-30-00-000Z";
const STATE_KEY = "internal/sre/v1/dev/state.json";
const MODEL = "@cf/zai-org/glm-4.7-flash";
/** A Worker secret: 40 token characters, so the sanitizer's 32-character rule must catch it. */
const SECRET = "ghs_0123456789abcdefghijABCDEFGHIJ012345";

class MemoryBucket {
  readonly objects = new Map<string, string>();
  readonly calls: string[] = [];
  failGet?: string;
  async get(key: string) {
    this.calls.push(`get ${key}`);
    if (this.failGet !== undefined && key === this.failGet) throw new Error(`R2 get failed for ${key} with ${SECRET}`);
    const body = this.objects.get(key);
    return body === undefined ? null : { text: async () => body, json: async () => JSON.parse(body) as unknown };
  }
  async put(key: string, body: string) {
    this.calls.push(`put ${key}`);
    this.objects.set(key, String(body));
    return { key };
  }
  json(key: string): Record<string, unknown> { return JSON.parse(this.objects.get(key)!) as Record<string, unknown>; }
}

class FakeSink {
  readonly points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
  writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }) { this.points.push(point); }
}

class FakeSql {
  readonly calls: { query: string; params?: Record<string, unknown> }[] = [];
  async query(input: { query: string; params?: Record<string, string | number | boolean | null> }) {
    this.calls.push(input);
    return { data: [] as unknown[] };
  }
}

class FakeAi {
  readonly calls: unknown[][] = [];
  async run(...args: unknown[]) {
    this.calls.push(args);
    return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
  }
}

function namespace(handle: (request: Request) => Response | Promise<Response>, calls: string[]) {
  return { idFromName: (name: string) => name, get: () => ({ fetch: async (input: string | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push(`${request.method} ${request.url}`);
    return handle(request);
  } }) };
}

/** The publisher's `/status`: its last run `hoursAgo` hours before NOW (30 h makes `job.missed` fire). */
function publisherBody(hoursAgo: number) {
  const completedAt = new Date(NOW_MS - hoursAgo * 3_600_000).toISOString();
  return {
    environment: "development", running: false, scheduled: false, followUp: null, phase: null,
    lastRun: { ok: true, runId: "publication-2026-10-21T18-30-00-000Z", completedAt, copiedObjectCount: 10, reusedObjectCount: 5, r2: { classA: 13, classB: 2 }, error: `an earlier retry said Bearer ${SECRET}` },
    sources: null,
  };
}

function workerEnv(vars: Record<string, unknown>, options: { hoursAgo?: number; publisherStatus?: number } = {}) {
  const calls: string[] = [];
  const bucket = new MemoryBucket();
  const ai = new FakeAi();
  const env = {
    PUBLICATION_ENVIRONMENT: "development",
    GITHUB_SOURCE_TOKEN: SECRET,
    PIPELINE_STATE: namespace((request) => {
      if (request.url.endsWith("/run")) return Response.json({ ok: true, scheduled: true }, { status: 202 });
      return options.publisherStatus === undefined ? Response.json(publisherBody(options.hoursAgo ?? 30)) : new Response("busy", { status: options.publisherStatus });
    }, calls),
    DIGEST_RUN: namespace(() => Response.json({ enabled: false, lastRun: null }), calls),
    OSS_KB_BUCKET: bucket,
    AI: ai,
    SRE_AGENT_CRON: SRE_CRONS,
    SRE_AGENT_MODEL: MODEL,
    ...vars,
  };
  return { env, calls, bucket, ai };
}

async function scheduled(env: unknown, cron: string, at = NOW_MS) {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled({ cron, scheduledTime: at } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
  // The branch never rejects into the handler (B23): a rejected waitUntil fails here.
  await Promise.all(pending);
}

async function health(env: unknown): Promise<Record<string, unknown>> {
  return await (await worker.fetch(new Request("https://data.example/health"), env as never)).json() as Record<string, unknown>;
}

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
let logs: unknown[] = [];
let outbound: string[] = [];
beforeEach(() => {
  setSystemTime(new Date(NOW));
  logs = [];
  outbound = [];
  console.log = (value: unknown) => { logs.push(value); };
  console.error = (value: unknown) => { logs.push(value); };
  // GitHub answers 500: `ci.release` is unknown, never a firing (B27).
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    outbound.push(String(input instanceof Request ? input.url : input));
    return new Response("unavailable", { status: 500 });
  }) as typeof fetch;
});
afterEach(() => {
  setSystemTime();
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
});

const readConfig = async (name: string) => JSON.parse((await Bun.file(new URL(`../${name}`, import.meta.url)).text()).replace(/^\s*\/\/.*$/gmu, "")) as {
  vars?: Record<string, string>; triggers?: { crons?: string[] };
};

const sreLogs = () => logs.filter((value): value is { message: string; runId: string; job: string } =>
  value !== null && typeof value === "object" && (value as { job?: unknown }).job === "sre-agent");

const scenarios: Record<string, () => Promise<void>> = {
  async "health as served"() {
    const { env, bucket } = workerEnv({ OBSERVABILITY_SIGNALS: "on", KIP_PAGES: "authors@1" });
    // A job record only the route's redaction covers (not mergeHealth's).
    bucket.objects.set("internal/kips/v1/last-run.json", JSON.stringify({ revision: "authors@1", lastRun: { ok: false, status: "failed", at: NOW, durationMs: 1, error: `jira said ${SECRET}` }, lastGoodAt: null, coverageFrom: null }));
    const served = await health(env);
    const { sreAgent: _served, ...withoutAgent } = served;
    const ticked = await tickHealth(env as never);
    expect(ticked).toEqual(withoutAgent);
    expect(ticked).not.toHaveProperty("sreAgent");
    // Redacted as served, and a firing rule is in it (positive control: signals were judged, not copied).
    expect(JSON.stringify(ticked)).not.toContain(SECRET);
    expect((ticked.signals as { rules: { id: string; job: string; status: string }[] }).rules).toContainEqual(expect.objectContaining({ id: "job.missed", job: "publication", status: "firing" }));
  },

  async "flag off in the Worker"() {
    for (const [flag, expected] of [[undefined, { mode: "off" }], ["off", { mode: "off" }], ["Live", { mode: "off", reason: "invalid-flag" }]] as const) {
      const sink = new FakeSink();
      const sql = new FakeSql();
      const { env, calls, bucket, ai } = workerEnv({ ...(flag === undefined ? {} : { SRE_AGENT: flag }), OBSERVABILITY_SIGNALS: "on", SIGNALS: sink, ANALYTICS_SQL: sql });
      logs = [];
      outbound = [];
      await scheduled(env, "30 0 * * *");
      await scheduled(env, "0 11 * * *");
      expect({ calls, r2: bucket.calls, ai: ai.calls.length, points: sink.points.length, sql: sql.calls.length, logs, outbound }).toEqual({ calls: [], r2: [], ai: 0, points: 0, sql: 0, logs: [], outbound: [] });
      expect((await health(env)).sreAgent).toEqual(expected);
      // `/health` read no sre-agent key while off.
      expect(bucket.calls.filter((call) => call.includes("internal/sre/"))).toEqual([]);
    }
    // Positive control: `dry` on the same tick reads and writes its prefix.
    const { env, bucket } = workerEnv({ SRE_AGENT: "dry" });
    await scheduled(env, "30 0 * * *");
    expect(bucket.calls).toContain(`get ${STATE_KEY}`);
    expect(bucket.calls).toContain(`put ${STATE_KEY}`);
  },

  async "deploy config"() {
    const dev = await readConfig("wrangler.development.jsonc");
    const prod = await readConfig("wrangler.production.jsonc");
    expect(dev.vars?.SRE_AGENT).toBe("off");
    expect(dev.vars?.SRE_AGENT_CRON).toBe(SRE_CRONS);
    expect(dev.vars?.SRE_AGENT_MODEL).toBe(MODEL);
    for (const cron of SRE_CRONS.split(";")) expect(dev.triggers?.crons).toContain(cron);
    expect(prod.vars?.SRE_AGENT).toBe("off");
    expect(prod.vars?.SRE_AGENT_CRON).toBeUndefined();
    expect(prod.triggers?.crons).toEqual(["37 22 * * *"]);
  },

  async "job names"() {
    expect(SIGNAL_JOBS.filter((job) => !(SRE_JOBS as readonly string[]).includes(job))).toEqual([]);
    expect(SIGNAL_JOBS.filter((job) => !(job in JOB_HEALTH_FIELDS))).toEqual([]);
    expect(SRE_JOBS).toContain("embedding");
    expect(SRE_JOBS).not.toContain("search-embedding");
  },

  async isolation() {
    // Steps 0–2 and 4–7 on a firing (Spec 028 job.missed for publication); step 3 on a healthy tick.
    for (const step of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const { env, calls, bucket } = workerEnv({ SRE_AGENT: "dry", OBSERVABILITY_SIGNALS: "on" }, { hoursAgo: step === 3 ? 1 : 30 });
      const onStep = (current: number) => { if (current === step) throw new Error(`step ${current} broke with Bearer ${SECRET} and ${SECRET}`); };
      // One tick shared with the publication cron: the sre-agent branch and the publisher's run at once.
      const [result] = await Promise.all([
        sreAgentTick(env as unknown as SreAgentEnv, { now: new Date(NOW), readHealth: () => tickHealth(env as never), fetch: globalThis.fetch, onStep }),
        scheduled(env, "7 22 * * *"),
      ]);
      expect(calls).toContain("POST https://pipeline.internal/run");
      expect(result).toMatchObject({ runId: RUN_ID, status: "failed" });
      expect(result!.reason).toContain(`step ${step} broke`);
      expect(result!.reason).not.toContain(SECRET);
      const state = bucket.json(STATE_KEY);
      expect(state.lastRun).toEqual({ runId: RUN_ID, at: NOW, status: "failed", reason: result!.reason });
      const sreAgent = (await health(env)).sreAgent as Record<string, unknown>;
      expect(sreAgent).toMatchObject({ mode: "dry", status: "failed", reason: result!.reason, lastRun: { status: "failed" } });
      expect(JSON.stringify(sreAgent)).not.toContain(SECRET);
    }
    // Positive control: without a fault the same tick is ok.
    const { env } = workerEnv({ SRE_AGENT: "dry", OBSERVABILITY_SIGNALS: "on" });
    const ok = await sreAgentTick(env as unknown as SreAgentEnv, { now: new Date(NOW), readHealth: () => tickHealth(env as never), fetch: globalThis.fetch });
    expect(ok).toMatchObject({ status: "ok", runRecord: { diagnosed: 1 } });
  },

  async "own tick"() {
    for (const flag of [undefined, "off", "dry", "live"]) {
      for (const cron of SRE_CRONS.split(";")) expect(cronTarget(cron, "47 22 * * *", undefined, "17 2 * * *", "43 3 * * *", SRE_CRONS)).toBe("sre-agent");
      const { env, calls } = workerEnv(flag === undefined ? {} : { SRE_AGENT: flag });
      await scheduled(env, "30 0 * * *");
      expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    }
    expect(cronTarget("7 22 * * *", "47 22 * * *", undefined, "17 2 * * *", "43 3 * * *", SRE_CRONS)).toBe("publisher");
    // A real fault inside the handler's branch: the publisher's /status answers 503, so /health cannot be read (step 1).
    const { env, bucket, calls } = workerEnv({ SRE_AGENT: "dry" }, { publisherStatus: 503 });
    await scheduled(env, "30 0 * * *");
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(bucket.json(STATE_KEY).lastRun).toEqual({ runId: RUN_ID, at: NOW, status: "failed", reason: "/health answered 503" });
    // And the publication tick of the same handler still schedules its run.
    await scheduled(env, "7 22 * * *");
    expect(calls).toContain("POST https://pipeline.internal/run");
    // state.json that cannot be read is never replaced (its neuron reservations stay); the log line and /health say why.
    const unreadable = workerEnv({ SRE_AGENT: "dry" });
    unreadable.bucket.objects.set(STATE_KEY, JSON.stringify({ fingerprints: {}, today: { date: "2026-10-23", diagnoses: 1, neurons: 700 } }));
    unreadable.bucket.failGet = STATE_KEY;
    logs = [];
    await scheduled(unreadable.env, "30 0 * * *");
    expect(unreadable.bucket.calls.filter((call) => call.startsWith("put"))).toEqual([]);
    expect(sreLogs().map((line) => line.message).join("\n")).toContain("R2 get failed");
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect((await health(unreadable.env)).sreAgent).toMatchObject({ mode: "dry", status: "unknown", reason: expect.stringContaining("R2 get failed") });
  },

  async "model construction throws"() {
    const { env, ai, bucket } = workerEnv({ SRE_AGENT: "live", OBSERVABILITY_SIGNALS: "on" });
    // The binding fails as the model is built (createAI reads it there), before any tick step.
    Object.defineProperty(env, "AI", { get() { throw new Error(`AI binding unavailable for ${SECRET}`); }, enumerable: true });
    await scheduled(env, "30 0 * * *");
    expect(ai.calls).toHaveLength(0);
    expect(bucket.json(STATE_KEY).lastRun).toEqual({ runId: RUN_ID, at: NOW, status: "failed", reason: "AI binding unavailable for [redacted]" });
    expect((await health(env)).sreAgent).toMatchObject({ mode: "live", status: "failed" });
  },

  async "model from the binding"() {
    const ai = new FakeAi();
    const model = sreAgentModel({ AI: ai, SRE_AGENT_MODEL: MODEL });
    expect(model).toBeDefined();
    const answer = await generateText({ model: model!, prompt: "ping" });
    expect(answer.text).toBe("ok");
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]![0]).toBe(MODEL);
    expect(sreAgentModel({ AI: ai, SRE_AGENT_MODEL: "" })).toBeUndefined();
    expect(sreAgentModel({ SRE_AGENT_MODEL: MODEL })).toBeUndefined();
    for (const vars of [{ SRE_AGENT_MODEL: undefined }, { AI: undefined }]) {
      const { env, ai: binding, bucket } = workerEnv({ SRE_AGENT: "live", OBSERVABILITY_SIGNALS: "on", ...vars });
      await scheduled(env, "30 0 * * *");
      expect(binding.calls).toHaveLength(0);
      expect(bucket.json(STATE_KEY).lastRun).toMatchObject({ status: "failed", reason: "SRE_AGENT=live needs a model" });
    }
  },

  async "neuron term"() {
    const status = (body: unknown) => ({ idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json(body) }) });
    const date = NOW.slice(0, 10);
    const ledgers = {
      AI: {},
      PUBLICATION_ENVIRONMENT: "development",
      DIGEST_RUN: status({ today: { date, estimatedNeurons: 5_000 } }),
      SEARCH_EMBEDDING_RUN: status({ today: { date, estimatedNeurons: 2_500 } }),
      SEARCH_QUERY_GATE: status({ today: { date, neurons: 1_000 } }),
    };
    const at = (bucket: MemoryBucket, flag?: string) => inAppSources({ ...ledgers, OSS_KB_BUCKET: bucket, ...(flag === undefined ? {} : { SRE_AGENT: flag }) } as never, () => new Date(NOW)).neuronsToday();
    const bucket = new MemoryBucket();
    bucket.objects.set(STATE_KEY, JSON.stringify({ fingerprints: {}, today: { date, diagnoses: 3, neurons: 1_500 } }));
    expect(await at(bucket, "live")).toBe(10_000);
    expect(await at(bucket, "dry")).toBe(10_000);
    // Positive control: the agent absent (off) adds 0 and reads nothing.
    const off = new MemoryBucket();
    off.objects.set(STATE_KEY, bucket.objects.get(STATE_KEY)!);
    expect(await at(off)).toBe(8_500);
    expect(off.calls).toEqual([]);
    const yesterday = new MemoryBucket();
    yesterday.objects.set(STATE_KEY, JSON.stringify({ fingerprints: {}, today: { date: "2026-10-22", diagnoses: 3, neurons: 1_500 } }));
    expect(await at(yesterday, "live")).toBe(8_500);
  },

  async "dry tick observability"() {
    const sink = new FakeSink();
    const sql = new FakeSql();
    const { env, bucket, ai } = workerEnv({ SRE_AGENT: "dry", OBSERVABILITY_SIGNALS: "on", SIGNALS: sink, ANALYTICS_SQL: sql });
    await scheduled(env, "30 0 * * *");
    expect(ai.calls).toHaveLength(0);
    const recordKey = `internal/sre/v1/dev/runs/2026-10-23/${RUN_ID}.json`;
    const trajectoryKey = `internal/sre/v1/dev/trajectories/2026-10-23/${RUN_ID}-publication.json`;
    const record = bucket.json(recordKey) as { runId: string; firings: number; diagnosed: number; diagnoses: { verdict: string; trajectoryKey: string }[] };
    expect(record).toMatchObject({ runId: RUN_ID, mode: "dry", diagnosed: 1, modelCalls: 0 });
    expect(record.firings).toBeGreaterThanOrEqual(1);
    expect(record.diagnoses.map((value) => [value.verdict, value.trajectoryKey])).toEqual([["dry-run", trajectoryKey]]);
    expect(bucket.json(trajectoryKey)).toMatchObject({ runId: RUN_ID, job: "publication" });
    // The harness's queries ran on this environment's dataset with bound arguments.
    expect(sql.calls.length).toBeGreaterThan(0);
    for (const call of sql.calls) expect(call.query).toContain('"osskb_signals_dev"');
    // One point, Spec 028's layout, c1–c6 of B33.
    expect(sink.points).toHaveLength(1);
    const point = sink.points[0]!;
    expect(point.indexes).toEqual([RUN_ID]);
    expect(point.blobs).toEqual(["sre-agent", "development", "ok", ""]);
    expect(point.doubles).toHaveLength(12);
    expect(point.doubles[0]).toBe(1);
    expect(point.doubles.slice(6)).toEqual([record.firings, 1, 0, 0, 0, 0]);
    // One log line with the same runId.
    expect(sreLogs().map((line) => line.runId)).toEqual([RUN_ID]);
    // /health.sreAgent from state.json.
    const sreAgent = (await health(env)).sreAgent as Record<string, unknown>;
    expect(Object.keys(sreAgent).sort()).toEqual(["lastRun", "mode", "reason", "status", "today"]);
    expect(sreAgent).toMatchObject({ mode: "dry", status: "ok", reason: null, today: { date: "2026-10-23", diagnoses: 1, neurons: 0 } });
    expect(sreAgent.lastRun).toEqual({
      runId: RUN_ID, at: NOW, status: "ok", firings: record.firings, diagnosed: 1, notDiagnosed: 0, modelCalls: 0, neurons: 0, verdicts: ["dry-run"], recordKey,
    });
  },
};

describe("Spec 027 Amendment (2): the sre-agent job in the Worker", () => {
  test("every row has a scenario", () => {
    expect(testPlanRows.filter((row) => scenarios[row.case] === undefined).map((row) => row.case)).toEqual([]);
  });

  test.each(testPlanRows)("$id: $case", async (row) => {
    await scenarios[row.case]!();
  });
});
