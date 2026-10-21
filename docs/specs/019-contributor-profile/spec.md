# Spec 019: Contributor profile

Status: Partially implemented (accepted 2026-10-14, all nine owner decisions recorded; amended 2026-10-15): slice 1 is Spec 022; slices 2a, 2b, 3 and amendments (4) and (5) implemented (#74–#78, #81) and on Dev only (`PEOPLE_PROFILES=true`, `PEOPLE_ACTIVITY=log@1`), off on Prod; amendment (7) slice B (the `kip-pages` job, W93, W97–W100, W102, W105, W107, W108, W110) implemented and off everywhere (`KIP_PAGES` unset); the rest of slices 4–7 not implemented
Date: 2026-10-13 (decisions recorded 2026-10-14; amendment and decision 10 2026-10-15)
Traceability: enforced
Builds on: Spec 004 (GitHub connector), Spec 008 (content-addressed objects), Spec 009 (bounded memory), Spec 012 (dev@ and Jira), Spec 014 (digest profiles), Spec 015 (governance profile and ASF roster), Spec 016/017 (search, "exact matches first"), Spec 018 (daily publication)

> **How to read this spec.** Sections 1–3 are the intent, the real-data
> Example, and the data-range estimate. The owner decided all nine open
> questions on 2026-10-14; they are in [Decisions made](#decisions-made).
> Slice 1 (review ingestion) is Spec 022, live on Dev with 12 months of
> reviews. The [amendment of 2026-10-15](#amendment-2026-10-15-the-first-profile-ships-from-reviews)
> splits slice 2: **2a** ships the profile page from the review store with
> per-source coverage stated on the page; **2b** adds the activity log
> ([amendment (2)](#amendment-2026-10-15-2-slice-2b-the-activity-log): what
> is stored, identity, the real-data Example, budget and worst-case cost).
> [Amendment (7)](#amendment-2026-10-21-7-kips-a-person-started-and-corroborated-links)
> (specified, not implemented) lists the KIPs a person started and adds a
> third link basis, `corroborated`, computed by its own job.
> Items of later slices stay `[pending]`.

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
   so. Two unlinked identities are better than one wrong merge. *Amendment
   (7), 2026-10-21: or when deterministic co-occurrence corroborates it
   (basis `corroborated`), after a precision check, with the basis shown.*
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
   - `corroborated` (amendment (7), 2026-10-21): repeated co-occurrence on
     `KAFKA-n` (GitHub ↔ Jira) or `KIP-n` (Jira ↔ dev@), computed daily by
     the identity-link job, enabled only after its precision check. See
     [the rule](#the-corroborated-rule).
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
  ("chia") produces no person result in v1. *Revised 2026-10-15 (slice 3,
  [amendment](#amendment-2026-10-15-slice-3-finding-a-person-from-search)):
  a login prefix also yields person results, after the exact match, at most
  three.*
- No people directory and no tab in v1 (a directory needs an order, and any
  order but alphabetical is a ranking).

### Sections of the page, in order

Amended 2026-10-16: the order and the top of the page are those of
[amendment (5)](#amendment-2026-10-16-5-the-top-of-the-profile-as-a-chart-and-tiles)
(W56); the table below is the original rationale of each section.

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
   | Partial-name people search, autocomplete | convenience | **deleted** from v1; *login prefixes restored 2026-10-15 for slice 3 (owner: no entry point); autocomplete stays deleted* |
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
   numbers from titles. A label naming a KIP (`KIP-932`, `kip-1332`) counts
   as that KIP, not as an area (amendment (4), `areas.ts`). A source without
   labels shows "no area data from <source>".
7. The page shows the sections in the stated order, the period covered, and
   the "how this is computed" note. An identity with no rows in the period
   says so; it is not an error.
8. A query that equals an identity key or display name exactly yields one
   person result first. Bots and suppressed identities never do. *Slice 3
   (2026-10-15): a query that is a prefix of a login yields person results
   after the exact one, at most three in all.*
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

**Enabled on Dev in the same PR (deliberate exception).** `docs/process/workflow.md`
asks to separate merge from enable. Slice 2a sets `PEOPLE_PROFILES: "true"`
in the Dev Pages configuration in the PR that adds the code, because the
owner wants the profile visible as soon as possible (2026-10-15) and Dev-only
visibility was already approved (decision 3). The risk is bounded: the
change is Pages-only (no Worker, no publication, no R2 write) and Prod has no
value. **Rollback:** remove `PEOPLE_PROFILES` from
`apps/web/wrangler.development.jsonc` and let CI redeploy Dev Pages (or
`bun run --cwd apps/web pages:deploy:development` from that commit); `/api/people`
then answers 404 and no author name links, without reverting the feature.

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

## Amendment 2026-10-15 (2): slice 2b, the activity log

Owner's request (2026-10-15): "開始做活動紀錄". Slice 2b adds the activity
log of Behavior 1–4: the publication appends the records its state holds,
and the profile reads them beside the reviews. Jira and dev@ identities get
their own pages. It ships behind `PEOPLE_ACTIVITY`, off in every environment
in the merge PR; a second PR turns it on for Dev only
(`docs/process/workflow.md`, "Separate merge from enable").

### What is stored (reconciles Behavior 1–4, W2, W22 and decision 10)

Three kinds of object per project under `internal/people/v1/<projectId>/`,
nothing under `public/`:

| Object | Schema | Content | Written |
| --- | --- | --- | --- |
| `<YYYY-MM>.json` | `osskb.people-activity.v1` | `rows[]`: `id` (the source record id), `source` (`github`, `jira`, `mail`), `kind` (`pull-request`, `issue`, `comment`, `message`), `person`, `at`, `thread`, `merged?`; `threads{}`: `source`, `kind`, `title`, `url`, `author`, `labels[]`, `kips[]`; `people{}`: person id → display name | When its bytes change |
| `<YYYY-MM>.summary.json` | `osskb.people-activity-summary.v1` | Per identity: `display`, `counts` (pull requests, issues, comments, Jira issues, Jira comments, dev@ messages), `opened[]` and `merged[]` thread keys (so distinct counts stay exact across months), `lastAt`. Built by `indexActivityMonth`, the function the reader indexes a month with (decision 10) | Before its month, whenever the month changes |
| `state.json` | `osskb.people-activity-state.v1` | `firstAppendAt`, `coverageFrom` (35 days before the first append), `updatedAt` (the last append), `months[]` | Once per run, last |

No text, no excerpt, no address, no hash of an address (P-c). The row is
about 150 bytes, not the 110 estimated above.

- **Rows are rebuilt from the whole state every run** (W2, W9). A row is
  keyed by its record id; a run merges its rows into each stored month and
  writes the month only when its bytes changed. A run whose append failed is
  repaired by the next one while the records are still in the state (35
  days). So the append is idempotent and needs no cursor.
- **Which month a row is in.** GitHub pull requests and issues: the month
  they were **opened** (`createdAt`, W3); comments and dev@ messages: the
  month they were written. A merged pull request keeps its merge time
  (`merged`). **The last-update time is not kept** (amends W3's "keeps both
  times"): keeping it would rewrite a past month every time an old pull
  request is touched, and nothing on the page reads it. A Jira issue is in
  the month of its **last update**, because the connector does not keep
  Jira's `created` (G77); an issue updated in two months is in both objects
  and the reader counts it once, in the newer month.
- **Coverage.** The first append holds what the state holds: 35 days. So
  `coverageFrom` = first append − 35 days, and rows before it are neither
  written nor counted: a pull request opened before it is not "authored" in
  the log even when the release shows it (m1a2st below: 18 in the release, 7
  opened inside the coverage). `coverageFrom` never moves after the first
  append, and nothing is written before it, so at most 12 months are ever
  read, and only months that have rows in the state are read by a run.
- **Writes.** Plain puts, not conditional ones: only the publication Durable
  Object's alarm writes these keys, and the runtime never runs two alarms at
  once, so no precondition can fail (the 2026-10-13 Class A incident came
  from failed conditional puts). The summary is written before its month, so
  a month whose summary write failed is rewritten next run.
- **What stays in the log.** A record deleted upstream (a deleted comment,
  a removed message) is no longer polled, but its row stays in its month:
  the log only adds and replaces rows. Removal of a person's rows is by
  suppression (P-e: the identity gets no page and is unnamed elsewhere),
  not by deleting rows. Months older than the 12-month horizon are not
  pruned yet: they are small, and nothing reads them (Behavior 3 leaves
  deletion to a later, separately approved spec).
- **Decision 10, reconciled.** The amendment proposed the summary "next to
  each month object it changes", built by `indexReviewMonth`. Reviews are
  written by Spec 022's job, not by the publication, so the activity summary
  covers the activity log only; whether Spec 022's job writes a review
  summary or the list reads review months is left to slice 7 (G81).

### Identity (decision 5, strict)

| Source | Person id | Key | Display |
| --- | --- | --- | --- |
| GitHub | `github:<login>` | login, case-insensitive | the login as written |
| Jira | `jira:<name key>` | display name, `nameKey` (NFC, quotes removed, trimmed), case-folded | the display name |
| dev@ | `mail:<name key>` | From name, same rule; the address is dropped by the connector (`mailAuthor`) and never stored | the From name |

- The route is `/#/<project>/people/<id>` with the id URL-encoded, for
  example `/#/kafka/people/mail%3Aandrew%20schofield`. This replaces the
  8-hex hash of the original route: a hash of a public display name hides
  nothing, needs a digest in the browser to build a link, and can collide
  (two people on one page). Slice 4 replaces the Jira key with the account
  key; Jira ids then change (G76).
- `jira:chia-ping tsai` and `mail:chia-ping tsai` are two identities and two
  pages; neither is linked to `github:chia7712`. Counts are never summed
  across them (rule 3). "Possibly the same person" stays slice 4.
- Not identities: `unknown`, `unknown sender` (a bare address), `ghost`, and
  bots. A GitHub or Jira record the connector marks `isBot` writes no row.
- The page of a Jira or dev@ identity says that it is identified by the name
  the source shows, so two people with one name would share it (G76).
- Ids are `<source>:<key>` like GitHub ids, so a people index (slice 3) can
  list them without a contract change.

### Example (2b): what the first append shows for three real people

Recorded from Dev on 2026-10-15 (release `2026-10-14T22:07:43Z`, anonymous
GETs of `/api/feed` and `/api/detail`; creation times of the pull requests
these people opened from GitHub REST): every Kafka thread in which
`chia7712`, "Chia-Ping Tsai", `m1a2st`, "Andrew Schofield" or
`AndrewJSchofield` wrote, with its root record
(`packages/reference-pipeline/test/fixtures/people-activity/kafka-dev.json`,
339 records in 194 threads; command
`packages/reference-pipeline/scripts/capture-people-activity-fixture.ts`).
The log is built as the first append at that release would build it:
coverage from 2026-09-09T22:07:43Z. The counts were computed from the
fixture by a separate script, then fixed as the case rows of W1.

| Profile | GitHub | Jira | dev@ | Areas | Wrote in threads started by |
| --- | --- | --- | --- | --- | --- |
| `github:chia7712` | 0 pull requests opened; 59 comments on 48 threads, 0 on his own | — (another identity) | — (another identity) | `clients` 10, `streams` 9, `build` 8, `core` 8, `group-coordinator` 6; KIP-909 | `gabriellefu` 5, `harmadasg` 4, `jim0987795064` 3, `m1a2st` 3 |
| `jira:chia-ping tsai` | — | 72 issues reported (by last update), 12 comments, on 78 issues | — | no area data from Jira | Mickael Maison 2, Andrew Schofield 1, David Jacot 1, Edoardo Comar 1 |
| `mail:chia-ping tsai` | — | — | 21 messages in 13 threads; `[DISCUSS]` 6, `[VOTE]` 6 | KIP-1153, KIP-1342, KIP-1349; no label data | Andrew Schofield 1, David Jacot 1, Ming-Yen Chung 1, Omnia Ibrahim 1 |
| `github:m1a2st` | 7 pull requests opened (5 merged); 26 comments on 20 threads, 7 on his own | — | — | `clients` 8, `consumer` 5, `core` 5, `group-coordinator` 5, `storage` 4 | `dajac` 4, `mimaison` 2, `nileshkumar3` 2 |
| `mail:andrew schofield` | — | — | 23 messages in 11 threads; `[DISCUSS]` 4, `[VOTE]` 4 | KIP-1368 ×2, KIP-1279, KIP-1306, KIP-1349, KIP-1371 | Chia-Ping Tsai 2, Aditya Kousik 1, Apoorv Mittal 1 |
| `jira:andrew schofield` | — | 4 issues, 4 comments, on 8 issues | — | no area data from Jira | Apoorv Mittal 2, Luke Chen 1, Shekhar Prasad Rajak 1 |
| `github:AndrewJSchofield` (unlinked) | 6 opened (4 merged); 4 comments on 3 threads, 2 on his own | — | — | `clients` 7, `consumer` 5, `KIP-932` 3 | `apoorvmittal10` 1, `ezhou413` 1 |

Against the 2026-10-13 Example (a window two days earlier): `chia7712` 57
comments on 46 pull requests there, 59 on 48 here; "Chia-Ping Tsai" 71 Jira
issues there, 72 here; dev@ 21 in 13 threads, unchanged; "Andrew Schofield"
dev@ 23 in 11 threads and Jira 4 / 4, unchanged. `m1a2st`: the release has
18 of his pull requests, 7 of them opened inside the coverage; the other 11
are older pull requests updated in the window, which "opened" does not count
(W3). The fixture holds only Jira issues the release publishes (linked from
GitHub or dev@); the publication's state, which the append reads, holds every
polled KAFKA issue, so on Dev the Jira counts can be higher (upstream JQL
`reporter = chia7712 AND updated >= -35d` returned 112 on 2026-10-13).
Process labels left out of Areas: Kafka `ci-approved`, `small`, `triage`,
`needs-attention`, `stale`, `closed-stale`; DataFusion `Stale`, `auto
detected api change`, `api change`, `help wanted`, `good first issue`,
`bug`, `enhancement` and release labels `vN.N.N` (from the Dev release's
label counts, 2026-10-15).

### The page (2b)

- Header coverage: "Reviews: <from> to <until>" and one line for the log's
  sources, "Comments, pull requests, Jira, dev@: <coverageFrom> to <last
  append>" (W27). Over time shows "—", not 0, for a month or week that ends
  before the log's coverage.
- A GitHub identity shows reviews and its GitHub activity (pull requests
  opened and merged, issues opened, comments and on how many threads, how
  many on its own threads). A Jira identity shows Jira counts; a dev@
  identity dev@ counts and `[DISCUSS]` / `[VOTE]` threads. No page shows
  another source's counts, not even 0.
- Areas: labels minus process labels, and KIP numbers from titles and
  subjects, each with its thread count; "No area data from Jira / dev@".
- Threads: reviews and activity threads in one list, newest first, each
  linking to the source (pull request, Jira issue, the dev@ thread's first
  message), with the person's part ("opened · merged", "2 comments").
- Works with: "Wrote in threads started by" (authors of threads the person
  wrote in but did not open), capped at 10 (Behavior 9). The other relations
  of section 7 for activity ("commented on their pull requests", "same dev@
  threads") are not built (G80).
- Detail: a Jira or dev@ author links to its page only where `/api/people`
  lists the source as recorded (`recorded`, W28); before the first append it
  does not.
- Not built in 2b: votes marked "(binding)" (needs the message body; metadata
  only, G78).

### Budget, measured

`bun run --cwd apps/data-publisher-worker measure:memory --kafka 1
--activity 1` (Node/V8, seeded events, two appends: the first, then an
unchanged rerun); before = the same command without `--activity`:

| Events | Peak before → after | Peak phase | Append phase peak | Run wall time before → after | First append | Unchanged rerun | Objects |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8,600 + 1,250 dev@/Jira (1×) | 54.3 → 54.3 MB | write feed | 52.2 MB | 7.9 → 6.0 s (noise; the append took 305 ms) | 7,884 rows, 6 months, 14 Class A, 8 Class B, 2.9 MB | 0 months written, 2 Class A, 8 Class B, 112 ms | 14, largest 1.3 MB |
| 17,200 + 2,500 (2×) | 102.6 → 102.7 MB | write feed | 97.8 MB | 19.2 → 19.6 s (the append took 567 ms) | 15,705 rows, 6 months, 14 Class A, 8 Class B, 5.5 MB | 0 written, 2 Class A, 8 Class B, 269 ms | 14, largest 2.5 MB |

The append is not the peak at either scale (W19 holds: K24 96 MB, K25 128
MB). Its wall time in the Durable Object adds R2 latency: at most 26 reads
and 50 writes a run, sequential.

`bun run measure:people` (Bun; constructed stores; the 2a numbers with
`--no-activity`):

| Request (cold) | R2 reads | Bytes parsed | Wall / CPU | Response (gzip) | Heap kept by the isolate cache |
| --- | --- | --- | --- | --- | --- |
| 2a: Kafka `chia7712`, reviews only | 14 | 3.2 MB | 14 / 19 ms | 33 KB | 5.3 MB |
| 2b, 12 full months of log: Kafka `chia7712` | 26 | 11.6 MB | 51 / 84 ms | 67 KB | 23 MB |
| 2b, 12 full months: DataFusion `alamb` | 26 | 23.2 MB | 88 / 101 ms | 151 KB | 39 MB |
| 2b, 12 full months, `--scale 2`: DataFusion `alamb` | 26 | 46.0 MB | 203 / 187 ms | 285 KB | 75 MB |

A warm request reads nothing. On the first append's day only two months
exist, so a request parses about a sixth of the 12-month figure. **W18's
16 MB parse budget holds until the DataFusion log is about 8 months old,
then fails** (23 MB at 12 months, 46 MB at 2×); the Pages limit is 128 MB
and a search request already parses 28.8 MB. The fix (rows split by
identity, or compacted rows) is G75 and must land before the log is 6 months
old. `measure:people` now checks the budget: it exits 1 above 16 MiB, `--months N`
sets the log's age (DataFusion: 15.7 MiB at 8 months, 17.3 MiB at 9), and
`--report-only` reports without failing.

### Cost: worst case per day and per month (free tier: 1 M Class A, 10 M Class B, 10 GB a month)

| Path | Worst case |
| --- | --- |
| Daily run, both projects | Class B: 2 `state.json` + at most 12 months each = 26. Class A: at most 12 changed months × 2 (month and summary) + 1 `state.json`, each = 50 |
| Runs per day | 1 Cron tick + 5 catch-ups + 3 retries (Spec 018) = 9, plus up to 6 platform retries of a killed alarm = 15; plus any manual `POST /run` |
| Publisher, a day | 15 × 50 = 750 Class A, 15 × 26 = 390 Class B |
| Publisher, a month | 22,500 Class A (2.3 % of the free million), 11,700 Class B (0.1 %) |
| Expected (measured counts above) | First append on Dev: Class B 6, Class A 10 (2 months a project). Then a daily run: a few changed months, about 10–18 Class A and 6–10 Class B |
| Profile reader | At most 26 Class B per project per isolate per 10 minutes, plus 4 for `/api/people` (`recorded`); the free 10 M a month is reached only above about 12,800 cold isolate windows a day |
| Storage | About 12 × 1.7 MB (DataFusion) + 12 × 0.7 MB (Kafka) of months, plus summaries, after a year: under 0.1 GB of 10 GB |

A failed put is an ordinary Class A (no conditional put is sent), so a retry
loop cannot multiply cost beyond the run count above.


## Amendment 2026-10-15 (slice 3): finding a person from Search

Owner (2026-10-15): "要怎麼搜尋個人 profile？沒看到入口" (how do I search
for a profile? I see no entry point). Profiles are live on Dev (slice 2a),
but the only way in is an author link on a Detail page. Slice 3 makes the
existing search box the entry point.

### What changes from the accepted design

- **Login prefixes are back.** The simplification review deleted
  partial-name search from v1 as a convenience. The owner's question shows
  it is the entry point: a reader rarely types a full login. A query that is
  a prefix of a login (two characters or more) yields person results after
  the exact match. Autocomplete stays deleted: results appear where search
  results already appear, with the search box's existing 180 ms debounce.
- **Order.** The exact login first, then prefix matches in alphabetical
  order (case-insensitive), at most **three** person results. No activity
  order: any order but alphabetical is a ranking (decision 1, decision 10).
- **Display names wait for 2b.** The review store holds logins only, so in
  slice 3 the match key is the GitHub login. Jira and dev@ identities, and
  their display names, enter the same index with 2b (see the contract
  below).

### Example (Dev, 2026-10-15)

Profiles read with unauthenticated `GET /api/people/kafka/github:<login>`
on Dev (`chia7712`, `chiacyu`, `mimaison`, `mingyen066`, `m1a2st` answer
200, re-checked 2026-10-15; `dependabot` answers 404, "Bots and deleted accounts have no profile").
The full login list was not read (that needs the new endpoint or R2), so the
prefix rows name only logins known to have a page.

| Query (Kafka) | Person results | Why |
| --- | --- | --- |
| `chia7712`, `Chia7712`, `@chia7712` | `github:chia7712` (exact) first | Case-insensitive; a leading `@` is dropped |
| `chia` | `chia7712`, `chiacyu`, and any other login starting with `chia`, alphabetical, at most 3 | Prefix |
| `mi` | the first three logins starting with `mi` alphabetically (`mimaison` and `mingyen066` have pages) | Cap |
| `dependabot` | none | Bot (W12) |
| `kafka consumer` | none, and no R2 read | Not a login (spaces) |
| `c` | none unless a login is exactly `c` | A prefix needs two characters |

Thread results for every query are the `/api/search` results of today:
person results are a separate block above them and never enter the thread
list or its numbering.

### Contract: `GET /api/people/:project?q=<query>`

`osskb.people-search.v1`: `{ schema, project, query, people: [{ id, source,
display, match }] }`, where `id` is the profile route's id
(`github:chia7712`), `source` the identity's source (`github` in slice 3),
`display` what the result shows, and `match` is `exact` or `prefix`. The
page links each result to `/#/<project>/people/<id>` and shows `display` and
the source; it does not parse `id`. **2b adds `jira:`/`mail:` entries and
display-name keys to the same index without changing this shape or the
page.**

Who is in the index: every login with a counted review row (given or
received) in the 12-month view since `coverageFrom`, which is exactly the set
whose profile answers 200. Bots (the profile's list, `[bot]`, typed `Bot` in
any row of the view), the deleted account and suppressed identities are
never in it (W12, P-e). A month that cannot be read is skipped, as the
profile skips it (W10).

**Enumeration is accepted.** Typing prefixes can list the logins in the
index two characters at a time; this is accepted because it is Dev only,
alphabetical (no activity ranking), respects suppression, and exposes only
public GitHub logins that are already reachable through the profile links in
Detail.

Gate: served only where `PEOPLE_PROFILES` is `true` (W25); elsewhere 404,
`no-store`, `X-Robots-Tag: noindex`. The page asks `/api/people` once and
sends no person request where it is 404, so Prod sees no new request but
that one (already sent by Detail pages since 2a).

### Cost (W43, W44)

- No Vectorize, no Workers AI, no Durable Object, no D1: the endpoint reads
  only the review store, through the profile's per-isolate cache
  (`readState`, `readMonth`, 10 minutes). A profile request and a person
  search in the same isolate share the parsed months.
- R2 Class B per request: at most 13 cold per project (`state.json` + 12
  months), 0 warm. A query that is not a login reads nothing. Without a
  project filter the page queries both projects: at most 26 cold.
- Worst case, per isolate that stays busy all day: the cache expires every
  10 minutes, so 144 × 26 = 3,744 Class B reads a day. Ten such isolates:
  37,440 a day, about 1.1 M a month, against 10 M Class B included per
  month. Pathological (every request on a cold isolate): 26 reads per typed
  query, so 10 M reads cover about 380,000 searches a month. Dev has one
  reader.
- Requests: two Pages Function invocations per typed query (one per
  project), after the debounce, against Workers' 100,000 free requests a
  day.
- CPU: the index is rebuilt per request from the cached month indexes
  (about 600 identities a month); `measure:people` reports it (W44).

### An entry besides Search (proposal, not built)

A "貢獻者" link in the project navigation opening a list of everyone with a
page is the visible entry. It is slice 7 (decision 10): the list needs an
order the reader chooses and the month summaries that make it cheap. Slice 3
adds no list and no nav item; the search box, whose placeholder already
reads "搜尋討論、來源或貢獻者", is the entry until slice 7.

## Amendment 2026-10-15 (4): areas as a chart, avatars and public names

Owner, 2026-10-15, on the Dev profile of `m1a2st`: "能有一個圓餅圖顯示他 work
in 的 area 嗎？目前 work in area 好像都沒有資料", and "能抓 GitHub 的 Avatar 來
顯示嗎？這樣就知道這個帳號對應的是哪個人". Areas were empty for review work
because review rows carry no labels. Spec 022's amendment of the same date
(`metadata@2`) stores each reviewed pull request's label names and title KIP
ids, and each login's public profile name, in the month objects the profile
already reads. This amendment is what the profile does with them.

### One taxonomy, one aggregation (Behavior 6, W46, W47)

`packages/reference-pipeline/src/people/areas.ts` holds the per-community
taxonomy and the aggregation; review metadata (this amendment) and the
activity log's thread labels (slice 2b) both go through them, so a label is an
area or not in the same way everywhere. Slice 2b's process-label list moved
there unchanged and was extended from the measurement in Spec 022's amendment
(label lists, auto-labeler configurations, 603 Kafka and 2,293 DataFusion pull
requests of 2026-09-15 to 2026-10-14):

| Community | Areas | Process labels (never an area) | KIP |
| --- | --- | --- | --- |
| Kafka | every other label; in practice the 21 path labels of `.github/configs/labeler.yml` (`clients`, `core`, `tests`, `streams`, `group-coordinator`, `build`, `tools`, `consumer`, `storage`, `kraft`, `connect`, …) | review status `triage`, `needs-attention`, `ci-approved`; size `small`; lifecycle `stale`, `closed-stale`, `do-not-merge`; release `backport-candidate`, `Blocker`; `admin`, `ctr`, `uniform2`; the generic `kip` | a label `KIP-<n>` or `kip-<n>` (`KIP-932`, `kip-1332`) is that KIP, not an area; with title KIP ids |
| DataFusion | every other label; in practice the 18 path labels (`sqllogictest`, `physical-plan`, `core`, `functions`, `documentation`, `optimizer`, …) | release `v<x>.<y>.<z>`, `backport`; API `api change`, `auto detected api change`; status `Stale`, `review:waiting`, `waiting-on-upstream`; issue type `bug`, `enhancement`, `regression`, `question`, `discussion`, `EPIC`, `PROPOSAL EPIC`, `tech debt`; onboarding `good first issue`, `help wanted`; bot dependency bumps `auto-dependencies` and Dependabot's `rust`, `javascript`, `python:uv` | none |

Kept as areas although they describe a kind of work more than a component
(all are path labels): Kafka `tests`, `build`, `docs`, `dependencies`,
`performance`, `docker`; DataFusion `documentation`, `development-process`,
`sqllogictest`, `dependencies`, `performance`. A label the taxonomy does not
know is an area, so a new path label appears without a change here; a new
process label needs an entry (gardening G88).

The aggregation counts **distinct pull requests (or threads) per area**; a
pull request with several area labels counts once in each, so the shares are
of label assignments, not of pull requests, and the page says so. KIP ids are
counted apart. Moving a numbered KIP label from "area" to "KIP" changed three
rows of slice 2b's W1 table (`KIP-932` now in the KIP part).

### What the profile carries (W46, W51)

- `pullAreas` (new, optional): for each pull request in `reviewsGiven` and
  `reviewsReceived` that has stored metadata, `{labels, kips?}` after the
  taxonomy (area labels only; process labels never leave the server). A pull
  request in two months takes the newer month's entry. Absent when no month of
  the view has metadata, so a `metadata@1` store answers exactly as before.
- `identity.name` (new, optional): the GitHub account's public profile name
  from the newest month that has one. Display only: it links nothing across
  sources (strict identity, decision 5, is unchanged; "Chia-Ping Tsai" on
  GitHub and the Jira or dev@ identity of the same name stay separate pages),
  and no counterpart's name is sent. A suppressed identity has no page (P-e),
  so its name is never served.
- Person search (`/api/people/:project?q=`) adds `name` to a result the same
  way (W52).

### The page (W48–W53)

Section 5, Areas, gets one block per side, each only when that side has pull
requests in the selected period (12 months or 90 days):

- **Pull requests reviewed** (reviews given) and **Own pull requests reviewed
  by others** (reviews received).
- Every pull request of the side covered: a donut of the six largest areas and
  "Other" (其他: the sum of the rest's assignments, its labels listed under the
  chart), with the number of pull requests in the centre. The same slices are
  listed as text with count and share; the `svg` is `role="img"` with an
  `aria-label` naming every slice; colours are the app's area tokens
  (`--area-1`…`--area-6`, `--area-other`). One line states the definition
  ("a pull request with several area labels counts in each; percentages are of
  label counts; process labels are left out"), how many pull requests have no
  area label, and up to five KIP ids.
- Some pull requests without metadata (months the refresh has not reached):
  **no chart**; "Area labels cover X of Y pull requests so far …". A partial
  chart would show the shares of the newest months as if they were the year's.
- The activity log's own label list (slice 2b) stays below, headed "Threads in
  the activity log", computed by the same aggregation.
- Header: the GitHub avatar (56 px) beside the public name as the heading, the
  login beneath it; without a name, the login is the heading as before.
  Search results and the "Works with" names also show the avatar (32 and 20
  px).

**Avatar.** `https://avatars.githubusercontent.com/<login>?s=<2 × size>`,
loaded by the visitor's browser: nothing stored, no API call, no request from
our servers. The URL is built only from a string that passes GitHub's login
rule (`[A-Za-z0-9][A-Za-z0-9-]{0,38}`), so nothing else reaches `src`; the
image has `width`, `height`, `alt`, `loading="lazy"`,
`referrerpolicy="no-referrer"`, and falls back to a neutral initial when it
fails. The app sends no Content-Security-Policy today (no `_headers`, no
header in the Functions), so no policy needed a change. **Privacy:** viewing a
profile makes the visitor's browser contact GitHub's avatar host (it learns
the visitor's IP address and that the avatar was requested, not the page,
because no referrer is sent). Dev only, like every profile (P-g).

P-a is unchanged: the shares are of one person's own label counts, never a
comparison between people.

### Example: `m1a2st` and `chia7712` (W54)

Public read of 2026-10-15 01:57–01:58 UTC; sample: pull requests found by
`repo:apache/kafka is:pr reviewed-by:<login> -author:<login> updated:>=2026-07-15`
(reviewed) and `repo:apache/kafka is:pr author:<login> updated:>=2026-07-15`
(authored), every result read (`incomplete_results` false). The search cannot
filter by review time, so this is "pull requests he reviewed that were updated
since 2026-07-15", not the profile's 12-month period; the Dev page after the
refresh will show the 12 months. Computed by an independent script and
reproduced exactly by `areaDistribution` with the Kafka taxonomy.

| Person, side | PRs | Label assignments | No area label | Six largest (PRs, share of assignments) | Other | KIPs |
| --- | --- | --- | --- | --- | --- | --- |
| `m1a2st` ("Ken Huang"), reviewed | 155 | 326 | 4 | `tests` 65 (19.9%), `streams` 42 (12.9%), `core` 38 (11.7%), `clients` 36 (11.0%), `build` 31 (9.5%), `storage` 24 (7.4%) | 90 (27.6%): `tools` 15, `dependencies` 11, `tiered-storage` 11, `connect` 10, `docs` 9, … | KIP-909 1, KIP-932 1, KIP-1232 1, KIP-1332 1 |
| `m1a2st`, authored | 41 | 60 | 7 | `core` 14 (23.3%), `clients` 12 (20.0%), `build` 8 (13.3%), `tests` 8 (13.3%), `consumer` 6 (10.0%), `tools` 5 (8.3%) | 7 (11.7%) | KIP-909 1, KIP-1284 1 |
| `chia7712` ("Chia-Ping Tsai"), reviewed | 390 | 724 | 28 | `clients` 105 (14.5%), `tests` 103 (14.2%), `core` 94 (13.0%), `streams` 68 (9.4%), `build` 62 (8.6%), `tools` 47 (6.5%) | 245 (33.8%): `storage` 34, `docs` 27, `consumer` 26, `connect` 25, `docker` 25, … | KIP-932 12, KIP-909 3, KIP-1071 2, KIP-1241 2, KIP-1265 2 |
| `chia7712`, authored | 1 | 0 | 1 | none: a side with no area label says so instead of a chart | | |

On the page "authored" is narrower: own pull requests that someone reviewed
(the review store has no others; slice 2b's log has the rest).

### Cost

No new R2 read: the fields are in the month objects the profile reads (W29).
The response grows by one entry per distinct pull request (about 40 bytes;
`chia7712`'s 994 reviewed pull requests: about 40 KB on about 340 KB) and one
name. Avatars: one image request per visible person to GitHub, from the
browser, lazy; none to our servers.

## Amendment 2026-10-16 (5): the top of the profile as a chart and tiles

Owner, 2026-10-16, on the Dev profile of `Parkerhiphop`: "最上面一欄能夠更直觀一點嗎？
希望有個由左到右的長條圖 bar chart 顯示 over time，然後是文字 activity。現在的有點沒有
衝擊感。" A static mockup built from the real Dev response of
`github:Parkerhiphop` and `mail:andrew schofield` was approved the same day
("設計的不錯，很清楚，可以套用到 dev"). This amendment is that design. It changes
only the page: the response, the reads and Prod (W25) are unchanged; the chart
and the tiles are computed from the response the page already has (W65).

### What was wrong with the top of the page

1. No hierarchy: the key numbers ("16 reviews on 12 pull requests") were
   body-sized link text, all with equal weight.
2. "Over time" was a vertical table of up to 14 rows with an unlabelled bar:
   time read top to bottom, and "—" (not recorded) beside "0" was unclear.
3. The coverage chips with date ranges competed with the name.
4. The trend came after the counts, below the fold on a phone.

### The page, in order (W56, replaces the order of W5)

| # | Section | Content |
| --- | --- | --- |
| 1 | Header (`header`) | GitHub avatar (GitHub identities), public name or display name, a source badge with the login (linked upstream) and "Activity in <community>", the 12 months / 90 days toggle; below, one plain sentence for the selected period (`.person-summary`): GitHub "Past 90 days: reviewed 12 pull requests, opened 4 pull requests (2 merged), commented in 2 threads"; Jira "…: reported N issues, commented N times on N issues"; dev@ "…: wrote N dev@ messages in N threads". A source whose coverage starts inside the period adds "(<source> recorded since <date>)" |
| 2 | Activity over time (`over-time`) | The chart (below), its legend, the collapsed "Data range" line, and "Show as table" |
| 3 | Activity (`activity`) | Count tiles (below) |
| 4 | Areas (`areas`) and Works with (`works-with`) | Side by side from 720 px, stacked below |
| 5 | Threads (`threads`) | Unchanged |
| 6 | Identities (`identities`) and How this is computed (`how`) | Unchanged, moved to the bottom: they explain the page rather than describe the person |

### The chart (W57–W61)

- **Buckets, left to right.** One column per month in the 12-month view and
  per week (Monday, UTC) in the 90-day view, from `profileView`'s `overTime`.
  The 12-month view always has 12 columns ending with the current month, and
  the 90-day view starts at the week of 90 days before now: a bucket the
  response has no row for is "not recorded" in every series, not absent, so a
  dev@ identity with 35 days of data shows ten months not recorded instead of
  a two-column chart.
- **Series, strict identity.** GitHub: above the axis, stacked, what the
  person did: reviews given and the activity log's GitHub records (pull
  requests, issues, comments); below the axis, mirrored, reviews others gave
  on their pull requests. Received reviews are not the person's own work, so
  they are not added to the stack (Parker received 30 in August and gave 6).
  Jira: Jira records only; dev@: dev@ messages only.
- **One scale.** Both directions share one unit, from 0, ticks at a step of
  1, 2 or 5 × 10^k (at most about three above the axis), so a review given and
  a review received of the same count are bars of the same height. The total
  is written above each column and below each received bar.
- **Not recorded.** A value with no coverage is null, never 0. Where none of
  the person's own series is recorded, the columns are a hatched band labelled
  "Not recorded yet" (尚未記錄). Where only some are, a thin coverage lane under
  the axis shows, per series, the buckets recorded (solid) and not (hatched).
  A bucket that starts before a series' coverage (or before the period) says so
  in its tooltip ("GitHub activity recorded since 9/10").
- **Text alternative.** The `svg` is `role="img"` with an `aria-label` that
  names the period, the series, and the busiest bucket; "Show as table"
  (以表格檢視) toggles a table with one row per bucket and one column per
  series, "Not recorded yet" where null. Each column has a tooltip with every
  series of the bucket.

### The tiles (W62)

Large numbers with a short label, a one-line detail, and the series colour:

| Identity | Tiles |
| --- | --- |
| GitHub | Reviews given (on N pull requests · approved, changes requested, commented, inline comments); Reviews received (on N pull requests · from N reviewers); Pull requests opened (N merged); Comments (on N threads, N on their own); Issues opened only when not 0 |
| Jira | Issues reported; Comments; Issues taken part in |
| dev@ | dev@ messages (in N threads); [DISCUSS] threads; [VOTE] threads |

A tile whose source is not recorded shows "Not recorded yet" in place of the
number. A tile whose source's coverage starts after the period's start adds
"recorded since <date>". Four columns from 720 px, two below; three tiles stay
three columns down to 340 px.

### Data range (W63)

The chips under the name are replaced by one collapsed line under the chart:
"Data range: Reviews since 11/1 · Comments, pull requests since 9/10". Opened,
it lists each source's coverage with the texts of W27 and the period with its
days (W5's "<from> to <until> · <n> days of data").

### Example (Dev, 2026-10-15 20:03 UTC release, read 2026-10-16)

`github:Parkerhiphop`, 90 days: 14 weekly columns from the week of 07-13;
reviews given 16 on 12 pull requests, received 50 on 14 from 9 reviewers,
4 pull requests opened (2 merged), 2 comments on 2 threads; GitHub activity
recorded from 2026-09-10, so the lane is hatched for the eight weeks before
09-07 and the week of 09-07 says "recorded since 9/10". 12 months: the
received bar of 2026-08 (30) sets the scale (step 10, 30 below, 20 above).
`mail:andrew schofield`, 12 months: 2025-11 to 2026-08 one hatched band,
2026-09 19 messages, 2026-10 4. The chart's case file uses these counts
(numbers only, no identity) as its `dev-shaped` rows.

## Slices

Reviews first (decision 7, 2026-10-14), then the smallest useful page. Each
slice is one PR with its own verifier pass.

| Slice | Content | Proves | IDs |
| --- | --- | --- | --- |
| 1 | GitHub review ingestion (metadata): its own spec, **Spec 022** ([PR #70](https://github.com/unknowntpo/oss-knowledge-base/pull/70), merged 2026-10-14 with `GITHUB_REVIEWS` off), with its own acceptance items. It must be enabled on Dev and have run before slice 2 is shown | Reviews a person gave are stored per pull request with state and time, inside the request budget | W20; Spec 022's own items |
| 2a (2026-10-15) | Review activity read from slice 1's month objects (`internal/github-reviews/v1/<projectId>/<YYYY-MM>.json`), not stored a second time; identity = (source, string), GitHub only; `/api/people/:project/:id`; the page with sections 1–8 and per-source coverage; GitHub author names in Detail link to it, Dev only | A review profile is correct against the store, states what it does not cover, and costs at most 13 R2 reads cold | W5, W6, W8, W10–W13, W18, W23–W29 |
| 2b | Activity log written at publish time from the events the pipeline already has; the profile reads it beside the reviews; Jira and dev@ identities get pages; their author names link | A per-source profile is correct against the Example and grows by a day per day | W1–W4, W9, W17, W19, W22, W34 |
| 3 | Person result in Search: exact login first, then login prefixes, at most three; `/api/people/:project?q=` reads the review store's cached months (2026-10-15 amendment) | A login leads to the page in one step, thread ranking unchanged, no metered call | W7, W40–W45 |
| 4 | Stable keys (GitHub id, Jira account key), roster links, `identityLinks`, the labelled sample, "possibly the same person" | Zero wrong merges on the sample | W14–W16 |
| 4a (amendment (7), 2026-10-21) | KIPs a person started (request time); Jira `assignee` and account keys; the identity-link job and its `corroborated` links; the precision check; the `kip-pages` job (KIP-page author lists); the committers page as `declared` links; the page section behind `PEOPLE_KIPS` | A person's KIPs (any author, or the starter) are listed with the basis of every line and link, and no corroborated link contradicts the truth set | W66–W112; W16 extended |
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

## Amendment 2026-10-21 (7): KIPs a person started, and corroborated links

Owner's request (2026-10-21): a person's profile lists the KIPs they
authored, and identities on different sources may be linked by repeated,
deterministic co-occurrence, not only by the roster or a declared entry.
Decisions of the owner, the same day (decision 11):

1. "Authored" means **started the discussion**: the sender of the first
   message of the earliest `[DISCUSS] KIP-n` thread on dev@, within the
   recorded range. Confluence is not read. *Revised the same day by the
   owner's multi-author requirement: a KIP can have several authors, and the
   KIP page's own author list comes first. See
   [KIP authors](#kip-authors-several-per-kip-revision-2026-10-21).*
2. A third link basis, **`corroborated`**: repeated co-occurrence on shared
   identifiers (`KAFKA-n`, `KIP-n`), deterministic, no model. Thresholds 3
   and 2 are provisional until a precision check passes.
3. "One job must not carry too many tasks": linking is **its own job**, with
   its own trigger, inputs, output, budget, `/health` status and failure
   isolation. It is not a step of the publication or of the activity append.
4. Profiles read the job's link table behind a flag, Dev first; Prod is a
   separate owner-approved step (after amendment (6)'s profile tag).
5. Public pages only; every link shows its basis; a link can be removed and
   the next run splits the profile.

This amendment revises precision rule 2 of the Intent, decision 5, rule 2
of [Identity resolution](#the-rule), and step 5 of the simplification
review ("No job proposes links"). Rules 3 and 4 stand: no similarity, no
fuzzy matching, no email, no login equal to an ASF id. It is specified
only; nothing is implemented.

### Example (real data, read 2026-10-21)

Dev release `2026-10-20T22:07:19Z` (anonymous `/api/feed` and
`/api/detail`; the activity log's Kafka coverage starts
`2026-09-10T02:45:16Z`, `/health`), plus read-only public upstream calls:
GitHub search, ASF Jira REST, Pony Mail `stats.lua`, and the Kafka
committers page. No R2 object was read.

**(a) Who started which KIP.** The release holds 21 dev@ threads whose title
is a `DISCUSS` title naming one KIP. In 11 the oldest recorded message is a
root (its subject has no `Re:`); in 10 every recorded message is a reply.

| KIP | Starter in the data | Root | Note |
| --- | --- | --- | --- |
| KIP-1377 | Aditya Kousik | 2026-09-17 | |
| KIP-1342 | Ming-Yen Chung | 2026-09-18 | |
| KIP-1378 | Edoardo Comar | 2026-09-18 | title `DISCUSS: KIP-1378 …`, no brackets |
| KIP-1371 | Eric Chang | 2026-09-22 | |
| KIP-1379 | David Jacot | 2026-10-02 | |
| KIP-1165 | Viktor Somogyi-Vass | 2026-10-05 | the only `[DISCUSS] KIP-1165` thread Pony Mail returns for 2024-01 to 2026-10; the KIP page lists nine authors, Viktor last; the page was created by Ivan Yurchenko (see [KIP authors](#kip-authors-several-per-kip-revision-2026-10-21)) |
| KIP-1376 | Mickael Maison | 2026-10-06 | 18 messages |
| KIP-1381, KIP-1382 | Arnab nandy | 2026-10-16 | two KIPs, one person |
| KIP-1384 | PoAn Yang | 2026-10-20 | |
| KIP-1383 | Andrew Schofield | 2026-10-20 | |
| KIP-1368, 1262, 1374, 1325, 785, 1324, 1163, 1153, 1349, 1365 | none | | replies only. KIP-1163 was started 2025-04-23 by Ivan Yurchenko, before the coverage: nobody is credited, which is correct for "within the recorded range" |

KIP-1153 was used twice in 2025 (Pony Mail: pritam kumar on 2025-04-04,
Connect microsecond precision; 黃竣陽 on 2025-04-12, a Streams KIP). The
earliest thread wins, so a renumbered KIP credits nobody for the reused
number. Both are before the coverage anyway.

**(b) GitHub ↔ Jira through `KAFKA-n`.** 270 apache/kafka pull requests
created 2026-09-15 to 2026-10-21 name a `KAFKA-n` in their title (221
distinct keys; 205 assigned in Jira). Pairing each pull request's author with
the Jira assignee of the key gives 77 logins, 80 Jira accounts and 89 pairs.

| Pair | Distinct `KAFKA-n` | Largest competing pairing | Strict (no competitor) | Dominance 3 |
| --- | --- | --- | --- | --- |
| `chickenchickenlove` ↔ JIRAUSER303328 "sanghyeok An" | 19 | 0 | link | link |
| `harmadasg` ↔ JIRAUSER306203 "Gergely Harmadás" | 10 | 2 (`m1a2st` opened 2 pull requests on his issues) | no | link |
| `unknowntpo` ↔ JIRAUSER306218 "Eric Chang" | 5 | 0 | link | link |
| `dybyte` ↔ JIRAUSER312871 "Doyeon Kim" | 5 | 1 (one issue assigned to `chia7712`) | no | link |
| `dajac` ↔ `dajac` "David Jacot" | 3 | 0 | link | link |
| `brandboat` ↔ `brandboat` "Kuan Po Tseng" | 3 | 1 (`Alwaysgaurav1` on one of his issues) | no | link |
| `m1a2st` ↔ JIRAUSER306203 / JIRAUSER305187 "Ken Huang" / JIRAUSER300229 "PoAn Yang" | 2 / 2 / 1 | — | no | no |
| `dybyte`, `dino2895`, `jim0987795064` ↔ `chia7712` "Chia-Ping Tsai" | 1 each | — | no | no |
| `see-quick` ↔ `mimaison` / JIRAUSER301401 "Maros Orsak" | 1 / 1 | — | no | no |

28 pairs reach 3 keys. With no competitor at all, 21 qualify; the other 7
(`harmadasg`, `dybyte`, `nileshkumar3`, `gitedmond`, `egyedt`, `dino2895`,
`brandboat`) each lose to one or two pull requests someone else opened on
their issues: exactly the committer-or-peer pattern the owner named. The
known false-positive patterns stay unlinked under both rules: a committer
assigned to issues others fixed (`chia7712`), and a contributor splitting
work across three people's issues (`m1a2st`).

**(c) Jira ↔ dev@ through `KIP-n`.** Of the 11 starters, three have a Jira
issue whose **summary** names the KIP, with the starter's name as reporter
or assignee: KIP-1371 (KAFKA-20995, reporter and assignee JIRAUSER306218
"Eric Chang"), KIP-1378 (KAFKA-21127, `ecomar` "Edoardo Comar"), KIP-1379
(KAFKA-21200, `dajac` "David Jacot"). All three issues are in the Dev
release. Each is one KIP, so **none reaches 2** in today's coverage.
KAFKA-20728 names KIP-1376 only in its description; its reporter (Netan
Mangal) and assignee (Arnab Nandy) are not the starter (Mickael Maison).
That is why the rule reads the summary only, although the log's Jira `kips`
also come from the description.

**What the rule would show today.** `mail:eric chang` lists KIP-1371 (no
link needed). `github:unknowntpo` is linked to Jira "Eric Chang"
(corroborated, 5 keys) but not to `mail:eric chang` (1 KIP < 2), so the
GitHub page lists no KIP until a second KIP or a declared link. `dajac`
qualifies on GitHub ↔ Jira; Jira lists a second KIP of his in the last 365
days (KIP-1319), whose `[DISCUSS]` root is before the coverage. Transitive
GitHub ↔ dev@ links today: 0.

### Started a KIP discussion (the rule)

1. A dev@ thread is a KIP discussion when its title (reply prefixes removed,
   `threadTitle`) starts with `[DISCUSS]` or `DISCUSS:` (any case) and names
   exactly one KIP (`extractKeys`). A title naming two KIPs credits nobody.
2. Its **root** is the oldest recorded message of the thread whose subject
   has no reply prefix. A thread with no root in the data has no starter.
3. For KIP-n, the starter of the thread with the earliest root is "started
   the discussion of KIP-n". Later threads with the same number credit
   nobody.
4. Only the activity log's coverage counts. A KIP whose discussion started
   earlier is not listed for anyone, and the page says so.
5. Computed at request time from the activity months the profile already
   reads (a pure function, `kipStarters`), so the dev@ identity's own list
   needs no link and no new read. The link job uses the same function.

### What the stored data gains

| Where | Change | Why |
| --- | --- | --- |
| Activity log, dev@ `message` rows | `opens: true` when the message's subject has no reply prefix; absent otherwise | Rule 2. The thread entry's `author` is the oldest message **in the state**, which slides; a row flag is fixed once written, because rows are keyed by record id and never removed |
| Jira connector | `fields` adds `assignee`; the event keeps `reporter.key`, `assignee.key` and `assignee.displayName`, nothing else of either user object | Edge A needs the assignee's stable key; edge B the reporter's and assignee's |
| Activity log, Jira thread entries | `reporter` and `assignee`: `{key, display}` or `null` | The link job's input. The newest month's entry of an issue wins (an issue is in the month of its last update, amendment (2)) |

- Rows written before the change have no `opens` and count as "no root".
  The first run after the change rebuilds the 35 days in the state, so
  starters are known from 35 days before that run (W83).
- **Privacy of the Jira account key.** ASF Jira's anonymous REST response
  carries `key` (`dajac`, `JIRAUSER306218`), `name`, `displayName`,
  `timeZone`, `avatarUrls` and `active`, and no email. Only `key` and
  `displayName` are kept. `timeZone` would be a derived attribute (P-k);
  `name` is not needed. The key is stored only in internal objects and
  appears in no `/api/feed`, `/api/detail` or `/api/people` response; pages
  show display names and link to the Jira issues. No email or address part
  is stored or matched (P-c; rule 4 unchanged).
- Jira person ids stay `jira:<name key>` until slice 4 switches them (G76);
  the link table names Jira accounts as `jira-account:<key>` with the
  display name beside it.

### The `corroborated` rule

Thresholds live in the community profile (`PeopleProfile.corroboration`,
Kafka: `{issueKey: "KAFKA-", minIssues: 3, dominance: 3, minKips: 2}`;
DataFusion: none, so the job skips it). The rule revision is
`corroborated@1`; changing a number is a new revision and needs a new
precision check.

**Edge A, GitHub ↔ Jira, through `KAFKA-n`.**

1. For every pull-request thread in the activity months, the `KAFKA-n` keys
   in its title, read with the Kafka search profile's identifier pattern
   (`compileIdentifierProfiles(searchIdentifierProfiles).identifiersOf`,
   Spec 016), are paired with the thread author's login. Bot authors and
   unassigned issues give nothing.
2. Each key is paired with its Jira assignee's account key (newest entry).
   A pair `(X, Y)` counts **distinct** keys, so a backport of the same key
   counts once.
3. Link `X ↔ Y` when `n(X, Y) ≥ 3` and `n(X, Y) ≥ 3 × n` of every other
   pairing of `X` and of every other pairing of `Y` ("dominance 3").

Why dominance and not "no conflict at all": the competing pairings in the
Example are single pull requests someone opened on another person's issue
(a committer finishing work, a peer taking over). "No competitor" drops 7
of 28 pairs for that alone. Dominance 3 still refuses every split pattern of
the Example (`m1a2st`: 2/2/1, `chia7712`: 1/1/1) and refuses a pair as soon
as a competitor has a third of its evidence. The residual risk is a person
who only ever opens pull requests on one other person's issues and has no
Jira assignment of their own; no conflict test can see it, so the precision
check measures it.

**Edge B, Jira ↔ dev@, through `KIP-n`.**

1. For every KIP-n with a starter (rule above), the Jira issues whose title
   (`KAFKA-n: <summary>`) names KIP-n, read with `extractKeys` on the title,
   not the stored `kips`.
2. Pair the starter's dev@ identity with the issue's reporter and assignee
   accounts whose display name has the same `nameKey` as the starter.
3. Link when a pair holds on **≥ 2 distinct KIPs** and **no competitor**:
   the dev@ identity pairs with no other Jira account, and the account with
   no other dev@ identity. Strict here because the evidence already rests on
   a name, which is user-editable and not unique.

**Components.**

- Edges join into components. GitHub ↔ dev@ exists only through a Jira
  account whose two edges qualify on their own; there is no direct
  GitHub ↔ dev@ edge.
- A component holding two GitHub logins, two Jira accounts or two dev@
  identities publishes none of its corroborated links (`conflict`).
- With roster and declared links: a corroborated link that would put two ASF
  ids, or two people the declared list keeps apart, into one component is
  dropped (`contradiction`). Roster and declared links are never dropped
  for a corroborated one.
- **Removal.** An `identityLinks` entry `{a, b, remove: true, evidence,
  date, reviewer}` suppresses that pair (declared removal); a suppressed
  identity (P-e) gets no link at all. Both take effect at the next run,
  which splits the profile; profiles are derived, never the source of truth.

### The identity-link job

| | |
| --- | --- |
| Trigger | Its own cron entry, `17 2 * * *` (02:17 UTC) in the Dev publisher Worker's configuration, dispatched by `IDENTITY_LINKS_CRON` as the digest is by `DIGEST_CRON`; and `POST /identity-links/run[?dryRun=1]` (`Bearer MANUAL_TRIGGER_TOKEN`). 02:17 is clear of the Dev publication (22:07; its retries end by about 00:00), the digest (22:47, deferred at most 4 × 15 min) and the Prod publication (22:37; retries end by about 00:30). Daily; not real time |
| Inputs (the hand-off) | Objects other jobs already write: the activity log `internal/people/v1/<projectId>/state.json` and its month objects (publication's append, amendment (2)); the roster `internal/rosters/v1/asf/<projectId>.json` (Spec 015; may be absent: then no roster links and no roster contradiction check, stated in the output); the community profile's `identityLinks` and suppression list (code). It reads no publication state, no Durable Object, no upstream API |
| Output | `internal/identity/v1/<projectId>/links.json` (`osskb.identity-links.v1`): `revision`, `generatedAt`, `inputs {coverageFrom, months[], activityUpdatedAt, rosterAt}`, `people[]` with `members[]` (`github:<login>`, `jira-account:<key>` + display, `mail:<name key>`) and `links[]` `{a, b, basis, evidence[]}`; evidence ids are `KAFKA-n` with the pull requests, or `KIP-n` with the Jira issue and the dev@ thread, each with its URL. Sorted, so equal inputs give equal bytes. Written only when the bytes change. Then `internal/identity/v1/last-run.json`, the status `/health` reads |
| Budget | Per project with a `corroboration` config (Kafka): at most 1 + 12 months + 1 roster + 1 previous table = 15 Class B and 2 Class A per run (450 B and 62 A a month, against 10 M and 1 M free). Months are read one at a time and reduced to the facts the rule needs before the next is read (Spec 009) |
| Status | `/health` `identityLinks` while `IDENTITY_LINKS` is set (W91) |
| Isolation | Runs in its own invocation; never starts, waits for, or is started by the publication or the digest; writes only under `internal/identity/v1/`. Any failed or unparsable read of a project fails that project closed: no table is written and the last good one stays (a missing month could remove a competing pairing and so create a false link). The next day's run, or a manual run, retries. Profiles read the last good table; the publication never reads it |
| Off | `IDENTITY_LINKS` unset: the cron entry and the route do nothing, read nothing, and `/health` has no field |

### Precision check before enabling

The thresholds are provisional. Before profiles read corroborated links on
any environment:

1. **Truth set.** The Kafka committers page (68 committers, each with a name
   and a GitHub login: a public statement by the project, the evidence
   kind `declared` already accepts), captured as a committed fixture with
   its date; plus the roster where the store has it.
2. **Blind run.** The rule never reads the truth set. Since the owner's
   resolution 3 writes the committers page's pairs into `identityLinks`,
   the measure command and the dry run take `--blind`, which leaves those
   `declared` entries out, so the contradiction filter cannot hide an error
   the truth set would catch (W103).
3. **Classify** every corroborated component that holds a committer's
   GitHub login, or a Jira or dev@ display name equal (`nameKey`) to a
   committer's name. `agree`: its GitHub login and its Jira or dev@ name
   belong to the same committer. `contradict`: it joins a committer to
   another committer's login or name. `unlabelled`: anything else. The
   name comparison is an oracle for the check only, never a link basis.
4. **Label the rest.** Every other corroborated link joins the labelled
   sample of W16 (same / different / unknown, from public evidence, by the
   owner).
5. **Gate.** `contradict` = 0, committer `unlabelled` = 0, and no labelled
   link "different". Recall (committers with evidence who are not linked)
   is reported, not gated.
6. **Measured twice.** Offline, from public upstream data only, by a
   committed command (`bun run measure:identity-links -- --from <date>
   --to <date>`; W89), and on Dev from the real inputs by
   `POST /identity-links/run?dryRun=1` (W90). The enable PR records the
   window, the counts, and the commit of the labelled sample.

Today's offline reading (window above): 28 corroborated links, 3 touching
committers (`bbejeck`, `frankvicky`, `dajac`), 3 agree, 0 contradict;
25 links to label. Zero errors in 3 says little; zero in 28 bounds the error
rate below about 11 % (95 %, rule of three), which is why the labelled
sample is part of the gate and the page always shows the basis.

### The page

- A section `[data-section="kips"]` after `activity`: "Started the
  discussion of" with KIP-n, the thread title, the root date and a link to
  the dev@ thread. On a dev@ identity it lists its own KIPs. On an identity
  linked to a dev@ identity it lists that identity's KIPs with the basis
  ("roster", "declared", "corroborated") and "how linked": the evidence ids
  as links.
- The identities section shows each link with its basis and evidence.
- "How this is computed" states the definition, the coverage start, that
  earlier KIPs are not listed, and the link table's `generatedAt`.
- No count of KIPs is compared with anyone; no rank (P-a).

### Flags and order

| Step | Change | Expected |
| --- | --- | --- |
| 1 | Merge PR: activity-log fields, Jira `assignee`, the identity-link job, the `kip-pages` job, `kipStarters`, the committers capture, the page section; `IDENTITY_LINKS`, `KIP_PAGES` and `PEOPLE_KIPS` unset everywhere | Nothing changes at runtime except the two stored fields (W67, W88) |
| 2 | Dev: `IDENTITY_LINKS=corroborated@1` and `KIP_PAGES=authors@1` with their cron entries | `/health` `identityLinks.lastRun.ok` and `kipPages.lastRun.ok`; both tables exist; no page reads them |
| 3 | Precision gate (offline and Dev dry run) | Recorded in the enable PR |
| 4 | Dev Pages: `PEOPLE_KIPS=true` | The section, the author lists and the linked identities appear (W74, W92, W106) |
| 5 | Prod | Separate owner approval, after amendment (6)'s profile tag |

### Simplification review

| Item | Kept? |
| --- | --- |
| Confluence KIP pages as the author source | deleted by decision 11.1, then **kept** by the owner's multi-author requirement, as its own small job ([KIP authors](#kip-authors-several-per-kip-revision-2026-10-21)) |
| A stored list of KIP starters | **deleted**: request time, from months already read |
| A separate Worker for the job | **deleted**: its own cron entry and invocation give the isolation; a second Worker adds secrets and a deploy |
| A Durable Object lock | **deleted**: the job is deterministic and writes plain puts; two concurrent runs write equal bytes |
| A shadow mode | **deleted**: the Worker flag on with the Pages flag off is the shadow |
| Jira `name`, `timeZone`, avatar | **deleted** (privacy; not needed) |
| Rejected pairs stored in the table | **deleted**: counts in `/health` only |
| Follow-up runs after a failure | **deleted**: the next day's run, or a manual run |
| Jira descriptions as KIP evidence | **deleted** (KAFKA-20728) |
| Similarity, email, model | still **deleted** (rule 4) |

### Owner resolutions (2026-10-21)

The five questions this amendment first left open, decided by the owner:

1. **Dominance 3** for edge A: accepted.
2. **Edge B stays at 2 KIPs.** `declared` links are open: the owner may
   declare his own identities with a public evidence URL. Example entry
   (a design, not yet in code; the URL is the owner's to supply):

   ```ts
   // identityLinks (Kafka PeopleProfile)
   { a: "github:unknowntpo", b: "mail:eric chang", basis: "declared",
     evidence: "TODO(owner): public URL where Eric Chang states the GitHub login unknowntpo",
     date: "2026-10-21", reviewer: "unknowntpo" }
   ```

   An entry whose `evidence` is not an `https` URL is rejected by the
   profile's validation, so the entry is added only with its URL (W104).
   With it, `github:unknowntpo`, Jira JIRAUSER306218 (corroborated, 5 keys)
   and `mail:eric chang` are one person, and the GitHub page lists KIP-1371.
3. **The committers page is the truth set and `declared` evidence.** Its
   68 name ↔ GitHub-login pairs are written into `identityLinks` as
   `{a: "github:<login>", b: "mail:<name key>", basis: "declared",
   evidence: "https://kafka.apache.org/committers", date: <capture date>,
   reviewer: <who reviewed the PR>}`; a name that appears twice on the page
   gives no entry (the roster's uniqueness rule). They are kept in a
   committed capture beside the Kafka profile, with its date.
   - **Refresh**: a manual command, `bun run refresh:committers`, reads the
     page once and rewrites the capture; it prints the pairs added, removed
     and changed. The owner reviews that diff in a PR; the PR's reviewer and
     date go into the changed entries. No cron reads the page.
   - **Removal**: a pair no longer on the page is deleted from the capture
     in that PR (not kept as `remove: true`, which is for a pair the page
     still states but the owner knows to be wrong). The next identity-link
     run splits the profile.
   - **Staleness**: `/health` `identityLinks.lastRun.inputs.committersAt`
     names the capture date; the identity-link job states it, nothing alerts.
   - The precision check runs blind of these entries (step 2 above).
4. **Naming the starter when the page lists other authors**: accepted, and
   superseded by the multi-author design below: the page shows the KIP
   page's author list first and "started the discussion" only as a fact
   of its own.
5. **Jira account keys on Prod** are folded into decision 8 (terms and
   privacy check), still open. Names read from KIP pages join it.

### KIP authors: several per KIP (revision, 2026-10-21)

Owner's requirement (2026-10-21): a KIP can have several authors; a
profile lists every KIP where the person is any author, not only the one
who started the discussion. Investigated with public data only (Confluence
REST API of `cwiki.apache.org` and Pony Mail, anonymous, read-only, about
60 requests; no R2 read, no deploy).

**What the KIP pages carry (read 2026-10-21).**

| Question | Finding |
| --- | --- |
| How many KIP pages | 1,402 pages in space `KAFKA` with "KIP" in the title (CQL `space=KAFKA and type=page and title~"KIP"`). Exact titles are needed for `/content?title=`; `content/search` with CQL finds them by number |
| Does the template name authors | No. Its header is `Current state`, `Discussion thread`, `JIRA` (and sometimes `Released`). 0 of 30 recent pages have an author field from the template |
| Pages with an explicit author line | **31 of 1,402** (2.2 %) have an `Author:`, `Authors:` or `Co-Author:` line before the first heading (61 pages contain the word at all). 21 of the 31 name two or more authors. In the 30 newest pages (KIP-1355 to KIP-1385, created 2026-05-31 to 2026-10-20) **1** has one: KIP-1360, four authors |
| The forms of the line | 21 plain name lists; 6 Confluence user mentions (`<ri:user ri:userkey=…>`, KIP-137, 236, 952, 1113, 1255, 1258), whose names appear only in the rendered view (`body.view`); 3 with an email address in the line (KIP-1115, 1183, 1300); 1 that is not a list (KIP-986, "None of the below contents is final…"). Other labels exist beside it: "Collaborators" (KIP-950), "Contributors" (KIP-578) |
| KIP-1165 | `Authors: Greg Harris, Ivan Yurchenko, Jorge Quilcate, Giuseppe Lillo, Anatolii Popov, Juha Mynttinen, Josep Prat, Filip Yonov, Viktor Somogyi-Vass`. Page created by Ivan Yurchenko (2025-04-16); the recorded `[DISCUSS]` root (Viktor, 2026-10-05) opens "Updated the reopened KIP-1165". KIP-1150, 1163, 1164 and 1181 carry the same nine-name family |
| KIP-1371 | No author line; created by Eric Chang, 22 versions, all by him |
| Creator (`history.createdBy`) | Equals the recorded dev@ starter on 9 of the 10 KIPs that have both (KIP-1371, 1376–1379, 1381–1384); differs on KIP-1165. Elsewhere the creator is not an author: KIP-1026 was created by Divij Vaidya, `Author: Arpit Goyal` |
| Editors (`history.contributors.publishers`) | 27 of the 30 newest pages have one editor, the creator. 3 have a second, a committer: Andrew Schofield on KIP-1381 and KIP-1382 (Arnab Nandy's), Matthias J. Sax on KIP-1357 (Gabriella Fu's). KIP-1360 lists four authors and has one editor; KIP-1165 lists nine and has four. **Editors are not authors**, and authors need not edit |
| What a Confluence user exposes | `type`, `username`, `userKey`, `displayName`, `profilePicture`; no email and no ASF id field. `/rest/api/user` answers 403 anonymously. The username equals the GitHub login for some (`unknowntpo`, `chickenchickenlove`, `m1a2st`), the ASF id for some (`dajac`, `mjsax`, `schofielaj`), and neither for others (`mickael.maison`, ASF id `mimaison`). Equality is not a link basis (rule 4), so the username is neither used nor stored |
| One person, several written names | "Henry Cai" on KIP-1272's page, "Henry Haiying Cai" on its dev@ root; "Viktor Somogyi" (Confluence display name) and "Viktor Somogyi-Vass" (author line, dev@); "Gergely Harmadas" (KIP-1134) and Jira "Gergely Harmadás"; "Viquar Khan" and "Vaquar Khan" on two pages by one creator. Exact `nameKey` leaves these unlinked (recall), never merges |
| Co-author signals on dev@ | Of six multi-author `[DISCUSS]` roots read (KIP-1134, 1150, 1165, 1254, 1272, 1279), four say "we" or "our"; one signs with three names ("Henry Cai, Tom Thornton and Greg Harris" for KIP-1272, where the page says "Thomas Thornton"); none has a structured field. The activity log keeps no bodies. Not used |
| Cost | One `content/search` request with `expand=body.view,version` returns up to 50 pages: pages modified in the last 30 days, 25 pages, 0.97 MB, 2.9 s; last 7 days 10 pages; last day 5; last 365 days 225 pages. Mean stored body 24 KB. No rate-limit headers are sent |

**Conclusion.** An explicit author list is rare but present exactly where a
KIP has several authors (21 of the 31). The template, the creator and the
editors cannot replace it (KIP-1026, KIP-1165, KIP-1357). dev@ has no
structured co-author signal. So the KIP page's line is the only author list,
and the dev@ starter remains the fallback for the 98 % of pages without one.
The simpler alternative (dev@ starter only) cannot meet the requirement:
KIP-1165 would list one of nine authors.

**Sources and precedence.** For a KIP and an identity, the page shows one
line, with the first basis that holds:

| Order | Basis | Label on the page | Source |
| --- | --- | --- | --- |
| 1 | The KIP page's author line names the person (resolved below) | "author (KIP page)" | Confluence, the `kip-pages` job |
| 2 | The person is the assignee of a Jira issue the KIP page's `JIRA:` field names ([the KIP's Jira issue](#the-kips-jira-issue-owner-input-2026-10-21)) | "assigned the KIP's Jira issue (KAFKA-n)" | the KIP page's field and ASF Jira, the `kip-pages` job |
| 3 | The person started the discussion ([the rule](#started-a-kip-discussion-the-rule)) | "started the discussion" | dev@, request time |

A person who holds several shows the first label and the others as "also
…" ("also assigned KAFKA-n", "also started the discussion"). A starter whom the page's list does not name (KIP-1272: "Henry
Haiying Cai" against "Henry Cai") still gets line 2: both are facts with
their sources. The page creator, the editors, "Collaborators" and
"Contributors" are never authorship.

**Reading the author line (W93).** In the rendered view of the page, the
first block element (paragraph or table cell) of the page header
whose text starts with `Author`, `Authors`, `Co-Author` or `Co-Authors` and
a colon (any case) is the line. Its value is split at user mentions (each
rendered mention is one name), commas, semicolons, `&` and the word `and`.
Any part holding `@` or angle brackets is removed with its brackets
(KIP-1183: `xinyu<xinyuzhou@ automq.com >` gives "xinyu"); parentheses are
removed and their content becomes its own part. A part is a name when it has
1 to 5 words of letters (any script), spaces, `.`, `-` and `'`. If any part
is not a name, the page's status is `unparsed` and **no** author is taken
from it, never a partial list. No line: status `no-list`.

*Page header (slice B, 2026-10-21, from the recorded pages).* "Before the
first heading" missed most lines: the template's header sits under a
`Status` heading (KIP-1026's `Author:`, KIP-1183's and KIP-1258's lines and
every `JIRA:` field are below it), and some pages put a title heading above
`Status` (KIP-1381). The header is therefore everything before the first
heading that follows the `Status` heading, or before the first heading when
the page has no `Status` heading (KIP-1165, KIP-1279 put the line above
`Status`). KIP-986's block reads "To Co-Authors: None of …": it does not
start with the label, so the page is `no-list` (no author either way); the
`unparsed` case is a constructed row.

**From an author name to a profile (W95).** An author name is a credit, not
an identity: it never creates a profile and never joins two identities. Its
`nameKey` `k` links to a profile only through:

1. a `declared` entry naming `mail:k` (the committers page's pairs and the
   owner's own entries), then that person's other identities through the
   link table;
2. `mail:k` having written a message, within the activity log's coverage,
   in a dev@ thread whose title names exactly that KIP (label "named on the
   KIP page, wrote in its discussion"). Same KIP plus same exact name, the
   evidence edge B already accepts; the risk is a namesake who discussed
   that very KIP, and the page shows the basis.

Anyone else is shown as a plain name in the KIP's author list. Author lines
never feed the `corroborated` rule (edge B keeps the starter only).

**The `kip-pages` job.** Its own job, not a step of the publication or of
the identity-link job ("one job must not carry too many tasks").

| | |
| --- | --- |
| Trigger | Its own cron entry `43 3 * * *` (03:43 UTC) in the Dev publisher Worker, dispatched by `KIP_PAGES_CRON`; and `POST /kip-pages/run[?dryRun=1]` (`Bearer MANUAL_TRIGGER_TOKEN`). Clear of Dev publication 22:07 (retries end about 00:00), digest 22:47, Prod 22:37 (retries end about 00:30), identity links 02:17, retention 10:17. Daily |
| Upstream | (1) `GET https://cwiki.apache.org/confluence/rest/api/content/search` with CQL `space=KAFKA and type=page and title~"KIP" and lastmodified >= "<since>" order by lastmodified asc`, `expand=body.view,version`, `limit=50`. `since` = the last good run's start minus one day; first run: 365 days ago. Pages are keyed by page id; an entry is replaced when `version.number` changes; the KIP number comes from the title (`^KIP-(\d+)`), a page without one is skipped. (2) `GET https://issues.apache.org/jira/rest/api/2/search` with `jql=key in (<up to 100 keys>)`, `fields=assignee`, `validateQuery=warn` (an unknown key is dropped instead of failing the query: checked, a plain query answers 400), for the `JIRA:` keys of pages new or changed in this run, and on Mondays for every key in the table (W108) |
| Budget | At most **10 cwiki requests and 3 Jira requests** per run, sequential, at least 2 s apart, 30 s timeout each, a `User-Agent` naming the project and its URL. Measured: first run 5 cwiki requests (225 pages) and 2 Jira requests (about 160 keys), a normal day 1 and 0–1, a Monday 1 and 2. On a Monday the re-read takes the changed pages' keys first, then the table's keys with the oldest reading, up to 300, so the re-read alone never exceeds 3 requests (slice B). R2: 2 Class B (previous table and `last-run.json`, which carries `lastGoodAt` for `since`; slice B) and at most 2 Class A per run |
| Politeness | No retry within a run; a 429 or 5xx ends the run. Needing an 11th request ends it as `over-budget` (the next day starts from the same `since`). Anonymous only |
| Output | `internal/kips/v1/<projectId>/authors.json` (`osskb.kip-authors.v1`): `generatedAt`, `coverageFrom`, `pages[]` `{kip, pageId, version, title, url, status (listed, no-list, unparsed), authors[] {name, nameKey}, jira (one, several, empty, query, none), issues[] {key, assignee {key, display} or null, readAt}}`. Sorted; written only when the bytes change; then `internal/kips/v1/last-run.json` |
| Privacy | Names only from Confluence: no username, user key, email, avatar or body text is stored; parts holding `@` are dropped before storing (W102). From Jira only the assignee's `key` and `displayName`, as amendment (7) already keeps them; no reporter, `name`, `timeZone`, avatar or email (W110) |
| Status | `/health` `kipPages` while `KIP_PAGES` is set (W100) |
| Responsibility | One: the facts a KIP page states (its authors and the issues its `JIRA:` field names, with each issue's assignee). It joins nothing; identity links stay with the identity-link job, which still calls no upstream API |
| Isolation | Its own invocation; never started by, waiting for or starting another job; writes only under `internal/kips/v1/`. Any failed request or unparsable response fails the run closed: no table is written, the last good one stays (W97, W98, W108). The publication and the identity-link job never call cwiki |
| Off | `KIP_PAGES` unset: the cron entry and the route do nothing, read nothing, and `/health` has no field (W99) |
| Projects | Kafka only (`PeopleProfile.kipPages: {space: "KAFKA", titlePrefix: "KIP-"}`); DataFusion has none |

### The KIP's Jira issue (owner input, 2026-10-21)

Owner's input: "A KIP links a Jira issue, and usually the author is its
assignee." Measured from public data on 2026-10-21: all 1,402 KIP pages in
29 cwiki search requests (`body.storage`, 2 s apart), 274 Jira issues in 3
requests (`fields=assignee,reporter`), the `[DISCUSS]` roots of dev@ for two
years from one Pony Mail request (298 roots), and the committers page. No R2
read, no deploy.

**The `JIRA:` field (all 1,371 pages titled with a KIP number).**

| Field | Pages | Note |
| --- | --- | --- |
| One `KAFKA-n` | 1,160 (85 %) | KIP-1371 → KAFKA-20995, KIP-1360 → KAFKA-20715, KIP-1165 → KAFKA-19161, KIP-1026 → KAFKA-16209 |
| Several | 45 | 36 with 2, 7 with 3, 1 with 4, 1 with 6. KIP-1370 → KAFKA-20888, KAFKA-20883 |
| Empty, "TBD", "here" or the template's KAFKA-1 | 138 | KIP-1383, KIP-1367, KIP-1361, KIP-1359, KIP-1354 among the 30 newest |
| A Jira query macro, no key | 8 | |
| No `JIRA:` field | 20 | |

Pages created in the last two years (281): 236 one issue, 8 several, 33
empty, 4 without the field. The 30 newest: 24 one, 1 several, 5 empty.

**Agreement (pages of the last two years with one issue: 236).**

| Comparison | Result |
| --- | --- |
| Assignee set | 219; unassigned 17 (7 %) |
| Assignee = page creator (exact `nameKey`) | 180 of 219 (82 %) |
| Assignee among the author line's names (pages with a line and one issue) | 12 of 12 assigned; 1 more unassigned (KIP-1360) |
| Reporter among the author line's names | 12 of 13 |
| Assignee vs the dev@ starter (208 pages with a starter; 12 unassigned) | of 196: **126 exact** `nameKey`; 24 the same name in another written form ("TaiJuWu" / "TaiJu Wu", "fujian" / "jian fu", "Maros Orsak" / "Maroš Orsák"); 16 in another script ("sanghyeok An" / "안상혁"); **30 different names** |
| The 30 different names | the starter is a committer in 10 (Mickael Maison started KIP-1376, assignee Arnab Nandy; Andrew Schofield KIP-1313, assignee Alan Lau; Lucas Brutschy KIP-1251, assignee Lucy Liu; Bill Bejeck KIP-1221); the assignee is a committer in 3 (KIP-1311 Chia-Ping Tsai, starter Siddhartha Devineni; KIP-1136 Andrew Schofield; KIP-1101 PoAn Yang, starter "Frank Yang"); the assignee created the page in 14 |
| Reporter vs the starter | 97 of 208 exact |
| Assignee is a committer (committers page names) | 45 of 219, mostly committers' own KIPs (`dajac` KIP-1379, KIP-1319) |
| Several issues | of 8 pages with every issue read: 4 one assignee, 2 one assignee and an unassigned issue, 2 two people (KIP-1128: TengYao Chi twice and Matthias J. Sax; KIP-1105: Chu Cheng Li and Kamal Chandraprakash) |

So the assignee agrees with the author line whenever both exist, with the
page creator in 82 %, and with the starter wherever the starter is not a
committer opening a discussion for someone else, or the same person under
another name. It is wrong in a few cases where a committer holds the issue
(at most 3 of 196).

**What it adds: a real identity.** The assignee is a Jira account key, the
identity edge A already links to GitHub. With the 28 corroborated GitHub ↔
Jira links of the Example (pull requests of 2026-09-15 to 2026-10-21 only),
**33 KIPs** of the last two years reach a GitHub profile through their
assignee, for 13 people (`chickenchickenlove` 6, `brandboat` 5,
`muralibasani`, `fvaleri`, `frankvicky` 3 each, `unknowntpo` 2 (KIP-1371,
KIP-1320), `dajac` 2, …); 5 of them are among the 30 newest KIPs. Through
the starter, a GitHub profile reaches **0** today (edge B fires for nobody).
The window of 5 weeks of pull requests makes 33 a lower bound. A Jira
identity's own page lists its assigned KIPs with no link at all.

**The rule.**

1. **Reading the field (W107).** In the page header (as for the author
   line), the first block whose text starts with `JIRA` (any case); its
   `KAFKA-n` keys (links, Jira macros or text) in order, without
   duplicates, KAFKA-1 (the template's link) removed. A Jira query macro is
   `query` with no key; no key is `empty`; no block is `none`.
2. **The assignee (W108).** The `kip-pages` job reads each listed issue's
   `assignee` (key and display name only). An unassigned issue gives no
   line. Each issue counts on its own: a KIP with two issues assigned to two
   people gives each of them line 2 with their own `KAFKA-n`.
3. **Reassignment (W109).** The newest reading wins: the job re-reads an
   issue when its page changes and every Monday; where the activity log has
   a newer Jira entry for the same key (amendment (7)'s `assignee`), that
   entry wins. Earlier assignees are not kept.
4. **Precedence (W94).** Line 2, below the author line and above "started
   the discussion": it is an identity, not a name, but it can be a
   committer holding the issue for someone else (KIP-1311), so the label
   states the fact ("assigned the KIP's Jira issue (KAFKA-n)") and never
   says "author".
5. **To a profile (W111).** `jira-account:<key>` is the identity; GitHub and
   dev@ identities reach it through the link table (roster, declared,
   corroborated). No name comparison is made; the display name is shown
   only as text.
6. **Not evidence for links.** The assignee of a KIP's issue does not feed
   edge B or any other link rule in this revision (deferred by the owner, 2026-10-21).

**Job boundaries.** The `kip-pages` job fetches the issues because the keys
come from the page it reads; its responsibility stays "what a KIP page
states", now including the assignee of each issue the page names. The
identity-link job still reads only R2 objects, and the publication's Jira
connector is unchanged. Total upstream per run: at most 13 requests (10
cwiki, 3 Jira), 2 s apart.

**Profile at request time.** With `PEOPLE_KIPS=true` the profile reads
`authors.json` once (cached 10 minutes like the other objects; W87 becomes
28 objects) and lists, in `[data-section="kips"]`, every KIP where the
identity (or an identity linked to it) is an author, the assignee of a
listed issue or the starter, newest first: KIP-n, title, the label, the
issues with their assignees, the full author list (linked names and plain
names, in the page's order), the page link and the dev@ thread link. A
missing or unparsable `authors.json` leaves the starter lines and says
"author lists not available" (W98). "How this is computed" names both
sources, the `coverageFrom` of each, and that a page without an author line
lists only who started the discussion.

**Example (what it would show from today's data).** KIP-1165:
`mail:viktor somogyi-vass` gets "author (KIP page)", "also started the
discussion", and the nine names, each linked only if that name wrote in a
KIP-1165 thread in the coverage or has a `declared` entry. KIP-1371:
`mail:eric chang` gets "started the discussion" (no author line). KIP-1360:
Omnia Ibrahim, Gaurav Narula, Luke Chen and Federico Valeri each get
"author (KIP page)" when one of the two link rules holds for them.

**Simplification review (this revision).**

| Item | Kept? |
| --- | --- |
| Page creator or editors as authors | **deleted** (KIP-1026, KIP-1165, KIP-1357) |
| Confluence usernames and user keys | **deleted** (rule 4; privacy) |
| dev@ body text ("we", sign-offs) as co-author evidence | **deleted**: free text, not stored |
| A per-KIP request | **deleted**: one search request carries up to 50 pages with bodies |
| Reading all 1,402 pages | **deleted**: 365 days back, then incremental |
| Author names feeding `corroborated` links | **deleted**: credits, not evidence for joining identities |
| The job inside the identity-link job or the publication | **deleted**: its own job, own budget, own failure |
| The issue's reporter as a source | **deleted**: 97 of 208 agree with the starter; reporters are often committers filing for others |
| A separate job for the Jira read | **deleted**: the keys come from the page the `kip-pages` job reads; a second job would hand over a key list and add a trigger |
| The assignee as link evidence | **deleted** for now (deferred by the owner, 2026-10-21) |

### Owner decisions on the KIP-authors revision (2026-10-21)

The owner accepted every recommendation of this revision:

1. **Confluence is a source**, through the separate `kip-pages` job.
2. **Author-name link rule 2 is accepted**: same KIP, exact `nameKey`, and
   a message in that KIP's dev@ discussion within the coverage; the basis is
   shown.
3. **Upstream budget**: cron 03:43 UTC, at most 10 cwiki and 3 Jira
   requests per run, at least 2 s apart.
4. **The Jira assignee is its own line**, between the author line and the
   discussion starter ("assigned the KIP's Jira issue (KAFKA-n)").
5. **The `JIRA:` field's issue is not Jira ↔ dev@ link evidence** for now:
   deferred; it would need its own precision check.

### Open for the owner

1. **The owner's own `declared` entry**: the public evidence URL (the TODO
   in resolution 2). Low priority: KIP-1371 already reaches
   `github:unknowntpo` through its assignee (W111).
2. **Decision 8** (terms and privacy) before Prod, now also covering author
   names read from KIP pages and KIP issues' assignee keys.
3. **The 30 s cwiki timeout, before step 2** (found by slice B's
   `measure:kip-pages`, 2026-10-21). A search page of 50 with `body.view`
   now takes 27–42 s (recordings: 39 s, 41 s, 42.5 s; the first-run
   measurement: 27.3 s, then a timeout on the second request), against
   2.9 s in the investigation. With 30 s the first run fails closed and,
   since nothing is written, every later day repeats the 365-day window and
   fails again; a normal day (1 request of up to 10 pages, 1.4 s measured)
   passes. Options: a longer timeout (90 s), `limit=25` (first run 9 of the
   10 requests), or a shorter first window. The merge PR keeps 30 s as
   specified; the job is off.

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
| W8 | a change request, and approvals of two bots' PRs (counted, the bots not named) | recorded + constructed | github:mjsax | — | 200 | 4 / 4 | approved 2, changes requested 1, commented 1 | 0 / 0 / 0 | reviewed PRs by constructed-author 1, gabriellefu 1 |
| W8 | a dismissed review keeps its earlier verdict | constructed | github:constructed-reviewer | — | 200 | 1 / 1 | dismissed 1 (was approved) | 0 / 0 / 0 | reviewed PRs by constructed-author 1 |
| W12 | GitHub typed the reviewer Bot in the stored rows | recorded | github:copilot-pull-request-reviewer | — | 404 | — | — | — | — |
| W12 | a login GitHub typed Bot, on no static list, that also authored a PR (learned from the rows) | constructed | github:acme-review-app | — | 404 | — | — | — | — |
| W12 | a login on the profile's bot list | constructed | github:dependabot | — | 404 | — | — | — | — |
| W12 | a suppressed identity has no profile (positive control: row 3) | recorded | github:gabriellefu | gabriellefu | 404 | — | — | — | — |
| W12 | a suppressed counterpart stays counted but unnamed (positive control: row 1) | recorded | github:chia7712 | gabriellefu | 200 | 2 / 1 | commented 2 | 0 / 0 / 0 | — |
| W11 | a login with no row in the store | recorded | github:nobody-here | — | 404 | — | — | — | — |
| W11 | a Jira identity: the source is not recorded in 2a | — | jira:5f2a9c1e | — | 404 | — | — | — | — |
| W26 | a review on the last second before the 12-month view (2025-10-31T23:59:59Z) | constructed | github:old-reviewer | — | 404 | — | — | — | — |
| W26 | a review on the first second of the view (2025-11-01T00:00:00Z) | constructed | github:edge-reviewer | — | 200 | 1 / 1 | approved 1 | 0 / 0 / 0 | reviewed PRs by constructed-author 1 |
<!-- test-plan:end -->

Slice 3: person results from the same store plus constructed rows that share
a prefix (`constructed`). `people` lists the response in order; `reads` is
the number of R2 reads on a cold isolate.

<!-- test-plan:start packages/reference-pipeline/test/person-search.cases.ts -->
| id | case | data | project | query | suppressed | people | reads |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W7 | the exact login | recorded | kafka | chia7712 | — | github:chia7712 exact | 13 |
| W7 | another case; the stored login is displayed | recorded | kafka | CHIA7712 | — | github:chia7712 exact | 13 |
| W7 | a leading @ is dropped | recorded | kafka |  @chia7712  | — | github:chia7712 exact | 13 |
| W7 | a prefix | recorded | kafka | chia | — | github:chia7712 prefix | 13 |
| W7 | two prefix matches, alphabetical | constructed | kafka | constructed | — | github:constructed-author prefix, github:constructed-reviewer prefix | 13 |
| W7 | the exact login first, then prefixes alphabetically, at most 3 (lu-c, lu-d, lucasbru left out) | recorded + constructed | kafka | lu | — | github:lu exact, github:lu-a prefix, github:lu-b prefix | 13 |
| W7 | at most 3 prefix matches; case does not change the order | constructed | kafka | lu- | — | github:lu-a prefix, github:lu-b prefix, github:Lu-C prefix | 13 |
| W7 | the same store in another community | recorded | datafusion | chia7712 | — | github:chia7712 exact | 13 |
| W40 | GitHub typed the reviewer Bot in the stored rows | recorded | kafka | copilot | — | — | 13 |
| W40 | a login typed Bot in one row, on no static list, that also authored a PR | constructed | kafka | acme | — | — | 13 |
| W40 | a login on the profile's bot list | constructed | kafka | dependabot | — | — | 13 |
| W40 | a suppressed identity | recorded | kafka | gabriellefu | gabriellefu | — | 13 |
| W40 | positive control: the same identity not suppressed (reviews received only) | recorded | kafka | gabriellefu | — | github:gabriellefu exact | 13 |
| W40 | a suppressed login among the first three prefix matches does not use up the cap: the fourth candidate takes its place | constructed | kafka | lu- | lu-b | github:lu-a prefix, github:Lu-C prefix, github:lu-d prefix | 13 |
| W40 | the deleted account (ghost) has no person result | constructed | kafka | ghost | — | — | 13 |
| W40 | a login whose only review is before the 12-month view | constructed | kafka | old-reviewer | — | — | 13 |
| W40 | positive control: a review on the first second of the view | constructed | kafka | edge | — | github:edge-reviewer prefix | 13 |
| W41 | two words are not a login | — | kafka | kafka consumer | — | — | 0 |
| W41 | an empty query | — | kafka |  | — | — | 0 |
| W41 | other characters | — | kafka | chia/7712 | — | — | 0 |
| W41 | 40 characters, longer than any login | — | kafka | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | — | — | 0 |
| W41 | one character is no prefix | constructed | kafka | c | — | — | 13 |
| W41 | positive control: one character equal to a login | constructed | kafka | Q | — | github:q exact | 13 |
<!-- test-plan:end -->

Slice 2b: the Example identities of [amendment (2)](#example-2b-what-the-first-append-shows-for-three-real-people)
from the recorded Dev fixture of 2026-10-15 (`recorded`), and constructed
events on each side of a rule (`constructed`). Read at the capture time,
2026-10-15T01:03:56Z; the log's coverage starts 2026-09-09T22:07:43Z.

<!-- test-plan:start packages/reference-pipeline/test/profile-areas.cases.ts -->
| id | rule | input | expected |
| --- | --- | --- | --- |
| W46 | taxonomy | kafka: clients, small, ci-approved, triage, needs-attention, KIP-932, kip | areas clients; kips KIP-932 |
| W46 | taxonomy | kafka: kip-1332 (lower case) and a title KIP-1332 | areas none; kips KIP-1332 |
| W46 | taxonomy | datafusion: sql, v56.0.0, auto detected api change, bug, rust, auto-dependencies | areas sql; kips none |
| W46 | taxonomy | kafka: a label not in the profile (share-groups) | areas share-groups; kips none |
| W46 | taxonomy | datafusion positive control: core, physical-plan, sqllogictest | areas core, physical-plan, sqllogictest; kips none |
| W47 | distribution | #1 clients, core; #2 clients; #3 triage only | items 3; unlabelled 1; assignments 3; slices clients 2, core 1 |
| W47 | distribution | the same pull request listed twice | items 1; unlabelled 0; assignments 1; slices clients 1 |
| W47 | distribution | 8 areas a..h on 8, 7, …, 1 pull requests | items 8; unlabelled 0; assignments 36; slices a 8, b 7, c 6, d 5, e 4, f 3, other 3 |
| W47 | distribution | exactly 6 areas | items 6; unlabelled 0; assignments 6; slices a 1, b 1, c 1, d 1, e 1, f 1 |
| W49 | coverage | reviewed #1 and #2; metadata for #1 only | covered 1 of 2 |
| W49 | coverage | reviewed #1 twice; metadata for #1 | covered 1 of 1 |
| W46 | profile | every month of the view with metadata; ada reviewed #10 (clients, triage) and #11 (core, KIP-932) | pullAreas 10 clients; 11 core KIP-932 |
| W46 | profile | no month with metadata (metadata@1 only) | no pullAreas |
| W49 | profile | ada's reviews in two months, only the newer with metadata | pullAreas 11 core KIP-932; #10 not covered |
| W46 | profile | #11's labels in an older month and different labels in a newer one | pullAreas 11 streams |
| W51 | profile name | ada named Ada Lovelace in the older month and A. Lovelace in the newer | name A. Lovelace |
| W51 | profile name | no name stored for ada | no name |
| W51 | profile name | a suppressed counterpart with a stored name | name not in the response |
<!-- test-plan:end -->

Named tests of amendment (4): `apps/web/test/people-areas-ui.test.ts` (W46, W48, W49, W51, W53 rendered on the server and the Prod gate) and `apps/web/e2e/people-areas.spec.ts` (W48–W53 in the browser, with GitHub's avatar host answered by a constructed image or refused).

Amendment (5): the chart model's rows (`apps/web/test/profile-chart.cases.ts`, computed by `activityChart` and `chartLayout` in `apps/web/src/profile-chart.ts`); `dev-shaped` rows carry the counts of the Example, `constructed` rows edge cases. Named tests: `apps/web/test/people-chart-ui.test.ts` (W56, W60–W63 rendered on the server) and `apps/web/e2e/people-chart.spec.ts` (W61, W64, W65 in the browser).

<!-- test-plan:start apps/web/test/profile-chart.cases.ts -->
| id | case | data | fixture | columns | series | scale | band | lanes | partial | clipped | peak |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W57 | a GitHub identity over 12 months: 12 monthly columns, oldest on the left | dev-shaped | github-12m | 12: 2025-11 … 2026-10 | given + github / received | 10, 20, 30 | — | github | 2026-09 github from 2026-09-10 | — | 2026-09 13 |
| W57 | the same identity over 90 days: 14 weekly columns from the week of now − 90 days | dev-shaped | github-90d | 14: 2026-07-13 … 2026-10-12 | given + github / received | 5, 10, 10 | — | github | 2026-09-07 github from 2026-09-10 | 2026-07-13 | 2026-09-21 6 |
| W57 | a dev@ identity with 35 days of data still has 12 monthly columns; ten are not recorded | dev-shaped | mail-12m | 12: 2025-11 … 2026-10 | mail / — | 10, 20, 0 | 2025-11 – 2026-08 | — | — | 2026-09 | 2026-09 19 |
| W57 | the dev@ identity over 90 days: the weeks before the log are one band | dev-shaped | mail-90d | 14: 2026-07-13 … 2026-10-12 | mail / — | 5, 10, 0 | 2026-07-13 – 2026-08-31 | — | — | 2026-09-07 | 2026-09-21 9 |
| W58 | a Jira identity charts Jira only, although the rows carry reviews, GitHub and dev@ counts | constructed | jira-12m | 12: 2025-11 … 2026-10 | jira / — | 1, 2, 0 | 2025-11 – 2026-08 | — | — | 2026-09 | 2026-09 2 |
| W60 | a GitHub identity in a community without the activity log: reviews drawn, GitHub activity a lane, never 0 | constructed | github-no-log | 12: 2025-11 … 2026-10 | given + github / received | 1, 2, 1 | — | github | — | — | 2026-09 2 |
| W59 | everything recorded and 0: no band, no lane, a scale of one step | constructed | github-zeros | 14: 2026-07-13 … 2026-10-12 | given + github / received | 1, 1, 0 | — | github | 2026-09-07 github from 2026-09-10 | 2026-07-13 | — |
<!-- test-plan:end -->

<!-- test-plan:start packages/reference-pipeline/test/people-activity.cases.ts -->
| id | case | data | person | status | github | jira | mail | areas | worksWith |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W1 | a committer who comments on others' pull requests and opens none | recorded | github:chia7712 | 200 | PRs 0 (merged 0), comments 59 on 48 threads (own 0) | — | — | clients 10, streams 9, build 8, core 8, group-coordinator 6; KIP-932 2, KIP-909 1, KIP-1071 1 | gabriellefu 5, harmadasg 4, jim0987795064 3, m1a2st 3 |
| W1 | the same person's Jira identity: its own page, nothing added from GitHub or dev@ | recorded | jira:Chia-Ping Tsai | 200 | — | issues 72, comments 12, on 78 issues | — | no area data from jira | Mickael Maison 2, Andrew Schofield 1, David Jacot 1, Edoardo Comar 1 |
| W1 | the same person's dev@ identity: 21 messages in 13 threads | recorded | mail:Chia-Ping Tsai | 200 | — | — | 21 in 13 threads; [DISCUSS] 6, [VOTE] 6 | KIP-1153 1, KIP-1342 1, KIP-1349 1; no area data from mail | Andrew Schofield 1, David Jacot 1, Ming-Yen Chung 1, Omnia Ibrahim 1 |
| W1 | a pull-request author: 18 of his PRs are in the release, 7 were opened inside the log's coverage | recorded | github:m1a2st | 200 | PRs 7 (merged 5), comments 26 on 20 threads (own 7) | — | — | clients 8, consumer 5, core 5, group-coordinator 5, storage 4; KIP-932 1 | dajac 4, mimaison 2, nileshkumar3 2, aliehsaeedii 1 |
| W1 | a dev@ identity with no GitHub page under this name | recorded | mail:Andrew Schofield | 200 | — | — | 23 in 11 threads; [DISCUSS] 4, [VOTE] 4 | KIP-1368 2, KIP-1279 1, KIP-1306 1, KIP-1349 1, KIP-1371 1; no area data from mail | Chia-Ping Tsai 2, Aditya Kousik 1, Apoorv Mittal 1 |
| W1 | the same name in Jira: a separate identity (strict identity, decision 5) | recorded | jira:andrew schofield | 200 | — | issues 4, comments 4, on 8 issues | — | no area data from jira | Apoorv Mittal 2, Luke Chen 1, Shekhar Prasad Rajak 1 |
| W1 | his GitHub login: unlinked, counted on its own | recorded | github:AndrewJSchofield | 200 | PRs 6 (merged 4), comments 4 on 3 threads (own 2) | — | — | clients 7, consumer 5, build 1, producer 1; KIP-932 3 | apoorvmittal10 1, ezhou413 1 |
| W3 | a pull request opened on the last second of September and updated 40 days later counts in September | constructed | github:edge-author | 200 | PRs 1 (merged 1), comments 0 on 0 threads (own 0) | — | — | — | — |
| W4 | labels `clients`, `small`, `ci-approved`: the area is `clients` only | constructed | github:label-author | 200 | PRs 1 (merged 0), comments 0 on 0 threads (own 0) | — | — | clients 1 | — |
| W12 | a GitHub bot's comments are not logged: no page | constructed | github:ci-bot | 404 | — | — | — | — | — |
| W12 | a Jira identity the connector marks as a bot: no page | constructed | jira:Jenkins Bot | 404 | — | — | — | — | — |
| W11 | a dev@ sender without a name (`unknown sender`) is no identity | constructed | mail:unknown sender | 400 | — | — | — | — | — |
| W11 | a Jira identity in a community without Jira (DataFusion) | recorded | jira:Chia-Ping Tsai @ datafusion | 404 | — | — | — | — | — |
<!-- test-plan:end -->

Amendment (7): KIP starters, the stored fields, the `corroborated` rule and
the job, from the Example's recorded values (labelled `recorded`) and
constructed boundaries.

<!-- test-plan:start packages/reference-pipeline/test/identity-links.cases.ts [pending] -->
| id | case | data | input | expected |
| --- | --- | --- | --- | --- |
| W66 | a root message starts the KIP discussion | recorded | KAFKA-MAIL-3bc971ac: root "[DISCUSS] KIP-1376: …" by Mickael Maison 2026-10-06, 17 replies | KIP-1376 started by mail:mickael maison |
| W66 | replies only | recorded | KAFKA-MAIL-fd63cd54: 22 messages, all "Re: [DISCUSS] KIP-1368 …" | KIP-1368 has no starter |
| W66 | title without brackets | recorded | "DISCUSS: KIP-1378: Allow Consumer Group Renaming …" by Edoardo Comar | KIP-1378 started by mail:edoardo comar |
| W66 | one KIP number used by two threads | recorded + constructed | KIP-1153 roots: pritam kumar 2025-04-04, 黃竣陽 2025-04-12 (both inside a constructed coverage) | KIP-1153 started by mail:pritam kumar only |
| W66 | a title naming two KIPs | constructed | root "[DISCUSS] KIP-1 and KIP-2" | no starter for either |
| W66 | a [VOTE] root is not a discussion | constructed | root "[VOTE] KIP-1376" before the [DISCUSS] root | starter from the [DISCUSS] thread |
| W67 | the root flag on dev@ rows | recorded | messages "[DISCUSS] KIP-1342: …" and "Re: [DISCUSS] KIP-1342: …" | opens: true on the first row only |
| W67 | the flag survives the state sliding | constructed | month written with the root row; a later run's state holds only replies | the root row keeps opens: true |
| W67 | Jira accounts on the thread entry | recorded | KAFKA-20995 reporter and assignee JIRAUSER306218 "Eric Chang" | reporter {key JIRAUSER306218, display Eric Chang}, assignee the same |
| W68 | only key and display name are kept | recorded | Jira user object with key, name, displayName, timeZone, avatarUrls, active (and a constructed emailAddress) | event, activity log, link table and every API response hold no name, timeZone, avatar, active or email |
| W68 | an unassigned issue | recorded | one of the 16 unassigned keys of the Example | assignee null; no pairing |
| W69 | five keys, no competitor | recorded | unknowntpo ↔ JIRAUSER306218 on KAFKA-21152, 21172, 21252, 21262, 21276 | linked, corroborated, 5 keys as evidence |
| W69 | dominance with a competitor | recorded | harmadasg ↔ JIRAUSER306203 10 keys; m1a2st ↔ JIRAUSER306203 2 keys | harmadasg linked; m1a2st not |
| W69 | split pairings | recorded | m1a2st ↔ JIRAUSER306203 2, JIRAUSER305187 2, JIRAUSER300229 1 | no link for m1a2st |
| W69 | a committer assigned to issues others fixed | recorded | dybyte, dino2895, jim0987795064 ↔ chia7712 1 key each | no link to chia7712 |
| W69 | a backport counts once | constructed | 3 pull requests naming one KAFKA-n | n = 1, no link |
| W69 | dominance boundary | constructed | X ↔ Y 6 keys, X ↔ Z 2 keys / X ↔ Y 6, X ↔ Z 3 | linked / not linked |
| W69 | minimum boundary | constructed | X ↔ Y 2 keys, no competitor | not linked |
| W70 | one KIP is not enough | recorded | KIP-1371 started by Eric Chang; KAFKA-20995 "KIP-1371: …" reporter Eric Chang | no Jira ↔ dev@ link |
| W70 | two KIPs | recorded + constructed | KIP-1371 as recorded and a constructed second KIP with the same pairing | mail:eric chang ↔ jira-account:JIRAUSER306218 linked |
| W70 | a KIP named only in the description | recorded | KAFKA-20728 (KIP-1376 in the description; reporter Netan Mangal, assignee Arnab Nandy) | not an issue for KIP-1376; no pairing |
| W70 | two Jira accounts with the starter's name | constructed | two accounts "A B" each on a KIP started by mail:a b | no link (strict) |
| W71 | transitive only through both edges | constructed | github:x ↔ jira-account:k (3 keys) and jira-account:k ↔ mail:x (2 KIPs) | one person: github, Jira and dev@ |
| W71 | one edge short | recorded | github:unknowntpo ↔ JIRAUSER306218 (5 keys); mail:eric chang ↔ JIRAUSER306218 (1 KIP) | GitHub and Jira linked; mail:eric chang separate |
| W71 | two logins in one component | constructed | github:a and github:b both reach jira-account:k | no corroborated link of that component; conflict 1 |
| W72 | contradicts the roster | constructed | a corroborated chain joining two names of two ASF ids | link dropped; contradiction 1; roster links kept |
| W72 | declared removal | constructed | identityLinks {a: github:unknowntpo, b: jira-account:JIRAUSER306218, remove: true} | pair not linked at the next run |
| W72 | suppressed identity | constructed | github:x on the suppression list | no link touches github:x |
| W73 | table format and order | recorded | the W69 recorded rows, twice, in different input order | byte-equal tables; each link has basis and evidence ids with URLs |
| W74 | own KIPs on a dev@ page | recorded | PEOPLE_KIPS=true; mail:arnab nandy | [data-section=kips] lists KIP-1381 and KIP-1382 with titles, 2026-10-16 and thread links |
| W74 | linked KIPs on a GitHub page | constructed | PEOPLE_KIPS=true; github:x corroborated to mail:x | KIPs of mail:x with basis corroborated and the evidence links |
| W74 | flag off | constructed | PEOPLE_KIPS unset | no kips section; links.json not read |
| W75 | the note | constructed | coverageFrom 2026-09-10, table generatedAt 2026-10-22T02:17Z | definition, "KIPs started before 9/10 are not listed", links computed 10/22 |
| W76 | a month read fails | constructed | bucket throws on 2026-09.json | no table written; last good kept; lastRun.ok false with the key |
| W77 | no activity log | constructed | state.json absent | status no-input; nothing written |
| W77 | no roster | constructed | roster object absent | table written without roster links; inputs.rosterAt null |
| W78 | unchanged inputs | constructed | second run on the same objects | links.json not written; last-run.json written |
| W79 | crash between writes | constructed | throw after links.json put | next run writes last-run.json; table unchanged |
| W80 | link table missing or corrupt | constructed | links.json absent / not JSON | 200; own KIPs listed; "links not available" |
| W81 | isolation from the publication | constructed | the job throws on its cron | publication not started or changed; nothing written outside internal/identity/v1/ |
| W82 | two runs at once | constructed | cron and manual run on the same inputs | equal bytes; plain puts only |
| W83 | rows written before the flag | constructed | month with dev@ rows and no opens field | no starter from them; note states the start |
| W84 | issue reassigned | constructed | KAFKA-n assignee A in 2026-09, B in 2026-10 | paired with B only, counted once |
| W85 | job off | constructed | IDENTITY_LINKS unset | cron no-op, route 404, no R2 call, no /health field |
| W87 | profile reads | constructed | cold, then within 10 min | at most 28 reads (links.json and authors.json), then 0 |
| W91 | health shape | constructed | a finished run | identityLinks {revision, lastRun {ok, status, at, durationMs, inputs (with committersAt), links, rejected, people, kipStarters, r2}, lastGoodAt} |
<!-- test-plan:end -->

Amendment (7), KIP authors revision: the KIP-page author line, the order of
labels, how author names link, the `kip-pages` job, and the committers page
as `declared` links. Rows from public cwiki and Pony Mail reads of
2026-10-21 (labelled `recorded`) and constructed boundaries.

<!-- test-plan:start packages/reference-pipeline/test/kip-authors.cases.ts [pending] -->
| id | case | data | input | expected |
| --- | --- | --- | --- | --- |
| W94 | author and starter | recorded | KIP-1165 list names Viktor Somogyi-Vass; he started the recorded [DISCUSS] thread | "author (KIP page)", "also started the discussion" |
| W94 | starter only | recorded | KIP-1371: no line; started by Eric Chang | mail:eric chang: "started the discussion" |
| W94 | a starter the list does not name | recorded + constructed | KIP-1272 list "Henry Cai, Thomas Thornton, Greg Harris"; starter "Henry Haiying Cai" inside a constructed coverage | mail:henry haiying cai: "started the discussion"; not an author |
| W94 | creator and editors give nothing | recorded | KIP-1357 editor Matthias J. Sax; KIP-1026 creator Divij Vaidya, author Arpit Goyal | no line for Matthias J. Sax or Divij Vaidya |
| W95 | linked by writing in the discussion | constructed | KIP-1165 list; mail:greg harris wrote in a KIP-1165 thread in coverage | Greg Harris links to mail:greg harris ("named on the KIP page, wrote in its discussion") |
| W95 | same name, other KIP only | constructed | mail:greg harris wrote only in a KIP-1150 thread | Greg Harris on KIP-1165 is a plain name |
| W95 | linked by a declared entry | constructed | committers capture pair github:x ↔ mail:a b; author "A B" never on dev@ | A B links to the person of github:x |
| W95 | a different written name | recorded | author "Henry Cai"; dev@ identity mail:henry haiying cai | plain name; no link |
| W95 | names never join identities | constructed | author "A B"; github:x and mail:a b unlinked | link table unchanged; no corroborated edge from the author line |
| W96 | the section | recorded + constructed | PEOPLE_KIPS=true; mail:viktor somogyi-vass with KIP-1165 | one line: KIP-1165, title, label, 9 names in page order, page and thread links |
| W96 | a linked identity | constructed | github:x declared to mail:x, an author of KIP-n | github:x lists KIP-n with the link's basis |
| W98 | table missing | constructed | authors.json absent / not JSON | 200; starter lines; "author lists not available" |
| W102 | names only | recorded | the W93 pages (with usernames, user keys, emails in their sources) | no username, user key, email, avatar or body text in any stored object or response |
| W103 | committers as declared links | constructed | capture of 3 pairs, one name twice | 2 declared entries with the committers page URL, date, reviewer |
| W103 | refresh removes a pair | constructed | new capture without one pair | diff lists it as removed; no entry; next run splits |
| W103 | blind check | constructed | measure:identity-links --blind | committers-page entries not read |
| W104 | evidence must be a URL | constructed | entry github:unknowntpo ↔ mail:eric chang with evidence "TODO(owner): …" | rejected; no link |
| W104 | with a URL | recorded + constructed | the same entry with an https URL; github:unknowntpo ↔ JIRAUSER306218 corroborated (5 keys) | one person; GitHub page lists KIP-1371 |
| W94 | assignee below the author line | recorded | KIP-1165: author line names Ivan Yurchenko; KAFKA-19161 assignee Ivan Yurchenko | jira-account of Ivan Yurchenko: "author (KIP page)" via a link, "also assigned KAFKA-19161"; otherwise "assigned the KIP's Jira issue (KAFKA-19161)" |
| W94 | assignee above the starter | recorded | KIP-1376: KAFKA-20728 assignee Arnab Nandy; starter Mickael Maison | Arnab Nandy's Jira account: "assigned the KIP's Jira issue (KAFKA-20728)"; mail:mickael maison: "started the discussion" |
| W109 | activity log is newer | constructed | job read A at 2026-10-20; activity-log entry with assignee B updated 2026-10-21 | line for B only |
| W109 | unassigned | recorded | KIP-1360 KAFKA-20715 assignee null | no assignee line |
| W109 | two people on two issues | recorded | KIP-1105: two issues, Chu Cheng Li and Kamal Chandraprakash | each gets a line naming their own KAFKA-n |
| W111 | through a corroborated link | recorded | github:unknowntpo ↔ JIRAUSER306218 (5 keys); KIP-1371 KAFKA-20995 assignee JIRAUSER306218 | github:unknowntpo lists KIP-1371, basis corroborated |
| W111 | no link | recorded | KIP-1360: no assignee; github:x unlinked | nothing listed on the GitHub page |
| W111 | a committer holding the issue | recorded | KIP-1311 assignee Chia-Ping Tsai, starter Siddhartha Devineni | chia7712's Jira account: "assigned the KIP's Jira issue", never "author" |
<!-- test-plan:end -->

Slice B, the `kip-pages` job (2026-10-21): the author line, the `JIRA:`
field, the assignee read and the run's budget and failures, from the
recorded cwiki and Jira answers committed under
`packages/reference-pipeline/test/fixtures/kip-pages/`.

<!-- test-plan:start packages/reference-pipeline/test/kip-pages.cases.ts -->
| id | case | data | input | expected |
| --- | --- | --- | --- | --- |
| W93 | a plain list of nine | recorded | KIP-1165 view: "Authors: Greg Harris, Ivan Yurchenko, …, Viktor Somogyi-Vass" | listed; 9 names in page order |
| W93 | a plain list across spans | recorded | KIP-1360 view: "Authors: Omnia Ibrahim, Gaurav Narula," then a span " Luke Chen, Federico Valeri" | listed; 4 names |
| W93 | the line ends at its block | recorded | KIP-1279 view: "Authors: Luke Chen, Federico Valeri, Omnia Ibrahim, Gaurav Narula" then a paragraph "This design follows …" | listed; 4 names, no text of the next paragraph |
| W93 | user mentions | recorded | KIP-952: two user mentions, rendered "Mital Awachat" "Christo Lolov" with no comma | listed; 2 names |
| W93 | an email in the line | recorded | KIP-1183: "xinyu<xinyuzhou@automq.com>"; KIP-1300 (page 406622741): "Viquar Khan (Vaquar.khan@gmail.com)" | listed; "xinyu" / "Viquar Khan"; no @ stored |
| W93 | a parenthesized co-author | recorded | KIP-1258: "Co-Author: <mention ujjwal kalia> (Ujjwal Kalia)" | listed; the mention's name and "Ujjwal Kalia" |
| W93 | a line under the Status heading | recorded | KIP-1026: "Author: Arpit Goyal" between the Status heading and the next heading | listed; "Arpit Goyal" (the header ends at the first heading after Status) |
| W93 | a block that does not start with the label | recorded | KIP-986: "To Co-Authors: None of the below contents is final or necessarily correct. …" | no-list; no author |
| W93 | not a list | constructed | "Authors: the Kafka streams team, see the discussion thread for the full list of people" | unparsed; no author, never a partial list |
| W93 | no author line | recorded | KIP-1371 (template header only) | no-list |
| W93 | collaborators are not authors | recorded | KIP-950: "Authors: Mehari Beyene, Divij Vaidya" and "Collaborators: Karthik Rajagopalan, …" | listed; the 2 authors only |
| W93 | the word and, & and ; | constructed | "Authors: Henry Cai; Tom Thornton & Greg Harris and Anna Müller-O'Brien" | listed; 4 names |
| W107 | one issue | recorded | KIP-1371 header "JIRA: KAFKA-20995" | one [KAFKA-20995] |
| W107 | several issues | recorded | KIP-1370 header with KAFKA-20888 and KAFKA-20883 (Jira macros) | several, in page order |
| W107 | several issues as links | recorded | KIP-1105 "JIRA: KAFKA-17928 and KAFKA-17980"; KIP-1128 three Jira macros | several [KAFKA-17928, KAFKA-17980]; [KAFKA-17178, KAFKA-17131, KAFKA-19688] |
| W107 | empty | recorded | KIP-1383 "JIRA: here [Ticket will be opened once the KIP is approved]" linking KAFKA-1; KIP-1183 "JIRA:" | empty |
| W107 | the template's link | constructed | "JIRA: here [Change the link from KAFKA-1 to your own ticket]" linking KAFKA-1 | empty |
| W107 | a query macro | constructed | JIRA block holding a jqlQuery macro | query, no key |
| W107 | no field | recorded | "Kafka Improvement Proposals" index page body | none |
| W108 | batching and unknown keys | constructed | 160 keys incl. KAFKA-99999999 | 2 requests (100 + 60) with fields=assignee and validateQuery=warn; unknown key dropped |
| W108 | recorded assignees | recorded | KIP-1165 KAFKA-19161; KIP-1360 KAFKA-20715; KIP-1105 KAFKA-17928, KAFKA-17980; unknown KAFKA-99999999 | Ivan Yurchenko (ivanyu); null; Chu Cheng Li and Kamal Chandraprakash; dropped |
| W108 | Jira fails | constructed | stub Jira answers 503 | no table; last good kept; ok false, status failed |
| W108 | Monday re-read | constructed | run on a Monday, table with 160 keys, no page changed | 1 cwiki request, 2 Jira requests; every issue's readAt is the run |
| W108 | Monday cap | constructed | run on a Monday, table with 350 keys, one changed page | 3 Jira requests: the changed page's key, then the 299 oldest readings; never over budget from the re-read |
| W108 | a re-read replaces the assignee | constructed | table: KAFKA-n assignee A; changed page re-reads KAFKA-n as B | assignee B only; A is not kept |
| W110 | Jira fields kept | recorded | KAFKA-20995 with assignee and reporter user objects | assignee {key JIRAUSER306218, display Eric Chang} only; no reporter, name, timeZone, avatar |
| W102 | names only | recorded | the recorded pages (usernames, user keys, avatars, emails in their sources) and Jira answer | no username, user key, email, avatar or body text in authors.json or last-run.json |
| W97 | a 429 | constructed | stub cwiki answers 429 on the first request | no table; last good kept; ok false, status failed; 1 request |
| W97 | a 5xx, a timeout, unparsable JSON | constructed | stub cwiki answers 502 / throws a timeout / answers "<html>" | each: no table; last good kept; ok false, status failed; no retry |
| W97 | over budget | constructed | a window needing 11 pages of 50 | status over-budget after 10 requests; nothing written but last-run.json; next run starts from the same since |
| W97 | positive control | constructed | stub answers 200 with 25 pages | table written; ok true |
| W101 | pacing | constructed | a run of 3 cwiki pages and 1 Jira request | sequential; a 2 s delay before every request after the first; 30 s timeout signal; the project's User-Agent |
| W105 | a new version | constructed | KIP-n version 3 in the table, 4 in the answer | entry replaced |
| W105 | unchanged | constructed | same versions | authors.json not written; last-run.json written; status unchanged |
| W105 | the window | constructed | last good run 2026-10-21T03:43Z / no table | since 2026-10-20T03:43Z / 365 days back |
| W105 | a page without a KIP number | recorded | "Kafka Improvement Proposals" index page | skipped |
| W105 | byte-equal | recorded | the recorded 7-day window, answered in two orders | equal bytes, pages sorted by KIP then page id (two KIP-1300 pages) |
<!-- test-plan:end -->

Slice B in the publisher Worker: the job's cron entry, route and `/health`
field.

<!-- test-plan:start apps/data-publisher-worker/test/kip-pages-worker.cases.ts -->
| id | case | data | input | expected |
| --- | --- | --- | --- | --- |
| W98 | isolation | constructed | the job's cron tick with cwiki throwing and the bucket failing its puts | publication, digest and every other job not started; no write outside internal/kips/v1/; the tick does not throw |
| W98 | the publication tick | constructed | the publication's cron tick with KIP_PAGES set | the publication is scheduled; no cwiki or Jira request; nothing under internal/kips/v1/ |
| W99 | job off | constructed | KIP_PAGES unset, KIP_PAGES_CRON set | cron no-op, route 404, no cwiki request, no R2 call, no /health field |
| W99 | positive control | constructed | KIP_PAGES=authors@1 with the same cron | the cron runs the job: one cwiki request, internal/kips/v1/ written; the route answers 401 without the token and 200 with it |
| W100 | health shape | constructed | a finished run, then no run yet, then an unreadable record | kipPages is the run record; {revision, lastRun: null, lastGoodAt: null, coverageFrom: null}; null |
<!-- test-plan:end -->

## Acceptance

Each item: precondition → action → observable result → evidence. All are
`[pending]` until their slice is implemented.

### Behavior

- W1: given the recorded Dev fixture of 2026-10-15 appended as the first append would (coverage from 2026-09-09T22:07:43Z), `github:chia7712` has 0 pull requests opened and 59 comments on 48 threads; `jira:chia-ping tsai` 72 issues and 12 comments on 78 issues; `mail:chia-ping tsai` 21 messages in 13 threads with 6 `[DISCUSS]` and 6 `[VOTE]` threads; `github:m1a2st` 7 pull requests opened (5 merged) and 26 comments on 20 threads, 7 on his own; `mail:andrew schofield` 23 messages in 11 threads; each identity's counts come from its own source only, and the page shows the response's totals → case file rows (amended 2026-10-15: the 2026-10-13 fixture of 268 Detail responses was never committed; the Example of amendment (2) replaces it).
- W2: given a record ingested twice (a retried run, a newer version of it, or the same state appended on two days), the activity month object holds one row for it and an unchanged month is not written again; a Jira issue updated in two months is counted once → unit tests on the row builder, the merge and the append, with a positive control (a new record adds a row and rewrites only its month). (Review rows are not appended by this spec; their idempotence is Spec 022 RV5.)
- W3: given a pull request created on the last second of a month and merged and updated 40 days later, its row is in the month it was created and keeps its creation and merge times (not the update time, amendment (2)); one second later it is the next month's; a pull request created before the log's coverage writes no row → case rows on each side of a month boundary and of the coverage start.
- W4: given a thread with labels `clients`, `small`, `ci-approved` and a Kafka profile naming the last two as process labels, the area is `clients` only; given a dev@ thread, the page says "no area data from dev@" → case rows.
- W5: given the page for an identity, sections appear in the order of this spec and the page states the period covered and the number of days of data → component test (amended 2026-10-16: the order is W56's, and the period with its days is in the "Data range" line of W63).
- W6: given an identity with rows only before the selected period, the page says there is no activity in this period and shows no zero-filled chart → component test, with a positive control on the same identity in the full period.
- W7: given the query `chia7712` (any case, or with a leading `@`), the first person result is `github:chia7712` with `match: exact`; given a two-character-or-longer prefix, person results are the exact match, then prefix matches alphabetically, at most 3 in all, merged across projects exact first; the thread list is the `/api/search` response unchanged, below the person results → case rows, merge unit test, E2E.
- W40: the person index holds exactly the identities whose profile answers 200: bots (the profile's list, `[bot]`, typed `Bot` in a row), the deleted account, suppressed identities and logins whose rows are all before the view are absent; a month that cannot be read is skipped → case rows with positive controls, and a test that every fixture login is found if and only if its profile is 200.
- W41: a query that is not a GitHub login after trimming and dropping one leading `@` (empty, spaces, other characters, over 39 characters) answers 200 with no people and reads nothing from R2; a one-character query matches only an identical login → case rows with a counting bucket.
- W42: given the Prod configuration, `/api/people/:project?q=` answers 404 with `no-store` and `X-Robots-Tag: noindex`, and the Feed sends no person request; given Dev, 200 with the profile's cache header and `noindex`; an unknown project is 400; an unreadable review cursor is 503 → API test both sides, and E2E for the Dev side.
- W45: at 320 and 375 px, a search with a person result has no horizontal overflow, and the person result opens the profile → E2E.
- W8: given Spec 022 month objects (`osskb.github-reviews.v1`) built from Spec 022's recorded Kafka #23675 and #23165 (approvals, comments, a bot's review, the author's own reply) plus a constructed change-request row, the profile reads them as they are, shows each human review with its state, counts "reviews given" as distinct pull requests, leaves out rows with `isBot` or with `reviewer` equal to `prAuthor`, and states the date reviews are counted from (`coverageFrom`) → case rows (recorded and constructed, labelled as such).
- W46: given month objects with `metadata@2` fields, the profile response's `pullAreas` holds, for each reviewed or received pull request with metadata, its area labels after the community taxonomy (process labels removed, `KIP-<n>` labels moved to KIP ids) and its KIP ids, the newer month's entry winning; without any metadata the field is absent and the page shows what it showed before; unknown labels are areas; review areas and activity-log areas use the same taxonomy and aggregation → case rows and UI test.
- W47: the aggregation counts distinct items per area, an item once in each of its area labels, leaves process labels out, keeps the six largest areas and groups the rest as "other" with the sum of their assignments, and counts items with no area label apart → case rows.
- W48: given every pull request of a side covered, the page draws a donut of at most seven slices with `role="img"` and an `aria-label` naming each slice, and lists the same slices as text with count and share of assignments, the definition (a pull request with several area labels counts in each), the number without an area label, and up to five KIP ids → UI test and E2E.
- W49: given a side with a pull request that has no stored metadata, the page draws no chart and states "covered X of Y" instead → case rows, UI test and E2E.
- W50: at 320 and 375 px the profile with both area blocks and the avatar header has no horizontal overflow → E2E.
- W51: given a stored public name, the header shows it as the heading with the login beneath, as escaped text; without one, the login alone; the name is display only and links nothing; a counterpart's name, suppressed or not, is never in the response → case rows, UI test and E2E.
- W52: a person result in Search shows the avatar and the public name with the login beneath → E2E and the search API's `name`.
- W53: the avatar URL is `https://avatars.githubusercontent.com/<login>?s=<2 × size>` built only from a string matching GitHub's login rule (anything else, including paths, queries, `[bot]` logins and `javascript:`, gets the neutral initial and no `img`); the image has width, height, alt, `loading="lazy"` and `referrerpolicy="no-referrer"`; a refused image falls back to the initial; on Prod the profile API answers 404 with no name and no area field → UI test and E2E.
- W56: given a profile, the sections are `header`, `over-time`, `activity`, `areas`, `works-with`, `threads`, `identities`, `how` in that order; the header holds the avatar (GitHub), the name, the source badge with the login, "Activity in <community>" and the period toggle, and one sentence summarising the selected period from the same totals as the tiles, with "recorded since <date>" when the source's coverage starts inside the period → UI test (amendment (5), replaces the order of W5).
- W57: the chart has one column per month (12 in the 12-month view, ending with the month of `until`) or per week from the week of 90 days before now (90-day view), oldest on the left; a bucket without a row in `overTime` is not recorded in every series → case rows.
- W58: a GitHub identity's chart stacks reviews given and GitHub activity above the axis and mirrors reviews received below; a Jira or dev@ identity's chart has its own source only; no other source's series appears → case rows.
- W59: both directions share one scale from 0 with a step of 1, 2 or 5 × 10^k; every segment's height is its value times the unit, stacked segments touch, and each column's total is its own series' sum → case rows.
- W60: a value not recorded is null and is never drawn or written as 0; buckets where none of the person's own series is recorded form one hatched band labelled "Not recorded yet"; a series not recorded in some buckets where another is gets a coverage lane; a bucket that starts before a series' coverage names the date in its tooltip → case rows and UI test.
- W61: the chart `svg` is `role="img"` with an `aria-label` naming the period, the series and the busiest bucket; "Show as table" shows one row per bucket with "Not recorded yet" for null; hovering or tapping a column shows its values → UI test and E2E.
- W62: GitHub tiles are reviews given, reviews received, pull requests opened and comments (issues opened only when not 0); Jira and dev@ have three tiles of their source; a tile of a source not recorded shows "Not recorded yet" and no number; a tile whose coverage starts inside the period says "recorded since <date>" → UI test, both locales.
- W63: the coverage chips are gone; a collapsed "Data range" line under the chart lists the start of each of the identity's sources and, opened, every source's range (W27's texts) and the period with its days → UI test.
- W64: at 320 and 375 px the redesigned profile (GitHub with the activity log, and dev@ only) has no horizontal overflow, the chart fits its card, and the tiles are two columns (three for three tiles at 375 px) → E2E with screenshots.
- W65: opening a profile and switching the period sends exactly one `/api/people/:project/:id` request and no other API request beyond what the page sent before → E2E counting requests.
- W34: given an activity month, its stored summary holds, for every identity in the month, the counters `indexActivityMonth` computes for it (decision 10: one function for the reader and the summary) → test over every month of the recorded store.
- W66: [pending] given dev@ rows of the activity log, a KIP's starter is the author of the root (subject without a reply prefix) of the earliest thread whose title starts with `[DISCUSS]` or `DISCUSS:` and names exactly that one KIP; a thread of replies only, a later thread with the same number, a title naming two KIPs and a `[VOTE]` thread credit nobody (amendment (7)) → case rows, recorded (KIP-1376, KIP-1368, KIP-1378, KIP-1153) and constructed.
- W67: [pending] given the publication's activity append, a dev@ `message` row carries `opens: true` exactly when its subject has no reply prefix, and a root row keeps it when a later state holds only replies; a Jira thread entry carries `reporter` and `assignee` as `{key, display}` or `null`, from the newest month → unit tests on the row builder and the merge, with a positive control (a reply row has no flag).
- W68: [pending] given a recorded ASF Jira user object (`key`, `name`, `displayName`, `timeZone`, `avatarUrls`, `active`, plus a constructed `emailAddress`), the connector requests `assignee` and keeps only `key` and `displayName`; no event, activity object, link table, `/api/feed`, `/api/detail` or `/api/people` response contains a `name`, time zone, avatar, `active`, an email address or a Jira account key → case rows and a response scan, both sides.
- W69: [pending] given pull-request threads and Jira assignees, GitHub login X and Jira account Y are linked `corroborated` when they share at least 3 distinct `KAFKA-n` (read with the Kafka search profile's identifier pattern) and that count is at least 3 times every other pairing of X and of Y; bots and unassigned issues pair nothing → case rows, recorded (`unknowntpo`, `harmadasg`, `m1a2st`, `chia7712`) and constructed boundaries (2 keys; 6 vs 2; 6 vs 3; a backport).
- W70: [pending] given KIP starters and Jira issues whose summary names the KIP, a dev@ identity and a Jira account whose display name has the same `nameKey` as the starter (reporter or assignee) are linked `corroborated` on at least 2 distinct KIPs, with no other account for that identity and no other identity for that account; a KIP named only in the description pairs nothing → case rows (KIP-1371 alone: no link; KAFKA-20728; two accounts with one name).
- W71: [pending] given qualifying edges, a GitHub login and a dev@ identity are one person only through a Jira account with both edges; a component with two identities of one source publishes none of its corroborated links and counts a `conflict` → case rows (`unknowntpo` / Eric Chang: GitHub and Jira linked, dev@ separate).
- W72: [pending] given roster and declared links, a corroborated link that would join two ASF ids or two people the declared list keeps apart is dropped and counted as `contradiction`; an `identityLinks` entry with `remove: true` suppresses its pair and a suppressed identity gets no link, both from the next run → case rows, with a positive control (the same inputs without the entry link the pair).
- W73: [pending] given the same inputs in any order, the job writes byte-equal `osskb.identity-links.v1` tables in which every link has a basis and its evidence ids (`KAFKA-n` with pull requests; `KIP-n` with the Jira issue and the dev@ thread), each with its URL → unit test.
- W74: [pending] given `PEOPLE_KIPS=true`, the profile of a dev@ identity lists the KIPs it started (title, root date, dev@ thread link) in `[data-section="kips"]` after `activity`, and the profile of an identity linked to it lists them with the basis and the evidence links; given the flag unset, there is no section and `links.json` is not read → API and component tests, both sides.
- W75: [pending] given a profile with the section, "how this is computed" states "started the discussion" (not "authored"), the activity log's coverage start, that KIPs started earlier are not listed, and the link table's `generatedAt` → component test.
- W93: given recorded KIP page views (KIP-1165, KIP-1360, KIP-1279: plain lists; KIP-952: two user mentions; KIP-1183 and KIP-1300: an email in the line; KIP-986: a block that does not start with the label; KIP-1026: a line below the `Status` heading; KIP-1371: no line; KIP-950: a "Collaborators" line), the parser takes the first `Author(s):` / `Co-Author(s):` block of the page header (before the first heading after `Status`, or before the first heading without one), splits it at mentions, commas, semicolons, `&` and `and`, drops parts holding `@` or angle brackets, and returns the names in page order with status `listed`; a part that is not a name makes the page `unparsed` with no author; no line is `no-list`; "Collaborators" and "Contributors" are never authors (amendment (7), KIP authors) → case rows.
- W94: [pending] given a KIP and an identity, the line shows "author (KIP page)" when the page's list names the person (resolved by W95), else "assigned the KIP's Jira issue (KAFKA-n)" when the person's Jira account is the assignee of an issue the page's `JIRA:` field names, else "started the discussion" when the starter rule holds; the lower bases that also hold are shown as "also …"; a starter the list does not name keeps "started the discussion"; the page creator and editors give nothing → case rows (KIP-1165, KIP-1371, KIP-1272 recorded; constructed).
- W95: [pending] given an author name with `nameKey` k, it links to a profile only through a `declared` entry naming `mail:k` or through `mail:k` having written, within the coverage, in a dev@ thread whose title names exactly that KIP; otherwise it is a plain name; an author name never creates an identity, never joins two identities, and never feeds a `corroborated` link; "Henry Cai" does not link to `mail:henry haiying cai` → case rows, with a positive control for each rule.
- W96: [pending] given `PEOPLE_KIPS=true`, `[data-section="kips"]` lists every KIP where the identity, or an identity linked to it, is an author or the starter, newest first, each with KIP-n, title, label, the full author list in page order (linked names as profile links, others as escaped text), the KIP page link and the dev@ thread link; "how this is computed" names both sources and their coverage → component test and API test.
- W102: given any `authors.json`, `/api/people` response or `/health` body, it holds no Confluence username, user key, email address, avatar or page body text, and no author part containing `@` → test over the recorded pages of W93 (slice B covers `authors.json` and `/health`; the profile slice extends it to `/api/people`, row "names only" in `kip-authors.cases.ts`).
- W103: [pending] given the committers capture (68 pairs, its date), the Kafka profile's `identityLinks` holds one `declared` entry `github:<login>` ↔ `mail:<name key>` per pair with the committers page as evidence, none for a name that appears twice; `refresh:committers` on a changed capture prints added, removed and changed pairs, and a removed pair has no entry; `measure:identity-links --blind` and `?dryRun=1&blind=1` leave these entries out → unit test and command test on a constructed capture.
- W104: [pending] given an `identityLinks` entry whose `evidence` is not an `https` URL (including the owner's TODO example), the profile validation rejects it and no link is made; with a URL, `github:unknowntpo`, `jira-account:JIRAUSER306218` and `mail:eric chang` are one person and the GitHub page lists KIP-1371 → config test and case rows.
- W107: given recorded KIP page bodies, the `JIRA:` field is read from the first block of the page header (as in W93) starting with `JIRA`: KIP-1371 gives `one` [KAFKA-20995], KIP-1370 `several` [KAFKA-20888, KAFKA-20883] in page order, KIP-1383 `empty`, a page linking only the template's KAFKA-1 `empty`, a Jira query macro `query`, a page without the block `none` (amendment (7), the KIP's Jira issue) → case rows.
- W109: [pending] given an issue read by the job with assignee A and a newer activity-log Jira entry for the same key with assignee B, the KIP's line goes to B only; an issue re-read with a new assignee replaces the old one; earlier assignees are not kept; an unassigned issue gives no line → case rows.
- W110: given a recorded Jira response with `assignee` and `reporter` objects (key, name, displayName, timeZone, avatarUrls, active), `authors.json` keeps only the assignee's `key` and `displayName` per issue, nothing of the reporter, and no response or `/health` body carries more → test over the recorded issues (slice B covers `authors.json` and `/health`; the profile slice adds its responses).
- W111: [pending] given `PEOPLE_KIPS=true`, the profile of `jira-account:<key>` lists the KIPs whose listed issue it is assigned, and a GitHub or dev@ identity linked to that account (roster, declared or corroborated) lists them with the link's basis; with the recorded corroborated link `github:unknowntpo` ↔ JIRAUSER306218, `github:unknowntpo` lists KIP-1371 as "assigned the KIP's Jira issue (KAFKA-20995)"; with no link, the GitHub page lists nothing; no display name is compared → API test and case rows.

### Failure and retry

- W9: given a publication whose activity append fails (an R2 error, or a throw), the publication still commits its state and records an `ok` run whose `activity` reports the failure, `state.json` does not advance, and the next run writes the missed rows (they are still in the state for 35 days), including a summary whose month was not written → pipeline and append tests.
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
- W76: [pending] given a read of an activity month, the roster or the previous table that fails or does not parse, the job writes no table for that project, keeps the last good one, and records `ok: false` with the object key → test with a failing bucket.
- W77: [pending] given no activity `state.json`, the run reports `no-input` and writes nothing; given no roster object, it writes a table without roster links and `inputs.rosterAt: null` → case rows.
- W78: [pending] given unchanged inputs, a second run does not write `links.json` and writes `last-run.json` only → counting bucket, with a positive control (one changed month rewrites the table).
- W79: [pending] given a crash after the table is written and before `last-run.json`, the next run converges (table unchanged, status written); the table is always written before the status → test that throws between the two puts.
- W80: [pending] given `links.json` missing or unparsable, `/api/people/:project/:id` answers 200 with the identity's own KIPs and says links are not available → API test.
- W81: [pending] given the job throws on its cron, the publication is neither started nor changed, the publication's cron never runs the job, and the job writes nothing outside `internal/identity/v1/` → Worker test on `scheduled` with both cron strings and a recording bucket.
- W82: [pending] given a cron run and a manual run on the same inputs at once, both write equal bytes with plain puts (no conditional put) → unit test.
- W83: [pending] given dev@ rows written before `opens` existed, none is a root, and the note states from when starters are known → case rows.
- W84: [pending] given a Jira issue whose assignee changed between two months, only the newest entry pairs, and the key counts once → case rows.
- W85: [pending] given `IDENTITY_LINKS` unset, the cron entry and `POST /identity-links/run` do nothing (the route answers 404), make no R2 call, and `/health` has no `identityLinks` → Worker test.
- W97: given a cwiki request that fails, times out, answers 429 or 5xx, or returns JSON that does not parse, or a run that would need an 11th request, the `kip-pages` job writes no table, keeps the last good one, records `ok: false` with the status (`failed`, `over-budget`) and does not retry within the run; the next run starts from the last good run's `since` → unit test with a stub fetch, with a positive control.
- W108: the `kip-pages` job reads the assignees of the `JIRA:` keys of pages new or changed in the run (and of every key in the table on Mondays) with `search?jql=key in (…)&fields=assignee&validateQuery=warn`, at most 100 keys and at most 3 requests per run; an unknown key is dropped, not an error; a failed Jira request fails the run closed like a cwiki failure; on a Monday the re-read is capped at 300 keys, the changed pages' keys first and then the oldest readings; a positive control writes the issues → unit test with a stub fetch.
- W98: given the `kip-pages` job throws, the publication, the digest and the identity-link job are neither started nor changed and it writes nothing outside `internal/kips/v1/`; none of them calls cwiki; given `authors.json` missing or unparsable, `/api/people/:project/:id` answers 200 with the starter lines and says author lists are not available → Worker test and API test (slice B: the Worker half; the API half is the "table missing" row in `kip-authors.cases.ts`, run by the profile slice).
- W99: given `KIP_PAGES` unset, the cron entry and `POST /kip-pages/run` do nothing (the route answers 404), make no request to cwiki and no R2 call, and `/health` has no `kipPages` → Worker test.
- W105: given a previous table and a search answer, a page whose `version.number` changed replaces its entry, an unchanged page keeps it, a title without `KIP-<n>` is skipped, the request's `since` is the last good run's start minus one day (365 days back without a table), the output is sorted and byte-equal for equal inputs, and an unchanged table is not written (only `last-run.json`) → unit test with a counting bucket.

### Budget

- W17: [measure] the activity append sends at most 1 + 12 Class B and 2 × 12 + 1 Class A requests per project per run, writes no per-identity object, and writes no month whose bytes did not change; measured: first append 14 Class A and 8 Class B for 6 months, an unchanged rerun 2 Class A and 8 Class B (amended 2026-10-15: a pull request's month is its creation month, so a run can touch any month since the coverage start, not only 2; command `measure:memory --activity 1`, worst case per day in amendment (2)).
- W18: [measure] `/api/people` for the identity with the most rows over 12 months parses under 16 MB and answers under 500 ms in the Pages reader (limit 128 MB; command `measure:people`). 2a: measured on review months at Dev's volume, reported in the PR. 2b: with 12 full months of the activity log, Kafka 11.6 MB and DataFusion 23.2 MB parsed (46 MB at 2×), 26 reads, under 210 ms; the 16 MB budget fails once the DataFusion log is about 8 months old (G75).
- W33: [measure] (slice 7) a list request parses at most 12 summaries per project, under 2 MB, measured with `measure:people`.
- W43: a cold person search reads at most 13 R2 objects per project, all of them keys a profile reads (since 2b a profile also reads the activity log), none when warm within 10 minutes, and none after a profile request in the same isolate; the handler runs with only `OSS_KB_BUCKET` and `PEOPLE_PROFILES` bound (no AI, Vectorize or search binding) → API test with a counting bucket.
- W44: [measure] a person search on a store of Dev's size answers under 50 ms warm and under 500 ms cold in Bun, measured with `measure:people`.
- W19: [measure] the publisher's peak memory with the activity append stays within the Spec 009 budgets at 8,600 and 17,200 events (`measure:memory --kafka 1 --activity 1`): measured 54.3 and 102.7 MB, the append phase 52.2 and 97.8 MB, unchanged peaks.
- W20: [measure] review ingestion adds at most one GitHub request per pull request updated that day, and a day's batch stays inside the hourly request limit (slice 1; measured by Spec 022 RV21 and RV22 with `measure:github-reviews`).
- W54: [measure] the area distributions of `m1a2st` and `chia7712` in amendment (4)'s Example, from public GitHub data (search `reviewed-by:` / `author:` updated since 2026-07-15, read 2026-10-15), reproduced by `areaDistribution` with the Kafka taxonomy.
- W21: [measure] the 12-month backfill of slice 6 states its request count and stored size per source (GitHub, Jira, dev@'s 12 monthly archives) before it runs, measured, not estimated, and stays under each source's limit; it runs outside the publication.
- W86: [measure] one identity-link run for Kafka with 12 full activity months reads at most 15 objects (Class B) and writes at most 2 (Class A), keeps one month parsed at a time, and reports peak heap and duration; DataFusion makes no call (command `measure:identity-links -- --budget`, against a constructed log of Dev's size; amendment (7)).
- W87: [pending] given a cold isolate with `PEOPLE_KIPS=true`, one profile request reads at most 28 objects (W29's 26, `links.json` and `authors.json`), and a second within 10 minutes reads none → API test with a counting bucket.
- W88: [measure] the first activity append after the change rewrites at most the months in the 35-day state once and then nothing for unchanged rows; a Jira page of 100 issues with `assignee` stays under the 4 MiB source limit; the bytes added per page are reported (command `measure:memory --activity 1` and a recorded Jira page).
- W89: [measure] before enabling, `measure:identity-links -- --from <date> --to <date>` (public upstream data only: GitHub search, ASF Jira REST, Pony Mail, the committers page) reports corroborated links, committers touched, `agree`, `contradict`, committer `unlabelled`, and links to label; the gate is `contradict` 0, committer `unlabelled` 0, and no link labelled "different" in W16's sample; recall is reported. Recorded 2026-10-21 for 2026-09-15 to 2026-10-21: 28 links, 3 committers, 3 agree, 0 contradict, 25 to label.
- W101: [measure] one `kip-pages` run sends at most 10 cwiki requests and 3 Jira requests, sequential and at least 2 s apart, with the project's `User-Agent`; the first run on Kafka (365 days, about 225 pages) sends at most 5 and a normal day 1 to 2, and the run reads 1 R2 object and writes at most 2; the command `measure:kip-pages` reports requests, bytes, pages, `listed` / `no-list` / `unparsed` counts and duration from public cwiki data.
- W112: [measure] `measure:kip-pages -- --agreement` reports, from public data, the `JIRA:` field classes over all KIP pages and, for pages with one issue, assignee unset, assignee = creator, assignee in the author line, assignee = starter (exact, other written form, other script, different), and the KIPs whose assignee has a corroborated GitHub link; the 2026-10-21 reading is 1,160 / 45 / 138 / 8 / 20, then 17 unset, 180 of 219, 12 of 12, 126 / 24 / 16 / 30 of 196, and 33 KIPs for 13 people.

### Observability

- W22: [deploy] `/health` `lastRun.activity` reports the append: `ok`, `rows`, `monthsRead`, `monthsWritten`, `monthsUnchanged`, `identities`, `earliestMonth`, `coverageFrom`, `bytesWritten`, `durationMs`, `r2` (its own Class A and B, apart from `lastRun.r2`), or `error`; absent while `PEOPLE_ACTIVITY` is unset (the field shape is unit-tested; Dev values are checked by the enable PR's operator sequence). Review ingestion is not reported here: it has its own `/health` `githubReviews` (Spec 022 RV24), which the page's "how this is computed" note takes `coverageFrom` from.
- W23: [deploy] on Dev, the page for `github:chia7712` shows the period covered and the coverage line, and its counts equal the `/api/people` response; the response's review totals agree with the upstream oracle of the 2a Example within the reviews submitted after the oracle was read.
- W55: [deploy] on Dev, after Spec 022's refresh reports `done` for both projects, `/api/people/kafka/github:m1a2st` has `pullAreas` for every reviewed pull request and `identity.name` "Ken Huang", and the page draws both charts with no "covered X of Y" note; `github:chia7712` shows "Chia-Ping Tsai".
- W27: given a community with sources the profile does not read yet, the response lists each with status "not recorded" and the page shows "<sources>: not recorded yet" without a count; given the review store, the page shows "Reviews: <from> to <until>" with the dates of the response → case rows and component test, both sides.
- W28: given the Dev configuration, a GitHub record's author in Detail links to `/#/<project>/people/github:<login>`; a bot author does not link; a Jira or dev@ author links to `jira:<name key>` or `mail:<name key>` only where `/api/people` lists that source in `recorded` (2b), and not before the log's first append (2a); given the Prod configuration, no author links → component test and E2E, both sides.
- W29: given a cold isolate, one profile request reads at most 26 objects from R2 for its project (the two `state.json` objects, 12 review months none before Spec 022's `coverageFrom`, and 12 activity months none before the log's `coverageFrom`; a Jira or dev@ identity reads no review month); a second request within 10 minutes reads none; one after 10 minutes reads them again → API test with a counting bucket (amended 2026-10-15 for 2b: 13 before).
- W90: [deploy] on Dev with `IDENTITY_LINKS=corroborated@1` and `PEOPLE_KIPS` unset, `POST /identity-links/run?dryRun=1` gives the W89 counts from the real inputs, with `contradict` 0, before the Pages flag is set; the enable PR records both readings, the window and the commit of the labelled sample.
- W91: [pending] `/health` `identityLinks` is `{revision, lastRun {ok, status (ok, unchanged, no-input, failed), at, durationMs, inputs {months, activityUpdatedAt, rosterAt, committersAt}, links {roster, declared, corroborated}, rejected {dominance, minimum, conflict, contradiction, removed}, people, kipStarters, bytesWritten, r2 {classA, classB}, error?}, lastGoodAt}` while `IDENTITY_LINKS` is set → unit test on the field.
- W92: [deploy] on Dev after step 4 of amendment (7), `/health` `identityLinks.lastRun.ok` is true on two consecutive days, and the profile of `mail:arnab nandy` lists KIP-1381 and KIP-1382 (or, if they left the coverage, the note says so).
- W100: `/health` `kipPages` is `{revision, lastRun {ok, status (ok, unchanged, failed, over-budget), at, durationMs, since, requests, jiraRequests, pagesRead, pagesChanged, listed, unparsed, issuesRead, unassigned, bytesWritten, r2 {classA, classB}, error?}, lastGoodAt, coverageFrom}` while `KIP_PAGES` is set → unit test on the field.
- W106: [deploy] on Dev after step 4, `/health` `kipPages.lastRun.ok` is true on two consecutive days, and the profile of `mail:viktor somogyi-vass` lists KIP-1165 as "author (KIP page)" with "also started the discussion" and nine author names in page order (or, if KIP-1165 left the coverage, the note says so).

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
| 11 | KIP authorship and corroborated links (2026-10-21) | **"Authored" = started the earliest `[DISCUSS] KIP-n` thread on dev@, within the recorded range; a third link basis `corroborated` (GitHub ↔ Jira on ≥ 3 `KAFKA-n`, Jira ↔ dev@ on ≥ 2 `KIP-n`, provisional until a precision check); linking is its own job; profiles read its table behind a flag, Dev first. Revised the same day (owner): a KIP can have several authors; the KIP page's author line (read by its own `kip-pages` job) comes first, "started the discussion" second; the assignee of the issue the KIP page's `JIRA:` field names is line 2 ("assigned the KIP's Jira issue"), read by the same job; dominance 3 and edge B at 2 accepted; the committers page's 68 pairs become `declared` links** | Amendment (7); W66–W112; revises precision rule 2, decision 5, identity rule 2 | Page creator or editors as authors; Confluence usernames as identities; dev@ starter only (KIP-1165 would list one of nine authors); linking as a step of the publication or of the activity append; similarity or model-based matching |

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
- Amendment (7): who wrote the 98 % of KIP pages without an author line
  (the starter is assumed, labelled as such); whether ASF Jira account keys can change
  (`key` is documented as stable for Jira Server; not checked for ASF's
  instance); the precision of `corroborated` beyond the 3 committers and 28
  links of the 2026-10-21 reading, until the 25 links are labelled; how many
  Jira issues of the Example's keys are in the Dev activity log (all 221
  were read from Jira directly).

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
