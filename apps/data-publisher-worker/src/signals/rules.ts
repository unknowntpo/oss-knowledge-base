/**
 * Spec 028 Behaviors 5–7 and 15–16: the rules. `trendRules` judges one finished run against the job's
 * previous data points (analytics, at the end of the run); `signalsHealth` judges the `/health` body it
 * is given (state, at read time) and adds the trend results each job stored with its own record. Both
 * are pure: no binding, no read. Missing data is `unknown`, never `firing`.
 */
import type { SignalRun } from "./point";
import { R2_COUNTED, SIGNAL_THRESHOLDS as T, WALL_BUDGET_MS, type SignalJob } from "./profile";

export type RuleStatus = "ok" | "warn" | "firing" | "unknown";

/** One `/health.signals.rules[]` entry (the Spec 027 hand-off contract, Behavior 7). */
export interface RuleEntry {
  readonly id: string;
  readonly job: SignalJob;
  readonly source: "state" | "analytics";
  readonly status: RuleStatus;
  readonly value: number | null;
  readonly threshold: string;
  /** When the condition first held; null unless warn or firing. */
  readonly since: string | null;
  /** The newest run that shows it. */
  readonly runId: string | null;
  /** The publication's source for `source.success`. */
  readonly subject?: string;
  /** Why an entry is `unknown`, or what it assumed (`r2.classAInvariant` on a record without its counters). */
  readonly reason?: string;
}

/** One previous data point of the same job, as the history query returns it. */
export interface HistoryPoint {
  readonly runId: string;
  readonly status: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly r2ClassA: number;
  readonly completedAtMs: number;
  readonly counters: readonly number[];
  readonly sampleInterval: number;
}

export type History = { readonly ok: true; readonly points: readonly HistoryPoint[] } | { readonly ok: false; readonly reason: string };

/** Stored by each job in the status write it already makes (Behavior 4, 17). */
export interface TrendResult {
  readonly evaluatedAt: string;
  readonly rules: readonly RuleEntry[];
  readonly lastError: string | null;
}

export interface SignalsHealth {
  readonly status: Exclude<RuleStatus, "unknown">;
  readonly evaluatedAt: string;
  readonly analyticsEvaluatedAt: string | null;
  readonly rules: readonly RuleEntry[];
  readonly lastError: string | null;
}

const PUBLICATION_SOURCES = ["github", "mail", "jira"] as const;
const iso = (ms: number) => new Date(ms).toISOString();
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

interface RuleKey { readonly id: string; readonly subject?: string; readonly threshold: string }

/** The analytics rules a job has (Behavior 5 and 16); `job.r2ClassA` only for a job that counts R2. */
function analyticsRules(job: SignalJob, countsR2: boolean): readonly RuleKey[] {
  const budget = WALL_BUDGET_MS[job];
  return [
    { id: "job.failures", threshold: "warn: the run failed; firing: 2 consecutive runs failed" },
    { id: "job.duration", threshold: `warn: > ${T.durationFactor} × median of the previous runs (≥ ${T.minHistory})${budget === undefined ? "" : `; firing: ≥ ${T.wallBudgetShare * 100} % of ${budget} ms`}` },
    ...(countsR2 ? [{ id: "job.r2ClassA", threshold: `warn: > ${T.r2WarnFactor} × median and > ${T.r2WarnFloor}; firing: > ${T.r2FiringFactor} × median and > ${T.r2FiringFloor}` }] : []),
    ...(job === "publication"
      ? [
          ...PUBLICATION_SOURCES.map((subject) => ({ id: "source.success", subject, threshold: "warn: the run's source failed; firing: the newest runs of 2 consecutive UTC days failed" })),
          { id: "publication.pollTruncated", threshold: `warn: the run truncated; firing: truncated for > ${T.pollTruncatedFiringMs} ms` },
        ]
      : []),
    ...(job === "digest" ? [{ id: "digest.rejections", threshold: `firing: ≥ ${T.rejectionsFloor} and > ${T.rejectionsFactor} × median of the previous runs (≥ ${T.minHistory})` }] : []),
  ];
}

const unknownEntries = (job: SignalJob, countsR2: boolean, runId: string | null, reason: string): RuleEntry[] =>
  analyticsRules(job, countsR2).map((key) => ({
    id: key.id, job, source: "analytics", status: "unknown", value: null, threshold: key.threshold, since: null, runId,
    ...(key.subject === undefined ? {} : { subject: key.subject }), reason,
  }));

