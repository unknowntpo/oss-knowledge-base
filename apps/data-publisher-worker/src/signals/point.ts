/**
 * Spec 028 Behaviors 2, 3, 13: a run's identity and its one data point, built from values already in
 * that job's own status record. Pure: no binding, no clock.
 */
import type { PipelineRunStatus } from "../pipeline";
import { R2_COUNTED, type SignalJob } from "./profile";

/** Behavior 2: `<job>-<startedAt, ISO with ":" and "." replaced by "-">`. */
export function runIdFor(job: SignalJob, startedAt: string | number): string {
  const at = new Date(startedAt);
  if (Number.isNaN(at.valueOf())) throw new Error("a run's start must be a timestamp");
  return `${job}-${at.toISOString().replace(/[:.]/gu, "-")}`;
}

/** One finished run of one job, in the common shape every job maps its record to. */
export interface SignalRun {
  readonly job: SignalJob;
  readonly runId: string;
  /** The job's own word (`ok`, `failed`, `unchanged`, `no-input`, `over-budget`, `warn`, …). */
  readonly status: string;
  /** Whether the job counts this run as good (`unchanged` and `no-input` are). */
  readonly ok: boolean;
  /** The other job's run whose output this run read; "" when none or unknown. */
  readonly sourceRunId: string;
  readonly durationMs: number;
  readonly completedAtMs: number;
  /** The job's own R2 requests; null when it does not count them (`r2Counted` 0). */
  readonly r2: { readonly classA: number; readonly classB: number } | null;
  /** c1–c6 of Behavior 13's table; missing slots are 0. */
  readonly counters: readonly number[];
}

export interface DataPoint {
  readonly indexes: [string];
  readonly blobs: [string, string, string, string];
  readonly doubles: number[];
}

const flag = (value: boolean | undefined) => (value === true ? 1 : 0);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const sum = (record: Readonly<Record<string, unknown>> | undefined) => Object.values(record ?? {}).reduce<number>((total, value) => total + num(value), 0);
const r2Of = (job: SignalJob, r2: { readonly classA?: unknown; readonly classB?: unknown } | null | undefined) =>
  R2_COUNTED[job] && r2 !== null && r2 !== undefined ? { classA: num(r2.classA), classB: num(r2.classB) } : null;

/** Behavior 13: `indexes [runId]`, `blobs [job, env, status, sourceRunId]`, 12 doubles. */
export function metricPoint(run: SignalRun, environment: "development" | "production"): DataPoint {
  const counters = Array.from({ length: 6 }, (_, index) => num(run.counters[index]));
  return {
    indexes: [run.runId],
    blobs: [run.job, environment, run.status, run.sourceRunId],
    doubles: [flag(run.ok), num(run.durationMs), run.r2?.classA ?? 0, run.r2?.classB ?? 0, run.r2 === null ? 0 : 1, num(run.completedAtMs), ...counters],
  };
}

/**
 * The publication. Its `completedAt` is the materialization time (the run's start for a cron run),
 * so the run's duration and finish come from the clock: `finishedAtMs` − `startedAtMs` (the trigger).
 */
export function publicationSignalRun(status: PipelineRunStatus, context: { readonly runId: string; readonly startedAtMs: number; readonly finishedAtMs: number }): SignalRun {
  const sources = status.sources;
  const sourceOk = (key: string) => flag(sources === undefined ? key === "github" && status.ok : sources[key]?.ok);
  return {
    job: "publication",
    runId: context.runId,
    status: status.ok ? "ok" : "failed",
    ok: status.ok,
    sourceRunId: "",
    durationMs: Math.max(0, context.finishedAtMs - context.startedAtMs),
    completedAtMs: context.finishedAtMs,
    r2: r2Of("publication", status.r2),
    counters: [
      sourceOk("github"), sourceOk("mail"), sourceOk("jira"),
      status.ok ? flag(status.pollTruncated) : 0,
      status.ok ? status.copiedObjectCount : 0,
      status.ok ? status.reusedObjectCount : 0,
    ],
  };
}

interface TimedRecord {
  readonly ok: boolean;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly r2?: { readonly classA: number; readonly classB: number } | undefined;
}

export function digestSignalRun(
  result: TimedRecord & { readonly candidates: number; readonly rejections: Readonly<Record<string, unknown>> },
  context: { readonly runId: string; readonly sourceRunId: string },
): SignalRun {
  return {
    job: "digest", runId: context.runId, status: result.ok ? "ok" : "failed", ok: result.ok, sourceRunId: context.sourceRunId,
    durationMs: num(result.durationMs), completedAtMs: Date.parse(result.completedAt), r2: r2Of("digest", result.r2),
    counters: [num(result.candidates), sum(result.rejections)],
  };
}

