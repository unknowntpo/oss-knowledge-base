/**
 * Spec 019 slice 2b: the recorded Dev fixture (`fixtures/people-activity/kafka-dev.json`, captured
 * by `scripts/capture-people-activity-fixture.ts`) as the domain events the publication state holds.
 * Every recorded value (id, kind, author, time, labels, title, link, merged state, creation time)
 * comes from the fixture; fields the profile never reads (excerpt, role) are placeholders.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DomainEventV1 } from "@oss-knowledge-base/domain";

import type { GitHubEventDataV1 } from "../../src/event-data";
import type { JiraEventDataV1, MailEventDataV1 } from "../../src/kafka-events";
import { extractKeys } from "../../src/kafka-rules";

export interface FixtureRecord {
  readonly id: string;
  readonly kind: "Pull Request" | "Issue" | "Comment" | "Jira Issue" | "Jira Comment" | "Mail";
  readonly author: string;
  readonly occurredAt: string;
  readonly url: string;
  readonly status?: string;
}
export interface FixtureThread {
  readonly displayId: string;
  readonly source: "github" | "jira" | "mail";
  readonly title: string;
  readonly labels: readonly string[];
  readonly rootId: string;
  readonly records: readonly FixtureRecord[];
}
export interface PeopleActivityFixture {
  readonly capturedAt: string;
  /** The Dev release the fixture was read from: the test's publication time. */
  readonly release: string;
  readonly createdAt: Readonly<Record<string, string>>;
  readonly threads: readonly FixtureThread[];
}

export const peopleActivityFixture: PeopleActivityFixture = JSON.parse(
  readFileSync(join(import.meta.dir, "../fixtures/people-activity/kafka-dev.json"), "utf8"),
);

function event(sourceInstanceId: string, entityId: string, sourceTimestamp: string, canonicalUrl: string, data: Readonly<Record<string, unknown>>): DomainEventV1 {
  return {
    schemaVersion: 1,
    id: `fixture:${entityId}`,
    projectId: "apache-kafka",
    sourceType: sourceInstanceId === "kafka:github" ? "code-host" : sourceInstanceId === "kafka:jira" ? "issue-tracker" : "mailing-list",
    sourceInstanceId,
    entityType: "artifact",
    entityId,
    eventType: "updated",
    sourceCursor: sourceTimestamp,
    sourceTimestamp,
    observedAt: sourceTimestamp,
    canonicalUrl,
    payloadRef: `fixture://${entityId}`,
    sourceConnectorVersion: "fixture@1",
    communityProfileVersion: sourceInstanceId === "kafka:github" ? "apache-kafka@github-live-1" : "apache-kafka@community-live-1",
    data,
  } as DomainEventV1;
}

/** The fixture's records as `github-record@1`, `jira-record@1` and `mail-record@1` events. */
export function fixtureEvents(fixture: PeopleActivityFixture = peopleActivityFixture): DomainEventV1[] {
  const events: DomainEventV1[] = [];
  for (const thread of fixture.threads) {
    const root = thread.records.find((record) => record.id === thread.rootId)!;
    for (const record of thread.records) {
      if (thread.source === "github") {
        const number = Number(thread.displayId.split("-").at(-1));
        const isRoot = record.id === thread.rootId;
        const data: GitHubEventDataV1 = {
          contract: "github-record@1",
          recordKind: isRoot ? (record.kind === "Issue" ? "issue" : "pull-request") : "comment",
          externalNumber: number,
          ...(isRoot ? {} : { parentEntityId: thread.rootId }),
          title: isRoot ? thread.title : `Comment on #${number}`,
          excerpt: "(fixture)",
          author: record.author,
          authorRole: "Contributor",
          occurredAt: record.occurredAt,
          createdAt: isRoot ? fixture.createdAt[record.id] ?? record.occurredAt : record.occurredAt,
          updatedAt: record.occurredAt,
          ...(isRoot ? { nativeState: record.status === "open" ? "open" : "closed" } : {}),
          ...(isRoot && record.status === "merged" ? { mergedAt: record.occurredAt } : {}),
          labels: isRoot ? thread.labels : [],
          isBot: record.author.toLowerCase().includes("bot"),
        } as GitHubEventDataV1;
        events.push(event("kafka:github", record.id, record.occurredAt, record.url, data));
      } else if (thread.source === "jira") {
        const isRoot = record.id === thread.rootId;
        const data: JiraEventDataV1 = {
          contract: "jira-record@1",
          recordKind: isRoot ? "issue" : "comment",
          key: thread.displayId,
          ...(isRoot ? {} : { parentEntityId: thread.rootId }),
          title: isRoot ? thread.title : `Comment on ${thread.displayId}`,
          excerpt: "(fixture)",
          author: record.author,
          occurredAt: record.occurredAt,
          ...(isRoot ? { nativeStatus: "Open", status: "open" } : {}),
          kips: isRoot ? extractKeys(thread.title).kips : [],
          isBot: /bot/iu.test(record.author),
        } as JiraEventDataV1;
        events.push(event("kafka:jira", record.id, record.occurredAt, record.url, data));
      } else {
        const subject = record.id === root.id ? thread.title : `Re: ${thread.title}`;
        const keys = extractKeys(subject);
        const data: MailEventDataV1 = {
          contract: "mail-record@1", subject, author: record.author, occurredAt: record.occurredAt, excerpt: "(fixture)",
          kips: keys.kips, issueKeys: keys.issueKeys,
        };
        events.push(event("kafka:mail:dev", record.id, record.occurredAt, record.url, data));
      }
    }
  }
  return events;
}
