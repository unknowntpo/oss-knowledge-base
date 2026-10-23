/**
 * Spec 026: what the cost guard measures and the free allowance of each metric on Workers Paid
 * (read 2026-10-20; links in docs/specs/026-cost-guard/spec.md, "Allowances on Workers Paid").
 * A change to a number here is a PR, not a variable.
 */
export type CostMetricKey =
  | "r2ClassA"
  | "r2ClassB"
  | "r2StorageBytes"
  | "vectorizeStoredDimensions"
  | "vectorizeQueriedDimensions"
  | "workersAiNeurons";

export interface CostMetricProfile {
  /** Included in Workers Paid for one `period`. */
  readonly allowance: number;
  /** The UTC period the allowance renews over. */
  readonly period: "month" | "day";
  /** A counter accumulates over its period and is projected; a gauge is a level and is not. */
  readonly kind: "counter" | "gauge";
  /** Whether reaching the trip threshold opens the breaker (Behavior 6: stored dimensions only warn). */
  readonly trips: boolean;
  /** `account`: every bucket of the account; `worker`: only what this Worker's own ledgers see. */
  readonly scope: "account" | "worker";
  readonly source: "graphql" | "in-app";
  /** List price in US dollars of one unit over the allowance (Allowances on Workers Paid). */
  readonly priceUsd: number;
}

/** https://developers.cloudflare.com/r2/pricing/, /vectorize/platform/pricing/, /workers-ai/platform/pricing/ */
export const COST_METRICS: Readonly<Record<CostMetricKey, CostMetricProfile>> = {
  r2ClassA: { allowance: 1_000_000, period: "month", kind: "counter", trips: true, scope: "account", source: "graphql", priceUsd: 4.5 / 1_000_000 },
  r2ClassB: { allowance: 10_000_000, period: "month", kind: "counter", trips: true, scope: "account", source: "graphql", priceUsd: 0.36 / 1_000_000 },
  // 10 GB-month, read as 10 × 10⁹ bytes (the smaller reading of GB).
  r2StorageBytes: { allowance: 10_000_000_000, period: "month", kind: "gauge", trips: true, scope: "account", source: "graphql", priceUsd: 0.015 / 1_000_000_000 },
  // Overage is $0.05 per 100 million dimensions: worth a warning, never a pause.
  vectorizeStoredDimensions: { allowance: 10_000_000, period: "month", kind: "gauge", trips: false, scope: "worker", source: "in-app", priceUsd: 0.05 / 100_000_000 },
  vectorizeQueriedDimensions: { allowance: 50_000_000, period: "month", kind: "counter", trips: true, scope: "worker", source: "in-app", priceUsd: 0.01 / 1_000_000 },
  workersAiNeurons: { allowance: 10_000, period: "day", kind: "counter", trips: true, scope: "worker", source: "in-app", priceUsd: 0.011 / 1_000 },
};

export const COST_METRIC_KEYS = Object.keys(COST_METRICS) as readonly CostMetricKey[];

/** Behavior 5–6. */
export const COST_GUARD_THRESHOLDS = {
  warnPercent: 60,
  tripPercent: 80,
  /** A projection trips only when it is over this. */
  projectedTripPercent: 100,
  /** Neurons (a daily counter): today is not extrapolated before this fraction of the day has passed. */
  minElapsedForProjection: 0.25,
} as const;

/**
 * CG35 (Decision 9): a month counter projects by its average over at most this many complete UTC
 * days before today, so a burst that has stopped is not carried into the rest of the month.
 */
export const COST_GUARD_RATE_DAYS = 7;

/**
 * Behavior 6b (Decisions 6, 12): the guard's own bucket trips `r2ClassA` at this many Class A
 * operations over the last 24 hours, whatever the dollars. Provisional until CG37.
 */
export const COST_GUARD_SPIKE_CLASS_A = 50_000;

/**
 * Decision 10: the bucket each environment's guard counts for the spike, the `OSS_KB_BUCKET`
 * binding's `bucket_name` in its wrangler file (a test keeps them equal).
 */
export const COST_GUARD_BUCKETS = {
  development: "oss-knowledge-base-dev",
  production: "oss-knowledge-base-prod",
} as const satisfies Readonly<Record<"development" | "production", string>>;

/** The one guard object. */
export const COST_GUARD_OBJECT_NAME = "cost-guard-v1";

/** What the query gate answers while refused: the search reader then stays lexical for an hour. */
export const COST_GUARD_RETRY_AFTER_MS = 3_600_000;
