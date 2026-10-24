/**
 * Spec 019 amendment (5), W57–W60: the profile's "activity over time" chart as data. Pure: the
 * input is what the page already has (`profileView(...).overTime` and the response's `coverage`),
 * so the chart costs no request (W65). `PersonActivityChart.vue` draws `chartLayout`'s geometry.
 */
import type { PeopleSource, ProfilePeriod, SourceCoverageV1 } from "@oss-knowledge-base/reference-pipeline/people";

export type ChartSeries = "given" | "github" | "jira" | "mail" | "received";
export type IdentitySource = "github" | "jira" | "mail";
/** Spec 030: a project's series instead of an identity's (the trend on This week). */
export type ChartSource = IdentitySource | "project";

/**
 * One `overTime` row: review counts always, an activity-log source only where it is recorded.
 * Spec 030: a project row has `null` where a month was not recorded or could not be read.
 */
export interface OverTimeRow {
  readonly label: string;
  readonly given: number | null;
  readonly received: number;
  readonly github?: number | null;
  readonly jira?: number | null;
  readonly mail?: number | null;
}

export interface ChartInput {
  readonly source: ChartSource;
  readonly period: ProfilePeriod;
  readonly overTime: readonly OverTimeRow[];
  readonly coverage: readonly SourceCoverageV1[];
  /** The selected period's start (`profileView(...).from`). */
  readonly from: string;
  readonly until: string;
  readonly nowMs: number;
}

export interface ChartBucket {
  readonly label: string;
  /** `null`: the series is not recorded for this bucket (never drawn or written as 0, W60). */
  readonly values: Readonly<Partial<Record<ChartSeries, number | null>>>;
  readonly up: number;
  readonly down: number;
  /** None of the person's own series is recorded: part of a "not recorded yet" band. */
  readonly unrecorded: boolean;
  /** Series whose coverage starts inside this bucket, with that start. */
  readonly partial: readonly { readonly series: ChartSeries; readonly from: string }[];
  /** The bucket starts before the selected period (the first week of the 90-day view). */
  readonly clipped: boolean;
}

export interface ActivityChart {
  readonly period: ProfilePeriod;
  readonly up: readonly ChartSeries[];
  readonly down: readonly ChartSeries[];
  readonly buckets: readonly ChartBucket[];
  /** Own series not recorded in some buckets where another own series is: drawn as a coverage lane. */
  readonly lanes: readonly ChartSeries[];
  readonly scale: { readonly step: number; readonly top: number; readonly bottom: number };
  /** The bucket with the largest own total (the first of equals), for the text alternative. */
  readonly peak: ChartBucket | undefined;
}

const DAY_MS = 86_400_000;

/**
 * W58: strict identity — a page shows its own source's series only. Spec 030 decisions 2 and 3: a
 * project stacks reviews, GitHub, Jira and dev@ upward, with no down series (given equals received).
 */
export function chartSeries(source: ChartSource): { readonly up: readonly ChartSeries[]; readonly down: readonly ChartSeries[] } {
  if (source === "project") return { up: ["given", "github", "jira", "mail"], down: [] };
  return source === "github" ? { up: ["given", "github"], down: ["received"] } : { up: [source], down: [] };
}

/** The coverage source behind a series. */
export function coverageSource(series: ChartSeries): PeopleSource {
  return series === "given" || series === "received" ? "github-reviews" : series;
}

function weekStart(ms: number): string {
  const day = new Date(ms);
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - offset)).toISOString().slice(0, 10);
}

/** W57: 12 months ending with the month of `until`, or the weeks from the week of now − 90 days to `until`. */
export function chartLabels(period: ProfilePeriod, until: string, nowMs: number): string[] {
  const end = Date.parse(until);
  const labels: string[] = [];
  if (period === "12m") {
    const last = new Date(end);
    for (let back = 11; back >= 0; back -= 1) labels.push(new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - back, 1)).toISOString().slice(0, 7));
    return labels;
  }
  for (let week = Date.parse(weekStart(nowMs - 90 * DAY_MS)); week <= Math.max(end, nowMs - 90 * DAY_MS); week += 7 * DAY_MS) labels.push(weekStart(week));
  return labels;
}

