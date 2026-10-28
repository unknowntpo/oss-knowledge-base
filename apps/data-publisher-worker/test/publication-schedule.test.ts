/** Spec 018: the daily schedule, and the follow-up runs that keep one bad run from costing a day. */
import { describe, expect, test } from "bun:test";

import { cronTarget, PipelineState } from "../src/index";
import {
  CATCH_UP_DELAY_MS,
  FOLLOW_UP_KEY,
  MAX_CATCH_UP_RUNS,
  planFollowUp,
  RETRY_DELAYS_MS,
  runPending,
  runStarting,
  scheduleFollowUp,
  STALE_ALARM_MS,
  type FollowUpMarker,
} from "../src/run-schedule";
import { PUBLICATION_CADENCE_MS } from "../../web/src/freshness";
import { testPlanRows } from "./publication-schedule.cases";

const MINUTE = 60_000;
const now = Date.parse("2026-10-13T22:07:00Z");

function statusOf(run: string) {
  const parts = run.split(", ");
  const sources = { github: { ok: true }, mail: { ok: true }, jira: { ok: !parts.includes("jira failed") } };
  return { ok: parts[0] !== "failed", pollTruncated: parts.includes("truncated"), sources };
}

function countOf(before: string) {
  const [catchUps, retries] = [...before.matchAll(/\d+/gu)].map((match) => Number(match[0]));
  return { catchUps: catchUps!, retries: retries! };
}

class FakeStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async setAlarm(time: number): Promise<void> { this.alarm = time; }
  async list<T>(options: { readonly prefix: string }): Promise<Map<string, T>> {
    return new Map([...this.values].filter(([key]) => key.startsWith(options.prefix)) as [string, T][]);
  }
}

async function crons(environment: "development" | "production"): Promise<readonly string[]> {
  const file = Bun.file(new URL(`../wrangler.${environment}.jsonc`, import.meta.url));
  return (JSON.parse(await file.text()) as { readonly triggers: { readonly crons: readonly string[] } }).triggers.crons;
}

/** Milliseconds between two firings of a five-field cron whose minute and hour are fixed numbers. */
function cadenceOf(cron: string): number {
  const [minute, hour, day, month, weekday] = cron.split(" ");
  if (!/^\d+$/u.test(minute!) || day !== "*" || month !== "*" || weekday !== "*") throw new Error(`unsupported cron ${cron}`);
  return /^\d+$/u.test(hour!) ? 24 * 60 * MINUTE : hour === "*" ? 60 * MINUTE : Number.NaN;
}

