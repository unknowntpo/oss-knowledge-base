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
  buildPublicationSetV1,
  buildR2Projection,
  buildR2SearchProjection,
  materializeSearchPublicationFromFeed,
  promotePublicationSet,
  type ProjectionObject,
  type PublicationObjectStore,
  type PublicationSetV1,
} from "@oss-knowledge-base/serving-contract";

export interface PipelineStateRepository {
  read(): Promise<SerializedReferenceStateV1>;
  commit(state: SerializedReferenceStateV1): Promise<void>;
  recordStatus(status: PipelineRunStatus): Promise<void>;
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

export async function runDataPublication(input: {
  readonly environment: "development" | "production";
  readonly materializedAt: string;
  readonly connector: PollingConnector;
  readonly state: PipelineStateRepository;
  readonly destination: PublicationDestination;
}): Promise<PipelineRunStatus> {
  try {
    const persisted = await input.state.read();
    const next = new ReferenceStateStore(persisted);
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
    const materialized = materializeReferenceFeed(
      next.readEvents(),
      defaultReferenceConfig(input.materializedAt),
    );
    const releaseId = releaseIdFor(input.materializedAt);
    const searchRevision = `feed-${releaseId}`;
    const search = await materializeSearchPublicationFromFeed({
      feed: materialized.publication,
      indexRevision: searchRevision,
      corpusRevision: materialized.digest,
      generatedAt: input.materializedAt,
    });
    const feedObjects = buildR2Projection(materialized.publication, releaseId);
    const searchObjects = await buildR2SearchProjection(search);
    const publicationSet = await buildPublicationSetV1({
      id: `github-${releaseId}`,
      generatedAt: input.materializedAt,
      inputDigest: canonicalDigest(next.readEvents()) as `sha256:${string}`,
      materializerRevision: defaultReferenceConfig(input.materializedAt).materializerRevision,
      feedObjects,
      searchObjects,
    });

    const source = projectionSource([...feedObjects, ...searchObjects]);
    const published = await promotePublicationSet(publicationSet, source, input.destination);
    if (!published.ok) throw new Error(`${published.kind}: ${published.message}`);

    await input.destination.putEvidence(
      publicationEvidenceKey(publicationSet),
      new TextEncoder().encode(JSON.stringify(publicationSet)),
    );
    const compacted = compactState(next.readEvents(), input.materializedAt);
    compacted.commitCheckpoint(poll.candidateCheckpoint);
    await input.state.commit(compacted.snapshot());
    return await record(input.state, {
      ok: true,
      environment: input.environment,
      completedAt: input.materializedAt,
      publicationSetId: publicationSet.id,
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

function projectionSource(objects: readonly ProjectionObject[]): Pick<PublicationObjectStore, "get"> {
  const bodies = new Map(objects.map((object) => [object.key, new TextEncoder().encode(object.body)]));
  return { get: async (key) => bodies.get(key) };
}

async function record<T extends PipelineRunStatus>(state: PipelineStateRepository, status: T): Promise<T> {
  await state.recordStatus(status);
  return status;
}
