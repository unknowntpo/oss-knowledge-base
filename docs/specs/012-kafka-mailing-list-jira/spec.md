# Spec 012: Kafka dev mailing list and Jira sources

Status: Accepted 2026-10-06
Date: 2026-10-06
Traceability: enforced
Builds on: Spec 004, Spec 005, Spec 008, Spec 009; `docs/domain/community-model.md`

## Intent

A Kafka maintainer wants to see what the Kafka community is discussing now:
KIP discussions and votes on dev@kafka.apache.org, the KAFKA Jira issues
behind them, and the GitHub pull requests that implement them, so they can
judge where the project should go next. Today the product shows only GitHub.

Outcome: dev@ threads and linked KAFKA issues appear in Feed, Search, and
Detail next to GitHub records, each with a citation to its canonical URL, and
Detail shows deterministic links between a KIP thread, its Jira issue, and the
pull request. AI topic summaries are a later spec.

Human decisions (2026-10-06): dev@ only; 30-day backfill; Jira issues linked
to GitHub or to a KIP thread are shown. At acceptance (2026-10-06) the human
also decided: unlinked Jira issues are stored, not published; a Jira issue
naming a KIP is published only when a retained dev@ thread names the same KIP;
entries stay separate and are joined by Related links; the contract changes
below are approved, with each source's status reported separately in
`/health`; K25 stays, and Spec 013 (streamed Search publication) lands first;
mail stays at 200-character previews.

## Evidence

Feasibility spike, 2026-10-06, about 40 anonymous read-only requests at about
1 request/s or slower. Raw samples (trimmed, addresses redacted) are in
`docs/specs/012-kafka-mailing-list-jira/samples/`.

| | dev@kafka.apache.org | KAFKA Jira |
| --- | --- | --- |
| Where | Pony Mail Foal, `lists.apache.org/api/stats.lua?list=dev&domain=kafka.apache.org&d=lte=Nd` | ASF Jira Server 8.20.10 (not migrated), `issues.apache.org/jira/rest/api/2/search` |
| Auth | anonymous | anonymous (`/rest/api/3` redirects to login; `/search/jql` is 404) |
| Incremental | no `since`; relative day window `d=lte=Nd` or month `d=YYYY-MM`; dedupe by `mid` | JQL `updated >= "-Nm"` (relative, so the unknown server timezone does not matter) `ORDER BY updated ASC, key ASC`; `startAt`/`maxResults` |
| Page | whole window in one response, `hits` = `emails.length`: 28 d = 500 emails / 670 KB; month 2026-09 = 520 / 699 KB; 90 d = 1,354 / 1.8 MB (so 500 is not a cap) | `maxResults=100` honored; one page of 100 issues with `summary,description,status,updated,created,reporter,comment` = 671 KB |
| Rate limit | none advertised; `cache-control: max-age=600` | no `X-RateLimit-*` or `Retry-After` seen |
| Volume | 107–149 emails/week, about 94 threads/week; 53% are Jira notification mail | 154 issues updated/week, about 50 created, 54 comments |
| Identity | Pony `mid`; `in-reply-to` is null for most replies in captured threads | issue key, comment id, `updated` (`2026-09-29T20:24:00.702+0000`) |
| Body | list view has a 200-char preview; full body needs one `email.lua` call per message | `description` and comment `body` inline (comments are lifetime, not only recent) |
| Privacy | JSON obfuscates addresses (`an...@outlook.com`); `mbox.lua` does not | `emailAddress` is null for anonymous |

Linking, observed:

- 13 of the last 30 apache/kafka PR titles start with `KAFKA-NNNNN:`, one has
  it mid-title (`WIP: KAFKA-20292: …`), 12 are `MINOR`; none name a KIP.
- 71 of 500 dev@ subjects name a KIP; 277 name a KAFKA key, almost all in Jira
  notification mail.
- Of 100 KAFKA issues updated in the last 7 days, 4 name a KIP in the summary
  and 15 in summary or description. Jira descriptions name the KIP they track
  (`…tracks the development of KIP-1279`, or a wiki URL containing
  `KIP-1368+Client+…`). JQL `text ~ "KIP-1368"` returned 0 issues, so Jira
  text search is not usable for linking.
- Jira remote links (`/issue/KEY/remotelink`) give the PR URL but cost one
  request per issue.

Memory (`bun run --cwd apps/data-publisher-worker measure:memory -- --events
8600,9800,17200,19600`, 2026-10-06, GitHub-shaped seeded events as a proxy):
63.1 MB at 8,600, 71.4 MB at 9,800, 120.8 MB at 17,200, 136.6 MB at 19,600;
the peak is always "write search". About 7 MB per 1,000 events.

