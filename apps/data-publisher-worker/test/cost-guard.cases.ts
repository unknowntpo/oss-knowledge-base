/**
 * Spec 026 test plan: the threshold math (Behavior 5–6). The single source for the unit tests and
 * for the table in docs/specs/026-cost-guard/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * Percents are floored to 0.01 for display; the status compares exact values. `now` 2026-10-31T22:07Z
 * is 99.75 % of October; 2026-10-08T18:00Z is exactly a quarter of it; 2026-10-20T22:07Z is 92.15 %
 * of its UTC day. A projection is null before a quarter of the period and for gauges.
 */
export const testPlanRows = [
  { id: "CG2", case: "R2 Class A just under warn, month end", metric: "r2ClassA", value: 599_999, now: "2026-10-31T22:07:00Z", percent: 59.99, projectedPercent: 60.15, status: "ok" },
  { id: "CG2", case: "R2 Class A at 60 %: warn", metric: "r2ClassA", value: 600_000, now: "2026-10-31T22:07:00Z", percent: 60, projectedPercent: 60.15, status: "warn" },
  { id: "CG2", case: "R2 Class A just under 80 %", metric: "r2ClassA", value: 799_999, now: "2026-10-31T22:07:00Z", percent: 79.99, projectedPercent: 80.2, status: "warn" },
  { id: "CG2", case: "R2 Class A at 80 %: trip", metric: "r2ClassA", value: 800_000, now: "2026-10-31T22:07:00Z", percent: 80, projectedPercent: 80.2, status: "tripped" },
  { id: "CG2", case: "one second before a quarter of the month: no projection", metric: "r2ClassA", value: 300_000, now: "2026-10-08T17:59:59Z", percent: 30, projectedPercent: null, status: "ok" },
  { id: "CG2", case: "a quarter of the month: projected 120 % trips", metric: "r2ClassA", value: 300_000, now: "2026-10-08T18:00:00Z", percent: 30, projectedPercent: 120, status: "tripped" },
  { id: "CG2", case: "projected exactly 100 %: not over", metric: "r2ClassA", value: 250_000, now: "2026-10-08T18:00:00Z", percent: 25, projectedPercent: 100, status: "ok" },
  { id: "CG2", case: "projected just over 100 % (shown floored)", metric: "r2ClassA", value: 250_001, now: "2026-10-08T18:00:00Z", percent: 25, projectedPercent: 100, status: "tripped" },
  { id: "CG2", case: "February has 28 days", metric: "r2ClassA", value: 400_000, now: "2026-02-15T00:00:00Z", percent: 40, projectedPercent: 80, status: "ok" },
  { id: "CG2", case: "R2 Class B at 60 %", metric: "r2ClassB", value: 6_000_000, now: "2026-10-31T22:07:00Z", percent: 60, projectedPercent: 60.15, status: "warn" },
  { id: "CG2", case: "R2 storage just under 80 %: a gauge has no projection", metric: "r2StorageBytes", value: 7_999_999_999, now: "2026-10-20T22:07:00Z", percent: 79.99, projectedPercent: null, status: "warn" },
  { id: "CG2", case: "R2 storage at 8 GB: trip", metric: "r2StorageBytes", value: 8_000_000_000, now: "2026-10-20T22:07:00Z", percent: 80, projectedPercent: null, status: "tripped" },
  { id: "CG2", case: "Vectorize stored dimensions today (Example): warn, never trips", metric: "vectorizeStoredDimensions", value: 9_998_336, now: "2026-10-20T22:07:00Z", percent: 99.98, projectedPercent: null, status: "warn" },
  { id: "CG2", case: "Vectorize stored dimensions under 60 %", metric: "vectorizeStoredDimensions", value: 5_999_999, now: "2026-10-20T22:07:00Z", percent: 59.99, projectedPercent: null, status: "ok" },
  { id: "CG2", case: "Vectorize queried dimensions (Example)", metric: "vectorizeQueriedDimensions", value: 10_244_096, now: "2026-10-20T22:07:00Z", percent: 20.48, projectedPercent: 31.88, status: "ok" },
  { id: "CG2", case: "neurons today just under warn at the Dev tick", metric: "workersAiNeurons", value: 5_999, now: "2026-10-20T22:07:00Z", percent: 59.99, projectedPercent: 65.09, status: "ok" },
  { id: "CG2", case: "neurons today at 60 %", metric: "workersAiNeurons", value: 6_000, now: "2026-10-20T22:07:00Z", percent: 60, projectedPercent: 65.1, status: "warn" },
  { id: "CG2", case: "neurons today just under 80 %", metric: "workersAiNeurons", value: 7_999, now: "2026-10-20T22:07:00Z", percent: 79.99, projectedPercent: 86.8, status: "warn" },
  { id: "CG2", case: "neurons today at 80 %: trip", metric: "workersAiNeurons", value: 8_000, now: "2026-10-20T22:07:00Z", percent: 80, projectedPercent: 86.81, status: "tripped" },
  { id: "CG2", case: "neurons one second before a quarter of the day: no projection", metric: "workersAiNeurons", value: 5_000, now: "2026-10-20T05:59:59Z", percent: 50, projectedPercent: null, status: "ok" },
  { id: "CG2", case: "neurons at a quarter of the day: projected 200 % trips", metric: "workersAiNeurons", value: 5_000, now: "2026-10-20T06:00:00Z", percent: 50, projectedPercent: 200, status: "tripped" },
  { id: "CG2", case: "a value that could not be read", metric: "r2ClassA", value: null, now: "2026-10-20T22:07:00Z", percent: null, projectedPercent: null, status: "unavailable" },
] as const;