/** The previous runs, newest first: one per `runId` (a retried run counts once), at most `historyRuns`. */
export function previousRuns(points: readonly HistoryPoint[], runId: string): HistoryPoint[] {
  const seen = new Set<string>([runId]);
  const runs: HistoryPoint[] = [];
  for (const point of [...points].sort((a, b) => b.completedAtMs - a.completedAtMs)) {
    if (seen.has(point.runId)) continue;
    seen.add(point.runId);
    runs.push(point);
  }
  return runs.slice(0, T.historyRuns);
}

/** Behavior 16 (and 5 for the publication's and the digest's own rules): one finished run. */
export function trendRules(current: SignalRun, history: History): RuleEntry[] {
  const countsR2 = R2_COUNTED[current.job] && current.r2 !== null;
  if (!history.ok) return unknownEntries(current.job, countsR2, current.runId, history.reason);
  const previous = previousRuns(history.points, current.runId);
  // Behavior 6: an exact rule never runs on a sample.
  if (previous.some((point) => point.sampleInterval !== 1)) return unknownEntries(current.job, countsR2, current.runId, "sampled");
  const done = iso(current.completedAtMs);
  return analyticsRules(current.job, countsR2).map((key) => {
    const base = { id: key.id, job: current.job, source: "analytics" as const, threshold: key.threshold, runId: current.runId, ...(key.subject === undefined ? {} : { subject: key.subject }) };
    const judged = (status: RuleStatus, value: number | null, since: string | null = null, reason?: string): RuleEntry =>
      ({ ...base, status, value, since: status === "warn" || status === "firing" ? since : null, ...(reason === undefined ? {} : { reason }) });
    const fewer = (values: readonly number[]) => values.length < T.minHistory;
    switch (key.id) {
      case "job.failures": {
        if (current.ok) return judged("ok", 0);
        let streak = 1;
        let start = current.completedAtMs;
        for (const point of previous) {
          if (point.ok) break;
          streak += 1;
          start = point.completedAtMs;
        }
        return judged(streak >= 2 ? "firing" : "warn", streak, iso(start));
      }
      case "job.duration": {
        const budget = WALL_BUDGET_MS[current.job];
        if (budget !== undefined && current.durationMs >= T.wallBudgetShare * budget) return judged("firing", current.durationMs, done);
        const durations = previous.map((point) => point.durationMs);
        if (fewer(durations)) return judged("unknown", current.durationMs, null, `fewer than ${T.minHistory} previous runs`);
        return judged(current.durationMs > T.durationFactor * median(durations) ? "warn" : "ok", current.durationMs, done);
      }
      case "job.r2ClassA": {
        const classA = current.r2!.classA;
        const values = previous.map((point) => point.r2ClassA);
        if (fewer(values)) return judged("unknown", classA, null, `fewer than ${T.minHistory} previous runs`);
        const middle = median(values);
        if (classA > T.r2FiringFactor * middle && classA > T.r2FiringFloor) return judged("firing", classA, done);
        return judged(classA > T.r2WarnFactor * middle && classA > T.r2WarnFloor ? "warn" : "ok", classA, done);
      }
      case "source.success": {
        const slot = PUBLICATION_SOURCES.indexOf(key.subject as (typeof PUBLICATION_SOURCES)[number]);
        if (current.counters[slot] === 1) return judged("ok", 0);
        // The newest point of each UTC day, the current run being the newest of its own day.
        const newestByDay = new Map<number, HistoryPoint | SignalRun>([[utcDay(current.completedAtMs), current]]);
        for (const point of previous) if (!newestByDay.has(utcDay(point.completedAtMs))) newestByDay.set(utcDay(point.completedAtMs), point);
        let days = 0;
        let start = current.completedAtMs;
        for (let day = utcDay(current.completedAtMs); ; day -= 1) {
          const newest = newestByDay.get(day);
          if (newest === undefined || newest.counters[slot] === 1) break;
          days += 1;
          start = newest.completedAtMs;
        }
        return judged(days >= 2 ? "firing" : "warn", days, iso(start));
      }
      case "publication.pollTruncated": {
        if (current.counters[3] !== 1) return judged("ok", 0);
        let start = current.completedAtMs;
        for (const point of previous) {
          if (point.counters[3] !== 1) break;
          start = point.completedAtMs;
        }
        const age = current.completedAtMs - start;
        return age > T.pollTruncatedFiringMs ? judged("firing", age, iso(start + T.pollTruncatedFiringMs)) : judged("warn", age, iso(start));
      }
      case "digest.rejections": {
        const rejections = current.counters[1] ?? 0;
        const values = previous.map((point) => point.counters[1] ?? 0);
        if (fewer(values)) return judged("unknown", rejections, null, `fewer than ${T.minHistory} previous runs`);
        return judged(rejections >= T.rejectionsFloor && rejections > T.rejectionsFactor * median(values) ? "firing" : "ok", rejections, done);
      }
      default:
        throw new Error(`no rule ${key.id}`);
    }
  });
}

