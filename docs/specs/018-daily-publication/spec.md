# Spec 018: Daily publication

Status: Implemented (#62, #65, #68; owner's decision 2026-10-13, details by the implementer); Dev publishes daily at 22:07 UTC; the Prod cron (22:37 UTC) is configured but never deployed
Date: 2026-10-13
Traceability: enforced
Builds on: Spec 006, Spec 009, Spec 010, Spec 012, Spec 016, ADR-0012

## Intent

The data publisher runs once a day instead of once an hour, because the
upstream sources do not change often enough to justify 24 publications a day.
Nothing that used to rely on "the next run is at most an hour away" may get
worse by more than the cadence itself: a healthy day is not shown as stalled,
a backlog or a failed run does not wait a day, and an operator can still
publish on demand.

## Decision (owner, 2026-10-13)

> Run the job once a day for now — the upstream update frequency is not that
> high.

- Dev: `7 22 * * *` (22:07 UTC = 06:07 Asia/Taipei, so the day's data is ready
  in the owner's morning). Prod: `37 22 * * *`, so that a future Prod launch
  does not go hourly by accident.
- Rationale: an hourly publication cost about 8,150 R2 Class A operations per
  run (≈ $22 a month); PR #60 removed most of that (about 40 Class A and
  8,200 Class B a run), and the schedule is reduced as well: a month of daily
  runs is about 1.2 thousand Class A and 0.25 million Class B.
- What it trades: the site's data is up to about 24 h old (it was up to about
  1 h old).
- How to go back: set `crons` to `7 * * * *` / `37 * * * *` and
  `PUBLICATION_CADENCE_MS` to one hour in the same change; test T2 fails when
  only one of the two is changed. The follow-up rules below are harmless at
  any cadence.

This amends ADR-0012 (minute 7 and minute 37 of every hour) and replaces the
"hourly" premise of Spec 009, Spec 010, Spec 011, Spec 012 and Spec 016 where
each says so.

## Evidence

Dev `/health` at 2026-10-13T08:52Z, last hourly run (08:07 UTC):
`inputEventCount: 34`, `pageCount: 13`, `pollTruncated: false`,
`sources.github.read: 19`, `sources.mail.read: 37` (2-day window, 23
filtered), `sources.jira.read: 1`, every `gapCapped: false`;
`searchEmbedding.lastRun`: `embeddedThisRun: 7`, `modelCalls: 1`,
`pending: 0`.

A day against the per-run caps (`bun run measure:daily-volume`, 2026-10-13
09:02 UTC, a Monday-to-Tuesday window):

| Source | Updated in 24 h | Updated in 7 days | Cap per run | A day | A missed week |
| --- | --- | --- | --- | --- | --- |
| `kafka:github` | 66 | 221 | 200 issues | fits | 2 runs |
| `datafusion:github` | 96 | 438 | 200 issues | fits | 3 runs |
| `kafka:jira` | 48 | 182 | 200 issues (2 pages) | fits | fits |
| `kafka:mail:dev` | 37 messages in 2 days | — | one request; window 2–3 days | fits | one request, 8-day window |

A day uses a third to a half of each cap, so the caps stay as they are: 200
issues per source is what Spec 009 and the 2026-09 memory incidents proved
safe, and raising it buys nothing on a normal day. What changes is what
happens when a run is cut short or fails. Under the hourly Cron the next tick
was the retry; under a daily Cron it would be a day away.

Prod: `v0.1.0` (2026-08-26) and `v0.2.0` (2026-08-31) deployed Prod **Pages**
(`Deploy production: success` in both CI runs;
https://oss-knowledge-base.pages.dev serves the bootstrap snapshot generated
2026-08-25). The Prod data Worker has never been deployed: its configuration
was added on 2026-09-02 (`48ff871`), after the last tag. Its Cron therefore
takes effect only at the next `v*` tag.

## Example

Dev, 2026-10-13, after this change is deployed (times UTC):

| Time | What happens | `/health` | Topbar at 375 px and above 420 px |
| --- | --- | --- | --- |
| 22:07 | Cron tick → publication `2026-10-13T22-07-00-000Z` (158 GitHub issues, 47 Jira issues: one run) | `lastRun.pollTruncated: false`, `followUp: null` | hidden / "Updated just now" |
| 22:13 | The embedding job, started by the publication, embeds the day's chunks | `searchEmbedding.lastRun.pending: 0` | |
| next day 21:00 | Nothing ran in between | unchanged | hidden / "Updated 22 h ago", live styling |
| next day 22:17 | The next publication is late or still running | | hidden / "Updated 24 h ago", live styling |
| two days later 01:07:01 | No publication for 27 h 1 s | | "Data may be out of date · 27 h ago", stale styling, on both |