## Example

Captured 2026-10-06; `now` = 2026-10-06T08:00:00Z, so the 30-day window starts
2026-09-06T08:00:00Z.

**1. A KIP vote thread.** "[VOTE] KIP-1279: Cluster Mirroring" has 8
messages. Its root (2026-07-08, Federico Valeri, mid `cjo3555p…`) and one
reply (2026-07-12) are older than the window; 6 replies are inside it
(2026-09-11 ×2, 09-14, 09-15 ×2, 09-18). The newest, mid
`15rddlqk42tqsjh5rw2r6so5cgns122f`, announces that the vote passed with 3
binding votes.

Each in-window message becomes one event:

```json
{ "entityId": "kafka:mail:dev:message:15rddlqk42tqsjh5rw2r6so5cgns122f",
  "sourceInstanceId": "kafka:mail:dev",
  "sourceCursor": "2026-09-18T16:06:37.000Z",
  "data": { "contract": "mail-record@1",
    "subject": "Re: [VOTE] KIP-1279: Cluster Mirroring",
    "author": "Federico Valeri", "occurredAt": "2026-09-18T16:06:37.000Z",
    "url": "https://lists.apache.org/thread/15rddlqk42tqsjh5rw2r6so5cgns122f",
    "excerpt": "<Pony Mail 200-char preview>",
    "kips": ["KIP-1279"], "jiraKeys": [] } }
```

The six messages share the thread key `[vote] kip-1279: cluster mirroring`
(normalized subject), so they form one Feed entry: title
"[VOTE] KIP-1279: Cluster Mirroring", source `mail`, status `discussing`, 6
records; its canonical link is the newest message's thread link
`https://lists.apache.org/thread/15rddlqk42tqsjh5rw2r6so5cgns122f`.

**2. The Jira issue behind the KIP.** KAFKA-20186 "Cluster Mirroring", In
Progress, updated 2026-10-06T06:49:33.889+0000, description "This Jira tracks
the development of KIP-1279: …". It becomes `kafka:jira:issue:KAFKA-20186`,
title "KAFKA-20186: Cluster Mirroring", status `open`, `kips: ["KIP-1279"]`.
A retained dev@ thread also names KIP-1279, so it is published.

**3. A Jira issue fixed by a PR.** KAFKA-20184 "jose4j marked as compileOnly in
clients module causes ClassNotFoundException at runtime for OAuth
authentication", Patch Available, updated 2026-09-29T20:24:00.702+0000, 4
comments. Three comments are from February, so only the issue and the
2026-09-29 comment (loicgreffier) are within retention. GitHub PR #21518
"KAFKA-20184: Remove static jose4j references from DefaultJwtValidator" (open)
is already in the GitHub source, so KAFKA-20184 is published with 2 records.

**4. Links shown in Detail** (deterministic, from keys in titles, subjects,
and Jira descriptions):

| Detail of | Related | Rule |
| --- | --- | --- |
| [VOTE] KIP-1279 thread | KAFKA-20186 | same KIP |
| KAFKA-20186 | [VOTE] KIP-1279 thread | same KIP |
| KAFKA-20184 | PR #21518 | key in title |
| PR #21518 | KAFKA-20184 | key in title |

No full three-way chain exists in the current window: KIP-1279 has a Jira
issue but no PR yet, and KAFKA-20184 has a PR but no KIP. The rules compose, so
a KIP thread → Jira → PR chain appears when one exists.

**5. Not published.** KAFKA-21227 "Speed up ColdStartStickinessIntegrationTest"
(Open) is stored, but no PR title, dev@ subject, or KIP thread cites it, so it
is not in Feed. A PR titled "KAFKA-21227: Speed up
ColdStartStickinessIntegrationTest" was opened the same week; once that PR is
in the GitHub source, the issue is published. "[jira] [Created] (KAFKA-21049)
…" mail on dev@ is never ingested; the Jira source already carries
KAFKA-21049.

## Simplification review

1. **Requirements and owners.** The maintainer needs: which KIPs and topics are
   being discussed (dev@ subjects and who replies), the Jira issues that track
   them, and the PRs that implement them, each citable. Nothing else is
   required by this spec; the later AI-summary spec owns anything it needs.
