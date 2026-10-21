/**
 * Spec 026 amendment 2026-10-21 (dollar budget), CG22 and CG23: the budget's status from the
 * summed overage, and the R2 Class A spike rule. Planned slice: no test runs these rows yet (the
 * spec's marker is `[pending]`); the implementing slice adds `test.each(testPlanRows)`.
 *
 * Budget $5 a month. `percent` = overageUsd / 5 × 100, `projectedPercent` likewise, floored to
 * 0.01 for display; comparisons use exact values. Trips: `budget` when percent ≥ 80 or
 * projectedPercent > 100; `r2ClassA` when the OSS KB buckets' Class A over the last 24 hours is
 * 50,000 or more. Status: `tripped` when anything trips, else `warn` when percent ≥ 60, else `ok`.
 * `classA24h` 1,483 is Dev 824 + Prod 659 from the 2026-10-20 publications.
 */
export const testPlanRows = [
  { id: "CG22", case: "just under warn", overageUsd: 2.9999, projectedOverageUsd: 4.9, classA24h: 1_483, percent: 59.99, projectedPercent: 98, status: "ok", trips: null },
  { id: "CG22", case: "$3 spent: warn", overageUsd: 3, projectedOverageUsd: 4.9, classA24h: 1_483, percent: 60, projectedPercent: 98, status: "warn", trips: null },
  { id: "CG22", case: "just under $4, no projection yet", overageUsd: 3.9999, projectedOverageUsd: null, classA24h: 1_483, percent: 79.99, projectedPercent: null, status: "warn", trips: null },
  { id: "CG22", case: "$4 spent: trip", overageUsd: 4, projectedOverageUsd: null, classA24h: 1_483, percent: 80, projectedPercent: null, status: "tripped", trips: "budget" },
  { id: "CG22", case: "projected exactly $5: not over", overageUsd: 1, projectedOverageUsd: 5, classA24h: 1_483, percent: 20, projectedPercent: 100, status: "ok", trips: null },
  { id: "CG22", case: "projected just over $5 (shown floored)", overageUsd: 1, projectedOverageUsd: 5.0001, classA24h: 1_483, percent: 20, projectedPercent: 100, status: "tripped", trips: "budget" },
  { id: "CG22", case: "today's account (Example)", overageUsd: 1.0935, projectedOverageUsd: 3.7599, classA24h: 1_483, percent: 21.87, projectedPercent: 75.19, status: "ok", trips: null },
  { id: "CG22", case: "nothing over any allowance", overageUsd: 0, projectedOverageUsd: 0, classA24h: 1_483, percent: 0, projectedPercent: 0, status: "ok", trips: null },
  { id: "CG23", case: "Class A just under the spike threshold", overageUsd: 0, projectedOverageUsd: 0, classA24h: 49_999, percent: 0, projectedPercent: 0, status: "ok", trips: null },
  { id: "CG23", case: "Class A at the spike threshold: trips with no dollars spent", overageUsd: 0, projectedOverageUsd: 0, classA24h: 50_000, percent: 0, projectedPercent: 0, status: "tripped", trips: "r2ClassA" },
  { id: "CG23", case: "the 10-13 incident rate (8,150 an hour)", overageUsd: 0, projectedOverageUsd: 0, classA24h: 195_600, percent: 0, projectedPercent: 0, status: "tripped", trips: "r2ClassA" },
  { id: "CG23", case: "budget and spike together", overageUsd: 4, projectedOverageUsd: null, classA24h: 60_000, percent: 80, projectedPercent: null, status: "tripped", trips: "budget, r2ClassA" },
  { id: "CG23", case: "the bucket read failed: no spike trip on missing data", overageUsd: 0, projectedOverageUsd: 0, classA24h: null, percent: 0, projectedPercent: 0, status: "ok", trips: null },
] as const;