A week-long gap (438 DataFusion issues): the 22:07 run reads 200 and reports
`pollTruncated: true`; `/health` shows
`followUp: {reason: "catch-up", at: "…T22:12:00.000Z", catchUps: 1, retries: 0}`;
the runs at 22:12 and 22:17 read the rest, and `followUp` is `null` again.

## Simplification review

1. **Question every requirement.**
   - The daily Cron: the owner (cost, upstream frequency).
   - The stale threshold: the reader and the maintainer, who must not see a
     healthy pipeline flagged for 21 hours a day (Spec 011's intent).
   - Catch-up and retry runs: the maintainer; without them one truncated or
     failed run leaves the site a further day behind, silently.
   - `/health` `followUp`: the maintainer and the verifier, to tell "a run is
     waiting" from "nothing will happen until tomorrow".
   - The embedding continuation: Spec 016's backfill and failure arithmetic,
     which counted on hourly triggers (Spec 016 Behavior 46).
2. **Delete.**
   - Raising the per-run caps: a day fits with room, and the memory budget
     was measured at these caps.
   - A cadence field in `/api/feed` or `/health` for the page to read: the
     cadence changes only with a deploy that also ships the page, and Spec
     010 already rejected server-computed freshness. One constant
     (`PUBLICATION_CADENCE_MS`) and a test that holds it to the crons.
   - A separate retry schedule per source: the run-level rule covers a failed
     source, because a retry run polls every source again.
   - A "next expected run" time on the page: the age is enough.
   - Honouring `retryAfterSeconds` from the status: its values (60, 300) are
     below the first retry wait.
3. **Simplify.** One pure function decides the follow-up from the status and
   two counters; the Durable Object's alarm is the only mechanism (it already
   existed). A waiting follow-up is just an alarm in the future.
4. **Shorten the cycle.** The rule is a generated table (below); the daily
   batch runs through the real connectors against fake upstreams in under
   five seconds.
5. **Automate last.** `bun run measure:daily-volume` repeats the Evidence
   table; nothing else is added.

## Behavior

1. Each environment's publisher has one Cron: Dev `7 22 * * *`, Prod
   `37 22 * * *` (UTC). Any tick that is not exactly `DIGEST_CRON` or
   `REVIEW_QUEUE_CRON` publishes, as before.
2. The page's stale rule is derived from the cadence:
   `STALE_AFTER_MS = PUBLICATION_CADENCE_MS (24 h) + STALE_GRACE_MS (3 h)`.
   The grace covers a late run and its three retries (10 + 30 + 60 min, each
   run up to 15 min). Spec 010 owns the texts.
3. A publication that completes with nothing cut short schedules nothing.
4. **Catch-up.** A successful publication whose poll was truncated
   (`lastRun.pollTruncated`: a source returned its per-run cap and has more)
   schedules another run 5 minutes later, at most 5 times per trigger. With
   200 issues per source per run that is up to 1,200 issues per source, about
   12 days of DataFusion or 25 days of Jira at the measured rate. `gapCapped`
   does not start one: a cursor older than the 30-day window has nothing more
   to read than the window, and a truncated read of it is already covered.
5. **Retry.** A failed publication, or one that published while a source
   failed, is retried after 10 min, then 30 min, then 60 min, then left for
   the next tick. Catch-up is decided first; the two counts are independent.
6. One trigger therefore causes at most 9 publications (1 + 5 + 3).
7. A trigger (Cron tick or `POST /run`) replaces a follow-up that is waiting
   and starts new counts: it answers 202 and runs now. It answers 409 only
   while a run is active or its alarm is due (Spec 009 Behavior 8 otherwise
   unchanged).
8. `/health` carries `followUp`: `null`, or
   `{reason: "catch-up" | "retry", at, catchUps, retries}` for the run that
   is waiting; `scheduled` is `true` while it waits.
9. Publishing on demand is `POST /run` with the bearer token (runbook). With
   a daily Cron it is the only way to see a change before the next morning.
10. The embedding job continues on its own alarm while work is left (Spec
    016 Behavior 46). The digest and the review queue stay unscheduled.

