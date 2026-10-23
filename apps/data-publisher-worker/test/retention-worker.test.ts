/**
 * Spec 029, dry-run slice: retention as its own job inside the publisher Worker — its cron, its
 * alarm invocation of `PipelineState`, its `/health` field and report route. Stub Durable Object
 * storage and an in-memory bucket; no network.
 */
import { afterEach, describe, expect, test } from "bun:test";

import worker, { cronTarget, PipelineState } from "../src/index";
import { RETENTION_DAY_KEY, RETENTION_LAST_RUN_KEY, RETENTION_PENDING_KEY, RETENTION_REPORT_KEY, RETENTION_SKIP_KEY, retentionAlarm } from "../src/retention/job";
import { releaseIdAt } from "./retention.cases";
import { point, publish, RetentionMemoryBucket } from "./support/retention-bucket";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const RETENTION_CRON = "17 10 * * *";
const PUBLICATION_CRON = "7 22 * * *";
const DIGEST_CRON = "47 22 * * *";
const TOKEN = "manual-under-test";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

class FakeStorage {
  readonly values = new Map<string, unknown>();
  readonly writes: string[] = [];
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
    for (const [name, item] of entries) { this.writes.push(name); this.values.set(name, item); }
  }
  async delete(key: string): Promise<boolean> { this.writes.push(`-${key}`); return this.values.delete(key); }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async setAlarm(time: number): Promise<void> { this.alarm = time; }
  async list<T>(options: { readonly prefix: string }): Promise<Map<string, T>> {
    return new Map([...this.values].filter(([key]) => key.startsWith(options.prefix)) as [string, T][]);
  }
}

/** A Dev-like bucket: two daily releases in the window, one old one, pointers on the newest. */
function devBucket(): RetentionMemoryBucket {
  const bucket = new RetentionMemoryBucket();
  const now = Date.now();
  publish(bucket, now - 60 * DAY);
  publish(bucket, now - 3 * DAY);
  publish(bucket, now - 2 * DAY - 60 * MINUTE);
  point(bucket, now - 2 * DAY - 60 * MINUTE);
  return bucket;
}

interface Options { readonly flag?: string; readonly paused?: boolean; readonly bucket?: RetentionMemoryBucket }

/** One `PipelineState` behind a Worker env; every outbound fetch (the publication's sources) is recorded and answered 404. */
function world(options: Options = {}) {
  const storage = new FakeStorage();
  const bucket = options.bucket ?? devBucket();
  const outbound: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    outbound.push(new URL(String(input instanceof Request ? input.url : input)).host);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const objectCalls: string[] = [];
  const stub = (name: string, answer: (url: string, init?: RequestInit) => Promise<Response>) => ({
    idFromName: (id: string) => id,
    get: () => ({ fetch: async (url: string, init?: RequestInit) => { objectCalls.push(`${name} ${init?.method ?? "GET"} ${new URL(url).pathname}`); return answer(url, init); } }),
  });
  const env: Record<string, unknown> = {
    PUBLICATION_ENVIRONMENT: "development",
    GITHUB_SOURCE_TOKEN: "github_pat_test",
    MANUAL_TRIGGER_TOKEN: TOKEN,
    DIGEST_CRON,
    RETENTION_CRON,
    OSS_KB_BUCKET: bucket,
    DIGEST_RUN: stub("digest", async () => Response.json({ running: false }, { status: 202 })),
    ...(options.flag === undefined ? {} : { R2_RETENTION: options.flag }),
    ...(options.paused === true ? {
      COST_GUARD: "enforce",
      COST_GUARD_STATE: stub("cost-guard", async () => Response.json({ refuse: true, pausePublication: true })),
    } : {}),
  };
  const object = new PipelineState({ storage } as unknown as ConstructorParameters<typeof PipelineState>[0], env as unknown as ConstructorParameters<typeof PipelineState>[1]);
  env.PIPELINE_STATE = stub("publication", (url, init) => object.fetch(new Request(url, init)));
  const tick = async (cron: string) => {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron, scheduledTime: Date.now() } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
    await Promise.all(pending);
  };
  /** The runtime fires the alarm: it clears the alarm first, as Cloudflare does. */
  const fire = async () => { storage.alarm = null; await object.alarm(); };
  const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://data.example${path}`, init), env as never);
  const health = async () => (await (await request("/health")).json()) as Record<string, unknown> & { retention?: Record<string, unknown> };
  const run = () => object.fetch(new Request("https://pipeline.internal/run", { method: "POST", headers: { "x-scheduled-at": new Date().toISOString() } }));
  return { storage, bucket, outbound, objectCalls, object, env, tick, fire, request, health, run };
}

