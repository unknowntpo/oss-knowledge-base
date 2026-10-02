/**
 * An alarm still registered this long after its scheduled time will never fire: the runtime
 * gave up retrying it. It covers the 15-minute alarm wall-time limit plus retry backoff.
 */
export const STALE_ALARM_MS = 30 * 60_000;

/** Whether a run is already active or will still start, so a new trigger must not schedule one. */
export function runPending(running: boolean, alarmAt: number | null, now: number): boolean {
  return running || (alarmAt !== null && now - alarmAt < STALE_ALARM_MS);
}