2. **Deleted:**
   - Other lists (users@, commits@, jira@): human decision.
   - Notification mail on dev@ (`[jira] …`, `[PR] …`, and replies to them):
     53% of dev@ traffic, duplicating the Jira and GitHub sources.
   - Full mail bodies (`email.lua` per message, `mbox.lua`): the 200-char
     preview is the excerpt, as for GitHub. Saves about 280 requests on
     backfill and about 60 per week. Reply previews are often quote headers
     ("On … wrote:"); the AI-summary spec may add bodies back.
   - `in-reply-to` / `references` threading: null for most captured replies,
     Pony Mail's own thread ids change with the window, and the KIP-1279 result
     references a synthetic `pony-…` id. The normalized subject is the only
     thread key. A `[RESULT] [VOTE]` message or a renamed subject forms its
     own entry, linked by the KIP rule.
   - Sender addresses: obfuscated in JSON and private in mbox; only the display
     name is kept.
   - Jira fields: priority, labels, components, fix versions, assignee, issue
     links, parent and subtasks, attachments, worklog, changelog, votes,
     watchers, resolution (status alone gives open/resolved). Requested
     fields are pinned to `summary,description,status,updated,created,reporter,comment`.
   - Jira remote links: one request per issue; the PR title already gives the
     link in the other direction (it covers the sampled KAFKA-20184 case).
   - Jira JQL text search for KIPs: returned nothing for a KIP whose issue
     exists.
   - KIP wiki (Confluence) source, KIP entities, merged KIP Feed entries, vote
     tallies (planned in `docs/ingestion-spec.md` §2.4 and §4): Detail links
     between records are enough to follow a KIP; merging belongs with AI
     topics.
   - Jira issues that nothing links to are stored but not published
     (Behavior 6). About 150 issues change per week; most are bug reports and
     flaky-test tickets. The intent is "what the community discusses", and a PR
     or a dev@ thread is the signal of that. Cost: an actively commented bug
     with no PR is hidden. Not deleted: the human's decision to show linked
     issues.
   - "Names any KIP" as a publish reason (first draft): 15 of 100 recent issues
     mention a KIP, often in passing; the human asked for issues linked to a
     KIP *thread*, so an issue is published only when a retained dev@ thread
     names the same KIP.
   - Absolute-time JQL: the anonymous user's timezone is unknown.
3. **Simplified:** one request per run for mail (`stats.lua` with a day
   window) and at most two Jira search pages per run; thread grouping and
   linking are pure functions of the retained events, so a replay rebuilds
   them.
4. **Shorter cycle:** connector rules (filter, keys, thread key, status,
   windows, publish rule, failure classification) are pure functions tested
   from the case file below; captured samples are the fixtures.
5. **Automated last:** no new jobs. Both connectors run inside the existing
   hourly publication run.

## Behavior

1. **Sources.** Two source instances for project `apache-kafka`:
   `kafka:mail:dev` (source key `mail`, status `discussing`) and `kafka:jira`
   (source key `jira`, statuses `open`, `resolved`). The Kafka project's Feed
   sources become `github`, `mail`, `jira`, and its status filter offers each
   source's statuses; DataFusion is unchanged. Source profiles are keyed by
   source instance id, not project id.
2. **Mail records.** Each dev@ message from `stats.lua` becomes one event of
   contract `mail-record@1`: entity `kafka:mail:dev:message:<mid>`, cursor and
   `occurredAt` = message time in UTC with milliseconds, subject, author
   display name (or "unknown sender"), 200-char preview as excerpt, URL
   `https://lists.apache.org/thread/<mid>`, and the keys matching
   `\b(KIP|KAFKA)-(\d+)\b` (case-sensitive) in the subject. A message is
   dropped when its normalized subject (Behavior 3) starts with `[jira]` or
   `[pr]`. A message dated more than 1 hour after now is skipped and counted.
3. **Threads.** A thread is the set of retained messages with the same
   normalized subject: leading `Re:`, `RE:`, `Fwd:`, `FW:`, `AW:` prefixes
   removed repeatedly, whitespace collapsed, lowercased. One Feed entry per
   thread; title = the newest subject without reply prefixes; status
   `discussing`; canonical URL = the newest message's URL (it changes only on
   new activity); display id `KAFKA-MAIL-` plus the first 8 hex characters of
   the SHA-256 of the thread key.
4. **Jira records.** Each KAFKA issue becomes one event of contract
   `jira-record@1` (entity `kafka:jira:issue:<KEY>`, cursor and time =
   `updated` normalized to UTC `Z` with milliseconds) with title
   `<KEY>: <summary>`, native status, status `resolved` for Resolved/Closed
   and `open` otherwise, reporter display name, 280-char description excerpt,
   URL `https://issues.apache.org/jira/browse/<KEY>`, and the KIP keys in
   summary and description. Each comment becomes one event
   (`…:comment:<id>`, cursor and time = its `updated`, parent = the issue, URL
   `…/browse/<KEY>?focusedCommentId=<id>`). Display id = the key. The
   materializer reads GitHub, mail, and Jira events by their contract.
