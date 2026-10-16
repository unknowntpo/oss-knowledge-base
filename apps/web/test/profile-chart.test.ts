/**
 * Spec 019 amendment (5), W57–W60: the chart model and its geometry, over the rows of
 * `profile-chart.cases.ts`.
 */
import { describe, expect, test } from "bun:test";

import { activityChart, chartLayout, niceStep, type ActivityChart } from "../src/profile-chart";
import { fixtures, testPlanRows } from "./profile-chart.cases";

function describeChart(chart: ActivityChart) {
  const buckets = chart.buckets;
  const runs = (indexes: readonly number[]) => {
    const parts: string[] = [];
    for (let i = 0; i < indexes.length; i += 1) {
      let j = i;
      while (j + 1 < indexes.length && indexes[j + 1] === indexes[j]! + 1) j += 1;
      parts.push(`${buckets[indexes[i]!]!.label} – ${buckets[indexes[j]!]!.label}`);
      i = j;
    }
    return parts.length === 0 ? null : parts.join(", ");
  };
  return {
    columns: `${buckets.length}: ${buckets[0]!.label} … ${buckets[buckets.length - 1]!.label}`,
    series: `${chart.up.join(" + ")} / ${chart.down.length === 0 ? "—" : chart.down.join(" + ")}`,
    scale: `${chart.scale.step}, ${chart.scale.top}, ${chart.scale.bottom}`,
    band: runs(buckets.flatMap((bucket, index) => (bucket.unrecorded ? [index] : []))),
    lanes: chart.lanes.length === 0 ? null : chart.lanes.join(", "),
    partial: buckets.flatMap((bucket) => bucket.partial.map((item) => `${bucket.label} ${item.series} from ${item.from.slice(0, 10)}`)).join(", ") || null,
    clipped: buckets.filter((bucket) => bucket.clipped).map((bucket) => bucket.label).join(", ") || null,
    peak: chart.peak === undefined ? null : `${chart.peak.label} ${chart.peak.up}`,
  };
}

describe("Spec 019 amendment (5): chart model", () => {
  test.each(testPlanRows)("$id: $case", (row) => {
    const chart = activityChart(fixtures[row.fixture]!);
    const { id: _id, case: _case, data: _data, fixture: _fixture, ...expected } = row;
    expect(describeChart(chart)).toEqual(expected);
  });

  test("W60: a value not recorded is null, never 0, and is not part of any total", () => {
    const chart = activityChart(fixtures["github-12m"]!);
    const august = chart.buckets.find((bucket) => bucket.label === "2026-08")!;
    expect(august.values).toEqual({ given: 6, github: null, received: 30 });
    expect(august.up).toBe(6);
    const september = chart.buckets.find((bucket) => bucket.label === "2026-09")!;
    expect(september.values).toEqual({ given: 10, github: 3, received: 13 });
    // Positive control: a recorded 0 stays 0.
    expect(activityChart(fixtures["github-zeros"]!).buckets.at(-1)!.values).toEqual({ given: 0, github: 0, received: 0 });
    const mail = activityChart(fixtures["mail-12m"]!);
    expect(mail.buckets[0]!.values).toEqual({ mail: null });
    expect(mail.buckets.filter((bucket) => bucket.unrecorded)).toHaveLength(10);
  });

  test("W58: no series of another source appears, whatever the rows carry", () => {
    const jira = activityChart(fixtures["jira-12m"]!);
    expect(jira.buckets.flatMap((bucket) => Object.keys(bucket.values))).toEqual(Array(12).fill("jira"));
  });

  test("W59: the step is 1, 2 or 5 × 10^k, at most three steps up to the maximum", () => {
    expect([0, 1, 2, 3, 4, 6, 9, 13, 30, 31, 61, 150, 999].map((max) => niceStep(max))).toEqual([1, 1, 1, 1, 2, 2, 5, 5, 10, 20, 50, 50, 500]);
  });

  test("W59: every segment is value × unit tall from the zero line, stacks touch, and up and down share the unit", () => {
    for (const [name, width] of [["github-12m", 900], ["github-90d", 320], ["mail-12m", 375]] as const) {
      const chart = activityChart(fixtures[name]!);
      const layout = chartLayout(chart, width);
      expect(layout.unit * (chart.scale.top + chart.scale.bottom)).toBeCloseTo(width < 480 ? 170 : 200, 6);
      for (const column of layout.columns) {
        const bucket = chart.buckets[column.index]!;
        const up = column.segments.filter((segment) => chart.up.includes(segment.series));
        const down = column.segments.filter((segment) => chart.down.includes(segment.series));
        let edge = layout.zero;
        for (const segment of up) {
          expect(segment.height).toBeCloseTo(bucket.values[segment.series]! * layout.unit, 6);
          expect(segment.y + segment.height).toBeCloseTo(edge, 6);
          edge = segment.y;
        }
        expect(layout.zero - column.upTop).toBeCloseTo(bucket.up * layout.unit, 6);
        edge = layout.zero;
        for (const segment of down) {
          expect(segment.y).toBeCloseTo(edge, 6);
          expect(segment.height).toBeCloseTo(bucket.values[segment.series]! * layout.unit, 6);
          edge = segment.y + segment.height;
        }
        expect(column.x - layout.slot / 2).toBeGreaterThanOrEqual(layout.left - 1e-6);
        expect(column.x + layout.slot / 2).toBeLessThanOrEqual(layout.width - layout.right + 1e-6);
      }
      // The ticks are the scale's multiples, 0 at the zero line.
      expect(layout.ticks.find((tick) => tick.value === 0)!.y).toBe(layout.zero);
    }
  });

  test("W60: unrecorded buckets become one band; the newest bucket always has its label", () => {
    const layout = chartLayout(activityChart(fixtures["mail-12m"]!), 320);
    expect(layout.bands.map((band) => [band.first, band.last])).toEqual([[0, 9]]);
    expect(layout.labelled.at(-1)).toBe(11);
    expect(layout.labelled.length).toBeLessThan(12);
    expect(chartLayout(activityChart(fixtures["github-12m"]!), 900).labelled).toHaveLength(12);
  });
});
