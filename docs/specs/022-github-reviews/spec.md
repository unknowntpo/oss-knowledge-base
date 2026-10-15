# Spec 022: GitHub pull-request reviews

Status: Slice 1 implemented behind `GITHUB_REVIEWS`; set to `metadata@1` on Dev (decision 3, decided 2026-10-14), unset on Prod. Slice 2 (manual 12-month backfill, decision 5, decided 2026-10-14) implemented. Amendment 2026-10-15 (`metadata@2`: pull-request areas and display names, and the refresh) implemented, off until the flag is set to `metadata@2`
Date: 2026-10-14
Traceability: enforced
Builds on: Spec 004 (GitHub connector), Spec 009 (bounded memory), Spec 015 (review queue, ADR-0016), Spec 018 (daily publication), Spec 019 (contributor profile, decision 7)

> **How to read this.** The owner decided on 2026-10-14 that reviews are
> ingested before the contributor profile is built (Spec 019 decision 7).
> This spec is that ingestion. The code merged switched off: with
> `GITHUB_REVIEWS` unset the Worker sends no extra request and `/health` is
> byte-identical. On 2026-10-14 the owner decided to enable it on Dev
> (decision 3); Prod stays off. The five choices listed in
> [Decisions needed from owner](#decisions-needed-from-owner) were all
> decided by the owner on 2026-10-14 (decision 5: a 12-month backfill).

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
   - A scheduled or automatic backfill: the backfill is a manual route an
     operator calls about a dozen times, once (decision 5).
   - A second listing or a per-pull-request REST read for the backfill: it
     reuses the daily listing, batch read and merge; only the window, the
     cursor it keeps, and the paging differ.
   - Pruning old months: about 8 MB a year; proposed, not built
     (Behavior 14).
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
   100 a page, paged by key: every request is `page=1` with `since` one
   second before the last item received (the repeated second is
   deduplicated; a page entirely inside one second moves to `page=2`).
   Offset pages shift when an item is updated during the listing, and
   GitHub answers 422 past about page 10 of a large listing, which a day
   of more than about 1,000 updated issues would otherwise reach on every
   later run. (GitHub's message points to native `after`/`before` cursors;
   a later option, not used.) Only the number, the update time and whether
   it is a pull request are kept. At most 500 pull requests newer than the cursor are
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
13. **Backfill (slice 2).** `POST /github-reviews/backfill?from=<date>[&dryRun=1]`
    (bearer token; 403 while the flag is unset). `from` is a UTC date or an
    ISO time with a zone, in the past and at most 395 days (about 13 months)
    back; otherwise 400 and nothing is sent. Each call, per project:
    - needs the daily cursor (`state.json`); without it the project fails as
      `config` (the backfill fills in what lies before the daily run's
      `coverageFrom`, so the daily run starts first);
    - keeps its own progress in `<projectId>/backfill.json` (`from`,
      `until`, `cursor`, `completedAt`). `until` is the daily
      `coverageFrom` when the backfill started; the daily cursor's
      `updatedAt` is never written by a backfill;
    - lists what GitHub updated since its cursor (the first call: since
      `from`; later calls: cursor minus 300 s), oldest first, by key like
      the daily run (Behavior 3), so an item updated during the walk cannot
      shift another off a page, and GitHub's refusal of deep offsets (422
      past about page 10, observed 2026-10-14) never applies;
    - reads at most 500 new pull requests (the daily cap), 25 per GraphQL
      request, and stores reviews submitted in [`from`, `until`) into the
      same month objects, merged by `reviewId`, each write conditional on
      the ETag read;
    - when the listing reaches the present (not `truncated`), writes the
      daily cursor with `coverageFrom` set to `from` (conditional on the
      ETag read, `updatedAt` unchanged), then marks its progress complete.
    A call with another `from` while one is in progress fails as `config`
    and names the `from` to use. A call whose `from` is not before the
    daily `coverageFrom` (a finished backfill) sends nothing to GitHub.
    The daily cursor write becomes conditional too, so a daily run racing
    a finishing backfill fails as `conflict` instead of restoring the older
    `coverageFrom`; its next run repairs it. The call's record goes to
    `internal/github-reviews/v1/backfill-last-run.json`, and `/health`
    carries it as `githubReviewsBackfill` while the flag is set.
