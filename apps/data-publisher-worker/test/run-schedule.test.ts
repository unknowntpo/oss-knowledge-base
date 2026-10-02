import { describe, expect, test } from "bun:test";

import { runPending, STALE_ALARM_MS } from "../src/run-schedule";

describe("run scheduling", () => {
  const now = Date.parse("2026-10-02T02:00:00Z");

  test("an idle object with no alarm schedules a run", () => {
    expect(runPending(false, null, now)).toBe(false);
  });

  test("an active alarm handler blocks a new run", () => {
    expect(runPending(true, null, now)).toBe(true);
  });

  test("a future or recently due alarm, including a pending retry, blocks a new run", () => {
    expect(runPending(false, now + 2_000, now)).toBe(true);
    expect(runPending(false, now - STALE_ALARM_MS + 1, now)).toBe(true);
  });

  test("an alarm whose retries were exhausted no longer blocks the next trigger", () => {
    expect(runPending(false, now - STALE_ALARM_MS, now)).toBe(false);
    expect(runPending(false, now - 2 * 24 * 60 * 60_000, now)).toBe(false);
  });
});
