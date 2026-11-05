/**
 * Spec 026: the `CostGuard` Durable Object's logic, free of Workers types so it is testable. It
 * keeps one storage key: the last check, the breaker and the last reset. A check reads the
 * account's R2 numbers over GraphQL and this Worker's own ledgers; it never touches R2.
 */
import { errorText, sanitizeErrorMessage } from "@oss-knowledge-base/semantic-vectorize";

import { evaluateBudget, evaluateMetric, evaluateSpike, exactOverage, nextBreaker, type Breaker, type BudgetEvaluation, type CostMetricKey, type MetricEvaluation, type RecentCount, type SpikeEvaluation } from "./evaluate";
import { fetchR2Usage, type GraphqlFetch } from "./graphql";
import { COST_GUARD_BUCKETS, COST_METRIC_KEYS } from "./profile";
import { costGuardSignalRun, runIdFor } from "../signals/point";
import { runLog, type JobSignals, type RunContext } from "../signals/recorder";
import type { TrendResult } from "../signals/rules";

export type CostGuardMode = "off" | "monitor" | "enforce" | "invalid";
export type CostGuardStatus = "ok" | "warn" | "tripped" | "unconfigured" | "pending";

/** Behavior 1: unset, blank or `off` is off; any value but `monitor` or `enforce` is invalid. */
export function resolveCostGuardMode(flag: string | undefined): CostGuardMode {
  const value = flag?.trim() ?? "";
  if (value === "" || value === "off") return "off";
  return value === "monitor" || value === "enforce" ? value : "invalid";
}

/**
 * Behavior 9a: what a guarded feature does. Only `enforce` refuses; only `r2ClassA` (the own-bucket
 * spike of CG23) pauses publication; a budget trip leaves it running.
 */
export function costGuardDecision(mode: CostGuardMode, breaker: Breaker): { readonly refuse: boolean; readonly pausePublication: boolean } {
  if (mode !== "enforce" || !breaker.tripped) return { refuse: false, pausePublication: false };
  return { refuse: true, pausePublication: breaker.metrics.includes("r2ClassA") };
}

/** Behavior 2: what is missing for a check, named without values; undefined when nothing is. */
export function costGuardMissing(input: { readonly flag: string | undefined; readonly token: string | undefined; readonly accountId: string | undefined; readonly bound: boolean }): string | undefined {
  if (resolveCostGuardMode(input.flag) === "invalid") return sanitizeErrorMessage(`COST_GUARD "${input.flag?.trim() ?? ""}" is not off, monitor or enforce`);
  const missing = [
    ...(input.bound ? [] : ["the COST_GUARD_STATE binding is missing"]),
    ...((input.token?.trim() ?? "") === "" ? ["CF_ANALYTICS_TOKEN is not set"] : []),
    ...((input.accountId?.trim() ?? "") === "" ? ["CF_ACCOUNT_ID is not set"] : []),
  ];
  return missing.length === 0 ? undefined : missing.join("; ");
}

export interface CostGuardInApp {
  /** Neurons today from this Worker's ledgers; null without the `AI` binding. */
  neuronsToday(): Promise<number | null>;
  /** Vectorize dimensions for `month` (`YYYY-MM`); null without the index. */
  vectorize(month: string): Promise<{ readonly storedDimensions: number; readonly queriedDimensions: number } | null>;
}

export interface CostGuardRunnerDeps {
  readonly storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
  readonly flag: string | undefined;
  readonly token: string | undefined;
  readonly accountId: string | undefined;
  /** `PUBLICATION_ENVIRONMENT`: picks the bucket the spike counts (Decision 10). */
  readonly environment: keyof typeof COST_GUARD_BUCKETS;
  readonly fetch: GraphqlFetch;
  readonly now: () => Date;
  readonly inApp: CostGuardInApp;
  /** Spec 028: present only while `OBSERVABILITY_SIGNALS=on`; a real check then writes its point and stores the trend result. */
  readonly signals?: JobSignals;
}

export interface CostGuardError { readonly message: string; readonly at: string }

interface StoredState {
  readonly checkedAt: string | null;
  /** Behavior 6a of the last real check; null before one, and in a state stored before the budget slice (CG40). */
  readonly budget: BudgetEvaluation | null;
  readonly metrics: Partial<Record<CostMetricKey, MetricEvaluation>>;
  /** The last real check's own-bucket spike (CG23); null before one. */
  readonly r2ClassASpike: SpikeEvaluation | null;
  readonly breaker: Breaker;
  readonly lastResetAt: string | null;
  readonly lastError: CostGuardError | null;
  /** Spec 028: the last real check's run and trend result, while signals are on. */
  readonly runId?: string;
  readonly trends?: TrendResult;
}

