/**
 * Spec 019 slice 3 test plan: the single source for `person-search.test.ts` and for the slice 3
 * table in docs/specs/019-contributor-profile/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * Store: the slice 2a store of `contributor-profile.cases.ts` (recorded Kafka #23675 and #23165
 * plus its constructed rows) and the `searchRows` below (`constructed`): five reviewers whose
 * logins share the prefix `lu`, a one-character login, and the deleted account `ghost`. Request time 2026-10-15T12:00:00Z.
 *
 * `people` = the response's `people` as `<id> <match>`, in order; `reads` = R2 reads on a cold
 * isolate (W41, W43).
 */
export const searchRows = [
  { reviewId: 101, pr: 90101, prAuthor: "constructed-author", reviewer: "lu", isBot: false, state: "APPROVED", submittedAt: "2026-08-03T10:00:00Z", commit: null, inlineComments: 0 },
  { reviewId: 102, pr: 90101, prAuthor: "constructed-author", reviewer: "lu-d", isBot: false, state: "COMMENTED", submittedAt: "2026-08-04T10:00:00Z", commit: null, inlineComments: 1 },
  { reviewId: 103, pr: 90101, prAuthor: "constructed-author", reviewer: "lu-b", isBot: false, state: "COMMENTED", submittedAt: "2026-08-05T10:00:00Z", commit: null, inlineComments: 0 },
  { reviewId: 104, pr: 90101, prAuthor: "constructed-author", reviewer: "Lu-C", isBot: false, state: "APPROVED", submittedAt: "2026-08-06T10:00:00Z", commit: null, inlineComments: 0 },
  { reviewId: 105, pr: 90101, prAuthor: "constructed-author", reviewer: "lu-a", isBot: false, state: "APPROVED", submittedAt: "2026-08-07T10:00:00Z", commit: null, inlineComments: 0 },
  { reviewId: 106, pr: 90102, prAuthor: "constructed-author", reviewer: "q", isBot: false, state: "APPROVED", submittedAt: "2026-08-08T10:00:00Z", commit: null, inlineComments: 0 },
  // GitHub's placeholder for a deleted account (Spec 022 stores it as `ghost`).
  { reviewId: 107, pr: 90102, prAuthor: "constructed-author", reviewer: "ghost", isBot: false, state: "COMMENTED", submittedAt: "2026-08-09T10:00:00Z", commit: null, inlineComments: 0 },
] as const;

export const testPlanRows = [
  { id: "W7", case: "the exact login", data: "recorded", project: "kafka", query: "chia7712", suppressed: "—", people: "github:chia7712 exact", reads: 13 },
  { id: "W7", case: "another case; the stored login is displayed", data: "recorded", project: "kafka", query: "CHIA7712", suppressed: "—", people: "github:chia7712 exact", reads: 13 },
  { id: "W7", case: "a leading @ is dropped", data: "recorded", project: "kafka", query: " @chia7712 ", suppressed: "—", people: "github:chia7712 exact", reads: 13 },
  { id: "W7", case: "a prefix", data: "recorded", project: "kafka", query: "chia", suppressed: "—", people: "github:chia7712 prefix", reads: 13 },
  { id: "W7", case: "two prefix matches, alphabetical", data: "constructed", project: "kafka", query: "constructed", suppressed: "—", people: "github:constructed-author prefix, github:constructed-reviewer prefix", reads: 13 },
  { id: "W7", case: "the exact login first, then prefixes alphabetically, at most 3 (lu-c, lu-d, lucasbru left out)", data: "recorded + constructed", project: "kafka", query: "lu", suppressed: "—", people: "github:lu exact, github:lu-a prefix, github:lu-b prefix", reads: 13 },
  { id: "W7", case: "at most 3 prefix matches; case does not change the order", data: "constructed", project: "kafka", query: "lu-", suppressed: "—", people: "github:lu-a prefix, github:lu-b prefix, github:Lu-C prefix", reads: 13 },
  { id: "W7", case: "the same store in another community", data: "recorded", project: "datafusion", query: "chia7712", suppressed: "—", people: "github:chia7712 exact", reads: 13 },
  { id: "W40", case: "GitHub typed the reviewer Bot in the stored rows", data: "recorded", project: "kafka", query: "copilot", suppressed: "—", people: "—", reads: 13 },
  { id: "W40", case: "a login typed Bot in one row, on no static list, that also authored a PR", data: "constructed", project: "kafka", query: "acme", suppressed: "—", people: "—", reads: 13 },
  { id: "W40", case: "a login on the profile's bot list", data: "constructed", project: "kafka", query: "dependabot", suppressed: "—", people: "—", reads: 13 },
  { id: "W40", case: "a suppressed identity", data: "recorded", project: "kafka", query: "gabriellefu", suppressed: "gabriellefu", people: "—", reads: 13 },
  { id: "W40", case: "positive control: the same identity not suppressed (reviews received only)", data: "recorded", project: "kafka", query: "gabriellefu", suppressed: "—", people: "github:gabriellefu exact", reads: 13 },
  { id: "W40", case: "a suppressed login among the first three prefix matches does not use up the cap: the fourth candidate takes its place", data: "constructed", project: "kafka", query: "lu-", suppressed: "lu-b", people: "github:lu-a prefix, github:Lu-C prefix, github:lu-d prefix", reads: 13 },
  { id: "W40", case: "the deleted account (ghost) has no person result", data: "constructed", project: "kafka", query: "ghost", suppressed: "—", people: "—", reads: 13 },
  { id: "W40", case: "a login whose only review is before the 12-month view", data: "constructed", project: "kafka", query: "old-reviewer", suppressed: "—", people: "—", reads: 13 },
  { id: "W40", case: "positive control: a review on the first second of the view", data: "constructed", project: "kafka", query: "edge", suppressed: "—", people: "github:edge-reviewer prefix", reads: 13 },
  { id: "W41", case: "two words are not a login", data: "—", project: "kafka", query: "kafka consumer", suppressed: "—", people: "—", reads: 0 },
  { id: "W41", case: "an empty query", data: "—", project: "kafka", query: "", suppressed: "—", people: "—", reads: 0 },
  { id: "W41", case: "other characters", data: "—", project: "kafka", query: "chia/7712", suppressed: "—", people: "—", reads: 0 },
  { id: "W41", case: "40 characters, longer than any login", data: "—", project: "kafka", query: "a".repeat(40), suppressed: "—", people: "—", reads: 0 },
  { id: "W41", case: "one character is no prefix", data: "constructed", project: "kafka", query: "c", suppressed: "—", people: "—", reads: 13 },
  { id: "W41", case: "positive control: one character equal to a login", data: "constructed", project: "kafka", query: "Q", suppressed: "—", people: "github:q exact", reads: 13 },
] as const;