14. **Retention.** The store keeps every month object; nothing deletes one.
    The 35-day window of Behavior 5 bounds what a *daily* run writes (at
    most three month objects read per project), not what is kept. The
    review store's horizon is at least 13 months: 12 months of backfill
    plus the current month, the horizon Spec 019 is expected to read (the
    owner leans to 12 months there; Spec 019 decision 4 stays open in
    PR #63). Proposed pruning, not built: a later slice may delete month
    objects older than 13 complete months and, in the same call, move
    `coverageFrom` to the first kept month. Until a reader needs it there
    is no reason to: the store grows by about 8 MB a year.

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
   review is at most 35 days old (by the daily run), or when the backfill
   reads it. A review dismissed later than that keeps
   its stored verdict.
2. A review edited later changes nothing here: no text is stored.
3. A deleted review keeps its row; GitHub offers no signal.
4. A user who renames their account appears under both logins.
5. A pull request with more than 100 reviews submitted within 35 days is
   read partially and counted in `reviewsTruncated` (none exists today; the
   largest has 28).
6. The trailer comparison needs display names, which the job does not
   fetch; it runs on a recorded fixture.

### Backfill: what it covers, and its cost

**Covers:** every review submitted in [`from`, `until`) on a pull request
whose latest update is at or after `from`. A review updates its pull
request (fact 4), so a pull request that received a review in the window
was last updated in the window or later, and the ascending listing from
`from` to the present reaches it at its latest position. A pull request
reviewed in May and last updated in May is found in the first calls; one
reviewed in May and updated again today is found in the last call, at
today's position, and its May review is stored then. Walking only part of
the way would miss it, which is why a backfill is complete only when its
listing reaches the present.

**Does not cover:**
- Reviews submitted before `from`, by design. `coverageFrom` says so.
- A review whose pull request's latest update is before `from`. By fact 4
  none can be inside the window; fact 4 is measured (1,804 reviews), not a
  documented GitHub guarantee.
- Reviews beyond the newest 100 of one pull request (`reviewsTruncated`
  counts them; the largest seen had 28).
- The verdict of a review dismissed before it was first read (no
  `stateBefore`), reviews GitHub has deleted, pull requests deleted or
  transferred.
- Reviews at or after `until`: the daily run owns them.

**Measured volume, 12 months** (`from` = 2025-10-14; GitHub search totals of
2026-10-14 by public read; rows from a sample of 20 pull requests per
project last updated mid-window: 93 and 53 reviews in the window):

| | Kafka | DataFusion | Both |
| --- | --- | --- | --- |
| Pull requests updated since `from` | 3,674 | 5,843 | 9,517 |
| Issues in the same listing | 0 | 3,194 | 3,194 |
| Calls of 500 pull requests | 8 | 12 | **12 calls** (each call serves both; Kafka is done after 8) |
| Listing requests (99 new items a keyed page, plus one a call) | about 46 | about 104 | about 150 |
| GraphQL requests, about 1 point each (25 pull requests a request; each call after the first also re-reads every pull request updated in the 300 s before its cursor, usually one or two, at most a listing page: up to 4 more requests a call) | about 155 (bound about 185) | about 246 (bound about 290) | about 400 (bound about 475) |
| Reviews per pull request (sample) | 4.65 | 2.65 | |
| Rows | about 17,100 | about 15,500 (18,300 by the measured week) | about 33,000 |
| Month objects | 13, about 3.8 MB | 13, 3.5 to 4.1 MB | about 8 MB |

Six months (`from` = 2026-04-14) for comparison: 2,214 and 3,586 pull
requests, 1,934 DataFusion issues; 5 and 8 calls.

Per call, per project, at most 500 pull requests: about 8 listing pages and
20 GraphQL requests, about 35 s (the measured 35-day run cut at the cap:
34.8 s and 35.2 s). A call serving both projects takes about 70 s; calls 9
to 12 serve DataFusion only, about 35 s. The whole backfill is about
12 minutes of calls, about 14 with the dry call and the checks.

| Budget | Per call | Whole 12-month backfill | Limit |
| --- | --- | --- | --- |
| GitHub REST (shared with the daily publication: about 81 pages plus at most 237 closed-pull-request reads at 22:07 UTC) | at most about 16 | about 150 | 5,000 an hour |
| GitHub GraphQL points (shared; the review queue is unscheduled) | at most about 42 | about 400 | 5,000 an hour |
| R2 Class A (a refused conditional write counts as one) | per project: the months written (at most 13) and its progress, plus the cursor on the last call; one run record | typical about 120; bound 294 (20 project calls × 14, 2 cursors, 12 records), plus one per conflict | 1 million a month included; Dev publications about 12 thousand |
| R2 Class B | per project: cursor, progress, months read (at most 13) | at most about 300, plus 1 per `/health` request for `githubReviewsBackfill` | 10 million a month included |
| Worker subrequests | at most about 90 | | 20,000 a call |
| Memory | one listing page (about 0.7 MB), the rows of one call (about 2,300 at most, 0.5 MB), one month object (about 0.3 MB) at a time | | 128 MB; not measured in the runtime |

Even all 12 calls inside one hour use about 3% of the REST and 8% of the
GraphQL budget, so the chunk (the daily cap of 500) cannot starve the daily
publication; the binding limit is the call's wall time, which is why the
chunk is not larger. The calls finish before 22:00 UTC or start after 22:30 UTC, so
they do not overlap the daily tick (an overlap is safe, a `conflict` the
next call repairs, but wastes a call).

`bun run measure:github-reviews -- --backfill-from 2025-10-14` runs the
whole backfill read-only against the live API with an in-memory bucket and
prints each call and the totals (RV35). It needs a token with GraphQL
access and was not run for this amendment.

## Amendment 2026-10-15: pull-request areas and display names (`metadata@2`)

Owner, 2026-10-15, on the Dev profile of `m1a2st`: "能有一個圓餅圖顯示他 work
in 的 area 嗎？目前 work in area 好像都沒有資料" (a pie chart of the areas he
works in; Areas shows nothing today), and "能抓 GitHub 的 Avatar 來顯示嗎？這樣
就知道這個帳號對應的是哪個人" (show the GitHub avatar, so one can tell who the
account is). Areas are empty because a review row carries no label (Spec 019
decision 6 takes areas from labels and KIP numbers). This amendment gives the
store what a profile needs for both: each reviewed pull request's label names
and title KIP ids, and each login's public profile name. The chart and the
avatar are Spec 019's (its amendment of the same date); the avatar needs no
stored field.

### Evidence (public reads, 2026-10-15 01:57–01:58 UTC)

Pull requests updated 2026-09-15 to 2026-10-14, by the REST listing
`repos/apache/<repo>/pulls?state=all&sort=updated&direction=desc`:

| | Kafka | DataFusion |
| --- | --- | --- |
| Pull requests | 603 | 2,293 |
| Labels on one pull request: mean, most | 3.26, 20 | 3.14, 17 |
| No label at all / only process labels | 27 / 13 | 24 / 124 |
| Title with `KIP-<n>` (case-sensitive) / other spellings (`kip-1`, `KIP 1`) | 12 / 0 | 0 / 0 |
| `pulls` entry as stored (`"<n>":{"labels":[…],"kips":[…]}`), mean / most | 57.6 / 261 bytes | 62.7 / 237 bytes |

