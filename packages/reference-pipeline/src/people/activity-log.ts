/**
 * Spec 019 slice 2b, Behavior 1–4: the pipeline's events → activity rows, grouped by project and
 * month. Publisher-side (it hashes mail thread keys with Node's `crypto`, as the materializer does).
 */
import type { DomainEventV1 } from "@oss-knowledge-base/domain";

import { sha256 } from "../canonical";
import { communitySourceProfiles, githubProjectProfiles } from "../config";
import type { GitHubEventDataV1 } from "../event-data";
import type { JiraEventDataV1, MailEventDataV1 } from "../kafka-events";
import { extractKeys, threadKey, threadTitle } from "../kafka-rules";
import {
  activityMonth,
  activityPersonId,
  PEOPLE_ACTIVITY_SCHEMA,
  type ActivityMonthV1,
  type ActivityRowV1,
  type ActivityThreadV1,
} from "./activity";

const projectKeys = new Map<string, string>([
  ...githubProjectProfiles.map((profile) => [profile.projectId, profile.projectKey] as const),
  ...communitySourceProfiles.map((profile) => [profile.projectId, profile.projectKey] as const),
]);

/** The newest version of each record, as `compactState` keeps it. */
function latestVersions(events: readonly DomainEventV1[]): readonly DomainEventV1[] {
  const current = new Map<string, DomainEventV1>();
  for (const event of events) {
    const key = `${event.projectId}\u0000${event.sourceInstanceId}\u0000${event.entityId}`;
    const previous = current.get(key);
    if (previous === undefined || event.sourceTimestamp > previous.sourceTimestamp ||
        (event.sourceTimestamp === previous.sourceTimestamp && event.sourceCursor > previous.sourceCursor)) {
      current.set(key, event);
    }
  }
  return [...current.values()];
}

interface Draft {
  readonly projectId: string;
  readonly row: ActivityRowV1;
  readonly display: string;
}

/**
 * Every human-authored record in `events` as an activity row, with its thread and the author's
 * display name, grouped by project and by the month of the row's time. Rows before `from` are
 * left out: the log counts from its coverage start (and never past the 12-month horizon).
 */