export interface CostGuardHealth {
  readonly mode: CostGuardMode;
  readonly status: CostGuardStatus;
  readonly reason: string | null;
  readonly checkedAt: string | null;
  readonly budget: BudgetEvaluation | null;
  readonly metrics: Partial<Record<CostMetricKey, MetricEvaluation>>;
  /** Behavior 13a `r2ClassASpike {last24h, threshold, bucket, status}`; null before the first check. */
  readonly r2ClassASpike: SpikeEvaluation | null;
  readonly breaker: Breaker;
  readonly lastResetAt: string | null;
  readonly lastError: CostGuardError | null;
  /** Spec 028: present only after a check made while signals are on. */
  readonly runId?: string;
  readonly trends?: TrendResult;
}

/** Behavior 13a: the budget's status, or `tripped` when the own-bucket spike trips (CG23). */
const checkStatus = (budget: BudgetEvaluation, spike: SpikeEvaluation | null) =>
  spike?.status === "tripped" ? "tripped" : budget.status;

const STATE = "state";
const EMPTY: StoredState = { checkedAt: null, budget: null, metrics: {}, r2ClassASpike: null, breaker: { tripped: false }, lastResetAt: null, lastError: null };

/** `/health` `costGuard` where the object is not bound: the same keys, unconfigured (Behavior 13). */
export function unboundCostGuardHealth(flag: string | undefined, reason: string): CostGuardHealth {
  return { ...EMPTY, mode: resolveCostGuardMode(flag), status: "unconfigured", reason };
}

export class CostGuardRunner {
  constructor(private readonly deps: CostGuardRunnerDeps) {}

  private get mode(): CostGuardMode {
    return resolveCostGuardMode(this.deps.flag);
  }

  private missing(): string | undefined {
    return costGuardMissing({ flag: this.deps.flag, token: this.deps.token, accountId: this.deps.accountId, bound: true });
  }

  private async state(): Promise<StoredState> {
    return { ...EMPTY, ...(await this.deps.storage.get<StoredState>(STATE)) };
  }