const retentionKeys = (storage: FakeStorage) => storage.writes.filter((key) => key.replace(/^-/u, "").startsWith("retention-"));
/** The publication's own `/health` fields, with timestamps blanked so two runs compare equal. */
const publicationFields = (body: Record<string, unknown>) => JSON.parse(JSON.stringify(
  { environment: body.environment, running: body.running, scheduled: body.scheduled, followUp: body.followUp, phase: body.phase, lastRun: body.lastRun, sources: body.sources },
).replace(/\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}[:-]\d{2}[.-]\d{3}Z/gu, "<time>").replace(/"durationMs":\d+/gu, "\"durationMs\":0"));

describe("Spec 029 retention job (dry-run slice)", () => {
  test("RT1: off makes no call and no /health key; unconfigured (enforce, on) makes no call and shows the reason; dry-run runs", async () => {
    for (const flag of [undefined, "", "off"]) {
      const off = world(flag === undefined ? {} : { flag });
      await off.tick(RETENTION_CRON);
      expect(off.objectCalls).toEqual([]);
      expect(off.bucket.calls).toEqual([]);
      expect("retention" in await off.health()).toBe(false);
      expect((await off.request("/retention/report", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    }
    for (const flag of ["enforce", "on"]) {
      const unconfigured = world({ flag });
      await unconfigured.tick(RETENTION_CRON);
      expect(unconfigured.objectCalls).toEqual([]);
      expect(unconfigured.bucket.lists).toBe(0);
      const body = await unconfigured.health();
      expect(body.retention).toMatchObject({ mode: "unconfigured", status: "unconfigured" });
      expect(String(body.retention!.reason)).toContain("R2_RETENTION");
    }
    // Positive control: dry-run schedules the alarm, and the alarm lists.
    const on = world({ flag: "dry-run" });
    await on.tick(RETENTION_CRON);
    expect(on.objectCalls).toEqual(["publication POST /retention"]);
    await on.fire();
    expect(on.bucket.lists).toBeGreaterThan(0);
  });

  test("RT24: the retention cron reaches POST /retention only; the publication and digest crons never do", async () => {
    expect(cronTarget(RETENTION_CRON, DIGEST_CRON, undefined, "17 2 * * *", "43 3 * * *", "30 0 * * *;0 11 * * *", RETENTION_CRON)).toBe("retention");
    // Control: without RETENTION_CRON the same tick would publish.
    expect(cronTarget(RETENTION_CRON, DIGEST_CRON)).toBe("publisher");
    for (const flag of ["off", "dry-run"]) {
      const env = world({ flag });
      await env.tick(PUBLICATION_CRON);
      await env.tick(DIGEST_CRON);
      expect(env.objectCalls.some((call) => call.includes("/retention"))).toBe(false);
      expect(env.objectCalls).toContain("publication POST /run");
      expect(env.objectCalls).toContain("digest POST /run");
    }
    const dev = JSON.parse(await Bun.file(new URL("../wrangler.development.jsonc", import.meta.url)).text()) as { vars: Record<string, string>; triggers: { crons: string[] } };
    const prod = JSON.parse(await Bun.file(new URL("../wrangler.production.jsonc", import.meta.url)).text()) as { vars: Record<string, string>; triggers: { crons: string[] } };
    expect(dev.vars.RETENTION_CRON).toBe(RETENTION_CRON);
    expect(dev.triggers.crons).toContain(RETENTION_CRON);
    // Dev runs the dry run (Dev enable PR, 2026-10-23); Prod has neither the cron nor the flag.
    expect(dev.vars.R2_RETENTION).toBe("dry-run");
    expect(prod.vars.R2_RETENTION).toBeUndefined();
    expect(prod.vars.RETENTION_CRON).toBeUndefined();
    expect(prod.triggers.crons).not.toContain(RETENTION_CRON);
    // Outside the Dev windows 21:50–23:05, 02:05–02:30, 03:30–03:55 UTC, with its 10-minute budget.
    const [minute, hour] = RETENTION_CRON.split(" ").map(Number);
    const start = hour! * 60 + minute!;
    for (const [from, to] of [[21 * 60 + 50, 23 * 60 + 5], [2 * 60 + 5, 2 * 60 + 30], [3 * 60 + 30, 3 * 60 + 55]] as const) {
      expect(start + 10 < from || start > to).toBe(true);
    }
  });

  test("RT25: a running, requested or follow-up publication makes POST /retention skip with the alarm unchanged; with both keys at the alarm the publication runs", async () => {
    const cases: { readonly name: string; readonly prepare: (env: ReturnType<typeof world>) => Promise<void> }[] = [
      { name: "follow-up", prepare: async (env) => { env.storage.alarm = Date.now() + 30 * MINUTE; } },
      { name: "requested run", prepare: async (env) => { expect((await env.run()).status).toBe(202); } },
      { name: "due alarm", prepare: async (env) => { env.storage.alarm = Date.now(); } },
    ];
    for (const item of cases) {
      const env = world({ flag: "dry-run" });
      await item.prepare(env);
      const alarm = env.storage.alarm;
      await env.tick(RETENTION_CRON);
      expect(env.storage.alarm).toBe(alarm);
      expect(env.storage.values.get(RETENTION_SKIP_KEY)).toMatchObject({ reason: "publication-pending" });
      expect(env.storage.values.has(RETENTION_PENDING_KEY)).toBe(false);
      expect(env.bucket.calls).toEqual([]);
    }
    // Positive control: nothing scheduled, so retention is pending and the alarm is set.
    const idle = world({ flag: "dry-run" });
    await idle.tick(RETENTION_CRON);
    expect(idle.storage.values.has(RETENTION_PENDING_KEY)).toBe(true);
    expect(idle.storage.alarm).not.toBeNull();
    // Both keys when the alarm fires: the publication runs, retention is skipped and lists nothing.
    await idle.storage.put("requested-at", new Date().toISOString());
    await idle.fire();
    expect(idle.outbound).toContain("api.github.com");
    expect(idle.storage.values.has("status")).toBe(true);
    expect(idle.storage.values.get(RETENTION_SKIP_KEY)).toMatchObject({ reason: "publication-pending" });
    expect(idle.storage.values.has(RETENTION_PENDING_KEY)).toBe(false);
    expect(idle.bucket.lists).toBe(0);
  });

  test("RT6: a publication alarm makes no retention call or key; retention runs in its own alarm; a second tick today or a paused publication skips with no R2 call", async () => {
    const env = world({ flag: "dry-run" });
    expect((await env.run()).status).toBe(202);
    await env.fire();
    expect(env.outbound).toContain("api.github.com");
    expect(env.bucket.lists).toBe(0);
    expect(retentionKeys(env.storage)).toEqual([]);

    // Retention's own alarm: lists and reports, and the publication's code does not run.
    const own = world({ flag: "dry-run" });
    await own.tick(RETENTION_CRON);
    await own.fire();
    expect(own.outbound).toEqual([]);
    expect(own.storage.values.has("status")).toBe(false);
    expect(own.bucket.lists).toBeGreaterThan(0);
    expect(own.bucket.writes).toBe(0);
    expect(own.storage.values.get(RETENTION_LAST_RUN_KEY)).toMatchObject({ mode: "dry-run", status: "ok" });
    expect(own.storage.writes.filter((key) => !key.replace(/^-/u, "").startsWith("retention-"))).toEqual([]);

    const calls = own.bucket.calls.length;
    await own.tick(RETENTION_CRON);
    expect(own.storage.values.get(RETENTION_SKIP_KEY)).toMatchObject({ reason: "already-ran-today" });
    expect(own.storage.alarm).toBeNull();
    expect(own.bucket.calls.length).toBe(calls);

    const paused = world({ flag: "dry-run", paused: true });
    await paused.tick(RETENTION_CRON);
    expect(paused.storage.values.get(RETENTION_SKIP_KEY)).toMatchObject({ reason: "paused" });
    expect(paused.storage.alarm).toBeNull();
    expect(paused.bucket.calls).toEqual([]);
  });

  test("RT15: POST /run while retention is pending or running answers 202, and the publication runs after the retention alarm", async () => {
    // Pending: the run wins the alarm.
    const pending = world({ flag: "dry-run" });
    await pending.tick(RETENTION_CRON);
    expect((await pending.run()).status).toBe(202);
    await pending.fire();
    expect(pending.outbound).toContain("api.github.com");
    expect(pending.bucket.lists).toBe(0);

    // Running: the request arrives during the retention alarm, after the pointers were read.
    const running = world({ flag: "dry-run" });
    await running.tick(RETENTION_CRON);
    const answers: number[] = [];
    let triggered = false;
    running.bucket.onCall = (op) => {
      if (op === "list" && !triggered) { triggered = true; void running.run().then((response) => answers.push(response.status)); }
    };
    await running.fire();
    await Bun.sleep(0);
    expect(answers).toEqual([202]);
    expect(running.outbound).toEqual([]);
    const pointerReads = running.bucket.calls.findIndex((call) => call.key === "public/search/v1/current.json");
    const firstList = running.bucket.calls.findIndex((call) => call.op === "list");
    expect(pointerReads).toBeLessThan(firstList);
    expect(running.storage.values.get(RETENTION_LAST_RUN_KEY)).toMatchObject({ status: "ok" });
    // The publication's alarm was set by the request and runs next.
    expect(running.storage.alarm).not.toBeNull();
    await running.fire();
    expect(running.outbound).toContain("api.github.com");
  });

  test("RT27: a retention run that fails or throws leaves the next publication alarm and its /health fields as without retention", async () => {
    const control = world({});
    expect((await control.run()).status).toBe(202);
    await control.fire();
    const expected = publicationFields(await control.health());

    // Fails: the pointers are missing. Throws: the run itself rejects.
    for (const kind of ["fails", "throws"] as const) {
      const env = world({ flag: "dry-run", bucket: new RetentionMemoryBucket() });
      await env.tick(RETENTION_CRON);
      if (kind === "throws") {
        env.storage.alarm = null; // the runtime fired the alarm the tick set
        const handled = await retentionAlarm(env.storage, { flag: "dry-run", now: () => Date.now(), paused: async () => false, run: () => Promise.reject(new Error("sweep exploded")) });
        expect(handled).toBe(true);
      } else {
        await env.fire();
      }
      expect(env.storage.values.get(RETENTION_LAST_RUN_KEY)).toMatchObject({ status: "failed" });
      expect(env.storage.values.has(RETENTION_PENDING_KEY)).toBe(false);
      expect((await env.run()).status).toBe(202);
      await env.fire();
      expect(env.outbound).toContain("api.github.com");
      const response = await env.request("/health");
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(publicationFields(body)).toEqual(expected);
      expect(expected.lastRun).not.toBeNull();
    }
  });

  test("RT20: /health retention carries the run's fields for a dry run, a skip and a failure; the report route needs the token", async () => {
    const env = world({ flag: "dry-run" });
    expect((await env.health()).retention).toEqual({ mode: "dry-run", status: "pending", reason: null, lastRun: null });
    await env.tick(RETENTION_CRON);
    await env.fire();
    const done = (await env.health()).retention!;
    expect(done).toMatchObject({ mode: "dry-run", status: "ok", reason: null });
    const lastRun = done.lastRun as Record<string, unknown>;
    expect(Object.keys(lastRun).sort()).toEqual(["at", "candidates", "complete", "deleted", "elapsedMs", "error", "failureKind", "mode", "pointers", "r2", "reason", "remaining", "retained", "runId", "status"]);
    expect(lastRun).toMatchObject({ runId: `retention-${new Date().toISOString().slice(0, 10)}`, deleted: { objects: 0, bytes: 0 }, candidates: { releases: { feed: 1, search: 1 }, evidence: 1 } });
    expect(Object.keys(lastRun.candidates as object).sort()).toEqual(["bytes", "evidence", "objects", "poolObjects", "releases"]);

    await env.tick(RETENTION_CRON);
    expect((await env.health()).retention).toMatchObject({ status: "skipped", reason: "already-ran-today", lastRun: { status: "ok" } });

    const failed = world({ flag: "dry-run", bucket: new RetentionMemoryBucket() });
    await failed.tick(RETENTION_CRON);
    await failed.fire();
    expect((await failed.health()).retention).toMatchObject({ status: "failed", lastRun: { failureKind: "pointer-read" } });

    expect((await env.request("/retention/report")).status).toBe(401);
    const report = await env.request("/retention/report", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(report.status).toBe(200);
    const body = await report.json() as { candidates: { releases: { id: string }[] } };
    // The 60-day-old publication's Feed and Search releases, and nothing else.
    const oldDate = releaseIdAt(Date.now() - 60 * DAY).slice(0, 10);
    expect(body.candidates.releases).toHaveLength(2);
    expect(body.candidates.releases.every((release) => release.id.includes(oldDate))).toBe(true);
    expect(env.storage.values.get(RETENTION_DAY_KEY)).toBe(new Date().toISOString().slice(0, 10));
  });

  test("RT20: with the flag turned off, a stored report is no longer served (404, even with the token) and /health has no retention", async () => {
    const env = world({ flag: "dry-run" });
    await env.tick(RETENTION_CRON);
    await env.fire();
    const authorized = { headers: { authorization: `Bearer ${TOKEN}` } };
    // Control: the report exists and is served while the flag is set.
    expect((await env.request("/retention/report", authorized)).status).toBe(200);
    env.env.R2_RETENTION = "off";
    expect(env.storage.values.has(RETENTION_REPORT_KEY)).toBe(true);
    const calls = env.objectCalls.length;
    expect((await env.request("/retention/report", authorized)).status).toBe(404);
    expect(env.objectCalls.slice(calls).some((call) => call.includes("/retention"))).toBe(false);
    expect("retention" in await env.health()).toBe(false);
  });

  test("RT28: for each retention status, the publication's /health fields and HTTP status equal those with retention off", async () => {
    const off = world({});
    const expected = publicationFields(await off.health());
    const statuses: Record<string, (env: ReturnType<typeof world>) => Promise<void>> = {
      ok: async (env) => { await env.tick(RETENTION_CRON); await env.fire(); },
      failed: async (env) => { env.bucket.objects.delete("public/v2/current.json"); await env.tick(RETENTION_CRON); await env.fire(); },
      overrun: async (env) => {
        let clock = Date.now();
        env.bucket.onCall = () => { clock += 11 * MINUTE; };
        await env.storage.put(RETENTION_PENDING_KEY, new Date().toISOString());
        const realNow = Date.now;
        Date.now = () => clock;
        try { await env.object.alarm(); } finally { Date.now = realNow; }
      },
      skipped: async (env) => { env.storage.alarm = Date.now() + 30 * MINUTE; await env.tick(RETENTION_CRON); env.storage.alarm = null; },
    };
    for (const [status, produce] of Object.entries(statuses)) {
      const env = world({ flag: "dry-run" });
      await produce(env);
      const response = await env.request("/health");
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown> & { retention: { status: string } };
      expect(body.retention.status).toBe(status);
      expect(publicationFields(body)).toEqual(expected);
    }
  });
});
