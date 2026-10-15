/**
 * Spec 019 slice 2a: a constructed Spec 022 review store for the local E2E bucket, dated relative
 * to the moment it is seeded so it always falls in the 12-month view. Authors match the Feed
 * fixture (`alice`, `bob`, `carol` in Kafka). Constructed data, labelled as such.
 */
import {
  encodeReviewMonth,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsMonthKey,
  githubReviewsStateKey,
  reviewMonth,
  type ReviewRow,
} from "@oss-knowledge-base/reference-pipeline";

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

export function peopleE2eObjects(nowMs: number): readonly { readonly key: string; readonly body: string }[] {
  const projectId = "apache-kafka";
  const byMonth = new Map<string, ReviewRow[]>();
  for (const row of peopleE2eRows(nowMs)) byMonth.set(reviewMonth(row.submittedAt), [...(byMonth.get(reviewMonth(row.submittedAt)) ?? []), row]);
  const coverageFrom = new Date(nowMs - 395 * DAY_MS).toISOString();
  return [
    { key: githubReviewsStateKey(projectId), body: JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: new Date(nowMs - DAY_MS).toISOString(), coverageFrom }) },
    ...[...byMonth].map(([month, rows]) => ({ key: githubReviewsMonthKey(projectId, month), body: encodeReviewMonth(projectId, month, rows) })),
  ];
}
