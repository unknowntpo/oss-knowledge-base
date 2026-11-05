/**
 * Spec 026 Behavior 5a–7a: the dollars per metric (CG21, CG35), the budget over them (CG22, CG34),
 * the own-bucket Class A spike (CG23) and the breaker transition, pure so they are tested row by
 * row (test/cost-guard.cases.ts, test/cost-guard-dollars.cases.ts, test/cost-guard-budget.cases.ts,
 * test/cost-guard-spike.cases.ts).
 */
import { COST_GUARD_BUDGET_PERCENT, COST_GUARD_BUDGET_USD, COST_GUARD_MIN_DAY_ELAPSED, COST_GUARD_SPIKE_CLASS_A, COST_METRICS, COST_METRIC_KEYS, type CostMetricKey, type CostMetricProfile } from "./profile";

export type { CostMetricKey } from "./profile";

export type MetricStatus = "ok" | "unavailable";

export interface MetricEvaluation {
  readonly value: number | null;
  readonly included: number;
  /** Dollars over the allowance at list price, floored to 0.0001 (CG21); null when unread. */
  readonly overageUsd: number | null;
  /** Dollars over the allowance at the end of the UTC month (CG21, CG35); null when unread. */
  readonly projectedOverageUsd: number | null;
  /** Complete UTC days a month counter's rate used (0–7, CG35); null for gauges, neurons and an unread value. */
  readonly rateDays: number | null;
  readonly period: CostMetricProfile["period"];
  readonly scope: CostMetricProfile["scope"];
  readonly source: CostMetricProfile["source"];
  readonly status: MetricStatus;
}

/** Behavior 6a: `ok`, `warn` or `tripped`, judged on the sum of what could be read. */
export interface BudgetEvaluation {
  readonly limitUsd: number;
  /** Floored to 0.0001. */
  readonly overageUsd: number;
  readonly projectedOverageUsd: number;
  /** Over `limitUsd` × 100, floored to 0.01. */
  readonly percent: number;
  readonly projectedPercent: number;
  readonly status: "ok" | "warn" | "tripped";
  /** Metrics that could not be read; each counts $0. */
  readonly missing: readonly CostMetricKey[];
}

/** What can open the breaker (Behavior 7a), or a metric key stored by a breaker opened before the budget slice (CG40). */
export type BreakerKey = "budget" | "r2ClassA" | CostMetricKey;

export type Breaker =
  | { readonly tripped: false }
  | {
    readonly tripped: true;
    readonly reason: string;
    readonly metric: BreakerKey;
    /** The dollars that tripped, or the 24-hour Class A count. */
    readonly value: number;
    /** $4 (spent), $5 (projected) or the spike threshold. */
    readonly threshold: number;
    /** The guard's own bucket, when a Class A spike opened it (Behavior 7a). */
    readonly bucket?: string;
    /** Dollars per metric at that moment, when the budget tripped (Behavior 7a). */
    readonly overageUsd?: Partial<Record<CostMetricKey, number>>;
    readonly trippedAt: string;
    /** Every key that tripped while the breaker was open, in the order they tripped. */
    readonly metrics: readonly BreakerKey[];
  };

/** Rounded to 1e-6 first, so a quotient such as 5.077 / 5 × 100 does not floor below its value. */
const floor2 = (value: number) => Math.floor(Math.round(value * 1e6) / 1e4) / 100;

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
    return { projected: elapsed >= COST_GUARD_MIN_DAY_ELAPSED ? value / elapsed : null, rateDays: null };
  }
  // The only source, parseR2Usage, rejects negative counts and sets days to 7 (COST_GUARD_RATE_DAYS),
  // so only "no history" needs handling here.
  if (recent === null || recent.days === 0) return { projected: value, rateDays: 0 };
  return { projected: value + (recent.count / recent.days) * remainingDaysOfMonth(now), rateDays: recent.days };
}

/** Rounded to 1e-8 first, so a product such as 3.9e9 × $0.015/1e9 does not floor below its value. */
const floor4 = (value: number) => Math.floor(Math.round(value * 1e8) / 1e4) / 1e4;
const overageAt = (profile: CostMetricProfile, value: number) => Math.max(0, value - profile.included) * profile.priceUsd;

/** A metric's exact dollars, which the budget sums; `MetricEvaluation` shows them floored. */
export interface ExactOverage { readonly now: number; readonly projected: number }

/**
 * Behavior 5a: dollars over the allowance now and at the end of the UTC month. A month counter
 * prices its CG35 projection; a gauge prices itself; neurons price today's projected overage
 * (today's value before a quarter of the day) times the days of the month. Null when unread.
 */
export function exactOverage(key: CostMetricKey, value: number | null, recent: RecentCount | null, now: Date): ExactOverage | null {
  if (value === null || !Number.isFinite(value)) return null;
  const profile = COST_METRICS[key];
  const projected = projection(profile, value, recent, now).projected ?? value;
  return { now: overageAt(profile, value), projected: overageAt(profile, projected) * (profile.period === "day" ? daysOfMonth(now) : 1) };
}