5. **Windows.** The first run reads 30 days (mail `d=lte=30d`, messages older
   than now − 30 d discarded; Jira `updated >= "-43200m"`). Later runs read
   from the cursor with overlap: mail `d=lte=<ceil(gap in days) + 1>d`, Jira
   `updated >= "-<ceil(gap in minutes) + 10>m"`, both capped at 30 days.
   `gapCapped` is true only when the gap itself exceeds 30 days. The mail
   cursor is `min(newest message time, now)`. Events are deduplicated by
   entity and cursor, so overlap is harmless; an event with an existing
   identity but different content keeps the stored one and is counted as a
   conflict instead of failing the run. Jira reads at most 200 issues per run
   (2 pages of 100); when truncated, its cursor is the last issue read and
   later runs catch up (as GitHub does). Responses larger than 4 MB fail the
   source as `too-large`.
6. **Published Jira issues.** A Jira issue appears in Feed, Search, and Detail
   only when (a) a retained GitHub issue or PR title contains its key,
   (b) a retained dev@ subject contains its key, or (c) it names a KIP that a
   retained dev@ subject also names. Other issues stay in state until
   retention removes them.
7. **Related links.** Detail shows links between published entries, without
   merging them: title or subject citing `KAFKA-N` ↔ Jira `KAFKA-N`; entries
   naming the same `KIP-N` (dev@ threads and Jira issues). Each link names its
   rule (`key in title`, `same KIP`) and rule revision.
8. **Search.** Mail and Jira records are indexed like GitHub records; an exact
   query for a Jira key or a KIP finds records whose title contains it, and a
   hit opens its entry's Detail by the entry's display id.
9. **Source independence.** Each source polls and commits its own cursor. A
   failed source (`transport`, `rate-limit`, `schema`, `truncated`,
   `too-large`) keeps its cursor and its retained events; the run still
   publishes with the other sources' new events and reports the failure per
   source. This also applies to GitHub. A run fails only when every source
   fails. A source whose read fails partway (e.g. Jira page 2) commits nothing
   from that run.
10. **Politeness.** Requests to one host are sequential, send
    `User-Agent: oss-knowledge-base/1.0 (+https://github.com/unknowntpo/oss-knowledge-base)`,
    and carry no credentials. A 5xx, 429, or transport error is retried once,
    after `Retry-After` when it is at most 60 s (otherwise 5 s); a second
    failure, or a `Retry-After` above 60 s, fails the source until the next
    hourly run.
11. **Retention.** Mail and Jira events follow the existing 35-day retention
    by their own time; a comment older than that is dropped even when its
    issue is retained. A Jira issue moved out of KAFKA is not seen again and
    ages out; one moved into KAFKA appears under its new key. A deleted Jira
    comment or mail message stays until it ages out.

## Contract changes and decision

Approved 2026-10-06 and recorded in
`docs/architecture/decisions/0014-publish-per-source-with-independent-cursors.md`:

1. One cursor per source instance in the existing checkpoint (its `sources`
   map is already keyed by source instance id, so no schema bump), and partial
   publication (a run is `ok` with failed sources). Revisit if a source's
   staleness hides a failure for more than 3 hours (Spec 011 can alert on it).
2. A `related` list on Feed Detail (entries, not records, with rule and
   revision), distinct from grouping relationships, which would merge entries.
3. Feed Detail carries its entry's display id, so a Search hit (which opens
   the Detail) shows it without parsing the title. Adding the field changes
   every Detail's bytes once, so the first run after deploy writes every
   Detail again (Spec 008 content addressing).
4. New source keys `mail` and `jira`, statuses `discussing` and `resolved`,
   and per-source `/health` fields (Behavior 9, K30, K32). The web app already
   has `mail`/`jira` labels and styles.

## Test plan

Generated from `packages/reference-pipeline/test/kafka-sources.cases.ts` by
`bun run docs:test-plan`; the unit tests in
`packages/reference-pipeline/test/kafka-sources.test.ts` (to be written) run
exactly these rows. Edit the case file, not this table. Rows marked
"constructed:" are synthetic edge cases; the others use captured values.
`now` is 2026-10-06T08:00:00Z.

