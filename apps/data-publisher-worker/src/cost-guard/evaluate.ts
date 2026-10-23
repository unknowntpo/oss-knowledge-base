/**
 * Spec 026 Behavior 5–7: the threshold math, the dollars per metric (CG21, CG35), the own-bucket
 * Class A spike (CG23) and the breaker transition, pure so they are tested row by row
 * (test/cost-guard.cases.ts, test/cost-guard-dollars.cases.ts, test/cost-guard-spike.cases.ts).
 */
import { COST_GUARD_SPIKE_CLASS_A, COST_GUARD_THRESHOLDS, COST_METRICS, COST_METRIC_KEYS, type CostMetricKey, type CostMetricProfile } from "./profile";

export type { CostMetricKey } from "./profile";

export type MetricStatus = "ok" | "warn" | "tripped" | "unavailable";

export interface MetricEvaluation {
  readonly value: number | null;
  readonly allowance: number;
  /** Floored to 0.01; null when the value could not be read. */
  readonly percent: number | null;
  /** Floored to 0.01; null for gauges, and for neurons before a quarter of the day. */
  readonly projectedPercent: number | null;
  /** Dollars over the allowance at list price, floored to 0.0001 (CG21); null when unread. */
  readonly overageUsd: number | null;
  /** Dollars over the allowance at the end of the UTC month (CG21, CG35); null when unread. */
  readonly projectedOverageUsd: number | null;
  /** Complete UTC days a month counter's rate used (0–7, CG35); null for gauges and neurons. */
  readonly rateDays: number | null;
  readonly period: CostMetricProfile["period"];
  readonly scope: CostMetricProfile["scope"];
  readonly source: CostMetricProfile["source"];
  readonly status: MetricStatus;
}

export type Breaker =
  | { readonly tripped: false }
  | {
    readonly tripped: true;
    readonly reason: string;
    readonly metric: CostMetricKey;
    readonly value: number;
    /** The value at which it tripped: 80 % of the allowance, the allowance for a projection, or the spike threshold. */
    readonly threshold: number;
    /** The guard's own bucket, when a Class A spike opened it (Behavior 7a). */
    readonly bucket?: string;
    readonly trippedAt: string;
    /** Every metric that tripped while the breaker was open, in profile order. */
    readonly metrics: readonly CostMetricKey[];
  };

const floor2 = (value: number) => Math.floor(value * 100) / 100;

/** The fraction of the metric's UTC period that has passed at `now`. */
export function periodElapsed(period: "month" | "day", now: Date): number {
  const time = now.getTime();
  if (period === "day") {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return (time - start) / 86_400_000;
  }
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return (time - start) / (end - start);
}

/** A month counter's count over the `days` complete UTC days before today (CG35). */
export interface RecentCount { readonly count: number; readonly days: number }

const DAY_MS = 86_400_000;
const monthEnd = (now: Date) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);

/** Days from `now` to the end of its UTC month. */
export function remainingDaysOfMonth(now: Date): number {
  return (monthEnd(now) - now.getTime()) / DAY_MS;
}

const daysOfMonth = (now: Date) => (monthEnd(now) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) / DAY_MS;

/**
 * The value a metric is judged on at the end of its period (Behavior 5a):
 * - a month counter: `value + count / days × remaining days` (CG35, Decision 9); with no complete
 *   day of history, or none read, `value`;
 * - neurons (a day counter): `value / elapsed day` from a quarter of the day, null before;
 * - a gauge: null (a level, not projected).
 */
function projection(profile: CostMetricProfile, value: number, recent: RecentCount | null, now: Date): { readonly projected: number | null; readonly rateDays: number | null } {
  if (profile.kind === "gauge") return { projected: null, rateDays: null };
  if (profile.period === "day") {
    const elapsed = periodElapsed("day", now);
    return { projected: elapsed >= COST_GUARD_THRESHOLDS.minElapsedForProjection ? value / elapsed : null, rateDays: null };
  }
  // The only source, parseR2Usage, rejects negative counts and sets days to 7 (COST_GUARD_RATE_DAYS),
  // so only "no history" needs handling here.
  if (recent === null || recent.days === 0) return { projected: value, rateDays: 0 };
  return { projected: value + (recent.count / recent.days) * remainingDaysOfMonth(now), rateDays: recent.days };
}

/** Rounded to 1e-8 first, so a product such as 3.9e9 × $0.015/1e9 does not floor below its value. */
const floor4 = (value: number) => Math.floor(Math.round(value * 1e8) / 1e4) / 1e4;
const overageUsd = (profile: CostMetricProfile, value: number) => Math.max(0, value - profile.allowance) * profile.priceUsd;

/**
 * CG21: dollars over the allowance now and at the end of the UTC month, floored to 0.0001. A month
 * counter prices its CG35 projection; a gauge prices itself; neurons price today's projected
 * overage (today's value before a quarter of the day) times the days of the month. Null when the
 * value could not be read.
 */
export function metricOverage(key: CostMetricKey, value: number | null, recent: RecentCount | null, now: Date): { readonly overageUsd: number | null; readonly projectedOverageUsd: number | null } {
  if (value === null || !Number.isFinite(value)) return { overageUsd: null, projectedOverageUsd: null };
  const profile = COST_METRICS[key];
  const projected = projection(profile, value, recent, now).projected ?? value;
  const projectedUsd = overageUsd(profile, projected) * (profile.period === "day" ? daysOfMonth(now) : 1);
  return { overageUsd: floor4(overageUsd(profile, value)), projectedOverageUsd: floor4(projectedUsd) };
}

