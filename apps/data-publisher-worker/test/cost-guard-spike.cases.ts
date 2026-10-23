/**
 * Spec 026 amendment 2026-10-21, CG23 (Behavior 6b, Decisions 6, 10, 12): the R2 Class A spike of
 * the guard's own bucket. `evaluateSpike` and `nextBreaker` run these rows (test/cost-guard.test.ts).
 *
 * `classA24h` is the guard's own bucket's Class A over the last 24 hours (Dev
 * `oss-knowledge-base-dev`, Prod `oss-knowledge-base-prod`); null when the GraphQL read failed.
 * `tripped` at 50,000 or more (provisional, Decision 12, CG37), whatever the dollars: every row
 * runs with every other metric far under its threshold. `trips` is what a closed breaker then
 * records in `metrics`. 976 is Dev's real 2026-10-20 and 9,300 Prod's real first publication day
 * (2026-10-19); 195,600 is the 2026-10-13 incident's 8,150 an hour.
 */
export const testPlanRows = [
  { id: "CG23", case: "Dev's real day (Example)", classA24h: 976, status: "ok", trips: null },
  { id: "CG23", case: "Prod's real first publication day", classA24h: 9_300, status: "ok", trips: null },
  { id: "CG23", case: "Class A just under the spike threshold", classA24h: 49_999, status: "ok", trips: null },
  { id: "CG23", case: "Class A at the spike threshold: trips with no dollars spent", classA24h: 50_000, status: "tripped", trips: "r2ClassA" },
  { id: "CG23", case: "the 10-13 incident rate (8,150 an hour)", classA24h: 195_600, status: "tripped", trips: "r2ClassA" },
  { id: "CG23", case: "the bucket read failed: no spike trip on missing data", classA24h: null, status: "unavailable", trips: null },
] as const;
