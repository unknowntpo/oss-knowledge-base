# Spec 015: Review queue for PRs and KIPs

Status: Accepted 2026-10-08 (decisions and governance amendment below)
Date: 2026-10-08
Traceability: enforced
Builds on: Spec 004 (GitHub connector), Spec 009 (bounded memory), Spec 010 (freshness), Spec 012 (dev@ and Jira, ADR-0014), Spec 014 (topic digest, profile `proposal`), ADR-0016

## Intent

A Kafka maintainer's scarce resource is review time. apache/kafka has 625 open
pull requests and a dozen KIPs waiting for discussion or votes, and nothing in
the product shows which of them are waiting on reviewers.

Outcome: the community home page has an **Awaiting review** block right after
the highlights (design canvas https://claude.ai/artifact/1pSUY6ruQMP2yMouo1iMaG).
It has two columns:

- **Pull requests**: no reviewer yet; waiting more than N days since the
  author's last update; approved but not merged. Each row shows its wait time.
- **KIPs**: votes short of the binding +1 quorum (3 for Kafka); DISCUSS threads
  with few distinct repliers; time since the last reply.

On the topic page, a PR card says "Awaiting reviewer" or "In review · n
reviewers".

Every row links to its source. Every count comes from one function. The quorum,
the proposal kind, and the thresholds come from the community profile; a
community without proposals has no KIP column.

## Evidence

Feasibility measured 2026-10-08 04:00–04:15 UTC, read-only, one request at a
time with at least 1 s between Pony Mail requests and 2 s between GitHub
requests. GitHub was read with the existing `gh` CLI login (the token was never
printed or stored). Pony Mail and the ASF roster were read anonymously with the
publisher's `User-Agent`.

| Approach | Requests per run | Payload | Wall time (sequential) | Notes |
| --- | --- | --- | --- | --- |
| REST `pulls?state=open` + `pulls/<n>/reviews` per PR | 7 + 625 = 632 | 1.71 MB per list page (≈ 10.6 MB) + ≈ 2 KB per PR | list 1.33 s/page, reviews 0.53 s/PR ≈ 5.7 min | `requested_reviewers` is already in the list |
| GraphQL, open PRs, 100 per page (query in `samples/github-open-prs.graphql`) | **7** | **306 KB** (45–52 KB per page) | **41.9 s** (2.3–9.6 s per page) | rate-limit cost 3 points per page = 21 of 5,000 points/h |
| Same GraphQL with `labels`, `updatedAt`, `latestOpinionatedReviews` | 7 | 406 KB | 44.8 s | cost 5 per page; the extra fields were deleted |
| Search API counts (`review:none`, `review:approved`, …) | 6 | < 1 KB | ~1 s each | counts only; `review:none` = 568 disagrees with every bucket below |
| Pony Mail `thread.lua?id=<mid>&find_parent=true` (whole thread, headers) | 1 per thread, 21 threads | 3–104 KB, 479 KB for the 15 DISCUSS threads | 0.9–2.3 s each | returns the root even when it is older than our retention |
| Pony Mail `email.lua?id=<mid>` (one full body) | 1 per message, 34 for the 6 VOTE threads | 0.4–1.4 KB body, 145 KB JSON total | ≈ 1 s each | bodies are immutable: cacheable by mid |
| ASF `whimsy.apache.org/public/committee-info.json` (PMC rosters) | 1 | 706 KB | < 1 s | kafka: 44 PMC names; no committers. Not used |
| ASF `whimsy.apache.org/public/public_ldap_projects.json` (LDAP project groups) | 1 | 495 KB | 1.6 s | kafka: `members` 73 committers (ids), `owners` 44 PMC (all also members) |
| ASF `whimsy.apache.org/public/public_ldap_people.json` (id → name) | 1 | 1.31 MB | 1.8 s | names for the 73 ids; no emeritus field |
| `apache/kafka-site` `data/committers.json` | 1 | 16.8 KB | < 1 s | 68 curated entries, titles "Committer" / "PMC member"; no emeritus field; 7 names spelled differently from LDAP. Not used |
| Parse the Dev Feed index (Bun, `JSON.parse` + filter) | 1 R2 read | 11.04 MB, 4,004 entries | — | heap +36.3 MB, RSS 85.9 MB |

What the existing data cannot answer:

- The Dev Feed (release `2026-10-08T03-07-37-000Z`) has 337 Kafka PRs with
  status `open`; GitHub has 625. The connector reads only recently updated
  issues, so the backlog this feature is about is mostly absent.
- dev@ retention starts 2026-09-07. Counts from retained messages are wrong in
  both directions: KIP-1163's DISCUSS thread has 1 retained message but 5
  repliers since 2025-04-23; KIP-1349's VOTE root (2026-08-19) is not retained.
- Tallies from the 200-character preview miss votes after a first paragraph.
  Full bodies fix that: KIP-1262 shows "+1 (binding) from me." on line 3 of
  Luke Chen's message.
- Kafka bylaws (https://cwiki.apache.org/confluence/display/KAFKA/Bylaws):
  "For technical decisions, only the votes of active committers are binding."
  Lazy Majority is "3 binding +1 votes and more binding +1 votes than -1
  votes". Product releases need active PMC members and last at least 3 days.
- KIP process (https://cwiki.apache.org/confluence/display/KAFKA/Kafka+Improvement+Proposals):
  a KIP is accepted by lazy majority, and the vote stays open at least 72
  hours. This spec reads "-1 votes" as binding -1 votes (only binding votes
  count for a technical decision) and shows every -1 so a reader can check.
- No public ASF source marks emeritus committers: the LDAP group (73) still
  holds the incubator-era mentors (Alan Cabrera, Geir Magnusson Jr, Henry
  Saputra, Phillip Rhodes, Chris Burroughs), and the kafka-site list (68) has
  no emeritus field either. Those 5 are exactly the LDAP names absent from
  the kafka-site list after the 7 spelling variants are paired, so the site
  list is a de facto "active" signal; it is not used because it has no ids
  and spells 7 names differently (revisit trigger in ADR-0016).
- Self-declared "(binding)" understates: José Armando García Sancio (committer)
  wrote "+1. LGTM." with no marker on KIP-1262.
- Kafka's own `triage` (359 PRs) and `needs-attention` (316) labels come from
  a Kafka-only GitHub Action. They do not cover approved PRs or PRs waiting on
  a reviewer, and other communities do not have them.

Measuring commands (planned as `bun run measure:review-queue`; the ad-hoc
equivalents used for the numbers above):

```text
gh api graphql -F n=100 [-F cursor=…] -f query="$(cat samples/github-open-prs.graphql)"   # per page; bytes = wc -c, time = wall clock
curl -A "$UA" "https://lists.apache.org/api/thread.lua?id=<mid>&find_parent=true"
curl -A "$UA" "https://lists.apache.org/api/email.lua?id=<mid>"
curl -A "$UA" https://whimsy.apache.org/public/committee-info.json
bun heap.ts feed.json   # Bun.gc + process.memoryUsage around JSON.parse of /api/feed
```

## Example

Captured 2026-10-08. PRs: GitHub GraphQL at 04:01:48Z
(`samples/github-open-prs.json`, all 625). KIPs: Dev `/api/feed` release
`2026-10-08T03-07-37-000Z` (`samples/feed-kip-mail-entries.json`) plus full
Pony Mail threads (`samples/ponymail-kip-threads.json`); roster: ASF LDAP
`kafka` group at 2026-10-08T06:30Z (`samples/asf-roster-kafka.json`). Kafka
profile (decided 2026-10-08): `reviewWaitDays` 14, `fewRepliers` 2, proposal
votes `{quorum 3, rule lazy-majority, minOpenHours 72, bindingRole committer}`.

### Pull requests (625 open)

| Bucket | Count | Longest waits |
| --- | --- | --- |
| No reviewer, waiting > 14 d | 310 (63 more are 14 d or newer) | #18706 620 d, #18715 618 d, #18808 608 d |
| Waiting > 14 d since the author's last update | 61 | #19236 347 d, #21039 306 d, #21518 218 d |
| Approved, not merged | 22 (10 over 14 d) | #22319 140 d, #22333 139 d, #21416 121 d |
| Not queued | 232 | 35 drafts, 90 where the reviewer spoke last (author's turn), 44 waiting on reviewers 14 d or less, 63 without a reviewer 14 d or less |

The block's PR column shows 393 = 310 + 61 + 22.

Concrete PRs:

| PR | Signals | Result |
| --- | --- | --- |
| #18706 KAFKA-18171 bootstrap.servers behavior after upgrade | no requested reviewer, no review, created 2025-01-25 | No reviewer · 620 d |
| #23724 KAFKA-21214 [8/8] uniform2 fuzzer (dajac) | only review is `copilot-pull-request-reviewer` (Bot) | not queued (no reviewer, 0 d); card "Awaiting reviewer" |
| #21333 KAFKA-20025 dynamic TLS for KafkaRaftManager | CHANGES_REQUESTED 2026-08-14, force-push 2026-09-02 | Waiting · 35 d |
| #16808 KAFKA-17259 override serverProperties | created 2024-08-06, reopened 2026-08-26, 1 requested reviewer | Waiting · 42 d (from the reopen) |
| #22319 KAFKA-20530 log cluster.id at startup | `reviewDecision` APPROVED by smjn 2026-05-20 | Approved · 140 d |
| #23739 MINOR: PR description guidance | APPROVED by 3, commented by 1; commit after the approvals | Approved · 0 d; card "In review · 4 reviewers" |
| #20995 (author account deleted) | `author: null`, no reviewer | No reviewer · 315 d, author "ghost" |

### KIPs

The release has 21 dev@ threads tagged `[VOTE]` or `[DISCUSS]` with a KIP key:
6 votes and 15 discussions. 4 discussions belong to KIPs that already have a
vote thread (KIP-1368, KIP-1262, KIP-1349, KIP-1279), so 11 discussion
candidates remain.

Votes (full threads, all bodies read; binding = declared "(binding)", or an
unmarked vote from a name in the ASF `kafka` committer roster ("via roster");
"unmarked" = an unmarked +1 from a name not in the roster):

| KIP | Thread | Root | +1 | Binding +1 / -1 | State | Queued |
| --- | --- | --- | --- | --- | --- | --- |
| KIP-1368 | KAFKA-MAIL-86ae8b63 | Andrew Schofield 2026-09-25, no replies | 0 | 0 of 3 / 0 | short | yes, 12 d since the root |
| KIP-1097 | KAFKA-MAIL-a614bccc | Anton Liauchuk 2025-07-08, 3 messages | 0 | 0 of 3 / 0 | short | yes, last reply 15 d |
| KIP-1349 | KAFKA-MAIL-82e0d5b3 | Muralidhar Basani 2026-08-19 (not retained in our data) | 2: Andrew Schofield (declared), Sushant Mahajan (committer, via roster) | 2 of 3 (1 via roster) / 0 | short | yes, last reply 2 d |
| KIP-1262 | KAFKA-MAIL-e903d023 | Kevin Wu 2026-03-04 | 2: Luke Chen (declared), José Armando García Sancio (via roster) | 2 of 3 (1 via roster) / 0 | short | yes, last reply 15 d |
| KIP-1357 | KAFKA-MAIL-75914579 | Gabriella Fu 2026-06-25 | 4 (Alieh Saeedi declared non-binding) | 3 (Lucas Brutschy, Matthias J. Sax, Bill Bejeck "(biding)") / 0 | passing (open 104 d ≥ 72 h) | no |
| KIP-1279 | KAFKA-MAIL-ff6d44a5 | Federico Valeri 2026-07-08 | 4 (vaquar khan unmarked, not a committer), plus 1 unclear "+1 (non-binding): Vaquar Khan" (a summary line) | ≥ 3 · 1 unmarked / 0 | unresolved (the unclear line makes the count a lower bound) | yes, last reply 19 d |

Under the earlier PMC-roster draft KIP-1349 showed "1 of 3 · 1 unmarked";
Sushant Mahajan is a committer, so his unmarked +1 is binding for a KIP.

KIP-1349 on retained data alone would show no root and one vote of each kind.
The full thread also shows Sushant Mahajan's second, empty message from
another address; it is one voter.

Discussions (repliers = distinct authors other than the root's author; thread
membership = messages with the candidate's normalized subject):

| KIP | Thread | Root | Repliers | Last reply | Queued (< 2) |
| --- | --- | --- | --- | --- | --- |
| KIP-1375 | KAFKA-MAIL-dd798156 | Hrishi Baskaran 2026-09-08 | 0 | none (opened 30 d ago) | yes |
| KIP-785 | KAFKA-MAIL-0b57fb00 | not archived: the only message is Manan Gupta's "Re:" of 2026-09-17, with no parent | seen ≥ 1 (wording "seen") | 20 d | yes |
| KIP-1377 | KAFKA-MAIL-16fc1da5 | Aditya Kousik 2026-09-17 | 0 | none (20 d) | yes |
| KIP-1165 | KAFKA-MAIL-f93938c0 | Viktor Somogyi-Vass 2026-10-05 | 0 | the author's own follow-up, 2 d | yes |
| KIP-1371 | KAFKA-MAIL-540e8110 | Eric Chang | 1 | 15 d | yes |
| KIP-1365 | KAFKA-MAIL-743911d7 | pritam kumar | 1 | 12 d | yes |
| KIP-1379 | KAFKA-MAIL-7eb8eba3 | David Jacot | 1 | 2 d | yes |
| KIP-1342 | KAFKA-MAIL-3bff04e6 | Ming-Yen Chung | 1 (Chia-Ping Tsai) | 1 d | yes |
| KIP-1376 | KAFKA-MAIL-3bc971ac | Mickael Maison | 1 (Paolo Patierno) | 0 d | yes |
| KIP-1153 | KAFKA-MAIL-0635ac57 | pritam kumar | 2 | 9 d | no |
| KIP-1163 | KAFKA-MAIL-a9696e08 | Ivan Yurchenko 2025-04-23 | 5 | 2 d | no |

The block's KIP column shows 14 = 5 votes + 9 discussions.

## Decisions (human, 2026-10-08)

1. `reviewWaitDays` 14. 2. Few repliers: fewer than 2. 3. Binding follows the
community's governance, declared in a profile `governance` block (Behavior
21); Kafka KIP votes are binding for active committers, release votes for PMC
members (bylaws). 4. One row per PR; series grouping later. 5. "No reviewer"
also requires a wait over 14 d (310, not 373). 6. Hourly. 7. Until Spec 014's
home page is live, the block sits at the top of All threads
(`/#/<projectKey>/threads`, Spec 014 slice 3, PR #36); if that is not merged
when slice 3 of this spec starts, the current Feed page (`/#/`).
Contract changes are approved and recorded in ADR-0016.

## Solution space and decision

| Option | Verdict | Why |
| --- | --- | --- |
| A. REST reviews per PR inside the hourly publication alarm | Rejected | 632 requests, ≈ 10.6 MB, ≈ 5.7 min; the alarm already took ≈ 12 of 15 min on a heavy run |
| B. GraphQL snapshot inside the hourly alarm | Rejected | 42 s more in the alarm that is closest to its limit; a GitHub GraphQL outage would then touch publication |
| C. Incremental PR state by `updated_at` | Rejected | a full snapshot is 7 requests; incremental needs stored state and handling for PRs that leave the open set |
| D. Search API counts | Rejected | counts only, no rows or wait times, and a second counting source (`review:none` = 568 matches no bucket) |
| E. Kafka's `triage` / `needs-attention` labels from existing events | Rejected | Kafka-only, misses approved and waiting PRs, and our events lack 288 open PRs |
| F. Webhooks or a GitHub App on apache/kafka | Rejected | we cannot install anything on apache/kafka |
| **G. A separate review-queue job on its own cron: one GraphQL snapshot of open PRs + full Pony Mail threads for KIP candidates of the pinned Feed release; writes one object** | **Chosen** | 7 + ≈ 22 requests warm, < 1 MB, ≈ 1–3 min, in its own invocation; publication is unchanged |

KIP tally options (the Spec 014 review found preview tallies undercount):

| Option | Verdict | Why |
| --- | --- | --- |
| Tally from the 200-char preview of retained messages | Rejected | misses votes after a first paragraph and every vote before retention (KIP-1349 shows 1 binding of an unknown total) |
| Show "seen n" from retained data only | Rejected as the default | honest but useless for "short of quorum": every row would be "unknown" |
| Omit tallies | Rejected | the intent's main KIP signal |
| **Full thread headers (`thread.lua`) for every candidate + full bodies (`email.lua`) for VOTE threads only, cached by message id; declared binding, else the roster role the profile's governance names (committer for KIPs)** | **Chosen** | exact on the 6 captured votes; when a body is missing the row says "seen" (Behavior 13) |

Placement of the job:

- A third cron entry on the existing data Worker, dispatched by
  `controller.cron` through Spec 014's `cronTarget`, which now returns
  `digest`, `review-queue`, or `publisher`. A tick that is neither job's
  configured cron publishes, as before (Q57).
- The cron is configured by the variable `REVIEW_QUEUE_CRON`. Slice 2 ships
  it unset and adds no cron trigger, so a deploy changes nothing for the
  publisher. A follow-up sets it, and adds the trigger, after a Dev dry run.
- `POST /review-queue/run` (bearer `MANUAL_TRIGGER_TOKEN`, the publisher's
  manual token) runs the job while the caller waits and returns
  `last-run`; `?dryRun=1` computes and returns it without any R2 write
  (Q58).
- `/health` gains `reviewQueue`: the `last-run.json` object, or null.
- No Durable Object. The run is short (≈ 1–3 min) and hourly, so runs do not
  overlap in practice; the pointer write is conditional (Behavior 17) for the
  case where they do. Run status is an R2 object, not DO storage.
- Proposed crons: Dev `27 * * * *`, Prod `57 * * * *` (20 min after each
  environment's publication cron, so the pinned Feed release is fresh).

## Architecture

```text
cron (Dev :27, Prod :57) → scheduled() → dispatchScheduled(cron) → runReviewQueue(projectId)
  1 PRs   GraphQL open PRs, 100 per page, until hasNextPage = false   (all pages or nothing)
  2 KIPs  if profile.proposal.kind != null:
          read public/v2/current.json → manifest → feed index (one pinned release)
          candidates = dev@ entries whose subject has a vote/discuss tag and a proposal key
          per candidate: thread.lua (headers, whole thread)
          per VOTE thread: email.lua for each message id not in the previous object
          roster: governance.roster adapter (ASF: LDAP projects + people JSON), refreshed daily
  3 build buckets, rows, counts (reviewQueueCounts); validate
  4 write public/review-queue/v1/<projectId>/<contentHash>.json
    then public/review-queue/v1/<projectId>/current.json (conditional, last)
    always public/review-queue/v1/<projectId>/last-run.json
web: GET /api/review-queue?projectId=apache-kafka → home "Awaiting review" block,
     /#/review/<projectId> full list, topic-page PR card labels
```

Shared code (named so Spec 014 and this spec do not duplicate it):

- `mailAuthor(from)` (Spec 012, `packages/reference-pipeline/src/kafka-rules.ts`): voter and replier identity.
- `subjectHasTag(title, tag)` and `proposalKeys(title, profile)` (Spec 014,
  `packages/reference-pipeline/src/digest/proposals.ts`): subject tags and
  proposal keys.
- `isMachineAuthor(author, profile)` (Spec 014 Behavior 2, gardening G8):
  `[bot]` logins and profile machine users; this spec adds GitHub's `Bot`
  type (`isMachineActor`).
- Not shared: Spec 012's `threadKey`. Thread members use this spec's
  `memberKey` (Behavior 9), because changing `threadKey` would regroup the
  Feed.
- `tallyVote(thread, rule, roster, now)`: new, owned by this spec (Spec 014
  dropped its tally on 2026-10-08); it returns the state too.
- `reviewQueueCounts(queue)`: new, the only counting function.
- The connector fetch policy (Spec 012): `SOURCE_USER_AGENT`, one retry when
  `Retry-After` ≤ 60 s, 4 MiB response limit.
- `STALE_AFTER_MS` (Spec 010).

## Simplification review

1. **Question every requirement.**
   - PR rows need: number, title, author, draft flag, reviewers, approval,
     author's last update. Owner: the maintainer choosing what to review.
   - KIP rows need: key, stage, binding +1s vs quorum, repliers, last reply.
     Owner: the same maintainer, for KIP votes and discussions.
   - Wait time needs one clock. Owner: the canvas ("Wait time counts from the
     author's last update").
   - The list route `/#/review/<projectId>`. Owner: the canvas links "All PRs
     awaiting review" and "All open KIPs"; a GitHub search link would count
     differently (Behavior 15).
   - `labels`, `updatedAt`, `latestOpinionatedReviews`, CI status, mergeable
     state: no owner. Deleted.
2. **Delete.**
   - Per-PR REST reviews (632 requests) → one GraphQL snapshot (7).
   - Incremental cursor and stored PR state → full snapshot each run.
   - A Durable Object, a lease, and new `/health` fields → a cron handler and
     a `last-run.json` object.
   - Search API counts and Kafka's labels as signals → one bucket function.
   - Query fields above → payload 406 KB → 306 KB, cost 5 → 3 points per page.
   - Author comments as an author update → only commits, force-pushes,
     ready-for-review, and reopen count (no per-PR comment reads).
   - Team expansion of requested teams → a team counts as one reviewer.
   - Preview-based tallies and retained-window replier counts → full thread.
   - DISCUSS bodies → headers only (`thread.lua`); bodies only for VOTE threads.
   - Grouping PRs by series (canvas: "KIP-1306 series, 6 PRs") → one row per
     PR (open decision 4).
   - An "Approved" card label → two labels, as in the intent.
   - A Pony Mail `stats.lua` search for KIP threads → reuse the pinned Feed
     release (no second copy of the mail source access).
   - **Came back:** approval from `latestReviews` (any human APPROVED) was
     deleted in favor of GitHub's `reviewDecision`, then checked: 80 latest
     reviews are APPROVED but only 22 PRs are `APPROVED`, because Kafka counts
     only approvals from people with write access. `reviewDecision` stays.
   - **Came back:** the vote tally, deleted from Spec 014, returns here with
     full bodies.
3. **Simplify.** One wait clock for every bucket (Behavior 4). One object per
   project. First-match buckets, so every open PR is in exactly one.
4. **Shorten the cycle.** The case file replays the captured samples offline;
   `review-queue -- dry-run --fixture` (planned) builds the object without
   network.
5. **Automate last.** `measure:review-queue` (planned) prints requests, bytes,
   and time per source against live data at the polite rate.

## Behavior

Ties are broken by PR number or proposal number, ascending (numeric).

1. **PR snapshot.**
   - One GraphQL query per page of 100 open PRs
     (`samples/github-open-prs.graphql`), sequential, until `hasNextPage` is
     false. PRs are deduplicated by number.
   - A page with `hasNextPage: true` and no nodes is a schema failure.
   - GraphQL `errors`: an error whose `path` points into one PR node drops
     that PR, counts it in `droppedNodes`, and the page still counts as
     succeeded. Any other error (no `path`, or `data` null) fails the page.
   - The snapshot is published only when every page succeeded.
   - The query reads at most 10 requested reviewers and 20 latest reviews
     (captured maximum: 3 and 4). When a `totalCount` exceeds what was read,
     the PR's reviewer count is shown as "≥ n".
   - Uses `GITHUB_SOURCE_TOKEN` (GraphQL requires authentication).
2. **Machine and deleted accounts.**
   - An author or reviewer is a machine when `__typename` is `Bot`, the login
     ends with `[bot]`, or the login is in the profile `machineUsers`.
   - A PR authored by a machine is not queued.
   - `author: null` (deleted account) is a human shown as "ghost".
3. **Reviewers.** A PR's reviewers are the union of:
   - requested reviewers that are users or teams (not bots);
   - authors of `latestReviews` (any state) who are human and not the PR author.
4. **Wait clock.**
   - Author's last update = the newest of `createdAt` and the last timeline
     item of type commit (`committedDate`), force-push, ready-for-review, or
     reopened.
   - Last review = the newest `submittedAt` among human reviews (Behavior 3).
   - Waiting since = the later of the two. Wait = now − waiting since, shown
     in whole days (floor).
5. **Buckets**, first match wins:
   1. draft → not queued;
   2. machine author → not queued;
   3. `reviewDecision` = `APPROVED` → `approved`;
   4. no reviewers and wait > `reviewWaitDays` days (strictly) → `noReviewer`;
      no reviewers and a shorter wait → not queued (decided 2026-10-08);
   5. author's last update is after the last review (or there is no review
      yet) and wait > `reviewWaitDays` days (strictly, in milliseconds) →
      `waiting`;
   6. otherwise → not queued.
   - `reviewDecision` null (a base branch without required reviews) is never
     `approved`.
6. **Order and block.**
   - Sort key: `waitDays` (floor), longest first, then PR number or proposal
     number, ascending (numeric). A KIP's wait is the time since its last reply, or since the
     root when it has no reply.
   - Bucket order everywhere: no reviewer, waiting, approved; vote, discuss.
   - The home block shows, per column, the total, each bucket's count, and the
     3 rows with the longest waits across the column's buckets (for KIPs, the
     time since the last reply, or since the root when there is none). Its link opens
     `/#/review/<projectId>`, which lists every row by bucket.
7. **Topic-page PR label.** A draft has no label. For another open PR in the snapshot: no reviewers →
   "Awaiting reviewer"; otherwise "In review · n reviewers". A PR not in the
   snapshot (merged, closed, or no snapshot yet) has no label.
8. **KIP candidates.**
   - Only when the profile has `proposal.kind` not null.
   - From the pinned Feed release: dev@ entries whose subject has a profile
     vote or discuss tag and a proposal key (`detectProposalStages`).
   - One row per proposal key. A key with a vote thread gets a vote row and no
     discuss row.
   - A key with a `[RESULT]` thread in the release has no vote row.
9. **Thread read.** For each candidate, one `thread.lua?id=<a retained mid>&find_parent=true`.
   - `memberKey(subject)` strips leading mail-gateway tags (`[EXTERNAL]`,
     `[EXT]`, `[External Email]`, `[External Sender]`, `[CAUTION]`) and reply
     or forward prefixes (`Re:`, `RE:`, `Fwd:`, `Fw:`, `AW:`, `SV:`, `VS:`,
     `WG:`, `Antw:`, `R:`-style `Rif:`, `TR:`), repeatedly, then collapses
     whitespace and lowercases.
   - Members = messages in the returned tree with the candidate's
     `memberKey`. A `[VOTE]` started as a reply inside the `[DISCUSS]` tree
     therefore keeps only `[VOTE]` messages.
   - **Unattributed replies:** a non-member message whose `memberKey`
     contains the proposal key and every bracket tag of the candidate's
     subject (for example "Re: [VOTE] KIP-9 (was: x)") is counted as
     unattributed. Its vote is not read, and the tally is not complete.
   - Root = the oldest member with no reply prefix once gateway tags are
     removed, so "[EXTERNAL] [VOTE] KIP-9: x" is a root. When
     every member is a reply, the root is not archived in this tree
     (KIP-785): repliers and the tally use the "seen" wording and the row
     shows the oldest member's date.
   - A response that is not the expected JSON shape is a thread failure.
10. **Repliers and last reply.**
    - Repliers = distinct `mailAuthor(from)` of non-root messages, other than
      the root's author, excluding machines. "unknown sender" counts once.
    - Last reply = the newest non-root message; with none, the row shows "no
      replies" and the root's age.
    - A discuss row is queued when repliers < `fewRepliers`.
11. **Vote bodies.** For a vote thread, the full body of every message, from
    `email.lua?id=<mid>`. A body already in the previous queue object (by mid)
    is not fetched again.
12. **Vote lines.** A vote line matches

    ```text
    ^\s*(?<vote>[+-]1)(?=$|[\s(,.!:;])\s*(?<binding>\(\s*(?:non[-\s]?)?bin?ding\s*\)|(?:non[-\s]?)?bin?ding\b)?\s*(?<rest>.*)$   (case-insensitive)
    ```

    - Lines quoted with `>` never match, because a vote line starts with +1
      or -1. An attribution line ("On … wrote:") does not stop reading, so a
      vote written below a `>` quote (bottom-posting) counts.
    - Reading stops at an Outlook-style quoted message (`^\s*-{2,}\s*Original
      Message` or `^\s*From:\s`). A vote bottom-posted below such a header
      cannot be told from a quoted vote, so it is not counted. If any
      vote-like line follows the header, the message is **ambiguous** and the
      tally is not complete.
    - A **-1** line is a vote whatever follows ("-1 (binding) until …", "-1:
      reason"). Counting a -1 never overstates passing.
    - A **+1** line is a vote when `rest` matches
      `^(?:$|[.!,;)]|from me\b|thanks?\b|lgtm\b)`. Otherwise it is
      **unclear** ("+1 to Chris's suggestion", "+1: looks good", "+1
      (non-binding): Vaquar Khan", "+1 (binding) - Mickael Maison"). Unclear
      lines are never counted as votes, and they make the tally not complete.
    - "biding" is accepted as "binding" (seen in KIP-1357), and a comma may
      precede the marker ("-1, binding, see below").
13. **Tally (`tallyVote`).**
    - Vote lines parsed in an earlier run are cached by message id with
      `VOTE_REGEX_VERSION` (now 2, after the comma rule); a version change
      rereads every body.
    - `tallyVote(thread, rule, roster, now)`: one vote per voter (`mailAuthor`
      name); the voter's latest vote counts, and within one body the last
      vote line.
    - Binding (Behavior 21): a declared marker wins ("non-binding" → no,
      "binding" → yes). An unmarked vote is binding when the voter's name is
      exactly the name of a roster entry holding the vote kind's
      `bindingRole`. Without a roster, only declared markers count.
    - Result: `{plus, plusBinding, plusBindingViaRoster, minus,
      minusBinding, minusUnmarked, unmarked, unclear, unread, ambiguous,
      unattributed, rootArchived, rosterRead, openedAt, complete, state,
      queued}`. `unmarked` = unmarked +1s not matched as binding (not in the
      roster, or in it without the vote kind's `bindingRole`);
      `minusUnmarked` likewise for -1s. `complete` = no unread body, the root
      is archived, the roster was read, and there are no unclear lines,
      ambiguous messages, or unattributed replies.
    - Text: "+1 × n · binding m of q", then "(k via roster)", "· binding -1
      × j", "· j unmarked -1", "· j non-binding -1", "· k unmarked" when
      non-zero. When not
      complete, the text starts with "seen", every binding count gets "≥",
      and the reasons follow after "; ": unread messages, thread start not
      archived, roster unavailable, unclear lines, messages with a vote after
      a quoted header, replies not attributed. Binding is never shown as a
      bare number while a vote of unknown standing exists.
    - **State** (`Tally.state`), for `rule: "lazy-majority"`:
      - `short`: binding +1 < quorum (for a "seen" tally, the lower bound);
      - `unresolved`: otherwise, when the tally is not complete (lower
        bounds never assert contested, pending-close, or passing);
      - `contested`: otherwise, when binding +1 ≤ binding -1;
      - `pending-close`: otherwise, when the vote has been open less than
        `minOpenHours` since the root;
      - `passing`: otherwise.
    - A vote row is queued when its state is `short`, `unresolved`, or
      `contested`. The object keeps every vote row with its state; the list
      page shows the others under "Not queued".
14. **Output object** `osskb.review-queue.v1`:
    - `projectId`, `generatedAt`, `profile {reviewWaitDays, fewRepliers, votes}`
      (the governance vote rules used), `roster {adapter, fetchedAt, entries}`
      (`entries` = count only; names stay in the internal roster object);
    - `sources.github {ok, fetchedAt, failureKind?}`, `sources.mail {ok, fetchedAt, feedReleaseId, failureKind?}` (`feedReleaseId` is the Feed release the candidates came from; a failed mail source keeps the previous one);
    - `prs {noReviewer[], waiting[], approved[]}`, each row `{number, title, url, author, reviewers, waitingSince, waitDays}`;
    - `reviewState {<prNumber>: reviewerCount}` for every queued and
      not-queued open non-draft PR (for Behavior 7);
    - `kips {vote[], discuss[]}`, each row `{key, title, displayId?, threadUrl, rootAt, lastReplyAt, repliers, tally?}`;
    - `kips.unavailable`: candidates whose thread could not be read and that
      have no previous row;
    - `voteLines {regexVersion, byMid {<mid>: [unquoted lines starting with +1 or -1]}}`,
      the cache for Behavior 11. Entries of threads that are no longer
      candidates are dropped. A changed `regexVersion` refetches every body;
    - `droppedNodes` (Behavior 1);
    - `counts`.
15. **One counting function.** `reviewQueueCounts(queue)` computes every count
    from the arrays. The block, the list page, and the object's `counts` use
    it. An object whose stored counts differ is not published.
16. **Sources fail independently.** A failed source keeps the previous
    object's section and its `fetchedAt`; the other section is updated.
    `sources.mail.ok` is true when the Feed release was read and at least one
    candidate thread was read; when every candidate thread fails, the mail
    source failed (Q43). On the first run there is no previous section:
    a failed source's section is empty and its column says the data is
    unavailable. The run as a whole is `ok` when at least one source
    succeeded and the object was published.
    - **No source succeeded:** nothing is written but `last-run.json`
      (`ok: false`, `failureKind: no-source`). The previous pointer and
      object stay, so the UI keeps the last queue with its as-of times; with
      no previous object nothing is published and the UI shows the queue as
      unavailable, never as an empty queue.
17. **Pointer.** `current.json` is replaced with a conditional put on the ETag
    read at the start of the run. A refused write is not retried: a newer run
    has written. The content object is written first, so a crash leaves at
    most an unreferenced content object and an unchanged pointer;
    `last-run.json` is written after every run, failed ones included: the run
    catches its own errors first, so this equals a `finally`, except that a
    failed `last-run` write fails the invocation. A crash that kills the
    invocation leaves the old `last-run.json`, which `verify:health` reports
    as a missing run after 2 h.
18. **Freshness in the UI.** Each column shows "as of <time>" from its
    source's `fetchedAt`, stale after `STALE_AFTER_MS` (3 h).
19. **Citations.** A PR row links to its GitHub URL. A KIP row links to
    `https://lists.apache.org/thread/<root mid>` and, when the thread is in the
    Feed, to `/#/feed/<displayId>`.
20. **i18n.** All strings via `apps/web/i18n.js`, en and zh-Hant: `review.title`,
    `review.prs`, `review.kips`, `review.bucket.noReviewer`,
    `review.bucket.waiting` ({n} days), `review.bucket.approved`,
    `review.bucket.vote`, `review.bucket.discuss`, `review.wait` ({n} d),
    `review.card.awaiting`, `review.card.inReview` ({n}, plural),
    `review.tally`, `review.tally.seen`, `review.unclear`, `review.noReplies`,
    `review.repliers`, `review.asOf`, `review.stale`, `review.all`.

21. **Governance profile** (decided 2026-10-08). A community profile has a
    `governance` block; there is no rule language, only enums and adapters:

    ```ts
    governance: {
      roster: { adapter: "asf", project: "kafka" },        // RosterAdapter id + its argument
      votes: [
        { kind: "proposal", quorum: 3, rule: "lazy-majority", minOpenHours: 72, bindingRole: "committer" },
        { kind: "release",  quorum: 3, rule: "lazy-majority", minOpenHours: 72, bindingRole: "pmc" },
      ],
    }
    ```

    - `rule` is an enum; `lazy-majority` is the only value now.
    - Only proposal votes are candidates in this spec (Behavior 8 requires a
      proposal key). The `release` entry is declared data, kept per the
      human decision and exercised by a constructed test row; no release
      thread is classified or shown (Non-goals).
    - **ASF preset** `asfPreset({project, devList})` returns the shared ASF
      fields: Pony Mail dev@ (`<devList>@<project>.apache.org`), Jira, the
      `asf` roster adapter, subject tags `[VOTE]`, `[DISCUSS]`, `[RESULT]`,
      and the two vote kinds above with `bindingRole` committer (proposal) and
      pmc (release). The Kafka profile is the preset plus overrides
      (`proposal.kind KIP`, key pattern, `reviewWaitDays`, `fewRepliers`),
      with a comment citing the bylaws URL.
    - DataFusion uses the preset with `proposal.kind: null`, so it has no KIP
      column (Behavior 8).
22. **Roster adapter.** `RosterAdapter { id; sources(project) → URL[]; parse(bodies, project, fetchedAt) → Roster }`;
    `Roster = {adapter, project, fetchedAt, entries: [{id, name, roles: ("committer" | "pmc")[]}]}`.
    Fetching, caching, and refresh belong to the job (slice 2); parsing is
    pure (slice 1).
    - The ASF adapter reads `whimsy.apache.org/public/public_ldap_projects.json`
      (`members` → committer, `owners` → pmc) and
      `public_ldap_people.json` (id → name), and keeps only the project's
      entries (Kafka: 73 entries, 44 with pmc). An `owners` id gets both
      roles, even if `members` lacks it.
    - An id without a name in the people file is kept with `name: null` and
      never matches a voter.
    - A response without the project, or with no `members`, is a roster
      failure, not an empty roster.
    - Emeritus status is not published by any public ASF source (Evidence).
      The adapter therefore cannot exclude emeritus committers: an emeritus
      committer's unmarked +1 counts as binding "via roster", so a `passing`
      state can be overstated, never understated. Exact-name matching also
      lets a non-committer who uses a committer's display name count via the
      roster. Both are visible as "(k via roster)".
    - The roster is stored as an internal R2 object
      `internal/rosters/v1/<adapter>/<project>.json` and refreshed when older
      than 24 h. A failed refresh keeps the stored roster (with its
      `fetchedAt`); with none, tallies use declared markers only and the "≥"
      wording.
    - An OWNERS-file adapter is a later, separate change (Non-goals).
23. **Name matching.** A voter's `mailAuthor` name matches a roster entry when
    the two strings are equal after Unicode NFC normalization, trimming, and
    removing quote characters (as `mailAuthor` does). No case folding,
    transliteration, or partial match.

## Slices

Each slice is its own PR. Tests are named with the IDs they cover. A slice
removes the `[pending]` tags of the IDs it implements and the `[pending]`
marker of its case file.

1. **Deterministic core** (`packages/reference-pipeline/src/review-queue/`):
   PR page parsing and buckets, thread membership and repliers, vote lines,
   tally and vote state, governance profile and ASF preset, ASF roster
   parsing, counts, cites, and wording. No Worker or web change.
2. **Review-queue job in the data Worker:** GraphQL and Pony Mail fetchers,
   the roster refresh, R2 objects, cron dispatch, `last-run.json`,
   `measure:review-queue`, and `verify:health`.
3. **Web:** `/api/review-queue`, the block (placement per decision 7), the
   list route, topic-page labels, i18n, and freshness.

## Contract changes and decision

Approved 2026-10-08 and recorded in
[ADR-0016](../../architecture/decisions/0016-review-queue-job-and-governance-profiles.md):

1. New R2 objects `public/review-queue/v1/<projectId>/<contentHash>.json`,
   `current.json`, and `last-run.json`. Readers: the web app and the next run.
2. New endpoint `GET /api/review-queue?projectId=` and route
   `/#/review/<projectId>`.
3. A third cron on the data Worker with dispatch by `controller.cron`, using
   the existing `GITHUB_SOURCE_TOKEN` for GraphQL. No new secret.
4. Profile fields `reviewWaitDays`, `fewRepliers`, and `governance`
   (Behavior 21), the ASF preset, and the `RosterAdapter` interface.
5. New upstream reads: GitHub GraphQL, Pony Mail `thread.lua` and
   `email.lua`, and `whimsy.apache.org/public/public_ldap_projects.json` and
   `public_ldap_people.json` (daily).
6. A new internal R2 object `internal/rosters/v1/<adapter>/<project>.json`.

## Test plan

Generated by `bun run docs:test-plan` from one case file per slice. Unit tests
in `packages/reference-pipeline/test/review-queue.test.ts` run the slice 1
rows against the captured samples and constructed inputs. Slice 2 and 3 files
are `[pending]` until those slices run them. Edit the case files, not these
tables.

Slice 1, deterministic core:

<!-- test-plan:start packages/reference-pipeline/test/review-queue.cases.ts -->
| id | rule | input | expected |
| --- | --- | --- | --- |
| Q1 | snapshot | apache/kafka open PRs, totalCount 625, pages of 100 | 7 requests; 625 PRs |
| Q1 | snapshot | constructed: PR #23700 on page 2 and again on page 3 (moved while paging) | counted once |
| Q1 | snapshot | constructed: totalCount 625 on page 1, 624 distinct PRs read (one closed while paging) | snapshot of 624 |
| Q2 | machine | reviewer copilot-pull-request-reviewer (__typename Bot) | machine |
| Q2 | machine | constructed: author dependabot[bot] (__typename Bot) | machine; PR not queued |
| Q2 | machine | constructed: reviewer codecov-commenter (__typename User) listed in the profile machineUsers | machine |
| Q2 | machine | constructed: reviewer abbott (__typename User, not listed) | human |
| Q2 | machine | #20995 author null (deleted account) | human author shown as ghost; noReviewer, 315 d |
| Q3 | author update | #23724 created 2026-10-07, last timeline item force-push 2026-10-07T16:46:00Z | author update 2026-10-07T16:46:00Z |
| Q3 | author update | #22319 last commit committedDate 2026-05-18T19:33:37Z, human review smjn APPROVED 2026-05-20T18:59:58Z | waiting since 2026-05-20T18:59:58Z; 140 d |
| Q3 | author update | constructed: PR with no timeline item of the 4 types, createdAt 2026-09-01T00:00:00Z | author update 2026-09-01T00:00:00Z |
| Q3 | author update | constructed: author comment 2026-10-07 after the last review, no new commit | not an author update (comments are not read) |
| Q4 | bucket | #22751 isDraft true | not queued |
| Q4 | bucket | #23739 reviewDecision APPROVED, 4 reviewers, commit 2026-10-08T03:08:51Z after the approvals | approved; 0 d |
| Q4 | bucket | #18706 no requested reviewer, no review, created 2025-01-25T13:28:22Z | noReviewer; 620 d |
| Q4 | bucket | #19236 1 reviewer, author update 2025-10-25T20:04:34Z after the last review | waiting; 347 d |
| Q4 | bucket | #23381 reviewer present, author update after the last review, wait 14.32 d | waiting |
| Q4 | bucket | #22996 reviewer present, author update after the last review, wait 13.58 d | not queued (14 d or less) |
| Q4 | bucket | constructed: author update at exactly the last review's submittedAt, wait 30 d | not queued (not after the review) |
| Q4 | bucket | constructed: author update after the last review, wait exactly 14 d 0 ms | not queued |
| Q4 | bucket | constructed: author update after the last review, wait 14 d + 1 ms | waiting |
| Q4 | bucket | constructed: reviewer reviewed after the author's last update (author's turn), wait 40 d | not queued |
| Q4 | bucket | captured snapshot, 625 open PRs | approved 22; noReviewer 310; waiting 61; not queued 232 (35 drafts, 90 author's turn, 44 waiting on reviewers 14 d or less, 63 without a reviewer 14 d or less) |
| Q4 | bucket | #23724 no reviewer (Copilot only), wait 0.5 d | not queued (no reviewer, 14 d or less) |
| Q4 | bucket | constructed: no reviewer, wait exactly 14 d 0 ms | not queued |
| Q4 | bucket | constructed: no reviewer, wait 14 d + 1 ms | noReviewer |
| Q5 | order | no-reviewer bucket of the captured snapshot | first three #18706 620 d, #18715 618 d, #18808 608 d |
| Q5 | order | constructed: #100 and #99 both 30 d | #99 before #100 |
| Q5 | home block | column summaries of the captured snapshot and KIP rows | PR column 393 (310 / 61 / 22), rows #18706 620 d, #18715 618 d, #18808 608 d; KIP column 14 (5 votes / 9 discussions), rows KIP-1375 30 d, KIP-785 20 d, KIP-1377 20 d (tie broken by proposal number) |
| Q6 | card label | #23724 in the snapshot, Copilot review only | Awaiting reviewer |
| Q6 | card label | #23739 in the snapshot, 4 human reviewers | In review · 4 reviewers |
| Q6 | card label | #16808 in the snapshot, 1 requested reviewer, no review | In review · 1 reviewer |
| Q6 | card label | constructed: merged PR #23623 (not in the open snapshot) | no label |
| Q6 | card label | #22751 isDraft true | no label |
| Q7 | kip candidates | Dev release 2026-10-08T03-07-37-000Z: 21 dev@ threads with [VOTE]/[DISCUSS] and a KIP key | 6 vote threads; 15 discuss threads |
| Q7 | kip candidates | KIP-1349 has [VOTE] KAFKA-MAIL-82e0d5b3 and [DISCUSS] KAFKA-MAIL-4bc41094 | vote row only |
| Q7 | kip candidates | DISCUSS: KIP-1378 … (no brackets) | not a candidate (profile tag is [DISCUSS]) |
| Q7 | kip candidates | constructed: [RESULT][VOTE] KIP-1279 thread in the release | KIP-1279 vote row removed |
| Q7 | kip candidates | constructed: two [VOTE] KIP-9 threads, last activity 09-01 and 10-01 | the 10-01 thread |
| Q7 | kip candidates | constructed: profile apache-datafusion proposal.kind null | no KIP candidates |
| Q7 | kip candidates | constructed: the Kafka profile and entries with proposal.kind set to null | no KIP candidates |
| Q8 | repliers | KAFKA-MAIL-a9696e08 KIP-1163: release has 1 message; full thread 22 messages, root Ivan Yurchenko 2025-04-23 | 5 repliers; not few |
| Q8 | repliers | KAFKA-MAIL-3bc971ac KIP-1376: root Mickael Maison, replies Paolo Patierno and Mickael Maison | 1 replier; last reply 2026-10-07T13:07:14Z |
| Q8 | repliers | KAFKA-MAIL-dd798156 KIP-1375: root only, 2026-09-08T03:17:45Z | 0 repliers; no replies · opened 30 d ago |
| Q8 | repliers | constructed: two replies from "unknown sender" | 1 replier |
| Q8 | repliers | constructed: replies from Alice and "CI Bot", profile machineUsers ["CI Bot"] | 1 replier |
| Q8 | members | constructed: reply "[EXTERNAL] RE: [VOTE] KIP-9: x" and "SV: [VOTE] KIP-9: x" | both members |
| Q8 | members | constructed: reply "Fw: Re: [VOTE] KIP-9: x" (stacked prefixes) | member |
| Q8 | members | constructed: "Re: [DISCUSS] KIP-9: x" in a [VOTE] KIP-9 tree | not unattributed (no [VOTE] tag); tally complete |
| Q8 | members | constructed: root subject "[EXTERNAL] [VOTE] KIP-9: x" | root archived |
| Q8 | members | constructed: reply "Re: [VOTE] KIP-9 (was: x)" in the tree, subject key differs | not a member; tally incomplete: 1 reply not attributed |
| Q8 | members | KAFKA-MAIL-0b57fb00 KIP-785: only message "Re: [DISCUSS] KIP-785 …" by Manan Gupta 2026-09-17, no parent | root not archived; "seen ≥ 1 replier"; queued |
| Q8 | members | constructed: [VOTE] KIP-9 started as a reply inside the [DISCUSS] KIP-9 tree | vote row uses only the [VOTE] messages; root = oldest [VOTE] message without a reply prefix |
| Q9 | vote line | Andrew Schofield: "+1 (binding)" | +1, declared binding |
| Q9 | vote line | Luke Chen: "+1 (binding) from me." | +1, declared binding |
| Q9 | vote line | Alieh Saeedi: "+1 (non-binding)" | +1, declared non-binding |
| Q9 | vote line | Bill Bejeck: "+1 (biding)" | +1, declared binding |
| Q9 | vote line | José Armando García Sancio: "+1. LGTM. Looking forward to …" | +1, unmarked |
| Q9 | vote line | Andrew Schofield: "Thanks for the KIP." then quoted "> +1 (binding)" | no vote (quoted) |
| Q9 | vote line | constructed: "+1 to Chris's suggestion" | unclear |
| Q9 | vote line | Federico Valeri: "+1 (non-binding): Vaquar Khan" (vote summary) | unclear |
| Q9 | vote line | Gabriella Fu: "0-1. Version 1 was introduced by KIP-1331 …" | no vote |
| Q9 | vote line | constructed: "I am +1 on this" (not at line start) | no vote |
| Q9 | vote line | constructed: "+1 (binding) - Mickael Maison" (vote summary) | unclear |
| Q9 | vote line | constructed: "+1 (binding)." | +1, declared binding |
| Q9 | vote line | constructed: "-1 (binding) until the upgrade path is documented" | -1, declared binding |
| Q9 | vote line | constructed: "-1: the upgrade path is missing" | -1, unmarked |
| Q9 | vote line | constructed: "+1: looks good" | unclear |
| Q9 | vote line | constructed: "+1;" | +1, unmarked |
| Q9 | vote line | constructed: "-1, binding, see below" | -1, declared binding |
| Q9 | vote line | constructed: "+1, non-binding" | +1, declared non-binding |
| Q9 | vote line | constructed: "Thanks", "From: Bob", then an unquoted "+1 (binding)" | no vote; message ambiguous (vote-like line after a quoted header) |
| Q9 | vote line | constructed: "On Mon, … wrote:", "> Please vote", then "+1 (binding)" (bottom-posted) | +1, declared binding |
| Q9 | vote line | constructed: "-----Original Message-----" then "+1 (binding)" | no vote (quoted message) |
| Q10 | binding | José Armando García Sancio unmarked +1; name in the ASF kafka committer roster (roles committer, pmc) | binding via roster |
| Q10 | binding | KIP-1349: Sushant Mahajan unmarked +1; roster roles committer (not pmc) | binding via roster (proposal votes need committer) |
| Q10 | binding | constructed: roster member writes "+1 (non-binding)" | not binding (declaration wins) |
| Q10 | binding | KIP-1279: vaquar khan unmarked +1; not in the roster | not binding; counted as unmarked |
| Q10 | binding | constructed: release vote; Sushant Mahajan unmarked +1 (committer, not pmc) | not binding (release votes need pmc); counted as unmarked |
| Q10 | binding | constructed: "José Armando García Sancio" written with a decomposed accent (NFD) | matches after NFC normalization |
| Q10 | binding | constructed: voter "jose armando garcia sancio" | no match (no case folding or transliteration) |
| Q11 | voter | KIP-1349: Sushant Mahajan from su…@gmail.com "+1" 17:38:50Z, from sm…@apache.org empty reply 18:05:01Z | 1 voter, +1 |
| Q11 | voter | constructed: A "+1 (binding)" then later "-1 (binding)" | A counts -1 binding |
| Q11 | voter | constructed: one body with "+1 (binding)" then "-1 (binding)" lines | counts -1 binding (last line in the body) |
| Q12 | vote row | KAFKA-MAIL-82e0d5b3 KIP-1349: full thread 6 messages, root 2026-08-19 | +1 × 2 · binding 2 of 3 (1 via roster); short; queued |
| Q12 | vote row | KAFKA-MAIL-e903d023 KIP-1262: Luke Chen declared, Sancio via roster | +1 × 2 · binding 2 of 3 (1 via roster); short; queued |
| Q12 | vote row | KAFKA-MAIL-86ae8b63 KIP-1368: root only | +1 × 0 · binding 0 of 3; short; queued |
| Q12 | vote row | KAFKA-MAIL-a614bccc KIP-1097: 3 messages, no vote line | +1 × 0 · binding 0 of 3; short; queued |
| Q12 | vote row | KAFKA-MAIL-75914579 KIP-1357: Lucas Brutschy, Matthias J. Sax, Bill Bejeck declared binding, root 2026-06-25 | +1 × 4 · binding 3 of 3; passing; not queued |
| Q12 | vote row | KAFKA-MAIL-ff6d44a5 KIP-1279: Mickael Maison, Andrew Schofield, Rajini Sivaram binding; vaquar khan unmarked (not a committer); 1 unclear +1 line | seen +1 × 4 · binding ≥ 3 of 3 · 1 unmarked; 1 unclear line; unresolved; queued |
| Q12 | discuss row | KIP-1153: 2 repliers | not queued (2 is not fewer than 2) |
| Q12 | discuss row | KIP-1379: 1 replier | queued |
| Q12 | discuss row | 11 discuss threads without a vote thread | 9 queued (KIP-1375, KIP-1377, KIP-1165 with 0; KIP-785 seen ≥ 1; KIP-1371, KIP-1365, KIP-1379, KIP-1342, KIP-1376 with 1); KIP-1153 and KIP-1163 not |
| Q13 | counts | queue object with stored counts {noReviewer 310, waiting 61, approved 22, vote 5, discuss 9} | accepted; counts equal the arrays |
| Q13 | counts | constructed: stored noReviewer 309 with 310 rows | rejected: counts-mismatch |
| Q14 | cite | #18706 | https://github.com/apache/kafka/pull/18706 |
| Q14 | cite | KIP-1349 vote row | https://lists.apache.org/thread/ow8p1n05rob9n3k4b7xw8m8zqx4molbl and /#/feed/KAFKA-MAIL-82e0d5b3 |
| Q16 | wording | KIP-1349, all 6 bodies read, root archived, roster read | "+1 × 2 · binding 2 of 3 (1 via roster)" |
| Q16 | wording | constructed: KIP-1349 with Andrew Schofield's message unread | "seen +1 × 1 · binding ≥ 1 of 3 (1 via roster); 1 message unread"; short |
| Q16 | wording | KIP-1279 with 1 unclear line | "seen +1 × 4 · binding ≥ 3 of 3 · 1 unmarked; 1 unclear line" |
| Q16 | wording | constructed: one "+1 (binding)" and one reply under "Re: [VOTE] KIP-9 (was: x)" | "seen +1 × 1 · binding ≥ 1 of 3; 1 reply not attributed" |
| Q16 | wording | constructed: complete tally with A "+1 (binding)" and B "-1 (non-binding)" | "+1 × 1 · binding 1 of 3 · 1 non-binding -1" |
| Q16 | wording | constructed: 3 declared binding +1 and a reply with an unquoted "+1 (binding)" below a "From:" header, open 100 h | "seen +1 × 3 · binding ≥ 3 of 3; 1 message with a vote after a quoted header"; unresolved |
| Q16 | wording | constructed: vote thread whose members are all replies, one "+1 (binding)" | "seen +1 × 1 · binding ≥ 1 of 3; thread start not archived" |
| Q19 | graphql errors | constructed: HTTP 200, data null, errors[0] "Something went wrong" (no path) | failureKind schema |
| Q19 | graphql errors | constructed: HTTP 200, data present, errors[0] path ["repository"] (not a PR node) | failureKind schema |
| Q20 | paging drift | constructed: hasNextPage true with an empty nodes list | failureKind schema (no endless loop) |
| Q21 | reopened | #16808 created 2024-08-06, reopened 2026-08-26T05:25:22Z, 1 requested reviewer | waiting since 2026-08-26T05:25:22Z; 42 d |
| Q22 | force-push | #21333 CHANGES_REQUESTED 2026-08-14, force-push 2026-09-02T10:01:16Z | waiting; 35 d |
| Q23 | bot reviewer | #23724 only review by copilot-pull-request-reviewer | 0 reviewers |
| Q23 | bot reviewer | constructed: only requested reviewer is a Bot | 0 reviewers |
| Q23 | reviewers | constructed: only review is the PR author's own COMMENTED review | 0 reviewers |
| Q23 | reviewers | constructed: requested team apache/kafka-committers, no review | 1 reviewer (team) |
| Q24 | no decision | constructed: reviewDecision null, one human APPROVED review | not approved; bucket by reviewers |
| Q28 | unparsable | constructed: thread.lua returns HTML | parse failure, not 0 repliers |
| Q28 | unparsable | constructed: thread.lua JSON without thread.epoch | parse failure, not 0 repliers |
| Q28 | unparsable | constructed: thread.epoch as the string "1790000000" | parse failure, not 0 repliers |
| Q29 | roster | KIP-1262 with no roster: Luke Chen declared, Sancio unmarked | "seen +1 × 2 · binding ≥ 1 of 3; roster unavailable"; short; queued |
| Q46 | node error | constructed: errors[0].path ["repository","pullRequests","nodes",17,"author"] on page 2 | that PR dropped; droppedNodes 1; page parsed |
| Q47 | truncated | constructed: reviewRequests totalCount 12, 10 nodes read, no review | "In review · ≥ 10 reviewers"; not noReviewer |
| Q47 | truncated | #23739 latestReviews totalCount 4, 4 nodes | 4 reviewers (exact) |
| Q49 | governance | Kafka profile | asfPreset(kafka, dev) + overrides; roster {asf, kafka}; proposal {quorum 3, lazy-majority, 72 h, committer}; release {quorum 3, lazy-majority, 72 h, pmc}; reviewWaitDays 14; fewRepliers 2 |
| Q49 | governance | DataFusion profile | asfPreset(datafusion, dev) with proposal.kind null; no KIP candidates |
| Q49 | governance | asfPreset({project: "kafka", devList: "dev"}) | mail list dev@kafka.apache.org; tags VOTE, DISCUSS, RESULT; roster adapter asf |
| Q49 | governance | constructed: proposal.kind KIP and no proposal vote rule | error: governance has no proposal vote rule |
| Q50 | roster | samples/asf-roster-kafka.json | 73 entries; 44 with pmc; smjn Sushant Mahajan [committer]; jsancio José Armando García Sancio [committer, pmc] |
| Q50 | roster | constructed: LDAP file also has projects.flink | only kafka entries kept |
| Q50 | roster | constructed: owners ["p"], members ["c"] | c [committer]; p [committer, pmc] |
| Q51 | vote state | constructed: binding +1 × 3, binding -1 × 0, open exactly 72 h | passing; not queued |
| Q51 | vote state | constructed: binding +1 × 3, open 71 h 59 min | pending-close; not queued |
| Q51 | vote state | constructed: binding +1 × 3, binding -1 × 3, open 100 h | contested; queued |
| Q51 | vote state | constructed: binding +1 × 4, binding -1 × 1, open 100 h | passing; shows binding -1 × 1 |
| Q51 | vote state | constructed: binding +1 × 3 and "-1 (binding) until …", open 100 h | passing; shows binding -1 × 1 |
| Q51 | vote state | KIP-1279: binding +1 × 3 and an unclear +1 summary line | unresolved; queued (an unclear line makes the tally a lower bound) |
| Q51 | vote state | constructed: binding +1 × 3 and "-1: no" from a roster committer, open 100 h | passing; shows binding -1 × 1 |
| Q51 | vote state | constructed: binding +1 × 3 declared, 1 body unread, open 100 h | unresolved; queued |
| Q51 | vote state | constructed: no roster; binding +1 × 3 declared and an unmarked "-1.", open 100 h | unresolved; queued; "seen +1 × 3 · binding ≥ 3 of 3 · 1 unmarked -1; roster unavailable" |
| Q53 | via roster | KIP-1262 | binding 2 of 3 (1 via roster) |
| Q53 | via roster | KIP-1357: all 3 binding declared | no "via roster" part |
| Q54 | roster | constructed: members has id "ghostid" with no people entry | entry {id ghostid, name null}; never matches |
| Q55 | roster | constructed: LDAP file without projects.kafka | roster failure; declared markers only |
| Q55 | roster | constructed: projects.kafka with no members field | roster failure |
| Q56 | vote state | constructed: root not archived, binding +1 × 3, newest message 10 d old | unresolved (a seen tally is never passing); queued |
<!-- test-plan:end -->

Slice 2, the job in the data Worker:

<!-- test-plan:start packages/reference-pipeline/test/review-queue-run.cases.ts -->
| id | rule | input | expected |
| --- | --- | --- | --- |
| Q17 | rate limit | constructed: GraphQL HTTP 403 "secondary rate limit", Retry-After 120 | no retry; PR section keeps the previous snapshot; github failureKind rate-limit |
| Q17 | rate limit | constructed: HTTP 429 with Retry-After 30, then 200 | one retry after 30 s; snapshot published |
| Q17 | rate limit | constructed: HTTP 429 with Retry-After 60, then 200 | one retry; published |
| Q17 | rate limit | constructed: HTTP 429 with Retry-After 61 | no retry; previous kept; rate-limit |
| Q17 | rate limit | constructed: HTTP 200 with errors[0].type RATE_LIMITED | rate-limit; previous snapshot kept |
| Q18 | partial pages | constructed: page 3 of 7 returns 502 twice | no PR snapshot published; previous kept; failureKind transport; page 3 tried twice |
| Q19 | graphql errors | constructed: page 2 of 7 has data null and an error without a path | failureKind schema; previous kept |
| Q25 | thread fetch | constructed: thread.lua 503 twice for KIP-1376, previous row exists | previous row kept with its fetchedAt |
| Q25 | thread fetch | constructed: thread.lua 503 twice for a new thread | row omitted; unavailable 1 shown |
| Q26 | email fetch | constructed: email.lua 404 for one KIP-1349 message | row shows seen wording (Q16); message counted unread |
| Q27 | cache | constructed: second run, KIP-1349 thread unchanged | 0 email.lua requests for KIP-1349 |
| Q27 | cache | constructed: previous object regexVersion 1, current 2 | 6 email.lua requests for KIP-1349 |
| Q30 | feed release | constructed: public/v2/current.json missing | KIP section keeps previous; mail fetchedAt and feedReleaseId kept; PR section updated; mail failureKind pointer-missing |
| Q32 | overlap | constructed: run B (started later) wrote pointer; run A finishes after | A's pointer write refused (ETag changed), not retried; B stays |
| Q33 | too large | constructed: GraphQL page body 4 MiB + 1 byte | failureKind too-large; previous kept |
| Q33 | too large | constructed: GraphQL page body exactly 4 MiB | accepted |
| Q42 | auth | constructed: GraphQL HTTP 401 | failureKind auth; no retry; KIP section updated |
| Q43 | first run | constructed: no previous object; Pony Mail down; GitHub ok | published; PR column filled; KIP column unavailable; mail ok false; last-run ok true |
| Q43 | no source | constructed: previous object exists; GitHub 401 and the Feed pointer missing | pointer unchanged; no new object; last-run ok false, failureKind no-source |
| Q43 | no source | constructed: no previous object; GitHub 401 and the Feed pointer missing | nothing published (no pointer); last-run ok false, failureKind no-source |
| Q44 | crash | constructed: run killed after the content object write | pointer unchanged; next run publishes; verify:health flags last-run older than 2 h |
| Q45 | write | constructed: R2 put of the content object throws | pointer and previous object unchanged; last-run failureKind write |
| Q48 | mail retry | constructed: thread.lua 503 with Retry-After 5, then 200 | one retry after 5 s; row updated |
| Q48 | mail retry | constructed: 21 thread requests | sequential, at least 1 s apart |
| Q52 | roster cache | constructed: stored roster fetched 23 h 59 min ago | reused; 0 roster requests |
| Q52 | roster cache | constructed: stored roster fetched exactly 24 h ago | refetched; 2 roster requests |
| Q52 | roster cache | constructed: stored roster 30 h old, refetch fails | stored roster and its fetchedAt kept |
| Q52 | roster cache | constructed: no stored roster, refetch fails | no roster; tallies use the seen wording (Q29) |
| Q57 | cron | constructed: REVIEW_QUEUE_CRON unset; cron 7 * * * * fires | publisher |
| Q57 | cron | constructed: REVIEW_QUEUE_CRON 27 * * * * set; it fires | review-queue |
| Q57 | cron | constructed: REVIEW_QUEUE_CRON 27 * * * * set; the publisher cron 7 * * * * fires | publisher |
| Q57 | cron | constructed: DIGEST_CRON 37 1 * * * and REVIEW_QUEUE_CRON 27 * * * * set; 37 1 * * * fires | digest |
| Q57 | cron | constructed: DIGEST_CRON and REVIEW_QUEUE_CRON both 27 * * * * (misconfigured); it fires | digest |
| Q58 | manual run | constructed: run with dryRun | counts returned; 0 R2 writes |
| Q40 | run record | captured samples: a full run | last-run ok; github 7 requests; mail 17 thread + 34 email requests; roster 2 requests; counts noReviewer 310, waiting 61, approved 22, vote 5, discuss 9 |
| Q40 | run record | constructed: GET /health with last-run.json in R2 | reviewQueue is the last-run object |
| Q40 | run record | constructed: /health merge with no last-run object | reviewQueue null |
<!-- test-plan:end -->

Slice 3, web:

<!-- test-plan:start packages/reference-pipeline/test/review-queue-ui.cases.ts [pending] -->
| id | rule | input | expected |
| --- | --- | --- | --- |
| Q7 | column | fixture: apache-datafusion (proposal.kind null) | no KIP column |
| Q5 | block | fixture queue for apache-kafka | #review-queue shows PR 393 and KIP 13, 3 rows each, link "All" to /#/review/apache-kafka |
| Q6 | card | fixture: topic page with #23724 and #23739 | .pr-review-label "Awaiting reviewer" and "In review · 4 reviewers" |
| Q15 | i18n | every review.* key | present in en and zh-Hant |
| Q31 | stale | object generatedAt 3 h 0 min 1 s ago (controlled clock) | freshness line stale |
| Q31 | stale | object generatedAt 2 h 59 min ago, github section fetchedAt 5 h ago | PR column shows its own as-of time, stale |
<!-- test-plan:end -->

## Acceptance

Items tagged `[pending]` belong to slice 3 (see Slices). The
traceability gate lists them without failing and blocks Status: Implemented
until they are done.

### Behavior
- Q1: page parsing merges all pages and deduplicates by number (625 PRs in 7
  pages on the captured snapshot).
- Q2: bots (`Bot`, `[bot]`, profile `machineUsers`) are machines; a deleted
  author is a human "ghost".
- Q3: waiting since = later of the author's last update (created, commit,
  force-push, ready-for-review, reopen) and the last human review.
- Q4: buckets by first match; `noReviewer` and `waiting` need wait > 14 d
  strictly; `waiting` needs an author update strictly after the last review;
  on the captured snapshot approved 22, no reviewer 310, waiting 61, not
  queued 232.
- Q5: sort by `waitDays` then numeric id; the column summary has totals,
  bucket counts, and the 3 longest waits (core rows here; the rendered block
  and its link are slice 3 rows).
- Q6: the card label is "Awaiting reviewer" or "In review · n reviewers";
  drafts and PRs not in the snapshot get none.
- Q7: KIP candidates come from Feed entries via the profile's tags; a vote
  supersedes discuss; `[RESULT]` removes the vote row; `kind: null` gives no
  candidates.
- Q8: thread members share the candidate's `memberKey` (gateway tags and
  reply prefixes stripped); other replies naming the proposal and stage are
  unattributed and make the tally incomplete; repliers exclude the root's
  author and machines and come from the full thread (KIP-1163: 5, not 1); a
  thread without an archived root uses the "seen" wording (KIP-785).
- Q9: vote lines follow the regex in Behavior 12; `>` lines never count;
  bottom-posted votes below a `>` quote count; every -1 line is a vote;
  "+1 to …", "+1: …", "+1 (binding) - Name", and summary lines are unclear;
  a vote-like line after an Outlook header makes the message ambiguous.
- Q10: binding = declared marker, else an exact name match against roster
  entries holding the vote kind's `bindingRole` (committer for KIPs).
- Q11: one vote per voter name; the latest vote counts.
- Q12: discuss rows queue when repliers < 2; on the captured data 5 vote and
  9 discuss rows are queued.
- Q13: every count comes from `reviewQueueCounts`; a queue whose stored counts
  differ is rejected.
- Q14: every row links to its GitHub or lists.apache.org source.
- Q15: [pending] every `review.*` key exists in en and zh-Hant.
- Q16: a tally is a plain count only when it is complete (Behavior 13); roster,
  unmarked, and minus parts are shown next to it; otherwise the "seen … ≥"
  wording with every reason.
- Q21: a reopened PR waits from the reopen (#16808: 42 d).
- Q22: a force-push after a review is an author update (#21333: waiting, 35 d).
- Q23: bot reviews and bot review requests do not make a reviewer (#23724).
- Q24: `reviewDecision` null is never approved.
- Q49: the Kafka profile is `asfPreset` plus overrides, with proposal votes
  `{quorum 3, lazy-majority, 72 h, committer}` and release votes `{…, pmc}`;
  DataFusion from the same preset has no proposal kind; a profile with a
  proposal kind but no proposal vote rule is an error, not a hidden column.
- Q50: the ASF roster adapter keeps only the project's entries with ids,
  names, and roles (Kafka: 73 entries, 44 pmc).
- Q51: vote state follows lazy majority: `short`, `unresolved` (a "seen"
  tally at or above quorum), `contested` (binding +1 not more than binding
  -1), `pending-close` (open < 72 h), `passing`; `short`, `unresolved`, and
  `contested` are queued.
- Q53: binding votes counted through the roster are reported as "via roster"
  (KIP-1262: 2 of 3, 1 via roster).

### Failure and retry
- Q17: GitHub rate limit (403/429, or `RATE_LIMITED` in `errors`):
  one retry only when `Retry-After` ≤ 60 s (60 retries, 61 does not);
  otherwise the PR section keeps the previous snapshot and `last-run.json`
  records `rate-limit`.
- Q18: a page that fails after the retry discards the whole
  snapshot; no partial PR list is published.
- Q19: a GraphQL error without a node `path`, or with `data` null, makes page
  parsing fail with `schema`.
- Q20: an empty page that claims a next page fails parsing as `schema`.
- Q25: a thread that fails keeps its previous row and `fetchedAt`;
  a new thread that fails is omitted and counted in `kips.unavailable`.
- Q26: a body that fails to download is counted as unread, so the
  tally uses the "seen" wording (Q16).
- Q27: a second run with an unchanged vote thread makes no
  `email.lua` requests for it; a changed `regexVersion` refetches its bodies.
- Q28: a non-JSON or malformed Pony Mail thread is a parse failure, not
  "0 repliers".
- Q29: without a roster, unmarked votes' binding is unknown ("≥" wording) and
  the row stays queued.
- Q30: a missing Feed pointer or release keeps the previous KIP
  section, its `fetchedAt`, and its `feedReleaseId`; the PR section is still
  updated.
- Q31: [pending] a column older than 3 h, or whose source failed, shows its
  own as-of time and the stale style (E2E, controlled clock, both sides of
  3 h).
- Q32: a run that finishes after a newer run does not replace the
  pointer and does not retry.
- Q33: a response over 4 MiB fails that source as `too-large`
  (exactly 4 MiB passes).
- Q42: GitHub 401 fails the PR source as `auth`, with no retry; the
  KIP section is still updated.
- Q43: the first run with a failed source publishes the other
  section, marks the failed column unavailable, records `ok: false` for
  that source, and the run is `ok`; a run where no source succeeded publishes
  nothing new (failureKind `no-source`), keeping the previous pointer or, on
  a first run, publishing nothing.
- Q44: a crash after the content object write leaves the pointer
  unchanged; `verify:health` reports `last-run.json` older than 2 h as a
  missing run.
- Q45: a failed R2 write of the content object leaves the pointer
  and the previous object unchanged and records `write`.
- Q46: a GraphQL error whose `path` points into one PR node drops that PR and
  counts it in `droppedNodes`; the page still parses.
- Q47: a PR whose `reviewRequests` or `latestReviews` `totalCount` exceeds the
  nodes read shows "≥ n reviewers" and is never `noReviewer`.
- Q48: Pony Mail and roster requests are sequential, at least 1 s
  apart, with one retry after a 5xx, 429, or network error when
  `Retry-After` ≤ 60 s.
- Q52: a stored roster younger than 24 h is reused without
  requests; an older one is refetched; a failed refetch keeps the stored
  roster and its `fetchedAt`; with none, Q29 applies.
- Q54: a roster id without a name in the people file is kept with `name: null`
  and never matches a voter.
- Q55: a roster response without the project or its `members` is a roster
  failure (Q29), never an empty roster.
- Q56: a vote whose root is not archived is never `passing`: its tally is a
  lower bound, so it is `short` or `unresolved`, and queued.

### Budget
- Q34: [measure] GitHub per run: 7 requests, 306 KB, 41.9 s sequential, 21
  GraphQL points (limit 5,000/h). Measured again by the job itself
  2026-10-08T07:27Z: 7 requests, 298 KB, 46.5 s (cold) and 40.6 s (warm).
  Command: `bun run measure:review-queue -- --warm`.
- Q35: [measure] Pony Mail per run: cold 17 `thread.lua` (one per
  candidate) + 34 `email.lua`, 51 requests, 248 KB, 52.2 s; warm 17
  requests, 159 KB, 16.9 s. Roster: 2 requests, 1.76 MB, 1.5 s, at most once
  a day. A cold run took 100.2 s and a warm one 57.5 s. Command:
  `bun run measure:review-queue -- --warm`.
- Q36: [measure] memory: heap growth of the parsed Feed index (10.5 MB of
  JSON) is 22.6 MB at 1x and 45.2 MB at 2x, within 80 MB at 2x (JSC heap
  size; Bun's `heapUsed` does not move with `JSON.parse`); the roster
  refresh parses 1.8 MB. The cron invocation has its own isolate; the publisher
  alarm (Dev :07, ≤ 15 min) has ended before :27. Command:
  `bun run measure:review-queue -- --scale 2`.
- Q37: [deploy] Dev wall time of the run at most 5 min (15-min cron limit),
  and the publisher alarm's wall time unchanged within run-to-run noise
  (Cloudflare analytics).
- Q38: [measure] at most 100 subrequests per run (limit 20,000). Measured:
  cold 60 upstream + 8 R2 operations = 68; warm 24 + 8 = 32.

### Observability
- Q40: `last-run.json` records `ok`, `completedAt`, `durationMs`,
  per source `{ok, requests, bytes, durationMs, failureKind?}`, the roster's
  `fetchedAt`, `droppedNodes`, `unavailable`, and `counts`;
  `bun run verify:health` prints its age and failures.
- Q41: [deploy] on Dev after the first run, the block's counts equal the list
  page's and the object's, and 3 sampled PRs match GitHub's review state.

- Q57: a cron tick runs the review queue only when it equals
  `REVIEW_QUEUE_CRON`; with it unset, or for any other cron, the publisher
  runs as before; the digest cron still runs the digest.
- Q58: `POST /review-queue/run?dryRun=1` returns the run record with counts
  and writes nothing to R2, the roster cache included.

(Q39 was removed in review as a duplicate of Q31.)

## Planned feature-map and gardening updates (in the implementation PR)

- `docs/feature-map.md`: `/api/review-queue`, route `/#/review/<projectId>`,
  selectors `#review-queue`, `.review-col[data-col]`, `.review-bucket`,
  `.review-row`, `.review-asof`, `.pr-review-label`, the cron, the upstream
  sources (GraphQL, `thread.lua`, `email.lua`, ASF LDAP roster), and a Spec
  015 row Q1–Q56.
- `docs/gardening.md`:
  - G8: done in slice 1 (the review queue uses `isMachineAuthor` plus GitHub's
    `Bot` type).
  - G9: add `public/review-queue/v1/` and `internal/rosters/v1/` to the
    retention scope, in slice 2, which writes them.
  - New: voter identity is the display name; a person who mails under two
    names counts twice, and two people with one name count once.
  - New: a rebase-only force-push counts as an author update.
  - New: emeritus committers cannot be excluded (no public source); roster
    matches are shown "via roster". The roster is today's, not the one at the
    vote's date.
  - New: a vote closed by a `[RESULT]` older than the Feed release window
    comes back as "short of quorum" if someone replies to the old vote
    thread. Fix when seen: read `[RESULT]` subjects from Pony Mail by key.

## Non-goals

- A personal "assigned to me" or "my reviews" view: the future Following tab.
- Other proposal kinds until a profile declares them.
- Mergeability, CI status, or conflict detection.
- Notifications or alerts about the queue.
- Changing the hourly publication run or the Feed.
- Author comments as author activity.
- Verifying identity across email addresses and GitHub logins.
- An OWNERS-file roster adapter and non-ASF governance presets.
- Showing release (RC) vote rows; the release vote rule is declared only.
- Excluding emeritus committers (no public source; Behavior 22).

## Review log

| # | Finding | Resolution |
| --- | --- | --- |
| 0 | Coordinator (2026-10-08): Spec 014 drops its tally; this spec owns vote and reply counts and must never show an understated count as fact; define +1 as a regex and handle "+1 to X's suggestion" | Applied: solution-space table for tallies; full threads and bodies (Behavior 9–13); `tallyVote` owned here; Q9, Q16, Q26, Q29 |
| 1 | Major: an unmarked +1 from a name not in the roster is counted non-binding as fact | Applied: `unmarked` is shown next to the binding count ("binding 1 of 3 · 1 unmarked"); Behavior 13, Q16, Q12 rows |
| 2 | Major: stopping at "wrote:" drops bottom-posted votes | Applied: skip `>` lines and attribution lines; stop only at "Original Message" or a `From:` block (Behavior 12, Q9 rows). Recomputed: all 6 captured tallies unchanged |
| 3 | Major: `rest` alternative `-\s` accepts "+1 (binding) - Name" summaries | Applied: removed; Q9 rows for "- Name", "+1 (binding).", "-1 (binding) until …"; -1 with a reason is unclear, stated in Behavior 12 |
| 4 | Major: `find_parent` may merge a VOTE started inside a DISCUSS tree | Applied: members share the candidate's thread key; root = oldest non-reply member, else "not archived" with "seen" wording (Behavior 9). This also corrected the Example: KIP-785's only message is a parentless "Re:", so its row is "seen ≥ 1", not "0 repliers" |
| 5 | Major: case rows over the full snapshot and KIP-1378 have no committed sample | Applied: `samples/github-open-prs.json` (all 625, 305 KB) and `samples/feed-kip-mail-entries.json`; Q5 names its 3 rows per column |
| 6 | Major: a persistent node-level GraphQL error would freeze the PR section | Applied: node-scoped errors drop the node and count `droppedNodes` (Behavior 1, Q46); others stay `schema` (Q19) |
| 7 | Minor: "5 … so 10 remain" contradicts the table | Applied: 4 superseded, 11 candidates |
| 8 | Minor: Q21–Q24 are behavior, failure items too few | Applied: moved to Behavior; added Q42 auth, Q43 first run, Q44 crash, Q45 write, Q46 node error, Q47 truncation, Q48 Pony Mail retry and spacing (20 Behavior, 20 Failure) |
| 9 | Minor: missing boundary pairs | Applied: Retry-After 60/61, 4 MiB exact/+1, author update equal to the review time, truncated reviewer lists |
| 10 | Minor: ordering ambiguous | Applied: sort by `waitDays` then numeric id; one bucket order; KIP wait defined (Behavior 6) |
| 11 | Minor: drafts and the card label | Applied: drafts have no label (Behavior 7, Q6 row) |
| 12 | Minor: `voteBodies` misnamed and unversioned | Applied: `voteLines {regexVersion, byMid}`, dropped when no longer a candidate (Behavior 14, Q27 row) |
| 13 | Minor: partial mail failure not representable | Applied: `kips.unavailable`; `mail.ok` defined (Behavior 14, 16) |
| 14 | Minor: Q36 mixes heap and RSS | Applied: bound is heap growth; isolate assumption stated |
| 15 | Minor: Q39 duplicates Q31; list route unowned; pointer rule redundant; measure command planned | Applied: Q39 removed; route owned by the canvas links; pointer = ETag-conditional, no retry; Q34 says the command must ship before it counts |
| 16 | Minor: a `[RESULT]` older than the window re-queues a closed vote on a late reply | Rebutted for v1: recorded as a gardening item; no captured case, and a fix needs a new Pony Mail query |
| G1 | Governance review, major: bylaws misattributed; the KIP rule lives on the KIP process page; bylaws' "-1 votes" is unqualified | Applied: both pages cited and quoted; the binding -1 reading is stated (Evidence, ADR-0016) |
| G2 | Major: a "seen" tally could still become passing or contested; unmarked -1s were invisible | Applied: state `unresolved` for incomplete tallies at or above quorum (queued); `minus` and `minusUnmarked` added and shown; Q51 and Q56 rows |
| G3 | Major: generated tables stale | Applied: `bun run docs:test-plan`; `check:test-plan` passes |
| G4 | Major: Q52 had no slice 2 rows | Applied: 23 h 59 min, exactly 24 h, failed refetch, no stored roster |
| G5 | Minor: `unmarked` definition inconsistent | Applied: "not matched as binding (not in the roster, or without the role)" |
| G6 | Minor: release kind detection unreachable | Applied: only proposal votes are candidates; the release entry is declared data |
| G7 | Minor: adapter mixes I/O and parsing; owners ⊆ members implicit | Applied: `sources()` + pure `parse()`; an `owners` id gets both roles |
| G8 | Minor: emeritus degradation direction unstated | Applied: overstated, never understated, visible as "via roster"; the 5 inactive mentors match the kafka-site gap, recorded as the ADR revisit option |
| G9 | Minor: open days used calendar dates | Applied: floor of elapsed days (104 d, 91 d); also #18808 is 608 d, not 609 |
| G10 | Minor: ADR binding bullet | Applied |
| V1 | Verifier on 3491c2f (all slice 1 IDs pass): "-1: reason", "+1:", "+1;" were dropped silently by the lookahead | Applied: `:` and `;` allowed; every -1 line is a vote; an unclear +1 makes the tally incomplete (Behavior 12–13, Q9, Q51 rows). On real data KIP-1279's summary line now makes its tally "seen … ≥ 3" and the row `unresolved`, queued (KIP column 13 → 14) |
| V2 | Verifier: replies with `[EXTERNAL]`, `RE:`, `AW:`, `SV:`, `Fwd:` prefixes were not members, so their votes vanished from a "complete" tally | Applied: `memberKey` (Behavior 9); replies naming the proposal and stage under another subject are unattributed and make the tally incomplete; a vote-like line after an Outlook header marks the message ambiguous (Q8, Q9, Q16 rows) |
| V3 | Verifier survivors V9, P3, P16, T2, T4, R4 | Applied: one row each (Q11, Q23 ×2, Q8, Q7, Q50); all killed |
| V4 | Verifier doc drift: shared-code claims, G8/G9 promises, Behavior 12 first sentence, Behavior 13 names, silent drop when no proposal vote rule | Applied: code now reuses Spec 014's `isMachineAuthor`, `proposalKeys`, and `subjectHasTag` (signatures widened to the fields they read); `threadKey` is explicitly not shared; G8 note added, G9 moved to slice 2; Behavior 12–13 rewritten; a missing proposal vote rule is an error (Q49 row) |
| S2 | Slice 2 coordinator notes: memberKey single pass, unattributed without the tag condition, `isReply` on gateway-tagged roots, the "reply not attributed" text, a declared non-binding -1 missing from the text, "-1, binding, see below" read as unmarked | Applied: rows for each (Q8 ×3, Q16 ×2, Q9 ×2); `isReply` strips gateway tags first; the text shows "non-binding -1"; a comma may precede the marker; `VOTE_REGEX_VERSION` 2 |
| S3 | Slice 2 verifier: every source failing still published an object (empty on a first run); mail `fetchedAt` kept but untested (V23); `/health` read untested (V39); run `ok` with one failed source unpinned (V21); `feedReleaseId` in the text but not the object; `finally` wording | Applied: `no-source` skips the content and pointer writes (Behavior 16, Q43 rows); Q30 row asserts `fetchedAt` and `feedReleaseId`; a handler test reads `/health`; Q43 row asserts the run is `ok`; `sources.mail.feedReleaseId` added; Behavior 17 states why the run record is written after the run, not in `finally` |