<!-- test-plan:start packages/reference-pipeline/test/kafka-sources.cases.ts -->
| id | rule | input | expected |
| --- | --- | --- | --- |
| K1 | mail record | mid 15rddlqk42tqsjh5rw2r6so5cgns122f, from "Federico Valeri <fe...@gmail.com>", subject "Re: [VOTE] KIP-1279: Cluster Mirroring", epoch 2026-09-18T16:06:37Z | entity kafka:mail:dev:message:15rddlqk42tqsjh5rw2r6so5cgns122f; occurredAt 2026-09-18T16:06:37.000Z; author Federico Valeri; url https://lists.apache.org/thread/15rddlqk42tqsjh5rw2r6so5cgns122f; kips KIP-1279; jiraKeys none |
| K1 | mail record | constructed: from "Jun Rao via dev <de...@kafka.apache.org>" | author Jun Rao |
| K1 | mail record | constructed: from "<an...@outlook.com>" (no display name) | author unknown sender (address never stored) |
| K1 | keys | [jira] [Created] (KAFKA-21049) Async consumer can busy-loop … | jiraKeys KAFKA-21049 |
| K1 | keys | constructed: [DISCUSS] KIP-13680: … | kips KIP-13680 (not KIP-1368) |
| K1 | keys | constructed: re: kip-1279 question | kips none |
| K2 | mail filter | [jira] [Created] (KAFKA-21049) Async consumer can busy-loop while waiting for fetch progress when retry.backoff.ms is zero | dropped |
| K2 | mail filter | constructed: [PR] MINOR: Fix produce-ack race in ShareConsumerDLQTest multi-topic tests. | dropped |
| K2 | mail filter | [DISCUSS] KIP-1368: Client framework name and version | kept |
| K2 | mail filter | [VOTE] 4.4.0 RC3 | kept |
| K2 | mail filter | constructed: Re: [jira] [Created] (KAFKA-21049) Async consumer can busy-loop … | dropped |
| K2 | mail filter | constructed: [JIRA] [Resolved] (KAFKA-20953) Remove hamcrest … | dropped |
| K3 | thread key | [VOTE] KIP-1279: Cluster Mirroring | [vote] kip-1279: cluster mirroring |
| K3 | thread key | Re: [VOTE] KIP-1279: Cluster Mirroring | [vote] kip-1279: cluster mirroring |
| K3 | thread key | constructed: RE: Fwd:  Re: [VOTE]  KIP-1279: Cluster Mirroring | [vote] kip-1279: cluster mirroring |
| K3 | thread key | [DISCUSS] KIP-1279: Cluster Mirroring | [discuss] kip-1279: cluster mirroring |
| K3 | thread key | constructed: [RESULT] [VOTE] KIP-1279: Cluster Mirroring | [result] [vote] kip-1279: cluster mirroring (separate thread) |
| K4 | jira record | KAFKA-20186 "Cluster Mirroring", In Progress, description "…tracks the development of KIP-1279: …" | title KAFKA-20186: Cluster Mirroring; status open; kips KIP-1279 |
| K4 | jira record | KAFKA-20810, Open, description "…/pages/440304679/KIP-1368+Client+framework…" | status open; kips KIP-1368 |
| K4 | jira record | KAFKA-20184, Patch Available, no KIP in summary or description | status open; kips none |
| K4 | jira time | updated 2026-09-29T20:24:00.702+0000 | cursor and occurredAt 2026-09-29T20:24:00.702Z |
| K4 | jira record | KAFKA-20184 comment by loicgreffier, updated 2026-09-29T20:24:00.702+0000 | entity kafka:jira:issue:KAFKA-20184:comment:<id>; url …/browse/KAFKA-20184?focusedCommentId=<id> |
| K4 | jira status | Resolved | resolved |
| K4 | jira status | Closed | resolved |
| K4 | jira status | Reopened | open |
| K4 | jira status | constructed: Triage Needed (unknown name) | open |
| K5 | jira publish | KAFKA-20184; retained PR #21518 "KAFKA-20184: Remove static jose4j references from DefaultJwtValidator" | published |
| K5 | jira publish | KAFKA-20186; kips KIP-1279; retained dev@ thread "[VOTE] KIP-1279: Cluster Mirroring"; no PR | published |
| K5 | jira publish | constructed: KAFKA-20186; kips KIP-1279; no retained dev@ subject names KIP-1279; no PR | not published |
| K5 | jira publish | constructed: KAFKA-20184; retained dev@ subject "Re: KAFKA-20184 jose4j at runtime" | published |
| K5 | jira publish | constructed: KAFKA-20292; retained PR "WIP: KAFKA-20292: …" (key mid-title) | published |
| K5 | jira publish | constructed: KAFKA-20292; only PR title cites KAFKA-202920 | not published |
| K5 | jira publish | KAFKA-21227 "Speed up ColdStartStickinessIntegrationTest"; no PR, mail subject, or KIP cites it | not published |
| K5 | jira publish | constructed: KAFKA-21227; retained PR "KAFKA-21227: Speed up ColdStartStickinessIntegrationTest" | published |
| K9 | backfill window | message epoch 2026-09-06T08:00:00Z (now − 30 d) | ingested |
| K9 | backfill window | message epoch 2026-09-06T07:59:59Z (now − 30 d − 1 s) | not ingested |
| K9 | backfill window | no Jira cursor | JQL updated >= "-43200m" |
| K9 | backfill window | no mail cursor | d=lte=30d |
| K10 | jira window | cursor 60 min before now | updated >= "-70m"; gap capped no |
| K10 | jira window | cursor 3 d before now | updated >= "-4330m"; gap capped no |
| K10 | jira window | cursor 29 d 23 h 50 min before now | updated >= "-43200m"; gap capped no |
| K10 | jira window | cursor 29 d 23 h 51 min before now | updated >= "-43200m"; gap capped no |
| K10 | jira window | cursor exactly 30 d before now | updated >= "-43200m"; gap capped no |
| K10 | jira window | cursor 30 d 1 min before now | updated >= "-43200m"; gap capped yes |
| K10 | jira window | cursor 40 d before now | updated >= "-43200m"; gap capped yes |
| K10 | mail window | cursor 1 h before now | d=lte=2d; gap capped no |
| K10 | mail window | cursor exactly 1 d before now | d=lte=2d; gap capped no |
| K10 | mail window | cursor 1 d 1 s before now | d=lte=3d; gap capped no |
| K10 | mail window | cursor 29 d 1 s before now | d=lte=30d; gap capped no |
| K10 | mail window | cursor 30 d 1 s before now | d=lte=30d; gap capped yes |
| K10 | mail window | constructed: cursor 1 h after now (misdated mail) | d=lte=2d; gap capped no |
| K10 | mail window | cursor 40 d before now | d=lte=30d; gap capped yes |
| K12 | retry | constructed: Jira 429 with Retry-After: 30, then 200 | one retry after 30 s; ok |
| K12 | retry | constructed: Jira 429 with Retry-After: 120 | no retry; source failed (rate-limit, retry after 120 s); cursor unchanged |
| K12 | retry | constructed: Pony Mail 503, then 503 | one retry; source failed (transport); cursor unchanged |
| K13 | malformed mail | constructed: message without epoch | skipped, counted |
| K13 | malformed mail | constructed: message with subject null | skipped, counted |
| K13 | malformed mail | constructed: message without mid | skipped, counted |
| K13 | misdated mail | constructed: epoch 2 d after now | skipped, counted; cursor unchanged |
| K13 | misdated mail | constructed: epoch 59 min after now | ingested; cursor = now |
| K14 | malformed jira | constructed: issue without fields.updated | skipped, counted; cursor = newest valid updated |
| K14 | malformed jira | constructed: issue without key | skipped, counted |
| K15 | duplicate | same mid 15rddlqk42tqsjh5rw2r6so5cgns122f in two overlapping windows | one event |
| K15 | conflict | constructed: same mid and epoch, different preview text | first stored event kept; conflict counted; run not failed |
| K20 | truncated mail | constructed: hits 500, emails 499 | source failed (truncated); cursor unchanged |
| K20 | truncated mail | hits 500, emails 500 (captured 28-day window) | ok, 500 read |
| K21 | schema | constructed: Pony Mail 200 without emails array | source failed (schema) |
| K21 | schema | constructed: Pony Mail 200 with emails [] | ok, 0 read |
| K22 | schema | Jira 200 text/html (login page, as /rest/api/3/search returns) | source failed (schema) |
| K22 | size | Jira page 671 KB (captured 100 issues, 2026-10-06) | ok |
| K22 | size | constructed: response body 4 MB + 1 byte | source failed (too-large); cursor unchanged |
<!-- test-plan:end -->

