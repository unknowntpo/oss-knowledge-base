/** Spec 030 amendment (1): the compact card's marker row sits above the plot and inside the card. */
import { describe, expect, test } from "bun:test";

import type { ActivityChart } from "../src/profile-chart";
import { compactLayout } from "../src/project-trend";
import { testPlanRows } from "./project-trend-layout.cases";

function months(from: string, to: string): string[] {
  const out: string[] = [];
  let [year, month] = from.split("-").map(Number) as [number, number];
  for (;;) {
    const label = `${year}-${String(month).padStart(2, "0")}`;
    if (label > to) return out;
    out.push(label);
    month += 1;
    if (month > 12) { year += 1; month = 1; }
  }
}

/** One series, every month at 1 except the busiest at the January boundary, so a misplaced year row would hit a bar. */
function chart(labels: readonly string[]): ActivityChart {
  const buckets = labels.map((label) => ({ label, up: label.endsWith("-01") || label.endsWith("-12") ? 9 : 1, values: { "github-reviews": label.endsWith("-01") || label.endsWith("-12") ? 9 : 1 } }));
  return { buckets, up: ["github-reviews"], lanes: [] } as unknown as ActivityChart;
}

describe("Spec 030 amendment (1): the compact card's marker row", () => {
  test("the helper builds the view it is given (positive control)", () => {
    expect(months("2025-02", "2026-01")).toHaveLength(12);
  });
  test.each(testPlanRows)("$id: $case", (row) => {
    const labels = months(row.from, row.to);
    const layout = compactLayout(chart(labels), row.width);
    expect(layout.zero - layout.plotHeight).toBe(row.top);
    const marks = layout.years.map((mark) => {
      expect(mark.x).toBeCloseTo(layout.left + layout.slot * mark.index, 6);
      // The year's baseline sits in the marker row, above the tallest bar.
      expect(mark.textY).toBeLessThan(row.top);
      // An end-anchored year ends at the line; a start-anchored one fits about 32 px before the right edge.
      if (mark.anchor === "start") expect(mark.x + 32).toBeLessThanOrEqual(layout.width - layout.right);
      return `${mark.year} at slot ${mark.index}, ${mark.anchor}`;
    });
    expect(marks.length === 0 ? null : marks.join("; ")).toBe(row.marks);
  });
});