## Test plan

Generated from `apps/data-publisher-worker/test/publication-schedule.cases.ts`
by `bun run docs:test-plan`; the unit tests run exactly these rows.

<!-- test-plan:start apps/data-publisher-worker/test/publication-schedule.cases.ts -->
| id | run | before | expected |
| --- | --- | --- | --- |
| T4 | ok, complete | 0 catch-ups, 0 retries | none |
| T5 | ok, truncated | 0 catch-ups, 0 retries | catch-up in 5 min |
| T5 | ok, truncated | 4 catch-ups, 0 retries | catch-up in 5 min |
| T6 | ok, truncated | 5 catch-ups, 0 retries | none |
| T7 | failed | 0 catch-ups, 0 retries | retry in 10 min |
| T7 | failed | 0 catch-ups, 1 retries | retry in 30 min |
| T7 | failed | 0 catch-ups, 2 retries | retry in 60 min |
| T8 | failed | 0 catch-ups, 3 retries | none |
| T7 | ok, jira failed | 0 catch-ups, 0 retries | retry in 10 min |
| T8 | ok, jira failed | 0 catch-ups, 3 retries | none |
| T5 | ok, truncated, jira failed | 0 catch-ups, 3 retries | catch-up in 5 min |
| T7 | ok, truncated, jira failed | 5 catch-ups, 0 retries | retry in 10 min |
| T7 | failed | 5 catch-ups, 0 retries | retry in 10 min |
| T7 | failed, truncated | 0 catch-ups, 0 retries | retry in 10 min |
<!-- test-plan:end -->

Named tests: `apps/data-publisher-worker/test/publication-schedule.test.ts`
(T1–T3, T5, T8, T9) and `apps/data-publisher-worker/test/daily-batch.test.ts`
(T10–T12: the real GitHub, Pony Mail and Jira connectors and the real
publication against in-memory upstreams, state and bucket).

| ID | Scenario | Expected |
| --- | --- | --- |
| T10 | A day at the measured volume: 63 + 95 GitHub issues, 47 Jira issues | one run, `pollTruncated: false`, 4 upstream requests, no follow-up |
| T11 | Five missed days: 315 + 475 GitHub issues, 235 Jira issues | 3 runs 5 minutes apart; truncated, truncated, complete; every issue stored; nothing left scheduled |
| T12 | 1,500 issues in one repository | 6 runs, the last still truncated and nothing scheduled; the next tick reads the rest |

## Acceptance

