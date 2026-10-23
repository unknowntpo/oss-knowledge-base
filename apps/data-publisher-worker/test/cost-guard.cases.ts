/**
 * Spec 026 test plan: the threshold math (Behavior 5–6). The single source for the unit tests and
 * for the table in docs/specs/026-cost-guard/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * Percents are floored to 0.01 for display; the status compares exact values. A month counter (R2
 * Class A and B, queried dimensions) projects `value + recent / days × remaining days` (CG35):
 * `recent` is its count over the `days` complete UTC days before today; with `days` 0 it projects
 * as `value`. `now` 2026-10-31T22:07Z leaves 0.0785 days of October; 2026-10-08T00:00Z leaves 24;
 * 2026-02-15T00:00Z leaves 14 of February's 28. Neurons project `value / elapsed day` from a quarter
 * of the day (2026-10-20T22:07Z is 92.15 % of it); gauges are not projected. `recent` 33,676 is the
 * account's real Class A over 2026-10-14..20 and 2,062,716 its October to 2026-10-21 02:04 UTC.
 */
export const testPlanRows = [
  { id: "CG2", case: "R2 Class A just under warn, month end", metric: "r2ClassA", value: 599_999, recent: 140_000, days: 7, now: "2026-10-31T22:07:00Z", percent: 59.99, projectedPercent: 60.15, status: "ok" },
  { id: "CG2", case: "R2 Class A at 60 %: warn", metric: "r2ClassA", value: 600_000, recent: 140_000, days: 7, now: "2026-10-31T22:07:00Z", percent: 60, projectedPercent: 60.15, status: "warn" },
  { id: "CG2", case: "R2 Class A just under 80 %", metric: "r2ClassA", value: 799_999, recent: 140_000, days: 7, now: "2026-10-31T22:07:00Z", percent: 79.99, projectedPercent: 80.15, status: "warn" },
  { id: "CG2", case: "R2 Class A at 80 %: trip", metric: "r2ClassA", value: 800_000, recent: 140_000, days: 7, now: "2026-10-31T22:07:00Z", percent: 80, projectedPercent: 80.15, status: "tripped" },
  { id: "CG35", case: "real October (Example): the 7-day rate projects 211 %, not month to date's 318 %", metric: "r2ClassA", value: 2_062_716, recent: 33_676, days: 7, now: "2026-10-21T02:04:00Z", percent: 206.27, projectedPercent: 211.52, status: "tripped" },
  { id: "CG35", case: "a past burst of 700,000 with a quiet week: warns, no longer projected over", metric: "r2ClassA", value: 700_000, recent: 33_676, days: 7, now: "2026-10-21T22:07:00Z", percent: 70, projectedPercent: 74.84, status: "warn" },
  { id: "CG35", case: "projected exactly 100 %: not over", metric: "r2ClassA", value: 280_000, recent: 210_000, days: 7, now: "2026-10-08T00:00:00Z", percent: 28, projectedPercent: 100, status: "ok" },
  { id: "CG35", case: "projected just over 100 % (shown floored)", metric: "r2ClassA", value: 280_001, recent: 210_000, days: 7, now: "2026-10-08T00:00:00Z", percent: 28, projectedPercent: 100, status: "tripped" },
  { id: "CG35", case: "November 1 00:30: October's last 7 days project from the 1st", metric: "r2ClassA", value: 100, recent: 1_400_000, days: 7, now: "2026-11-01T00:30:00Z", percent: 0.01, projectedPercent: 599.59, status: "tripped" },
  { id: "CG35", case: "February has 28 days: 14 remain", metric: "r2ClassA", value: 400_000, recent: 280_000, days: 7, now: "2026-02-15T00:00:00Z", percent: 40, projectedPercent: 96, status: "ok" },
  { id: "CG2", case: "R2 Class B at 60 %", metric: "r2ClassB", value: 6_000_000, recent: 1_400_000, days: 7, now: "2026-10-31T22:07:00Z", percent: 60, projectedPercent: 60.15, status: "warn" },
  { id: "CG2", case: "R2 storage just under 80 %: a gauge has no projection", metric: "r2StorageBytes", value: 7_999_999_999, recent: null, days: null, now: "2026-10-20T22:07:00Z", percent: 79.99, projectedPercent: null, status: "warn" },
  { id: "CG2", case: "R2 storage at 8 GB: trip", metric: "r2StorageBytes", value: 8_000_000_000, recent: null, days: null, now: "2026-10-20T22:07:00Z", percent: 80, projectedPercent: null, status: "tripped" },
  { id: "CG2", case: "Vectorize stored dimensions today (Example): warn, never trips", metric: "vectorizeStoredDimensions", value: 9_998_336, recent: null, days: null, now: "2026-10-20T22:07:00Z", percent: 99.98, projectedPercent: null, status: "warn" },
  { id: "CG2", case: "Vectorize stored dimensions under 60 %", metric: "vectorizeStoredDimensions", value: 5_999_999, recent: null, days: null, now: "2026-10-20T22:07:00Z", percent: 59.99, projectedPercent: null, status: "ok" },
  { id: "CG35", case: "queried dimensions (Example), no complete day of history: projects as month to date", metric: "vectorizeQueriedDimensions", value: 10_244_096, recent: 0, days: 0, now: "2026-10-20T22:07:00Z", percent: 20.48, projectedPercent: 20.48, status: "ok" },
  { id: "CG35", case: "queried dimensions with 3 complete days: the rate uses 3", metric: "vectorizeQueriedDimensions", value: 15_000_000, recent: 3_000_000, days: 3, now: "2026-10-21T22:07:00Z", percent: 30, projectedPercent: 50.15, status: "ok" },
  { id: "CG2", case: "neurons today just under warn at the Dev tick", metric: "workersAiNeurons", value: 5_999, recent: null, days: null, now: "2026-10-20T22:07:00Z", percent: 59.99, projectedPercent: 65.09, status: "ok" },
  { id: "CG2", case: "neurons today at 60 %", metric: "workersAiNeurons", value: 6_000, recent: null, days: null, now: "2026-10-20T22:07:00Z", percent: 60, projectedPercent: 65.1, status: "warn" },
  { id: "CG2", case: "neurons today just under 80 %", metric: "workersAiNeurons", value: 7_999, recent: null, days: null, now: "2026-10-20T22:07:00Z", percent: 79.99, projectedPercent: 86.8, status: "warn" },
  { id: "CG2", case: "neurons today at 80 %: trip", metric: "workersAiNeurons", value: 8_000, recent: null, days: null, now: "2026-10-20T22:07:00Z", percent: 80, projectedPercent: 86.81, status: "tripped" },
  { id: "CG2", case: "neurons one second before a quarter of the day: no projection", metric: "workersAiNeurons", value: 5_000, recent: null, days: null, now: "2026-10-20T05:59:59Z", percent: 50, projectedPercent: null, status: "ok" },
  { id: "CG2", case: "neurons at a quarter of the day: projected 200 % trips", metric: "workersAiNeurons", value: 5_000, recent: null, days: null, now: "2026-10-20T06:00:00Z", percent: 50, projectedPercent: 200, status: "tripped" },
  { id: "CG2", case: "a value that could not be read", metric: "r2ClassA", value: null, recent: null, days: null, now: "2026-10-20T22:07:00Z", percent: null, projectedPercent: null, status: "unavailable" },
] as const;
