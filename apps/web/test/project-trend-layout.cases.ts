/**
 * Spec 030 amendment (1) test plan: the compact card's marker row geometry, the single source for
 * `project-trend-layout.test.ts` and the table in docs/specs/030-project-activity-trend/spec.md
 * (`bun run docs:test-plan` regenerates it).
 *
 * Columns: the view's months `from` … `to` at `width` px; `top` the plot's top offset (16 with a
 * marker row, 4 without); `marks` each year marker as `YYYY at slot N, anchor`, the line on the
 * slot's left edge (— when none).
 */
export const testPlanRows = [
  { id: "PT18", case: "a year boundary adds the marker row above the plot", from: "2025-11", to: "2026-10", width: 343, top: 16, marks: "2026 at slot 2, start" },
  { id: "PT18", case: "a view within one year keeps the 4 px top", from: "2026-03", to: "2026-10", width: 343, top: 4, marks: null },
  { id: "PT18", case: "January as the first month: no row, 4 px top", from: "2026-01", to: "2026-12", width: 343, top: 4, marks: null },
  { id: "PT17", case: "a January in the last slot writes its year left of the line, inside the card", from: "2025-02", to: "2026-01", width: 343, top: 16, marks: "2026 at slot 11, end" },
] as const;
