import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import type { GitHubPollResult } from "@oss-knowledge-base/github-publisher/github-connector";
import {
  canonicalDigest,
  defaultReferenceConfig,
  materializeReferenceFeed,
  ReferenceStateStore,
  type SerializedReferenceStateV1,
} from "@oss-knowledge-base/reference-pipeline";
import {
  encodeJson,
  feedProjectionObjects,
  materializeSearchPublicationFromFeed,
  publishProjectionStreams,
  searchProjectionObjects,
  type PublicationObjectStore,
  type PublicationSetV1,
  type ProjectionStreams,
  type PublicationStreamPhase,
  type Sha256Digest,
  type StreamedPublicationResult,
} from "@oss-knowledge-base/serving-contract";

export interface PipelineStateRepository {
  read(): Promise<SerializedReferenceStateV1>;
  commit(state: SerializedReferenceStateV1): Promise<void>;
  /** Records a completed run; the run's phase marker is no longer current. */
  recordStatus(status: PipelineRunStatus): Promise<void>;
  recordPhase(marker: PipelinePhaseMarker): Promise<void>;
}

export interface PublicationDestination extends PublicationObjectStore {
  putEvidence(key: string, body: Uint8Array): Promise<void>;
}

export interface PollingConnector {
  poll(previous: ReturnType<ReferenceStateStore["readCheckpoint"]>, observedAt: string): Promise<GitHubPollResult>;
}

export type PipelineRunStatus =
  | {
      readonly ok: true;
      readonly environment: "development" | "production";
      readonly completedAt: string;
      readonly publicationSetId: string;
      readonly feedReleaseId: string;
      readonly searchRevision: string;
      readonly inputEventCount: number;
      readonly logicalEventCount: number;
      readonly pageCount: number;
      readonly pollTruncated: boolean;
      readonly copiedObjectCount: number;
      readonly reusedObjectCount: number;
    }
  | {
      readonly ok: false;
      readonly environment: "development" | "production";
      readonly completedAt: string;
      readonly failureKind: string;
      readonly error: string;
      readonly retryAfterSeconds: number;
    };

export type PipelinePhase =
  | "reading-state"
  | "polling"
  | "materializing"
  | PublicationStreamPhase
  | "recording-evidence"
  | "committing-state";

/**
 * Persisted before each phase. Workers expose no memory reading, so a run the platform kills
 * (for example for exceeding memory) is attributed to the last phase it reached (Spec 009).
 */
export interface PipelinePhaseMarker {
  readonly phase: PipelinePhase;
  readonly startedAt: string;
  readonly materializedAt: string;
  readonly counts: Readonly<Record<string, number>>;
}

// A first release, or a large catch-up, writes thousands of new objects; serial R2 round trips are too slow.
const PROMOTION_CONCURRENCY = 16;

export async function runDataPublication(input: {
  readonly environment: "development" | "production";
  readonly materializedAt: string;
  readonly connector: PollingConnector;
  readonly state: PipelineStateRepository;
  readonly destination: PublicationDestination;
}): Promise<PipelineRunStatus> {
  const startedAt = Date.now();
  const counts: Record<string, number> = {};
  const phase = async (name: PipelinePhase, update: Readonly<Record<string, number>> = {}) => {
    Object.assign(counts, update);
    console.log(`publication ${name} at ${Date.now() - startedAt}ms ${JSON.stringify(counts)}`);
    await input.state.recordPhase({
      phase: name,
      startedAt: new Date().toISOString(),
      materializedAt: input.materializedAt,
      counts: { ...counts },
    });
  };
  try {
    await phase("reading-state");
    const next = new ReferenceStateStore(await input.state.read());
    await phase("polling", { storedEvents: next.readEvents().length });
    const poll = await input.connector.poll(next.readCheckpoint(), input.materializedAt);
    if (!poll.complete) {
      return await record(input.state, {
        ok: false,
        environment: input.environment,
        completedAt: input.materializedAt,
        failureKind: poll.failureKind,
        error: poll.error,
        retryAfterSeconds: poll.retryAfterSeconds,
      });
    }

    next.appendDurably(poll.events);
    await phase("materializing", { polledEvents: poll.events.length, events: next.readEvents().length });
    const releaseId = releaseIdFor(input.materializedAt);
    const searchRevision = `feed-${releaseId}`;
    const published = await publish(input, next.readEvents(), releaseId, searchRevision, phase);
    if (!published.ok) throw new Error(`${published.kind}: ${published.message}`);

    await phase("recording-evidence");
    await input.destination.putEvidence(
      publicationEvidenceKey(published.publicationSet),
      encodeJson(published.publicationSet),
    );
    await phase("committing-state");
    const compacted = compactState(next.readEvents(), input.materializedAt);
    compacted.commitCheckpoint(poll.candidateCheckpoint);
    await input.state.commit(compacted.snapshot());
    return await record(input.state, {
      ok: true,
      environment: input.environment,
      completedAt: input.materializedAt,
      publicationSetId: published.publicationSet.id,
      feedReleaseId: releaseId,
      searchRevision,
      inputEventCount: poll.events.length,
      logicalEventCount: compacted.readEvents().length,
      pageCount: poll.pageCount,
      pollTruncated: poll.truncated,
      copiedObjectCount: published.copiedObjectCount,
      reusedObjectCount: published.reusedObjectCount,
    });
  } catch (error) {
    return await record(input.state, {
      ok: false,
      environment: input.environment,
      completedAt: input.materializedAt,
      failureKind: "pipeline",
      error: error instanceof Error ? error.message : String(error),
      retryAfterSeconds: 300,
    });
  }
}

