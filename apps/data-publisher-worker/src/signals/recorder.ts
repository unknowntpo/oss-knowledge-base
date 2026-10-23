/**
 * Spec 028 Behaviors 3, 4, 14, 17: the end of every job run while `OBSERVABILITY_SIGNALS=on`. Writes
 * the run's one data point to `SIGNALS` (Workers Analytics Engine), reads the job's previous points
 * with one `SELECT` through `ANALYTICS_SQL`, and returns the trend result the job stores in the status
 * write it already makes. Never throws: a failure only makes the analytics rules `unknown`.
 */
import { errorText, sanitizeErrorMessage } from "../search-embedding/sanitize";
import { metricPoint, type DataPoint, type SignalRun } from "./point";
import { SIGNAL_THRESHOLDS, signalsDataset, type SignalJob } from "./profile";
import { trendRules, type History, type HistoryPoint, type TrendResult } from "./rules";

/** The `analytics_engine_datasets` binding's one call. */
export interface SignalsSink {
  writeDataPoint(point: DataPoint): void;
}

/** The Analytics SQL Workers binding (`"analytics": {"binding": "ANALYTICS_SQL"}`). */
export interface AnalyticsSql {
  query(input: { readonly query: string; readonly params?: Record<string, string | number | boolean | null> }): Promise<{ readonly data: readonly unknown[] }>;
}

/** What a job runner needs at the end of a run; absent while the flag is off. */
export interface JobSignals {
  finish(run: SignalRun): Promise<TrendResult>;
}

/** The run a log line belongs to (Behavior 8). */
export interface RunContext {
  readonly runId: string;
  readonly job: SignalJob;
}

/**
 * Behavior 8: inside a run while signals are on, a log call receives `{message, runId, job}` so
 * Workers Logs indexes `runId`; without a run context (flag off) it keeps today's text.
 */
export function runLog(context: RunContext | undefined, level: "log" | "error", message: string): void {
  if (context === undefined) console[level](message);
  else console[level]({ message, runId: context.runId, job: context.job });
}

const DAY = 86_400_000;
const LIMIT = 20;

/**
 * The stored columns the history reads, selected and grouped by their raw names. They carry no alias:
 * the binding resolves a clause's column to its SELECT alias and then fails to find the alias in the
 * dataset (Dev 2026-10-23: "column `writtenAt` not found"). `historyPoints` maps them by name.
 */
const HISTORY_COLUMNS = "index1, blob3, double1, double2, double3, double6, double7, double8, double9, double10, double11, double12, timestamp";

/**
 * Behavior 4: one parameterized `SELECT`, bounded by time and by `blob1`, the current run excluded.
 * Behavior 6: the Analytics SQL binding has no `_sample_interval` column (that is the separate WAE SQL
 * API); it applies sample weights to `COUNT`. Grouping by every stored column keeps one row per point
 * and makes `COUNT(*)` that point's weight: 1 when unsampled. Only that aggregate has an alias, used
 * nowhere but the SELECT list.
 */
export function historyQuery(job: SignalJob, runId: string, environment: "development" | "production", now: number): { readonly query: string; readonly params: Record<string, string> } {
  return {
    query: [
      `SELECT ${HISTORY_COLUMNS}, COUNT(*) AS weight`,
      `FROM events.analyticsEngine."${signalsDataset(environment)}"`,
      "WHERE blob1 = $job AND index1 != $runId AND timestamp >= $start",
      `GROUP BY ${HISTORY_COLUMNS}`,
      `ORDER BY timestamp DESC LIMIT ${LIMIT}`,
    ].join(" "),
    params: { job, runId, start: new Date(now - SIGNAL_THRESHOLDS.historyDays * DAY).toISOString() },
  };
}

const number = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/** Maps the binding's raw-keyed rows (`index1`, `blob3`, `doubleN`, `weight`) to history points. */
export function historyPoints(data: readonly unknown[]): HistoryPoint[] {
  return data.map((value) => {
    const row = (value ?? {}) as Record<string, unknown>;
    const point: HistoryPoint = {
      runId: String(row.index1 ?? ""),
      status: String(row.blob3 ?? ""),
      ok: number(row.double1) === 1,
      durationMs: number(row.double2),
      r2ClassA: number(row.double3),
      completedAtMs: number(row.double6),
      counters: [row.double7, row.double8, row.double9, row.double10, row.double11, row.double12].map(number),
      // The weighted COUNT(*) of the point's group; a row without it is treated as sampled.
      sampleInterval: row.weight === undefined ? Number.NaN : number(row.weight),
    };
    if (point.runId === "" || Number.isNaN(point.completedAtMs)) throw new Error("a history row has no runId or completedAtMs");
    return point;
  });
}

export interface SignalRecorderDeps {
  readonly environment: "development" | "production";
  readonly sink?: SignalsSink | undefined;
  readonly sql?: AnalyticsSql | undefined;
  readonly now: () => number;
  readonly delay: (ms: number) => Promise<void>;
}

export class SignalRecorder implements JobSignals {
  constructor(private readonly deps: SignalRecorderDeps) {}

  async finish(run: SignalRun): Promise<TrendResult> {
    const context: RunContext = { runId: run.runId, job: run.job };
    try {
      const missing = [...(this.deps.sink === undefined ? ["SIGNALS"] : []), ...(this.deps.sql === undefined ? ["ANALYTICS_SQL"] : [])];
      if (missing.length > 0) {
        const reason = `the ${missing.join(" and ")} binding is missing`;
        return { evaluatedAt: new Date(this.deps.now()).toISOString(), rules: trendRules(run, { ok: false, reason }), lastError: reason };
      }
      try {
        this.deps.sink!.writeDataPoint(metricPoint(run, this.deps.environment));
      } catch (error) {
        // OB14: without its own point the run's history would be judged incomplete; no query either.
        const reason = sanitizeErrorMessage(`writing the data point failed: ${errorText(error)}`);
        runLog(context, "error", reason);
        return { evaluatedAt: new Date(this.deps.now()).toISOString(), rules: trendRules(run, { ok: false, reason }), lastError: reason };
      }
      const history = await this.history(run);
      return {
        evaluatedAt: new Date(this.deps.now()).toISOString(),
        rules: trendRules(run, history),
        lastError: history.ok ? null : history.reason,
      };
    } catch (error) {
      const reason = sanitizeErrorMessage(`evaluating the signals failed: ${errorText(error)}`);
      runLog(context, "error", reason);
      return { evaluatedAt: new Date(this.deps.now()).toISOString(), rules: trendRules(run, { ok: false, reason }), lastError: reason };
    }
  }

  /** At most two attempts: a second only when the first error says `retryable`. */
  private async history(run: SignalRun): Promise<History> {
    const request = historyQuery(run.job, run.runId, this.deps.environment, this.deps.now());
    for (let attempt = 0; ; attempt += 1) {
      try {
        const answer = await this.deps.sql!.query(request);
        return { ok: true, points: historyPoints(answer.data) };
      } catch (error) {
        const retryable = (error as { retryable?: unknown } | null)?.retryable === true;
        if (attempt === 0 && retryable) {
          await this.deps.delay(SIGNAL_THRESHOLDS.retryDelayMs);
          continue;
        }
        return { ok: false, reason: sanitizeErrorMessage(`the history query failed: ${errorText(error)}`) };
      }
    }
  }
}
