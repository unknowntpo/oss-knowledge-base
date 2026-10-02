import {
  buildFeedDetail,
  groupFeedRecords,
  type FeedActivityEvent,
  type FeedDetailKeyPoint,
  type FeedEntry,
  type FeedSourceRecord,
  type RecordConnection,
  type SourceRecordView,
} from "@oss-knowledge-base/domain";
import type { FeedIndexEntry, FeedPublication } from "@oss-knowledge-base/serving-contract";

import { canonicalDigest } from "./canonical";
import type { GitHubProjectProfile, ReferenceMaterializationConfig } from "./config";
import { parseGitHubEventDataV1, type GitHubDomainEventV1 } from "./event-data";
import { dedupeDomainEvents } from "./state";

function daysBefore(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) - days * 86_400_000).toISOString();
}

function currentEntityEvents(events: readonly GitHubDomainEventV1[]): readonly GitHubDomainEventV1[] {
  const current = new Map<string, GitHubDomainEventV1>();
  for (const event of events) {
    const key = [event.projectId, event.sourceInstanceId, event.entityId].join("\u0000");
    const previous = current.get(key);
    if (
      previous === undefined ||
      event.sourceTimestamp > previous.sourceTimestamp ||
      (event.sourceTimestamp === previous.sourceTimestamp && event.sourceCursor > previous.sourceCursor) ||
      (event.sourceTimestamp === previous.sourceTimestamp && event.sourceCursor === previous.sourceCursor && event.id > previous.id)
    ) {
      current.set(key, event);
    }
  }
  return [...current.values()].sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function statusOf(event: GitHubDomainEventV1): "open" | "merged" | "closed" {
  if (event.data.mergedAt !== undefined) return "merged";
  return event.data.nativeState === "open" ? "open" : "closed";
}

function kindLabel(event: GitHubDomainEventV1): string {
  switch (event.data.recordKind) {
    case "issue": return "GitHub Issue";
    case "pull-request": return "Pull Request";
    case "comment": return "Comment";
  }
}

function recordTitle(event: GitHubDomainEventV1): string {
  if (event.data.recordKind === "comment") return `Comment on #${event.data.externalNumber}`;
  return `${event.data.recordKind === "issue" ? "Issue" : "PR"} #${event.data.externalNumber}: ${event.data.title}`;
}

function profileFor(
  profiles: readonly GitHubProjectProfile[],
  event: GitHubDomainEventV1,
): GitHubProjectProfile {
  const profile = profiles.find(
    (candidate) => candidate.projectId === event.projectId && candidate.sourceInstanceId === event.sourceInstanceId,
  );
  if (profile === undefined) throw new Error(`No project profile for ${event.projectId}/${event.sourceInstanceId}`);
  if (profile.profileVersion !== event.communityProfileVersion) {
    throw new Error(`Event ${event.id} uses profile ${event.communityProfileVersion}, expected ${profile.profileVersion}`);
  }
  return profile;
}

export interface MaterializedReferenceResult {
  readonly publication: FeedPublication;
  /** Canonical-JSON digest of the publication; no serialized copy is retained (Spec 009). */
  readonly digest: string;
}

export function materializeReferenceFeed(
  values: readonly unknown[],
  config: ReferenceMaterializationConfig,
): MaterializedReferenceResult {
  const events = currentEntityEvents(
    dedupeDomainEvents(values).map(parseGitHubEventDataV1),
  );
  const profilesByProject = new Map(
    config.projectProfiles.map((profile) => [profile.projectId, profile]),
  );
  const eventByEntityId = new Map(events.map((event) => [event.entityId, event]));
  const records: FeedSourceRecord[] = [];
  const activityEvents: FeedActivityEvent[] = [];

  for (const event of events) {
    const profile = profileFor(config.projectProfiles, event);
    const isComment = event.data.recordKind === "comment";
    if (isComment && !eventByEntityId.has(event.data.parentEntityId ?? "")) {
      throw new Error(`GitHub comment ${event.entityId} references a missing parent`);
    }
    records.push({
      id: event.entityId,
      projectId: event.projectId,
      sourceId: profile.sourceInstanceId,
      ...(isComment ? { parentRecordId: event.data.parentEntityId } : {}),
      ...(isComment ? { textPreview: event.data.excerpt } : { title: event.data.title }),
      canonicalUrl: event.canonicalUrl,
      sourceVersion: event.sourceCursor,
    });
    if (!event.data.isBot) {
      activityEvents.push({
        id: event.id,
        projectId: event.projectId,
        recordId: event.entityId,
        occurredAt: event.data.occurredAt,
      });
    }
  }

  const groups = groupFeedRecords({
    records,
    relationships: [],
    activityEvents,
    minimumModelConfidence: 1,
    window: {
      startedAt: daysBefore(config.materializedAt, config.activityWindowDays),
      endedAt: config.materializedAt,
    },
    clusteringRevision: config.clusteringRevision,
  });

  const materialized = groups.map((group) => {
    const rootId = group.rootRecordIds[0];
    const root = rootId === undefined ? undefined : eventByEntityId.get(rootId);
    if (root === undefined || root.data.recordKind === "comment") {
      throw new Error(`Feed group ${group.id} has no GitHub root event`);
    }
    const profile = profilesByProject.get(group.projectId);
    if (profile === undefined) throw new Error(`Unknown project ${group.projectId}`);
    const groupEvents = group.recordIds
      .map((recordId) => eventByEntityId.get(recordId))
      .filter((event): event is GitHubDomainEventV1 => event !== undefined);
    const sourceRecords: SourceRecordView[] = groupEvents.map((event) => ({
      id: event.entityId,
      projectId: event.projectId,
      sourceInstanceId: event.sourceInstanceId,
      source: "github",
      sourceType: "code-host",
      kind: kindLabel(event),
      title: recordTitle(event),
      excerpt: event.data.excerpt,
      author: event.data.author,
      role: event.data.authorRole,
      occurredAt: event.data.occurredAt,
      canonicalUrl: event.canonicalUrl,
      sourceVersion: event.sourceCursor,
      ...(event.entityId === root.entityId ? { artifactStatus: statusOf(root) } : {}),
    }));
    const connections: RecordConnection[] = groupEvents
      .filter((event) => event.entityId !== root.entityId)
      .map((event) => ({
        id: `connection:${event.entityId}:discusses:${root.entityId}`,
        fromRecordId: event.entityId,
        toRecordId: root.entityId,
        kind: "discusses",
        derivation: { kind: "deterministic-rule", revision: config.clusteringRevision },
      }));
    const authors = [...new Set(groupEvents.filter((event) => !event.data.isBot).map((event) => event.data.author))].sort();
    const latestReply = groupEvents
      .filter((event) => event.data.recordKind === "comment" && !event.data.isBot && event.data.excerpt.length >= 80)
      .sort((left, right) => right.data.occurredAt.localeCompare(left.data.occurredAt) || left.entityId.localeCompare(right.entityId))[0];
    const keyPoints: FeedDetailKeyPoint[] = [
      { id: `key-point:${root.entityId}:scope`, text: root.data.excerpt, evidenceRecordIds: [root.entityId] },
      ...(latestReply === undefined ? [] : [{
        id: `key-point:${latestReply.entityId}:latest`,
        text: `Latest community update from ${latestReply.data.author}: ${latestReply.data.excerpt}`,
        evidenceRecordIds: [latestReply.entityId] as const,
      }]),
    ];
    const entry: FeedEntry = {
      id: `feed-entry:${group.id}`,
      projectId: group.projectId,
      title: group.title.text,
      summary: root.data.excerpt,
      sourceTitleRecordId: root.entityId,
      recordIds: group.recordIds,
      highlightedRecordIds: [root.entityId],
      reason: {
        kind: "trending",
        label: `${group.activity.score} GitHub activity signals in the last ${config.activityWindowDays} days`,
        evidenceEventIds: group.activity.evidenceEventIds,
      },
      activity: group.activity,
      grouping: { relationshipIds: connections.map((connection) => connection.id), clusteringRevision: config.clusteringRevision },
    };
    const detail = buildFeedDetail({
      entry,
      records: sourceRecords,
      connections,
      keyPoints: {
        status: "generated",
        points: keyPoints,
        derivation: { kind: "source-extract", revision: config.keyPointRevision },
      },
    });
    const lastActivityAt = groupEvents
      .map((event) => event.data.occurredAt)
      .sort()
      .at(-1) ?? root.data.occurredAt;
    const indexEntry: FeedIndexEntry = {
      displayId: `${profile.projectKey.toUpperCase()}-${root.data.recordKind === "issue" ? "ISSUE" : "PR"}-${root.data.externalNumber}`,
      projectKey: profile.projectKey,
      status: statusOf(root),
      releaseLabel: `GitHub ${root.data.recordKind === "issue" ? "Issue" : "Pull Request"} #${root.data.externalNumber}`,
      authors,
      tags: [root.data.recordKind === "issue" ? "Issue" : "Pull Request", ...[...root.data.labels].sort()],
      links: { github: root.canonicalUrl },
      sourceCounts: { github: sourceRecords.length },
      lastActivityAt,
      searchText: [entry.title, entry.summary, ...authors, ...sourceRecords.flatMap((record) => [record.title, record.excerpt, record.author])].join(" "),
      entry,
    };
    return { indexEntry, detail };
  });

  const publication: FeedPublication = {
    index: {
      schema: "osskb.feed-index.v2",
      generatedAt: config.materializedAt,
      sourceTypes: { github: { key: "github", label: "GitHub", full: "GitHub issues, pull requests, and comments" } },
      projects: [...config.projectProfiles]
        .sort((left, right) => left.projectKey.localeCompare(right.projectKey))
        .map((profile) => ({
          key: profile.projectKey,
          label: profile.label,
          profileVersion: profile.profileVersion,
          statusPolicyRef: profile.statusPolicyRef,
          statusFacetKey: "filter.status.github",
          sources: ["github"],
          statuses: [
            { key: "open", label: "Open" },
            { key: "merged", label: "Merged" },
            { key: "closed", label: "Closed" },
          ],
        })),
      entries: materialized.map(({ indexEntry }) => indexEntry),
      metadata: {
        mode: "replayable-reference-pipeline",
        materializedAt: config.materializedAt,
        inputEventCount: events.length,
        rejectedEventCount: 0,
        materializerRevision: config.materializerRevision,
        clusteringRevision: config.clusteringRevision,
        profileRevisions: Object.fromEntries(config.projectProfiles.map((profile) => [profile.projectId, profile.profileVersion])),
      },
    },
    details: materialized.map(({ detail }) => detail),
  };
  return { publication, digest: canonicalDigest(publication) };
}
