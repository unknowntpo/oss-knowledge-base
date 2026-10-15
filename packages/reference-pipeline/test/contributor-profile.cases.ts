/**
 * Spec 019 slice 2a test plan: the single source for `contributor-profile.test.ts` and for the
 * table in docs/specs/019-contributor-profile/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * Store: Spec 022 month objects built with `reviewRows` from the recorded GraphQL answer for Kafka
 * #23675 and #23165 (`fixtures/github-reviews/graphql-pull-reviews-kafka.json`, `recorded`), plus
 * the rows of `constructedRows` below (`constructed`). `state.json`: `coverageFrom`
 * 2025-10-14T00:00:00.000Z, cursor 2026-10-14T22:02:21Z (Dev's values on 2026-10-15). Request
 * time 2026-10-15T12:00:00Z, so the 12-month view is 2025-11 … 2026-10.
 *
 * `given` = reviews given / distinct PRs; `byState` counts reviews given; `received` = reviews
 * received / distinct PRs / distinct reviewers; `worksWith` = both relations, shared PRs.
 */
export const constructedRows = [
  { reviewId: 1, pr: 90001, prAuthor: "constructed-author", reviewer: "mjsax", isBot: false, state: "CHANGES_REQUESTED", submittedAt: "2026-09-15T10:00:00Z", commit: null, inlineComments: 3 },
  { reviewId: 2, pr: 90001, prAuthor: "constructed-author", reviewer: "constructed-reviewer", isBot: false, state: "DISMISSED", stateBefore: "APPROVED", submittedAt: "2026-09-16T10:00:00Z", commit: null, inlineComments: 0 },
  { reviewId: 3, pr: 90002, prAuthor: "dependabot", reviewer: "mjsax", isBot: false, state: "APPROVED", submittedAt: "2026-09-20T10:00:00Z", commit: null, inlineComments: 0 },
  { reviewId: 4, pr: 90003, prAuthor: "constructed-author", reviewer: "old-reviewer", isBot: false, state: "APPROVED", submittedAt: "2025-10-31T23:59:59Z", commit: null, inlineComments: 0 },
  // A GitHub App typed `Bot` in the rows that is on no static list, and that also opened a PR.
  { reviewId: 6, pr: 90005, prAuthor: "constructed-author", reviewer: "acme-review-app", isBot: true, state: "COMMENTED", submittedAt: "2026-09-21T10:00:00Z", commit: null, inlineComments: 1 },
  { reviewId: 7, pr: 90006, prAuthor: "acme-review-app", reviewer: "mjsax", isBot: false, state: "APPROVED", submittedAt: "2026-09-22T10:00:00Z", commit: null, inlineComments: 0 },
  { reviewId: 5, pr: 90004, prAuthor: "constructed-author", reviewer: "edge-reviewer", isBot: false, state: "APPROVED", submittedAt: "2025-11-01T00:00:00Z", commit: null, inlineComments: 0 },
] as const;

export const testPlanRows = [
  { id: "W8", case: "a reviewer who commented twice with inline comments", data: "recorded", person: "github:chia7712", suppressed: "—", status: 200, given: "2 / 1", byState: "commented 2", received: "0 / 0 / 0", worksWith: "reviewed PRs by gabriellefu 1" },
  { id: "W8", case: "an approval after comments; his own answer on his own PR (#23675) is left out", data: "recorded", person: "github:lucasbru", suppressed: "—", status: 200, given: "4 / 1", byState: "approved 1, commented 3", received: "1 / 1 / 1", worksWith: "reviewed PRs by gabriellefu 1; reviewed by bbejeck 1" },
  { id: "W8", case: "a PR author's 18 answers in her own review threads are no reviews given; the bot's review is not received", data: "recorded", person: "github:gabriellefu", suppressed: "—", status: 200, given: "0 / 0", byState: "—", received: "9 / 1 / 4", worksWith: "reviewed by chia7712 1, lucasbru 1, mjsax 1, squah-confluent 1" },
  { id: "W8", case: "one approval", data: "recorded", person: "github:bbejeck", suppressed: "—", status: 200, given: "1 / 1", byState: "approved 1", received: "0 / 0 / 0", worksWith: "reviewed PRs by lucasbru 1" },
  { id: "W8", case: "a change request, and approvals of two bots' PRs (counted, the bots not named)", data: "recorded + constructed", person: "github:mjsax", suppressed: "—", status: 200, given: "4 / 4", byState: "approved 2, changes requested 1, commented 1", received: "0 / 0 / 0", worksWith: "reviewed PRs by constructed-author 1, gabriellefu 1" },
  { id: "W8", case: "a dismissed review keeps its earlier verdict", data: "constructed", person: "github:constructed-reviewer", suppressed: "—", status: 200, given: "1 / 1", byState: "dismissed 1 (was approved)", received: "0 / 0 / 0", worksWith: "reviewed PRs by constructed-author 1" },
  { id: "W12", case: "GitHub typed the reviewer Bot in the stored rows", data: "recorded", person: "github:copilot-pull-request-reviewer", suppressed: "—", status: 404, given: "—", byState: "—", received: "—", worksWith: "—" },
  { id: "W12", case: "a login GitHub typed Bot, on no static list, that also authored a PR (learned from the rows)", data: "constructed", person: "github:acme-review-app", suppressed: "—", status: 404, given: "—", byState: "—", received: "—", worksWith: "—" },
  { id: "W12", case: "a login on the profile's bot list", data: "constructed", person: "github:dependabot", suppressed: "—", status: 404, given: "—", byState: "—", received: "—", worksWith: "—" },
  { id: "W12", case: "a suppressed identity has no profile (positive control: row 3)", data: "recorded", person: "github:gabriellefu", suppressed: "gabriellefu", status: 404, given: "—", byState: "—", received: "—", worksWith: "—" },
  { id: "W12", case: "a suppressed counterpart stays counted but unnamed (positive control: row 1)", data: "recorded", person: "github:chia7712", suppressed: "gabriellefu", status: 200, given: "2 / 1", byState: "commented 2", received: "0 / 0 / 0", worksWith: "—" },
  { id: "W11", case: "a login with no row in the store", data: "recorded", person: "github:nobody-here", suppressed: "—", status: 404, given: "—", byState: "—", received: "—", worksWith: "—" },
  { id: "W11", case: "a Jira identity: the source is not recorded in 2a", data: "—", person: "jira:5f2a9c1e", suppressed: "—", status: 404, given: "—", byState: "—", received: "—", worksWith: "—" },
  { id: "W26", case: "a review on the last second before the 12-month view (2025-10-31T23:59:59Z)", data: "constructed", person: "github:old-reviewer", suppressed: "—", status: 404, given: "—", byState: "—", received: "—", worksWith: "—" },
  { id: "W26", case: "a review on the first second of the view (2025-11-01T00:00:00Z)", data: "constructed", person: "github:edge-reviewer", suppressed: "—", status: 200, given: "1 / 1", byState: "approved 1", received: "0 / 0 / 0", worksWith: "reviewed PRs by constructed-author 1" },
] as const;

/** W27: the coverage the response states, per community. */
export const coverageRows = [
  { id: "W27", project: "kafka", coverage: "github-reviews 2025-11-01T00:00:00.000Z → 2026-10-14T22:02:21Z (stored from 2025-10-14T00:00:00.000Z); github, jira, mail not recorded" },
  { id: "W27", project: "datafusion", coverage: "github-reviews 2025-11-01T00:00:00.000Z → 2026-10-14T22:02:21Z (stored from 2025-10-14T00:00:00.000Z); github not recorded" },
] as const;
