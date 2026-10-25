/**
 * Spec 030: the project activity trend on This week, as data. The response of `/api/activity`
 * becomes the profile chart's input in project mode (`profile-chart.ts`, decision 2 and 3), so the
 * full view is the profile's chart; `compactLayout` is the geometry of the small card.
 */
import type { ProjectActivityV1 } from "@oss-knowledge-base/reference-pipeline/project-activity";
import type { SourceCoverageV1 } from "@oss-knowledge-base/reference-pipeline/people";

import { bucketStart, type ActivityChart, type ChartInput, type ChartSeries } from "./profile-chart";

export type TrendAnswer =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ok"; readonly body: ProjectActivityV1 };

type Recorded = Extract<SourceCoverageV1, { status: "recorded" }>;
const HOUR_MS = 3_600_000;
/** PT15: the Spec 014 lag rule — data older than this says when it was updated. */
export const TREND_LAG_MS = 48 * HOUR_MS;

/** PT11: the card shows only when some series is recorded. */
export function trendVisible(body: ProjectActivityV1): boolean {
  return body.coverage.some((item) => item.status === "recorded");
}

export function recordedCoverage(body: ProjectActivityV1): readonly Recorded[] {
  return body.coverage.filter((item): item is Recorded => item.status === "recorded");
}

/** The response as the profile chart's input: reviews are the `given` series; nothing below the axis. */
export function trendChartInput(body: ProjectActivityV1, nowMs: number): ChartInput {
  const until = body.until ?? new Date(nowMs).toISOString();
  return {
    source: "project",
    period: "12m",
    overTime: body.months.map((month) => ({ label: month.month, given: month.reviews, received: 0, github: month.github, jira: month.jira, mail: month.mail })),
    coverage: body.coverage,
    from: bucketStart(body.months[0]?.month ?? until.slice(0, 7)),
    // The chart's months are the response's (ending with the current month), even when the stores were last updated the month before.
    until: body.months.length === 0 ? until : bucketStart(body.months.at(-1)!.month),
    nowMs,
  };
}

/** `M/D` of an ISO time (UTC), as the profile writes dates. */
export function monthDay(iso: string): string {
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}

/** The current month is in progress up to the stores' update (or now, if earlier). */
export function inProgressDate(body: ProjectActivityV1, nowMs: number): string {
  const now = new Date(nowMs).toISOString();
  return monthDay(body.until === null || body.until > now ? now : body.until);
}

export function trendStale(body: ProjectActivityV1, nowMs: number): boolean {
  return body.until !== null && nowMs - Date.parse(body.until) > TREND_LAG_MS;
}

/**
 * Decision 4: where a later-starting series begins inside the view (the activity log, 9/10 on
 * Dev); the full chart draws a vertical marker there. Undefined when every series starts with the view.
 */
export function coverageMarker(body: ProjectActivityV1): string | undefined {
  const first = body.months[0];
  if (first === undefined) return undefined;
  const starts = recordedCoverage(body).map((item) => item.from).filter((from) => from > bucketStart(first.month));
  return starts.sort()[0];
}

/** "updated" line: `YYYY-MM-DD HH:MM UTC`. */
export function updatedAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export interface YearMark {
  /** The January's bucket index in the view. */
  readonly index: number;
  readonly year: string;
}

/** PT18: each January inside the view; not the first month, whose label already names the year. */
export function yearMarks(labels: readonly string[]): readonly YearMark[] {
  return labels.flatMap((label, index) => (index > 0 && label.endsWith("-01") ? [{ index, year: label.slice(0, 4) }] : []));
}

/** PT17: a `YYYY-MM` bucket with its year: zh-Hant `YYYY/M` (as the page writes dates), English "Nov 2025". */
export function yearMonth(label: string, locale: "zh-Hant" | "en"): string {
  if (locale === "zh-Hant") return `${label.slice(0, 4)}/${Number(label.slice(5, 7))}`;
  return new Intl.DateTimeFormat("en", { year: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${label}-01T00:00:00Z`));
}

/** Spec 030 amendment (1): the compact card's end labels and year markers. */
export function trendAxis(labels: readonly string[], locale: "zh-Hant" | "en"): { readonly first: string; readonly last: string; readonly years: readonly YearMark[] } {
  if (labels.length === 0) return { first: "", last: "", years: [] };
  return { first: yearMonth(labels[0]!, locale), last: yearMonth(labels.at(-1)!, locale), years: yearMarks(labels) };
}

export interface CompactLayout {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  /** Behavior 5: at most 96 px. */
  readonly plotHeight: number;
  readonly zero: number;
  readonly slot: number;
  readonly barWidth: number;
  readonly labelY: number;
  /** PT18: a boundary line left of each January bar (`x`), its year written above the plot at `textY`. */
  readonly years: readonly (YearMark & { readonly x: number; readonly textY: number; readonly anchor: "start" | "end" })[];
  readonly columns: readonly {
    readonly index: number;
    readonly x: number;
    readonly segments: readonly { readonly series: ChartSeries; readonly y: number; readonly height: number; readonly cap: boolean }[];
  }[];
  readonly lanes: readonly { readonly series: ChartSeries; readonly y: number }[];
  readonly laneHeight: number;
}

/**
 * The compact card's geometry: stacked bars scaled to the largest month, no axis, a lane per partly
 * recorded series. A row for the year markers is added above the plot only when a January is inside the view.
 */
export function compactLayout(chart: ActivityChart, width: number): CompactLayout {
  const w = Math.max(240, Math.round(width));
  const left = 2;
  const right = 2;
  const marks = yearMarks(chart.buckets.map((bucket) => bucket.label));
  const top = marks.length === 0 ? 4 : 16;
  const plotHeight = w < 480 ? 64 : 72;
  const n = Math.max(1, chart.buckets.length);
  const slot = (w - left - right) / n;
  const barWidth = Math.max(6, Math.min(30, slot * 0.62));
  const max = Math.max(1, ...chart.buckets.map((bucket) => bucket.up));
  const unit = plotHeight / max;
  const zero = top + plotHeight;
  const columns = chart.buckets.map((bucket, index) => {
    const drawn = chart.up.filter((series) => (bucket.values[series] ?? 0) > 0);
    let above = 0;
    const segments = drawn.map((series) => {
      const value = bucket.values[series]!;
      above += value;
      return { series, y: zero - above * unit, height: value * unit, cap: series === drawn.at(-1) };
    });
    return { index, x: left + slot * index + slot / 2, segments };
  });
  const years = marks.map((mark) => {
    const x = left + slot * mark.index;
    // Written right of the line over the January bar; a January in the last slot writes it to the left.
    return { ...mark, x, textY: 10, anchor: (x + 32 > w - right ? "end" : "start") as "start" | "end" };
  });
  const labelY = zero + 15;
  const laneHeight = 5;
  const laneTop = labelY + 9;
  const lanes = chart.lanes.map((series, index) => ({ series, y: laneTop + index * (laneHeight + 4) }));
  return {
    width: w, height: lanes.length === 0 ? labelY + 4 : laneTop + lanes.length * (laneHeight + 4), left, right, plotHeight, zero, slot, barWidth,
    labelY, years, columns, lanes, laneHeight,
  };
}

