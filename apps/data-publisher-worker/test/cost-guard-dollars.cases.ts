/**
 * Spec 026 amendment 2026-10-21 (dollar budget), CG21 and CG35: each metric's use beyond its
 * included allowance in US dollars at list price, now and projected to the end of the UTC month.
 * `metricOverage` runs these rows (test/cost-guard.test.ts).
 *
 * Dollars are floored to 0.0001 for display; sums and comparisons use exact values. `value` is
 * month to date (a gauge: its newest reading; neurons: today). A counter (R2 Class A and B,
 * queried dimensions) projects `value + recent / days × remaining days` (CG35, owner decision
 * 2026-10-21): `recent` is its count over the `days` complete UTC days before today, at most 7;
 * with `days` 0 it projects as `value`. Remaining days run from `now` to the end of the UTC month.
 * A gauge projects as itself; neurons project today's overage (value / elapsed day, from a
 * quarter of the day) times the days of the month. `recent` 33,676 Class A and 218,882 Class B are
 * the account's real 2026-10-14..20; 953,503 is the account's real 2026-10-01..07 Class A; October
 * to date 2,062,716 Class A and 269,830 Class B are the dry run's (2026-10-21 02:04 UTC).
 */
export const testPlanRows = [
  { id: "CG21", case: "R2 storage 13.9 GB (Example): a gauge projects as itself", metric: "r2StorageBytes", value: 13_900_000_000, recent: null, days: null, now: "2026-10-21T02:04:00Z", overageUsd: 0.0585, projectedOverageUsd: 0.0585 },
  { id: "CG21", case: "R2 storage at exactly 10 GB", metric: "r2StorageBytes", value: 10_000_000_000, recent: null, days: null, now: "2026-10-21T22:07:00Z", overageUsd: 0, projectedOverageUsd: 0 },
  { id: "CG21", case: "Vectorize stored dimensions (Example): $0.0000888, shown floored", metric: "vectorizeStoredDimensions", value: 10_177_536, recent: null, days: null, now: "2026-10-21T02:04:00Z", overageUsd: 0, projectedOverageUsd: 0 },
  { id: "CG21", case: "Vectorize stored dimensions 200 million over", metric: "vectorizeStoredDimensions", value: 210_000_000, recent: null, days: null, now: "2026-10-21T22:07:00Z", overageUsd: 0.1, projectedOverageUsd: 0.1 },
  { id: "CG21", case: "neurons at the sum of this Worker's daily caps: never billed", metric: "workersAiNeurons", value: 8_500, recent: null, days: null, now: "2026-10-21T22:07:00Z", overageUsd: 0, projectedOverageUsd: 0 },
  { id: "CG21", case: "neurons 20,000 today at the Dev tick", metric: "workersAiNeurons", value: 20_000, recent: null, days: null, now: "2026-10-21T22:07:00Z", overageUsd: 0.11, projectedOverageUsd: 3.9907 },
  { id: "CG21", case: "neurons before a quarter of the day: today is not extrapolated", metric: "workersAiNeurons", value: 20_000, recent: null, days: null, now: "2026-10-21T05:59:59Z", overageUsd: 0.11, projectedOverageUsd: 3.41 },
  { id: "CG21", case: "a value that could not be read", metric: "r2ClassA", value: null, recent: null, days: null, now: "2026-10-21T22:07:00Z", overageUsd: null, projectedOverageUsd: null },
  { id: "CG35", case: "real October to date (Example): the incident's dollars are spent, the quiet week adds little", metric: "r2ClassA", value: 2_062_716, recent: 33_676, days: 7, now: "2026-10-21T02:04:00Z", overageUsd: 4.7822, projectedOverageUsd: 5.0184 },
  { id: "CG35", case: "a past burst of 1.23 million with the same quiet week: no longer projected over", metric: "r2ClassA", value: 1_230_000, recent: 33_676, days: 7, now: "2026-10-21T22:07:00Z", overageUsd: 1.035, projectedOverageUsd: 1.2531 },
  { id: "CG35", case: "R2 Class A at the included million: nothing billed yet", metric: "r2ClassA", value: 1_000_000, recent: 33_676, days: 7, now: "2026-10-21T22:07:00Z", overageUsd: 0, projectedOverageUsd: 0.2181 },
  { id: "CG35", case: "the incident on its seventh day (real 10-01..07): projected far over", metric: "r2ClassA", value: 953_503, recent: 953_503, days: 7, now: "2026-10-08T00:00:00Z", overageUsd: 0, projectedOverageUsd: 14.5019 },
  { id: "CG35", case: "November 1 00:30: October's last 7 days give the rate", metric: "r2ClassA", value: 100, recent: 1_400_000, days: 7, now: "2026-11-01T00:30:00Z", overageUsd: 0, projectedOverageUsd: 22.4817 },
  { id: "CG35", case: "February has 28 days", metric: "r2ClassA", value: 1_600_000, recent: 33_676, days: 7, now: "2026-02-15T00:00:00Z", overageUsd: 2.7, projectedOverageUsd: 3.003 },
  { id: "CG35", case: "R2 Class B (Example) under its 10 million", metric: "r2ClassB", value: 269_830, recent: 218_882, days: 7, now: "2026-10-21T02:04:00Z", overageUsd: 0, projectedOverageUsd: 0 },
  { id: "CG35", case: "R2 Class B over its 10 million", metric: "r2ClassB", value: 12_000_000, recent: 2_100_000, days: 7, now: "2026-10-21T22:07:00Z", overageUsd: 0.72, projectedOverageUsd: 1.8084 },
  { id: "CG35", case: "queried dimensions with 3 complete days of history: the rate uses 3", metric: "vectorizeQueriedDimensions", value: 150_000_000, recent: 30_000_000, days: 3, now: "2026-10-21T22:07:00Z", overageUsd: 1, projectedOverageUsd: 2.0078 },
  { id: "CG35", case: "no complete day of history: projects as month to date", metric: "vectorizeQueriedDimensions", value: 150_000_000, recent: 0, days: 0, now: "2026-10-21T22:07:00Z", overageUsd: 1, projectedOverageUsd: 1 },
  { id: "CG35", case: "queried dimensions (Example): no per-day history yet", metric: "vectorizeQueriedDimensions", value: 10_433_536, recent: 0, days: 0, now: "2026-10-21T02:04:00Z", overageUsd: 0, projectedOverageUsd: 0 },
] as const;