export function bucketStart(label: string): string {
  return label.length === 7 ? `${label}-01T00:00:00.000Z` : `${label}T00:00:00.000Z`;
}

export function bucketEnd(label: string): string {
  return label.length === 7
    ? new Date(Date.UTC(Number(label.slice(0, 4)), Number(label.slice(5, 7)), 1) - 1).toISOString()
    : new Date(Date.parse(bucketStart(label)) + 7 * DAY_MS - 1).toISOString();
}

/** W59: a step of 1, 2 or 5 × 10^k giving at most `ticks` steps up to `max`. */
export function niceStep(max: number, ticks = 3): number {
  const raw = Math.max(1, max) / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const multiple of [1, 2, 5, 10]) if (multiple * power >= raw) return Math.max(1, multiple * power);
  return 10 * power;
}

export function activityChart(input: ChartInput): ActivityChart {
  const { up, down } = chartSeries(input.source);
  const recorded = new Map(input.coverage.flatMap((item) => (item.status === "recorded" ? [[item.source, item] as const] : [])));
  const rows = new Map(input.overTime.map((row) => [row.label, row]));
  const buckets = chartLabels(input.period, input.until, input.nowMs).map((label): ChartBucket => {
    const row = rows.get(label);
    const values: Partial<Record<ChartSeries, number | null>> = {};
    for (const series of [...up, ...down]) {
      const coverage = recorded.get(coverageSource(series));
      const value = row?.[series];
      // A review count exists for every row, but only means something once reviews are recorded.
      values[series] = row === undefined || coverage === undefined || value === undefined || value === null || bucketEnd(label) < coverage.from ? null : value;
    }
    const partial = [...up, ...down].flatMap((series) => {
      const coverage = recorded.get(coverageSource(series));
      return values[series] !== null && coverage !== undefined && bucketStart(label) < coverage.from && coverage.from > input.from ? [{ series, from: coverage.from }] : [];
    });
    return {
      label,
      values,
      up: up.reduce((sum, series) => sum + (values[series] ?? 0), 0),
      down: down.reduce((sum, series) => sum + (values[series] ?? 0), 0),
      unrecorded: up.every((series) => values[series] === null),
      partial,
      clipped: bucketStart(label) < input.from && bucketEnd(label) >= input.from,
    };
  });
  const lanes = up.filter((series) => buckets.some((bucket) => !bucket.unrecorded && bucket.values[series] === null));
  const maxUp = Math.max(0, ...buckets.map((bucket) => bucket.up));
  const maxDown = Math.max(0, ...buckets.map((bucket) => bucket.down));
  const step = niceStep(Math.max(maxUp, maxDown, 1));
  const peak = buckets.reduce<ChartBucket | undefined>((best, bucket) => (bucket.up > (best?.up ?? 0) ? bucket : best), undefined);
  return {
    period: input.period,
    up,
    down,
    buckets,
    lanes,
    scale: { step, top: Math.max(step, Math.ceil(maxUp / step) * step), bottom: down.length === 0 ? 0 : Math.ceil(maxDown / step) * step },
    peak,
  };
}

export interface ChartLayout {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  /** The zero line. */
  readonly zero: number;
  readonly bottom: number;
  readonly unit: number;
  readonly slot: number;
  readonly barWidth: number;
  readonly ticks: readonly { readonly value: number; readonly y: number }[];
  readonly columns: readonly {
    readonly index: number;
    readonly x: number;
    readonly segments: readonly { readonly series: ChartSeries; readonly y: number; readonly height: number; readonly cap: boolean }[];
    readonly upTop: number;
    readonly downBottom: number;
  }[];
  /** Runs of consecutive unrecorded buckets: [first, last] indexes. */
  readonly bands: readonly { readonly first: number; readonly last: number; readonly x: number; readonly width: number }[];
  /** Indexes of the buckets whose x label is drawn (every other one when columns are narrow, always the newest). */
  readonly labelled: readonly number[];
  readonly labelY: number;
  readonly lanes: readonly { readonly series: ChartSeries; readonly y: number }[];
}

