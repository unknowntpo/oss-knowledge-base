/**
 * Spec 010 test plan: the single source for the unit tests and for the table in
 * docs/specs/010-feed-freshness/spec.md (`bun run docs:test-plan` regenerates it).
 */
export const testPlanRows = [
  { id: "F1", generatedAt: "2026-10-03T23:07:13Z", now: "2026-10-04T01:07:13Z", en: "Updated 2 h ago", zh: "資料更新於 2 小時前", stale: false },
  { id: "F1", generatedAt: "2026-10-03T23:07:13Z", now: "2026-10-03T23:35:37Z", en: "Updated 28 min ago", zh: "資料更新於 28 分鐘前", stale: false },
  { id: "F1", generatedAt: "2026-10-03T23:07:13Z", now: "2026-10-03T23:52:13Z", en: "Updated 45 min ago", zh: "資料更新於 45 分鐘前", stale: false },
  { id: "F1", generatedAt: "2026-10-03T23:07:13Z", now: "2026-10-04T00:07:13Z", en: "Updated 1 h ago", zh: "資料更新於 1 小時前", stale: false },
  { id: "F1", generatedAt: "2026-10-03T23:07:13Z", now: "2026-10-04T00:52:13Z", en: "Updated 1 h ago", zh: "資料更新於 1 小時前", stale: false },
  { id: "F2", generatedAt: "2026-10-03T23:07:13Z", now: "2026-10-04T02:07:13Z", en: "Updated 3 h ago", zh: "資料更新於 3 小時前", stale: false },
  { id: "F2", generatedAt: "2026-10-03T23:07:13Z", now: "2026-10-04T02:07:14Z", en: "Data may be out of date · 3 h ago", zh: "資料可能過期 · 3 小時前", stale: true },
  { id: "F4", generatedAt: "not-a-time", now: "2026-10-04T01:07:13Z", en: null, zh: null, stale: null },
  { id: "F4", generatedAt: 0, now: "2026-10-04T01:07:13Z", en: null, zh: null, stale: null },
  { id: "F5", generatedAt: "2026-10-03T23:08:13Z", now: "2026-10-03T23:07:13Z", en: "Updated just now", zh: "資料剛剛更新", stale: false },
] as const;
