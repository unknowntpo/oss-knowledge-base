/**
 * Spec 005 S18 test plan: the search count line. The single source for the unit tests and for the
 * table in docs/specs/005-evidence-search/spec.md (`bun run docs:test-plan` regenerates it).
 * `exact` and `shown` are counted over the results of the response; `total` is the sum of
 * `facets.projects[].count` (the selected project's count under a project filter), `null` when the
 * response does not give it.
 */
export const testPlanRows = [
  { id: "S18", case: "exact and others, more than the page (Dev, KIP770)", exact: 1, shown: 20, total: 152, en: "1 exact match · showing 20 of 152 matching threads", zh: "1 個精確命中 · 顯示 152 個相符討論中的前 20 個" },
  { id: "S18", case: "several exact and others, more than the page", exact: 2, shown: 20, total: 152, en: "2 exact matches · showing 20 of 152 matching threads", zh: "2 個精確命中 · 顯示 152 個相符討論中的前 20 個" },
  { id: "S18", case: "no exact match, more than the page", exact: 0, shown: 20, total: 152, en: "Showing 20 of 152 matching threads", zh: "顯示 152 個相符討論中的前 20 個" },
  { id: "S18", case: "one more thread than the page", exact: 0, shown: 20, total: 21, en: "Showing 20 of 21 matching threads", zh: "顯示 21 個相符討論中的前 20 個" },
  { id: "S18", case: "exactly the page", exact: 0, shown: 20, total: 20, en: "20 matching threads", zh: "20 個相符的討論" },
  { id: "S18", case: "fewer than the page", exact: 0, shown: 7, total: 7, en: "7 matching threads", zh: "7 個相符的討論" },
  { id: "S18", case: "fewer than the page, exact and others (local fixture, KIP770)", exact: 2, shown: 7, total: 7, en: "2 exact matches · 7 matching threads", zh: "2 個精確命中 · 7 個相符的討論" },
  { id: "S18", case: "fewer than the page, exact and others (Dev, 770)", exact: 1, shown: 2, total: 2, en: "1 exact match · 2 matching threads", zh: "1 個精確命中 · 2 個相符的討論" },
  { id: "S18", case: "one thread", exact: 0, shown: 1, total: 1, en: "1 matching thread", zh: "1 個相符的討論" },
  { id: "S18", case: "every thread is exact", exact: 3, shown: 3, total: 3, en: "3 exact matches", zh: "3 個精確命中" },
  { id: "S18", case: "the one thread is exact", exact: 1, shown: 1, total: 1, en: "1 exact match", zh: "1 個精確命中" },
  { id: "S18", case: "a full page of exact matches: how many more are exact is unknown", exact: 20, shown: 20, total: 152, en: "Showing 20 of 152 matching threads", zh: "顯示 152 個相符討論中的前 20 個" },
  { id: "S18", case: "zero results", exact: 0, shown: 0, total: 0, en: "No matching threads", zh: "沒有相符的討論" },
  { id: "S18", case: "total not in the response", exact: 0, shown: 20, total: null, en: "Showing 20 matching threads", zh: "顯示 20 個相符的討論" },
  { id: "S18", case: "total not in the response, exact and others", exact: 1, shown: 20, total: null, en: "1 exact match · showing 20 matching threads", zh: "1 個精確命中 · 顯示 20 個相符的討論" },
  { id: "S18", case: "a total below the shown count is not used", exact: 0, shown: 20, total: 5, en: "Showing 20 matching threads", zh: "顯示 20 個相符的討論" },
] as const;
