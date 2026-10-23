/**
 * Spec 014 Behavior 21–22: the `DigestRun` Durable Object's logic, kept free of Workers types so
 * it is testable. Runs start from the object's alarm (serialized like the publisher's); a dry run
 * runs inline and writes nothing; while the publisher is busy, the alarm re-arms (D59, D87).
 */
import { DAILY_CAP, type DigestProfile } from "@oss-knowledge-base/reference-pipeline";
import { runPending } from "../run-schedule";
import type { DigestModel } from "./model";
import { runDigest, type DigestRunResult } from "./run";
import type { DigestBucket } from "./store";
import { digestSignalRun, runIdFor } from "../signals/point";
import { runLog, type JobSignals, type RunContext } from "../signals/recorder";

export const DEFER_MS = 15 * 60_000;
export const MAX_DEFERRALS = 4;

/**
 * D59, D87: the digest waits while a publication runs or its alarm will still start one: a run
 * that is due, or a follow-up (a catch-up or a retry, Spec 018) that is waiting. It then reads the
 * release those runs end with. `status` is the publisher's `/status` body; `scheduled` is false
 * once an alarm is lost, so a follow-up marker left behind does not hold the digest.
 */
export function publisherBusy(status: unknown): boolean {
  const publisher = (status ?? {}) as { readonly running?: unknown; readonly scheduled?: unknown };
  return publisher.running === true || publisher.scheduled === true;
}

export interface DigestStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface DigestRunnerDeps {
  readonly storage: DigestStorage;
  readonly bucket: DigestBucket;
  readonly profile: DigestProfile;
  readonly environment: "development" | "production";
  /** `DIGEST_ENABLED=true`: off on Prod until its gateway exists (slice 2b). */
  readonly enabled: boolean;
  readonly model?: DigestModel;
  readonly now: () => Date;
  readonly delay: (ms: number) => Promise<void>;
  /** Whether the publisher runs or will still start a run (`publisherBusy` of its status). */
  readonly publisherBusy: () => Promise<boolean>;
  /** Spec 026 Behavior 9: true while the cost guard enforces an open breaker; absent is never. */
  readonly costGuardRefuses?: () => Promise<boolean>;
  /**
   * Spec 028: present only while `OBSERVABILITY_SIGNALS=on`. A run started by the alarm writes its
   * point and stores the trend result, its `runId`, `sourceRunId` and R2 counts in `lastRun`.
   */
  readonly signals?: { readonly recorder: JobSignals; readonly sourceRunId: (release: string) => Promise<string> };
}

/** Spec 026 Behavior 9: the answer of a request the cost guard refused. */
export const COST_GUARD_REFUSAL = { status: 503, body: { ok: false, skipped: "cost-guard" } } as const;

export interface DigestHealth {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly scheduled: boolean;
  readonly today: { readonly date: string; readonly estimatedNeurons: number; readonly cap: number };
  readonly lastRun: DigestRunResult | null;
}

export class DigestRunner {
  private running = false;

  constructor(private readonly deps: DigestRunnerDeps) {}

  private get cap(): number {
    return this.deps.environment === "production" ? DAILY_CAP.prod : DAILY_CAP.dev;
  }

  private today(): string {
    return this.deps.now().toISOString().slice(0, 10);
  }

  async health(): Promise<DigestHealth> {
    const date = this.today();
    const alarm = await this.deps.storage.getAlarm();
    return {
      enabled: this.deps.enabled,
      running: this.running,
      scheduled: runPending(false, alarm, this.deps.now().getTime()),
      today: { date, estimatedNeurons: (await this.deps.storage.get<number>(`spend:${date}`)) ?? 0, cap: this.cap },
      lastRun: (await this.deps.storage.get<DigestRunResult>("lastRun")) ?? null,
    };
  }

