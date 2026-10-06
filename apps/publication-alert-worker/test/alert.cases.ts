/**
 * Spec 011 test plan: the single source for the decision unit tests and for the table in
 * docs/specs/011-publication-alerting/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * `health` names the /health outcome the test builds:
 *   ok / failed   — 200 with `lastRun.ok` true / false and `lastRun.completedAt` = `completedAt`
 *   no run        — 200 with `lastRun: null`
 *   not JSON      — 200 with an HTML body
 *   unreachable   — every attempt fails (network error, timeout, or non-2xx)
 * `open` is the number of open issues labelled `publication-alert` titled
 * "Dev data publication alert". `action`: none, open (create one issue), close (comment on and
 * close every open alert issue).
 */
export const testPlanRows = [
  { id: "A1", health: "ok", completedAt: "2026-10-06T06:07:13Z", now: "2026-10-06T07:11:18Z", open: 0, action: "none", reason: "fresh" },
  { id: "A1", health: "ok", completedAt: "2026-10-06T06:07:13Z", now: "2026-10-06T09:07:13Z", open: 0, action: "none", reason: "fresh" },
  { id: "A2", health: "ok", completedAt: "2026-10-06T06:07:13Z", now: "2026-10-06T09:07:14Z", open: 0, action: "open", reason: "stale" },
  { id: "A2", health: "ok", completedAt: "2026-09-30T01:07:13Z", now: "2026-09-30T04:37:00Z", open: 0, action: "open", reason: "stale" },
  { id: "A3", health: "failed", completedAt: "2026-10-06T07:07:13Z", now: "2026-10-06T07:37:00Z", open: 0, action: "open", reason: "failed" },
  { id: "A4", health: "ok", completedAt: "2026-10-06T06:07:13Z", now: "2026-10-06T07:11:18Z", open: 1, action: "close", reason: "fresh" },
  { id: "A4", health: "ok", completedAt: "2026-10-06T06:07:13Z", now: "2026-10-06T09:07:13Z", open: 1, action: "close", reason: "fresh" },
  { id: "A5", health: "unreachable", completedAt: null, now: "2026-10-06T07:37:00Z", open: 0, action: "open", reason: "unreachable" },
  { id: "A6", health: "no run", completedAt: null, now: "2026-10-06T07:37:00Z", open: 0, action: "open", reason: "invalid" },
  { id: "A6", health: "not JSON", completedAt: null, now: "2026-10-06T07:37:00Z", open: 0, action: "open", reason: "invalid" },
  { id: "A6", health: "ok", completedAt: "not-a-time", now: "2026-10-06T07:37:00Z", open: 0, action: "open", reason: "invalid" },
  { id: "A7", health: "ok", completedAt: "2026-10-06T06:07:13Z", now: "2026-10-06T09:07:14Z", open: 1, action: "none", reason: "stale" },
  { id: "A7", health: "failed", completedAt: "2026-10-06T07:07:13Z", now: "2026-10-06T07:37:00Z", open: 1, action: "none", reason: "failed" },
  { id: "A7", health: "unreachable", completedAt: null, now: "2026-10-06T07:37:00Z", open: 1, action: "none", reason: "unreachable" },
  { id: "A12", health: "ok", completedAt: "2026-10-06T06:07:13Z", now: "2026-10-06T07:11:18Z", open: 2, action: "close", reason: "fresh" },
  { id: "A12", health: "ok", completedAt: "2026-10-06T06:07:13Z", now: "2026-10-06T09:07:14Z", open: 2, action: "none", reason: "stale" },
  { id: "A13", health: "ok", completedAt: "2026-10-06T07:08:13Z", now: "2026-10-06T07:07:13Z", open: 0, action: "none", reason: "fresh" },
] as const;
