/**
 * Spec 028 Behaviors 2–4 for the publication: a run is a trigger (cron tick or `POST /run`) plus its
 * follow-ups and alarm retries (Spec 018), so its `runId` is set at the trigger and kept in the
 * object's storage, and the point is written once, by the invocation that leaves no follow-up.
 */
import type { PipelineRunStatus, PipelineStateRepository } from "../pipeline";
import { FOLLOW_UP_KEY, planFollowUp, type FollowUpMarker } from "../run-schedule";
import { publicationSignalRun, runIdFor } from "./point";
import type { JobSignals } from "./recorder";

/** Written in the same `put` as the trigger's `requested-at`, so the trigger makes no extra write. */
export const PUBLICATION_RUN_KEY = "signals-run";

export interface PublicationRunMarker {
  readonly runId: string;
  readonly startedAt: string;
}

export function publicationRunMarker(startedAt: string): PublicationRunMarker {
  return { runId: runIdFor("publication", startedAt), startedAt };
}

/**
 * Records every status of the run with its `runId`. The status of the run's last invocation (no
 * follow-up planned) also carries the trend result; earlier ones keep the previous run's result, so
 * `/health` does not lose it while follow-ups are pending. Same number of writes as without it.
 */
export function signalingPipelineState(
  inner: PipelineStateRepository,
  input: {
    readonly storage: { get<T>(key: string): Promise<T | undefined> };
    readonly run: PublicationRunMarker;
    readonly signals: JobSignals;
    readonly now: () => number;
  },
): PipelineStateRepository {
  return {
    read: () => inner.read(),
    ...(inner.readStatus === undefined ? {} : { readStatus: () => inner.readStatus!() }),
    commit: (state) => inner.commit(state),
    recordPhase: (marker) => inner.recordPhase(marker),
    async recordStatus(status: PipelineRunStatus): Promise<void> {
      const done = await input.storage.get<FollowUpMarker>(FOLLOW_UP_KEY);
      const last = planFollowUp(status, { catchUps: done?.catchUps ?? 0, retries: done?.retries ?? 0 }) === undefined;
      const trends = last
        ? await input.signals.finish(publicationSignalRun(status, { runId: input.run.runId, startedAtMs: Date.parse(input.run.startedAt), finishedAtMs: input.now() }))
        : (await input.storage.get<PipelineRunStatus>("status"))?.trends;
      await inner.recordStatus({ ...status, runId: input.run.runId, ...(trends === undefined ? {} : { trends }) });
    },
  };
}

/**
 * Spec 028 Behavior 2: the publication run whose release another job read (`sourceRunId`), from the
 * publisher's `/status` body: its last run's `runId` when that run published `release` (a Feed
 * release id, or a Search `feed-…` revision); "" otherwise.
 */
export function sourceRunIdFrom(publisherStatus: unknown, release: string | null): string {
  const lastRun = (publisherStatus as { lastRun?: { runId?: unknown; feedReleaseId?: unknown; searchRevision?: unknown } | null } | null)?.lastRun;
  if (release === null || lastRun === null || lastRun === undefined || typeof lastRun.runId !== "string") return "";
  return lastRun.feedReleaseId === release || lastRun.searchRevision === release ? lastRun.runId : "";
}
