import {
  buildFeedDetail,
  groupFeedRecords,
  type DomainEventV1,
  type FeedActivityEvent,
  type FeedDetailKeyPoint,
  type FeedEntry,
  type FeedRecordGroup,
  type FeedRelatedEntry,
  type FeedSourceRecord,
  type RecordConnection,
  type SourceRecordView,
} from "@oss-knowledge-base/domain";
import type { FeedIndexEntry, FeedPublication } from "@oss-knowledge-base/serving-contract";

import { canonicalDigest, sha256 } from "./canonical";
import type { CommunitySourceProfile, GitHubProjectProfile, ReferenceMaterializationConfig } from "./config";
import { parseGitHubEventDataV1, type GitHubDomainEventV1 } from "./event-data";
import {
  parseJiraEventDataV1,
  parseMailEventDataV1,
  type JiraDomainEventV1,
  type MailDomainEventV1,
} from "./kafka-events";
import { extractKeys, isJiraPublished, jiraLinkIndex, threadKey, threadTitle } from "./kafka-rules";
import { dedupeDomainEvents } from "./state";

function daysBefore(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) - days * 86_400_000).toISOString();
}

function currentEntityEvents<T extends DomainEventV1>(events: readonly T[]): readonly T[] {
  const current = new Map<string, T>();
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

type ParsedEvent =
  | { readonly kind: "github"; readonly event: GitHubDomainEventV1 }
  | { readonly kind: "mail"; readonly event: MailDomainEventV1 }
  | { readonly kind: "jira"; readonly event: JiraDomainEventV1 };

/** Each event is read by its data contract; an unknown contract still fails as a GitHub event. */
function parseEvent(event: DomainEventV1): ParsedEvent {
  const contract = (event.data as Readonly<Record<string, unknown>>).contract;
  if (contract === "mail-record@1") return { kind: "mail", event: parseMailEventDataV1(event) };
  if (contract === "jira-record@1") return { kind: "jira", event: parseJiraEventDataV1(event) };
  return { kind: "github", event: parseGitHubEventDataV1(event) };
}

function communityProfileFor(
  sources: readonly CommunitySourceProfile[],
  event: DomainEventV1,
): CommunitySourceProfile {
  const source = sources.find(
    (candidate) => candidate.projectId === event.projectId && candidate.sourceInstanceId === event.sourceInstanceId,
  );
  if (source === undefined) throw new Error(`No source profile for ${event.projectId}/${event.sourceInstanceId}`);
  if (source.profileVersion !== event.communityProfileVersion) {
    throw new Error(`Event ${event.id} uses profile ${event.communityProfileVersion}, expected ${source.profileVersion}`);
  }
  return source;
}

function byTimeThenId<T extends { readonly entityId: string; readonly data: { readonly occurredAt: string } }>(left: T, right: T): number {
  return left.data.occurredAt.localeCompare(right.data.occurredAt) || left.entityId.localeCompare(right.entityId);
}

interface MailThread {
  readonly key: string;
  /** Oldest first; the first message anchors the thread's Feed group. */
  readonly messages: readonly MailDomainEventV1[];
}

/** A group with what Related links need: its display id, the keys it cites, and the KIPs it names. */
interface PlannedEntry {
  readonly group: FeedRecordGroup;
  readonly parsed: ParsedEvent;
  readonly displayId: string;
  readonly title: string;
  readonly source: "github" | "mail" | "jira";
  readonly citedKeys: readonly string[];
  readonly kips: readonly string[];
}

function relatedLinks(planned: readonly PlannedEntry[], ruleRevision: string): ReadonlyMap<string, readonly FeedRelatedEntry[]> {
  const links = new Map<string, Map<string, FeedRelatedEntry>>();
  const add = (from: PlannedEntry, to: PlannedEntry, rule: FeedRelatedEntry["rule"]) => {
    if (from.displayId === to.displayId || from.group.projectId !== to.group.projectId) return;
    const forEntry = links.get(from.displayId) ?? new Map<string, FeedRelatedEntry>();
    if (!forEntry.has(to.displayId)) {
      forEntry.set(to.displayId, { displayId: to.displayId, title: to.title, source: to.source, rule, ruleRevision });
    }
    links.set(from.displayId, forEntry);
  };
  const jiraByKey = new Map(planned.filter((item) => item.source === "jira").map((item) => [`${item.group.projectId}\u0000${item.displayId}`, item]));
  for (const item of planned) {
    for (const key of item.citedKeys) {
      const issue = jiraByKey.get(`${item.group.projectId}\u0000${key}`);
      if (issue === undefined) continue;
      add(item, issue, "key-in-title");
      add(issue, item, "key-in-title");
    }
  }
  const byKip = new Map<string, PlannedEntry[]>();
  for (const item of planned) {
    for (const kip of item.kips) byKip.set(`${item.group.projectId}\u0000${kip}`, [...(byKip.get(`${item.group.projectId}\u0000${kip}`) ?? []), item]);
  }
  for (const items of byKip.values()) {
    for (const from of items) for (const to of items) add(from, to, "same-kip");
  }
  return new Map([...links.entries()].map(([displayId, values]) => [
    displayId,
    [...values.values()].sort((left, right) => left.displayId.localeCompare(right.displayId)),
  ]));
}

export function materializeReferenceFeed(
  values: readonly unknown[],
  config: ReferenceMaterializationConfig,
): MaterializedReferenceResult {
  const parsedEvents = currentEntityEvents(dedupeDomainEvents(values)).map(parseEvent);
  const events = parsedEvents.filter((parsed) => parsed.kind === "github").map((parsed) => parsed.event);
  const mailEvents = parsedEvents.filter((parsed) => parsed.kind === "mail").map((parsed) => parsed.event);
  const jiraEvents = parsedEvents.filter((parsed) => parsed.kind === "jira").map((parsed) => parsed.event);
  const communitySources = config.communitySources ?? [];
  const linkRevision = config.linkRevision ?? "kafka-key-links@1";
  const profilesByProject = new Map(
    config.projectProfiles.map((profile) => [profile.projectId, profile]),
  );
  const eventByEntityId = new Map(events.map((event) => [event.entityId, event]));
  const parsedByEntityId = new Map(parsedEvents.map((parsed) => [parsed.event.entityId, parsed]));
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

  // dev@ threads: messages with the same normalized subject, anchored by the oldest (Behavior 3).
  const threadsByKey = new Map<string, MailDomainEventV1[]>();
  for (const event of mailEvents) {
    communityProfileFor(communitySources, event);
    const key = `${event.projectId}\u0000${threadKey(event.data.subject)}`;
    threadsByKey.set(key, [...(threadsByKey.get(key) ?? []), event]);
  }
  const threadByAnchor = new Map<string, MailThread>();
  for (const [key, messages] of threadsByKey) {
    const sorted = [...messages].sort(byTimeThenId);
    const anchor = sorted[0]!;
    const newest = sorted.at(-1)!;
    threadByAnchor.set(anchor.entityId, { key: key.split("\u0000")[1]!, messages: sorted });
    for (const message of sorted) {
      const isAnchor = message.entityId === anchor.entityId;
      records.push({
        id: message.entityId,
        projectId: message.projectId,
        sourceId: message.sourceInstanceId,
        ...(isAnchor ? { title: threadTitle(newest.data.subject) } : { parentRecordId: anchor.entityId, textPreview: message.data.excerpt }),
        canonicalUrl: message.canonicalUrl,
        sourceVersion: message.sourceCursor,
      });
      activityEvents.push({ id: message.id, projectId: message.projectId, recordId: message.entityId, occurredAt: message.data.occurredAt });
    }
  }

  // Jira issues are published only when linked (Behavior 6); comments follow their issue.
  const links = jiraLinkIndex({
    githubTitles: events.filter((event) => event.data.recordKind !== "comment").map((event) => event.data.title),
    mailSubjects: mailEvents.map((event) => event.data.subject),
  });
  const publishedIssues = new Set(jiraEvents
    .filter((event) => event.data.recordKind === "issue" && isJiraPublished(event.data, links))
    .map((event) => event.entityId));
  for (const event of jiraEvents) {
    communityProfileFor(communitySources, event);
    const parentId = event.data.recordKind === "comment" ? event.data.parentEntityId ?? "" : undefined;
    const isComment = parentId !== undefined;
    if (!publishedIssues.has(parentId ?? event.entityId)) continue;
    records.push({
      id: event.entityId,
      projectId: event.projectId,
      sourceId: event.sourceInstanceId,
      ...(isComment ? { parentRecordId: parentId, textPreview: event.data.excerpt } : { title: event.data.title }),
      canonicalUrl: event.canonicalUrl,
      sourceVersion: event.sourceCursor,
    });
    if (!event.data.isBot) {
      activityEvents.push({ id: event.id, projectId: event.projectId, recordId: event.entityId, occurredAt: event.data.occurredAt });
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

  const planned: PlannedEntry[] = groups.map((group) => {
    const rootId = group.rootRecordIds[0];
    const parsed = rootId === undefined ? undefined : parsedByEntityId.get(rootId);
    if (parsed === undefined) throw new Error(`Feed group ${group.id} has no root event`);
    const profile = profilesByProject.get(group.projectId);
    if (profile === undefined) throw new Error(`Unknown project ${group.projectId}`);
    const projectKey = profile.projectKey.toUpperCase();
    switch (parsed.kind) {
      case "github": {
        const root = parsed.event;
        if (root.data.recordKind === "comment") throw new Error(`Feed group ${group.id} has no GitHub root event`);
        return {
          group, parsed, source: "github", title: group.title.text,
          displayId: `${projectKey}-${root.data.recordKind === "issue" ? "ISSUE" : "PR"}-${root.data.externalNumber}`,
          citedKeys: extractKeys(root.data.title).issueKeys, kips: [],
        };
      }
      case "mail": {
        const thread = threadByAnchor.get(parsed.event.entityId)!;
        const subjects = thread.messages.map((message) => extractKeys(message.data.subject));
        return {
          group, parsed, source: "mail", title: group.title.text,
          displayId: `${projectKey}-MAIL-${sha256(thread.key).slice(0, 8)}`,
          citedKeys: [...new Set(subjects.flatMap((keys) => keys.issueKeys))].sort(),
          kips: [...new Set(subjects.flatMap((keys) => keys.kips))].sort(),
        };
      }
      case "jira":
        return {
          group, parsed, source: "jira", title: group.title.text,
          displayId: parsed.event.data.key, citedKeys: [], kips: parsed.event.data.kips,
        };
    }
  });
  const related = relatedLinks(planned, linkRevision);

  const materialized = planned.map((plan) => {
    const { group } = plan;
    const profile = profilesByProject.get(group.projectId)!;
    const relatedEntries = related.get(plan.displayId) ?? [];
    if (plan.parsed.kind === "mail") return mailEntry(plan, threadByAnchor.get(plan.parsed.event.entityId)!, profile, relatedEntries, config);
    if (plan.parsed.kind === "jira") {
      const comments = group.recordIds
        .map((recordId) => parsedByEntityId.get(recordId))
        .flatMap((parsed) => parsed?.kind === "jira" && parsed.event.data.recordKind === "comment" ? [parsed.event] : []);
      return jiraEntry(plan, plan.parsed.event, comments, profile, relatedEntries, config);
    }
    const root = plan.parsed.event;
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
      displayId: plan.displayId,
      entry,
      records: sourceRecords,
      connections,
      keyPoints: {
        status: "generated",
        points: keyPoints,
        derivation: { kind: "source-extract", revision: config.keyPointRevision },
      },
      related: relatedEntries,
    });
    const lastActivityAt = groupEvents
      .map((event) => event.data.occurredAt)
      .sort()
      .at(-1) ?? root.data.occurredAt;
    const indexEntry: FeedIndexEntry = {
      displayId: plan.displayId,
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

  const sourceTypes: Record<string, { readonly key: string; readonly label: string; readonly full: string }> = {
    github: { key: "github", label: "GitHub", full: "GitHub issues, pull requests, and comments" },
  };
  for (const source of communitySources) sourceTypes[source.key] = { key: source.key, label: source.label, full: source.full };
  const publication: FeedPublication = {
    index: {
      schema: "osskb.feed-index.v2",
      generatedAt: config.materializedAt,
      sourceTypes,
      projects: [...config.projectProfiles]
        .sort((left, right) => left.projectKey.localeCompare(right.projectKey))
        .map((profile) => {
          const extra = communitySources.filter((source) => source.projectId === profile.projectId).map((source) => source.key);
          return {
            key: profile.projectKey,
            label: profile.label,
            profileVersion: profile.profileVersion,
            statusPolicyRef: profile.statusPolicyRef,
            statusFacetKey: "filter.status.github",
            sources: ["github", ...extra],
            statuses: [
              { key: "open", label: "Open" },
              { key: "merged", label: "Merged" },
              { key: "closed", label: "Closed" },
              ...(extra.includes("mail") ? [{ key: "discussing", label: "Discussing" }] : []),
              ...(extra.includes("jira") ? [{ key: "resolved", label: "Resolved" }] : []),
            ],
          };
        }),
      entries: materialized.map(({ indexEntry }) => indexEntry),
      metadata: {
        mode: "replayable-reference-pipeline",
        materializedAt: config.materializedAt,
        inputEventCount: parsedEvents.length,
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

function keyPointsFor(
  root: { readonly entityId: string; readonly data: { readonly excerpt: string } },
  replies: readonly { readonly entityId: string; readonly data: { readonly excerpt: string; readonly author: string; readonly occurredAt: string } }[],
): FeedDetailKeyPoint[] {
  const latestReply = replies
    .filter((event) => event.data.excerpt.length >= 80)
    .sort((left, right) => right.data.occurredAt.localeCompare(left.data.occurredAt) || left.entityId.localeCompare(right.entityId))[0];
  return [
    { id: `key-point:${root.entityId}:scope`, text: root.data.excerpt, evidenceRecordIds: [root.entityId] },
    ...(latestReply === undefined ? [] : [{
      id: `key-point:${latestReply.entityId}:latest`,
      text: `Latest community update from ${latestReply.data.author}: ${latestReply.data.excerpt}`,
      evidenceRecordIds: [latestReply.entityId] as const,
    }]),
  ];
}

function communityEntry(
  plan: PlannedEntry,
  input: {
    readonly root: { readonly entityId: string; readonly data: { readonly excerpt: string; readonly occurredAt: string } };
    readonly records: readonly SourceRecordView[];
    readonly replies: Parameters<typeof keyPointsFor>[1];
    readonly reasonLabel: string;
    readonly status: string;
    readonly releaseLabel: string;
    readonly tags: readonly string[];
    readonly link: string;
    readonly authors: readonly string[];
  },
  profile: GitHubProjectProfile,
  related: readonly FeedRelatedEntry[],
  config: ReferenceMaterializationConfig,
): { readonly indexEntry: FeedIndexEntry; readonly detail: ReturnType<typeof buildFeedDetail> } {
  const { group } = plan;
  const connections: RecordConnection[] = input.records
    .filter((record) => record.id !== input.root.entityId)
    .map((record) => ({
      id: `connection:${record.id}:discusses:${input.root.entityId}`,
      fromRecordId: record.id,
      toRecordId: input.root.entityId,
      kind: "discusses",
      derivation: { kind: "deterministic-rule", revision: config.clusteringRevision },
    }));
  const entry: FeedEntry = {
    id: `feed-entry:${group.id}`,
    projectId: group.projectId,
    title: group.title.text,
    summary: input.root.data.excerpt,
    sourceTitleRecordId: input.root.entityId,
    recordIds: group.recordIds,
    highlightedRecordIds: [input.root.entityId],
    reason: { kind: "trending", label: input.reasonLabel, evidenceEventIds: group.activity.evidenceEventIds },
    activity: group.activity,
    grouping: { relationshipIds: connections.map((connection) => connection.id), clusteringRevision: config.clusteringRevision },
  };
  const detail = buildFeedDetail({
    displayId: plan.displayId,
    entry,
    records: input.records,
    connections,
    keyPoints: {
      status: "generated",
      points: keyPointsFor(input.root, input.replies),
      derivation: { kind: "source-extract", revision: config.keyPointRevision },
    },
    related,
  });
  const indexEntry: FeedIndexEntry = {
    displayId: plan.displayId,
    projectKey: profile.projectKey,
    status: input.status,
    releaseLabel: input.releaseLabel,
    authors: input.authors,
    tags: input.tags,
    links: { [plan.source]: input.link },
    sourceCounts: { [plan.source]: input.records.length },
    lastActivityAt: input.records.map((record) => record.occurredAt).sort().at(-1) ?? input.root.data.occurredAt,
    searchText: [entry.title, entry.summary, ...input.authors, ...input.records.flatMap((record) => [record.title, record.excerpt, record.author])].join(" "),
    entry,
  };
  return { indexEntry, detail };
}

function mailEntry(
  plan: PlannedEntry,
  thread: MailThread,
  profile: GitHubProjectProfile,
  related: readonly FeedRelatedEntry[],
  config: ReferenceMaterializationConfig,
) {
  const anchor = thread.messages[0]!;
  const newest = thread.messages.at(-1)!;
  const records: SourceRecordView[] = [...thread.messages]
    .sort((left, right) => left.entityId.localeCompare(right.entityId))
    .map((message) => ({
      id: message.entityId,
      projectId: message.projectId,
      sourceInstanceId: message.sourceInstanceId,
      source: "mail",
      sourceType: "mailing-list",
      kind: "Mail",
      title: message.data.subject,
      excerpt: message.data.excerpt,
      author: message.data.author,
      role: "dev@ participant",
      occurredAt: message.data.occurredAt,
      canonicalUrl: message.canonicalUrl,
      sourceVersion: message.sourceCursor,
      ...(message.entityId === anchor.entityId ? { artifactStatus: "discussing" } : {}),
    }));
  return communityEntry(plan, {
    root: anchor,
    records,
    replies: thread.messages.slice(1),
    reasonLabel: `${plan.group.activity.score} dev@ messages in the last ${config.activityWindowDays} days`,
    status: "discussing",
    releaseLabel: "dev@kafka.apache.org",
    tags: ["Mailing list"],
    link: newest.canonicalUrl,
    authors: [...new Set(thread.messages.map((message) => message.data.author))].sort(),
  }, profile, related, config);
}

function jiraEntry(
  plan: PlannedEntry,
  issue: JiraDomainEventV1,
  comments: readonly JiraDomainEventV1[],
  profile: GitHubProjectProfile,
  related: readonly FeedRelatedEntry[],
  config: ReferenceMaterializationConfig,
) {
  const status = issue.data.status ?? "open";
  const records: SourceRecordView[] = [issue, ...comments]
    .sort((left, right) => left.entityId.localeCompare(right.entityId))
    .map((event) => ({
      id: event.entityId,
      projectId: event.projectId,
      sourceInstanceId: event.sourceInstanceId,
      source: "jira",
      sourceType: "issue-tracker",
      kind: event.data.recordKind === "issue" ? "Jira Issue" : "Jira Comment",
      title: event.data.title,
      excerpt: event.data.excerpt,
      author: event.data.author,
      role: event.data.recordKind === "issue" ? "Reporter" : "Commenter",
      occurredAt: event.data.occurredAt,
      canonicalUrl: event.canonicalUrl,
      sourceVersion: event.sourceCursor,
      ...(event.entityId === issue.entityId ? { artifactStatus: status } : {}),
    }));
  return communityEntry(plan, {
    root: issue,
    records,
    replies: comments.filter((comment) => !comment.data.isBot),
    reasonLabel: `${plan.group.activity.score} Jira activity signals in the last ${config.activityWindowDays} days`,
    status,
    releaseLabel: `Jira ${issue.data.key}`,
    tags: ["Jira", issue.data.nativeStatus ?? status],
    link: issue.canonicalUrl,
    authors: [...new Set([issue, ...comments].filter((event) => !event.data.isBot).map((event) => event.data.author))].sort(),
  }, profile, related, config);
}