  /** Behavior 3, 11, 12: evaluate now; a real check stores the result and may open the breaker. */
  async check(options: { readonly dryRun: boolean; readonly runId?: string }): Promise<unknown> {
    const reason = this.missing();
    if (reason !== undefined) return { ok: false, status: "unconfigured", reason };
    const now = this.deps.now();
    // Spec 028: the scheduled tick names the run (so its own log line carries the same id); a manual check names its own.
    const context: RunContext | undefined = this.deps.signals === undefined || options.dryRun ? undefined : { runId: options.runId ?? runIdFor("cost-guard", now.getTime()), job: "cost-guard" };
    const month = now.toISOString().slice(0, 7);
    let lastError = null as CostGuardError | null;
    const bucket = COST_GUARD_BUCKETS[this.deps.environment];
    const r2 = await fetchR2Usage({ fetch: this.deps.fetch, token: this.deps.token!.trim(), accountId: this.deps.accountId!.trim(), bucket, now })
      .catch((error: unknown) => {
        lastError = { message: errorText(error), at: now.toISOString() };
        runLog(context, "error", `cost guard: the GraphQL read failed: ${lastError.message}`);
        return null;
      });
    const neurons = await this.deps.inApp.neuronsToday().catch(() => null);
    const vectorize = await this.deps.inApp.vectorize(month).catch(() => null);
    // CG35: R2 counters project by the account's 7 complete days; queried dimensions have no per-day read yet (rateDays 0, G101).
    const read: Record<CostMetricKey, { readonly value: number | null; readonly recent: RecentCount | null }> = {
      r2ClassA: { value: r2?.classA ?? null, recent: r2 === null ? null : { count: r2.recent.classA, days: r2.recent.days } },
      r2ClassB: { value: r2?.classB ?? null, recent: r2 === null ? null : { count: r2.recent.classB, days: r2.recent.days } },
      r2StorageBytes: { value: r2?.storageBytes ?? null, recent: null },
      vectorizeStoredDimensions: { value: vectorize?.storedDimensions ?? null, recent: null },
      vectorizeQueriedDimensions: { value: vectorize?.queriedDimensions ?? null, recent: null },
      workersAiNeurons: { value: neurons, recent: null },
    };
    const perMetric = <T>(each: (key: CostMetricKey) => T) => Object.fromEntries(COST_METRIC_KEYS.map((key) => [key, each(key)])) as Record<CostMetricKey, T>;
    const metrics = perMetric((key) => evaluateMetric(key, read[key].value, now, read[key].recent));
    const budget = evaluateBudget(perMetric((key) => exactOverage(key, read[key].value, read[key].recent, now)));
    // CG23: the guard's own bucket over the last 24 hours; unavailable with the rest of R2.
    const r2ClassASpike = evaluateSpike(r2?.spike.classA ?? null, bucket);
    const overageUsd = Object.fromEntries(COST_METRIC_KEYS.flatMap((key) => (metrics[key].overageUsd === null ? [] : [[key, metrics[key].overageUsd]]))) as Partial<Record<CostMetricKey, number>>;
    const previous = await this.state();
    const breaker = nextBreaker(previous.breaker, { budget, spike: r2ClassASpike, overageUsd }, now);
    const status = breaker.tripped ? "tripped" : checkStatus(budget, r2ClassASpike);
    const result = {
      ok: lastError === null,
      dryRun: options.dryRun,
      mode: this.mode,
      status: options.dryRun ? checkStatus(budget, r2ClassASpike) : status,
      checkedAt: now.toISOString(),
      budget,
      metrics,
      r2ClassASpike,
      ...(r2 !== null && r2.unclassifiedActions.length > 0 ? { unclassifiedActions: r2.unclassifiedActions } : {}),
      breaker: options.dryRun ? previous.breaker : breaker,
      lastError,
      ...(options.dryRun ? { wouldTrip: !previous.breaker.tripped && breaker.tripped } : {}),
    };
    if (!options.dryRun) {
      const signals = context === undefined ? {} : {
        runId: context.runId,
        trends: await this.deps.signals!.finish(costGuardSignalRun({ ok: result.ok, status, breaker, budget, ...(r2ClassASpike.last24h === null ? {} : { r2ClassASpike: { last24h: r2ClassASpike.last24h } }) }, { runId: context.runId, startedAtMs: now.getTime(), finishedAtMs: this.deps.now().getTime() })),
      };
      // A check made with signals off drops an earlier run's id and result rather than serve them stale.
      const { runId: _runId, trends: _trends, ...kept } = previous;
      await this.deps.storage.put(STATE, { ...kept, checkedAt: now.toISOString(), budget, metrics, r2ClassASpike, breaker, lastError, ...signals } satisfies StoredState);
    }
    return result;
  }

  /** Behavior 8: the only way the breaker closes. */
  async reset(): Promise<{ readonly ok: true; readonly breaker: Breaker; readonly lastResetAt: string }> {
    const lastResetAt = this.deps.now().toISOString();
    await this.deps.storage.put(STATE, { ...(await this.state()), breaker: { tripped: false }, lastResetAt } satisfies StoredState);
    return { ok: true, breaker: { tripped: false }, lastResetAt };
  }

  async breaker(): Promise<Breaker> {
    return (await this.state()).breaker;
  }

  async decision(): Promise<{ readonly refuse: boolean; readonly pausePublication: boolean }> {
    return costGuardDecision(this.mode, await this.breaker());
  }

  /** Behavior 13a. A state stored before the budget slice has no `budget`: it reads as no check yet, and its old metrics are not served (CG40). */
  async health(): Promise<CostGuardHealth> {
    const state = await this.state();
    const reason = this.missing() ?? null;
    const status: CostGuardStatus = state.breaker.tripped ? "tripped"
      : reason !== null ? "unconfigured"
      : state.budget === null ? "pending"
      : checkStatus(state.budget, state.r2ClassASpike);
    return {
      mode: this.mode, status, reason, checkedAt: state.checkedAt, budget: state.budget, metrics: state.budget === null ? {} : state.metrics, r2ClassASpike: state.r2ClassASpike, breaker: state.breaker, lastResetAt: state.lastResetAt, lastError: state.lastError,
      ...(state.runId === undefined ? {} : { runId: state.runId }),
      ...(state.trends === undefined ? {} : { trends: state.trends }),
    };
  }
}
