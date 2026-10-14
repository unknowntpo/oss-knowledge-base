/**
 * Spec 021 test plan: the single source for the unit tests and for the table in
 * docs/specs/021-publication-overdue/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * `generatedAt` values are real releases: Dev 2026-10-13T22:07:09Z (Cron `7 22 * * *`) and the
 * Prod bootstrap snapshot. The next run is expected one cadence (24 h) after `generatedAt`;
 * the page waits `PUBLICATION_ALLOWANCE_MS` (30 min) more before it says the update is overdue.
 */
export const testPlanRows = [
  { id: "O1", case: "one second before the next run is expected", generatedAt: "2026-10-13T22:07:09Z", now: "2026-10-14T22:07:08Z", en: "Updated 23 h ago", zh: "資料更新於 23 小時前", state: "fresh" },
  { id: "O1", case: "the next run starts", generatedAt: "2026-10-13T22:07:09Z", now: "2026-10-14T22:07:09Z", en: "Updated 24 h ago", zh: "資料更新於 24 小時前", state: "fresh" },
  { id: "O1", case: "the run is at its 15-minute limit", generatedAt: "2026-10-13T22:07:09Z", now: "2026-10-14T22:22:09Z", en: "Updated 24 h ago", zh: "資料更新於 24 小時前", state: "fresh" },
  { id: "O1", case: "exactly the allowance", generatedAt: "2026-10-13T22:07:09Z", now: "2026-10-14T22:37:09Z", en: "Updated 24 h ago", zh: "資料更新於 24 小時前", state: "fresh" },
  { id: "O2", case: "one second past the allowance", generatedAt: "2026-10-13T22:07:09Z", now: "2026-10-14T22:37:10Z", en: "Daily feed late · 24 h ago", zh: "今日更新尚未完成 · 24 小時前", state: "overdue" },
  { id: "O2", case: "the second retry is waiting", generatedAt: "2026-10-13T22:07:09Z", now: "2026-10-14T23:30:00Z", en: "Daily feed late · 25 h ago", zh: "今日更新尚未完成 · 25 小時前", state: "overdue" },
  { id: "O2", case: "exactly 27 h", generatedAt: "2026-10-13T22:07:09Z", now: "2026-10-15T01:07:09Z", en: "Daily feed late · 27 h ago", zh: "今日更新尚未完成 · 27 小時前", state: "overdue" },
  { id: "O3", case: "27 h 1 s: stale, as before", generatedAt: "2026-10-13T22:07:09Z", now: "2026-10-15T01:07:10Z", en: "Data may be out of date · 27 h ago", zh: "資料可能過期 · 27 小時前", state: "stale" },
  { id: "O3", case: "the Prod bootstrap snapshot today", generatedAt: "2026-08-25T08:29:41.122Z", now: "2026-10-14T01:43:30Z", en: "Data may be out of date · 49 d ago", zh: "資料可能過期 · 49 天前", state: "stale" },
  { id: "O4", case: "Prod's Cron minute (22:37), at the allowance", generatedAt: "2026-10-13T22:37:00Z", now: "2026-10-14T23:07:00Z", en: "Updated 24 h ago", zh: "資料更新於 24 小時前", state: "fresh" },
  { id: "O4", case: "Prod's Cron minute (22:37), one second past", generatedAt: "2026-10-13T22:37:00Z", now: "2026-10-14T23:07:01Z", en: "Daily feed late · 24 h ago", zh: "今日更新尚未完成 · 24 小時前", state: "overdue" },
  { id: "O5", case: "release from a catch-up run at 22:12: counted from that release", generatedAt: "2026-10-13T22:12:09Z", now: "2026-10-14T22:42:09Z", en: "Updated 24 h ago", zh: "資料更新於 24 小時前", state: "fresh" },
  { id: "O5", case: "release from a catch-up run at 22:12, one second past", generatedAt: "2026-10-13T22:12:09Z", now: "2026-10-14T22:42:10Z", en: "Daily feed late · 24 h ago", zh: "今日更新尚未完成 · 24 小時前", state: "overdue" },
] as const;
