/**
 * Spec 026 amendment 2026-10-21 (dollar budget), CG21: each metric's use beyond its included
 * allowance in US dollars at list price. Planned slice: no test runs these rows yet (the spec's
 * marker is `[pending]`); the implementing slice adds `test.each(testPlanRows)` and drops the tag.
 *
 * Dollars are floored to 0.0001 for display; sums and comparisons use exact values. `now`
 * 2026-10-21T22:07Z is 67.49 % of October and 92.15 % of its UTC day. A counter projects as
 * value / elapsed month; a gauge (storage, stored dimensions) projects as its current value;
 * neurons project today's overage (value / elapsed day, from a quarter of the day) times the days
 * of the month. No projection before a quarter of the month.
 */
export const testPlanRows = [
  { id: "CG21", case: "R2 Class A at the included million: nothing billed yet", metric: "r2ClassA", value: 1_000_000, now: "2026-10-21T22:07:00Z", overageUsd: 0, projectedOverageUsd: 2.1677 },
  { id: "CG21", case: "R2 Class A with the 10-13 incident (Example)", metric: "r2ClassA", value: 1_230_000, now: "2026-10-21T22:07:00Z", overageUsd: 1.035, projectedOverageUsd: 3.7013 },
  { id: "CG21", case: "one second before a quarter of the month: no projection", metric: "r2ClassA", value: 1_230_000, now: "2026-10-08T17:59:59Z", overageUsd: 1.035, projectedOverageUsd: null },
  { id: "CG21", case: "the same burst at a quarter of the month projects far over", metric: "r2ClassA", value: 1_230_000, now: "2026-10-08T18:00:00Z", overageUsd: 1.035, projectedOverageUsd: 17.64 },
  { id: "CG21", case: "February has 28 days", metric: "r2ClassA", value: 1_600_000, now: "2026-02-15T00:00:00Z", overageUsd: 2.7, projectedOverageUsd: 9.9 },
  { id: "CG21", case: "R2 Class B (Example) under its 10 million", metric: "r2ClassB", value: 2_800_000, now: "2026-10-21T22:07:00Z", overageUsd: 0, projectedOverageUsd: 0 },
  { id: "CG21", case: "R2 Class B over its 10 million", metric: "r2ClassB", value: 12_000_000, now: "2026-10-21T22:07:00Z", overageUsd: 0.72, projectedOverageUsd: 2.801 },
  { id: "CG21", case: "R2 storage 13.9 GB (Example): a gauge projects as itself", metric: "r2StorageBytes", value: 13_900_000_000, now: "2026-10-21T22:07:00Z", overageUsd: 0.0585, projectedOverageUsd: 0.0585 },
  { id: "CG21", case: "R2 storage at exactly 10 GB", metric: "r2StorageBytes", value: 10_000_000_000, now: "2026-10-21T22:07:00Z", overageUsd: 0, projectedOverageUsd: 0 },
  { id: "CG21", case: "Vectorize stored dimensions today (Example): $0.0000888, shown floored", metric: "vectorizeStoredDimensions", value: 10_177_536, now: "2026-10-21T22:07:00Z", overageUsd: 0, projectedOverageUsd: 0 },
  { id: "CG21", case: "Vectorize stored dimensions 200 million over", metric: "vectorizeStoredDimensions", value: 210_000_000, now: "2026-10-21T22:07:00Z", overageUsd: 0.1, projectedOverageUsd: 0.1 },
  { id: "CG21", case: "Vectorize queried dimensions (Example)", metric: "vectorizeQueriedDimensions", value: 10_433_536, now: "2026-10-21T22:07:00Z", overageUsd: 0, projectedOverageUsd: 0 },
  { id: "CG21", case: "Vectorize queried dimensions 100 million over", metric: "vectorizeQueriedDimensions", value: 150_000_000, now: "2026-10-21T22:07:00Z", overageUsd: 1, projectedOverageUsd: 1.7225 },
  { id: "CG21", case: "neurons at the sum of this Worker's daily caps: never billed", metric: "workersAiNeurons", value: 8_500, now: "2026-10-21T22:07:00Z", overageUsd: 0, projectedOverageUsd: 0 },
  { id: "CG21", case: "neurons 20,000 today at the Dev tick", metric: "workersAiNeurons", value: 20_000, now: "2026-10-21T22:07:00Z", overageUsd: 0.11, projectedOverageUsd: 3.9907 },
  { id: "CG21", case: "neurons before a quarter of the day: today is not extrapolated", metric: "workersAiNeurons", value: 20_000, now: "2026-10-21T05:59:59Z", overageUsd: 0.11, projectedOverageUsd: 3.41 },
  { id: "CG21", case: "a value that could not be read", metric: "r2ClassA", value: null, now: "2026-10-21T22:07:00Z", overageUsd: null, projectedOverageUsd: null },
] as const;
