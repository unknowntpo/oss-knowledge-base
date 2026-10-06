import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import {
  canonicalDigest,
  type GitHubCheckpointV1,
  type SourcePollResult,
  defaultReferenceConfig,
  materializeReferenceFeed,
  ReferenceStateStore,
  type SerializedReferenceStateV1,
} from "@oss-knowledge-base/reference-pipeline";
import {
  encodeJson,
  feedProjectionObjects,
  publishProjectionStreams,
  searchGroupsFromFeed,
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
  /** The last recorded run, for each source's previous `lastSuccessAt` (ADR-0014). */
  readStatus?(): Promise<PipelineRunStatus | undefined>;
  commit(state: SerializedReferenceStateV1): Promise<void>;
  /** Records a completed run; the run's phase marker is no longer current. */
  recordStatus(status: PipelineRunStatus): Promise<void>;
  recordPhase(marker: PipelinePhaseMarker): Promise<void>;
}

export interface PublicationDestination extends PublicationObjectStore {
  putEvidence(key: string, body: Uint8Array): Promise<void>;
}

export interface PollingConnector {
  poll(previous: ReturnType<ReferenceStateStore["readCheckpoint"]>, observedAt: string): Promise<SourcePollResult>;
}

/** A source polled in addition to GitHub (Spec 012). */
export interface NamedConnector {
  readonly key: string;
  readonly connector: PollingConnector;
}

