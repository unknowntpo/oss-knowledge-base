/**
 * Spec 015 slice 3 test plan (web), [pending] until slice 3 runs it.
 * See review-queue.cases.ts for the capture notes.
 */
export const testPlanRows = [
  { id: "Q7", rule: "column", input: "fixture: apache-datafusion (proposal.kind null)", expected: "no KIP column" },
  { id: "Q5", rule: "block", input: "fixture queue for apache-kafka", expected: "#review-queue shows PR 393 and KIP 13, 3 rows each, link \"All\" to /#/review/apache-kafka" },
  { id: "Q6", rule: "card", input: "fixture: topic page with #23724 and #23739", expected: ".pr-review-label \"Awaiting reviewer\" and \"In review · 4 reviewers\"" },
  { id: "Q15", rule: "i18n", input: "every review.* key", expected: "present in en and zh-Hant" },
  { id: "Q31", rule: "stale", input: "object generatedAt 3 h 0 min 1 s ago (controlled clock)", expected: "freshness line stale" },
  { id: "Q31", rule: "stale", input: "object generatedAt 2 h 59 min ago, github section fetchedAt 5 h ago", expected: "PR column shows its own as-of time, stale" },
];
