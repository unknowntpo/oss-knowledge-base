/**
 * Spec 026 amendment 2026-10-21 (dollar budget), CG22 and CG34: the budget's status from the
 * summed overage, with the R2 Class A spike rule (CG23, implemented in
 * test/cost-guard-spike.cases.ts) as an input. Planned slice: no test runs these rows yet (the
 * spec's marker is `[pending]`); the implementing slice adds `test.each(testPlanRows)`.
 *
 * Budget $5 a month. `percent` = overageUsd / 5 × 100, `projectedPercent` likewise, floored to
 * 0.01 for display; comparisons use exact values. Trips: `budget` when percent ≥ 80 or
 * projectedPercent > 100; `r2ClassA` when the guard's own bucket (Dev `oss-knowledge-base-dev`,
 * Prod `oss-knowledge-base-prod`) has 50,000 or more Class A over the last 24 hours. Status:
 * `tripped` when anything trips, else `warn` when percent ≥ 60 or projectedPercent ≥ 60 (CG34),
 * else `ok`. `classA24h` 976 is Dev's real 2026-10-20.
 */
export const testPlanRows = [
  { id: "CG22", case: "just under warn", overageUsd: 2.9999, projectedOverageUsd: 2.9999, classA24h: 976, percent: 59.99, projectedPercent: 59.99, status: "ok", trips: null },
  { id: "CG22", case: "$3 spent: warn", overageUsd: 3, projectedOverageUsd: 3, classA24h: 976, percent: 60, projectedPercent: 60, status: "warn", trips: null },
  { id: "CG22", case: "just under $4", overageUsd: 3.9999, projectedOverageUsd: 4.9, classA24h: 976, percent: 79.99, projectedPercent: 98, status: "warn", trips: null },
  { id: "CG22", case: "$4 spent: trip", overageUsd: 4, projectedOverageUsd: 4.9, classA24h: 976, percent: 80, projectedPercent: 98, status: "tripped", trips: "budget" },
  { id: "CG22", case: "projected exactly $5: not over, warns", overageUsd: 1, projectedOverageUsd: 5, classA24h: 976, percent: 20, projectedPercent: 100, status: "warn", trips: null },
  { id: "CG22", case: "projected just over $5 (shown floored)", overageUsd: 1, projectedOverageUsd: 5.0001, classA24h: 976, percent: 20, projectedPercent: 100, status: "tripped", trips: "budget" },
  { id: "CG22", case: "real October (Example): the spent dollars alone trip", overageUsd: 4.8408, projectedOverageUsd: 5.077, classA24h: 976, percent: 96.81, projectedPercent: 101.54, status: "tripped", trips: "budget" },
  { id: "CG22", case: "a past 1.23 million burst with a quiet week", overageUsd: 1.0935, projectedOverageUsd: 1.3117, classA24h: 976, percent: 21.87, projectedPercent: 26.23, status: "ok", trips: null },
  { id: "CG22", case: "nothing over any allowance", overageUsd: 0, projectedOverageUsd: 0, classA24h: 976, percent: 0, projectedPercent: 0, status: "ok", trips: null },
  { id: "CG34", case: "projection just under 60 %", overageUsd: 1, projectedOverageUsd: 2.9999, classA24h: 976, percent: 20, projectedPercent: 59.99, status: "ok", trips: null },
  { id: "CG34", case: "projection at 60 %: warn, no trip", overageUsd: 1, projectedOverageUsd: 3, classA24h: 976, percent: 20, projectedPercent: 60, status: "warn", trips: null },
  { id: "CG34", case: "nothing spent yet, projection at 60 %", overageUsd: 0, projectedOverageUsd: 3, classA24h: 976, percent: 0, projectedPercent: 60, status: "warn", trips: null },
  { id: "CG22", case: "budget and spike together (the spike alone is CG23, test/cost-guard-spike.cases.ts)", overageUsd: 4, projectedOverageUsd: 4.9, classA24h: 60_000, percent: 80, projectedPercent: 98, status: "tripped", trips: "budget, r2ClassA" },
] as const;