export function activityMonthsFromEvents(events: readonly DomainEventV1[], from: string): readonly ActivityMonthV1[] {
  const latest = latestVersions(events);
  const byEntity = new Map(latest.map((event) => [`${event.projectId}\u0000${event.entityId}`, event]));
  const drafts: Draft[] = [];
  const threads = new Map<string, Map<string, ActivityThreadV1>>();
  /** Display names of row authors and thread authors, by project and person id. */
  const displays = new Map<string, string>();
  const setThread = (projectId: string, key: string, thread: ActivityThreadV1, authorDisplay?: string) => {
    (threads.get(projectId) ?? threads.set(projectId, new Map()).get(projectId)!).set(key, thread);
    if (thread.author !== null && authorDisplay !== undefined) displays.set(`${projectId}\u0000${thread.author}`, authorDisplay);
  };
  // dev@ threads take the oldest message's author and link, as the materializer anchors them.
  const mailAnchors = new Map<string, DomainEventV1 & { readonly data: MailEventDataV1 }>();

  for (const event of latest) {
    const projectKey = projectKeys.get(event.projectId);
    if (projectKey === undefined) continue;
    const prefix = projectKey.toUpperCase();
    const contract = (event.data as { readonly contract?: unknown }).contract;
    if (contract === "github-record@1") {
      const data = event.data as GitHubEventDataV1;
      const rootId = data.recordKind === "comment" ? data.parentEntityId! : event.entityId;
      const isPull = data.recordKind === "pull-request" || (data.recordKind === "comment" && /:pull:\d+$/u.test(rootId));
      const thread = `${prefix}-${isPull ? "PR" : "ISSUE"}-${data.externalNumber}`;
      const root = byEntity.get(`${event.projectId}\u0000${rootId}`)?.data as GitHubEventDataV1 | undefined;
      if (root !== undefined && root.recordKind !== "comment") {
        setThread(event.projectId, thread, {
          source: "github", kind: isPull ? "pull-request" : "issue", title: root.title,
          url: byEntity.get(`${event.projectId}\u0000${rootId}`)!.canonicalUrl,
          author: root.isBot ? null : activityPersonId("github", root.author) ?? null,
          labels: [...root.labels].sort(), kips: [...extractKeys(root.title).kips],
        }, root.author);
      } else if (!threads.get(event.projectId)?.has(thread)) {
        // The root fell out of the state: the thread is known by its number only.
        setThread(event.projectId, thread, {
          source: "github", kind: isPull ? "pull-request" : "issue", title: `#${data.externalNumber}`,
          url: event.canonicalUrl.replace(/#.*$/u, ""), author: null, labels: [], kips: [],
        });
      }
      if (data.isBot) continue;
      const person = activityPersonId("github", data.author);
      if (person === undefined) continue;
      drafts.push({
        projectId: event.projectId,
        display: data.author,
        row: {
          id: event.entityId, source: "github", kind: data.recordKind, person, thread,
          at: data.recordKind === "comment" ? data.occurredAt : data.createdAt,
          ...(data.mergedAt === undefined ? {} : { merged: data.mergedAt }),
        },
      });
    } else if (contract === "jira-record@1") {
      const data = event.data as JiraEventDataV1;
      const thread = data.key;
      if (data.recordKind === "issue") {
        setThread(event.projectId, thread, {
          source: "jira", kind: "issue", title: data.title, url: event.canonicalUrl,
          author: data.isBot ? null : activityPersonId("jira", data.author) ?? null, labels: [], kips: [...data.kips].sort(),
          // Amendment (7), W67: only on events read since the connector requests `assignee`.
          ...(data.assignee === undefined ? {} : {
            reporter: data.reporterKey === undefined ? null : { key: data.reporterKey, display: data.author },
            assignee: data.assignee === null ? null : { key: data.assignee.key, display: data.assignee.displayName },
          }),
        }, data.author);
      } else if (!threads.get(event.projectId)?.has(thread)) {
        const root = byEntity.get(`${event.projectId}\u0000${data.parentEntityId}`);
        if (root === undefined) {
          setThread(event.projectId, thread, {
            source: "jira", kind: "issue", title: thread, url: event.canonicalUrl.replace(/\?.*$/u, ""), author: null, labels: [], kips: [],
          });
        }
      }
      if (data.isBot) continue;
      const person = activityPersonId("jira", data.author);
      if (person === undefined) continue;
      drafts.push({
        projectId: event.projectId,
        display: data.author,
        row: { id: event.entityId, source: "jira", kind: data.recordKind, person, thread, at: data.occurredAt },
      });
    } else if (contract === "mail-record@1") {
      const data = event.data as MailEventDataV1;
      const key = threadKey(data.subject);
      const thread = `${prefix}-MAIL-${sha256(key).slice(0, 8)}`;
      const anchorKey = `${event.projectId}\u0000${thread}`;
      const anchor = mailAnchors.get(anchorKey);
      if (anchor === undefined || data.occurredAt < anchor.data.occurredAt ||
          (data.occurredAt === anchor.data.occurredAt && event.entityId < anchor.entityId)) {
        mailAnchors.set(anchorKey, event as DomainEventV1 & { readonly data: MailEventDataV1 });
      }
      const person = activityPersonId("mail", data.author);
      if (person === undefined) continue;
      drafts.push({
        projectId: event.projectId,
        display: data.author,
        row: {
          id: event.entityId, source: "mail", kind: "message", person, thread, at: data.occurredAt,
          // Amendment (7), W67: a subject without a reply prefix opens the thread.
          ...(threadTitle(data.subject) === data.subject.replace(/\s+/gu, " ").trim() ? { opens: true as const } : {}),
        },
      });
    }
  }
  // A dev@ thread's KIPs are those of every subject in it, as on the thread card.
  const mailKips = new Map<string, Set<string>>();
  for (const event of latest) {
    const data = event.data as Partial<MailEventDataV1>;
    if (data.contract !== "mail-record@1") continue;
    const key = `${event.projectId}\u0000${projectKeys.get(event.projectId)?.toUpperCase()}-MAIL-${sha256(threadKey(data.subject!)).slice(0, 8)}`;
    for (const kip of data.kips ?? []) (mailKips.get(key) ?? mailKips.set(key, new Set()).get(key)!).add(kip);
  }
  for (const [anchorKey, anchor] of mailAnchors) {
    const [projectId, thread] = anchorKey.split("\u0000") as [string, string];
    setThread(projectId, thread, {
      source: "mail", kind: "mail-thread", title: threadTitle(anchor.data.subject), url: anchor.canonicalUrl,
      author: activityPersonId("mail", anchor.data.author) ?? null, labels: [], kips: [...(mailKips.get(anchorKey) ?? [])].sort(),
    }, anchor.data.author);
  }

  const months = new Map<string, { projectId: string; month: string; rows: ActivityRowV1[]; people: Record<string, string>; threads: Record<string, ActivityThreadV1> }>();
  for (const draft of drafts) {
    if (draft.row.at < from) continue;
    const month = activityMonth(draft.row.at);
    const key = `${draft.projectId}\u0000${month}`;
    const entry = months.get(key) ?? months.set(key, { projectId: draft.projectId, month, rows: [], people: {}, threads: {} }).get(key)!;
    entry.rows.push(draft.row);
    entry.people[draft.row.person] = draft.display;
    const thread = threads.get(draft.projectId)!.get(draft.row.thread)!;
    entry.threads[draft.row.thread] = thread;
    const authorDisplay = thread.author === null ? undefined : displays.get(`${draft.projectId}\u0000${thread.author}`);
    if (authorDisplay !== undefined) entry.people[thread.author!] ??= authorDisplay;
  }
  return [...months.values()]
    .sort((a, b) => (a.projectId === b.projectId ? a.month.localeCompare(b.month) : a.projectId.localeCompare(b.projectId)))
    .map((entry) => ({ schema: PEOPLE_ACTIVITY_SCHEMA, ...entry }));
}