### Behavior
- T1: the Dev configuration has exactly one publisher cron, `7 22 * * *`,
  and the Prod configuration exactly `37 22 * * *`. (Dev's `47 22 * * *`
  is the digest's, Spec 014 D86.)
- T2: the cadence of each configured cron equals `PUBLICATION_CADENCE_MS`;
  the same check tells an hourly cron from a daily one.
- T3: both crons dispatch to the publisher, also when `DIGEST_CRON` and
  `REVIEW_QUEUE_CRON` are set to other expressions.
- T4: after a complete, successful run no follow-up is planned.
- T5: after a truncated run a catch-up is planned 5 minutes later, the alarm
  is set, and `followUp` records it; a complete run clears it.
- T10: a day at the measured volume is read whole by one run with no
  follow-up.

### Failure and retry
- T6: after 5 catch-up runs a truncated run plans nothing more.
- T7: a failed run, and a run with a failed source, is retried after 10, 30
  and 60 minutes; a truncated run with a failed source catches up first; a
  failed run is retried, not caught up, even if its status says truncated.
- T8: after the third retry nothing is planned and the record is cleared.
- T9: a future alarm reads as `scheduled` and does not block a trigger;
  `POST /run` while a follow-up waits answers 202, runs now and clears the
  record; a second `POST /run` answers 409.
- T11: a five-day backlog is caught up by two follow-up runs five minutes
  apart, with no read above the caps and no issue lost.
- T12: a backlog beyond the catch-up limit stops at 6 runs and the next tick
  continues from the cursors, losing nothing.

### Budget
- T13: [measure] a day's updates per source against the 200-per-run caps:
  66, 96 and 48 on 2026-10-13 (`bun run measure:daily-volume`;
  `-- --hours 168` for a missed week). The run's limits are unchanged from
  Spec 009: 128 MB, a 15-minute alarm, 20,000 subrequests, 300,000 ms CPU; a
  capped run reads at most 200 issues per source as before, so its peak is
  the one Spec 009 M1–M2 and Spec 013 L14 measure.
  Publications: 1 on a normal day and at most 9 per trigger (Behavior 6,
  tests T6 and T8), against 24 a day before.

### Observability
- T14: [deploy] on Dev after the deploy, the first Cron run is at 22:07 UTC:
  `/health` `lastRun.completedAt` is `<date>T22:07:00.000Z`, `ok: true`,
  `followUp: null`, and `searchEmbedding.lastRun.pending` is 0 within the
  hour.
- T15: [deploy] `POST /run` with the bearer token on Dev answers 202 and
  `/health` then names a new release, which `/api/feed` serves.
- T16: [deploy] on Dev at 375 px and at 1280 px, with the real clock and a
  publication less than 27 h old, the topbar pill is not stale; with the
  clock 27 h 1 s after `lastRun.completedAt` it is
  (`bun run verify:ui -- --target dev --at +27h1s`).

## Known limits (independent verification of PR #62, 2026-10-13)

1. **A missed daily run is not visible before the 27 h mark.** Between hour
   24 and hour 27 after a missed run a visitor sees "Updated 24 h ago" to
   "Updated 26 h ago" with live styling and no warning. `/health`
   `followUp` and a failed run (`lastRun.ok: false`) are not shown in the UI
   at all. The owner's standing rule is that a stall must be visible in the
   UI; this spec does **not** meet it for that window, it only keeps a
   healthy day from being flagged. Open follow-up: show a failed or overdue
   publication in the UI before the 27 h mark (gardening G66). Spec 021
   (2026-10-14) shows an overdue warning from 24 h 30 min.
2. **CI does not detect a stalled daily run.** The deployed E2E runs only
   after a Dev deploy, so on a day without a deploy nothing checks that the
   22:07 UTC run happened; the page's stale pill at 27 h is the only signal.
3. **Exactly 200 updates in one repository cause one empty catch-up.** The
   GitHub read stops at the cap and reports `pollTruncated` when the last
   page is full, even if nothing more exists, so one extra publication runs
   5 minutes later and reads nothing new. Rare (a day is 66 and 96 updates)
   and cheap (about 40 Class A).

## Everything that is scheduled (2026-10-13)

"Per run" costs are from Dev `/health` on 2026-10-13 unless a spec is named.

| What | Where | Cadence | Reads / writes | Cost per run | Needed | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| Publisher Cron, Dev | `apps/data-publisher-worker/wrangler.development.jsonc` → `scheduled` → `PipelineState` alarm | `7 22 * * *` (was `7 * * * *`) | GitHub, Pony Mail, Jira → Durable Object state → R2 Feed and Search releases, pointers, evidence | 13 upstream pages in an hourly run; R2 about 40 Class A (new objects + 3) and about 8,200 Class B a run since PR #60 (8,150 Class A before it); `lastRun.r2` reports both; no model | Yes | Keep (this spec) |
| Publisher Cron, Prod | `wrangler.production.jsonc` | `37 22 * * *` (was `37 * * * *`); the Worker has never been deployed | as Dev, Prod bucket | none today | Not until Prod data goes live | Keep the entry; it starts with the next `v*` tag |
| Publisher follow-ups | `PipelineState` alarm (`planFollowUp`) | 5 min after a truncated run (≤ 5); 10, 30, 60 min after a failure (≤ 3) | as a publication | one publication each | Yes, with a daily Cron | Keep |
| Runtime alarm retry | Workers runtime | when an alarm handler dies (for example out of memory); exponential backoff, up to 6 retries (Cloudflare's documented behavior); an alarm 30 min overdue is treated as gone (`STALE_ALARM_MS`) | as a publication, under a new release id (Spec 009 M10) | one publication | Yes | Keep |
| Embedding job | `SearchEmbeddingRun` alarm, started by each successful publication (`onPublished`) or `POST /search-embedding/run` | once per publication; then hourly while work is left; 00:05 UTC after a day cap (Spec 016 Behavior 46) | R2 Search pointer, manifest, shards (12 Class B) → Workers AI `bge-m3` through `osskb-search-dev` → Vectorize | 1 model call, 1 neuron for 7 chunks; caps 80 calls and 3,000 chunks a run, 400 calls and 2,500 neurons a day | Yes (Dev hybrid search) | Keep |
| Digest job | `DigestRun` alarm; only `POST /digest/run` starts it; `DIGEST_CRON` unset | none (specified: daily, Spec 014) | pinned Feed release → Workers AI and Clef through `osskb-digest-dev` → `public/digest/v1/…` | last run 2026-10-08: 26 model calls, 1,141 estimated neurons; cap 4,500 neurons a day on Dev | Not scheduled | Owner decides when to enable; if enabled, place it after 22:07 UTC |
| Review-queue job | inline on a Cron tick equal to `REVIEW_QUEUE_CRON` (unset), or `POST /review-queue/run` | none (specified: hourly, Spec 015) | GitHub GraphQL, Pony Mail, ASF roster, pinned Feed release → `public/review-queue/v1/…` | 1–3 min; see Spec 015 | Not scheduled | Open decision 1 |
| Query gate | `SearchQueryGate`, no alarm; one call per uncached text search | on demand | Workers AI and Vectorize; its own storage | at most 1 model call and 2 index queries a query; caps 1,000 neurons and 1,000 index queries a UTC day, 100 model calls a clock hour; matches cached 1 h, query embeddings 7 days; paused 15 min after a platform refusal | Yes | Keep; independent of the publisher's cadence |
| Web API cache | `cache-control` of `/api/*` | `max-age=30, stale-while-revalidate=120` | — | — | Yes | Keep; independent of the cadence (a new release shows within 150 s) |
| R2 pointer cache | `current.json` objects | `max-age=30, must-revalidate`; immutable objects one year | — | — | Yes | Keep |
| Page clock | `apps/web/src/App.vue`, `WeekView.vue` | every 60 s in an open page | nothing (recomputes the age) | — | Yes | Keep |
| Confluence ingest (M1) | `.github/workflows/ingest.yml` | manual only since 2026-10-14 (was daily 03:17 UTC and manual) | cwiki.apache.org for 9 followed KIPs → `vault/KIPs/*.md` frontmatter and `tools/ingest-*.json`; force-pushes the branch `automation/confluence-ingest` and edits issue #12; never commits to `main` | one GitHub Actions run per dispatch (viewer tests, then the poll) | Nothing in `apps/` or `packages/` reads its output; only the legacy `viewer/` does | Manual only (decision 2, decided 2026-10-14) |
| Corpus backfill | `.github/workflows/backfill.yml` | manual only | Confluence and mail → the legacy viewer's corpus, branch `automation/corpus-backfill` | — | Legacy viewer only | Decide with the ingest |
| CI and deploys | `.github/workflows/ci.yml` | on pull request, push to `main` (Dev deploy and deployed E2E), `v*` tag (Prod deploy) | no schedule; never calls `POST /run` | — | Yes | Keep |
| Local feed poller | `apps/github-publisher/feed-poller.ts` | every 5 min in a local dev server | GitHub | — | Local only, not deployed | Keep |

## Open decisions for the owner

1. **Review-queue cadence.** Spec 015 Decision 6 is "hourly" (proposed crons
   `27 * * * *` / `57 * * * *`, 20 minutes after each publication), its page
   is stale after `STALE_AFTER_MS` (then 3 h, now 27 h), and `verify:health`
   flags a run older than 2 h. With a daily publication the mail section,
   which pins the current Feed release, is as old as the publication, while
   the GitHub review section would still be hourly. Options: keep hourly for
   the review queue, or once a day after the publication. Not decided here;
   the job stays unscheduled and its 2 h check is unchanged.
2. **Confluence ingest.** It ran daily and nothing on the deployed site uses
   its output. Options: keep (if the legacy viewer and vault are still
   wanted), reduce to manual, or remove with the legacy viewer.
   **Decided (owner, 2026-10-14): manual only.** The `schedule` trigger of
   `.github/workflows/ingest.yml` is removed; `workflow_dispatch` stays.
   Putting KIP bodies into search is not part of this decision and will be
   a separate spec.
3. **Digest schedule.** Decided 2026-10-14: Dev `47 22 * * *` (Spec 014,
   "Schedule on Dev"). Before: if the digest is enabled, a time after 22:07 UTC
   (for example 22:37 on Dev) makes it read the day's release; `37 1 * * *`
   in Spec 014's examples would read a release about 3.5 h old.

## Non-goals

- Enabling the digest or the review queue, or changing their specs' cadences.
- Changing the per-run caps, the 30-day window, or the R2 layout.
- A Prod data launch.
- Alerting outside the page (Spec 011).
