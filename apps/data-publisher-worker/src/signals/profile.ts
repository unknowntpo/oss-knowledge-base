/**
 * Spec 028 slice 1: the flag, the jobs that are signal sources, and the rule thresholds (D4: one
 * const profile in code; changing a threshold is a PR).
 */
export type SignalsMode = "off" | "on" | "invalid";

/** Behavior 1: unset, blank or `off` is off; `on` is on; anything else is invalid (behaves as off). */
export function resolveSignalsMode(value: string | undefined): SignalsMode {
  const flag = value?.trim() ?? "";
  if (flag === "" || flag === "off") return "off";
  return flag === "on" ? "on" : "invalid";
}

/** Every scheduled job that writes its own data point (Behavior 13; `blob1`). */
export const SIGNAL_JOBS = ["publication", "digest", "embedding", "cost-guard", "retention", "identity-links", "kip-pages"] as const;
export type SignalJob = (typeof SIGNAL_JOBS)[number];

/** `r2Counted`: the job counts its own R2 operations (D8: the digest and the embedding job too). */
export const R2_COUNTED: Readonly<Record<SignalJob, boolean>> = {
  publication: true, digest: true, embedding: true, "cost-guard": false, retention: true, "identity-links": true, "kip-pages": true,
};

/** Behavior 16: the jobs that declare a wall budget; only they can make `job.duration` fire. */
export const WALL_BUDGET_MS: Readonly<Partial<Record<SignalJob, number>>> = {
  retention: 10 * 60_000,
  // `KIP_PAGES_CRON_WALL_MS` (kip-pages/run.ts, which imports this module's users); a test keeps them equal.
  "kip-pages": 14 * 60_000,
};

const HOUR = 3_600_000;

export const SIGNAL_THRESHOLDS = {
  /** Spec 021 `OVERDUE_AFTER_MS`: the publication (and every daily job) is late. */
  dailyWarnMs: 24.5 * HOUR,
  /** Spec 010 `STALE_AFTER_MS`: the publication (and every daily job) is stale. */
  dailyFiringMs: 27 * HOUR,
  digestFreshnessFiringMs: 48 * HOUR,
  embeddingWarnMs: 2 * HOUR,
  embeddingFiringMs: 3 * HOUR,
  classAInvariantSlack: 3,
  pollTruncatedFiringMs: 48 * HOUR,
  rejectionsFloor: 10,
  rejectionsFactor: 3,
  /** Previous runs a median needs before a trend rule judges. */
  minHistory: 3,
  /** Previous runs read per job run, and how far back. */
  historyRuns: 7,
  historyDays: 8,
  durationFactor: 2,
  wallBudgetShare: 0.8,
  r2WarnFactor: 3,
  r2WarnFloor: 1_000,
  r2FiringFactor: 10,
  r2FiringFloor: 5_000,
  /** One retry of a retryable SQL error, after this wait. */
  retryDelayMs: 1_000,
} as const;

/** Behavior 3: one dataset per environment, every job of it told apart by `blob1`. */
export function signalsDataset(environment: "development" | "production"): string {
  return environment === "production" ? "osskb_signals_prod" : "osskb_signals_dev";
}
