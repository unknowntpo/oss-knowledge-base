/**
 * Spec 019 slice 2a: a constructed Spec 022 review store for the local E2E bucket, dated relative
 * to the moment it is seeded so it always falls in the 12-month view. Authors match the Feed
 * fixture (`alice`, `bob`, `carol` in Kafka). Constructed data, labelled as such.
 */
import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import {
  activityMonthsFromEvents,
  encodeActivityMonth,
  encodeActivitySummary,
  PEOPLE_ACTIVITY_STATE_SCHEMA,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  peopleActivitySummaryKey,
  encodeReviewMonth,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsMonthKey,
  githubReviewsStateKey,
  reviewMonth,
  type IdentityLinksTableV1,
  type ReviewRow,
} from "@oss-knowledge-base/reference-pipeline";
import { kipAuthorsKey, type KipAuthorsTableV1 } from "@oss-knowledge-base/reference-pipeline/kip-pages";
import { profileIdentityLinksKey } from "@oss-knowledge-base/reference-pipeline/people";

const DAY_MS = 86_400_000;

export function peopleE2eRows(nowMs: number): readonly ReviewRow[] {
  const at = (daysAgo: number) => new Date(nowMs - daysAgo * DAY_MS).toISOString().replace(/\.\d{3}Z$/u, "Z");
  const row = (reviewId: number, pr: number, prAuthor: string, reviewer: string, state: ReviewRow["state"], daysAgo: number, inlineComments = 0, isBot = false): ReviewRow =>
    ({ reviewId, pr, prAuthor, reviewer, isBot, state, submittedAt: at(daysAgo), commit: null, inlineComments });
  return [
    row(1001, 43, "bob", "alice", "APPROVED", 2),
    row(1002, 43, "bob", "carol", "COMMENTED", 3, 2),
    row(1003, 43, "bob", "bob", "COMMENTED", 3, 1),
    row(1004, 43, "bob", "github-actions[bot]", "COMMENTED", 4, 0, true),
    row(1005, 41, "dave", "alice", "CHANGES_REQUESTED", 40),
    row(1006, 40, "erin", "alice", "COMMENTED", 120, 3),
    row(1007, 39, "alice", "carol", "APPROVED", 200),
  ];
}

/**
 * Spec 019 slice 2b: constructed activity-log events: alice opens and comments on Kafka pull
 * requests (labels `clients`, `small`), and a dev@ identity "Dana Mailer" writes in a KIP thread.
 */
export function peopleE2eActivityEvents(nowMs: number): readonly DomainEventV1[] {
  const at = (daysAgo: number) => new Date(nowMs - daysAgo * DAY_MS).toISOString().replace(/\.\d{3}Z$/u, "Z");
  const base = (sourceInstanceId: string, entityId: string, time: string, url: string, data: Readonly<Record<string, unknown>>) => ({
    schemaVersion: 1, id: `e2e:${entityId}`, projectId: "apache-kafka", sourceType: "code-host", sourceInstanceId, entityType: "artifact",
    entityId, eventType: "updated", sourceCursor: time, sourceTimestamp: time, observedAt: time, canonicalUrl: url, payloadRef: "e2e",
    sourceConnectorVersion: "e2e", communityProfileVersion: "e2e", data,
  }) as DomainEventV1;
  const pull = (number: number, author: string, daysAgo: number, labels: readonly string[], merged: boolean) => base("kafka:github", `kafka:github:pull:${number}`, at(daysAgo),
    `https://github.com/apache/kafka/pull/${number}`, {
      contract: "github-record@1", recordKind: "pull-request", externalNumber: number, title: `KAFKA-1${number}: constructed change ${number}`, excerpt: "-",
      author, authorRole: "Contributor", occurredAt: at(daysAgo), createdAt: at(daysAgo), updatedAt: at(daysAgo), nativeState: merged ? "closed" : "open",
      ...(merged ? { mergedAt: at(daysAgo) } : {}), labels, isBot: false,
    });
  const comment = (number: number, id: number, author: string, daysAgo: number) => base("kafka:github", `kafka:github:pull:${number}:comment:${id}`, at(daysAgo),
    `https://github.com/apache/kafka/pull/${number}#issuecomment-${id}`, {
      contract: "github-record@1", recordKind: "comment", externalNumber: number, parentEntityId: `kafka:github:pull:${number}`, title: `Comment on #${number}`,
      excerpt: "-", author, authorRole: "Contributor", occurredAt: at(daysAgo), createdAt: at(daysAgo), updatedAt: at(daysAgo), labels: [], isBot: false,
    });
  const mail = (id: string, author: string, daysAgo: number, subject: string) => base("kafka:mail:dev", `kafka:mail:dev:message:${id}`, at(daysAgo),
    `https://lists.apache.org/thread/${id}`, {
      contract: "mail-record@1", subject, author, occurredAt: at(daysAgo), excerpt: "-", kips: subject.includes("KIP-1368") ? ["KIP-1368"] : [], issueKeys: [],
    });
  return [
    pull(43, "bob", 5, ["clients", "small"], false),
    pull(44, "alice", 6, ["clients", "ci-approved"], true),
    pull(45, "alice", 20, ["streams"], false),
    comment(43, 1, "alice", 3),
    comment(43, 2, "alice", 2),
    comment(44, 3, "bob", 4),
    mail("e2ea", "Dana Mailer", 9, "[DISCUSS] KIP-1368: constructed proposal"),
    mail("e2eb", "alice", 8, "Re: [DISCUSS] KIP-1368: constructed proposal"),
    mail("e2ec", "Dana Mailer", 4, "[VOTE] 9.9.9 RC0"),
  ];
}

