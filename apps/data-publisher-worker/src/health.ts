import type { PipelinePhaseMarker, PipelineRunStatus } from "./pipeline";
import type { FollowUpMarker } from "./run-schedule";

/** `/health` body: the last run, its phase marker, and each source's status (ADR-0014, Spec 012 K32). */
export function healthBody(input: {
  readonly environment: "development" | "production";
  readonly running: boolean;
  readonly scheduled: boolean;
  readonly alarmAt?: number | null;
  readonly phase: PipelinePhaseMarker | undefined;
  readonly status: PipelineRunStatus | undefined;
  readonly followUp?: FollowUpMarker | undefined;
}) {
  return {
    environment: input.environment,
    running: input.running,
    scheduled: input.scheduled,
    // Spec 027 SRE105: the registered alarm's time. `scheduled` is false once it is stale, so this shows an alarm the runtime gave up on.
    alarmAt: input.alarmAt == null ? null : new Date(input.alarmAt).toISOString(),
    // Spec 018: the catch-up or retry run that is waiting, with the counts since the last trigger.
    followUp: input.followUp ?? null,
    // Set while a run is unfinished; left by a run the platform killed until a later run completes.
    phase: input.phase ?? null,
    lastRun: input.status ?? null,
    sources: input.status?.sources ?? null,
  };
}