const utcDay = (ms: number) => Math.floor(ms / 86_400_000);

type Record_ = Readonly<Record<string, unknown>>;
const object = (value: unknown): Record_ | undefined => (value !== null && typeof value === "object" ? value as Record_ : undefined);
const time = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** An age rule: warn above `warnMs` (when given), firing above `firingMs`. */
function ageEntry(id: string, job: SignalJob, at: number | undefined, now: number, limits: { readonly warnMs?: number; readonly firingMs: number }, runId: string | null, missing: string): RuleEntry {
  const threshold = `${limits.warnMs === undefined ? "" : `warn: > ${limits.warnMs} ms; `}firing: > ${limits.firingMs} ms`;
  const base = { id, job, source: "state" as const, threshold, runId };
  if (at === undefined) return { ...base, status: "unknown", value: null, since: null, reason: missing };
  const age = now - at;
  if (age > limits.firingMs) return { ...base, status: "firing", value: age, since: iso(at + limits.firingMs) };
  if (limits.warnMs !== undefined && age > limits.warnMs) return { ...base, status: "warn", value: age, since: iso(at + limits.warnMs) };
  return { ...base, status: "ok", value: age, since: null };
}

const DAILY = { warnMs: T.dailyWarnMs, firingMs: T.dailyFiringMs } as const;

const INVARIANT_THRESHOLD = `excess = classA − (copiedObjectCount + ${T.classAInvariantSlack} + putRetries + min(conditionalMisses, ${T.classAInvariantMissCap})); `
  + `warn: excess > ${T.classAInvariantWarnExcess}; firing: excess > max(${T.classAInvariantFiringFloor}, ${T.classAInvariantFiringShare} × copiedObjectCount)`;

/**
 * Behavior 5, `r2.classAInvariant` (D11): Class A beyond one put per new object, the two pointers
 * and the evidence object, and beyond what the run's own put retries and (at most 50) conditional
 * misses explain; the cap keeps a recurrence of 2026-10-13 (a miss on every existing key) firing.
 * A record written before those counters existed counts them as 0, and the entry says so.
 */
function classAInvariant(lastRun: Record_ | undefined, runId: string | null): RuleEntry {
  const base = { id: "r2.classAInvariant", job: "publication" as const, source: "state" as const, threshold: INVARIANT_THRESHOLD, runId };
  const r2 = object(lastRun?.r2);
  const classA = r2?.classA;
  const copied = lastRun?.copiedObjectCount;
  if (lastRun?.ok !== true || typeof classA !== "number" || typeof copied !== "number") {
    return { ...base, status: "unknown", value: null, since: null, reason: "the last run has no R2 counts" };
  }
  const counted = typeof r2?.putRetries === "number" && typeof r2.conditionalMisses === "number";
  const explained = counted ? (r2.putRetries as number) + Math.min(r2.conditionalMisses as number, T.classAInvariantMissCap) : 0;
  const excess = classA - (copied + T.classAInvariantSlack + explained);
  const status: RuleStatus = excess > Math.max(T.classAInvariantFiringFloor, T.classAInvariantFiringShare * copied) ? "firing"
    : excess > T.classAInvariantWarnExcess ? "warn" : "ok";
  return {
    ...base, status, value: classA, since: status === "ok" ? null : text(lastRun.completedAt),
    ...(counted ? {} : { reason: "putRetries and conditionalMisses missing from the record, counted as 0" }),
  };
}

interface JobView {
  readonly job: SignalJob;
  /** The job's stored trend result, if a run evaluated one. */
  readonly trends: unknown;
  readonly runId: string | null;
}