/**
 * Spec 022 `metadata@2` (areas amendment): constructed labels, title KIPs and one public name. The
 * month of PR #39 (200 days ago) is left as `metadata@1` wrote it, so alice's own pull requests are
 * partly covered (W49) while the pull requests she reviewed are fully covered (W48).
 */
export const PEOPLE_E2E_PULLS: Readonly<Record<number, { readonly labels: readonly string[]; readonly kips?: readonly string[] }>> = {
  43: { labels: ["clients", "consumer", "small", "triage"], kips: ["KIP-1071"] },
  41: { labels: ["ci-approved", "core", "storage"] },
  40: { labels: ["KIP-932", "streams", "tests"] },
};
export const PEOPLE_E2E_NAMES: Readonly<Record<string, string>> = { alice: "Alice Example" };

export function peopleE2eObjects(nowMs: number): readonly { readonly key: string; readonly body: string }[] {
  const projectId = "apache-kafka";
  const byMonth = new Map<string, ReviewRow[]>();
  for (const row of peopleE2eRows(nowMs)) byMonth.set(reviewMonth(row.submittedAt), [...(byMonth.get(reviewMonth(row.submittedAt)) ?? []), row]);
  const extras = (rows: readonly ReviewRow[]) => {
    const prs = [...new Set(rows.map((row) => row.pr))].filter((pr) => PEOPLE_E2E_PULLS[pr] !== undefined);
    if (prs.length === 0) return {};
    const logins = [...new Set(rows.flatMap((row) => [row.reviewer, row.prAuthor]))].filter((login) => PEOPLE_E2E_NAMES[login] !== undefined).sort();
    return {
      pulls: Object.fromEntries(prs.sort((a, b) => a - b).map((pr) => [String(pr), PEOPLE_E2E_PULLS[pr]!])),
      people: Object.fromEntries(logins.map((login) => [login, PEOPLE_E2E_NAMES[login]!])),
    };
  };
  const coverageFrom = new Date(nowMs - 395 * DAY_MS).toISOString();
  return [
    { key: githubReviewsStateKey(projectId), body: JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: new Date(nowMs - DAY_MS).toISOString(), coverageFrom }) },
    ...[...byMonth].map(([month, rows]) => ({ key: githubReviewsMonthKey(projectId, month), body: encodeReviewMonth(projectId, month, rows, extras(rows)) })),
    ...peopleE2eActivityObjects(nowMs),
    ...peopleE2eKipObjects(nowMs),
  ];
}

