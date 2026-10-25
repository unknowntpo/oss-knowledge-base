/** Spec 030 amendment (1): the compact card's end labels with years and the January year markers. */
import { describe, expect, test } from "bun:test";

import { trendAxis } from "../src/project-trend";
import { testPlanRows } from "./project-trend-axis.cases";

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

describe("Spec 030 amendment (1): the compact axis", () => {
  test("the month helper builds the view it is given (positive control)", () => {
    expect(months("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
  test.each(testPlanRows)("$id: $case", (row) => {
    const labels = months(row.from, row.to);
    const axis = trendAxis(labels, row.locale);
    expect(axis.first).toBe(row.first);
    expect(axis.last).toBe(row.last);
    const years = axis.years.map((mark) => `${mark.year} at ${labels[mark.index]}`).join("; ");
    expect(years === "" ? null : years).toBe(row.years);
  });
});