/** Geometry for a width in px; heights are value × unit from the zero line (W59). */
export function chartLayout(chart: ActivityChart, width: number): ChartLayout {
  const w = Math.max(260, Math.round(width));
  const left = 30;
  const right = 6;
  const top = 18;
  const n = chart.buckets.length;
  const slot = (w - left - right) / n;
  const barWidth = Math.max(6, Math.min(36, slot * 0.62));
  const plotHeight = w < 480 ? 170 : 200;
  const unit = plotHeight / (chart.scale.top + chart.scale.bottom);
  const zero = top + chart.scale.top * unit;
  const bottom = zero + chart.scale.bottom * unit;
  const x = (index: number) => left + slot * index + slot / 2;
  const ticks: { value: number; y: number }[] = [];
  for (let value = 0; value <= chart.scale.top; value += chart.scale.step) ticks.push({ value, y: zero - value * unit });
  for (let value = chart.scale.step; value <= chart.scale.bottom; value += chart.scale.step) ticks.push({ value, y: zero + value * unit });
  const columns = chart.buckets.map((bucket, index) => {
    const segments: { series: ChartSeries; y: number; height: number; cap: boolean }[] = [];
    let above = 0;
    const drawn = chart.up.filter((series) => (bucket.values[series] ?? 0) > 0);
    for (const series of drawn) {
      const value = bucket.values[series]!;
      above += value;
      segments.push({ series, y: zero - above * unit, height: value * unit, cap: series === drawn[drawn.length - 1] });
    }
    let below = 0;
    for (const series of chart.down) {
      const value = bucket.values[series] ?? 0;
      if (value <= 0) continue;
      segments.push({ series, y: zero + below * unit, height: value * unit, cap: true });
      below += value;
    }
    return { index, x: x(index), segments, upTop: zero - above * unit, downBottom: zero + below * unit };
  });
  const bands: { first: number; last: number; x: number; width: number }[] = [];
  for (let index = 0; index < n; index += 1) {
    if (!chart.buckets[index]!.unrecorded) continue;
    let last = index;
    while (last + 1 < n && chart.buckets[last + 1]!.unrecorded) last += 1;
    bands.push({ first: index, last, x: left + slot * index + 1, width: slot * (last - index + 1) - 2 });
    index = last;
  }
  const every = slot < 30 ? 2 : 1;
  const labelled = chart.buckets.map((_, index) => index).filter((index) => (n - 1 - index) % every === 0);
  const labelY = bottom + (chart.down.length > 0 ? 30 : 16);
  const laneTop = labelY + 26;
  // Each lane has its label above it; a second lane starts below the first one's bar and the next label (Spec 030: three lanes).
  const laneStep = 28;
  const lanes = chart.lanes.map((series, index) => ({ series, y: laneTop + index * laneStep }));
  return {
    width: w, height: lanes.length > 0 ? laneTop + (lanes.length - 1) * laneStep + 22 : labelY + 6, left, right, top, zero, bottom, unit, slot, barWidth,
    ticks, columns, bands, labelled, labelY, lanes,
  };
}

/**
 * The start of the selected period as the reader sees it (the first chart bucket): a source whose
 * coverage starts later says "recorded since <date>" in the summary and on its tiles (W56, W62).
 */
export function nominalStart(period: ProfilePeriod, until: string, nowMs: number): string {
  return bucketStart(chartLabels(period, until, nowMs)[0]!);
}