Named tests (no table), in
`apps/data-publisher-worker/test/kafka-sources-pipeline.test.ts` (to be
written): K6–K8 (publication from captured fixtures), K11, K16–K19, K23
(pipeline runs with fake sources), K32 (`/health` body); K28 (request count)
runs in `packages/reference-pipeline/test/kafka-connectors.test.ts`.

## Acceptance

### Behavior
- K1: a captured dev@ message becomes one mail event with the entity id,
  UTC time, display-name author, per-message URL, and subject keys in the test
  plan; no address is stored.
- K2: `[jira]` and `[PR]` notification mail and replies to it are not
  ingested; human mail, including release votes, is.
- K3: messages whose subjects differ only by reply/forward prefixes, case, or
  whitespace share one thread; `[DISCUSS]`, `[VOTE]`, and `[RESULT]` threads
  for the same KIP stay separate.
- K4: a captured KAFKA issue becomes one Jira event with title `<KEY>:
  <summary>`, open/resolved status, UTC time, and the KIPs in summary or
  description; each comment becomes one child event with its own URL.
- K5: a Jira issue is published only when a retained GitHub title or dev@
  subject cites its key, or a retained dev@ subject names the same KIP; a key
  that is a prefix of a longer number does not link.
- K6: publishing the captured fixtures yields a Feed entry
  "[VOTE] KIP-1279: Cluster Mirroring" (source `mail`, 6 records, status
  `discussing`) and entries `KAFKA-20186` (1 record) and `KAFKA-20184` (2
  records: the issue and the 2026-09-29 comment), both source `jira`, status
  `open`; the Kafka project lists sources `github`, `mail`, `jira`; every
  record has its canonical URL.