Both repositories set their area labels from changed paths with
`actions/labeler`: Kafka `.github/configs/labeler.yml` (21 labels: `build`,
`clients`, `tests`, `connect`, `mirror-maker-2`, `core`, `storage`, `streams`,
`tools`, `docs`, `generator`, `transactions`, `group-coordinator`, `kip-932`,
`docker`, `performance`, `consumer`, `producer`, `kraft`, `dependencies`,
`tiered-storage`), DataFusion `.github/workflows/labeler/labeler-config.yml`
(18: `development-process`, `documentation`, `sql`, `logical-expr`, `ffi`,
`physical-expr`, `physical-plan`, `catalog`, `common`, `execution`,
`datasource`, `functions`, `optimizer`, `core`, `proto`, `spark`, `substrait`,
`sqllogictest`). The other labels are set by workflows or by hand and describe
the process: Kafka's `triage` (non-committer pull requests) and
`needs-attention`, both removed by `pr-labels-cron.yml` once reviewed,
`ci-approved`, `small` (`label_small.sh`); DataFusion's release labels
(`v55.0.0`, `v56.0.0` on 876 and 872 of the 2,293), `auto detected api change`
(331), `auto-dependencies` (131). Which labels are areas is Spec 019's
taxonomy (its amendment); the store keeps every label name, so changing the
taxonomy needs no refetch.

### Data model: once per pull request per month, not per row