interface Exact { readonly percent: number; readonly projected: number | null }

function tripsOn(profile: CostMetricProfile, { percent, projected }: Exact): "level" | "projection" | undefined {
  if (!profile.trips) return undefined;
  if (percent >= COST_GUARD_THRESHOLDS.tripPercent) return "level";
  if (projected !== null && projected > COST_GUARD_THRESHOLDS.projectedTripPercent) return "projection";
  return undefined;
}

/** `recent` feeds a month counter's projection (CG35); other metrics ignore it. */
export function evaluateMetric(key: CostMetricKey, value: number | null, now: Date, recent: RecentCount | null = null): MetricEvaluation {
  const profile = COST_METRICS[key];
  const base = { value, allowance: profile.allowance, period: profile.period, scope: profile.scope, source: profile.source };
  if (value === null || !Number.isFinite(value)) {
    return { ...base, value: null, percent: null, projectedPercent: null, overageUsd: null, projectedOverageUsd: null, rateDays: null, status: "unavailable" };
  }
  const { projected, rateDays } = projection(profile, value, recent, now);
  const numbers: Exact = { percent: (value / profile.allowance) * 100, projected: projected === null ? null : (projected / profile.allowance) * 100 };
  const status: MetricStatus = tripsOn(profile, numbers) !== undefined ? "tripped"
    : numbers.percent >= COST_GUARD_THRESHOLDS.warnPercent ? "warn"
    : "ok";
  return {
    ...base,
    percent: floor2(numbers.percent),
    projectedPercent: numbers.projected === null ? null : floor2(numbers.projected),
    ...metricOverage(key, value, recent, now),
    rateDays,
    status,
  };
}

/** Behavior 6b: the guard's own bucket's Class A over the last 24 hours against the spike threshold. */
export interface SpikeEvaluation {
  /** Null when the GraphQL read failed. */
  readonly last24h: number | null;
  readonly threshold: number;
  readonly bucket: string;
  readonly status: "ok" | "tripped" | "unavailable";
}

/** CG23: `tripped` at the threshold or above, whatever the dollars; never on missing data. */
export function evaluateSpike(last24h: number | null, bucket: string): SpikeEvaluation {
  const threshold = COST_GUARD_SPIKE_CLASS_A;
  if (last24h === null || !Number.isFinite(last24h)) return { last24h: null, threshold, bucket, status: "unavailable" };
  return { last24h, threshold, bucket, status: last24h >= threshold ? "tripped" : "ok" };
}

/** The worst of the metrics; `unavailable` counts as ok (Behavior 13). */
export function worstStatus(metrics: Partial<Record<CostMetricKey, MetricEvaluation>>): "ok" | "warn" | "tripped" {
  const statuses = Object.values(metrics).map((metric) => metric?.status);
  return statuses.includes("tripped") ? "tripped" : statuses.includes("warn") ? "warn" : "ok";
}

/**
 * Behavior 7, 7a: a closed breaker opens on a spike of the guard's own bucket (CG23) as `r2ClassA`
 * with the 24-hour count, else on the tripped metric with the highest percent; an open one only
 * gains newly tripped metrics. Nothing here closes it (Behavior 8).
 */
export function nextBreaker(previous: Breaker, metrics: Partial<Record<CostMetricKey, MetricEvaluation>>, now: Date, spike: SpikeEvaluation | null = null): Breaker {
  const spiked = spike?.status === "tripped";
  const tripped = COST_METRIC_KEYS.filter((key) => metrics[key]?.status === "tripped" || (spiked && key === "r2ClassA"));
  if (tripped.length === 0) return previous;
  if (previous.tripped) {
    const all = COST_METRIC_KEYS.filter((key) => previous.metrics.includes(key) || tripped.includes(key));
    return all.length === previous.metrics.length ? previous : { ...previous, metrics: all };
  }
  if (spiked) {
    return {
      tripped: true,
      reason: `r2ClassA spike: ${spike.last24h} Class A in 24 h on ${spike.bucket} (trips at ${spike.threshold})`,
      metric: "r2ClassA",
      value: spike.last24h!,
      threshold: spike.threshold,
      bucket: spike.bucket,
      trippedAt: now.toISOString(),
      metrics: tripped,
    };
  }
  // Floored values order and describe it: a floored percent below the trip line means the level
  // did not trip, so the projection did.
  const [first] = [...tripped].sort((a, b) => metrics[b]!.percent! - metrics[a]!.percent!);
  const key = first!;
  const profile = COST_METRICS[key];
  const metric = metrics[key]!;
  const byProjection = metric.percent! < COST_GUARD_THRESHOLDS.tripPercent;
  return {
    tripped: true,
    reason: byProjection
      ? `${key} projected at ${metric.projectedPercent}% of ${profile.allowance} by the end of its period`
      : `${key} at ${metric.percent}% of ${profile.allowance} (trips at ${COST_GUARD_THRESHOLDS.tripPercent}%)`,
    metric: key,
    value: metric.value!,
    threshold: byProjection ? profile.allowance : (profile.allowance * COST_GUARD_THRESHOLDS.tripPercent) / 100,
    trippedAt: now.toISOString(),
    metrics: tripped,
  };
}
