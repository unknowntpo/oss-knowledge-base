/**
 * Spec 018 follow-up plan: the single source for the rows of `publication-schedule.test.ts` and
 * for the table in docs/specs/018-daily-publication/spec.md (`bun run docs:test-plan`).
 *
 * - `run`: how the publication that just ended went. `truncated` is `lastRun.pollTruncated`;
 *   `jira failed` is a run that published while one source failed. `failed, truncated` is a
 *   status with `ok: false` and `pollTruncated: true`: only a publication that succeeded catches up.
 * - `before`: follow-up runs already made since the last Cron tick or `POST /run`.
 * - `expected`: the follow-up the object schedules, and when, or `none` (wait for the next tick).
 */
export const testPlanRows = [
  { id: "T4", run: "ok, complete", before: "0 catch-ups, 0 retries", expected: "none" },
  { id: "T5", run: "ok, truncated", before: "0 catch-ups, 0 retries", expected: "catch-up in 5 min" },
  { id: "T5", run: "ok, truncated", before: "4 catch-ups, 0 retries", expected: "catch-up in 5 min" },
  { id: "T6", run: "ok, truncated", before: "5 catch-ups, 0 retries", expected: "none" },
  { id: "T7", run: "failed", before: "0 catch-ups, 0 retries", expected: "retry in 10 min" },
  { id: "T7", run: "failed", before: "0 catch-ups, 1 retries", expected: "retry in 30 min" },
  { id: "T7", run: "failed", before: "0 catch-ups, 2 retries", expected: "retry in 60 min" },
  { id: "T8", run: "failed", before: "0 catch-ups, 3 retries", expected: "none" },
  { id: "T7", run: "ok, jira failed", before: "0 catch-ups, 0 retries", expected: "retry in 10 min" },
  { id: "T8", run: "ok, jira failed", before: "0 catch-ups, 3 retries", expected: "none" },
  { id: "T5", run: "ok, truncated, jira failed", before: "0 catch-ups, 3 retries", expected: "catch-up in 5 min" },
  { id: "T7", run: "ok, truncated, jira failed", before: "5 catch-ups, 0 retries", expected: "retry in 10 min" },
  { id: "T7", run: "failed", before: "5 catch-ups, 0 retries", expected: "retry in 10 min" },
  { id: "T7", run: "failed, truncated", before: "0 catch-ups, 0 retries", expected: "retry in 10 min" },
] as const;
