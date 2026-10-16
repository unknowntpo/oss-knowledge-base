/**
 * Spec 019 amendment (5), W57–W60: the chart model's test plan, the single source for
 * `profile-chart.test.ts` and the table in docs/specs/019-contributor-profile/spec.md
 * (`bun run docs:test-plan` regenerates it).
 *
 * `dev-shaped`: the bucket counts and coverage of two real Dev responses (2026-10-15 20:03 UTC
 * release, read 2026-10-16): a GitHub identity with reviews and the activity log, and a dev@-only
 * identity. Numbers only; no identity is stored. `constructed`: edge cases.
 */
import type { SourceCoverageV1 } from "@oss-knowledge-base/reference-pipeline/people";

import type { ChartInput, OverTimeRow } from "../src/profile-chart";

const NOW = Date.parse("2026-10-16T00:00:00Z");
const LOG_FROM = "2026-09-10T02:45:16.847Z";
const recorded = (source: SourceCoverageV1["source"], from: string): SourceCoverageV1 =>
  ({ source, status: "recorded", from, until: "2026-10-15T02:45:16.847Z", storedFrom: from });
const ALL_RECORDED: readonly SourceCoverageV1[] = [
  recorded("github-reviews", "2025-11-01T00:00:00.000Z"), recorded("github", LOG_FROM), recorded("jira", LOG_FROM), recorded("mail", LOG_FROM),
];
const log = (github: number, mail = 0, jira = 0) => ({ github, jira, mail });
const months = (counts: readonly (readonly [string, number, number, Partial<OverTimeRow>?])[]): OverTimeRow[] =>
  counts.map(([label, given, received, extra]) => ({ label, given, received, ...extra }));

export const fixtures: Readonly<Record<string, ChartInput>> = {
  "github-12m": {
    source: "github", period: "12m", coverage: ALL_RECORDED, from: "2025-11-01T00:00:00.000Z", until: "2026-10-15T03:42:56Z", nowMs: NOW,
    overTime: months([["2025-11", 0, 0], ["2025-12", 0, 3], ["2026-01", 1, 19], ["2026-02", 0, 0], ["2026-03", 0, 0], ["2026-04", 0, 0], ["2026-05", 0, 0], ["2026-06", 0, 0], ["2026-07", 0, 2], ["2026-08", 6, 30], ["2026-09", 10, 13, log(3)], ["2026-10", 0, 5, log(3)]]),
  },
  "github-90d": {
    source: "github", period: "90d", coverage: ALL_RECORDED, from: "2026-07-18T00:00:00.000Z", until: "2026-10-15T03:42:56Z", nowMs: NOW,
    overTime: months([["2026-07-13", 0, 0], ["2026-07-20", 0, 1], ["2026-07-27", 0, 6], ["2026-08-03", 1, 4], ["2026-08-10", 2, 7], ["2026-08-17", 2, 9], ["2026-08-24", 1, 5], ["2026-08-31", 1, 4], ["2026-09-07", 0, 0, log(0)], ["2026-09-14", 2, 4, log(2)], ["2026-09-21", 5, 5, log(1)], ["2026-09-28", 2, 4, log(3)], ["2026-10-05", 0, 0, log(0)], ["2026-10-12", 0, 1, log(0)]]),
  },
  "mail-12m": {
    source: "mail", period: "12m", coverage: ALL_RECORDED, from: LOG_FROM, until: "2026-10-15T02:45:16.847Z", nowMs: NOW,
    overTime: months([["2026-09", 0, 0, log(0, 19)], ["2026-10", 0, 0, log(0, 4)]]),
  },
  "mail-90d": {
    source: "mail", period: "90d", coverage: ALL_RECORDED, from: LOG_FROM, until: "2026-10-15T02:45:16.847Z", nowMs: NOW,
    overTime: months([["2026-09-07", 0, 0, log(0, 1)], ["2026-09-14", 0, 0, log(0, 3)], ["2026-09-21", 0, 0, log(0, 9)], ["2026-09-28", 0, 0, log(0, 7)], ["2026-10-05", 0, 0, log(0, 2)], ["2026-10-12", 0, 0, log(0, 1)]]),
  },
  "jira-12m": {
    source: "jira", period: "12m", coverage: ALL_RECORDED, from: LOG_FROM, until: "2026-10-15T02:45:16.847Z", nowMs: NOW,
    overTime: months([["2026-09", 3, 9, log(5, 7, 2)], ["2026-10", 0, 0, log(1, 1, 0)]]),
  },
  "github-no-log": {
    source: "github", period: "12m", nowMs: NOW, from: "2025-11-01T00:00:00.000Z", until: "2026-10-15T03:42:56Z",
    coverage: [recorded("github-reviews", "2025-11-01T00:00:00.000Z"), { source: "github", status: "not-recorded" }],
    overTime: months([["2025-11", 0, 0], ["2025-12", 0, 0], ["2026-01", 0, 0], ["2026-02", 0, 0], ["2026-03", 0, 0], ["2026-04", 0, 0], ["2026-05", 0, 0], ["2026-06", 0, 0], ["2026-07", 0, 0], ["2026-08", 0, 0], ["2026-09", 2, 0], ["2026-10", 1, 1]]),
  },
  "github-zeros": {
    source: "github", period: "90d", coverage: ALL_RECORDED, from: "2026-07-18T00:00:00.000Z", until: "2026-10-15T03:42:56Z", nowMs: NOW,
    overTime: months([["2026-07-13", 0, 0], ["2026-07-20", 0, 0], ["2026-07-27", 0, 0], ["2026-08-03", 0, 0], ["2026-08-10", 0, 0], ["2026-08-17", 0, 0], ["2026-08-24", 0, 0], ["2026-08-31", 0, 0], ["2026-09-07", 0, 0, log(0)], ["2026-09-14", 0, 0, log(0)], ["2026-09-21", 0, 0, log(0)], ["2026-09-28", 0, 0, log(0)], ["2026-10-05", 0, 0, log(0)], ["2026-10-12", 0, 0, log(0)]]),
  },
};