describe("Spec 018 daily publication schedule", () => {
  test("T1: Dev publishes once a day at 22:07 UTC and Prod at 22:37 UTC, each with one publisher cron", async () => {
    // Dev's other entries are the digest's (Spec 014 D86) and the Spec 019 amendment (7) jobs'; none is a publication.
    const target = (cron: string) => cronTarget(cron, "47 22 * * *", undefined, "17 2 * * *", "43 3 * * *", "30 0 * * *;0 11 * * *", "17 10 * * *", "23 1 * * *");
    expect((await crons("development")).filter((cron) => target(cron) === "publisher")).toEqual(["7 22 * * *"]);
    // Prod's second entry is the digest tick (Spec 014 D113), not a publication.
    expect(await crons("production")).toEqual(["37 22 * * *", "17 23 * * *"]);
    expect((await crons("production")).filter((cron) => cronTarget(cron, "17 23 * * *") === "publisher")).toEqual(["37 22 * * *"]);
  });

  test("T2: the cadence the page judges staleness by is the cadence of both crons", async () => {
    for (const environment of ["development", "production"] as const) {
      const [cron] = await crons(environment);
      expect(cadenceOf(cron!)).toBe(PUBLICATION_CADENCE_MS);
    }
    // Control: the helper tells an hourly cron from a daily one, so the check above can fail.
    expect(cadenceOf("7 * * * *")).toBe(60 * MINUTE);
  });

  test("T3: the daily crons dispatch to the publisher, with or without the other jobs' crons set", async () => {
    for (const environment of ["development", "production"] as const) {
      const [cron] = await crons(environment);
      expect(cronTarget(cron!, undefined, undefined)).toBe("publisher");
      expect(cronTarget(cron!, "37 1 * * *", "27 * * * *")).toBe("publisher");
    }
    // Control: a configured job cron still takes its own tick.
    expect(cronTarget("37 1 * * *", "37 1 * * *", "27 * * * *")).toBe("digest");
  });

  test.each([...testPlanRows])("$id: after a run that $run, with $before → $expected", (row) => {
    const plan = planFollowUp(statusOf(row.run), countOf(row.before));
    expect(plan === undefined ? "none" : `${plan.reason} in ${plan.delayMs / MINUTE} min`).toBe(row.expected);
  });

  test("T5: the constants bound one trigger to 1 run, 5 catch-ups five minutes apart, and 3 retries", () => {
    expect(CATCH_UP_DELAY_MS).toBe(5 * MINUTE);
    expect(MAX_CATCH_UP_RUNS).toBe(5);
    expect(RETRY_DELAYS_MS).toEqual([10 * MINUTE, 30 * MINUTE, 60 * MINUTE]);
  });

  test("T5: a truncated run stores the follow-up and sets the alarm; a complete run clears it", async () => {
    const storage = new FakeStorage();
    const first = await scheduleFollowUp(storage, statusOf("ok, truncated"), now);
    expect(first).toEqual({ reason: "catch-up", at: "2026-10-13T22:12:00.000Z", catchUps: 1, retries: 0 });
    expect(storage.alarm).toBe(now + 5 * MINUTE);
    expect(await storage.get<FollowUpMarker>(FOLLOW_UP_KEY)).toEqual(first);

    const second = await scheduleFollowUp(storage, statusOf("ok, truncated"), now + 6 * MINUTE);
    expect(second).toMatchObject({ reason: "catch-up", catchUps: 2, retries: 0 });
    expect(storage.alarm).toBe(now + 11 * MINUTE);

    storage.alarm = null;
    expect(await scheduleFollowUp(storage, statusOf("ok, complete"), now + 12 * MINUTE)).toBeUndefined();
    expect(storage.alarm).toBeNull();
    expect(storage.values.has(FOLLOW_UP_KEY)).toBe(false);
  });

  test("T8: after the third retry fails nothing is scheduled and the count is cleared for the next tick", async () => {
    const storage = new FakeStorage();
    let at = now;
    const delays: number[] = [];
    for (let run = 0; run < 4; run += 1) {
      storage.alarm = null;
      const marker = await scheduleFollowUp(storage, statusOf("failed"), at);
      if (marker === undefined) break;
      delays.push(storage.alarm! - at);
      at = storage.alarm!;
    }
    expect(delays).toEqual([10 * MINUTE, 30 * MINUTE, 60 * MINUTE]);
    expect(storage.alarm).toBeNull();
    expect(storage.values.has(FOLLOW_UP_KEY)).toBe(false);
  });

  test("T9: a future alarm is a follow-up: it shows as scheduled and does not block a new trigger", () => {
    expect(runPending(false, now + 5 * MINUTE, now)).toBe(true);
    expect(runStarting(false, now + 5 * MINUTE, now)).toBe(false);
    // An alarm that is due, a running handler, and a stale alarm are judged as before (Spec 009 M9).
    expect(runStarting(false, now, now)).toBe(true);
    expect(runStarting(false, now - STALE_ALARM_MS + 1, now)).toBe(true);
    expect(runStarting(true, null, now)).toBe(true);
    expect(runStarting(false, now - STALE_ALARM_MS, now)).toBe(false);
    expect(runStarting(false, null, now)).toBe(false);
  });

  function pipelineObject(storage: FakeStorage) {
    const env = { PUBLICATION_ENVIRONMENT: "development", GITHUB_SOURCE_TOKEN: "github_pat_test" } as unknown as ConstructorParameters<typeof PipelineState>[1];
    return new PipelineState({ storage } as unknown as ConstructorParameters<typeof PipelineState>[0], env);
  }
  const post = () => new Request("https://pipeline.internal/run", { method: "POST", headers: { "x-scheduled-at": "2026-10-13T23:00:00.000Z" } });

  test("T7: the object's alarm schedules the retry itself when every source is unreachable", async () => {
    const storage = new FakeStorage();
    const object = pipelineObject(storage);
    const realFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(new URL(String(input instanceof Request ? input.url : input)).host);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      expect((await object.fetch(post())).status).toBe(202);
      storage.alarm = null; // the runtime clears an alarm when it fires
      const before = Date.now();
      await object.alarm();
      const health = await (await object.fetch(new Request("https://pipeline.internal/status"))).json() as { scheduled: boolean; lastRun: { ok: boolean }; followUp: FollowUpMarker };
      expect(new Set(requested)).toEqual(new Set(["api.github.com", "lists.apache.org", "issues.apache.org"]));
      expect(health.lastRun.ok).toBe(false);
      expect(health.followUp).toMatchObject({ reason: "retry", catchUps: 0, retries: 1 });
      expect(health.scheduled).toBe(true);
      expect(storage.alarm).toBeGreaterThanOrEqual(before + 10 * MINUTE);
      expect(storage.alarm).toBeLessThanOrEqual(Date.now() + 10 * MINUTE);
      expect(Date.parse(health.followUp.at)).toBe(storage.alarm!);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("T9: POST /run while a follow-up waits runs now and starts a new count; while a run is due it answers 409", async () => {
    const storage = new FakeStorage();
    const pending: FollowUpMarker = { reason: "retry", at: new Date(Date.now() + 30 * MINUTE).toISOString(), catchUps: 0, retries: 2 };
    await storage.put(FOLLOW_UP_KEY, pending);
    storage.alarm = Date.now() + 30 * MINUTE;
    const object = pipelineObject(storage);

    const status = await (await object.fetch(new Request("https://pipeline.internal/status"))).json() as { scheduled: boolean; followUp: FollowUpMarker | null };
    expect(status).toMatchObject({ scheduled: true, followUp: pending });

    const before = Date.now();
    const accepted = await object.fetch(post());
    expect(accepted.status).toBe(202);
    expect(storage.alarm).toBeGreaterThanOrEqual(before);
    expect(storage.alarm).toBeLessThanOrEqual(Date.now());
    expect(storage.values.has(FOLLOW_UP_KEY)).toBe(false);
    expect(storage.values.get("requested-at")).toBe("2026-10-13T23:00:00.000Z");

    // The alarm is now due: a second trigger must not start a second run.
    expect((await object.fetch(post())).status).toBe(409);
    const idle = await (await object.fetch(new Request("https://pipeline.internal/status"))).json() as { followUp: FollowUpMarker | null };
    expect(idle.followUp).toBeNull();
  });
});
