/**
 * Spec 014 Behavior 21–22: the `DigestRun` Durable Object's logic, kept free of Workers types so
 * it is testable. Runs start from the object's alarm (serialized like the publisher's); a dry run
 * runs inline and writes nothing; while the publisher runs, the alarm re-arms (D59).
 */
import { DAILY_CAP, type DigestProfile } from "@oss-knowledge-base/reference-pipeline";
import { runPending } from "../run-schedule";
import type { DigestModel } from "./model";
import { runDigest, type DigestRunResult } from "./run";
import type { DigestBucket } from "./store";

export const DEFER_MS = 15 * 60_000;
export const MAX_DEFERRALS = 4;

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
  /** Whether the hourly publisher reports a running publication (`/health.running`). */
  readonly publisherRunning: () => Promise<boolean>;
}

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

  /** The alarm: defer while the publisher runs, at most four times, then run (D59). */
  async alarm(): Promise<void> {
    if (!this.deps.enabled) return;
    const deferrals = (await this.deps.storage.get<number>("deferrals")) ?? 0;
    if (deferrals < MAX_DEFERRALS && await this.deps.publisherRunning()) {
      await this.deps.storage.put("deferrals", deferrals + 1);
      await this.deps.storage.setAlarm(this.deps.now().getTime() + DEFER_MS);
      return;
    }
    await this.deps.storage.delete("deferrals");
    await this.execute(false, deferrals);
  }

  private async execute(dryRun: boolean, deferred: number): Promise<DigestRunResult> {
    this.running = true;
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
        dryRun,
        deferred,
      });
      await this.deps.storage.put(`spend:${date}`, result.spentToday);
      // Dry-run objects are returned to the caller, not stored in the Durable Object.
      const recorded: DigestRunResult = { ...result };
      delete (recorded as { objects?: unknown }).objects;
      await this.deps.storage.put("lastRun", recorded);
      return result;
    } finally {
      this.running = false;
    }
  }
}