/**
 * `columns`: count, first and last bucket. `series`: up / down. `scale`: step, top, bottom.
 * `band`: runs of buckets with no own series recorded. `lanes`: series with a coverage lane.
 * `partial` / `clipped`: buckets whose tooltip names a later start. `peak`: the busiest bucket.
 */
export const testPlanRows = [
  { id: "W57", case: "a GitHub identity over 12 months: 12 monthly columns, oldest on the left", data: "dev-shaped", fixture: "github-12m", columns: "12: 2025-11 … 2026-10", series: "given + github / received", scale: "10, 20, 30", band: null, lanes: "github", partial: "2026-09 github from 2026-09-10", clipped: null, peak: "2026-09 13" },
  { id: "W57", case: "the same identity over 90 days: 14 weekly columns from the week of now − 90 days", data: "dev-shaped", fixture: "github-90d", columns: "14: 2026-07-13 … 2026-10-12", series: "given + github / received", scale: "5, 10, 10", band: null, lanes: "github", partial: "2026-09-07 github from 2026-09-10", clipped: "2026-07-13", peak: "2026-09-21 6" },
  { id: "W57", case: "a dev@ identity with 35 days of data still has 12 monthly columns; ten are not recorded", data: "dev-shaped", fixture: "mail-12m", columns: "12: 2025-11 … 2026-10", series: "mail / —", scale: "10, 20, 0", band: "2025-11 – 2026-08", lanes: null, partial: null, clipped: "2026-09", peak: "2026-09 19" },
  { id: "W57", case: "the dev@ identity over 90 days: the weeks before the log are one band", data: "dev-shaped", fixture: "mail-90d", columns: "14: 2026-07-13 … 2026-10-12", series: "mail / —", scale: "5, 10, 0", band: "2026-07-13 – 2026-08-31", lanes: null, partial: null, clipped: "2026-09-07", peak: "2026-09-21 9" },
  { id: "W58", case: "a Jira identity charts Jira only, although the rows carry reviews, GitHub and dev@ counts", data: "constructed", fixture: "jira-12m", columns: "12: 2025-11 … 2026-10", series: "jira / —", scale: "1, 2, 0", band: "2025-11 – 2026-08", lanes: null, partial: null, clipped: "2026-09", peak: "2026-09 2" },
  { id: "W60", case: "a GitHub identity in a community without the activity log: reviews drawn, GitHub activity a lane, never 0", data: "constructed", fixture: "github-no-log", columns: "12: 2025-11 … 2026-10", series: "given + github / received", scale: "1, 2, 1", band: null, lanes: "github", partial: null, clipped: null, peak: "2026-09 2" },
  { id: "W59", case: "everything recorded and 0: no band, no lane, a scale of one step", data: "constructed", fixture: "github-zeros", columns: "14: 2026-07-13 … 2026-10-12", series: "given + github / received", scale: "1, 1, 0", band: null, lanes: "github", partial: "2026-09-07 github from 2026-09-10", clipped: "2026-07-13", peak: null },
] as const;