  /** `POST /digest/run[?dryRun=1]`: 409 while a run is pending or active (D22). */
  async request(dryRun: boolean): Promise<{ readonly status: number; readonly body: unknown }> {
    if (!this.deps.enabled) return { status: 403, body: { ok: false, disabled: true } };
    if (await this.deps.costGuardRefuses?.()) return COST_GUARD_REFUSAL;
    if (runPending(this.running, await this.deps.storage.getAlarm(), this.deps.now().getTime())) {
      return { status: 409, body: { ok: false, skipped: "already-running" } };
    }
    if (dryRun) {
      const result = await this.execute(true, 0);
      return { status: result.ok ? 200 : 500, body: result };
    }
    await this.deps.storage.delete("deferrals");
    await this.deps.storage.setAlarm(this.deps.now().getTime());
    return { status: 202, body: { ok: true, scheduled: true } };
  }

  /** The alarm: defer while the publisher is busy, at most four times, then run (D59, D87). */
  async alarm(): Promise<void> {
    if (!this.deps.enabled) return;
    const context: RunContext | undefined = this.deps.signals === undefined ? undefined : { runId: runIdFor("digest", this.deps.now().getTime()), job: "digest" };
    // Spec 026: a refused alarm runs nothing and is not re-armed; the next cron or request starts again.
    if (await this.deps.costGuardRefuses?.()) {
      runLog(context, "log", "digest: refused by the cost guard");
      return;
    }
    const deferrals = (await this.deps.storage.get<number>("deferrals")) ?? 0;
    if (deferrals < MAX_DEFERRALS && await this.deps.publisherBusy()) {
      await this.deps.storage.put("deferrals", deferrals + 1);
      await this.deps.storage.setAlarm(this.deps.now().getTime() + DEFER_MS);
      return;
    }
    await this.deps.storage.delete("deferrals");
    await this.execute(false, deferrals, context);
  }

  private async execute(dryRun: boolean, deferred: number, context?: RunContext): Promise<DigestRunResult> {
    this.running = true;
    const r2Before = this.deps.bucket.operationCounts?.();
    try {
      const date = this.today();
      const spentToday = (await this.deps.storage.get<number>(`spend:${date}`)) ?? 0;
      const result = await runDigest({
        bucket: this.deps.bucket,
        profile: this.deps.profile,
        now: this.deps.now,
        ...(this.deps.model === undefined ? {} : { model: this.deps.model }),
        delay: this.deps.delay,
        spentToday,
        cap: this.cap,
        // D93: a run that dies must leave the spend it made for the alarm's retry.
        reserveSpend: (spent) => this.deps.storage.put(`spend:${date}`, spent),
        dryRun,
        deferred,
      });
      await this.deps.storage.put(`spend:${date}`, result.spentToday);
      // Dry-run objects and raw samples go only to the authenticated caller; the stored lastRun is
      // served by the public /health (D81).
      let recorded: DigestRunResult = { ...result };
      delete (recorded as { objects?: unknown }).objects;
      delete (recorded as { rawSamples?: unknown }).rawSamples;
      if (context !== undefined && this.deps.signals !== undefined) recorded = await this.withSignals(recorded, context, r2Before);
      await this.deps.storage.put("lastRun", recorded);
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Spec 028 Behaviors 2, 3, 14: the point and the trend result, in the `lastRun` write the run already makes (D8: with its R2 counts). */
  private async withSignals(recorded: DigestRunResult, context: RunContext, r2Before: { readonly classA: number; readonly classB: number } | undefined): Promise<DigestRunResult> {
    const signals = this.deps.signals!;
    const after = this.deps.bucket.operationCounts?.();
    const r2 = r2Before === undefined || after === undefined ? undefined : { classA: after.classA - r2Before.classA, classB: after.classB - r2Before.classB };
    const sourceRunId = recorded.sourceReleaseId === null ? "" : await signals.sourceRunId(recorded.sourceReleaseId).catch(() => "");
    const withCounts = { ...recorded, runId: context.runId, sourceRunId, ...(r2 === undefined ? {} : { r2 }) };
    return { ...withCounts, trends: await signals.recorder.finish(digestSignalRun(withCounts, { runId: context.runId, sourceRunId })) };
  }
}