- K7: Detail for KAFKA-20184 links to PR #21518 and back; Detail for the
  KIP-1279 vote thread links to KAFKA-20186 and back; each link names its rule.
- K8: Search for `KAFKA-20184` returns the Jira entry and PR #21518; Search for
  `KIP-1279` returns the vote thread, and opening that hit shows Detail
  `KAFKA-MAIL-…` for the thread.
- K9: the first run ingests mail and Jira updates from the last 30 days and
  nothing older.
- K10: later runs request the windows in the test plan, overlapping the cursor
  and capped at 30 days.

### Failure and retry
- K11: with Pony Mail down (transport error or 5xx twice), the run publishes
  new GitHub and Jira events, keeps the mail cursor and retained mail records,
  and the next successful run reads the missed window.
- K12: a 429 or 5xx is retried once when `Retry-After` is at most 60 s; a
  second failure or a longer `Retry-After` fails only that source with
  `rate-limit` or `transport`, cursor unchanged.
- K13: a mail message without epoch, mid, or a string subject, or dated more
  than 1 hour ahead, is skipped and counted; the rest of the window is
  ingested.
- K14: a Jira issue without key or `updated` is skipped and counted; the
  cursor advances only to the newest valid `updated`.
- K15: the same message or issue version read twice (overlapping windows,
  rerun) produces one event with the same event id; the same identity with
  different content keeps the stored event and counts a conflict.
- K16: an edited Jira issue (new `updated`, status Patch Available → Resolved)
  replaces the previous version; Feed shows `resolved`.
- K17: an issue seen under a new key is a new entity; the old key is not
  updated and ages out; a retained comment whose issue aged out is not
  published without its issue.
- K18: with the cursor 3 days before now, the next run reads a 4-day mail
  window and a 4,330-minute Jira window; with the cursor 40 days before now,
  both are capped at 30 days and the source reports `gapCapped: true`.
- K19: a run that fails after polling and before committing state commits
  neither events nor cursors, and a rerun produces the same publication; a
  Jira read that fails on page 2 commits nothing from Jira for that run.
- K20: a Jira backlog above 200 issues is read across runs without loss (cursor
  = last issue read); a Pony Mail response with fewer emails than `hits` fails
  the mail source as `truncated` instead of dropping messages.
- K21: a Pony Mail response without an `emails` array fails as `schema`; an
  empty array is a successful empty read.
- K22: a Jira response that is not JSON (e.g. the HTML login page) fails as
  `schema`; a response above 4 MB fails as `too-large`.
- K23: with GitHub down, the run publishes new mail and Jira events and keeps
  the GitHub cursor and records; with all three down, the run fails and
  publishes nothing.

### Budget
- K24: [measure] at the current volume (8,600 GitHub events plus mail and
  Jira events generated at the measured 35-day shape: about 330 messages, 650
  issues, and their retained comments, with the published share of Jira
  issues), the `measure:memory` peak is at most 96 MB. Proxy today: +1,200
  events cost +8.3 MB (63.1 → 71.4 MB).
- K25: [measure] at twice that volume the peak is at most 128 MB. The proxy
  exceeds it (136.6 MB at 19,600 GitHub-shaped events, against 7.2 MB of
  margin at 2x GitHub alone). The seeded generator gains mail and Jira events
  so the command measures this mix. Spec 013 (streamed Search publication
  and finer Search shards) lands first; K24 and K25 are measured again after
  it, and Spec 012 is not deployed until K25 passes.
