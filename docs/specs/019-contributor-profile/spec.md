# Spec 019: Contributor profile

Status: Accepted 2026-10-14 (all nine owner decisions recorded); amended 2026-10-15 (slice 2 split into 2a and 2b, decision 10); slice 1 is Spec 022 (live on Dev, 12 months backfilled); slice 2a implemented; slices 2b–7 not implemented
Date: 2026-10-13 (decisions recorded 2026-10-14; amendment and decision 10 2026-10-15)
Traceability: enforced
Builds on: Spec 004 (GitHub connector), Spec 008 (content-addressed objects), Spec 009 (bounded memory), Spec 012 (dev@ and Jira), Spec 014 (digest profiles), Spec 015 (governance profile and ASF roster), Spec 016/017 (search, "exact matches first"), Spec 018 (daily publication)

> **How to read this spec.** Sections 1–3 are the intent, the real-data
> Example, and the data-range estimate. The owner decided all nine open
> questions on 2026-10-14; they are in [Decisions made](#decisions-made).
> Slice 1 (review ingestion) is Spec 022, live on Dev with 12 months of
> reviews. The [amendment of 2026-10-15](#amendment-2026-10-15-the-first-profile-ships-from-reviews)
> splits slice 2: **2a** ships the profile page from the review store with
> per-source coverage stated on the page; **2b** adds the activity log. Items
> of later slices stay `[pending]`.

## Intent

A person's name leads to one page that shows **what that person has done in
a community, where, and when, with a link to every piece of evidence**.

The owner's words (2026-10-09, 2026-10-13): search a person's name, see their
contribution trajectory (fields, PRs across a time interval) on a personal
panel; "要能精確了解每個 contributor 的貢獻軌跡".

Three likely uses. The owner decided which are in scope (decision 1,
2026-10-14):

| # | Use | What it needs most | Decided 2026-10-14 |
| --- | --- | --- | --- |
| U1 | Know a person before asking them for a review, or before reviewing their PR: what do they work on, what did they touch recently | Areas, recent threads, review activity | In scope |
| U2 | Track my own road to committer: is my activity broad and steady, who reviews me, whom do I review | A long time axis (a year or more), reviews given and received | In scope |
| U3 | Find who is active in an area | A list of people per area | Deferred: "most active in an area" is a ranking (see Non-goals) |

"Precise" (精確) is the governing word. This spec reads it as three rules:

1. A number on the page has one stated definition and one stated period, and
   links to the records it counts.
2. Two identities are shown as one person only when a declared source says
   so. Two unlinked identities are better than one wrong merge.
3. What the data cannot show is said on the page, not left blank.

### Non-goals

- No score, grade, rank, percentile, leaderboard, or comparison between
  people. No "top contributors". Decision 10 (2026-10-15) allows one
  exception, in slice 7: a per-project list the reader sorts by one metric
  column at a time; it has no composite score and no rank number.
- No judgement words: no "inactive", "declining", "low", "slow".
- No inferred attributes: employer, location, time zone, working hours,
  seniority. No sentiment or "tone" analysis.
- No email address stored or shown.
- No model call in v1. An LLM-written summary of a person is explicitly out
  of scope; it would need its own spec and its own privacy review.
- No longer searchable text window. This spec does not change what Search
  indexes (see [The data range](#the-data-range-quantified)).

## Evidence

Captured 2026-10-13 from the Dev release `2026-10-13T10-07-01-000Z`
(`/api/feed`, 268 `/api/detail/:id` reads, `/health`) and from upstream count
queries. All reads were anonymous, sequential GETs.

1. **The release already holds a person on every record.** `SourceRecordView`
   has `author`, `role`, `kind`, `occurredAt`; `FeedIndexEntry.authors[]` lists
   a thread's distinct authors. There is no person key beyond a bare string.
2. **The release holds 35 days, per record.** 8,834 records in 4,116 threads:

   | Project | Source | Threads | Records |
   | --- | --- | --- | --- |
   | kafka | GitHub | 701 | 1,434 |
   | kafka | Jira | 404 | 568 |
   | kafka | dev@ | 64 | 246 |
   | datafusion | GitHub | 2,947 | 6,586 |

   Earliest `lastActivityAt` in the release: 2026-09-08 (35 days before the
   release).
3. **Reviews are not ingested.** The GitHub connector reads issues, PRs and
   issue-thread comments only. For `chia7712`, Dev shows comments on 46 pull
   requests; GitHub search returns 168 pull requests `reviewed-by:chia7712`
   updated since 2026-09-08. A profile built from today's data would
   under-state a reviewer by a factor of about 3.6.
4. **The same string is rarely shared across sources.** In the Kafka release:
   232 GitHub logins, 179 Jira display names, 70 mail From names. 37 strings
   occur in both Jira and mail. 3 strings occur on GitHub and also in Jira or
   mail. So almost nobody is one identity without a link.
5. **The ASF roster carries an ASF id and a name, nothing else.** The Spec 015
   sample (`docs/specs/015-review-queue/samples/asf-roster-kafka.json`,
   2026-10-08): 73 committers, 44 PMC members. 34 of the 73 names occur as an
   author string in the release. 14 ASF ids happen to equal a GitHub login
   seen in the release (`chia7712`, `dajac`, `mjsax`, …); others do not
   (`schofielaj` is "Andrew Schofield", whose GitHub login is
   `AndrewJSchofield`).

## Example

Three real contributors, built **only** from records in the release above.
"Window" = 2026-09-08 to 2026-10-13. Each identity is shown separately,
because nothing in today's data links them (see
[Identity](#identity-resolution)).

Read every number with these two caveats, both properties of today's data:

- A thread's root record (PR, Jira issue) carries the time of its **last
  update**, not of its creation. "Pull requests 18" means "18 pull requests by
  this author that were updated in the window".
- GitHub reviews (approve, request changes, inline review comments) are
  absent. "Comments" are conversation-tab comments only.

### A. `chia7712` / "Chia-Ping Tsai": committer and PMC member

Owner's addition (2026-10-13): this example is required, and it is the worked
case for identity resolution.

**Identities seen**

| Source | Identity string in the release | Role label in the release | Threads | Records |
| --- | --- | --- | --- | --- |
| GitHub | `chia7712` | "Apache member" (GitHub `author_association`) | 46 | 57 |
| Jira | "Chia-Ping Tsai" | Reporter, Commenter | 77 | 84 |
| dev@ | "Chia-Ping Tsai" | dev@ participant | 13 | 21 |
| ASF roster (Spec 015 sample) | id `chia7712`, name "Chia-Ping Tsai" | committer, pmc | n/a | n/a |

**Counts by source and kind**

| Source | Kind | Count | Upstream check |
| --- | --- | --- | --- |
| GitHub | Pull requests authored (updated in window) | 0 | GitHub search `author:chia7712 updated:>=2026-09-08`: 0. Agrees |
| GitHub | Comments on other people's pull requests | 57, on 46 PRs by 34 authors | `commenter:chia7712`: 181 PRs; `reviewed-by:chia7712`: 168 PRs. **Dev sees about a quarter** |
| GitHub | Reviews (approve / changes requested) | not ingested | 168 PRs reviewed upstream |
| Jira | Issues reported (updated in window) | 71 | JQL `reporter = chia7712 AND updated >= -35d`: 112; `created >= -35d`: 70. Dev holds fewer; not investigated |
| Jira | Comments | 13 (7 on his own issues) | not checked |
| dev@ | Messages | 21 in 13 threads | not checked |
| dev@ | `[DISCUSS]` threads joined | 6 (9 messages): KIP-1153, KIP-1342, KIP-1349, "Apache Kafka 4.5.0 release", "Base image for system test dependencies", "Tightening time-based releases" | |
| dev@ | `[VOTE]` threads joined | 6 (7 messages): 4.3.2 RC0, RC1, RC3; 4.4.0 RC1, RC3, RC4 | |
| dev@ | Votes with a declared "(binding)" marker in the stored excerpt | 2: `+1 (binding)` on 4.4.0 RC4 (2026-10-08) and 4.3.2 RC3 (2026-10-12) | Release votes bind PMC members (Spec 015 `asfPreset`); the roster lists him as `pmc`. Agrees. His messages in 4.3.2 RC0 and RC1 report verification but the 200-character excerpt ends before any vote line |

What the data says, against the expectation "a committer who mostly reviews
and votes": he authored no pull request in the window, commented on 46, cast
two binding release votes, and **reported 71 Jira issues**. Most records are
Jira issues he opened, not reviews. The review work, his largest activity
upstream, is the part Dev does not hold.

**Areas** (GitHub labels of the 46 pull requests he commented on; process
labels `ci-approved` 29, `small` 26, `triage` 7, `needs-attention` 5 left
out): `streams` 9, `clients` 9, `build` 8, `core` 7, `group-coordinator` 6,
`storage` 5, `tests` 5, `connect` 5, `dependencies` 5, `docker` 4. Jira and
dev@ carry no area field today (Jira tags are the status only).

**By week** (records; week starts Monday)

| Week of | GitHub | Jira | dev@ |
| --- | --- | --- | --- |
| 2026-09-07 | 15 | 15 | 0 |
| 2026-09-14 | 10 | 15 | 4 |
| 2026-09-21 | 10 | 14 | 4 |
| 2026-09-28 | 10 | 23 | 7 |
| 2026-10-05 | 11 | 12 | 5 |
| 2026-10-12 (2 days) | 1 | 5 | 1 |

**Most recent threads**: KAFKA-PR-23661 (2026-10-12), KAFKA-PR-22593,
KAFKA-PR-23716, KAFKA-PR-22353 (2026-10-11); KAFKA-21019, KAFKA-21235,
KAFKA-21134 (2026-10-12); KAFKA-MAIL-e07e6b7f "[VOTE] 4.3.2 RC3"
(2026-10-12).

**Works with** (threads shared in the window; not a ranking of people):

| Relation | People (shared threads) |
| --- | --- |
| Commented on pull requests by | `harmadasg` 4, `gabriellefu` 3, `m1a2st` 3, `jim0987795064` 3, `Russole` 2, `adikou` 2, `mimaison` 2, and 27 others once (`unknowntpo` among them) |
| Who commented on his pull requests | none: no pull request of his is in the window |
| Same dev@ threads | Bill Bejeck 5, David Jacot 4, Andrew Schofield 3, Muralidhar Basani 3, Jakub Scholz 3 |
| Same Jira issues | Matthias J. Sax 3, Mickael Maison 2 |

### B. `m1a2st`: frequent pull-request author

| Source | Kind | Count | Upstream check |
| --- | --- | --- | --- |
| GitHub | Pull requests authored (updated in window) | 18 | `author:m1a2st updated:>=2026-09-08`: 18. Agrees |
| GitHub | Comments on his own pull requests | 6 | |
| GitHub | Comments on other people's pull requests | 19, on 16 PRs by 11 authors | `reviewed-by:m1a2st`: 77 PRs. Dev sees about a fifth |
| Jira, dev@ | under the string `m1a2st` | 0 | The release may hold him under another name; nothing declares it, so it is not shown |

Identity: GitHub login `m1a2st`, role label "Apache member", 34 threads, 43
records. Areas (labels of the 34 threads): `clients` 11, `core` 10,
`consumer` 6, `storage` 5, `tests` 5, `group-coordinator` 5, `connect` 3,
`build` 3. By week: 21, 3, 4, 4, 7, 4 (the first week is inflated: older pull
requests re-stamped by a later update). Works with: commented on pull
requests by `dajac` 4, `nileshkumar3` 2, `mimaison` 2; commenters on his pull
requests: `chia7712` 3, `lianetm` 1 (a bot, 3, left out). Most recent:
KAFKA-PR-23665, KAFKA-PR-23264, KAFKA-PR-21005 (2026-10-12).

### C. "Andrew Schofield": active mainly on dev@

| Source | Identity | Kind | Count |
| --- | --- | --- | --- |
| dev@ | "Andrew Schofield" | Messages | 23 in 11 threads |
| dev@ | | `[DISCUSS]` threads joined | 4 (15 messages): KIP-1368 (10 messages), KIP-1371, "Apache Kafka 4.5.0 release", "Tightening time-based releases" |
| dev@ | | `[VOTE]` threads joined | 4: KIP-1349, KIP-1368, KIP-1279, 4.2.2 RC1 |
| dev@ | | Votes with a declared "(binding)" marker in the stored excerpt | 2: KIP-1349 (2026-10-01), KIP-1279 (2026-09-15). KIP votes bind committers; the roster lists `schofielaj` "Andrew Schofield" as committer. Agrees |
| Jira | "Andrew Schofield" | Issues reported (updated in window) / comments | 4 / 4 |
| GitHub | `AndrewJSchofield` (**unlinked**: a different string, no declared link) | Pull requests authored / comments on own / on others' | 9 / 3 / 3 (upstream `author:` 9, agrees; `reviewed-by:` 37) |

By week (dev@ / Jira): 1/1, 3/0, 9/2, 7/3, 2/1, 1/1. Same dev@ threads:
Apoorv Mittal 4, Lianet Magrans 4, Chia-Ping Tsai 3. Areas: none from dev@ or
Jira; KIP numbers from subjects (KIP-1368 ×2, KIP-1349, KIP-1279, KIP-1371,
KIP-1306). The unlinked GitHub identity's labels: `clients` 11, `consumer` 7,
`KIP-932` 3.

A purer dev@-only case also exists: "Jakub Scholz", 5 messages, all in
release `[VOTE]` threads, non-binding. Five records is the whole profile:
that is how thin 35 days is.

### What cannot be shown from today's data

| Wanted | State today | What it would take |
| --- | --- | --- |
| Reviews given and received (approve, request changes, inline comments) | Not ingested. The review-queue job (Spec 015) reads `latestReviews` for open PRs but keeps only a count | New ingestion: review events as metadata (who, which PR, state, when). Decided 2026-10-14: this comes first, as Spec 022 (slice 1) |
| A trajectory longer than 35 days | Records older than 35 days are deleted from the pipeline state | An activity log with a longer horizon (section below) |
| When a PR or Jira issue was created | Root records carry the last-update time | Keep `createdAt` (already on `GitHubEventDataV1`; Jira `created` is fetched but not kept) |
| One person across GitHub, Jira and dev@ | No link exists; GitHub numeric id, Jira account key and mail address are not kept | Identity rule and declared links (section below) |
| Areas for Jira and dev@ | Jira `components`, `labels`, `assignee`, `fixVersions` are not requested. Mail has only KIP and KAFKA keys parsed from the subject | One more Jira field; or the digest's title rules |
| Areas by changed file path | Changed files are never fetched | One request per PR; not proposed |
| Merged pull requests per person | `mergedAt` is on the event but not on `SourceRecordView` | Carry it into the activity log |
| Who merged a PR, `Reviewers:` trailers of commits | Commits are not ingested | Not proposed for v1 |
| Non-binding vs binding for unmarked votes | Works for dev@ names through the roster (Spec 015 `tallyVote`); mail excerpts are 200 characters, so a vote line further down a message is missed here | Reuse Spec 015's full-body read for `[VOTE]` threads |
| DataFusion beyond GitHub | No mail or Jira source is configured for DataFusion | Out of scope |

Record ids used are listed in
[Appendix: records behind the Example](#appendix-records-behind-the-example).

## The data range, quantified

**Conclusion.** "30 days" is a fetch window for Kafka dev@ and Jira; what the
site actually holds is the last **35 days per record**, and older records are
deleted from the pipeline. Growing the searchable window to a year breaks
three limits and is not needed: a profile needs only metadata. Recommended:
keep Search at 35 days and add an **append-only activity log (metadata only)**
with a 12-month horizon, about 9 MB a year for both projects.

### What "30 days" refers to, and whether old data is pruned

| Number | Where | What it does |
| --- | --- | --- |
| `WINDOW_DAYS = 30` | `packages/reference-pipeline/src/kafka-rules.ts` (`mailWindow`, `jiraWindow`, `windowStart`) | Kafka dev@ and Jira only. First poll asks Pony Mail for 30 days and Jira for issues **updated** in 30 days; later polls ask for the gap. A mail message, or a Jira comment, older than 30 days is dropped when parsed. The Jira issue itself is always kept |
| `activityWindowDays: 30` | `packages/reference-pipeline/src/config.ts` | Only which events count toward a thread's activity score ("22 dev@ messages in the last 30 days") |
| `initialLookbackDays = 1` | `apps/github-publisher/github-connector.ts` | GitHub has **no** historical backfill: the first poll reads one day, later polls read from the cursor. `MAX_ISSUES_PER_SOURCE = 200` (also for Jira) caps one poll; follow-up runs drain a backlog |
| 35 days | `compactState` in `apps/data-publisher-worker/src/pipeline.ts` | **The retention rule.** After each publication the state keeps, per record, only its latest version, and only if its source time is within 35 days (plus the parents of kept children). Everything else is deleted from the Durable Object |

Definitive answers:

- **Is old data pruned? Yes, from the data the site serves.** A release is
  rebuilt from the state, so a comment disappears from Feed, Detail and
  Search 35 days after it was written, even when its thread is still active.
  A thread disappears 35 days after its last update. Vectors of vanished
  chunks are deleted from Vectorize (`deleteByIds`, at most 2,000 a run).
- **Is anything kept forever? Yes, but not readable as history.** R2 objects
  are never deleted (Spec 008 and Spec 013 non-goals): old releases, pooled
  detail objects and publication evidence accumulate. No code reads them as a
  time series, and they exist only since Dev started publishing.

### What a longer searchable window would cost

Upstream counts on 2026-10-13 (threads updated in the window):

| Window | Kafka PRs | DataFusion PRs + issues | KAFKA Jira issues | dev@ emails (all / kept after dropping notification mail) |
| --- | --- | --- | --- | --- |
| 35 days | 710 | 2,953 | 570 | about 620 / 246 |
| 90 days | 1,397 | 3,899 | 1,038 | 1,371 / about 540 |
| 1 year | 3,661 | 9,041 | 2,352 | 6,828 / about 2,700 |
| All time | 23,778 | 25,929 | 19,982 | not counted |

dev@ emails with "KIP" in the subject, all time: about 34,500 (per year:
2015 1,477; 2016 2,834; 2017 4,871; 2018 4,307; 2019 3,716; 2020 3,411; 2021
2,030; 2022 2,087; 2023 2,388; 2024 3,124; 2025 2,194; last 365 days 2,558).

Model: records = threads updated in the window + comments (linear in time
from today's 4,536 comments in 35 days) + kept mail. It reproduces today
within 2 % (9,015 against 8,834). One chunk per record (8,834 chunks, 8,834
records). R2 objects checked per run = 2 per thread + shards (8,246 today).
Unit costs: Spec 016 Results, Spec 008, the runbook.

| Window | Threads | Records = chunks | R2 objects checked per run | Class B a month (daily runs; 10 M included) | Vectorize stored dimensions (10 M included) | Vectorize $ a month | One-time embedding $ | Shards | First limit hit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 35 days (today) | 4,116 | 8,834 | 8,246 | 0.25 M | 9.0 M | 0 | 0.016 (done) | 10, 18 MB | none; `/api/feed` is already 11.5 MB (G22) |
| 90 days | 6,500 | 18,500 | 13,000 | 0.39 M | 18.9 M | 0.005 | 0.033 | 19, 34 MB | `/api/feed` about 24 MB (G22). The query budget of Spec 016 H67 holds only up to 17,828 chunks. Feed-index write about 100 MB of the 128 MB Durable Object limit (G10: 138 MB at 25,800 events) |
| 1 year | 15,700 | 65,000 | 31,500 | 0.95 M | 66.6 M | 0.03 | 0.12 | 65, 118 MB | **Breaks.** Feed-index write (G10) at 2.5 times the event count that already exceeds 128 MB. Per-run object checks pass the 19,900-object bound of Spec 008 (G59). A search request parses 65 shards (19 shards = 28.8 MB measured). Embedding backfill takes about 4 days under the 2,500-neuron daily cap |
| Today + every KIP thread, all time | about 6,800 (estimate: 2 threads per KIP) | about 43,300 | about 13,700 | 0.41 M | 44.4 M | 0.02 | 0.06 more | 44, 80 MB | Same as 1 year except object checks: G10, shard parse, H67 |

Money is not the constraint: every option costs cents a month. **Memory and
payload size are.** The order in which limits break as the window grows:

1. `/api/feed` payload (G22), already a listed defect at 35 days.
2. The Vectorize query budget of H67 (17,828 chunks), at about 85 days.
3. The Feed-index write in the Durable Object (G10), at about 4 months.
4. One R2 request per existing object per run (G59): 19,900 objects is
   about 9,950 threads, at about 6 months.
5. The search request's shard parse in a Pages Function grows with the shard
   count; it is measured only up to 19 shards (28.8 MB, 100 to 165 ms).

A longer window also needs a backfill that does not exist: about 13,000
GitHub threads for a year, each with its comments, against a 5,000-request
hourly limit; Pony Mail's response cap (4 MiB) forces monthly windows.

### What a profile needs instead

| Need | Search | Contributor profile |
| --- | --- | --- |
| Text and excerpt | yes | no |
| Embedding | yes | no |
| Who, when, what kind, which thread, thread title, area labels | as a by-product | **this is all of it** |
| Horizon | recent | long |

Options:

| Option | Horizon for profiles | New storage | Limits touched | Verdict |
| --- | --- | --- | --- | --- |
| A. Use the release as it is | 35 days | none | none | Too thin: the Example above is everything a page could show |
| **B. Activity log, metadata only, 12 months** | 12 months, growing daily; optional one-time backfill | about 9 MB a year raw (about 2 MB compressed) | none: the log is not in the Feed index, the shards, or Vectorize | **Recommended** |
| C. Activity log, all time for KIP threads | B, plus about 34,500 mail rows since 2015 | about 4 MB more | none | Reasonable later slice; needs a Pony Mail backfill of 11 years |
| D. Searchable window of 1 year | 1 year | 118 MB shards, 66.6 M dimensions | G10, G22, G59, H67, shard parse | Rejected for this feature |

Size of option B. One row per event: time, source, kind, thread id, thread
title reference, identity key, record id, state (merged, approved), area
labels by reference: about 110 bytes of JSON. A year for both projects is
about 65,000 rows today, about 85,000 with review events: **about 9 MB raw**.
(Since 2026-10-14 review events are not part of this log: Spec 022 stores
them in its own month objects, estimated at about 8 MB a year for both
projects, and the profile reads those.)
Stored as one object per project per month (DataFusion about 450 KB, Kafka
about 200 KB a month). A past month never changes; only the current month is
rewritten, once a day: 2 Class A operations a day. A profile request reads 12
month objects (about 5 MB parsed, against 28.8 MB parsed by a search request
today).

The log must be written **before** `compactState` deletes the events, and it
starts empty: without a backfill a profile shows 35 days on day one and gains
a day per day.

## Identity resolution

**Conclusion.** Link two identities only when a declared source links them.
Never link by similarity. Otherwise keep them apart and say so. The
per-community profile names the sources; the core has no Kafka or ASF rule.

### What each source gives

| Source | Stable key upstream | Display | Kept by the pipeline today |
| --- | --- | --- | --- |
| GitHub | numeric user id; login (can be renamed) | login | login only (`GitHubUser` is `{login}`) |
| ASF Jira | account `key` / `name` | `displayName` (user-editable, not unique) | `displayName` only |
| dev@ (Pony Mail) | address (obfuscated by Pony Mail's JSON) | From name | From name only; `mailAuthor` strips the address. A bare address becomes "unknown sender" (4 threads in the release) |
| ASF roster (Whimsy LDAP JSON, Spec 015) | ASF id | name | id, name, roles (`RosterEntry`); kept in an internal R2 object, only a count is public |

The domain contract already declares `ContributorV1` and `SourceIdentityV1`
(`packages/domain/src/v1/contracts.ts`); the pipeline never fills them. This
spec fills them rather than adding a parallel type.

### The rule

1. **Within one source**, the stable key is the identity: GitHub numeric id
   (login as display), Jira account key (display name as display), dev@ From
   name normalized with the existing `nameKey` (NFC, trimmed, case-folded).
2. **Across sources**, two identities become one person only through a
   **declared link**, and each link records its basis and a URL:
   - `roster`: the community's roster adapter publishes the pair. The ASF
     adapter publishes ASF id ↔ name. A dev@ name that equals a roster name
     exactly is linked to that ASF id: the rule Spec 015 already uses to call
     a vote binding (`matchesRosterName`), applied only when the roster name
     is unique in the roster.
   - `declared`: an entry in the community profile's reviewed link list
     (`identityLinks`: two identity keys, the evidence URL, the date, who
     reviewed it). Evidence must be a public statement by the person or the
     project, for example the project's committers page.
3. **Everything else stays separate.** When two unlinked identities have the
   same normalized display name, each page says "An identity with the same
   name exists on <source>: possibly the same person" with a link. Counts are
   never added together across unlinked identities.
4. **No fuzzy matching**, no matching on an ASF id that equals a login, no
   matching on email local parts, no transliteration.
5. A link can be removed; the next publication splits the profile again.
   Profiles are derived, never the source of truth.

### Worked example: `chia7712`

| Pair | Linked by today's data? | Basis |
| --- | --- | --- |
| dev@ "Chia-Ping Tsai" ↔ ASF `chia7712` (committer, pmc) | **Yes** | `roster`: exact name, unique in the 73-entry roster. Already used for binding votes |
| Jira "Chia-Ping Tsai" ↔ dev@ "Chia-Ping Tsai" | **No** (shown as "possibly the same person") | Same string only. A Jira display name is user-editable and not unique. Upstream the Jira account name is `chia7712` (the JQL `reporter = chia7712` returns 1,097 issues), but the pipeline keeps only the display name, and no checked document says a Jira account name equals an ASF id |
| GitHub `chia7712` ↔ ASF `chia7712` | **No** | The strings are equal by coincidence of choice, not by declaration: `schofielaj` ↔ `AndrewJSchofield` shows the two namespaces differ. ASF LDAP is said to hold a self-declared GitHub username per committer; whether a public endpoint exposes it was **not checked** |
| GitHub `chia7712` ↔ dev@ / Jira "Chia-Ping Tsai" | **No** | No shared field at all |

So under the strict rule, with no link list yet, `chia7712` is two profiles
(dev@ + ASF roster; GitHub) and one unlinked Jira identity. One `declared`
entry per pair, written once by the owner with a URL, makes it one profile.
That is the intended cost of precision.

### How precision is measured

- A labelled sample, committed as a case file: every pair the rule links for
  the 73 roster members (expected: all correct), 50 "possibly the same
  person" pairs, and 50 random cross-source pairs with equal or near-equal
  names. Each row is labelled same / different / unknown by the owner from
  public evidence.
- Gate: **zero** pairs labelled "different" are linked. With 50 negative
  pairs and zero errors the true error rate can still be up to about 6 % (95 %
  bound); the page therefore always shows each link's basis.
- Recall (how many true pairs stay unlinked) is reported, not gated.

### What the per-community profile supplies

A `PeopleProfile` next to the existing search, digest and review profiles:
which sources carry identities and how each key is derived; the roster
adapter (reused from `Governance.roster`, or none: DataFusion has none
configured); `identityLinks`; the bot list (`codecov-commenter` has 674
threads in DataFusion, `github-actions[bot]`); the area rule (which labels are
areas, which are process labels); the suppression list (section Privacy).

## Product shape

**Conclusion.** One new page per identity at `/#/<project>/people/<id>`, one
small API, one publish-time job. No model calls. Search shows a person result
first when the query is exactly an identity.

### Route and entry points

- `/#/<project>/people/<id>`. `<id>` is the person id when links exist
  (`asf:chia7712`), otherwise the source identity (`github:chia7712`,
  `jira:<key>`, `mail:<8 hex of the name key>`), URL-encoded. It sits beside
  `/#/<project>/topic/<topicKey>` in `apps/web/src/routes.ts`.
- Every author name on a thread card, Detail record, and search hit becomes a
  link to that page.
- **Search.** When the whole query equals an identity's key or display name
  (case-insensitive, NFC), the first result is a person result linking to the
  page, above thread results. This follows "exact matches first" (adopted
  2026-10-13, PR #61) and does not change thread ranking. A partial name
  ("chia") produces no person result in v1.
- No people directory and no tab in v1 (a directory needs an order, and any
  order but alphabetical is a ranking).

### Sections of the page, in order

| # | Section | Why it exists |
| --- | --- | --- |
| 1 | Header: display name, "Activity in <community>", the period covered ("2026-09-08 to 2026-10-13, 35 days of data"), release time | Says at once what the page is and how far the data goes (U1, U2) |
| 2 | Identities: one row per identity with its source, link to the upstream profile, role from the roster ("committer, PMC, per ASF roster of <date>"), and **the basis of each link**; then "possibly the same person" hints | Rule 2 of precision; the reader can check every merge |
| 3 | Activity: a table of counts by source and kind for the selected period (all, 12 months, 90 days), each count a link to the list in section 6 filtered to it | The trajectory in numbers, each with its evidence (U1, U2) |
| 4 | Over time: one row per month (per week under 90 days), columns by source; plain bars or digits | "PRs across a time interval" in the owner's request (U2) |
| 5 | Areas: label → number of threads, process labels excluded; KIPs joined | "field" in the owner's request (U1) |
| 6 | Threads: newest first, kind, title, the person's part in it ("author", "commented 3 times", "+1 (binding)"), date; paged | The evidence itself |
| 7 | Works with: people who share threads, by relation ("commented on pull requests by", "commented on their pull requests", "same dev@ threads"), with the count of shared threads | Who reviews them, whom they review (U1, U2) |
| 8 | How this is computed: sources, period, what is not counted (anything before the log began; reviews submitted before review ingestion began, with that date), how to report a wrong link or ask for removal | Rule 3 of precision; guardrail |

### Publish time, request time

| When | What |
| --- | --- |
| Publish (daily, in the publication Durable Object, before `compactState`) | Append the run's new events to the current month's activity object per project (a row is replaced when its record id repeats, so a retry is idempotent). Rebuild the identity index per project: key, display, sources, link basis, first and last month seen. **Review activity is not written here**: Spec 022's job already stores it (`internal/github-reviews/v1/<projectId>/<YYYY-MM>.json`, schema `osskb.github-reviews.v1`), and this slice only reads it; the identity index takes reviewers from those objects too |
| Request | `/api/people/:project/:id`: read the identity index, up to 12 activity month objects, and the Spec 022 review month objects of the same months (up to 12 more); filter to the identity (or the linked identities), aggregate, return. Review rows with `isBot`, or with `reviewer` equal to `prAuthor` (the author answering a review thread), are not counted as reviews given; reviews are counted from Spec 022's `coverageFrom` only, read from `internal/github-reviews/v1/<projectId>/state.json` (one more read per project). `cache-control` as other API routes (R7). No Durable Object, no Vectorize, no AI binding |
| Never | Model calls. Per-person precomputed objects (rejected: thousands of small objects, each one more R2 request per run under G59) |

### Wireframes

Desktop (≥ 960 px):

```
+----------------------------------------------------------------------------+
| Kafka   This week | Proposals | All threads            [ search         ]  |
+----------------------------------------------------------------------------+
| Chia-Ping Tsai                                                             |
| Activity in Apache Kafka · 2026-09-08 to 2026-10-13 (35 days of data)      |
|                                                                            |
| IDENTITIES                                                                 |
|  dev@    Chia-Ping Tsai   committer, PMC (ASF roster, 2026-10-08)          |
|          linked to ASF id chia7712: same name in the roster                |
|  Possibly the same person: GitHub chia7712 · Jira "Chia-Ping Tsai"         |
|                                                                            |
| ACTIVITY   [ all ] [ 12 months ] [ 90 days ]                               |
|  dev@    Messages                 21   in 13 threads                       |
|          [DISCUSS] threads         6                                       |
|          [VOTE] threads            6   2 votes marked binding              |
|                                                                            |
| OVER TIME                         | AREAS                                  |
|  Week of 09-07   0                |  none from dev@ (KIP-1153, KIP-1342,   |
|  Week of 09-14   4  ####          |  KIP-1349)                             |
|  Week of 09-21   4  ####          |                                        |
|  Week of 09-28   7  #######       | WORKS WITH                             |
|  Week of 10-05   5  #####         |  Same dev@ threads                     |
|                                   |   Bill Bejeck 5 · David Jacot 4        |
| THREADS                                                                    |
|  10-12  [VOTE] 4.3.2 RC3                         +1 (binding)        dev@  |
|  10-08  [VOTE] 4.4.0 RC4                         +1 (binding)        dev@  |
|  10-08  [DISCUSS] Base image for system test…    2 messages          dev@  |
|  …                                                          [ older ]      |
|                                                                            |
| How this is computed · Report a wrong link · Ask for removal               |
+----------------------------------------------------------------------------+
```

Phone (375 px): one column, same order; tables become two-line rows.

```
+-----------------------------------+
| Kafka                  [ search ] |
+-----------------------------------+
| Chia-Ping Tsai                    |
| Activity in Apache Kafka          |
| 09-08 to 10-13 · 35 days of data  |
|                                   |
| IDENTITIES                        |
| dev@  Chia-Ping Tsai              |
|  committer, PMC (ASF roster)      |
|  linked: same name in the roster  |
| Possibly the same person:         |
|  GitHub chia7712                  |
|  Jira "Chia-Ping Tsai"            |
|                                   |
| ACTIVITY  [all][12 mo][90 d]      |
| dev@ messages                 21  |
| [DISCUSS] threads              6  |
| [VOTE] threads                 6  |
|  2 votes marked binding           |
|                                   |
| OVER TIME                         |
| 09-14  ####     4                 |
| 09-21  ####     4                 |
| 09-28  #######  7                 |
|                                   |
| AREAS · WORKS WITH · THREADS      |
| (stacked, same content)           |
|                                   |
| How this is computed              |
| Report a wrong link               |
+-----------------------------------+
```

## Privacy and ethics

**Conclusion.** Everything shown is already public upstream, but putting one
person's public traces on one page changes what they are. The page must read
as a record with sources, not as an assessment. The guardrails below are
the defaults; decisions 2, 3, 8 and 9 (2026-10-14) confirmed P-c, P-e, P-g,
P-h, P-i and P-j.

| # | Guardrail | Proposed default |
| --- | --- | --- |
| P-a | No scores, ranks, percentiles, or comparisons | Hard rule; a test fails on the words (W13). Decision 10: the slice 7 list may be sorted by one reader-chosen metric column; never by a composite |
| P-b | Counts with context | Every count states its period and definition and links to the records |
| P-c | No email addresses | None stored, none shown. Today's pipeline already drops them; an acceptance item keeps it so. No hash of an address either: a hash of a guessable address is reversible |
| P-d | "How this is computed" on every page | Sources, period, what is missing, the basis of every identity link |
| P-e | Removal and correction | A person (or anyone, for a wrong link) opens an issue in this repository or writes to the owner. Suppression is honoured at the next daily publication: the identity gets no page and no person result, and is left out of "Works with". Threads keep showing the author as upstream does. The suppression list stores a salted hash of the identity key, not the name |
| P-f | No inactivity shaming | Say "Data covers … to …" and "Most recent activity in this data: <date>". Never "inactive", "last seen", "gone" |
| P-g | Dev only | Decided (3): Dev only, not on Prod. Going beyond Dev needs the terms check of decision 8 first |
| P-h | Not indexable | `/api/people/*` answers with `X-Robots-Tag: noindex`; pages are hash routes, which crawlers do not treat as separate pages |
| P-i | Bots are not people | Identities on the profile's bot list get no page |
| P-j | Scope of people | Decided (2): everyone who appears, bots excluded |
| P-k | No derived attributes | No employer, location, time zone, hours-of-day chart |

Terms and law: **not checked yet.** This spec does not read, and so does not
cite, the GitHub Terms of Service or Acceptable Use Policies (their rules on
using API data about users), the ASF privacy policy, the Pony Mail archive
terms, or data-protection law (the GDPR applies to public personal data too).
Decision 8 (2026-10-14): they must be checked before anything goes beyond
Dev. Until then the feature exists on Dev only.

## Simplification review

1. **Question every requirement.**

   | Item | Who needs it | Kept? |
   | --- | --- | --- |
   | Counts by source and kind | U1, U2 | yes |
   | Time series | U2 (owner's "across a time interval") | yes |
   | Areas | U1 (owner's "field") | yes, from stored labels only |
   | Threads list | precision rule 1 (evidence) | yes |
   | Works with | U1, U2 | yes, as shared-thread counts |
   | Identity links | precision rule 2 | yes, strict |
   | 12-month horizon | U2 | yes (owner decides the horizon) |
   | People directory, "active in area" lists | U3 | **deleted** from v1 |
   | LLM summary of a person | nobody asked | **deleted** |
   | Per-person precomputed objects | performance guess | **deleted**; request-time aggregation over month objects |
   | Charts library | nobody | **deleted**; rows of digits and plain bars |
   | Partial-name people search, autocomplete | convenience | **deleted** from v1 |
   | Changed-file-path areas | finer "field" | **deleted**; one request per PR for a marginal gain over labels |
   | Longer searchable text window | not needed for profiles | **deleted** (option D) |
   | Email-based identity matching | recall | **deleted**; privacy and precision both lose |
   | Cross-project profile (one person in Kafka and DataFusion) | nobody yet | **deleted**; the page is per project |

2. **Delete what upstream already gives.** GitHub's own profile and search
   already answer "what did this login do on GitHub". This page earns its
   place only by joining dev@, Jira and GitHub with honest identity. If the
   owner's main use turns out to be GitHub-only, a saved GitHub search is the
   simpler product, and this spec should be dropped.
3. **Simplify.** One row shape for all sources; one object per project per
   month; one API route; reuse `ContributorV1`, `nameKey`, the roster adapter.
4. **Shorten the verification cycle.** The aggregation is a pure function
   over activity rows, tested from a case file; the three Example profiles
   become its first rows, with the upstream counts above as the oracle.
5. **Automate last.** The link list is written by hand at first. No job
   proposes links.

## Behavior

1. An activity row is written for every human-authored record the pipeline
   ingests (issues, pull requests, conversation comments, Jira, dev@): time,
   source, kind, thread id, record id, identity key, state, area labels. No
   text, no excerpt, no address. **Reviews are the exception: they are not
   copied into the activity log.** The profile reads them from the month
   objects Spec 022 writes (`osskb.github-reviews.v1`: `reviewId`, `pr`,
   `prAuthor`, `reviewer`, `isBot`, `state`, `stateBefore`, `submittedAt`,
   `commit`, `inlineComments`). One store per kind of fact; this spec adds no
   second store for reviews and does not change Spec 022's format without
   changing that spec.
2. Rows live in one object per project per month. A row is keyed by record
   id: writing it again replaces it. Past months are not rewritten except by
   an explicit backfill.
3. Rows are appended before the state is compacted. The horizon is 12
   months for all activity (decision 4), set in the community profile;
   months beyond it are not read (and may
   be deleted by a later, separately approved, spec).
4. Root records keep both creation time and last-update time; counts use
   creation time for "authored" and event time for everything else.
5. Identities and links follow the rule in
   [Identity resolution](#identity-resolution). Counts are summed only across
   linked identities.
6. Areas are the thread's labels minus the profile's process labels, plus KIP
   numbers from titles. A source without labels shows "no area data from
   <source>".
7. The page shows the sections in the stated order, the period covered, and
   the "how this is computed" note. An identity with no rows in the period
   says so; it is not an error.
8. A query that equals an identity key or display name exactly yields one
   person result first. Bots and suppressed identities never do.
9. No response under `/api/people` contains an email address, a score, or a
   list of people ordered by activity (the "Works with" lists are grouped by
   relation and capped at 10 names each).

## Amendment 2026-10-15: the first profile ships from reviews

Owner's goal (2026-10-15): "We want to see each contributor's own profile as
soon as possible." Sorting contributors within a project is an add-on after
the profile (decision 10).

### Slice 2 is split

| Slice | Content | Why in this order |
| --- | --- | --- |
| 2a | `/api/people/:project/:id` and `/#/<project>/people/<id>` read only the Spec 022 review store, which already holds 12 months on Dev. The page has sections 1–8 with what reviews give; every other source of the community is listed as "not recorded yet". GitHub author names in Detail link to the page, on Dev only. No publisher change | Visible as soon as Pages deploys; nothing waits for a publication run |
| 2b | The activity log (Behavior 1–4): the publication appends rows before `compactState`, and the profile reads them beside the reviews. Jira and dev@ identities get pages | The first append writes every record the state holds, which is the whole 35 days, so 2b shows 35 days from its first run |

**Why 2a does not read the current release's 35 days.** Per-record author,
source and kind exist only in the 4,116 Detail objects (one R2 read each) or
inside the search shards (about 18 MB for both projects, a format owned by
Search with three schema versions). The feed index's thread-level `authors[]`
cannot tell a Jira name from a dev@ name in a thread that groups both, which
breaks strict identity (rule 2). Each option is code written against another
spec's format, to be deleted by 2b, for a gain of at most one day (2b's first
daily run). Rejected.

**Why the activity log does not ship in 2a.** It changes the publication
Durable Object (append before `compactState`, failure isolation W9, memory
W19, `/health` W22), whose last changes needed full-scale rehearsals (Spec
009, Spec 018). Keeping it in its own PR keeps 2a a Pages-only change that
can ship today, and keeps 2b's verdict and rollback small.

### Coverage is stated per source (W27)

The header names every source of the community with its coverage:

- Reviews: from the later of Spec 022's `coverageFrom` and the first day of
  the 12-month view, to the review cursor (`state.json` `updatedAt`), e.g.
  "Reviews: 2025-11-01 to 2026-10-14".
- A source without a store yet: "Comments, pull requests, Jira, dev@: not
  recorded yet" (Kafka; DataFusion: "Comments, pull requests: not recorded
  yet"). No count is shown for it, not even 0.

When 2b lands, the same line says from when each of those sources is recorded.

### Example (2a): what three real profiles show

Read 2026-10-15 from GitHub (GraphQL search `reviewed-by:` / `author:` on
`apache/kafka`, reviews submitted since 2025-11-01, the author's own reviews
and bots left out, deduplicated by review id). This is the upstream oracle
that W23 compares Dev against after deployment; the R2 review store itself
was not read for this spec.

Coverage line on each of the three Kafka pages: "Reviews: 2025-11-01 to
<review cursor> · Comments, pull requests, Jira, dev@: not recorded yet".

| Profile | Reviews given | By state (approved / commented / changes requested), inline comments | Reviews received on own PRs | Reviewed PRs by (shared PRs, first of 10) | Reviewed by (shared PRs) |
| --- | --- | --- | --- | --- | --- |
| `github:chia7712` | 2,248 reviews on 994 PRs | 779 / 1,469 / 0; 2,005 inline | 11 reviews on 7 PRs from 6 reviewers | m1a2st 70, majialoong 60, mingyen066 51, FrankYang0529 46, mimaison 42 | junrao 4, FrankYang0529 2, m1a2st 2, clolov 1, frankvicky 1, nileshkumar3 1 |
| `github:m1a2st` | 341 on 272 PRs | 213 / 127 / 1; 182 inline | 381 on 86 PRs from 28 reviewers | majialoong 27, dino2895 14, harmadasg 12, mingyen066 12, mimaison 11 | chia7712 70, FrankYang0529 12, junrao 9, frankvicky 7, AndrewJSchofield 5 |
| `github:AndrewJSchofield` | 449 on 277 PRs | 255 / 77 / 117; 349 inline | 202 on 65 PRs from 31 reviewers | apoorvmittal10 42, smjn 42, lianetm 21, sjhajharia 10, chirag-wadhwa5 9 | chia7712 30, apoorvmittal10 26, lianetm 15, ShivsundarR 6, nileshkumar3 4 |

Over time (reviews given by `chia7712` per month): 2025-11 219, 2025-12 188,
2026-01 157, 2026-02 145, 2026-03 243, 2026-04 182, 2026-05 227, 2026-06 129,
2026-07 193, 2026-08 210, 2026-09 278, 2026-10 (to the 15th) 83.

What is partial, and the page says so:

- `chia7712`'s 2026-10-13 Example (comments on 46 PRs, 71 Jira issues, 21
  dev@ messages) is not on his 2a page: those sources are "not recorded yet".
  His 2a page is review work only, which upstream is his largest activity
  (994 PRs reviewed, 7 authored since 2025-11-01).
- "Andrew Schofield" (dev@, Jira) has no page in 2a; mail and Jira identities
  come with 2b. `AndrewJSchofield` (GitHub) has one. They stay separate until
  a declared link exists (slice 4).
- Areas: "No area data from reviews": review rows carry no labels; labels
  arrive with 2b.
- Reviews from 2025-10-14 to 2025-10-31 are stored but fall outside the
  12-month view (W26).
- "Pull requests authored" is not shown in 2a: a PR author appears in the
  review store only when someone reviewed the PR.

Heaviest reviewer in DataFusion, used for the budget (W18): `alamb`, 1,639
reviews on 1,083 PRs since 2025-11-01 (930 approved, 689 commented, 15
changes requested, 5 dismissed).

### Reading the store at request time (W18, W29)

- A request reads `state.json` and the month objects of the 12-month view
  that are not older than `coverageFrom`'s month: at most 13 R2 Class B reads
  per project when the isolate is cold.
- Each month object is parsed once per isolate into a per-identity index
  (reviews given, reviews received) and kept for 10 minutes; a warm request
  reads nothing from R2. The store changes once a day (Spec 022's daily job),
  so a profile is at most 10 minutes behind it, plus the HTTP cache
  (`public, max-age=300, stale-while-revalidate=600` on a 200).
- The per-identity, per-month index is the shape slice 7's month summary
  stores, so the list never parses review rows per request (decision 10).

### Decision 10 (owner, 2026-10-15): per-project contributor list, sortable by separate columns

Decided as proposed. It **revises decision 1**: U3 ("who is active in a
community") comes into scope in this form only; a single score or rank stays
out of scope.

- One page per project, Dev only (the gate of W25), `noindex`, bots and
  suppressed identities excluded.
- One row per identity with **separate metric columns**: reviews given
  (pull requests reviewed), pull requests authored, pull requests merged,
  comments, Jira (issues and comments), dev@ messages, last active. A column
  whose source is not recorded yet says "not recorded", never 0.
- The reader picks the window (12 months, 90 days, 30 days) and the one
  column to sort by; ties by name. No composite score, no rank number, no
  "top" wording.
- Slice 7, after 2b: most columns need the activity log; "reviews given" and
  "last active (reviews)" exist today.

**Data cost.** The list needs counters for everyone, so it must not parse 12
months of rows per request. The publisher writes, next to each month object
it changes, a month summary `internal/people/v1/<projectId>/<YYYY-MM>.summary.json`:
per identity, that month's counters plus the pull-request numbers behind
"reviews given", "authored" and "merged" (so distinct counts across months
stay exact), and the last activity time. It is built by the same
per-identity index function that 2a uses at request time
(`indexReviewMonth`). Estimate, to be measured in slice 7: about 440–600
identities a month, 120 bytes each plus 4 bytes per PR number, about 60–100
KB per project per month. A list request then reads at most 12 summaries
plus `state.json` per project (under about 1.2 MB parsed), against about 2.7
MB of Kafka review months and an estimated 2.4–5.4 MB of activity months.
Writes: one more Class A put per changed month, at most 2 per project a day
(about 120 a month against 1 M included). Open for slice 7: the 90- and
30-day windows cut through a month, so either the two edge months keep
per-day counters or the list states "whole months".

## Slices

Reviews first (decision 7, 2026-10-14), then the smallest useful page. Each
slice is one PR with its own verifier pass.

| Slice | Content | Proves | IDs |
| --- | --- | --- | --- |
| 1 | GitHub review ingestion (metadata): its own spec, **Spec 022** ([PR #70](https://github.com/unknowntpo/oss-knowledge-base/pull/70), merged 2026-10-14 with `GITHUB_REVIEWS` off), with its own acceptance items. It must be enabled on Dev and have run before slice 2 is shown | Reviews a person gave are stored per pull request with state and time, inside the request budget | W20; Spec 022's own items |
| 2a (2026-10-15) | Review activity read from slice 1's month objects (`internal/github-reviews/v1/<projectId>/<YYYY-MM>.json`), not stored a second time; identity = (source, string), GitHub only; `/api/people/:project/:id`; the page with sections 1–8 and per-source coverage; GitHub author names in Detail link to it, Dev only | A review profile is correct against the store, states what it does not cover, and costs at most 13 R2 reads cold | W5, W6, W8, W10–W13, W18, W23–W29 |
| 2b | Activity log written at publish time from the events the pipeline already has; the profile reads it beside the reviews; Jira and dev@ identities get pages; their author names link | A per-source profile is correct against the Example and grows by a day per day | W1–W4, W9, W17, W19, W22 |
| 3 | Person result in Search on an exact identity match | A name leads to the page, thread ranking unchanged | W7 |
| 4 | Stable keys (GitHub id, Jira account key), roster links, `identityLinks`, the labelled sample, "possibly the same person" | Zero wrong merges on the sample | W14–W16 |
| 5 | 12-month backfill of reviews: Spec 022's store, filled by its own PR (the start-date change proposed in Spec 022; about 509 requests, 20 runs, about 8 MB, measured from search totals) | Review activity reaches back 12 months | Spec 022's items |
| 6 | 12-month backfill of the activity log: GitHub issues, pull requests and conversation comments; Jira; dev@. **Cost not measured.** dev@: 12 monthly archives (one Pony Mail request per month; message count and bytes unknown). Jira: unknown (issues updated in 12 months, pages of 100, comments inline). GitHub: listing 3,668 Kafka and 9,032 DataFusion items (GitHub search totals, 2026-10-14) plus one comment request per item with comments, unmeasured. **This is the next measurement**, before the slice is specified | A 12-month trajectory on day one for every source; request budget respected | W21 |
| 7 (decision 10) | Per-project contributor list sortable by separate metric columns, from per-month summaries written at publish time | A list for everyone without parsing 12 months of rows per request | W30–W33 |
| Later, own decision | Jira components as areas; all-time KIP threads (option C) | | |

Changes of 2026-10-14, besides the order:

- Section 7 ("Works with") was in no slice, although W12, assigned to the
  first page, asserts on its lists. It now ships with the page (slice 2):
  with reviews already ingested it has its "reviewed by" relation from the
  first day, and W12 is testable in the slice it belongs to.
- W8 moved to the page's slice: it asserts on profile rows and on "reviews
  given", which exist only once the activity log does. Slice 1 is specified
  and tested by Spec 022.
- Decision 4 (12 months) splits the old backfill slice: reviews (slice 5,
  Spec 022's store) and the other sources (slice 6, cost not yet measured).
- Decision 3 adds W24 (`noindex`) and W25 (not on Prod); decision 4 adds W26
  (12-month horizon).
- The Example was captured before any review was ingested, so
  its "pull requests commented" figures stay as measured; W1 keeps them. The
  review counts of the same people are added to the case file when slice 1
  has data.

## Test plan

Slice 2a: rows built from Spec 022's recorded GraphQL responses for Kafka
#23675 and #23165 (labelled `recorded`) and from constructed rows (labelled
`constructed`). Counts are the profile's totals for the 12-month view.

<!-- test-plan:start packages/reference-pipeline/test/contributor-profile.cases.ts -->
| id | case | data | person | suppressed | status | given | byState | received | worksWith |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W8 | a reviewer who commented twice with inline comments | recorded | github:chia7712 | — | 200 | 2 / 1 | commented 2 | 0 / 0 / 0 | reviewed PRs by gabriellefu 1 |
| W8 | an approval after comments; his own answer on his own PR (#23675) is left out | recorded | github:lucasbru | — | 200 | 4 / 1 | approved 1, commented 3 | 1 / 1 / 1 | reviewed PRs by gabriellefu 1; reviewed by bbejeck 1 |
| W8 | a PR author's 18 answers in her own review threads are no reviews given; the bot's review is not received | recorded | github:gabriellefu | — | 200 | 0 / 0 | — | 9 / 1 / 4 | reviewed by chia7712 1, lucasbru 1, mjsax 1, squah-confluent 1 |
| W8 | one approval | recorded | github:bbejeck | — | 200 | 1 / 1 | approved 1 | 0 / 0 / 0 | reviewed PRs by lucasbru 1 |
| W8 | a change request, and an approval of a bot's PR (counted, the bot not named) | recorded + constructed | github:mjsax | — | 200 | 3 / 3 | approved 1, changes requested 1, commented 1 | 0 / 0 / 0 | reviewed PRs by constructed-author 1, gabriellefu 1 |
| W8 | a dismissed review keeps its earlier verdict | constructed | github:constructed-reviewer | — | 200 | 1 / 1 | dismissed 1 (was approved) | 0 / 0 / 0 | reviewed PRs by constructed-author 1 |
| W12 | GitHub typed the reviewer Bot in the stored rows | recorded | github:copilot-pull-request-reviewer | — | 404 | — | — | — | — |
| W12 | a login on the profile's bot list | constructed | github:dependabot | — | 404 | — | — | — | — |
| W12 | a suppressed identity has no profile (positive control: row 3) | recorded | github:gabriellefu | gabriellefu | 404 | — | — | — | — |
| W12 | a suppressed counterpart stays counted but unnamed (positive control: row 1) | recorded | github:chia7712 | gabriellefu | 200 | 2 / 1 | commented 2 | 0 / 0 / 0 | — |
| W11 | a login with no row in the store | recorded | github:nobody-here | — | 404 | — | — | — | — |
| W11 | a Jira identity: the source is not recorded in 2a | — | jira:5f2a9c1e | — | 404 | — | — | — | — |
| W26 | a review on the last second before the 12-month view (2025-10-31T23:59:59Z) | constructed | github:old-reviewer | — | 404 | — | — | — | — |
| W26 | a review on the first second of the view (2025-11-01T00:00:00Z) | constructed | github:edge-reviewer | — | 200 | 1 / 1 | approved 1 | 0 / 0 / 0 | reviewed PRs by constructed-author 1 |
<!-- test-plan:end -->

Slice 2b (pending): the three Example identities with the counts of the
Example, built from a recorded fixture of the 268 Detail responses captured
on 2026-10-13 (W1).

## Acceptance

Each item: precondition → action → observable result → evidence. All are
`[pending]` until their slice is implemented.

### Behavior

- W1: [pending] given the recorded 2026-10-13 fixture, aggregating identity `github:chia7712` gives 0 pull requests authored and 57 comments on 46 pull requests by 34 authors; `github:m1a2st` gives 18 authored, 6 comments on his own, 19 on 16 others'; `mail:"Andrew Schofield"` gives 23 messages in 11 threads → case file rows.
- W2: [pending] given a record ingested twice (a retried run), the activity month object holds one row for it → unit test on the append function. (Review rows are not appended by this spec; their idempotence is Spec 022 RV5.)
- W3: [pending] given a pull request created on day 1 and updated on day 40, "authored" counts it in the month of day 1 and its row keeps both times → case row on each side of a month boundary.
- W4: [pending] given a thread with labels `clients`, `small`, `ci-approved` and a Kafka profile naming the last two as process labels, the area is `clients` only; given a dev@ thread, the page says "no area data from dev@" → case rows.
- W5: given the page for an identity, sections appear in the order of this spec and the header states the period covered and the number of days of data → component test.
- W6: given an identity with rows only before the selected period, the page says there is no activity in this period and shows no zero-filled chart → component test, with a positive control on the same identity in the full period.
- W7: [pending] given the query `chia7712`, the first result is the person result for `github:chia7712`; given `chia`, there is no person result and thread results are identical to today's → API test, both sides.
- W8: given Spec 022 month objects (`osskb.github-reviews.v1`) built from Spec 022's recorded Kafka #23675 and #23165 (approvals, comments, a bot's review, the author's own reply) plus a constructed change-request row, the profile reads them as they are, shows each human review with its state, counts "reviews given" as distinct pull requests, leaves out rows with `isBot` or with `reviewer` equal to `prAuthor`, and states the date reviews are counted from (`coverageFrom`) → case rows (recorded and constructed, labelled as such).

### Failure and retry

- W9: [pending] given a publication whose activity write fails, the publication still completes, `/health` reports the failure, and the next run writes the missed rows (they are still in the state for 35 days) → Durable Object test.
- W10: given a month object missing or unparseable, `/api/people` answers with the months it could read and names the missing month in the response; the page shows "data for <month> is unavailable" → API and component test.
- W11: given an identity with no counted row in any source the profile reads (2a: reviews), `/api/people` answers 404 with `no-store`, and the page says there is no recorded activity for it in this community, naming the sources recorded → API test.
- W12: given a bot identity (GitHub `Bot` type in the review rows, a `[bot]` suffix, or the profile's bot list) or a suppressed identity, no profile is served (404) and it is absent from every "Works with" list → case rows, with a positive control (the same fixture without the suppression). (No person result: slice 3, W7.)
- W13: given any `/api/people` response for the fixture, it contains no `@` followed by a domain, and no field named score or rank → test over every fixture identity.
- W14: [pending] given two identities with the same display name and no declared link, counts are not summed and each page shows the "possibly the same person" hint → case rows on each side (with and without a `declared` link).
- W15: [pending] given a roster with two entries of the same name, no dev@ name is linked to either → case row; positive control with a unique name.
- W16: [pending] given the labelled sample, no pair labelled "different" is linked → test iterating the sample file.
- W24: given any `/api/people/*` response (200, 404, error), it carries `X-Robots-Tag: noindex` → API test over each status.
- W25: given the Prod configuration, `/api/people` is not served and no author name links to a people page; given the Dev configuration, both are → configuration test on both sides.
- W26: given activity and review month objects for 13 months, `/api/people` reads and counts only the newest 12, and the header's period says so → API test, with a positive control at exactly 12 months.

- W30: [pending] (slice 7) given month summaries for a project, the list answers one row per non-bot, non-suppressed identity with separate counts per column and no composite field; a source not recorded yet is "not recorded", not 0 → API test.
- W31: [pending] (slice 7) the reader sorts by any one column, either direction, ties by name; the default order is by name → component test.
- W32: [pending] (slice 7) the list is served on Dev only and with `X-Robots-Tag: noindex`, under the gate of W25 → configuration and API test.

### Budget

- W17: [measure] the activity write adds at most 2 Class A and 2 Class B operations per project per publication, and no per-identity object (limit: G59's one request per object; command to be added as `measure:people`).
- W18: [measure] `/api/people` for the identity with the most rows over 12 months parses under 16 MB and answers under 500 ms in the Pages reader (limit 128 MB; command `measure:people`). 2a: measured on review months at Dev's volume, reported in the PR.
- W33: [measure] (slice 7) a list request parses at most 12 summaries per project, under 2 MB, measured with `measure:people`.
- W19: [measure] the publisher's peak memory with the activity append stays within the Spec 009 budgets at 8,600 and 17,200 events (`measure:memory`).
- W20: [measure] review ingestion adds at most one GitHub request per pull request updated that day, and a day's batch stays inside the hourly request limit (slice 1; measured by Spec 022 RV21 and RV22 with `measure:github-reviews`).
- W21: [measure] the 12-month backfill of slice 6 states its request count and stored size per source (GitHub, Jira, dev@'s 12 monthly archives) before it runs, measured, not estimated, and stays under each source's limit; it runs outside the publication.

### Observability

- W22: [deploy] `/health` `lastRun` reports the activity write: rows appended, month objects written, identities indexed, and the earliest month held. Review ingestion is not reported here: it has its own `/health` `githubReviews` (Spec 022 RV24), which the page's "how this is computed" note takes `coverageFrom` from.
- W23: [deploy] on Dev, the page for `github:chia7712` shows the period covered and the coverage line, and its counts equal the `/api/people` response; the response's review totals agree with the upstream oracle of the 2a Example within the reviews submitted after the oracle was read.
- W27: given a community with sources the profile does not read yet, the response lists each with status "not recorded" and the page shows "<sources>: not recorded yet" without a count; given the review store, the page shows "Reviews: <from> to <until>" with the dates of the response → case rows and component test, both sides.
- W28: given the Dev configuration, a GitHub record's author in Detail links to `/#/<project>/people/github:<login>`; a bot author, a Jira author and a dev@ author do not link (2a); given the Prod configuration, no author links → component test and E2E, both sides.
- W29: given a cold isolate, one profile request reads at most 13 objects from R2 for its project (`state.json` + 12 months, none before `coverageFrom`'s month); a second request within 10 minutes reads none; one after 10 minutes reads them again → API test with a counting bucket.

## Success criteria

| Criterion | Measure |
| --- | --- |
| Counts are right | For 10 sampled identities, "pull requests authored" and "pull requests reviewed" equal the GitHub search count for the same period exactly (reviews: a period that starts after review ingestion began); any difference is explained on the page |
| No wrong merge | Zero in the labelled sample (W16) |
| Purpose is obvious | The first screen at 375 px names the person, the community, and the period, with no number that lacks a definition |
| Cost | No new metered service; R2 operations within W17; no model calls |
| Honest coverage | Every page states the days of data it covers and what is not counted |

## Decisions made

Decisions 1–9 by the owner, 2026-10-14; decision 10 on 2026-10-15. Each
matches the draft's recommendation; the rejected alternative is kept for the
record.

| # | Decision | Decided | Consequence in this spec | Rejected alternative |
| --- | --- | --- | --- | --- |
| 1 | Which uses | **U1** (understand a person) and **U2** (track one's own trajectory). **U3** ("most active in an area") deferred: it is ranking-like. *Revised by decision 10 (2026-10-15)* | Sections and slices serve U1 and U2; no list of people in any order | U3 needs people sorted by activity, which conflicts with "no ranking" |
| 2 | Scope | **Everyone who appears, bots excluded** | P-j; W12 | Committers only: about 73 Kafka pages instead of about 440 identities a month; useless for U2 and for new contributors; DataFusion has no roster |
| 3 | Visibility | **Dev only, `noindex`, not on Prod** | P-g, P-h; W24, W25 | Private behind access control: an auth setup, and the page could not be linked from threads |
| 4 | Horizon | **12 months for all activity.** Reviews come from Spec 022's store (its 12-month backfill is a separate PR); dev@, Jira and GitHub comments need their own 12-month backfill | Behavior 3; slices 5 and 6; W18, W21, W26. Slice 6's cost is unmeasured and is the next measurement | No backfill (35 days, a year to become a trajectory); option C (all-time KIP threads, 11 years of Pony Mail); option D (a searchable year: breaks G10, G59, H67) |
| 5 | Identity | **Strict.** Link only declared or roster-backed identities; otherwise "possibly the same person". No fuzzy matching, no email | Identity resolution rule; W14–W16; W13 (no address anywhere) | Merging equal display names, or an ASF id equal to a GitHub login: fewer split profiles (37 and 14 pairs today), with a real chance of a wrong merge |
| 6 | Areas | **GitHub labels (minus process labels) and KIP numbers first; Jira components later.** No file paths (decided); they are not available anyway, because Spec 022 counts inline comments without storing them | Behavior 6; W4; "Later" slice | Jira components now (one more Jira field); digest topics (12 coarse, Kafka-tuned) |
| 7 | Reviews before or after the first page | **Reviews first** ("先補") | Slice 1 is Spec 022; no "reviews are not counted yet" note | Page first: under-states a reviewer by about 3.6 times (`chia7712`: 46 pull requests commented, 168 reviewed upstream) |
| 8 | Terms and policy | **GitHub Terms of Service, the ASF privacy policy and the GDPR must be checked before anything goes beyond Dev** | Privacy section, P-g (Dev only); W25 | Skipping it risks having to take the feature down |
| 9 | Removal | **By issue or email; removed at the next daily publication** | P-e; W12 | A self-service form needs authentication of the requester |
| 10 | Contributor list (2026-10-15) | **Per-project list, sortable by separate metric columns** (reviews given, PRs authored/merged, comments, Jira, dev@, last active), no composite score, bots excluded, Dev only; built after the profile | Slice 7; W30–W33; revises decision 1 (U3 in this form) and P-a | A single activity score or rank (rejected again); no list at all (the owner wants it) |

## Could not be verified

- **The 12-month backfill cost of dev@, Jira and GitHub comments (slice 6).**
  dev@ is 12 monthly archives; Jira and the GitHub comment requests are
  unknown. This is the next measurement.
- Whether a public ASF endpoint publishes committers' GitHub usernames.
- Why Dev holds 404 Jira issues when Jira reports 474 updated in 30 days (570
  in 35), and 71 of the 112 issues `chia7712` reported that were updated in
  35 days.
- The number of KIP threads all time (only messages were counted; "2 threads
  per KIP" is an estimate). Pony Mail's unbounded query returned a capped
  25,001, so the all-time dev@ total is unknown.
- Jira comment and dev@ message counts per person upstream (no count-only
  query was run).
- Row size of the activity log (110 bytes is an estimate; the 9 MB a year
  follows from it).
- The live ASF roster: the Spec 015 sample of 2026-10-08 was used; Whimsy was
  not read.
- All terms of service and law (section Privacy).
- The month estimates for when each limit breaks are linear extrapolations
  from one 35-day release.

## Appendix: records behind the Example

Thread ids in the release `2026-10-13T10-07-01-000Z` (`#n` = `KAFKA-PR-n`,
`K-n` = `KAFKA-n`, `mail:x` = `KAFKA-MAIL-x`). Each thread's record ids are
in its `/api/detail/feed-entry:feed-record-group:…` response.

- `chia7712` (GitHub, 46): #20984, #22102, #22272, #22353, #22447, #22593, #22599, #22763, #22809, #23063, #23105, #23123, #23165, #23246, #23258, #23310, #23316, #23385, #23392, #23398, #23399, #23402, #23405, #23411, #23415, #23425, #23431, #23433, #23439, #23451, #23473, #23475, #23476, #23479, #23506, #23532, #23535, #23543, #23609, #23614, #23637, #23654, #23661, #23716, #23748, #23758.
- "Chia-Ping Tsai" (Jira, 77): K-12188, K-14019, K-16546, K-18775, K-18800, K-19028, K-19034, K-19122, K-19123, K-19277, K-19615, K-19931, K-20036, K-20125, K-20235, K-20351, K-20390, K-20416, K-20607, K-20609, K-20677, K-20745, K-20795, K-20812, K-20855, K-20939, K-20953, K-20979, K-20986, K-21006, K-21010, K-21012, K-21013, K-21014, K-21017, K-21019, K-21023, K-21036, K-21037, K-21038, K-21042, K-21045, K-21051, K-21053, K-21054, K-21058, K-21065, K-21067, K-21069, K-21075, K-21081, K-21091, K-21092, K-21093, K-21108, K-21110, K-21121, K-21124, K-21128, K-21131, K-21133, K-21134, K-21135, K-21138, K-21146, K-21148, K-21149, K-21150, K-21154, K-21155, K-21156, K-21173, K-21175, K-21183, K-21210, K-21228, K-21235.
- "Chia-Ping Tsai" (dev@, 13): mail:03dc59c4, mail:0635ac57, mail:1ea662ce, mail:3bff04e6, mail:4bc41094, mail:6c38f1a7, mail:6f627126, mail:7e460611, mail:8849f679, mail:d2f9f789, mail:e07e6b7f, mail:edf95c85, mail:f7a35fa2. Binding votes: messages `lkwrdnlf7x1lvc58p4gvgtqodfwl374s` and `yjd7llfyovbypwwh7yy227oz4o5yop80`.
- `m1a2st` (GitHub, 34): #19241, #19566, #19720, #21005, #21484, #21760, #22036, #22045, #22046, #22047, #22055, #22056, #22232, #22631, #22747, #23005, #23094, #23123, #23197, #23204, #23246, #23258, #23264, #23301, #23318, #23348, #23391, #23423, #23433, #23455, #23479, #23665, #23748, #23767.
- "Andrew Schofield" (Jira 8, dev@ 11): K-15677, K-20803, K-20923, K-20924, K-20939, K-21106, K-21178, K-21209; mail:186eea6b, mail:540e8110, mail:6f627126, mail:82e0d5b3, mail:85a6bd91, mail:86ae8b63, mail:edf95c85, mail:f09ac41a, mail:f7a35fa2, mail:fd63cd54, mail:ff6d44a5. Binding votes: messages `hxzv89m1tlrx3yym1szlv1xjzfy0bdzv` and `3yjrpgvy7rnwps56jr2gr7b8w5oqvlyy`.
- `AndrewJSchofield` (GitHub, 12, unlinked): #22996, #23123, #23221, #23232, #23234, #23478, #23499, #23532, #23649, #23664, #23678, #23703.

Upstream count queries (2026-10-13): GitHub search `repo:<repo> is:pr|is:issue
updated:>=<date>`, `author:`, `reviewed-by:`, `commenter:`; ASF Jira search
with `maxResults=0`; Pony Mail `stats.lua?list=dev&domain=kafka.apache.org&quick`
with `d=lte=<n>d`, and `header_subject=KIP` per calendar year.
