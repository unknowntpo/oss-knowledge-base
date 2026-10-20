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
}

/** https://developers.cloudflare.com/r2/pricing/, /vectorize/platform/pricing/, /workers-ai/platform/pricing/ */
export const COST_METRICS: Readonly<Record<CostMetricKey, CostMetricProfile>> = {
  r2ClassA: { allowance: 1_000_000, period: "month", kind: "counter", trips: true, scope: "account", source: "graphql" },
  r2ClassB: { allowance: 10_000_000, period: "month", kind: "counter", trips: true, scope: "account", source: "graphql" },
  // 10 GB-month, read as 10 × 10⁹ bytes (the smaller reading of GB).
  r2StorageBytes: { allowance: 10_000_000_000, period: "month", kind: "gauge", trips: true, scope: "account", source: "graphql" },
  // Overage is $0.05 per 100 million dimensions: worth a warning, never a pause.
  vectorizeStoredDimensions: { allowance: 10_000_000, period: "month", kind: "gauge", trips: false, scope: "worker", source: "in-app" },
  vectorizeQueriedDimensions: { allowance: 50_000_000, period: "month", kind: "counter", trips: true, scope: "worker", source: "in-app" },
  workersAiNeurons: { allowance: 10_000, period: "day", kind: "counter", trips: true, scope: "worker", source: "in-app" },
};

export const COST_METRIC_KEYS = Object.keys(COST_METRICS) as readonly CostMetricKey[];

/** Behavior 5–6. */
export const COST_GUARD_THRESHOLDS = {
  warnPercent: 60,
  tripPercent: 80,
  /** A projection trips only when it is over this. */
  projectedTripPercent: 100,
  /** No projection before this fraction of the period has passed. */
  minElapsedForProjection: 0.25,
} as const;

/** The one guard object. */
export const COST_GUARD_OBJECT_NAME = "cost-guard-v1";

/** What the query gate answers while refused: the search reader then stays lexical for an hour. */
export const COST_GUARD_RETRY_AFTER_MS = 3_600_000;