- K26: [measure] state growth: mail and Jira add at most 1,300 retained events
  at the current volume (stored events counted by `measure:memory`).
- K27: [measure] payload: a 30-day Pony Mail response is at most 1 MB
  (captured 699 KB for 520 messages) and a Jira page of 100 issues at most
  1 MB (captured 671 KB); both are parsed and released inside the poll phase.
- K28: a backfill or steady-state run makes at most 2 Pony Mail requests and 4
  Jira requests including retries; requests to one host are sequential and
  carry the `User-Agent`, and no credentials. The worker's subrequest limit
  is 20,000.
- K29: [deploy] on development, the added poll time per run, from the
  per-source durations in `/health` (K30), is at most 60 s against the
  15-minute alarm limit.

### Observability
- K30: [deploy] `/health` reports per source (`github`, `mail`, `jira`): last
  success time, cursor, poll duration, read/skipped/conflict/published counts,
  `gapCapped`, and the last failure kind; a failed source is visible while the
  run reports `ok`.
- K31: [deploy] on development after the backfill, Feed shows dev@ threads and
  linked Jira entries for Kafka, and Detail for a live Jira issue cited by a PR
  title links to that PR.
- K32: after a run in which the mail source fails and GitHub and Jira
  succeed, `/health` lists each source with `ok` and `lastSuccessAt`: GitHub
  and Jira `ok: true` at this run, mail `ok: false` with its failure kind and
  the previous run's `lastSuccessAt`; `lastRun.ok` is true.

## Non-goals

- AI topic summaries, KIP status (accepted, adopted), vote tallies.
- users@, commits@, jira@, and other projects' lists or trackers.
- Full mail bodies and attachments (full bodies of non-notification mail are
  deferred to the AI-summary spec); Confluence (KIP wiki) pages.
- Merging a KIP's threads, issues, and PRs into one Feed entry.
- Alerting on a failed source (Spec 011 may read the per-source fields).
- Identity merge of people across mail, Jira, and GitHub.

## Review log

Independent review (Fable, 2026-10-06, spec and workflow only), 23 findings:

| # | Finding | Handling |
| --- | --- | --- |
| 1 | `hits: 500` may be a server cap | Rebutted with data: 90 d returned 1,354, month 520; K20 kept, sizes in K27 |
| 2 | Source independence and Related links are contract changes; no ADR; GitHub-down case missing | Applied: "Contract changes and decision", ADR-0014 before implementation, K23 |
| 3 | Jira `+0000` timestamps fail validation; GitHub-only event parser | Applied: Behavior 2/4 normalize to UTC `Z`, contracts named, K4 row |
| 4 | Retention drops old comments; K6 said 4 | Applied: K6 = 2 records; Behavior 11 |
| 5 | Canonical URL contradicted example and drifted | Applied: newest message's URL |
| 6 | Misdated mail corrupts cursor | Applied: cursor clamp, skip > now + 1 h, rows |
| 7 | Search hit for mail could not open Detail | Applied: display id in Search records, K8 |
| 8 | "Names a KIP" wider than the human's "KIP thread" | Applied: KIP must also be named by a retained dev@ thread; measured 15/100 under the wide rule; open question |
| 9 | Jira page size unmeasured | Applied: measured 671 KB, fields pinned, K27, `too-large` |
| 10 | No retry contradicts ingestion-spec §6 | Applied: one retry, `Retry-After` ≤ 60 s |
| 11 | K25 imports a pre-existing failure | Partly applied: the cut is a separate slice, but Spec 012 is not deployed until 2x fits |
| 12 | `gapCapped` boundary ambiguous | Applied: gap > 30 d, rows on both sides |
| 13 | Replies to notification mail passed the filter | Applied: filter on normalized subject, rows |
| 14 | Key extraction undefined | Applied: regex, rows |
| 15 | K18 wording | Applied |
| 16 | Per-record URLs missing | Applied: Behavior 2/4 |
| 17 | Status vocabulary (`closed` = "without merge") | Applied: `discussing`, `resolved` |
| 18 | Source instance naming; profiles keyed by project | Applied: `kafka:mail:dev`, `kafka:jira`; Behavior 1 |
| 19 | Missing failure rows (conflict, page 2, orphan comment, missing mid/key) | Applied: K15, K17, K19, rows |
| 20 | `/health` lacks per-source fields; K29 not a measurement | Applied: K29 `[deploy]` from K30 |
| 21 | User-Agent unspecified | Applied |
| 22 | Agreed deletions, with caveats | Caveats recorded in the simplification review |
| 23 | Traceability gate fails before tests exist | Expected before implementation; test files named |
