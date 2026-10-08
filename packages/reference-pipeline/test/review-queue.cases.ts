/**
 * Spec 015 test plan: the single source for the unit tests and for the table in
 * docs/specs/015-review-queue/spec.md (`bun run docs:test-plan` regenerates it).
 * Inputs are real values captured 2026-10-08 (docs/specs/015-review-queue/samples/: github-open-prs.json,
 * feed-kip-mail-entries.json, ponymail-kip-threads.json), except rows
 * whose `input` starts with "constructed:". `now` for PR rows is 2026-10-08T04:01:48Z, for KIP rows
 * 2026-10-08T04:03:37Z. Kafka profile: reviewWaitDays 14, proposal.quorum 3, fewRepliers 2.
 */
export const testPlanRows = [
  // Q1: one GraphQL query per 100 open PRs; the snapshot is the union of all pages, deduplicated.
  { id: "Q1", rule: "snapshot", input: "apache/kafka open PRs, totalCount 625, pages of 100", expected: "7 requests; 625 PRs" },
  { id: "Q1", rule: "snapshot", input: "constructed: PR #23700 on page 2 and again on page 3 (moved while paging)", expected: "counted once" },
  { id: "Q1", rule: "snapshot", input: "constructed: totalCount 625 on page 1, 624 distinct PRs read (one closed while paging)", expected: "snapshot published with 624" },

  // Q2: machine and deleted accounts.
  { id: "Q2", rule: "machine", input: "reviewer copilot-pull-request-reviewer (__typename Bot)", expected: "machine" },
  { id: "Q2", rule: "machine", input: "constructed: author dependabot[bot] (__typename Bot)", expected: "machine; PR not queued" },
  { id: "Q2", rule: "machine", input: "constructed: reviewer codecov-commenter (__typename User) listed in the profile machineUsers", expected: "machine" },
  { id: "Q2", rule: "machine", input: "constructed: reviewer abbott (__typename User, not listed)", expected: "human" },
  { id: "Q2", rule: "machine", input: "#20995 author null (deleted account)", expected: "human author shown as ghost; queued no-reviewer, 315 d" },

  // Q3: author's last update and the wait clock.
  { id: "Q3", rule: "author update", input: "#23724 created 2026-10-07, last timeline item force-push 2026-10-07T16:46:00Z", expected: "author update 2026-10-07T16:46:00Z" },
  { id: "Q3", rule: "author update", input: "#22319 last commit committedDate 2026-05-18T19:33:37Z, human review smjn APPROVED 2026-05-20T18:59:58Z", expected: "waiting since 2026-05-20T18:59:58Z; 140 d" },
  { id: "Q3", rule: "author update", input: "constructed: PR with no timeline item of the 4 types, createdAt 2026-09-01T00:00:00Z", expected: "author update 2026-09-01T00:00:00Z" },
  { id: "Q3", rule: "author update", input: "constructed: author comment 2026-10-07 after the last review, no new commit", expected: "not an author update (comments are not read)" },

  // Q4: buckets, first match wins.
  { id: "Q4", rule: "bucket", input: "#22751 isDraft true", expected: "not queued" },
  { id: "Q4", rule: "bucket", input: "#23739 reviewDecision APPROVED, 4 reviewers, commit 2026-10-08T03:08:51Z after the approvals", expected: "approved; 0 d" },
  { id: "Q4", rule: "bucket", input: "#18706 no requested reviewer, no review, created 2025-01-25T13:28:22Z", expected: "no-reviewer; 620 d" },
  { id: "Q4", rule: "bucket", input: "#19236 1 reviewer, author update 2025-10-25T20:04:34Z after the last review", expected: "waiting; 347 d" },
  { id: "Q4", rule: "bucket", input: "#23381 reviewer present, author update after the last review, wait 14.32 d", expected: "waiting" },
  { id: "Q4", rule: "bucket", input: "#22996 reviewer present, author update after the last review, wait 13.58 d", expected: "not queued (14 d or less)" },
  { id: "Q4", rule: "bucket", input: "constructed: author update at exactly the last review's submittedAt, wait 30 d", expected: "not queued (not after the review)" },
  { id: "Q4", rule: "bucket", input: "constructed: author update after the last review, wait exactly 14 d 0 ms", expected: "not queued" },
  { id: "Q4", rule: "bucket", input: "constructed: author update after the last review, wait 14 d + 1 ms", expected: "waiting" },
  { id: "Q4", rule: "bucket", input: "constructed: reviewer reviewed after the author's last update (author's turn), wait 40 d", expected: "not queued" },
  { id: "Q4", rule: "bucket", input: "captured snapshot, 625 open PRs", expected: "approved 22; no-reviewer 373; waiting 61; not queued 169 (35 drafts, 90 author's turn, 44 waiting 14 d or less)" },

  // Q5: order and the home block.
  { id: "Q5", rule: "order", input: "no-reviewer bucket of the captured snapshot", expected: "first three #18706 620 d, #18715 618 d, #18808 609 d" },
  { id: "Q5", rule: "order", input: "constructed: #100 and #99 both 30 d", expected: "#99 before #100" },
  { id: "Q5", rule: "home block", input: "captured snapshot and KIP rows", expected: "PR column 456 (373 / 61 / 22), rows #18706 620 d, #18715 618 d, #18808 609 d; KIP column 13 (4 votes / 9 discussions), rows KIP-1375 30 d, KIP-785 20 d, KIP-1377 20 d (tie broken by proposal number); links to /#/review/apache-kafka" },

  // Q6: topic-page PR label.
  { id: "Q6", rule: "card label", input: "#23724 in the snapshot, Copilot review only", expected: "Awaiting reviewer" },
  { id: "Q6", rule: "card label", input: "#23739 in the snapshot, 4 human reviewers", expected: "In review · 4 reviewers" },
  { id: "Q6", rule: "card label", input: "#16808 in the snapshot, 1 requested reviewer, no review", expected: "In review · 1 reviewer" },
  { id: "Q6", rule: "card label", input: "constructed: merged PR #23623 (not in the open snapshot)", expected: "no label" },
  { id: "Q6", rule: "card label", input: "#22751 isDraft true", expected: "no label" },

  // Q7: KIP candidates come from the pinned Feed release; a VOTE supersedes DISCUSS for the same KIP.
  { id: "Q7", rule: "kip candidates", input: "Dev release 2026-10-08T03-07-37-000Z: 21 dev@ threads with [VOTE]/[DISCUSS] and a KIP key", expected: "6 vote threads; 15 discuss threads" },
  { id: "Q7", rule: "kip candidates", input: "KIP-1349 has [VOTE] KAFKA-MAIL-82e0d5b3 and [DISCUSS] KAFKA-MAIL-4bc41094", expected: "vote row only" },
  { id: "Q7", rule: "kip candidates", input: "DISCUSS: KIP-1378 … (no brackets)", expected: "not a candidate (profile tag is [DISCUSS])" },
  { id: "Q7", rule: "kip candidates", input: "constructed: [RESULT][VOTE] KIP-1279 thread in the release", expected: "KIP-1279 vote row removed" },
  { id: "Q7", rule: "kip candidates", input: "constructed: profile apache-datafusion proposal.kind null", expected: "no KIP column, no KIP rows, no Pony Mail requests" },

  // Q8: repliers and last reply from the full thread.
  { id: "Q8", rule: "repliers", input: "KAFKA-MAIL-a9696e08 KIP-1163: release has 1 message; full thread 22 messages, root Ivan Yurchenko 2025-04-23", expected: "5 repliers; not few" },
  { id: "Q8", rule: "repliers", input: "KAFKA-MAIL-3bc971ac KIP-1376: root Mickael Maison, replies Paolo Patierno and Mickael Maison", expected: "1 replier; last reply 2026-10-07T13:07:14Z" },
  { id: "Q8", rule: "repliers", input: "KAFKA-MAIL-dd798156 KIP-1375: root only, 2026-09-08T03:17:45Z", expected: "0 repliers; no replies · opened 30 d ago" },
  { id: "Q8", rule: "repliers", input: "constructed: two replies from \"unknown sender\"", expected: "1 replier" },
  { id: "Q8", rule: "members", input: "KAFKA-MAIL-0b57fb00 KIP-785: only message \"Re: [DISCUSS] KIP-785 …\" by Manan Gupta 2026-09-17, no parent", expected: "root not archived; \"seen ≥ 1 replier\"; queued" },
  { id: "Q8", rule: "members", input: "constructed: [VOTE] KIP-9 started as a reply inside the [DISCUSS] KIP-9 tree", expected: "vote row uses only the [VOTE] messages; root = oldest [VOTE] message without a reply prefix" },

  // Q9: vote lines (regex in the spec, Behavior 12).
  { id: "Q9", rule: "vote line", input: "Andrew Schofield: \"+1 (binding)\"", expected: "+1, declared binding" },
  { id: "Q9", rule: "vote line", input: "Luke Chen: \"+1 (binding) from me.\"", expected: "+1, declared binding" },
  { id: "Q9", rule: "vote line", input: "Alieh Saeedi: \"+1 (non-binding)\"", expected: "+1, declared non-binding" },
  { id: "Q9", rule: "vote line", input: "Bill Bejeck: \"+1 (biding)\"", expected: "+1, declared binding" },
  { id: "Q9", rule: "vote line", input: "José Armando García Sancio: \"+1. LGTM. Looking forward to …\"", expected: "+1, unmarked" },
  { id: "Q9", rule: "vote line", input: "Andrew Schofield: \"Thanks for the KIP.\" then quoted \"> +1 (binding)\"", expected: "no vote (quoted)" },
  { id: "Q9", rule: "vote line", input: "constructed: \"+1 to Chris's suggestion\"", expected: "unclear" },
  { id: "Q9", rule: "vote line", input: "Federico Valeri: \"+1 (non-binding): Vaquar Khan\" (vote summary)", expected: "unclear" },
  { id: "Q9", rule: "vote line", input: "Gabriella Fu: \"0-1. Version 1 was introduced by KIP-1331 …\"", expected: "no vote" },
  { id: "Q9", rule: "vote line", input: "constructed: \"I am +1 on this\" (not at line start)", expected: "no vote" },
  { id: "Q9", rule: "vote line", input: "constructed: \"+1 (binding) - Mickael Maison\" (vote summary)", expected: "unclear" },
  { id: "Q9", rule: "vote line", input: "constructed: \"+1 (binding).\"", expected: "+1, declared binding" },
  { id: "Q9", rule: "vote line", input: "constructed: \"-1 (binding) until the upgrade path is documented\"", expected: "unclear" },
  { id: "Q9", rule: "vote line", input: "constructed: \"On Mon, … wrote:\", \"> Please vote\", then \"+1 (binding)\" (bottom-posted)", expected: "+1, declared binding" },
  { id: "Q9", rule: "vote line", input: "constructed: \"-----Original Message-----\" then \"+1 (binding)\"", expected: "no vote (quoted message)" },

  // Q10: binding = declared marker, else the profile's binding roster.
  { id: "Q10", rule: "binding", input: "José Armando García Sancio unmarked +1; name in the ASF kafka PMC roster", expected: "binding (roster)" },
  { id: "Q10", rule: "binding", input: "Sushant Mahajan unmarked +1; not in the roster", expected: "not binding" },
  { id: "Q10", rule: "binding", input: "constructed: roster member writes \"+1 (non-binding)\"", expected: "not binding (declaration wins)" },

  // Q11: one vote per voter; the latest counts.
  { id: "Q11", rule: "voter", input: "KIP-1349: Sushant Mahajan from su…@gmail.com \"+1\" 17:38:50Z, from sm…@apache.org empty reply 18:05:01Z", expected: "1 voter, +1" },
  { id: "Q11", rule: "voter", input: "constructed: A \"+1 (binding)\" then later \"-1 (binding)\"", expected: "A counts -1 binding" },

  // Q12: thresholds and tallies on real threads.
  { id: "Q12", rule: "vote row", input: "KAFKA-MAIL-82e0d5b3 KIP-1349: full thread 6 messages, root 2026-08-19", expected: "+1 × 2 · binding 1 of 3 · 1 unmarked (Sushant Mahajan); queued" },
  { id: "Q12", rule: "vote row", input: "KAFKA-MAIL-e903d023 KIP-1262: Luke Chen declared, Sancio roster", expected: "+1 × 2 (binding 2 of 3); queued" },
  { id: "Q12", rule: "vote row", input: "KAFKA-MAIL-86ae8b63 KIP-1368: root only", expected: "+1 × 0 (binding 0 of 3); queued" },
  { id: "Q12", rule: "vote row", input: "KAFKA-MAIL-a614bccc KIP-1097: 3 messages, no vote line", expected: "+1 × 0 (binding 0 of 3); queued" },
  { id: "Q12", rule: "vote row", input: "KAFKA-MAIL-75914579 KIP-1357: Lucas Brutschy, Matthias J. Sax, Bill Bejeck binding", expected: "binding 3; not queued" },
  { id: "Q12", rule: "vote row", input: "KAFKA-MAIL-ff6d44a5 KIP-1279: Mickael Maison, Andrew Schofield, Rajini Sivaram binding; vaquar khan unmarked; 1 unclear", expected: "binding 3 · 1 unmarked · 1 unclear; not queued" },
  { id: "Q12", rule: "discuss row", input: "KIP-1153: 2 repliers", expected: "not queued (2 is not fewer than 2)" },
  { id: "Q12", rule: "discuss row", input: "KIP-1379: 1 replier", expected: "queued" },
  { id: "Q12", rule: "discuss row", input: "11 discuss threads without a vote thread", expected: "9 queued (KIP-1375, KIP-1377, KIP-1165 with 0; KIP-785 seen ≥ 1; KIP-1371, KIP-1365, KIP-1379, KIP-1342, KIP-1376 with 1); KIP-1153 and KIP-1163 not" },

  // Q13: counts from one function.
  { id: "Q13", rule: "counts", input: "queue object with stored counts {noReviewer 373, waiting 61, approved 22, vote 4, discuss 9}", expected: "published; home, list page and object agree" },
  { id: "Q13", rule: "counts", input: "constructed: stored noReviewer 372 with 373 rows", expected: "not published; failureKind counts-mismatch" },

  // Q14: every row cites its source.
  { id: "Q14", rule: "cite", input: "#18706", expected: "https://github.com/apache/kafka/pull/18706" },
  { id: "Q14", rule: "cite", input: "KIP-1349 vote row", expected: "https://lists.apache.org/thread/ow8p1n05rob9n3k4b7xw8m8zqx4molbl and /#/feed/KAFKA-MAIL-82e0d5b3" },

  // Q15: i18n.
  { id: "Q15", rule: "i18n", input: "every review.* key", expected: "present in en and zh-Hant" },

  // Q16: a tally is shown as a count only when every message body was read.
  { id: "Q16", rule: "wording", input: "KIP-1349, all 6 bodies read, root archived, roster read", expected: "\"+1 × 2 · binding 1 of 3 · 1 unmarked\"" },
  { id: "Q16", rule: "wording", input: "constructed: KIP-1349, 1 of 6 bodies failed", expected: "\"seen +1 × 2 · binding 1 of 3 (1 message unread)\" with thread link" },
  { id: "Q16", rule: "wording", input: "KIP-1279 with 1 unclear line", expected: "\"… · 1 unclear\" with thread link" },
  { id: "Q16", rule: "wording", input: "constructed: vote thread whose members are all replies (root not archived)", expected: "\"seen +1 × n · binding ≥ m of 3 (thread start not archived)\"" },

  // Q17–Q33: failure and retry.
  { id: "Q17", rule: "rate limit", input: "constructed: GraphQL HTTP 403 \"secondary rate limit\", Retry-After 120", expected: "no retry; PR section keeps the previous snapshot; github failureKind rate-limit" },
  { id: "Q17", rule: "rate limit", input: "constructed: HTTP 429 with Retry-After 30, then 200", expected: "one retry after 30 s; snapshot published" },
  { id: "Q17", rule: "rate limit", input: "constructed: HTTP 429 with Retry-After 60, then 200", expected: "one retry; published" },
  { id: "Q17", rule: "rate limit", input: "constructed: HTTP 429 with Retry-After 61", expected: "no retry; previous kept; rate-limit" },
  { id: "Q17", rule: "rate limit", input: "constructed: HTTP 200 with errors[0].type RATE_LIMITED", expected: "rate-limit; previous snapshot kept" },
  { id: "Q18", rule: "partial pages", input: "constructed: page 3 of 7 returns 502 twice", expected: "no PR snapshot published; previous kept; failureKind transport" },
  { id: "Q19", rule: "graphql errors", input: "constructed: HTTP 200, data null, errors[0] \"Something went wrong\" (no path)", expected: "failureKind schema; previous kept" },
  { id: "Q19", rule: "graphql errors", input: "constructed: HTTP 200, data present, errors[0] path [\"repository\"] (not a PR node)", expected: "failureKind schema; previous kept" },
  { id: "Q20", rule: "paging drift", input: "constructed: hasNextPage true with an empty nodes list", expected: "failureKind schema (no endless loop)" },
  { id: "Q21", rule: "reopened", input: "#16808 created 2024-08-06, reopened 2026-08-26T05:25:22Z, 1 requested reviewer", expected: "waiting since 2026-08-26T05:25:22Z; 42 d" },
  { id: "Q22", rule: "force-push", input: "#21333 CHANGES_REQUESTED 2026-08-14, force-push 2026-09-02T10:01:16Z", expected: "waiting; 35 d" },
  { id: "Q23", rule: "bot reviewer", input: "#23724 only review by copilot-pull-request-reviewer", expected: "no-reviewer" },
  { id: "Q23", rule: "bot reviewer", input: "constructed: only requested reviewer is a Bot", expected: "no-reviewer" },
  { id: "Q24", rule: "no decision", input: "constructed: reviewDecision null, one human APPROVED review", expected: "not approved; bucket by reviewers" },
  { id: "Q25", rule: "thread fetch", input: "constructed: thread.lua 503 twice for KIP-1376, previous row exists", expected: "previous row kept with its fetchedAt" },
  { id: "Q25", rule: "thread fetch", input: "constructed: thread.lua 503 twice for a new thread", expected: "row omitted; unavailable 1 shown" },
  { id: "Q26", rule: "email fetch", input: "constructed: email.lua 404 for one KIP-1349 message", expected: "row shows seen wording (Q16); message counted unread" },
  { id: "Q27", rule: "cache", input: "constructed: second run, KIP-1349 thread unchanged", expected: "0 email.lua requests for KIP-1349" },
  { id: "Q27", rule: "cache", input: "constructed: previous object regexVersion 1, current 2", expected: "6 email.lua requests for KIP-1349" },
  { id: "Q28", rule: "unparsable", input: "constructed: thread.lua returns HTML", expected: "thread failure (Q25), not 0 repliers" },
  { id: "Q29", rule: "roster", input: "constructed: roster request fails; Sancio unmarked +1", expected: "+1 counted, binding unknown: \"binding ≥ 1\" wording; still queued" },
  { id: "Q30", rule: "feed release", input: "constructed: public/v2/current.json missing", expected: "KIP section keeps previous; PR section updated; mail failureKind pointer-missing" },
  { id: "Q31", rule: "stale", input: "object generatedAt 3 h 0 min 1 s ago (controlled clock)", expected: "freshness line stale" },
  { id: "Q31", rule: "stale", input: "object generatedAt 2 h 59 min ago, github section fetchedAt 5 h ago", expected: "PR column shows its own as-of time, stale" },
  { id: "Q32", rule: "overlap", input: "constructed: run B (started later) wrote pointer; run A finishes after", expected: "A's pointer write refused (older generatedAt); B stays" },
  { id: "Q33", rule: "too large", input: "constructed: GraphQL page body 4 MiB + 1 byte", expected: "failureKind too-large; previous kept" },
  { id: "Q33", rule: "too large", input: "constructed: GraphQL page body exactly 4 MiB", expected: "accepted" },
  { id: "Q42", rule: "auth", input: "constructed: GraphQL HTTP 401", expected: "failureKind auth; no retry; KIP section updated" },
  { id: "Q43", rule: "first run", input: "constructed: no previous object; Pony Mail down; GitHub ok", expected: "published; PR column filled; KIP column unavailable; mail ok false" },
  { id: "Q44", rule: "crash", input: "constructed: run killed after the content object write", expected: "pointer unchanged; next run publishes; verify:health flags last-run older than 2 h" },
  { id: "Q45", rule: "write", input: "constructed: R2 put of the content object throws", expected: "pointer and previous object unchanged; last-run failureKind write" },
  { id: "Q46", rule: "node error", input: "constructed: errors[0].path [\"repository\",\"pullRequests\",\"nodes\",17,\"author\"] on page 2", expected: "that PR dropped; droppedNodes 1; snapshot published" },
  { id: "Q47", rule: "truncated", input: "constructed: reviewRequests totalCount 12, 10 nodes read, no review", expected: "\"In review · ≥ 10 reviewers\"; not noReviewer" },
  { id: "Q47", rule: "truncated", input: "#23739 latestReviews totalCount 4, 4 nodes", expected: "4 reviewers (exact)" },
  { id: "Q48", rule: "mail retry", input: "constructed: thread.lua 503 with Retry-After 5, then 200", expected: "one retry after 5 s; row updated" },
  { id: "Q48", rule: "mail retry", input: "constructed: 21 thread requests", expected: "sequential, at least 1 s apart" },
];