export function embeddingSignalRun(
  result: TimedRecord & { readonly embeddedThisRun: number; readonly pending: number; readonly quarantined: number; readonly deletedThisRun: number },
  context: { readonly runId: string; readonly sourceRunId: string },
): SignalRun {
  return {
    job: "embedding", runId: context.runId, status: result.ok ? "ok" : "failed", ok: result.ok, sourceRunId: context.sourceRunId,
    durationMs: num(result.durationMs), completedAtMs: Date.parse(result.completedAt), r2: r2Of("embedding", result.r2),
    counters: [result.embeddedThisRun, result.pending, result.quarantined, result.deletedThisRun],
  };
}

/** The cost guard: no R2 call (`r2Counted` 0); the budget fields are 0 until Spec 026's amendment lands. */
export function costGuardSignalRun(
  check: {
    readonly ok: boolean;
    readonly status: string;
    readonly breaker: { readonly tripped: boolean };
    readonly budget?: { readonly overageUsd?: number; readonly projectedOverageUsd?: number };
    readonly r2ClassASpike?: { readonly last24h?: number };
  },
  context: { readonly runId: string; readonly startedAtMs: number; readonly finishedAtMs: number },
): SignalRun {
  return {
    job: "cost-guard", runId: context.runId, status: check.status, ok: check.ok, sourceRunId: "",
    durationMs: Math.max(0, context.finishedAtMs - context.startedAtMs), completedAtMs: context.finishedAtMs, r2: null,
    counters: [flag(check.breaker.tripped), num(check.budget?.overageUsd), num(check.budget?.projectedOverageUsd), num(check.r2ClassASpike?.last24h)],
  };
}

/** Spec 029's run record as its Behavior 10 reserves it (the job is not implemented yet). */
export interface RetentionLastRun {
  readonly ok: boolean;
  readonly status: string;
  readonly at: string;
  readonly elapsedMs: number;
  readonly dryRun: boolean;
  readonly deleted: { readonly objects: number; readonly bytes: number };
  readonly remaining: number;
  readonly candidates: { readonly objects: number };
  readonly r2: { readonly classA: number; readonly classB: number };
}

export function retentionSignalRun(lastRun: RetentionLastRun, context: { readonly runId: string }): SignalRun {
  return {
    job: "retention", runId: context.runId, status: lastRun.status, ok: lastRun.ok, sourceRunId: "",
    durationMs: num(lastRun.elapsedMs), completedAtMs: Date.parse(lastRun.at) + num(lastRun.elapsedMs), r2: r2Of("retention", lastRun.r2),
    counters: [lastRun.deleted.objects, lastRun.deleted.bytes, lastRun.remaining, lastRun.candidates.objects, flag(lastRun.dryRun)],
  };
}

interface StartedRecord {
  readonly ok: boolean;
  readonly status: string;
  /** When the run started. */
  readonly at: string;
  readonly durationMs: number;
  readonly r2: { readonly classA: number; readonly classB: number };
}

export function identityLinksSignalRun(
  lastRun: StartedRecord & { readonly links: { readonly corroborated: number }; readonly rejected: Readonly<Record<string, number>>; readonly people: number; readonly bytesWritten: number },
  context: { readonly runId: string },
): SignalRun {
  return {
    job: "identity-links", runId: context.runId, status: lastRun.status, ok: lastRun.ok, sourceRunId: "",
    durationMs: num(lastRun.durationMs), completedAtMs: Date.parse(lastRun.at) + num(lastRun.durationMs), r2: r2Of("identity-links", lastRun.r2),
    counters: [lastRun.links.corroborated, sum(lastRun.rejected), lastRun.people, lastRun.bytesWritten],
  };
}

export function kipPagesSignalRun(
  lastRun: StartedRecord & { readonly pagesRead: number; readonly pagesChanged: number; readonly issuesRead: number; readonly requests: number; readonly bytesWritten: number },
  context: { readonly runId: string },
): SignalRun {
  return {
    job: "kip-pages", runId: context.runId, status: lastRun.status, ok: lastRun.ok, sourceRunId: "",
    durationMs: num(lastRun.durationMs), completedAtMs: Date.parse(lastRun.at) + num(lastRun.durationMs), r2: r2Of("kip-pages", lastRun.r2),
    counters: [lastRun.pagesRead, lastRun.pagesChanged, lastRun.issuesRead, lastRun.requests, lastRun.bytesWritten],
  };
}

/** Spec 019 amendment (8): c1 pull requests read, c2 with a key, c3 keys, c4 GitHub and c5 Jira requests, c6 bytes written. */
export function identityBackfillSignalRun(
  lastRun: StartedRecord & { readonly prs: number; readonly keyedPrs: number; readonly keys: number; readonly requests: { readonly github: number; readonly jira: number }; readonly bytesWritten: number },
  context: { readonly runId: string },
): SignalRun {
  return {
    job: "identity-backfill", runId: context.runId, status: lastRun.status, ok: lastRun.ok, sourceRunId: "",
    durationMs: num(lastRun.durationMs), completedAtMs: Date.parse(lastRun.at) + num(lastRun.durationMs), r2: r2Of("identity-backfill", lastRun.r2),
    counters: [lastRun.prs, lastRun.keyedPrs, lastRun.keys, lastRun.requests.github, lastRun.requests.jira, lastRun.bytesWritten],
  };
}
