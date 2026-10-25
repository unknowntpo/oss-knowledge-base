/**
 * Spec 030 amendment (1) test plan: the compact card's axis, the single source for
 * `project-trend-axis.test.ts` and the table in docs/specs/030-project-activity-trend/spec.md
 * (`bun run docs:test-plan` regenerates it).
 *
 * Columns: the view's months `from` … `to` (inclusive, one bar each); `first` and `last` the end
 * labels in `locale`; `years` the year markers as `YYYY at YYYY-MM` (— when none).
 */
export const testPlanRows = [
  { id: "PT17", case: "Dev's view across a year boundary: both ends name their year", locale: "zh-Hant", from: "2025-11", to: "2026-10", first: "2025/11", last: "2026/10", years: "2026 at 2026-01" },
  { id: "PT17", case: "the same view in English", locale: "en", from: "2025-11", to: "2026-10", first: "Nov 2025", last: "Oct 2026", years: "2026 at 2026-01" },
  { id: "PT18", case: "a view within one year has no marker", locale: "zh-Hant", from: "2026-03", to: "2026-10", first: "2026/3", last: "2026/10", years: null },
  { id: "PT18", case: "January as the first month: its label already names the year, no marker", locale: "en", from: "2026-01", to: "2026-12", first: "Jan 2026", last: "Dec 2026", years: null },
  { id: "PT18", case: "a January as the second month gets a marker", locale: "zh-Hant", from: "2025-12", to: "2026-11", first: "2025/12", last: "2026/11", years: "2026 at 2026-01" },
  { id: "PT18", case: "every January inside the view gets a marker", locale: "en", from: "2025-12", to: "2027-01", first: "Dec 2025", last: "Jan 2027", years: "2026 at 2026-01; 2027 at 2027-01" },
] as const;
