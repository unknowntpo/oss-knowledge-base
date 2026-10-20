/**
 * Spec 026 Behavior 5–7: the threshold math and the breaker transition, pure so they are tested
 * row by row (test/cost-guard.cases.ts).
 */
import { COST_GUARD_THRESHOLDS, COST_METRICS, COST_METRIC_KEYS, type CostMetricKey, type CostMetricProfile } from "./profile";

export type { CostMetricKey } from "./profile";

export type MetricStatus = "ok" | "warn" | "tripped" | "unavailable";

export interface MetricEvaluation {
  readonly value: number | null;
  readonly allowance: number;
  /** Floored to 0.01; null when the value could not be read. */
  readonly percent: number | null;
  /** Floored to 0.01; null for gauges and before a quarter of the period. */
  readonly projectedPercent: number | null;
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
    /** The value at which it tripped: 80 % of the allowance, or the allowance for a projection. */
    readonly threshold: number;
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

interface Exact { readonly percent: number; readonly projected: number | null }

function exact(profile: CostMetricProfile, value: number, now: Date): Exact {
  const percent = (value / profile.allowance) * 100;
  const elapsed = periodElapsed(profile.period, now);
  const projected = profile.kind === "counter" && elapsed >= COST_GUARD_THRESHOLDS.minElapsedForProjection ? percent / elapsed : null;
  return { percent, projected };
}

function tripsOn(profile: CostMetricProfile, { percent, projected }: Exact): "level" | "projection" | undefined {
  if (!profile.trips) return undefined;
  if (percent >= COST_GUARD_THRESHOLDS.tripPercent) return "level";
  if (projected !== null && projected > COST_GUARD_THRESHOLDS.projectedTripPercent) return "projection";
  return undefined;
}

export function evaluateMetric(key: CostMetricKey, value: number | null, now: Date): MetricEvaluation {
  const profile = COST_METRICS[key];
  const base = { value, allowance: profile.allowance, period: profile.period, scope: profile.scope, source: profile.source };
  if (value === null || !Number.isFinite(value)) return { ...base, value: null, percent: null, projectedPercent: null, status: "unavailable" };
  const numbers = exact(profile, value, now);
  const status: MetricStatus = tripsOn(profile, numbers) !== undefined ? "tripped"
    : numbers.percent >= COST_GUARD_THRESHOLDS.warnPercent ? "warn"
    : "ok";
  return { ...base, percent: floor2(numbers.percent), projectedPercent: numbers.projected === null ? null : floor2(numbers.projected), status };
}

/** The worst of the metrics; `unavailable` counts as ok (Behavior 13). */
export function worstStatus(metrics: Partial<Record<CostMetricKey, MetricEvaluation>>): "ok" | "warn" | "tripped" {
  const statuses = Object.values(metrics).map((metric) => metric?.status);
  return statuses.includes("tripped") ? "tripped" : statuses.includes("warn") ? "warn" : "ok";
}

/**
 * Behavior 7: a closed breaker opens on the tripped metric with the highest percent; an open one
 * only gains newly tripped metrics. Nothing here closes it (Behavior 8).
 */
export function nextBreaker(previous: Breaker, metrics: Partial<Record<CostMetricKey, MetricEvaluation>>, now: Date): Breaker {
  const tripped = COST_METRIC_KEYS.filter((key) => metrics[key]?.status === "tripped");
  if (tripped.length === 0) return previous;
  if (previous.tripped) {
    const all = COST_METRIC_KEYS.filter((key) => previous.metrics.includes(key) || tripped.includes(key));
    return all.length === previous.metrics.length ? previous : { ...previous, metrics: all };
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
