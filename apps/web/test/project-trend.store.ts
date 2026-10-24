/**
 * Spec 030: the stores `project-trend.cases.ts` names, built in memory. Nothing here reads R2.
 *
 * - Reviews (constructed): Spec 022's store for Kafka with `coverageFrom` 2025-10-14 (RV35). Month
 *   i of the view (2025-11 = 0 … 2026-10 = 11) holds 20 + i reviews by people, plus three rows that
 *   are not a review given by a person: one by `dependabot` (a GitHub App login, W12), one typed
 *   `Bot` by GitHub (`github-actions[bot]`), and one by the pull request's author (W8). 2025-10
 *   holds a row too, outside the 12-month view.
 * - Activity (recorded): the Dev release of 2026-10-14 (`people-activity-fixture`), appended with
 *   Dev's real coverage start, 2026-09-10T02:45:16.847Z. Constructed additions: Jira issue
 *   KAFKA-99001 updated in September and again in October (stored in both month objects, as two
 *   appends leave it), a `dependabot` comment the log kept (its event was not typed `Bot`), and a
 *   dev@ message one second before the coverage start, which the reader must not count.
 */
import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import {
  activityMonthsFromEvents,
  encodeActivityMonth,
  encodeReviewMonth,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsMonthKey,
  githubReviewsStateKey,
  mergeActivityMonth,
  PEOPLE_ACTIVITY_SCHEMA,
  PEOPLE_ACTIVITY_STATE_SCHEMA,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  type ActivityMonthV1,
  type ReviewRow,
} from "@oss-knowledge-base/reference-pipeline";
import type { PeopleBucket } from "@oss-knowledge-base/reference-pipeline/people";

import { fixtureEvents } from "../../../packages/reference-pipeline/test/support/people-activity-fixture";

export const PROJECT_ID = "apache-kafka";
/** The controlled clock of PT5: 2026-10-24, the view is 2025-11 … 2026-10. */
export const NOW = Date.parse("2026-10-24T03:00:00.000Z");
export const REVIEWS_FROM = "2025-10-14T00:00:00.000Z";
export const REVIEWS_UPDATED = "2026-10-23T22:02:21.000Z";
/** Dev's activity log: first append 2026-10-15T02:45:16.847Z, minus 35 days. */
export const LOG_FROM = "2026-09-10T02:45:16.847Z";
export const LOG_FIRST_APPEND = "2026-10-15T02:45:16.847Z";
export const LOG_UPDATED = "2026-10-24T02:45:16.847Z";

export const VIEW_MONTHS = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"] as const;

function reviewRows(month: string, people: number): ReviewRow[] {
  const at = (day: number, minute: number) => `${month}-${String(day).padStart(2, "0")}T10:${String(minute % 60).padStart(2, "0")}:00Z`;
  const id = Number(month.replace("-", "")) * 100;
  const rows: ReviewRow[] = [];
  for (let n = 0; n < people; n += 1) {
    rows.push({ reviewId: id + n, pr: 20000 + n, prAuthor: `author${n % 5}`, reviewer: `reviewer${n % 7}`, isBot: false,
      state: n % 3 === 0 ? "COMMENTED" : "APPROVED", submittedAt: at(1 + (n % 20), n), commit: null, inlineComments: n % 2 });
  }
  rows.push({ reviewId: id + 90, pr: 20090, prAuthor: "author1", reviewer: "dependabot", isBot: false, state: "COMMENTED", submittedAt: at(2, 1), commit: null, inlineComments: 0 });
  rows.push({ reviewId: id + 91, pr: 20091, prAuthor: "author1", reviewer: "github-actions[bot]", isBot: true, state: "COMMENTED", submittedAt: at(3, 2), commit: null, inlineComments: 0 });
  rows.push({ reviewId: id + 92, pr: 20092, prAuthor: "author2", reviewer: "author2", isBot: false, state: "COMMENTED", submittedAt: at(4, 3), commit: null, inlineComments: 1 });
  // W12 across months: GitHub typed `ci-runner` `Bot` in January only; its untyped review in February still counts for nobody.
  if (month === "2026-01") rows.push({ reviewId: id + 93, pr: 20093, prAuthor: "author3", reviewer: "ci-runner", isBot: true, state: "COMMENTED", submittedAt: at(5, 4), commit: null, inlineComments: 0 });
  if (month === "2026-02") rows.push({ reviewId: id + 93, pr: 20093, prAuthor: "author3", reviewer: "ci-runner", isBot: false, state: "COMMENTED", submittedAt: at(5, 4), commit: null, inlineComments: 0 });
  return rows;
}