/** One source's outcome in a run; a failed source keeps its cursor and retained events (ADR-0014). */
export interface SourceRunStatus {
  readonly ok: boolean;
  readonly lastSuccessAt: string | null;
  readonly cursor: string | null;
  readonly durationMs: number;
  readonly read: number;
  readonly skipped: number;
  readonly filtered: number;
  readonly conflicts: number;
  readonly published: number;
  readonly gapCapped: boolean;
  readonly failureKind?: string;
  readonly error?: string;
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
      readonly sources?: Readonly<Record<string, SourceRunStatus>>;
    }
  | {
      readonly ok: false;
      readonly environment: "development" | "production";
      readonly completedAt: string;
      readonly failureKind: string;
      readonly error: string;
      readonly retryAfterSeconds: number;
      readonly sources?: Readonly<Record<string, SourceRunStatus>>;
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
  /** The GitHub source. */
  readonly connector: PollingConnector;
  /** Further sources, each with its own cursor; any may fail without stopping the run. */
  readonly sources?: readonly NamedConnector[];
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
    const previousStatus = await input.state.readStatus?.();
    const previousCheckpoint = next.readCheckpoint();
    const polls: { readonly key: string; readonly poll: SourcePollResult; readonly durationMs: number }[] = [];
    for (const source of [{ key: "github", connector: input.connector }, ...(input.sources ?? [])]) {
      const started = Date.now();
      const poll = await source.connector.poll(previousCheckpoint, input.materializedAt);
      polls.push({ key: source.key, poll, durationMs: Date.now() - started });
    }
    const succeeded = polls.filter((item) => item.poll.complete);
    if (succeeded.length === 0) {
      const first = polls[0]!.poll as Extract<SourcePollResult, { complete: false }>;
      return await record(input.state, {
        ok: false,
        environment: input.environment,
        completedAt: input.materializedAt,
        failureKind: first.failureKind,
        error: first.error,
        retryAfterSeconds: first.retryAfterSeconds,
        ...withSources(sourceStatuses(polls, previousStatus, input.materializedAt, new Map(), new Map())),
      });
    }

    const conflicts = new Map<string, number>();
    let polledEvents = 0;
    for (const { key, poll } of succeeded) {
      conflicts.set(key, next.appendKeepingStored(poll.events).length);
      polledEvents += poll.events.length;
    }
    await phase("materializing", { polledEvents, events: next.readEvents().length });
    const releaseId = releaseIdFor(input.materializedAt);
    const searchRevision = `feed-${releaseId}`;
    const published = await publish(input, next.readEvents(), releaseId, searchRevision, phase);
    if (!published.ok) throw new Error(`${published.kind}: ${published.message}`);
    const publishedBySource = published.entriesBySource;

    await phase("recording-evidence");
    await input.destination.putEvidence(
      publicationEvidenceKey(published.publicationSet),
      encodeJson(published.publicationSet),
    );
    await phase("committing-state");
    const compacted = compactState(next.readEvents(), input.materializedAt);
    compacted.commitCheckpoint(mergedCheckpoint(previousCheckpoint, succeeded.map((item) => item.poll)));
    await input.state.commit(compacted.snapshot());
    return await record(input.state, {
      ok: true,
      environment: input.environment,
      completedAt: input.materializedAt,
      publicationSetId: published.publicationSet.id,
      feedReleaseId: releaseId,
      searchRevision,
      inputEventCount: polledEvents,
      logicalEventCount: compacted.readEvents().length,
      pageCount: succeeded.reduce((sum, item) => sum + (item.poll.complete ? item.poll.pageCount : 0), 0),
      pollTruncated: succeeded.some((item) => item.poll.complete && item.poll.truncated),
      copiedObjectCount: published.copiedObjectCount,
      reusedObjectCount: published.reusedObjectCount,
      ...withSources(sourceStatuses(polls, previousStatus, input.materializedAt, conflicts, publishedBySource)),
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
): Promise<StreamedPublicationResult & { readonly entriesBySource: ReadonlyMap<string, number> }> {
  const config = defaultReferenceConfig(input.materializedAt);
  const { streams, counts, entriesBySource } = await materializeStreams(events, config, releaseId, searchRevision);
  const result = await publishProjectionStreams(
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
  return { ...result, entriesBySource };
}

/**
 * Only the streams reference the materialized Feed publication once this returns, and the
 * publisher drops each stream when it is consumed. Search groups, chunks, and shards are
 * produced from the Feed one at a time while Search is written (Spec 013).
 */
async function materializeStreams(
  events: readonly DomainEventV1[],
  config: ReturnType<typeof defaultReferenceConfig>,
  releaseId: string,
  searchRevision: string,
): Promise<{
  readonly streams: ProjectionStreams;
  readonly counts: Readonly<Record<string, number>>;
  readonly entriesBySource: ReadonlyMap<string, number>;
}> {
  const materialized = materializeReferenceFeed(events, config);
  const entriesBySource = new Map<string, number>();
  for (const entry of materialized.publication.index.entries) {
    for (const source of Object.keys(entry.links)) entriesBySource.set(source, (entriesBySource.get(source) ?? 0) + 1);
  }
  return {
    streams: {
      search: searchProjectionObjects({
        indexRevision: searchRevision,
        corpusRevision: materialized.digest,
        generatedAt: config.materializedAt,
      }, searchGroupsFromFeed(materialized.publication)),
      feed: feedProjectionObjects(materialized.publication, releaseId),
    },
    counts: {
      feedEntries: materialized.publication.index.entries.length,
      searchGroups: materialized.publication.details.length,
    },
    entriesBySource,
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

/** Stored cursors stay; each successful source replaces only its own entries (ADR-0014). */
function mergedCheckpoint(previous: GitHubCheckpointV1 | undefined, polls: readonly SourcePollResult[]): GitHubCheckpointV1 {
  const sources: Record<string, { readonly updatedAt: string }> = { ...(previous?.sources ?? {}) };
  let connectorRevision = previous?.connectorRevision;
  for (const poll of polls) {
    if (!poll.complete) continue;
    Object.assign(sources, poll.candidateCheckpoint.sources);
    connectorRevision ??= poll.candidateCheckpoint.connectorRevision;
  }
  return { schema: "osskb.github-checkpoint.v1", connectorRevision: connectorRevision ?? "github@1", sources };
}

function sourceStatuses(
  polls: readonly { readonly key: string; readonly poll: SourcePollResult; readonly durationMs: number }[],
  previousStatus: PipelineRunStatus | undefined,
  completedAt: string,
  conflicts: ReadonlyMap<string, number>,
  published: ReadonlyMap<string, number>,
): Record<string, SourceRunStatus> {
  const statuses: Record<string, SourceRunStatus> = {};
  for (const { key, poll, durationMs } of polls) {
    const lastSuccessAt = previousStatus?.sources?.[key]?.lastSuccessAt ?? null;
    if (poll.complete) {
      const cursors = Object.values(poll.candidateCheckpoint.sources).map((source) => source.updatedAt).sort();
      statuses[key] = {
        ok: true,
        lastSuccessAt: completedAt,
        cursor: cursors.at(-1) ?? null,
        durationMs,
        read: poll.stats?.read ?? poll.events.length,
        skipped: poll.stats?.skipped ?? 0,
        filtered: poll.stats?.filtered ?? 0,
        conflicts: conflicts.get(key) ?? 0,
        published: published.get(key) ?? 0,
        gapCapped: poll.stats?.gapCapped ?? false,
      };
    } else {
      statuses[key] = {
        ok: false,
        lastSuccessAt,
        cursor: previousStatus?.sources?.[key]?.cursor ?? null,
        durationMs,
        read: 0,
        skipped: 0,
        filtered: 0,
        conflicts: 0,
        published: published.get(key) ?? 0,
        gapCapped: false,
        failureKind: poll.failureKind,
        error: poll.error,
      };
    }
  }
  return statuses;
}

/** Adds per-source fields only when more than GitHub is polled, so GitHub-only status is unchanged. */
function withSources(statuses: Record<string, SourceRunStatus>): { readonly sources?: Record<string, SourceRunStatus> } {
  return Object.keys(statuses).length > 1 ? { sources: statuses } : {};
}
