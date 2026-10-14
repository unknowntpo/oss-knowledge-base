/**
 * Spec 010 test plan: the single source for the unit tests and for the table in
 * docs/specs/010-feed-freshness/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * `generatedAt` is a daily publication (Spec 018: 22:07 UTC). The stale boundary is
 * `STALE_AFTER_MS`: one day plus three hours of grace. Between 24 h 30 min and that boundary
 * the text is Spec 021's overdue warning; it is not stale.
 */
export const testPlanRows = [
  { id: "F1", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-14T00:07:00Z", en: "Updated 2 h ago", zh: "資料更新於 2 小時前", stale: false },
  { id: "F1", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-13T22:35:24Z", en: "Updated 28 min ago", zh: "資料更新於 28 分鐘前", stale: false },
  { id: "F1", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-13T22:52:00Z", en: "Updated 45 min ago", zh: "資料更新於 45 分鐘前", stale: false },
  { id: "F1", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-13T23:07:00Z", en: "Updated 1 h ago", zh: "資料更新於 1 小時前", stale: false },
  { id: "F1", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-13T23:52:00Z", en: "Updated 1 h ago", zh: "資料更新於 1 小時前", stale: false },
  { id: "F2", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-14T01:07:01Z", en: "Updated 3 h ago", zh: "資料更新於 3 小時前", stale: false },
  { id: "F2", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-14T22:06:59Z", en: "Updated 23 h ago", zh: "資料更新於 23 小時前", stale: false },
  { id: "F2", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-14T22:17:00Z", en: "Updated 24 h ago", zh: "資料更新於 24 小時前", stale: false },
  { id: "F2", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-15T01:06:30Z", en: "Daily update late · 26 h ago", zh: "今日更新尚未完成 · 26 小時前", stale: false },
  { id: "F2", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-15T01:07:00Z", en: "Daily update late · 27 h ago", zh: "今日更新尚未完成 · 27 小時前", stale: false },
  { id: "F2", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-15T01:07:01Z", en: "Data may be out of date · 27 h ago", zh: "資料可能過期 · 27 小時前", stale: true },
  { id: "F7", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-15T22:06:59Z", en: "Data may be out of date · 47 h ago", zh: "資料可能過期 · 47 小時前", stale: true },
  { id: "F7", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-15T22:07:00Z", en: "Data may be out of date · 2 d ago", zh: "資料可能過期 · 2 天前", stale: true },
  { id: "F7", generatedAt: "2026-10-13T22:07:00Z", now: "2026-10-20T23:00:00Z", en: "Data may be out of date · 7 d ago", zh: "資料可能過期 · 7 天前", stale: true },
  { id: "F4", generatedAt: "not-a-time", now: "2026-10-14T00:07:00Z", en: null, zh: null, stale: null },
  { id: "F4", generatedAt: 0, now: "2026-10-14T00:07:00Z", en: null, zh: null, stale: null },
  { id: "F5", generatedAt: "2026-10-13T22:08:00Z", now: "2026-10-13T22:07:00Z", en: "Updated just now", zh: "資料剛剛更新", stale: false },
] as const;