/**
 * Spec 019 amendment (7), slice C: a constructed `authors.json` and identity-link table, read only
 * where `PEOPLE_KIPS=true` (unset in every configuration, so the E2E pages do not show them; the
 * section's screenshots start `pages dev` with the binding). Dana Mailer started the KIP-1368
 * discussion above and is on its author line; `github:alice` reaches "Alice Example" on dev@ through
 * a declared link and her Jira account through a corroborated one.
 */
export function peopleE2eKipObjects(nowMs: number): readonly { readonly key: string; readonly body: string }[] {
  const projectId = "apache-kafka";
  const readAt = new Date(nowMs - DAY_MS).toISOString();
  const issue = (key: string) => `https://issues.apache.org/jira/browse/${key}`;
  const authors: KipAuthorsTableV1 = {
    schema: "osskb.kip-authors.v1", generatedAt: readAt, coverageFrom: new Date(nowMs - 366 * DAY_MS).toISOString(),
    pages: [
      {
        kip: 1368, pageId: "900001368", version: 3, title: "KIP-1368: constructed proposal", url: "https://cwiki.apache.org/confluence/pages/viewpage.action?pageId=900001368",
        status: "listed", authors: ["Dana Mailer", "Alice Example", "Erin Plain"].map((name) => ({ name, nameKey: name })),
        jira: "one", issues: [{ key: "KAFKA-11368", assignee: { key: "JIRAUSER900010", display: "Alice Example" }, readAt }],
      },
      {
        kip: 1370, pageId: "900001370", version: 1, title: "KIP-1370: constructed follow-up without an author line", url: "https://cwiki.apache.org/confluence/pages/viewpage.action?pageId=900001370",
        status: "no-list", authors: [], jira: "several",
        issues: [{ key: "KAFKA-11370", assignee: { key: "JIRAUSER900010", display: "Alice Example" }, readAt }, { key: "KAFKA-11371", assignee: null, readAt }],
      },
    ],
  };
  const links: IdentityLinksTableV1 = {
    schema: "osskb.identity-links.v1", revision: "corroborated@1", projectId, generatedAt: readAt,
    inputs: { coverageFrom: new Date(nowMs - 36 * DAY_MS).toISOString(), months: [], activityUpdatedAt: readAt, rosterAt: null },
    people: [{
      members: [{ id: "github:alice" }, { id: "jira-account:JIRAUSER900010", display: "Alice Example" }, { id: "mail:alice example" }],
      links: [
        { a: "github:alice", b: "jira-account:JIRAUSER900010", basis: "corroborated", evidence: ["KAFKA-143", "KAFKA-144", "KAFKA-145"].map((id) => ({ id, url: issue(id) })) },
        { a: "github:alice", b: "mail:alice example", basis: "declared", evidence: [{ id: "declared", url: "https://example.org/e2e/alice" }], date: "2026-10-21", reviewer: "e2e" },
      ],
    }],
  };
  return [
    { key: kipAuthorsKey(projectId), body: JSON.stringify(authors) },
    { key: profileIdentityLinksKey(projectId), body: JSON.stringify(links) },
  ];
}

/** Slice 2b: the objects a first append at `nowMs − 1 day` writes for the constructed events. */
export function peopleE2eActivityObjects(nowMs: number): readonly { readonly key: string; readonly body: string }[] {
  const appendedAt = new Date(nowMs - DAY_MS).toISOString();
  const coverageFrom = new Date(nowMs - 36 * DAY_MS).toISOString();
  const months = activityMonthsFromEvents(peopleE2eActivityEvents(nowMs), coverageFrom);
  return [
    ...["apache-kafka", "apache-datafusion"].map((projectId) => ({
      key: peopleActivityStateKey(projectId),
      body: JSON.stringify({
        schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: appendedAt, coverageFrom, updatedAt: appendedAt,
        months: months.filter((month) => month.projectId === projectId).map((month) => month.month),
      }),
    })),
    ...months.flatMap((month) => [
      { key: peopleActivityMonthKey(month.projectId, month.month), body: encodeActivityMonth(month) },
      { key: peopleActivitySummaryKey(month.projectId, month.month), body: encodeActivitySummary(month) },
    ]),
  ];
}
