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

/** Behavior 4: one parameterized `SELECT`, bounded by time and by `blob1`, the current run excluded. */
export function historyQuery(job: SignalJob, runId: string, environment: "development" | "production", now: number): { readonly query: string; readonly params: Record<string, string> } {
  return {
    query: [
      "SELECT index1 AS runId, blob3 AS status, double1 AS ok, double2 AS durationMs, double3 AS r2ClassA, double6 AS completedAtMs,",
      "double7 AS c1, double8 AS c2, double9 AS c3, double10 AS c4, double11 AS c5, double12 AS c6, _sample_interval AS sampleInterval",
      `FROM events.analyticsEngine."${signalsDataset(environment)}"`,
      "WHERE blob1 = $job AND index1 != $runId AND timestamp >= $start",
      `ORDER BY timestamp DESC LIMIT ${LIMIT}`,
    ].join(" "),
    params: { job, runId, start: new Date(now - SIGNAL_THRESHOLDS.historyDays * DAY).toISOString() },
  };
}

const number = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

function historyPoints(data: readonly unknown[]): HistoryPoint[] {
  return data.map((value) => {
    const row = (value ?? {}) as Record<string, unknown>;
    const point: HistoryPoint = {
      runId: String(row.runId ?? ""),
      status: String(row.status ?? ""),
      ok: number(row.ok) === 1,
      durationMs: number(row.durationMs),
      r2ClassA: number(row.r2ClassA),
      completedAtMs: number(row.completedAtMs),
      counters: [row.c1, row.c2, row.c3, row.c4, row.c5, row.c6].map(number),
      // A row without the column is treated as sampled: an exact rule must not run on it.
      sampleInterval: row.sampleInterval === undefined ? Number.NaN : number(row.sampleInterval),
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