| Option | Bytes for the 12-month store (both projects) | Writes | Reader |
| --- | --- | --- | --- |
| Labels and KIPs on every review row | about 33,000 rows × 58 to 63 bytes, about 2 MB (+25%) | none more | one place, but repeated about 3.5 times per pull request |
| **`pulls` map in each month object (chosen)** | at most 9,517 pull requests × about 61 bytes, about 0.6 MB, plus repeats for pull requests reviewed in two months (+8 to 11% a month) | none more: written with the month it belongs to, under the same conditional write | a month object stays self-contained; the profile reads nothing more (W29's 13 objects) |
| A separate `pulls.json` per project | about 0.6 MB, one object | one more object read and rewritten whole (0.3 to 0.4 MB) every day | one more R2 read per profile; grows without bound |

Names follow the same rule: `people` in each month object, keyed by login, for
the logins of that month's rows that have a public name. About 150 to 250
logins a month per project, about 30 bytes each when named: 3 to 6 KB a month.

```json
{"schema":"osskb.github-reviews.v1","projectId":"apache-kafka","month":"2026-10","rows":[…],
 "pulls":{"23675":{"labels":["ci-approved","streams"],"kips":["KIP-1071"]}},
 "people":{"bbejeck":"Bill Bejeck","lucasbru":"Lucas Brutschy"}}
```

(The `pulls` and `people` values in the example are illustrative of the shape;
the real ones of #23675 are written by the first `metadata@2` run.)

- `pulls[<number>].labels`: every label name of the pull request, sorted,
  unique; at most `LABELS_PER_PULL` (30, against 20 measured) are read, and a
  run counts more in `labelsTruncated`.
- `pulls[<number>].kips`: `KIP-<n>` ids matched in the title, numerically
  sorted; absent when none. The title is requested and dropped; it is never
  stored.
- `people[<login>]`: GitHub's public profile `name` of an account typed
  `User`, with every format character (`\p{Cf}`: soft hyphen, bidi marks and
  overrides, invisible operators, tag characters, zero-width spaces) removed
  except the joiners ZWJ and ZWNJ, control characters and blank-looking
  letters (Hangul fillers U+115F, U+1160, U+3164, U+FFA0; the Braille blank
  U+2800) turned into spaces, whitespace collapsed, cut to 100 grapheme
  clusters (never inside a surrogate pair or an emoji sequence); not stored
  when no grapheme holds a letter or digit (an invisible, blank or
  punctuation-only name), when equal to the login, or when containing `@` (an
  address typed as a name). No email, no id, no other
  profile field. A login read again without a name loses its entry.
- A pull request's entry is in every month that has a row of it; a newer read
  replaces it (its labels may have changed).

### Contract and versioning

The month object keeps `schema: "osskb.github-reviews.v1"` and its key
prefix `internal/github-reviews/v1/`: `pulls` and `people` are additive,
optional fields. Every reader of v1 reads `rows` and ignores other keys
(`parseReviewMonth`, the profile, person search), so old code reads new months
and new code reads old months (RV36). What changes is the writer, named by the
flag: `GITHUB_REVIEWS=metadata@2` writes the two fields; `metadata@1` writes
none and keeps those already stored byte-identical; a reader tells "not yet
filled" from "no labels" by the entry's presence (`{"labels":[]}` is a pull
request without labels). The run records carry the revision they ran under.

### Behavior (amended and added)

- **Behavior 1, amended: flag.** `metadata@1` and `metadata@2` are
   supported; any other value is a `config` failure as before. `metadata@2` is
   everything `metadata@1` does, plus the two items below.
- **Behavior 4, amended: same request.** Under `metadata@2` the batched GraphQL read
   (Behavior 4) also asks for the pull request's `title`,
   `labels(first: 30) { totalCount nodes { name } }`, and `... on User { name }`
   on the pull request's and each review's author. No other request is sent;
   the number of GitHub requests of a run is unchanged.
- **Behavior 7, amended: stored with the month.** A run writes, into each month
   it merges, the entries of the pull requests of the rows it read for that
   month and the names of those rows' logins; the month is written only when
   its bytes changed, under the same conditional write. Under `metadata@1` a
   month's stored `pulls` and `people` are kept as they are.
- **Behavior 15 (new): refresh.** `POST /github-reviews/refresh-areas[?dryRun=1]`
    (bearer token; 403 while the flag is unset; a `config` failure, with
    nothing read, under `metadata@1`). Per project:
    - needs the daily cursor (`state.json`), else `config`;
    - reads every month object from the month of `coverageFrom` to the month
      of the cursor (13 on Dev), oldest first, and collects the pull requests
      of the rows that have no `pulls` entry: this is the whole progress, so
      there is no progress object, and a repeated or interrupted call resumes
      by itself;
    - reads at most 500 of them (the daily cap), oldest month first, 25 per
      GraphQL request with the query of Behavior 4, and writes each month that gained
      entries, rows unchanged, with a write conditional on the ETag read;
    - a number GitHub no longer resolves (deleted, transferred) gets
      `{"labels":[]}` and is counted in `droppedPulls`, so the refresh ends;
    - `done` when, after the call, every month has an entry for every pull
      request of its rows; a later call then reads the months and sends nothing
      to GitHub.
    The record goes to `internal/github-reviews/v1/refresh-last-run.json`:
    `{ok, revision, dryRun, startedAt, completedAt, durationMs, projects{
    <projectId>: {ok, months, monthsComplete, monthsRead, monthsWritten,
    pullsMissing, pullsRead, droppedPulls, labelsTruncated, graphqlRequests,
    graphqlCost, bytes, durationMs, done, failureKind?, error?}}, failureKind?}`;
    `/health` carries it as `githubReviewsRefresh` only under `metadata@2`
    (`null` before the first call; absent under `metadata@1`, so that
    `/health` is unchanged).

### Refresh: volume and cost (12 months on Dev)

The store holds reviews submitted since 2025-10-14 (the backfill). The pull
requests in it are at most those updated since then: 3,674 Kafka and 5,843
DataFusion (Spec 022 Evidence, GitHub search of 2026-10-14); the reviewed ones
are fewer. Not re-measured against Dev's store, which this work may not read:
the first dry call reports the real `pullsMissing`.

| | Per call (both projects) | Whole refresh, worst case | Limit |
| --- | --- | --- | --- |
| Calls | | 12 (DataFusion 5,843 / 500; Kafka done after 8) | |
| GraphQL requests (≈1 point each; the same query as the daily run) | at most 40 | at most 381 | 5,000 points an hour |
| REST requests | 0 | 0 | |
| Wall time | about 70 s (40 requests, as a backfill call) | about 14 minutes | |
| R2 Class B | 2 × (1 cursor + 13 months) = 28 | 336 | 10 million a month |
| R2 Class A | at most 2 × 13 months + 1 record = 27 | at most 324; typically each month written once or twice: about 65 | 1 million a month |
| Memory | pass 1 keeps the parsed month objects of one project that lack entries: 13 objects of about 0.3 MB of JSON each, about 15 to 20 MB as parsed objects (estimate, not measured in the runtime), plus one response at a time | | 128 MB |
| Storage | | +0.6 to 0.8 MB once | |

The daily run under `metadata@2`: the same requests (10 a normal day); each
response grows by about 100 bytes per pull request; GraphQL cost is expected to
stay about 1 point per request (25 more connections of at most 30 nodes; GitHub
counts a request's nodes divided by 100). Not measured here (no GraphQL call
was allowed); RV45 checks it on Dev. R2 is unchanged in count: the months a run
reads and writes are the same, and a month whose only change is a label is
still one of those at most three per project. Worst case a day: 9 Class A and
8 Class B, as before.

### Acceptance (added)

Listed under [Acceptance](#acceptance): RV36–RV45.

### Enabling `metadata@2` on Dev (operator sequence)

Preconditions: PR 1 (this amendment, flag unchanged) merged and deployed;
`/health` `githubReviews.ok` is `true` with `revision` `metadata@1`. Avoid
21:55–22:35 UTC (the 22:07 tick) and 22:45–22:50 UTC (the 22:47 digest): a
call that overlaps the tick is safe (a `conflict` the next call repairs) but
wastes a call.

1. Merge the enable PR: `"GITHUB_REVIEWS": "metadata@2"` in
   `apps/data-publisher-worker/wrangler.development.jsonc`. CI deploys Dev.
   Expect `/health` to show `githubReviewsRefresh: null`, and `githubReviews`
   unchanged (still the last `metadata@1` record).
2. Daily dry run: `POST /github-reviews/run?dryRun=1`. Expect `ok: true`,
   `revision: "metadata@2"`, per project `restRequests + graphqlRequests` as on
   a normal day (at most 10), `graphqlCost` at most 2 per GraphQL request,
   `labelsTruncated: 0`. **Stop** (remove the variable) on `failureKind`
   `schema` or `auth`: the token or the API refused a new field.
3. One real daily run (`POST /github-reviews/run`, or wait for the tick).
   Expect `ok: true`, `revision: "metadata@2"`, no `conflict`.
4. Refresh dry call: `POST /github-reviews/refresh-areas?dryRun=1`. Expect
   `ok: true`; per project `months: 13`, `monthsComplete` 0 to 2,
   `pullsMissing` at most 3,674 (Kafka) and 5,843 (DataFusion), `pullsRead` at
   most 500, `graphqlRequests` at most 20, `monthsWritten: 0`.
5. Refresh calls: repeat `POST /github-reviews/refresh-areas` until both
   projects report `done: true` (expected 8 to 12 calls of about 70 s). After
   each: `ok: true`; `pullsMissing` falls by `pullsRead`; `monthsWritten` at
   least 1 until done. **Stop** on a second `conflict` in a row, on `auth` or
   `rate-limit`, when `labelsTruncated` is above 0 (raise `LABELS_PER_PULL`
   first), when `droppedPulls` is above 10 in one call, or when a call's
   `graphqlCost` is above 60.
6. Done: `/health` `githubReviewsRefresh.projects.*.done` are `true` and
   `monthsComplete` equals `months`; one more call reports `pullsRead: 0` and
   `graphqlRequests: 0`.
7. Spec 019 W55: the profiles of `m1a2st` and `chia7712` show both charts and
   their public names.

Rollback: set `GITHUB_REVIEWS` back to `metadata@1`. The stored fields stay
and are kept by later runs; the refresh route answers `config`; the profile
keeps showing what is stored (Spec 019: hide it with `PEOPLE_PROFILES`).

### Could not be verified (amendment)

- GraphQL cost and acceptance of the new fields with the Dev token: no
  GraphQL request was made for this amendment (RV45 on Dev, step 2).
- The number of pull requests in Dev's store (the R2 store was not read):
  the refresh's call count is a bound from GitHub search totals.
- The `name` of an account that hides it, or an organisation's: GitHub
  returns null or nothing; both store no name.
- That a pull request's labels never change after its last review: a label
  set later is picked up when the pull request is next listed and its review
  is within 35 days; older months keep the labels read at their last refresh.

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
| RV1 | flag | constructed: GITHUB_REVIEWS metadata@2 | on, with areas |
| RV1 | flag | constructed: GITHUB_REVIEWS metadata@3 | error: not supported |
| RV36 | contract | constructed: a metadata@2 month (pulls, people) read by the rows-only parser | 1 row; extra fields ignored |
| RV36 | contract | constructed: a metadata@1 month read by the full parser | 1 row; no pulls; no people |
| RV36 | contract | constructed: pulls keyed by a non-number | error: malformed pulls |
| RV36 | contract | constructed: people with a number as a name | error: malformed people |
| RV37 | area query | constructed: the metadata@2 query for pull request 1 | title; labels(first: 30); User name; no body, bodyText, bodyHTML, path, diffHunk or email |
| RV37 | area query | constructed: the metadata@1 query for pull request 1 | no title, labels or name |
| RV37 | area meta | constructed: title KAFKA-1: x (KIP-1071, KIP-932), labels triage, streams, streams | labels streams, triage; kips KIP-932, KIP-1071 |
| RV37 | area meta | constructed: title kip-12 and KIP 13 and KIP-14a, no labels | labels none; no kips |
| RV38 | display name | constructed: Chia-Ping Tsai for chia7712 | Chia-Ping Tsai |
| RV38 | display name | constructed: a name with a control character, a zero-width space and doubled spaces | Ada Lovelace |
| RV38 | display name | constructed: an address typed as the name | dropped |
| RV38 | display name | constructed: the login typed as the name | dropped |
| RV38 | display name | constructed: 150 characters | 100 characters |
| RV38 | display name | constructed: 99 letters, then an emoji outside the BMP, then more | 100 graphemes; ends with the whole emoji; well-formed |
| RV38 | display name | constructed: a family emoji joined by ZWJ, and a right-to-left override | joiners kept; override removed |
| RV38 | display name | constructed: only format characters (U+00AD, U+200E, U+061C, U+180E, U+2063, a tag character) | dropped |
| RV38 | display name | constructed: Ada padded with U+200F and tag characters | Ada |
| RV38 | display name | constructed: only blank-looking characters (U+3164 Hangul filler, U+2800 Braille blank) | dropped |
| RV38 | display name | constructed: punctuation and symbols only (- . ★) | dropped |
| RV38 | display name | constructed: a soft hyphen inside Love-lace | Lovelace |
| RV38 | display name | constructed: positive controls 李小龍, Zoë 2, 7712 | 李小龍 \| Zoë 2 \| 7712 |
| RV38 | display name | constructed: <script>alert(1)</script> as the name | <script>alert(1)</script> |
| RV38 | display names | constructed: a User author with a name, a User reviewer without, a Bot reviewer with one | grace Grace Hopper; ada null |
| RV39 | merge extras | constructed: stored #1 core, ada Ada; read #1 core, tests and #2 none; ada null, bob Bob | pulls 1 core,tests; 2 none; people bob Bob; again equal bytes |
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
| RV27 | backfill start | constructed: from=2026-04-14, now 2026-10-14T12:00:00Z | 2026-04-14T00:00:00.000Z |
| RV27 | backfill start | constructed: from=2026-04-14T06:30:00Z | 2026-04-14T06:30:00.000Z |
| RV27 | backfill start | constructed: from missing | error: required |
| RV27 | backfill start | constructed: from=14/04/2026 | error: not an ISO date |
| RV27 | backfill start | constructed: from exactly 395 days back (about 13 months) | accepted |
| RV27 | backfill start | constructed: from 395 days and 1 s back | error: before the floor |
| RV27 | backfill start | constructed: from equal to now | error: not in the past |
| RV28 | backfill window | constructed: window 2026-04-14..2026-10-13; reviews 1 s before from, at from, 1 s before until, at until | 2 rows (at from, 1 s before until) |
| RV30 | keyset | constructed: page of 100 ending at 10:30:00 | next since 10:29:59; page 1 |
| RV30 | keyset | constructed: page of 100 all inside 10:29:59..10:30:00, since 10:29:59 | same since; next page |
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
| RV22 | The busiest measured day; 700 pull requests | 3 listing pages and 7 GraphQL requests; 500 read, 6 keyed pages and 20 GraphQL requests |
| RV26 | Both Wrangler files; a Dev tick on an empty bucket | Dev `metadata@1`, Prod unset; each project lists from one day back |
| RV27 | The backfill route: wrong token, flag unset, `from` missing, malformed or too old, a dry call, a real call | 401, 403, 400 with nothing sent, 200 writing nothing, 200 with both projects done |
| RV28 | Six months of history after a first day, cap 5 | Four calls read 5, 6, 6 and 3 pull requests; reviews before `from` and at or after `until` are not stored; `coverageFrom` moves to `from`, `updatedAt` does not |
| RV29 | A daily run between backfill calls and after the last | It lists from its own cursor, does not touch the progress, keeps `coverageFrom` |
| RV30 | 250 pull requests; #1 updated after the first page | All 250 stored; every listing request is `page=1` |
| RV31 | No daily cursor; another `from` in progress; a month or the cursor written meanwhile; the progress write fails | `config` with nothing read; `conflict` and the next call repairs it; the next call adds nothing |
| RV32 | A dry backfill call | Counts reported, nothing written |
| RV33 | 700 pull requests since `from` | One call reads 500 with 6 listing pages and 20 GraphQL requests; R2 5 reads and 5 writes |
| RV34 | A backfill call; `/health` | `backfill-last-run.json` names from, until, cursor, done and counts; `/health` `githubReviewsBackfill` |
| RV36 | `metadata@1` with a stored month holding `pulls` and `people` | No title, label or name requested; both fields kept byte-identical |
| RV37 | `metadata@2` run over two pull requests | Same GraphQL requests as `metadata@1`; `pulls` with sorted labels and title KIPs; no title stored; rows of nine keys |
| RV38 | Names read, then read again after one was cleared | Stored once per login per month; the cleared name removed; an address not stored |
| RV39 | A pull request reviewed in September and October; labels changed later | Its entry in both months; the newer labels replace it in both |
| RV40 | Three months of 20 pull requests, cap 30 | Two calls fill them oldest first; rows byte-identical; a third call sends nothing |
| RV41 | `metadata@1`; no cursor; dry; a month written meanwhile; a deleted pull request | `config` with nothing sent; nothing written; `conflict` then repaired; `{"labels":[]}` |
| RV42 | The refresh route and `/health` | 401, 403, 502 `config` under `metadata@1`; `githubReviewsRefresh` only under `metadata@2` |
| RV43 | 720 pull requests without metadata | 500 read in 20 GraphQL requests; Kafka: 4 R2 reads and 3 month writes; one record |

## Acceptance

Each item: precondition → action → observable result → evidence.

### Behavior
- RV1: given `GITHUB_REVIEWS` unset, blank, `metadata@1`, `true`, `metadata@2` or `metadata@3`, resolving it gives off, off, on, error, on with areas, error (amended 2026-10-15: `metadata@2` was an error before) → case rows.
- RV36: given a `metadata@2` month object, the rows-only parser (`parseReviewMonth`) returns its rows and ignores `pulls` and `people`; given a `metadata@1` month, the full parser returns its rows and no `pulls` or `people`; a malformed `pulls` (a key that is not a number) or `people` (a name that is not a string) fails as malformed; under `metadata@1` the read asks for no title, label or name and a run keeps a month's stored `pulls` and `people` → case rows and run test.
- RV37: under `metadata@2` the query asks for `title`, `labels(first: 30)` and `... on User { name }` and still no body, path, diff hunk or email; a run makes as many GraphQL requests as under `metadata@1`, stores per month each reviewed pull request's sorted unique label names and numerically sorted title KIP ids, never the title, and rows keep exactly their nine keys; `kip-12`, `KIP 13` and `KIP-14a` are no KIP ids → case rows and run test.
- RV38: a public name is kept trimmed, without control characters or format characters other than ZWJ and ZWNJ, blank-looking letters as spaces, at most 100 grapheme clusters; a name with no letter or digit (only format, blank or punctuation characters) is not stored, and padding around a real name is removed; an address, the login itself, and a name of an account not typed `User` are not stored; a login read again without a name loses it; a name with markup is stored as text (the page escapes it) → case rows and run test.
- RV39: entries and names merge by pull request and login, the newer read replacing the older, keys sorted so a repeated merge gives equal bytes; a pull request reviewed in two months has its entry in both, and a later read with other labels replaces it in both → case rows and run test.
- RV40: given months written under `metadata@1`, refresh calls fill them oldest month first, at most the cap of pull requests per call, read each pull request once per call even when it is in several months, change no row byte, and end with every month complete; a further call lists nothing and sends no GraphQL request → run test.
- RV2: given the flag unset, a publication tick makes exactly the one call that schedules the publication, no request to GitHub and no request to the bucket; `/health` is byte-identical to its body without this change; `POST /github-reviews/run` answers 403 without running. Positive control: the same tick with the flag set schedules the same publication and also reads GitHub → Worker tests; `publication-parity.test.ts` and its fixtures are unchanged.
- RV3: given the recorded response for Kafka #23675, #23809, #23165 and a number that is not a pull request, parsing gives 4, 0 and 28 rows with reviewer, state, time, commit and inline count, and drops the unknown number without failing; a malformed node or an error without an alias fails the batch; a pending review gives no row → case rows.
- RV4: given no stored cursor, a run lists from one day back with `state=all&sort=updated&direction=asc`, stores `coverageFrom`, and moves the cursor to the newest item listed (also when that is an issue); the next run lists from the cursor minus 300 s → run test.
- RV5: given reviews already stored, reading them again adds no row, changes none, and produces equal bytes, so neither the month nor the cursor is written → case rows and run test.
- RV6: given the recorded DataFusion #25716, its dismissed review is a row in state `DISMISSED`; given a stored `APPROVED` row read again as `DISMISSED`, the row keeps `stateBefore: APPROVED` → case rows and run test.
- RV7: given type `Bot` without a `[bot]` suffix (recorded), a `[bot]` suffix, or a machine user of the project, the row has `isBot: true`; given `abbott`, or a machine user of another project, it has not; both GitHub projects are ingested with their machine users → case rows and Worker test.
- RV8: given a review submitted by the pull request's author, the row has `reviewer` equal to `prAuthor`, and the run counts it under `selfReviews`, bots under `botReviews` → run test.
- RV9: given more new pull requests than the cap, a run reads the cap's worth oldest first, reports `truncated`, and stops the cursor at the last one read; pull requests inside the overlap do not count against the cap; later runs read the rest and no review is lost; given a day of 1,200 updated issues and 3 pull requests against a GitHub that refuses pages past 10, the run lists by key (`page=1` only), reads the 3 and moves the cursor past them → case rows and run tests.
- RV10: given the query and any run, no field named `body`, `bodyText`, `bodyHTML`, `path` or `diffHunk` is requested; a stored row has exactly the nine keys of the data model (`stateBefore` is the tenth, on a dismissed row only); nothing stored contains a listing item's title or body; every key is under `internal/github-reviews/v1/` → case rows and run test.
- RV11: given the recorded fixture of 52 Kafka pull requests merged 2026-10-07 to 2026-10-13, the trailer comparison reports 51 with a trailer, 73 names, 69 matched, the 4 unmatched by name, and 14 approvers not named; the parser drops bracketed and bare addresses; the fixture contains no address → case rows.
- RV12: given reviews submitted at 2026-09-30T23:59:59Z and 2026-10-01T00:00:00Z, they are stored in the objects of 2026-09 and 2026-10, each ordered by time then id; a month object of another project is refused → case rows and run test.
- RV27: given `from` of `2026-04-14`, `2026-04-14T06:30:00Z`, missing, `14/04/2026`, exactly 395 days back, 395 days and 1 s back, or now, resolving it gives that midnight, that time, required, not an ISO date, accepted, before the floor, not in the past; the route answers 401 without the token, 403 with the flag unset, 400 for a refused `from` with nothing sent to GitHub or the bucket, and otherwise runs one call while the caller waits → case rows and Worker test.
- RV28: given a daily cursor and history since `from`, each backfill call lists from its own cursor (the first from `from`), reads at most the cap's worth of pull requests, and stores only reviews submitted in [`from`, `until`) with `until` the daily `coverageFrom` at the start; a review before `from` is not stored; a May review on a pull request updated again today is; when the listing reaches the present the daily `coverageFrom` becomes `from`, its `updatedAt` is unchanged, and the progress is complete; a further call sends nothing to GitHub → case rows and run test.
- RV29: given a backfill in progress or finished, the daily run lists from its own cursor minus 300 s, never reads or writes the backfill progress, and keeps the `coverageFrom` the backfill set → run test.
- RV30: given an item updated between two listing pages of a backfill call, no item is skipped: each request is `page=1` with `since` one second before the last item received, and a page entirely inside that second moves to the next page instead → case rows and run test.
- RV26: given the Dev configuration, `GITHUB_REVIEWS` is `metadata@1` and the Prod configuration has no `GITHUB_REVIEWS`; given Dev's value and an empty bucket, a publication tick schedules the same publication and each project's run lists from one day before the tick and writes only its first cursor and the run record → Worker test reading both Wrangler files.

### Failure and retry
- RV41: given the flag at `metadata@1`, a refresh call is a `config` failure that sends nothing to GitHub; without a daily cursor the project fails as `config` with nothing read; a dry call reads the bucket and GitHub (the pull requests it would fill) and writes nothing, not even its record; a month written by another run between the refresh's read and write is a `conflict` and the next call completes it; a pull request GitHub no longer resolves is stored as `{"labels":[]}` and counted in `droppedPulls`, so the refresh ends → run tests.
- RV42: the refresh route answers 401 without the bearer token, 403 with the flag unset, 502 with a `config` failure under `metadata@1`; `/health` carries `githubReviewsRefresh` under `metadata@2` (`null` before the first call) and has no such field under `metadata@1` → Worker test.
- RV31: given no daily cursor, or a backfill from another date in progress, the project fails as `config`, reads nothing from GitHub and writes nothing; given a month object or the daily cursor written by another run between the backfill's read and its write, the project fails as `conflict`, its progress stays, `coverageFrom` is not moved, and the next call completes; given a daily run whose cursor a finishing backfill rewrote meanwhile, the daily run fails as `conflict` and leaves `coverageFrom` as the backfill set it; given a call that dies after its month writes, the next call repeats the chunk and adds nothing → run tests.
- RV32: given a dry backfill call, GitHub and the bucket are read, the counts are reported, and nothing is written, not even the run record or the progress → run test.
- RV13: given a GraphQL batch that fails twice, that project's run fails as `transport` after one retry, writes no month and no cursor, and the other project completes; the next run reads the same day → run test.
- RV14: given a 401, or a 403 with `Retry-After: 120`, on the listing, the project fails as `auth` or `rate-limit` after one request; given a 429 with `Retry-After: 30`, it waits 30 s once and completes; given a GraphQL `RATE_LIMITED` error, it fails as `rate-limit` → run test.
- RV15: given a run that dies after the month write and before the cursor write, the cursor is unchanged, and the next run adds no row, writes no month, and moves the cursor → run test.
- RV16: given a month object changed by another run between this run's read and write, the write is refused, the run fails as `conflict`, the other run's object and the cursor stay → run test.
- RV17: given an unsupported flag value, the flag missing, or a blank token, the run sends nothing to GitHub, reads nothing, and records a `config` failure; the publication tick still schedules the publication → run and Worker tests.
- RV18: given a malformed stored cursor or month object, the project fails and the stored object is not overwritten → run test.
- RV19: given a dry run, GitHub and the bucket are read and nothing is written → run test.
- RV20: given a first run, a review submitted before its day is not stored even when its pull request was updated today; a review exactly at the window start is; a pull request with 150 reviews of which the 100 read are all inside the window is counted as truncated, and is not when the oldest read is before the window; the daily run writes no review older than 35 days, which bounds its writes and not the store: month objects older than that, written by a backfill, are kept byte-identical by later daily runs, and nothing deletes a month object (Behavior 14) → case rows and run test.

### Budget
- RV33: given 700 pull requests updated since `from`, one call reads 500 of them with 6 keyed listing pages and 20 GraphQL requests, reads 5 and writes 5 R2 objects (Kafka: cursor, progress, one month read; month and progress written; DataFusion, with nothing to read, completes: cursor and progress read, cursor and progress written; the run record) → run test.
- RV35: [measure] the 12-month backfill (`from` 2025-10-14): 3,674 Kafka and 5,843 DataFusion pull requests and 3,194 DataFusion issues to list (GitHub search, 2026-10-14), 12 calls, about 150 listing and 400 GraphQL requests, about 33,000 rows in 26 month objects of about 8 MB; `bun run measure:github-reviews -- --backfill-from 2025-10-14` measures it read-only (not yet run).
- RV21: [measure] requests and time of one run against the live API: 10 requests, GraphQL cost 7, 10.5 s for a day of both projects; 31 requests for a week; 56 for a run cut at the cap (`bun run measure:github-reviews [-- --days N]`, 2026-10-14). Limits: 5,000 REST requests and 5,000 GraphQL points an hour for the token; 20,000 subrequests and 300,000 ms CPU per invocation.
- RV22: given the busiest measured day (70 Kafka pull requests; 85 DataFusion pull requests and 30 issues), a run makes 1 + 3 and 2 + 4 GitHub requests and 4 bucket reads and 5 writes; given 700 new pull requests, a run reads 500 with 6 keyed listing pages (99 new items a page) and 20 GraphQL requests → run test.
- RV23: [measure] a row is 224 to 226 bytes; a month is about 322 KB (Kafka) and 343 KB (DataFusion), a year about 8 MB for both (`bun run measure:github-reviews -- --days 7`: 74,017 and 78,593 bytes for 329 and 351 rows).

- RV43: given 720 Kafka pull requests without metadata in three months, one refresh call reads 500 in 20 GraphQL requests (batches of 25 across months), reads the cursor and 3 months per project and writes the 3 months it filled plus one record → run test.
- RV44: [measure] a `pulls` entry is about 58 (Kafka) and 63 (DataFusion) bytes, most 261; label names per pull request 3.26 and 3.14 on average, 20 at most (2026-10-15, 603 and 2,293 pull requests); `bun run measure:github-reviews -- --revision metadata@2 --days 7` reports the bytes `pulls` and `people` add to real month objects (needs a token; not run for this amendment).

### Observability
- RV45: [deploy] on Dev after `metadata@2` is set (operator sequence above): the dry daily run is `ok` with `revision: "metadata@2"`, the same number of requests as under `metadata@1`, `graphqlCost` at most 2 per GraphQL request and `labelsTruncated: 0`; the refresh finishes with `done: true` for both projects and no `conflict` left; `/health` `githubReviewsRefresh` shows it.
- RV34: given a backfill call, `backfill-last-run.json` holds `{ok, revision, dryRun, from, startedAt, completedAt, durationMs, projects}` and per project the run fields of RV24 plus `from`, `until` and `done`, never the token, and the daily `last-run.json` is not replaced; with the flag set `/health` carries it as `githubReviewsBackfill` (`null` before the first call), and with the flag unset neither field is present → run and Worker tests.
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
| R2 Class B per run | runbook | 8,343 | +4 a day, up to 8; +2 per `/health` request while the flag is set (`githubReviews` and `githubReviewsBackfill`) |
| Search chunks, vectors, neurons | Spec 016 | 8,996 chunks, 8,996 vectors, cap 2,500 neurons a day | Unchanged |
| R2 storage | | | +0.67 MB a month, about 8 MB a year; the 12-month backfill adds about 8 MB once |
| Backfill (manual, once) | Behavior 13 | | 12 calls, about 150 REST and 400 GraphQL requests, about 120 Class A (bound 294); see "Backfill: what it covers, and its cost" |

What grows: two month objects (about 11 KB a day each), 10 GitHub requests
and 9 R2 requests a day, one `/health` field. Nothing in the publication.

## Enabling on Dev

1. Decisions 1 to 5 below: decided by the owner on 2026-10-14.
2. One PR sets `"GITHUB_REVIEWS": "metadata@1"` in `vars` of
   `apps/data-publisher-worker/wrangler.development.jsonc` and updates the
   `GITHUB_REVIEWS` row of `docs/feature-map.md`. CI deploys Dev on merge.
   Merged alone it changes only this: the next 22:07 UTC tick is a first
   run, which reads the day before the tick and stores `coverageFrom` one
   day back (RV26). Nothing older is read until a backfill is run by hand.
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
8. **Backfill (decision 5: 12 months).** Only after step 6 passed (the
   backfill replaces month objects with the same conditional write). Steps
   and stop conditions: runbook, "GitHub review ingestion (Spec 022)",
   "Backfill". About 12 calls of `POST /github-reviews/backfill?from=2025-10-14`;
   done when `/health` `githubReviewsBackfill.projects.*.done` are true and
   the next daily run reports `coverageFrom` `2025-10-14T00:00:00.000Z`.
9. To turn off: remove the variable. The stored objects stay and are not
   read by anything.

Prod stays off: its data Worker has never been deployed (Spec 018).

## Decisions needed from owner

| # | Decision | Recommendation | Cost of the alternative |
| --- | --- | --- | --- |
| 1 | Inline review comments: individual rows, grouped per review, or counted | **Decided 2026-10-14 (owner): counted on the review row** (implemented) | Individual rows with file paths: +3 requests a day, about 131 more rows a day, and the draft-time trap of `/pulls/comments?since=`; worth it only if the profile should show areas by file path |
| 2 | Do reviews enter Feed, Detail and Search | **Decided 2026-10-14 (owner): no, metadata only, no text fetched** (implemented). Searchable review text is a later decision of its own | As Feed records: +37% events and Search chunks (+83% with inline comments), six in ten of them empty, state at 65% of the measured memory limit |
| 3 | Enable on Dev | **Decided 2026-10-14: yes**, by the steps above; Prod stays off | Not enabling blocks Spec 019 slice 2; each day not enabled is a day of reviews a later backfill has to fetch |
| 4 | The month object as the contract Spec 019 reads (`osskb.github-reviews.v1`, the nine fields, keys under `internal/`) | **Decided 2026-10-14 (owner): accepted as proposed**; it is versioned, and Spec 019 slice 2 may ask for a field before anything reads it | Changing it after Spec 019 reads it needs a migration of stored months |
| 5 | Backfill | **Decided 2026-10-14: 12 months** (2025-10-14 onwards), by the manual route of Behavior 13; the store keeps at least 13 months (Behavior 14). The owner leans to a 12-month horizon for Spec 019 too; that decision stays in PR #63 | 6 months: 5 and 8 calls. Re-measured 12 months: 12 calls, about 550 requests (the earlier 509 counted offset pages and no re-read at each cursor) |

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
- The backfill request counts are derived from search totals and a sample
  of 20 pull requests per project, not run (RV35 has the command). The row
  estimate for DataFusion differs by 15% between the sample and the
  measured week.
- That a Worker request held open about 70 s (a backfill call serving both
  projects) completes on this account; Workers documents no wall-time limit
  while the client stays connected. A call cut short loses nothing: the
  progress moves only after its months are written, and the next call
  repeats the chunk.
- GitHub's 422 for deep offset pages was seen past about page 10 of a
  12-month listing (page 10 answered, page 15 refused); the exact limit is
  not documented. Both the daily run and the backfill page by key
  (Behavior 3), so neither reaches it; a fake GitHub that refuses pages
  past 10 tests a day of 1,203 listed items (RV9).
- GitHub's terms for storing reviewer logins: Spec 019 decision 8 covers it;
  this spec stores logins the Feed already stores for authors.

## Non-goals

- The contributor profile, its API and page (Spec 019 slices 2 to 5).
- Review or comment text anywhere; file paths.
- Changing the GitHub connector, its `isBot` rule (gardening G8), or the
  35-day retention of the publication state (`compactState`); the review
  store is outside it.
- Pruning review months (Behavior 14 proposes it; not built).
- Scheduling the review queue, or changing its read.
- Prod.