/** Behavior 5 (state rules) and 15 (`job.missed`), from the body `/health` already built. */
function stateRules(health: Record_, now: number): { readonly rules: RuleEntry[]; readonly jobs: JobView[] } {
  const rules: RuleEntry[] = [];
  const jobs: JobView[] = [];

  const lastRun = object(health.lastRun);
  const publicationRunId = text(lastRun?.runId);
  const sources = Object.values(object(lastRun?.sources) ?? {}).map((source) => time(object(source)?.lastSuccessAt)).filter((at): at is number => at !== undefined);
  const newestSuccess = sources.length > 0 ? Math.max(...sources) : lastRun?.ok === true ? time(lastRun.completedAt) : undefined;
  rules.push(ageEntry("publication.freshness", "publication", newestSuccess, now, DAILY, publicationRunId, "no successful run recorded"));
  rules.push(classAInvariant(lastRun, publicationRunId));
  rules.push(ageEntry("job.missed", "publication", time(lastRun?.completedAt), now, DAILY, publicationRunId, "no run yet"));
  jobs.push({ job: "publication", trends: lastRun?.trends, runId: publicationRunId });

  const digest = object(health.digest);
  if (digest?.enabled === true) {
    const run = object(digest.lastRun);
    const runId = text(run?.runId);
    rules.push(ageEntry("digest.freshness", "digest", run?.ok === true ? time(run.completedAt) : undefined, now, { firingMs: T.digestFreshnessFiringMs }, runId,
      run === undefined ? "no run yet" : "the last run failed (see job.failures)"));
    rules.push(ageEntry("job.missed", "digest", time(run?.completedAt), now, DAILY, runId, "no run yet"));
    jobs.push({ job: "digest", trends: run?.trends, runId });
  }

  const embedding = object(health.searchEmbedding);
  if (embedding?.enabled === true) {
    const run = object(embedding.lastRun);
    const runId = text(run?.runId);
    const pending = typeof run?.pending === "number" ? run.pending : 0;
    const limits = { warnMs: T.embeddingWarnMs, firingMs: T.embeddingFiringMs };
    // It continues hourly only while chunks are pending; with none pending, no run is due.
    rules.push(run !== undefined && pending === 0
      ? { id: "job.missed", job: "embedding", source: "state", status: "ok", value: now - (time(run.completedAt) ?? now), threshold: `only while pending > 0; warn: > ${limits.warnMs} ms; firing: > ${limits.firingMs} ms`, since: null, runId }
      : ageEntry("job.missed", "embedding", time(run?.completedAt), now, limits, runId, "no run yet"));
    jobs.push({ job: "embedding", trends: run?.trends, runId });
  }

  if ("costGuard" in health) {
    const guard = object(health.costGuard);
    const runId = text(guard?.runId);
    rules.push(ageEntry("job.missed", "cost-guard", time(guard?.checkedAt), now, DAILY, runId, guard === undefined ? "the cost guard did not answer" : "no check yet"));
    jobs.push({ job: "cost-guard", trends: guard?.trends, runId });
  }

  // Jobs whose record is `last-run.json`: present only while their flag is set; null before the first run or on a read error.
  for (const [key, job] of [["identityLinks", "identity-links"], ["kipPages", "kip-pages"], ["retention", "retention"]] as const) {
    if (!(key in health)) continue;
    const run = object(object(health[key])?.lastRun);
    const runId = text(run?.runId);
    const started = time(run?.at);
    const finished = started === undefined ? undefined : started + (typeof run?.durationMs === "number" ? run.durationMs : typeof run?.elapsedMs === "number" ? run.elapsedMs : 0);
    rules.push(ageEntry("job.missed", job, finished, now, DAILY, runId, "no run yet"));
    jobs.push({ job, trends: run?.trends, runId });
  }
  return { rules, jobs };
}

function storedTrends(value: unknown): TrendResult | undefined {
  const trends = object(value);
  return trends !== undefined && typeof trends.evaluatedAt === "string" && Array.isArray(trends.rules) ? trends as unknown as TrendResult : undefined;
}

const RANK: Readonly<Record<RuleStatus, number>> = { unknown: 0, ok: 0, warn: 1, firing: 2 };

/** Behavior 7: `/health.signals`, from the body `/health` already read (Behavior 18: no read of its own). */
export function signalsHealth(health: Record_, now: number): SignalsHealth {
  const { rules: state, jobs } = stateRules(health, now);
  const stored = jobs.map((view) => ({ view, trends: storedTrends(view.trends) }));
  const analytics = stored.flatMap(({ view, trends }) => trends?.rules
    ?? unknownEntries(view.job, R2_COUNTED[view.job], view.runId, "no evaluated run yet"));
  const rules = [...state, ...analytics];
  const evaluated = stored.map(({ trends }) => trends).filter((trends): trends is TrendResult => trends !== undefined)
    .sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
  const worst = Math.max(0, ...rules.map((rule) => RANK[rule.status] ?? 0));
  return {
    status: worst === 2 ? "firing" : worst === 1 ? "warn" : "ok",
    evaluatedAt: iso(now),
    analyticsEvaluatedAt: evaluated[0]?.evaluatedAt ?? null,
    rules,
    lastError: evaluated.find((trends) => trends.lastError !== null)?.lastError ?? null,
  };
}
