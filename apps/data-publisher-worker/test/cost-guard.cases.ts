/**
 * Spec 026 test plan: what `evaluateMetric` says about one metric (CG2). The single source for the
 * unit tests and for the table in docs/specs/026-cost-guard/spec.md (`bun run docs:test-plan`
 * regenerates it).
 *
 * A metric is `ok` at any level (its dollars count in the budget, test/cost-guard-budget.cases.ts)
 * and `unavailable` when it could not be read. `rateDays` is the complete days a month counter's
 * projection used; null for gauges, neurons and an unread value.
 */
export const testPlanRows = [
  { id: "CG2", case: "R2 storage 15.81 GB (Prod, 2026-11-05): past its allowance, still ok", metric: "r2StorageBytes", value: 15_809_369_665, recent: null, days: null, now: "2026-11-05T00:55:00Z", status: "ok", rateDays: null },
  { id: "CG2", case: "Vectorize stored dimensions at 110.86 % (Prod, 2026-11-05): ok", metric: "vectorizeStoredDimensions", value: 11_086_848, recent: null, days: null, now: "2026-11-05T00:55:00Z", status: "ok", rateDays: null },
  { id: "CG2", case: "R2 Class A past its allowance (real October): ok, the budget judges it", metric: "r2ClassA", value: 2_062_716, recent: 33_676, days: 7, now: "2026-10-21T02:04:00Z", status: "ok", rateDays: 7 },
  { id: "CG2", case: "R2 Class B: a month counter with 7 days of history", metric: "r2ClassB", value: 269_830, recent: 218_882, days: 7, now: "2026-10-21T02:04:00Z", status: "ok", rateDays: 7 },
  { id: "CG2", case: "queried dimensions with no complete day of history", metric: "vectorizeQueriedDimensions", value: 11_105_280, recent: 0, days: 0, now: "2026-11-05T00:55:00Z", status: "ok", rateDays: 0 },
  { id: "CG2", case: "queried dimensions with 3 complete days", metric: "vectorizeQueriedDimensions", value: 15_000_000, recent: 3_000_000, days: 3, now: "2026-10-21T22:07:00Z", status: "ok", rateDays: 3 },
  { id: "CG2", case: "neurons past the day's allowance: ok", metric: "workersAiNeurons", value: 20_000, recent: null, days: null, now: "2026-10-21T22:07:00Z", status: "ok", rateDays: null },
  { id: "CG2", case: "a value that could not be read", metric: "r2ClassA", value: null, recent: null, days: null, now: "2026-10-20T22:07:00Z", status: "unavailable", rateDays: null },
] as const;
