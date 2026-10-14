# Spec 022: GitHub pull-request reviews

Status: Draft for owner review; slice 1 implemented behind `GITHUB_REVIEWS`, which is unset in both environments
Date: 2026-10-14
Traceability: enforced
Builds on: Spec 004 (GitHub connector), Spec 009 (bounded memory), Spec 015 (review queue, ADR-0016), Spec 018 (daily publication), Spec 019 (contributor profile, decision 7)

> **How to read this.** The owner decided on 2026-10-14 that reviews are
> ingested before the contributor profile is built (Spec 019 decision 7).
> This spec is that ingestion. The code is merged switched off: with
> `GITHUB_REVIEWS` unset the Worker sends no extra request and `/health` is
> byte-identical. Five choices are the owner's and are listed in
> [Decisions needed from owner](#decisions-needed-from-owner), each with a
> recommendation; the implementation follows the recommendations.

## Intent

A person who reviews pull requests is recorded as having reviewed them:
who, on whose pull request, which verdict, when, on which commit, with how
many inline comments.

Today the GitHub connector reads issues, pull requests and conversation
comments only. A formal review (approve, request changes, comment) and the
inline comments submitted with it are not ingested, so the contributor
profile (Spec 019) would show `chia7712` commenting on 46 pull requests
where GitHub counts 168 reviewed: wrong by a factor of about 3.6 for exactly
the people the profile is for.

Observable outcome: after the flag is set on Dev, each daily tick stores one
row per review submitted since the last tick, and `/health` says how many,
from how many requests.

## Evidence

All numbers are from public reads of `apache/kafka` and `apache/datafusion`
on 2026-10-14 between 01:40 and 01:57 UTC. DAY is 2026-10-13, WEEK is
2026-10-07 to 2026-10-13 (UTC). Per-day figures are min / median / max over
the seven days.

### Volume

| | Kafka DAY | Kafka WEEK | Kafka per day | DataFusion DAY | DataFusion WEEK | DataFusion per day |
| --- | --- | --- | --- | --- | --- | --- |
| Pull requests updated | 69 | 222 | 15 / 28 / 69 | 77 | 297 | 20 / 42 / 77 |
| Issues updated (same listing) | 0 | 0 | 0 | 17 | 125 | 6 / 18 / 30 |
| Reviews submitted | 77 | 327 | 4 / 48 / 77 | 41 | 351 | 21 / 51 / 88 |
| of them APPROVED | 16 | 71 | | 14 | 116 | |
| of them CHANGES_REQUESTED | 0 | 7 | | 2 | 13 | |
| of them COMMENTED | 61 | 249 | | 25 | 221 | |
| of them DISMISSED | 0 | 0 | | 0 | 1 | |
| Pull requests reviewed | 37 | 94 | 2 / 26 / 37 | 28 | 137 | 12 / 29 / 43 |
| Reviewers | 21 | 49 | | 16 | 61 | |
| Inline review comments | 94 | 476 | 21 / 57 / 138 | 37 | 369 | 24 / 49 / 108 |
| Reviews by a bot | 6 | 23 | | 1 | 6 | |
| Reviews by the pull request's own author | 43 | 143 | | 11 | 133 | |
| Reviews with no text of their own | 55 | 207 | | 19 | 194 | |

Earlier days are lower bounds for "updated": an item is listed only at its
latest update.

Five facts that shaped the design:

1. **Every inline comment belongs to a review.** No comment had a null
   review id, every review id of the 845 comments of the week is among the
   reviews read, and the reviews' `comments.totalCount` sums to exactly the
   comment count in both repositories (476 and 369). A reply in a review
   thread is itself a review with one comment.
2. **About 4 reviews in 10 are the author answering.** 143 of 327 (Kafka)
   and 133 of 351 (DataFusion) reviews of the week were submitted by the
   pull request's own author. Counting them as "reviews given" would be the
   opposite error to the one this spec fixes.
3. **A bot is not recognisable by its login.** The same Copilot reviewer is
   `copilot-pull-request-reviewer` with type `Bot` in GraphQL,
   `copilot-pull-request-reviewer[bot]` in REST `/reviews`, and `Copilot` in
   REST `/pulls/comments`. Only the type is stable.
4. **A review changes the pull request's update time.** Over 1,804 reviews
   on 600 pull requests none was submitted after its pull request's
   `updatedAt`, and the issue listing's `updated_at` equalled the pull
   request's in 529 of 529 cases. So "updated since" finds every new review.
5. **Six in ten reviews have no text.** 207 of 327 and 194 of 351 have an
   empty body (an approval click, or a container for inline comments).

No pull request had more than 28 reviews (the read takes 100).

### Requests, per daily run

`bun run measure:github-reviews` runs the real job against the live API with
an in-memory bucket (2026-10-14 01:55 UTC):

| Window | Project | Listed | Pull requests | Reviews (bot, by the author) | REST + GraphQL requests | GraphQL cost | Response | Month objects | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 day | Kafka | 69 | 69 | 77 (6, 43) | 1 + 3 | 3 | 0.39 MB | 1, 17,393 bytes | 4.6 s |
| 1 day | DataFusion | 103 | 85 | 42 (1, 11) | 2 + 4 | 4 | 0.76 MB | 1, 9,478 bytes | 5.9 s |
| 7 days | Kafka | 223 | 223 | 329 (23, 145) | 3 + 9 | 9 | 1.24 MB | 1, 74,017 bytes | 12.6 s |
| 7 days | DataFusion | 428 | 302 | 351 (6, 132) | 5 + 14 | 13 | 3.09 MB | 1, 78,593 bytes | 25.9 s |
| 35 days, cut at the cap | Kafka | 500 | 500 | 959 (52, 274) | 6 + 20 | 20 | 2.81 MB | 2, 215,994 bytes | 34.8 s |
| 35 days, cut at the cap | DataFusion | 1,000 | 500 | 404 (11, 160) | 10 + 20 | 20 | 7.21 MB | 2, 90,483 bytes | 35.2 s |

A row is 224 to 226 bytes. A normal day is **10 requests and about 10
seconds** for both projects together. (One GraphQL request of the 7-day
DataFusion run and one listing page of the 35-day Kafka run were retried
after a transient error, which is why 14 requests cost 13 and 500 items took
6 pages.)

### The three ways to read reviews

| | A. REST per pull request | B. GraphQL, newest first | C. chosen: REST listing + GraphQL batches |
| --- | --- | --- | --- |
| How | `GET /pulls/{n}/reviews` for each updated pull request, plus `GET /pulls/comments?since=` for inline comments | `pullRequests(orderBy: UPDATED_AT, DESC)` with nested `reviews` | `GET /issues?since=&sort=updated&direction=asc`, then `pullRequest(number:)` × 25 per GraphQL request |
| Requests on DAY, Kafka / DataFusion | 72 / 86 | 2 / 2 points | 4 / 6 |
| "Updated since", oldest first, with a cap that catches up | yes | no: GitHub offers no `since` and no usable ascending order here, so a backlog larger than the cap cannot be resumed | yes, the same cursor rule as the GitHub connector |
| Inline comment count per review | a second endpoint, joined by review id | on the review (`comments.totalCount`) | on the review |
| Bot type | `user.type`, login with `[bot]` | `__typename` | `__typename` |
| Wasted reads | 4 in 10 pull requests have no review (93 of 222, 111 of 297) | none | none (25 pull requests per request) |

A is 158 requests a day against 10. B is cheapest but cannot be cut and
resumed safely. C keeps the connector's proven cursor and cap and costs one
listing page more than B.

`GET /pulls/comments?since=` has one more trap: a comment drafted in a
pending review keeps its draft time as `created_at`, and `since` filters on
`updated_at`; 359 of Kafka's 378 comments with differing timestamps were
updated at the moment their review was submitted. The count on the review
has no such subtlety.

### Can the review queue's read serve both?

No. The review-queue job (Spec 015, `OPEN_PRS_QUERY` in
`packages/reference-pipeline/src/review-queue/prs.ts`) reads every **open**
pull request with `latestReviews`: the newest review of each reviewer, on
open pull requests only. Ingestion needs **every** review on pull requests
updated since the cursor, most of them merged or closed by the time they are
read (an approval is usually followed by the merge). Different selection,
different content, different cadence (the queue is unscheduled). The reverse
does not work either: the queue needs pull requests nobody touched for
months. What is shared is code: the GraphQL request with its retry rules
(`graphqlPage`, now taking the query) and the bot rule.

### What exists today

- `apps/github-publisher/github-connector.ts`: first poll 1 day, then the
  cursor minus 300 s, 200 issues per repository per run
  (`MAX_ISSUES_PER_SOURCE`). It reads issue-thread comments; its events live
  in the publication's Durable Object state.
- `apps/data-publisher-worker/src/pipeline.ts` `compactState`: events older
  than 35 days are dropped.
- Dev `/health`, 2026-10-13T22:07:09Z: `logicalEventCount` 9,206, Search
  `chunkCount` 8,996, 8,996 vectors, publication R2 `classA` 391,
  `classB` 8,343.
- `/health` `reviewQueue` is `null` on Dev: the review-queue job has never
  written a run there, so a GraphQL request with the Dev
  `GITHUB_SOURCE_TOKEN` is not yet proven (see
  [Could not be verified](#could-not-be-verified)).

## Example

Kafka pull request #23675 (author `lucasbru`), as read on 2026-10-14:

| Review | Reviewer | Type | State | Submitted | Inline comments |
| --- | --- | --- | --- | --- | --- |
| 5458691803 | `copilot-pull-request-reviewer` | Bot | COMMENTED | 2026-10-08T15:04:14Z | 1 |
| 5468541580 | `lucasbru` | User | COMMENTED | 2026-10-09T10:53:50Z | 1 |
| 5469127408 | `copilot-pull-request-reviewer` | Bot | COMMENTED | 2026-10-09T10:57:54Z | 0 |
| 5471076182 | `bbejeck` | User | APPROVED | 2026-10-09T13:59:54Z | 0 |

Stored in `internal/github-reviews/v1/apache-kafka/2026-10.json`:

```json
{"reviewId":5471076182,"pr":23675,"prAuthor":"lucasbru","reviewer":"bbejeck","isBot":false,"state":"APPROVED","submittedAt":"2026-10-09T13:59:54Z","commit":"9d06676db8c7d98927158c2237d7d7c268ca34c6","inlineComments":0}
```

What a profile can say from the four rows: `bbejeck` approved one pull
request by `lucasbru`. It must not say `lucasbru` reviewed anything (the row
has `reviewer` equal to `prAuthor`: he answered a thread) and must leave the
two bot rows out (`isBot`). The link to the evidence is
`https://github.com/apache/kafka/pull/23675#pullrequestreview-5471076182`.

DataFusion #25716 holds the week's one dismissed review: `kosiew`,
`DISMISSED`, 4 inline comments. GitHub no longer says what the verdict was.
Had the job stored it before the dismissal, the row would keep it as
`stateBefore`.

## Data model

**One row per review. Inline comments are a count on that row. Nothing
enters Feed, Detail, Search or Vectorize. No text is fetched.**

| Field | Why it exists |
| --- | --- |
| `reviewId` | The row's identity (GitHub's review id) and the anchor of the evidence link |
| `pr` | "Reviews given" counts distinct pull requests (Spec 019 W8); the link |
| `prAuthor` | Tells a review from the author's own reply (fact 2); "reviewed pull requests by" (Spec 019 section 7) |
| `reviewer` | Who |
| `isBot` | Spec 019 excludes bots; decided at ingestion from GitHub's type, which only the API response carries (fact 3) |
| `state` | The verdict: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` |
| `stateBefore` | Only on a dismissed review whose verdict was stored earlier; otherwise the verdict is lost |
| `submittedAt` | When; also the month the row is stored under |
| `commit` | Which revision was reviewed (the owner's list of 2026-10-14) |
| `inlineComments` | Inline comments submitted with this review |

### Inline comments: individual rows, grouped, or counted

| Option | Requests a day | Rows a day (both projects) | Verdict |
| --- | --- | --- | --- |
| Individual rows (id, path, time) | +3 (`/pulls/comments?since=`), with the draft-time trap above | +131 (the week's 845 / 7), 2.4 times today's review rows | Rejected for now: nothing reads a path (Spec 019 takes areas from labels and lists "areas by changed file path" as not proposed) |
| Grouped per review, with paths | +3, or a third GraphQL level | 0 more rows, a list per row | Rejected for the same reason |
| **Counted on the review** | 0 | 0 | Chosen: complete (fact 1), free, and enough for "inline comments" as a number |

### Feed, Detail and Search: no

Reviews as Feed records, like conversation comments, would add about 97 records a day
(678 a week), 3,390 in the 35-day window, on top of 9,206 events (+37%);
with inline comments as records, 7,615 (+83%), which puts the state at
16,800 events, 65% of the 25,800 at which the Feed-index write was measured
at 138 MB against a 128 MB limit (gardening G10). Search would gain 3,390
chunks and vectors on 8,996 (+38%). The embedding cap is not the obstacle
(about 0.16 neurons a chunk on Dev: 540 neurons once, 16 a day, cap 2,500 a
day). The obstacles are the memory headroom, the 11.5 MB `/api/feed` (G22),
and the content: six in ten reviews have no text and four in ten are the
author's replies, so most new Feed records would be empty.

Stored as metadata rows outside the publication, nothing above changes.
Whether review text should become searchable is a separate decision
(decision 2).

### Where it is stored

| Object | Key | Written |
| --- | --- | --- |
| Rows of a month | `internal/github-reviews/v1/<projectId>/<YYYY-MM>.json` (`osskb.github-reviews.v1`: `projectId`, `month`, `rows` ordered by `submittedAt`, then `reviewId`) | when its content changes |
| Cursor | `internal/github-reviews/v1/<projectId>/state.json` (`updatedAt`, `coverageFrom`) | when it moves |
| Run record | `internal/github-reviews/v1/last-run.json` | every run |

Nothing is under `public/`; no Pages Function reads these keys. A month is
the unit Spec 019 plans to read ("up to 12 month objects"). The month
object is a contract Spec 019 will read, so it is listed as decision 4.

## Simplification review

1. **Question every requirement.** Each stored field has an owner in the
   table above. The job itself: Spec 019 decision 7. The flag: the owner's
   rule that a merge changes no behaviour and no cost. `coverageFrom`: the
   profile must say from when reviews are counted.
2. **Delete.**
   - Review and comment text, HTML, diff hunks: not requested at all, so
     they cannot leak into storage or search.
   - Inline comments as rows, file paths: no reader.
   - `authorAssociation`: Spec 019 takes roles from the roster.
   - Pull-request title and labels on the row: the pull request's own
     record carries them; joined by number.
   - `reviewerType`: one boolean is what the reader needs.
   - A Durable Object, an alarm, a migration: the run takes seconds; the
     Worker invocation of the daily tick is enough (ADR-0016 made the same
     choice for the review queue), and a new class would have to be created
     in both environments by the merge itself.
   - A cron of its own: the job rides the publication tick.
   - Follow-up runs after a cut read: the next tick continues; the cap is
     six times the busiest measured day.
   - Review events in the publication state: see "Feed, Detail and Search".
   - A backfill: proposed below, not built.
3. **Simplify.** One listing (the connector's), one batched read, one
   merge keyed by review id. Equal content is equal bytes, so an unchanged
   month is not written.
4. **Shorten the cycle.** Rules are a generated table over recorded
   responses; the run is tested against a fake GitHub in under a second;
   `measure:github-reviews` runs the real job read-only in ten seconds.
5. **Automate last.** Nothing is scheduled beyond the existing tick.

## Behavior

1. **Flag.** `GITHUB_REVIEWS` unset or blank: off. The Worker sends no
   GitHub request and no R2 request for this job, `/health` has no
   `githubReviews` field, and `POST /github-reviews/run` answers 403.
   `metadata@1`: on. Any other value: the review run is recorded as a
   `config` failure and sends nothing to GitHub; the publication is
   scheduled as always.
2. **Cursor.** Per project. A first run lists what GitHub updated in the
   last day; a later run lists from the stored cursor minus 300 s (the
   connector's rule). The first run's start is kept as `coverageFrom`.
3. **Listing and cap.** `GET /repos/{o}/{r}/issues?state=all&sort=updated&direction=asc&since=…`,
   100 a page. Only the number, the update time and whether it is a pull
   request are kept. At most 500 pull requests newer than the cursor are
   read per project per run; those inside the 300 s overlap are read again
   on top and do not count, so a run always moves on. At most 20 pages are
   listed. The cursor moves to the newest item read, never backwards; when
   the read was cut it stops at the last pull request kept, the run is
   `truncated`, and the next run continues from there.
4. **Read.** Reviews are read 25 pull requests per GraphQL request, the
   newest 100 reviews of each. The fields are fixed: author login and type,
   state, time, commit, inline comment count, and the pull request's
   author. A number GitHub cannot resolve is dropped and counted; any other
   GraphQL error fails the project's run.
5. **Rows.** A review becomes a row when it has an id and a submission time
   (a pending review has none), a known state, and was submitted at or
   after the later of `coverageFrom` and 35 days before the run. A pull
   request with more reviews in that window than were read is counted in
   `reviewsTruncated`.
6. **Bots.** `isBot` is true when GitHub's type is `Bot`, or the login ends
   in `[bot]`, or the login is one of the project's machine users
   (`machineUsers` of its review profile). Never a substring of the login.
   A missing author is stored as `ghost`.
7. **Merge.** Rows are keyed by review id within the month they were
   submitted in; reading a review again replaces its row. A month whose
   bytes did not change is not written.
8. **Dismissal.** A review read as `DISMISSED` whose stored row has a
   verdict keeps it as `stateBefore`. A review first seen dismissed has no
   `stateBefore`.
9. **Order of writes.** Month objects, oldest first, each written only if
   it is unchanged since it was read; then the cursor; then the run
   record. A run that stops in between leaves the cursor, and the next run
   reads the same reviews into the same rows.
10. **Isolation.** The job runs in the Worker invocation of the publication
    tick, after the publication is scheduled, and on
    `POST /github-reviews/run[?dryRun=1]` (bearer token). It does not read
    or write the publication's Durable Object state, the Feed, or the
    Search release. A project that fails keeps its cursor and rows and does
    not stop the other project. A dry run writes nothing.
11. **Observability.** While the flag is set, `/health` carries
    `githubReviews`: the last run record, or `null` before the first run.
12. **Validation set.** Kafka's squash-merge messages carry a
    `Reviewers:` trailer written by the committer. `parseReviewersTrailer`
    returns its names (addresses are dropped), and `trailerAgreement`
    compares them with stored rows. It is a measure of agreement, not a
    gate: on the 52 pull requests merged in the week, 69 of 73 trailer
    names are a person with a stored review on that pull request, and 14
    approvers are not named in the trailer.

### What the first run contains

- Contains: every review submitted in the 24 hours before the first run, on
  pull requests updated in those 24 hours (on 2026-10-14: 77 Kafka rows and
  42 DataFusion rows).
- Does not contain: any review submitted earlier, also on a pull request
  that was updated today. `coverageFrom` records the boundary, and a
  profile must not count reviews from before it.
- A review on a pull request older than the cursor is found like any other:
  what matters is that the pull request was updated, which a review does
  (fact 4). 67 of Kafka's 327 reviews of the week were on pull requests
  opened more than 35 days earlier.

### Known limits

1. A dismissal is recorded when the pull request is listed again and the
   review is at most 35 days old. A review dismissed later than that keeps
   its stored verdict.
2. A review edited later changes nothing here: no text is stored.
3. A deleted review keeps its row; GitHub offers no signal.
4. A user who renames their account appears under both logins.
5. A pull request with more than 100 reviews submitted within 35 days is
   read partially and counted in `reviewsTruncated` (none exists today; the
   largest has 28).
6. The trailer comparison needs display names, which the job does not
   fetch; it runs on a recorded fixture.

### Proposed one-time backfill (not built, not run)

Give a first run an explicit start instead of one day, and let that start
replace the 35-day lower bound. Each manual run then reads 500 pull requests,
oldest first, until the cursor reaches today. No review text, the same
requests.

| Back to | Project | Items to list | Pull requests | Listing pages + GraphQL requests | Runs of 500 | Rows (estimate) |
| --- | --- | --- | --- | --- | --- | --- |
| 35 days (2026-09-09) | Kafka | 712 | 712 | 8 + 29 = 37 | 2 | about 1,650 |
| 35 days | DataFusion | 2,951 | 2,334 | 30 + 94 = 124 | 5 | about 1,750 |
| 12 months (2025-10-14) | Kafka | 3,668 | 3,668 | 37 + 147 = 184 | 8 | about 17,000 (3.9 MB) |
| 12 months | DataFusion | 9,032 | 5,841 | 91 + 234 = 325 | 12 | about 18,300 (4.1 MB) |

The whole 12-month backfill is 128 listing requests and 381 GraphQL points,
against 5,000 an hour of each, and about 11 minutes of run time in total.
Counts are GitHub search totals of 2026-10-14; the row estimates extrapolate
the measured week. It belongs with Spec 019 slice 5 and its horizon
decision.

## Test plan

Generated from `packages/reference-pipeline/test/github-reviews.cases.ts` by
`bun run docs:test-plan`; `packages/reference-pipeline/test/github-reviews.test.ts`
runs exactly these rows. "recorded" rows run on
`packages/reference-pipeline/test/fixtures/github-reviews/` (GitHub GraphQL
responses of 2026-10-14: no review text, no address).

<!-- test-plan:start packages/reference-pipeline/test/github-reviews.cases.ts -->
| id | rule | input | expected |
| --- | --- | --- | --- |
| RV1 | flag | constructed: GITHUB_REVIEWS unset | off |
| RV1 | flag | constructed: GITHUB_REVIEWS blank | off |
| RV1 | flag | constructed: GITHUB_REVIEWS metadata@1 | on |
| RV1 | flag | constructed: GITHUB_REVIEWS true | error: not supported |
| RV1 | flag | constructed: GITHUB_REVIEWS metadata@2 | error: not supported |
| RV3 | rows | recorded: kafka #23675 (Copilot twice, the author once, one approval) | 4 rows: copilot-pull-request-reviewer COMMENTED bot 1 inline; lucasbru COMMENTED self 1 inline; copilot-pull-request-reviewer COMMENTED bot 0 inline; bbejeck APPROVED 0 inline |
| RV3 | rows | recorded: kafka #23809 (no review) | 0 rows |
| RV3 | rows | recorded: kafka #23165 (28 reviews) | 28 rows; 28 with a commit; reviewId unique |
| RV3 | rows | recorded: the batch asked for 99999999, which is not a pull request | 3 pull requests parsed; dropped 99999999; cost 1 |
| RV3 | rows | constructed: a batch whose error has no alias path | batch fails: GraphQL error |
| RV3 | rows | constructed: a review node without a state | batch fails: malformed |
| RV3 | rows | constructed: a PENDING review, and a review with no submittedAt | 0 rows |
| RV3 | rows | constructed: a review by a deleted account on a pull request by a deleted account | 1 row: reviewer ghost, prAuthor ghost, not a bot |
| RV6 | dismissed | recorded: datafusion #25716 (one review dismissed) | kosiew DISMISSED 4 inline; no stateBefore |
| RV6 | dismissed | constructed: stored APPROVED, read again as DISMISSED | 1 row DISMISSED, stateBefore APPROVED; changed 1, dismissed 1 |
| RV6 | dismissed | constructed: stored DISMISSED with stateBefore CHANGES_REQUESTED, read again | 1 row DISMISSED, stateBefore CHANGES_REQUESTED; changed 0, dismissed 0 |
| RV6 | dismissed | constructed: first seen already DISMISSED | 1 row DISMISSED, no stateBefore; added 1 |
| RV7 | bot | recorded: copilot-pull-request-reviewer, type Bot, no [bot] suffix | bot |
| RV7 | bot | constructed: github-actions[bot], type User | bot |
| RV7 | bot | constructed: codecov-commenter, type User, in the project's machine users | bot |
| RV7 | bot | constructed: codecov-commenter, type User, not in the machine users | not a bot |
| RV7 | bot | constructed: abbott, type User | not a bot |
| RV5 | merge | constructed: the same 3 reviews read twice | 3 rows; second read added 0, changed 0; bytes equal |
| RV5 | merge | constructed: rows arriving newest first | stored oldest first, ties by review id |
| RV5 | merge | constructed: a stored review read again with 2 more inline comments | 1 row with the new count; changed 1 |
| RV12 | month | constructed: submitted 2026-09-30T23:59:59Z | 2026-09 |
| RV12 | month | constructed: submitted 2026-10-01T00:00:00Z | 2026-10 |
| RV12 | month | constructed: a month object with another project's id | error: malformed |
| RV9 | cap | constructed: 3 pull requests and 2 issues listed, cap 5, no more pages | 3 pull requests; cursor at the newest item (an issue); not truncated |
| RV9 | cap | constructed: 6 pull requests listed, cap 5 | 5 pull requests; cursor at the 5th; truncated |
| RV9 | cap | constructed: 5 pull requests listed, cap 5, more pages | 5 pull requests; cursor at the newest item; truncated |
| RV9 | cap | constructed: 5 pull requests inside the overlap, then 6 newer ones, cap 5 | 10 pull requests; cursor at the 5th newer one; truncated |
| RV9 | cap | constructed: nothing listed | 0 pull requests; cursor unchanged; not truncated |
| RV9 | cap | constructed: only items older than the stored cursor (the overlap) | cursor unchanged |
| RV9 | cap | constructed: the same pull request on two pages | read once |
| RV20 | window | constructed: reviews 1 s before and exactly at the window start | 1 row (the one at the start) |
| RV20 | window | constructed: 150 reviews on one pull request, 100 read, the oldest read inside the window | 100 rows; truncated |
| RV20 | window | constructed: 150 reviews on one pull request, 100 read, the oldest read before the window | not truncated |
| RV10 | no text | constructed: the query for pull requests 1 and 2 | asks for p1 and p2; no body, bodyText, bodyHTML, path or diffHunk field |
| RV10 | no text | recorded: the rows of kafka #23675 | keys: commit, inlineComments, isBot, pr, prAuthor, reviewId, reviewer, state, submittedAt |
| RV11 | trailer | constructed: Reviewers: Ada Lovelace <ada@example.org>, Grace Hopper <grace@example.org> | Ada Lovelace; Grace Hopper |
| RV11 | trailer | constructed: Reviewers: someone bare@example.org, Ada Lovelace | someone; Ada Lovelace |
| RV11 | trailer | constructed: a message with no Reviewers line | none |
| RV11 | trailer | recorded: 52 Kafka pull requests merged 2026-10-07..13 | 51 with a trailer; 73 names; 69 matched; unmatched #23280 Uros (github:uros-b), #23385 Mickael Maison, #23560 YANG-SYUAN CHOU, #23672 Andy Huang; 14 approvers not named |
| RV11 | trailer | recorded: the trailer fixture file | no address |
<!-- test-plan:end -->

Named tests, `apps/data-publisher-worker/test/github-reviews-run.test.ts`:
the job against a fake GitHub (listing and batched GraphQL), an in-memory
bucket and a controlled clock; and the Worker with the flag unset, set, and
set wrongly.

| ID | Scenario | Expected |
| --- | --- | --- |
| RV2 | A publication tick with the flag unset; the same tick with it set | Unset: one call, the publication's; no GitHub request, no bucket request; `/health` byte-identical; the manual route 403. Set: the same publication call, plus the review run |
| RV4 | First run, then a run a day later | `since` is one day back, then cursor minus 300 s; `coverageFrom` stays |
| RV5 | A second run one minute later | The overlap is read again; 0 rows added; neither month nor cursor written |
| RV9 | 12 pull requests, cap 5 | Three runs read 5, 5 and 2 new ones; every review stored |
| RV13 | GraphQL answers 502 twice for one project | That project fails and writes nothing; the other completes; the next run reads the same day |
| RV15 | The cursor write fails after the month write | The next run adds nothing, writes no month, moves the cursor |
| RV16 | Another run writes the month in between | `conflict`; the other run's object stays; the cursor stays |
| RV22 | The busiest measured day; 700 pull requests | 3 listing pages and 7 GraphQL requests; 500 read, 5 pages and 20 GraphQL requests |

## Acceptance

Each item: precondition → action → observable result → evidence.

### Behavior
- RV1: given `GITHUB_REVIEWS` unset, blank, `metadata@1`, `true` or `metadata@2`, resolving it gives off, off, on, error, error → case rows.
- RV2: given the flag unset, a publication tick makes exactly the one call that schedules the publication, no request to GitHub and no request to the bucket; `/health` is byte-identical to its body without this change; `POST /github-reviews/run` answers 403 without running. Positive control: the same tick with the flag set schedules the same publication and also reads GitHub → Worker tests; `publication-parity.test.ts` and its fixtures are unchanged.
- RV3: given the recorded response for Kafka #23675, #23809, #23165 and a number that is not a pull request, parsing gives 4, 0 and 28 rows with reviewer, state, time, commit and inline count, and drops the unknown number without failing; a malformed node or an error without an alias fails the batch; a pending review gives no row → case rows.
- RV4: given no stored cursor, a run lists from one day back with `state=all&sort=updated&direction=asc`, stores `coverageFrom`, and moves the cursor to the newest item listed (also when that is an issue); the next run lists from the cursor minus 300 s → run test.
- RV5: given reviews already stored, reading them again adds no row, changes none, and produces equal bytes, so neither the month nor the cursor is written → case rows and run test.
- RV6: given the recorded DataFusion #25716, its dismissed review is a row in state `DISMISSED`; given a stored `APPROVED` row read again as `DISMISSED`, the row keeps `stateBefore: APPROVED` → case rows and run test.
- RV7: given type `Bot` without a `[bot]` suffix (recorded), a `[bot]` suffix, or a machine user of the project, the row has `isBot: true`; given `abbott`, or a machine user of another project, it has not; both GitHub projects are ingested with their machine users → case rows and Worker test.
- RV8: given a review submitted by the pull request's author, the row has `reviewer` equal to `prAuthor`, and the run counts it under `selfReviews`, bots under `botReviews` → run test.
- RV9: given more new pull requests than the cap, a run reads the cap's worth oldest first, reports `truncated`, and stops the cursor at the last one read; pull requests inside the overlap do not count against the cap; later runs read the rest and no review is lost → case rows and run test.
- RV10: given the query and any run, no field named `body`, `bodyText`, `bodyHTML`, `path` or `diffHunk` is requested; a stored row has exactly the nine keys of the data model (`stateBefore` is the tenth, on a dismissed row only); nothing stored contains a listing item's title or body; every key is under `internal/github-reviews/v1/` → case rows and run test.
- RV11: given the recorded fixture of 52 Kafka pull requests merged 2026-10-07 to 2026-10-13, the trailer comparison reports 51 with a trailer, 73 names, 69 matched, the 4 unmatched by name, and 14 approvers not named; the parser drops bracketed and bare addresses; the fixture contains no address → case rows.
- RV12: given reviews submitted at 2026-09-30T23:59:59Z and 2026-10-01T00:00:00Z, they are stored in the objects of 2026-09 and 2026-10, each ordered by time then id; a month object of another project is refused → case rows and run test.

### Failure and retry
- RV13: given a GraphQL batch that fails twice, that project's run fails as `transport` after one retry, writes no month and no cursor, and the other project completes; the next run reads the same day → run test.
- RV14: given a 401, or a 403 with `Retry-After: 120`, on the listing, the project fails as `auth` or `rate-limit` after one request; given a 429 with `Retry-After: 30`, it waits 30 s once and completes; given a GraphQL `RATE_LIMITED` error, it fails as `rate-limit` → run test.
- RV15: given a run that dies after the month write and before the cursor write, the cursor is unchanged, and the next run adds no row, writes no month, and moves the cursor → run test.
- RV16: given a month object changed by another run between this run's read and write, the write is refused, the run fails as `conflict`, the other run's object and the cursor stay → run test.
- RV17: given an unsupported flag value, the flag missing, or a blank token, the run sends nothing to GitHub, reads nothing, and records a `config` failure; the publication tick still schedules the publication → run and Worker tests.
- RV18: given a malformed stored cursor or month object, the project fails and the stored object is not overwritten → run test.
- RV19: given a dry run, GitHub and the bucket are read and nothing is written → run test.
- RV20: given a first run, a review submitted before its day is not stored even when its pull request was updated today; a review exactly at the window start is; a pull request with 150 reviews of which the 100 read are all inside the window is counted as truncated, and is not when the oldest read is before the window → case rows and run test.

### Budget
- RV21: [measure] requests and time of one run against the live API: 10 requests, GraphQL cost 7, 10.5 s for a day of both projects; 31 requests for a week; 56 for a run cut at the cap (`bun run measure:github-reviews [-- --days N]`, 2026-10-14). Limits: 5,000 REST requests and 5,000 GraphQL points an hour for the token; 20,000 subrequests and 300,000 ms CPU per invocation.
- RV22: given the busiest measured day (70 Kafka pull requests; 85 DataFusion pull requests and 30 issues), a run makes 1 + 3 and 2 + 4 GitHub requests and 4 bucket reads and 5 writes; given 700 new pull requests, a run reads 500 with 5 listing pages and 20 GraphQL requests → run test.
- RV23: [measure] a row is 224 to 226 bytes; a month is about 322 KB (Kafka) and 343 KB (DataFusion), a year about 8 MB for both (`bun run measure:github-reviews -- --days 7`: 74,017 and 78,593 bytes for 329 and 351 rows).

### Observability
- RV24: given a run, `last-run.json` names per project the listing start, the cursor, `coverageFrom`, pull requests listed and read, `truncated`, reviews, bot and author reviews, rows added, changed and dismissed, pull requests dropped, `reviewsTruncated`, month objects read and written, REST and GraphQL requests, GraphQL cost, response size and duration, and never the token; with the flag set `/health` carries it as `githubReviews`, `null` before the first run → run and Worker tests.
- RV25: [deploy] on Dev after the flag is set: a dry run answers 200 with `ok: true` for both projects; the second real run replaces a month object (`monthsWritten` at least 1 or `changed` above 0) with no `failureKind: conflict`; after the first real run `/health` `githubReviews.ok` is true, each project's `restRequests + graphqlRequests` is at most 10 on a normal day, and `lastRun` of the publication of the same tick is `ok` with `r2` within its usual range.

## Budget against the platform limits

| Limit | Source | Today | With the flag on |
| --- | --- | --- | --- |
| GitHub REST, 5,000 requests an hour per user | GitHub; the Worker's `GITHUB_SOURCE_TOKEN` is a fine-grained personal token, and every token of that user shares the limit | publication: 81 pages on 2026-10-13, plus one request per closed pull request (at most 237 that run) | +3 a day (measured); +40 in a run cut at the cap |
| GitHub GraphQL, 5,000 points an hour | GitHub | 0 (the review queue is unscheduled) | +7 a day; +40 at the cap, plus the overlap |
| Worker subrequests, 20,000 per invocation | `limits.subrequests` | publication R2: 8,734 | The review run is its own invocation: 10 GitHub + 9 R2 a day; about 110 at the cap |
| Run duration | Durable Object alarm: 15 minutes (runbook) | publication: its own alarm | The review run is outside the alarm: 10.5 s a day, 70 s at the cap. The Cron invocation's own wall-time limit is not verified |
| Memory, 128 MB (G10) | Durable Object; 138 MB measured at 25,800 events | 9,206 events | Unchanged: no review enters the state. The review run holds one response (listing pages averaged 0.72 MB on the largest run) and one month object (about 0.3 MB) at a time; not measured in the runtime |
| `/api/feed` 11.5 MB (G22) | Pages | 11.5 MB | Unchanged |
| Objects per publication, bound 19,900 (Spec 008) | publisher | 8,340 | Unchanged: review objects are not part of a publication |
| R2 Class A per run | runbook | 391 on 2026-10-13 (about 40 on a quiet day) | +5 a day (2 months, 2 cursors, 1 run record); up to 9 when reviews of three months change. About 150 to 270 a month on top of about 1,200; 1 million included |
| R2 Class B per run | runbook | 8,343 | +4 a day, up to 8; +1 per `/health` request while the flag is set |
| Search chunks, vectors, neurons | Spec 016 | 8,996 chunks, 8,996 vectors, cap 2,500 neurons a day | Unchanged |
| R2 storage | | | +0.67 MB a month, about 8 MB a year |

What grows: two month objects (about 11 KB a day each), 10 GitHub requests
and 9 R2 requests a day, one `/health` field. Nothing in the publication.

## Enabling on Dev

1. Owner approves decisions 1 to 4 below.
2. One PR sets `"GITHUB_REVIEWS": "metadata@1"` in `vars` of
   `apps/data-publisher-worker/wrangler.development.jsonc` and updates the
   `GITHUB_REVIEWS` row of `docs/feature-map.md`. CI deploys Dev on merge.
3. Dry run (reads GitHub, writes nothing):
   `curl -sS -X POST -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" 'https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/github-reviews/run?dryRun=1' | jq`.
   Expect `ok: true`, both projects `ok`, about 4 and 6 requests. A project
   failing as `auth` means the token cannot use GraphQL: stop here.
4. Either wait for 22:07 UTC or repeat the call without `dryRun`.
5. `curl -sS …/health | jq .githubReviews`: `ok: true`; `added` near 80 and
   40; `monthsWritten: 1` per project (RV25).
6. **Check the second real run** (the next tick, or a second manual call
   after new reviews exist). The first run creates each month object; only
   the second replaces one, with a write conditional on the ETag read
   (`store.ts` passes `R2Object.etag` to `onlyIf.etagMatches`). That the
   two formats agree is tested against a fake bucket only. The second run
   must show `monthsWritten` of at least 1 or `changed` above 0 for a
   project with new reviews, and no `failureKind: conflict`. If it reports
   `conflict`, remove the variable and fix the ETag handling first.
7. **Wall time.** A normal run is about 10 s. A run cut at the cap is about
   70 s; whether the Cron invocation's `waitUntil` allows that is not
   verified. Until a capped run has been seen to complete from the Cron
   (`truncated: true` with `ok: true` in `githubReviews`), run anything
   backfill-sized through `POST /github-reviews/run`, which runs while the
   caller waits.
8. To turn off: remove the variable. The stored objects stay and are not
   read by anything.

Prod stays off: its data Worker has never been deployed (Spec 018).

## Decisions needed from owner

| # | Decision | Recommendation | Cost of the alternative |
| --- | --- | --- | --- |
| 1 | Inline review comments: individual rows, grouped per review, or counted | **Counted on the review row** (implemented) | Individual rows with file paths: +3 requests a day, about 131 more rows a day, and the draft-time trap of `/pulls/comments?since=`; worth it only if the profile should show areas by file path |
| 2 | Do reviews enter Feed, Detail and Search | **No: metadata only, no text fetched** (implemented). Searchable review text is a later decision of its own | As Feed records: +37% events and Search chunks (+83% with inline comments), six in ten of them empty, state at 65% of the measured memory limit |
| 3 | Enable on Dev | **Yes, after this PR merges**, by the steps above; Prod stays off | Not enabling blocks Spec 019 slice 2; each day not enabled is a day of reviews a later backfill has to fetch |
| 4 | The month object as the contract Spec 019 reads (`osskb.github-reviews.v1`, the nine fields, keys under `internal/`) | **Accept as proposed**; it is versioned, and Spec 019 slice 2 may ask for a field before anything reads it | Changing it after Spec 019 reads it needs a migration of stored months |
| 5 | Backfill | **Decide with Spec 019's horizon (its decision 4)**; until then coverage starts on the day of the first run | 35 days now: 161 requests, 7 manual runs. 12 months: 509 requests, 20 runs. Needs the small change described above |

## Could not be verified

- That the Dev `GITHUB_SOURCE_TOKEN` may call GraphQL. The measurements used
  another token of the same kind of access (public data). The review-queue
  job would have proven it, but `/health` `reviewQueue` is `null` on Dev.
  Step 3 of the enabling checks it without writing anything.
- That a dismissal always updates the pull request. All three dismissed
  reviews seen had the pull request updated at or after the dismissal, which
  is consistent but not proof.
- The wall-time limit of a Cron invocation's `waitUntil` on this account;
  the run needs 10 s (70 s at the cap). Enabling step 7 covers it.
- That R2 accepts `R2Object.etag` as `onlyIf.etagMatches` for the month
  object's conditional write. Only a fake bucket was used; the first
  replacement of a month object on Dev proves it (enabling step 6).
- Memory of the review run inside the Workers runtime; the figures are
  response and object sizes, not a heap measurement.
- More than 100 reviews on one pull request: none exists in either
  repository's week; the rule is tested on constructed data only.
- "Updated" counts of earlier days are lower bounds.
- The backfill request counts are derived from search totals, not run.
- GitHub's terms for storing reviewer logins: Spec 019 decision 8 covers it;
  this spec stores logins the Feed already stores for authors.

## Non-goals

- The contributor profile, its API and page (Spec 019 slices 2 to 5).
- Review or comment text anywhere; file paths.
- Changing the GitHub connector, its `isBot` rule (gardening G8), or the
  35-day retention of the publication state.
- Scheduling the review queue, or changing its read.
- Prod.