/** Materializes Feed and Search, then streams their objects to the destination. */
async function publish(
  input: { readonly materializedAt: string; readonly destination: PublicationDestination },
  events: readonly DomainEventV1[],
  releaseId: string,
  searchRevision: string,
  phase: (name: PipelinePhase, update?: Readonly<Record<string, number>>) => Promise<void>,
): Promise<StreamedPublicationResult> {
  const config = defaultReferenceConfig(input.materializedAt);
  const { streams, counts } = await materializeStreams(events, config, releaseId, searchRevision);
  return publishProjectionStreams(
    {
      id: `github-${releaseId}`,
      generatedAt: input.materializedAt,
      inputDigest: canonicalDigest(events) as Sha256Digest,
      materializerRevision: config.materializerRevision,
    },
    streams,
    input.destination,
    {
      concurrency: PROMOTION_CONCURRENCY,
      onPhase: (name, progress) => phase(name, { ...counts, ...progress }),
    },
  );
}

/**
 * Only the streams reference the materialized publications once this returns, and the
 * publisher drops each stream when it is consumed, so Search is collectable while Feed is
 * written and both are before pointers switch.
 */
async function materializeStreams(
  events: readonly DomainEventV1[],
  config: ReturnType<typeof defaultReferenceConfig>,
  releaseId: string,
  searchRevision: string,
): Promise<{ readonly streams: ProjectionStreams; readonly counts: Readonly<Record<string, number>> }> {
  const materialized = materializeReferenceFeed(events, config);
  const search = await materializeSearchPublicationFromFeed({
    feed: materialized.publication,
    indexRevision: searchRevision,
    corpusRevision: materialized.digest,
    generatedAt: config.materializedAt,
  });
  return {
    streams: {
      search: searchProjectionObjects(search),
      feed: feedProjectionObjects(materialized.publication, releaseId),
    },
    counts: { feedEntries: materialized.publication.index.entries.length, searchGroups: search.details.length },
  };
}

/** Keep current entities near the activity window; this state is a bounded
 * reference-publisher checkpoint, not the canonical history plane. */
function compactState(events: readonly DomainEventV1[], materializedAt: string): ReferenceStateStore {
  const current = new Map<string, DomainEventV1>();
  for (const event of events) {
    const identity = [event.projectId, event.sourceInstanceId, event.entityId].join("\u0000");
    const previous = current.get(identity);
    if (previous === undefined || event.sourceTimestamp > previous.sourceTimestamp ||
        (event.sourceTimestamp === previous.sourceTimestamp && event.sourceCursor > previous.sourceCursor)) {
      current.set(identity, event);
    }
  }
  const cutoff = new Date(Date.parse(materializedAt) - 35 * 86_400_000).toISOString();
  const values = [...current.values()];
  const recent = values.filter((event) => event.sourceTimestamp >= cutoff);
  const requiredParents = new Set(recent.flatMap((event) => {
    const parent = (event.data as Readonly<Record<string, unknown>>).parentEntityId;
    return typeof parent === "string" ? [parent] : [];
  }));
  const retained = values.filter((event) => event.sourceTimestamp >= cutoff || requiredParents.has(event.entityId));
  return new ReferenceStateStore({ schema: "osskb.reference-state.v1", events: retained });
}

function releaseIdFor(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf())) throw new Error("materializedAt must be a timestamp");
  return parsed.toISOString().replace(/[:.]/gu, "-");
}

function publicationEvidenceKey(publicationSet: PublicationSetV1): string {
  return `publication-sets/v1/${publicationSet.id}.json`;
}

async function record<T extends PipelineRunStatus>(state: PipelineStateRepository, status: T): Promise<T> {
  await state.recordStatus(status);
  return status;
}
