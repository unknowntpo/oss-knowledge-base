/**
 * Spec 029 Behavior 2: retention as its own job inside the publication's Durable Object. Its own
 * storage keys (`retention-*`), its own alarm invocation, its own status. It never reads or writes
 * the publication's keys (`status`, `phase`, `requested-at`, `follow-up`) and never throws.
 */
import { runPending } from "../run-schedule";
import { resolveRetentionMode } from "./plan";
import type { RetentionLastRun, RetentionReport } from "./run";

export const RETENTION_PENDING_KEY = "retention-pending";
export const RETENTION_DAY_KEY = "retention-day";
export const RETENTION_LAST_RUN_KEY = "retention-last-run";
export const RETENTION_REPORT_KEY = "retention-report";
export const RETENTION_SKIP_KEY = "retention-skip";

export type RetentionSkipReason = "publication-pending" | "already-ran-today" | "paused";

export interface RetentionSkip { readonly reason: RetentionSkipReason; readonly at: string }

export interface RetentionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

const day = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * `POST /retention` (the retention cron's tick): records a skip, or marks retention pending and
 * sets the alarm. A scheduled alarm (a requested run, a follow-up, a retry) is left as it was.
 */
export async function requestRetention(storage: RetentionStorage, input: { readonly running: boolean; readonly paused: boolean; readonly now: number }): Promise<{ readonly status: number; readonly body: unknown }> {
  const skip = async (reason: RetentionSkipReason) => {
    await storage.put(RETENTION_SKIP_KEY, { reason, at: new Date(input.now).toISOString() } satisfies RetentionSkip);
    return { status: 200, body: { ok: true, skipped: reason } };
  };
  if (input.paused) return skip("paused");
  if (runPending(input.running, await storage.getAlarm(), input.now)) return skip("publication-pending");
  if (await storage.get<string>(RETENTION_DAY_KEY) === day(input.now)) return skip("already-ran-today");
  await storage.put(RETENTION_PENDING_KEY, new Date(input.now).toISOString());
  await storage.setAlarm(input.now);
  return { status: 202, body: { ok: true, scheduled: true } };
}

/**
 * The alarm's first step. Returns true when the alarm was retention's (so the publication must not
 * run). With `requested-at` set too, the publication wins and retention is recorded skipped.
 */
export async function retentionAlarm(
  storage: RetentionStorage,
  input: {
    readonly flag: string | undefined;
    readonly now: () => number;
    readonly paused: () => Promise<boolean>;
    readonly run: () => Promise<{ readonly lastRun: RetentionLastRun; readonly report: RetentionReport | null }>;
  },
): Promise<boolean> {
  if (await storage.get<string>(RETENTION_PENDING_KEY) === undefined) return false;
  const at = () => new Date(input.now()).toISOString();
  if (await storage.get<string>("requested-at") !== undefined) {
    await storage.delete(RETENTION_PENDING_KEY);
    await storage.put(RETENTION_SKIP_KEY, { reason: "publication-pending", at: at() } satisfies RetentionSkip);
    return false;
  }
  try {
    // The flag turned off or unconfigured after the tick: nothing runs, and no publication either.
    if (resolveRetentionMode(input.flag).mode !== "dry-run") return true;
    if (await input.paused()) {
      await storage.put(RETENTION_SKIP_KEY, { reason: "paused", at: at() } satisfies RetentionSkip);
      return true;
    }
    // Written before the run, so a retried alarm and a second tick today do not list again.
    await storage.put(RETENTION_DAY_KEY, day(input.now()));
    const { lastRun, report } = await input.run();
    await storage.put(RETENTION_LAST_RUN_KEY, lastRun);
    if (report !== null) await storage.put(RETENTION_REPORT_KEY, report);
  } catch (error) {
    await storage.put(RETENTION_LAST_RUN_KEY, { runId: `retention-${day(input.now())}`, at: at(), mode: "dry-run", status: "failed", failureKind: "internal", error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }).catch(() => undefined);
  } finally {
    await storage.delete(RETENTION_PENDING_KEY).catch(() => undefined);
  }
  return true;
}

/** Behavior 9: `/health` `retention`. A skip newer than the last run is the status. */
export async function retentionHealth(storage: Pick<RetentionStorage, "get">, flag: string | undefined): Promise<unknown> {
  const { mode, reason } = resolveRetentionMode(flag);
  if (mode === "off") return undefined;
  if (mode === "unconfigured") return { mode: "unconfigured", status: "unconfigured", reason, lastRun: null };
  const lastRun = await storage.get<RetentionLastRun>(RETENTION_LAST_RUN_KEY) ?? null;
  const skip = await storage.get<RetentionSkip>(RETENTION_SKIP_KEY) ?? null;
  if (skip !== null && (lastRun === null || skip.at >= lastRun.at)) return { mode, status: "skipped", reason: skip.reason, lastRun };
  if (lastRun === null) return { mode, status: "pending", reason: null, lastRun };
  return { mode, status: lastRun.status, reason: lastRun.reason ?? null, lastRun };
}
