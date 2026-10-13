/**
 * An alarm still registered this long after its scheduled time will never fire: the runtime
 * gave up retrying it. It covers the 15-minute alarm wall-time limit plus retry backoff.
 */
export const STALE_ALARM_MS = 30 * 60_000;

/** Whether a run is already active or will still start, so a new trigger must not schedule one. */
export function runPending(running: boolean, alarmAt: number | null, now: number): boolean {
  return running || (alarmAt !== null && now - alarmAt < STALE_ALARM_MS);
}

/**
 * Whether a run is active or about to start, so a new trigger answers 409. An alarm set for a
 * later time is a follow-up (Spec 018), which a new trigger replaces instead of waiting for.
 */
export function runStarting(running: boolean, alarmAt: number | null, now: number): boolean {
  return running || (alarmAt !== null && alarmAt <= now && now - alarmAt < STALE_ALARM_MS);
}

/** Spec 018: a run a per-run cap cut short is followed by another this soon. */
export const CATCH_UP_DELAY_MS = 5 * 60_000;
/** Catch-up runs per Cron tick or `POST /run`; with 200 issues per source per run, 1,200 in all. */
export const MAX_CATCH_UP_RUNS = 5;
/** Spec 018: a failed run, or one with a failed source, is retried after these waits, then left for the next tick. */
export const RETRY_DELAYS_MS: readonly number[] = [10 * 60_000, 30 * 60_000, 60 * 60_000];

/** Follow-up runs made since the last Cron tick or `POST /run`. */
export interface FollowUpCount {
  readonly catchUps: number;
  readonly retries: number;
}

/** The part of a run's status the follow-up rule reads. */
export interface FollowUpStatus {
  readonly ok: boolean;
  readonly pollTruncated?: boolean;
  readonly sources?: Readonly<Record<string, { readonly ok: boolean }>>;
}

export interface FollowUpPlan {
  readonly reason: "catch-up" | "retry";
  readonly delayMs: number;
  readonly count: FollowUpCount;
}

/**
 * Spec 018 Behavior 4–6: with one Cron tick a day, a run that left work behind runs again by
 * itself. A truncated poll continues first; a failure is retried; both are bounded per trigger.
 */
export function planFollowUp(status: FollowUpStatus, done: FollowUpCount): FollowUpPlan | undefined {
  if (status.ok && status.pollTruncated === true && done.catchUps < MAX_CATCH_UP_RUNS) {
    return { reason: "catch-up", delayMs: CATCH_UP_DELAY_MS, count: { ...done, catchUps: done.catchUps + 1 } };
  }
  const failed = !status.ok || Object.values(status.sources ?? {}).some((source) => !source.ok);
  const delayMs = RETRY_DELAYS_MS[done.retries];
  if (failed && delayMs !== undefined) return { reason: "retry", delayMs, count: { ...done, retries: done.retries + 1 } };
  return undefined;
}

export const FOLLOW_UP_KEY = "follow-up";

/** The follow-up that is waiting, as stored and as `/health` `followUp` shows it. */
export interface FollowUpMarker extends FollowUpCount {
  readonly reason: "catch-up" | "retry";
  readonly at: string;
}

export interface FollowUpStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  setAlarm(time: number): Promise<void>;
}

/** After a run: sets the alarm for the follow-up and records it, or clears the record. */
export async function scheduleFollowUp(storage: FollowUpStorage, status: FollowUpStatus, now: number): Promise<FollowUpMarker | undefined> {
  const done = await storage.get<FollowUpMarker>(FOLLOW_UP_KEY);
  const plan = planFollowUp(status, { catchUps: done?.catchUps ?? 0, retries: done?.retries ?? 0 });
  if (plan === undefined) {
    await storage.delete(FOLLOW_UP_KEY);
    return undefined;
  }
  const marker: FollowUpMarker = { reason: plan.reason, at: new Date(now + plan.delayMs).toISOString(), ...plan.count };
  await storage.put(FOLLOW_UP_KEY, marker);
  await storage.setAlarm(now + plan.delayMs);
  return marker;
}