function jiraIssue(at: string): DomainEventV1 {
  return {
    schemaVersion: 1, id: `constructed:KAFKA-99001:${at}`, projectId: PROJECT_ID, sourceType: "issue-tracker", sourceInstanceId: "kafka:jira",
    entityType: "artifact", entityId: "kafka:jira:issue:KAFKA-99001", eventType: "updated", sourceCursor: at, sourceTimestamp: at, observedAt: at,
    canonicalUrl: "https://issues.apache.org/jira/browse/KAFKA-99001", payloadRef: "constructed", sourceConnectorVersion: "constructed",
    communityProfileVersion: "constructed",
    data: { contract: "jira-record@1", recordKind: "issue", key: "KAFKA-99001", title: "KAFKA-99001: constructed", excerpt: "-", author: "Constructed Reporter", occurredAt: at, nativeStatus: "Open", status: "open", kips: [], isBot: false },
  } as DomainEventV1;
}

function dependabotComment(at: string): DomainEventV1 {
  return {
    schemaVersion: 1, id: `constructed:dependabot:${at}`, projectId: PROJECT_ID, sourceType: "code-host", sourceInstanceId: "kafka:github",
    entityType: "artifact", entityId: "kafka:github:pull:99002:comment:1", eventType: "updated", sourceCursor: at, sourceTimestamp: at, observedAt: at,
    canonicalUrl: "https://github.com/apache/kafka/pull/99002#issuecomment-1", payloadRef: "constructed", sourceConnectorVersion: "constructed",
    communityProfileVersion: "constructed",
    data: { contract: "github-record@1", recordKind: "comment", externalNumber: 99002, parentEntityId: "kafka:github:pull:99002", title: "Comment on #99002",
      excerpt: "-", author: "dependabot", authorRole: "Contributor", occurredAt: at, createdAt: at, updatedAt: at, labels: [], isBot: false },
  } as DomainEventV1;
}

/** A month object as the publisher's appends leave it: each append's months merged into the stored ones (W2). */
function appendAll(appends: readonly (readonly ActivityMonthV1[])[]): Map<string, ActivityMonthV1> {
  const months = new Map<string, ActivityMonthV1>();
  for (const append of appends) for (const month of append) months.set(month.month, mergeActivityMonth(months.get(month.month), month));
  return months;
}

export type StoreName = "full" | "review-month-corrupt" | "activity-month-corrupt" | "no-activity" | "nothing";

export function store(name: StoreName): Map<string, string> {
  const objects = new Map<string, string>();
  if (name === "nothing") return objects;
  objects.set(githubReviewsStateKey(PROJECT_ID), JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: REVIEWS_UPDATED, coverageFrom: REVIEWS_FROM }));
  for (const month of ["2025-10", ...VIEW_MONTHS]) {
    const index = VIEW_MONTHS.indexOf(month as (typeof VIEW_MONTHS)[number]);
    objects.set(githubReviewsMonthKey(PROJECT_ID, month), encodeReviewMonth(PROJECT_ID, month, reviewRows(month, index < 0 ? 5 : 20 + index)));
  }
  if (name === "review-month-corrupt") objects.set(githubReviewsMonthKey(PROJECT_ID, "2026-03"), "{ not json");
  if (name === "no-activity") return objects;

  const months = appendAll([
    activityMonthsFromEvents([...fixtureEvents(), jiraIssue("2026-09-20T08:00:00Z"), dependabotComment("2026-10-02T09:00:00Z")], LOG_FROM),
    activityMonthsFromEvents([jiraIssue("2026-10-05T08:00:00Z")], LOG_FROM),
  ]);
  // A row the writer would not keep (before the coverage start): the reader must not count it either.
  const september = months.get("2026-09")!;
  const early = Object.keys(september.threads).find((key) => september.threads[key]!.source === "mail")!;
  months.set("2026-09", { ...september, rows: [...september.rows, { id: "constructed:early-mail", source: "mail", kind: "message", person: "mail:early sender", at: "2026-09-10T02:45:15.000Z", thread: early }] });
  for (const month of months.values()) objects.set(peopleActivityMonthKey(PROJECT_ID, month.month), encodeActivityMonth(month));
  objects.set(peopleActivityStateKey(PROJECT_ID), JSON.stringify({
    schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: LOG_FIRST_APPEND, coverageFrom: LOG_FROM, updatedAt: LOG_UPDATED, months: [...months.keys()].sort(),
  }));
  if (name === "activity-month-corrupt") objects.set(peopleActivityMonthKey(PROJECT_ID, "2026-09"), JSON.stringify({ schema: PEOPLE_ACTIVITY_SCHEMA, projectId: PROJECT_ID, month: "2026-09", rows: "broken" }));
  return objects;
}

/** An R2 stand-in that records each read; `broken` keys throw (a failed R2 call). */
export class CountingBucket implements PeopleBucket {
  readonly reads: string[] = [];
  bytes = 0;
  constructor(readonly objects: ReadonlyMap<string, string>, readonly broken: Set<string> = new Set()) {}
  async get(key: string) {
    this.reads.push(key);
    if (this.broken.has(key)) throw new Error(`R2 failed for ${key}`);
    const body = this.objects.get(key);
    if (body === undefined) return null;
    this.bytes += new TextEncoder().encode(body).length;
    return { text: async () => body };
  }
}
