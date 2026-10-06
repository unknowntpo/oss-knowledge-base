import type { PipelinePhaseMarker, PipelineRunStatus } from "./pipeline";

/** `/health` body: the last run, its phase marker, and each source's status (ADR-0014, Spec 012 K32). */
export function healthBody(input: {
  readonly environment: "development" | "production";
  readonly running: boolean;
  readonly scheduled: boolean;
  readonly phase: PipelinePhaseMarker | undefined;
  readonly status: PipelineRunStatus | undefined;
}) {
  return {
    environment: input.environment,
    running: input.running,
    scheduled: input.scheduled,
    // Set while a run is unfinished; left by a run the platform killed until a later run completes.
    phase: input.phase ?? null,
    lastRun: input.status ?? null,
    sources: input.status?.sources ?? null,
  };
}