/** CG21: `exactOverage` floored to 0.0001 for display. */
export function metricOverage(key: CostMetricKey, value: number | null, recent: RecentCount | null, now: Date): { readonly overageUsd: number | null; readonly projectedOverageUsd: number | null } {
  const exact = exactOverage(key, value, recent, now);
  return exact === null ? { overageUsd: null, projectedOverageUsd: null } : { overageUsd: floor4(exact.now), projectedOverageUsd: floor4(exact.projected) };
}

/** `recent` feeds a month counter's projection (CG35); other metrics ignore it. */
export function evaluateMetric(key: CostMetricKey, value: number | null, now: Date, recent: RecentCount | null = null): MetricEvaluation {
  const profile = COST_METRICS[key];
  const base = { included: profile.included, period: profile.period, scope: profile.scope, source: profile.source };
  if (value === null || !Number.isFinite(value)) {
    return { ...base, value: null, overageUsd: null, projectedOverageUsd: null, rateDays: null, status: "unavailable" };
  }
  return { ...base, value, ...metricOverage(key, value, recent, now), rateDays: projection(profile, value, recent, now).rateDays, status: "ok" };
}

/**
 * Behavior 6a, CG22, CG34: the sum over the metrics that could be read, against the budget. It
 * compares the floored dollars, so what `/health` shows is exactly what was judged: a trip at 80 %
 * of the budget spent or over 100 % projected, a warning at 60 % of either. An absent or null line
 * counts $0 and is listed in `missing`.
 */
export function evaluateBudget(lines: Partial<Record<CostMetricKey, ExactOverage | null>>): BudgetEvaluation {
  const read = COST_METRIC_KEYS.flatMap((key) => lines[key] ?? []);
  const overageUsd = floor4(read.reduce((sum, line) => sum + line.now, 0));
  const projectedOverageUsd = floor4(read.reduce((sum, line) => sum + line.projected, 0));
  const percent = (overageUsd / COST_GUARD_BUDGET_USD) * 100;
  const projectedPercent = (projectedOverageUsd / COST_GUARD_BUDGET_USD) * 100;
  const { warn, trip, projectedTrip } = COST_GUARD_BUDGET_PERCENT;
  const status = percent >= trip || projectedOverageUsd > COST_GUARD_BUDGET_USD * (projectedTrip / 100) ? "tripped"
    : percent >= warn || projectedPercent >= warn ? "warn"
    : "ok";
  return {
    limitUsd: COST_GUARD_BUDGET_USD, overageUsd, projectedOverageUsd, percent: floor2(percent), projectedPercent: floor2(projectedPercent), status,
    missing: COST_METRIC_KEYS.filter((key) => (lines[key] ?? null) === null),
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

export interface BreakerCheck {
  readonly budget: BudgetEvaluation;
  readonly spike: SpikeEvaluation;
  /** Dollars per metric now, recorded when the budget opens the breaker (Behavior 7a). */
  readonly overageUsd: Partial<Record<CostMetricKey, number>>;
}

/**
 * Behavior 7a, 8: a closed breaker opens on a spike of the guard's own bucket (CG23), else on the
 * budget; an open one only gains newly tripped keys. Nothing here closes it.
 */
export function nextBreaker(previous: Breaker, { budget, spike, overageUsd }: BreakerCheck, now: Date): Breaker {
  const budgetTripped = budget.status === "tripped";
  const spiked = spike.status === "tripped";
  const tripped: readonly BreakerKey[] = [...(budgetTripped ? ["budget" as const] : []), ...(spiked ? ["r2ClassA" as const] : [])];
  if (tripped.length === 0) return previous;
  if (previous.tripped) {
    const added = tripped.filter((key) => !previous.metrics.includes(key));
    return added.length === 0 ? previous : { ...previous, metrics: [...previous.metrics, ...added] };
  }
  const dollars = budgetTripped ? { overageUsd } : {};
  if (spiked) {
    // Numbers and the profile's own bucket name only: no error text reaches this reason.
    const reason = `r2ClassA spike: ${spike.last24h} Class A in 24 h on ${spike.bucket} (trips at ${spike.threshold})`;
    return { tripped: true, reason, metric: "r2ClassA", value: spike.last24h!, threshold: spike.threshold, bucket: spike.bucket, ...dollars, trippedAt: now.toISOString(), metrics: tripped };
  }
  const spentLine = (COST_GUARD_BUDGET_USD * COST_GUARD_BUDGET_PERCENT.trip) / 100;
  const bySpend = budget.overageUsd >= spentLine;
  return {
    tripped: true,
    reason: bySpend
      ? `budget: $${budget.overageUsd} spent this UTC month (trips at $${spentLine})`
      : `budget: $${budget.projectedOverageUsd} projected by the end of the UTC month (trips over $${COST_GUARD_BUDGET_USD})`,
    metric: "budget",
    value: bySpend ? budget.overageUsd : budget.projectedOverageUsd,
    threshold: bySpend ? spentLine : COST_GUARD_BUDGET_USD,
    ...dollars,
    trippedAt: now.toISOString(),
    metrics: tripped,
  };
}
