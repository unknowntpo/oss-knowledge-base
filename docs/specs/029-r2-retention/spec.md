# Spec 029: R2 release retention (mark and sweep)

Status: Draft (owner direction 2026-10-21: mark-and-sweep retention, dry run first, Dev before Prod; O1–O4 decided 2026-10-21; retention is its own job, not part of the publication; spec only, nothing implemented)
Date: 2026-10-21
Traceability: enforced
Builds on: ADR-0010 (rollback selects earlier pointers), ADR-0013 (content-addressed detail pools; "retention is deferred to its own spec"), Spec 006 (publication-set evidence), Spec 008 (R2 operations, pools), Spec 009 (bounded memory), Spec 013, Spec 014 (digest pins a release), Spec 016 (embedding job reads a release), Spec 018 (daily publication, follow-ups), Spec 026 (cost guard), Spec 028 (observability signals, PR #108, not merged)

## Intent

The owner can see that each R2 bucket stays at a bounded size, instead of
growing by one release (about 34 MB) per publication forever. A separate
retention job deletes what no reader can reach any more, and never what a
reader, a rollback or a running job can still reach. The publication does
not change: it never runs retention, and a retention failure or overrun
never fails or blocks it (owner principle 2026-10-21: one job must not
carry too many tasks).

Observable outcome: Dev shrinks from 13.37 GB to about 1.2 GB by mid
November (the last hourly releases leave the 30-day window on 2026-11-13),
and Prod levels off near 1.2 GB once it is 30 days old; `/health`
`retention` shows each run's status, retained releases, candidates, deleted
objects and bytes, separately from the publication's status.

## Evidence

Measured 2026-10-20 and 2026-10-21 (GraphQL `r2StorageAdaptiveGroups`,
publisher `/health`, one evidence object read with `wrangler r2 object get`):

| Bucket | Stored | Objects | Since |
| --- | --- | --- | --- |
| `oss-knowledge-base-dev` | 13.37 GB | 302,468 | hourly 2026-09-02 → 2026-10-13 (about 1,000 releases), daily since (Spec 018) |
| `oss-knowledge-base-prod` | 0.52 GB | 9,749 | first release 2026-10-19; grows about 34 MB a day (about 1 GB a month) |

- No code deletes an R2 object. The publisher only puts
  (`apps/data-publisher-worker/src/r2-destination.ts:31-83`); keys are
  release-scoped (`packages/serving-contract/src/r2.ts:70-72`,
  `packages/serving-contract/src/publication-set.ts:821-825`,
  `packages/serving-contract/src/search-r2.ts:504-514`) or content-addressed
  in two pools (`public/v2/objects/details/`,
  `public/search/v1/objects/details/`).
- Retention was deferred four times: ADR-0013 (lines 45-46), Spec 008
  (spec.md:147-148), Spec 013 (spec.md:400), Spec 022 (spec.md:372);
  gardening G9. ADR-0010 line 81: rollback "does not rebuild or delete
  immutable objects".
- Account-wide storage is 13.89 GB against Workers Paid's 10 GB-month
  included; the overage costs about $0.06 a month. Spec 026 as merged trips
  at 80 % of the storage allowance (8 GB, CG2), and under `enforce` that
  stops the digest, the embedding job and semantic queries (Spec 026
  Behavior 9). A separate PR amends the guard to a dollar budget ($5 a month
  of overage in total; storage alone no longer trips). This spec depends on
  neither rule: under the merged rule retention is the precondition for Dev
  `enforce`; under the amendment it keeps storage within the included
  10 GB, so retention spends none of the $5.
- About 12.5 GB of Dev is superseded releases (prior investigation,
  2026-10-21: about 1,000 releases × release-scoped bytes, about 12.5 MB a
  release on average; early hourly releases are smaller than today's
  34.5 MB). Most Dev objects are pool objects: about 16,000 of the 302,468
  are release-scoped (16 a release including evidence).
- Cron slots already used: Dev publication 22:07 UTC, Dev digest 22:47 UTC
  (`wrangler.development.jsonc`), Prod publication 22:37 UTC
  (`wrangler.production.jsonc`). The publication `PipelineState` runs its
  work in its alarm; the runtime never runs two alarms of one object at once
  (`apps/data-publisher-worker/src/index.ts:475-478`).

## Example

Dev, captured 2026-10-21 from `/health` (`lastRun`) and the evidence object
`publication-sets/v1/github-2026-10-20T22-07-19-086Z.json` (1,827,275 bytes):

| Projection | Release id | Release-scoped objects | Bytes | Pool keys referenced | Pool bytes |
| --- | --- | --- | --- | --- | --- |
| Feed | `2026-10-20T22-07-19-086Z` | 2 (`feed/index.json`, `feed/details.json`) | 13,084,327 | 4,330 | 18,456,267 |
| Search | `feed-2026-10-20T22-07-19-086Z` | 13 (manifest, terms, shards) | 21,468,104 | 4,330 | 18,456,267 |

`lastRun`: `publicationSetId` `github-2026-10-20T22-07-19-086Z`,
`r2 {classA: 824, classB: 8678}`. The embedding job's
`lastRun.releaseId` is `feed-2026-10-20T22-07-19-086Z`; the digest's
`sourceReleaseId` is `2026-10-20T22-07-19-086Z`. Both equal the current
pointers.

A retention run in `dry-run` at its own slot (2026-10-22 10:17 UTC, twelve
hours after that day's publication; window W = 30 days, floor N = 2, grace
48 h):

1. **Retained releases**: the current Feed and Search pointers
   (`public/v2/current.json`, `public/search/v1/current.json`), the digest
   pointer's and the embedding job's release, every release with evidence
   whose id time is after 2026-09-22T10:17Z, and at least the 2 newest
   releases with evidence. Today these are the daily releases 2026-10-13 →
   10-21, their follow-up and manual runs, and the hourly releases
   2026-09-22 → 10-13 (about 500); all pinned releases are among them.
2. **Marked pool keys**: the union of pool keys in the retained evidence:
   at least the 4,330 per pool above, plus every detail that changed within
   the window (about 150,000 keys while the hourly releases are in it).
3. **Candidates**: the hourly releases 2026-09-02 → 09-22 (about 480) under
   `public/v2/releases/` and `public/search/v1/releases/`, their evidence,
   and every unmarked pool object uploaded more than 48 h ago. Expected
   bytes: about 4 GB (the earliest, smallest releases); the dry run measures
   the real number (RT21).
4. **Dry run**: lists and reports; deletes nothing. `/health` shows
   `retention {mode: "dry-run", status: "ok", lastRun: {retained:
   {releases: ≈ 510, poolKeys: ≈ 150,000}, candidates: {releases, evidence,
   poolObjects, objects, bytes}, deleted: {objects: 0, bytes: 0}}}`; the
   publication's `status` is untouched.
5. **Enforce** (a later PR): deletes at most 20,000 objects a run, oldest
   first. The first stage (about 480 releases, their evidence and their
   unmarked pool objects) takes about 8 daily runs; afterwards about 24
   hourly releases leave the window each day until 2026-11-13. Dev then
   holds about 30 daily releases plus follow-ups:
   30 × 34.5 MB (releases) + 30 × 1.8 MB (evidence) + about 80 MB (pools)
   ≈ 1.2 GB. Prod reaches the same ≈ 1.2 GB around 2026-11-18 and stays
   there.

## Simplification review

1. **Question every requirement.**
   - Retain the current pointers: every reader (Pages, digest, embedding
     job) starts there.
   - Retain every verified release of the last 30 days, and at least the 2
     newest verified releases: the owner, for rollback (ADR-0010: rollback
     selects an earlier verified pointer; O1). "Verified" means its
     publication-set evidence exists, which the pipeline writes only after
     both pointers switched (`pipeline.ts:268-272`). The floor keeps the
     previous successful release when publication stalls longer than 30
     days, so the live and the previous release are never candidates.
   - Retain the digest's and the embedding job's release: both pin a
     release and read it across invocations (`digest/store.ts:80`,
     `search-embedding/run.ts:469`).
   - Retain anything younger than 48 h: a crashed attempt's objects are
     reused by its retry through `head` (Spec 008); defence in depth on top
     of serialization (Behavior 7).
   - Dry run: the owner; the first evidence is counts and bytes with no
     delete.
   - A delete cap and a time budget per run: the owner; bound a bug's blast
     radius and how long a manual publication can wait (Behavior 12).
   - Its own cron slot and `/health` status: the owner (one job, one task);
     the Spec 027 SRE agent sees that it ran and what it removed, apart from
     the publication.
2. **Delete.**
   - A new Worker or Durable Object, and a lease between it and the
     publication: retention runs in its own alarm invocation of the same
     `PipelineState`, so the runtime's one-alarm-at-a-time rule serializes
     it with the publication (the old `run-lease` is gone and stays gone).
   - Running retention after each publication: removed (owner principle);
     the publication's code path does not change.
   - Reading shards or detail maps to mark: the evidence already lists every
     immutable key with its byte length; one read per retained release.
   - Reference counts, per-object metadata, tombstones: writes (Class A)
     on every publication; reachability from evidence needs none.
   - A configurable window: W = 30 days and N = 2 are constants; a change is
     a spec change.
   - Verifying the current release after the sweep (one `head` per object,
     about 8,700 Class B a run): safety comes from construction (Behavior 5),
     asserted by tests.
   - A manual retention route: the cron slot is the only trigger; Dev
     evidence comes from `/health` after the slot.
   - Review-queue, digest, activity-log and roster objects: other prefixes,
     other owners (Non-goals).
3. **Simplify.** One pure function computes the retained set and the
   candidates from lists and evidence; the alarm's retention branch only
   lists, reads and deletes.
4. **Shorten the cycle.** The retained-set rules are a generated case table;
   an in-memory bucket stands in for R2; a fake alarm runtime stands in for
   the Durable Object; no test calls the network.
5. **Automate last.** One cron entry per environment; the Dev drain needs no
   script.

## Rejected alternatives

- **R2 lifecycle (TTL) rule alone.** Object age is not reachability: a pool
  object written 60 days ago is still referenced by today's release (reuse
  does not refresh its upload time), and a publishing stall longer than the
  TTL deletes the live release itself. Unsafe for pools and releases alike.
- **Dev wipe and reseed.** Deletes the live release (Dev serves nothing
  until a full backfill), loses the rollback window, costs about 300,000
  Class A puts again, and solves Dev once while Prod keeps growing.
- **Delete inside `publish`.** Couples retention failures to the
  publication and lengthens the critical path.
- **Run after a successful publication in the same alarm** (this spec's
  first draft). Serialized, but one job carries two tasks: a retention bug,
  overrun or eviction shares the publication's invocation, budget and
  retry. Rejected by the owner principle (2026-10-21).
- **A separate Worker or Durable Object reading the pointers.** It cannot
  see whether a publication is between `head`-checking a pool object and
  switching its pointer (the hazard ADR-0013 names), so it would need a
  lease shared with the publication. Same object, separate alarm, needs
  none.
- **A count of releases instead of a time window** (first-draft O1). A
  count shortens the rollback window after bursts of follow-up and manual
  runs; the owner chose time (O1) and accepts the extra storage.

## Behavior

1. `R2_RETENTION` (Worker var) unset, blank or `off`: nothing runs, nothing
   is listed, `/health` has no `retention` key. `dry-run` lists and reports
   without deleting. `enforce` also deletes. Any other value is
   `unconfigured`: nothing runs, `/health` shows the mode and the reason.
   Same shape as `COST_GUARD` (Spec 026 Behavior 1).
2. **Its own job.** Retention has its own cron slot (`RETENTION_CRON`,
   `17 10 * * *` on Dev and Prod: about 12 h from the 22:07, 22:37 and
   22:47 UTC ticks), its own Durable Object storage keys (`retention-*`),
   its own budget (Behavior 12) and its own `/health` status (Behavior 9).
   The publication tick never triggers it and the publication's code path
   never calls it. The slot's tick sends `POST /retention` to
   `PipelineState`, which records one of:
   - `skipped: "publication-pending"` when a publication is running or any
     alarm is scheduled (a requested run, a Spec 018 follow-up or a retry);
     the alarm is left as it was;
   - `skipped: "already-ran-today"` when retention already ran this UTC day
     (one storage key);
   - `skipped: "paused"` while the cost guard pauses the publication (Spec
     026 Behavior 9: retention's lists are Class A);
   - otherwise it writes `retention-pending` and sets the alarm.
   The alarm runs the retention branch only when `retention-pending` is set
   and no publication was requested (`requested-at` absent); otherwise it
   runs the publication exactly as today and drops `retention-pending`
   (recorded `skipped: "publication-pending"`; the next day's slot runs).
   The retention branch never reads or writes the publication's keys
   (`status`, `phase`, `requested-at`, the follow-up marker) and never
   throws: every error ends as `status: "failed"`, so the runtime does not
   retry it. It deletes `retention-pending` when it ends; an eviction
   before that makes the runtime retry the alarm, which resumes retention
   idempotently (RT13).
3. **Retained releases** (pointers re-read at the start of the run):
   - the Feed release of `public/v2/current.json` and the Search release of
     `public/search/v1/current.json`;
   - the release of each digest pointer `public/digest/v1/<projectId>/current.json`
     (`sourceReleaseId`, schema `osskb.digest-pointer.v1`) and the embedding
     job's `lastRun.releaseId`;
   - every release with evidence under `publication-sets/v1/` whose release
     id time is within W = 30 days of the run, each contributing its Feed
     and Search release ids from the evidence (O1);
   - the N = 2 newest releases with evidence, whatever their age (floor);
   - any release whose id time is within the grace period (48 h).
   A floor below 2 is rejected at startup, so the live and the previous
   successful release (the one a future skip-`head` list would trust,
   gardening G10) are always kept, even after a stall longer than W.
4. **Mark.** The marked pool keys are the union of the pool keys in the
   `immutableObjects` of the retained releases' evidence (schema
   `osskb.publication-set.v1`). Evidence is read one object at a time; only
   the content hash of each key is kept (Spec 009).
5. **Sweep candidates**, only under these prefixes:
   - every object under `public/v2/releases/<id>/` and
     `public/search/v1/releases/<id>/` whose `<id>` is not retained;
   - `publication-sets/v1/<setId>.json` whose releases are both not
     retained: deleted with the release (O3);
   - every object under `public/v2/objects/details/` and
     `public/search/v1/objects/details/` that is not marked and whose
     `uploaded` is older than the grace period.
   `current.json` keys, `public/digest/`, `public/review-queue/`,
   `internal/` and any other prefix are never listed for deletion. Before
   each delete batch, every key is checked against the retained releases
   and the marked set again; a hit aborts the run with `failureKind:
   "invariant"` and deletes nothing more.
6. **Order and cap.** Releases are swept oldest id first; within a release
   the Search `manifest.json` and the Feed `feed/index.json` are deleted
   first (an old Search detail URL then reads as expired, not half
   present), then its other objects, then its evidence. Pool candidates
   follow, oldest `uploaded` first. A run deletes at most 20,000 objects
   (R2 `delete` with up to 1,000 keys per call); the rest is reported as
   `remaining` and waits for the next run.
7. **Serialization.** Retention and publication are separate alarm
   invocations of one Durable Object, and the runtime never runs two at
   once, so no publication starts between the mark and the last delete. A
   `POST /run` while retention is pending or running is accepted (202) as
   today: `runStarting` ignores retention, the request sets `requested-at`
   and the alarm, and the publication starts when the retention alarm
   returns, at most the time budget later (Behavior 12). The grace period
   additionally keeps anything a crashed or concurrent writer created in
   the last 48 h.
8. A `/search/:detailRef` link whose release was swept answers 404
   `{error: "Search release expired"}` with `cache-control: no-store`
   instead of today's 503 (`apps/web/functions/api/search-detail/[ref].ts`),
   so an expired link is not reported as an outage (O4).
9. `/health` `retention` (only while `R2_RETENTION` is set), a sibling of
   the publication's fields: `{mode, status, reason, lastRun}`; `status` is
   `ok`, `failed`, `overrun` or `skipped` (with the skip reason in
   `reason`) and never changes the publication's `status`, `ok` or the
   `/health` HTTP status. `lastRun` is `{runId, at, mode, retained:
   {releases, poolKeys}, candidates: {releases, evidence, poolObjects,
   objects, bytes}, deleted: {objects, bytes}, remaining, elapsedMs, r2:
   {classA, classB}, failureKind, error}`. `runId` is
   `retention-<UTC date>` today and Spec 028's `runId` shape once it lands.
   Bytes come from the list results, not from extra reads.
10. **Spec 028 (light).** When `OBSERVABILITY_SIGNALS` lands, retention
    writes its own data point (job `retention`) with `deleted.objects`,
    `deleted.bytes`, `remaining` and `status` under its own `runId`; no new
    rule is added here.
11. **Spec 026.** Retention's lists and reads count toward the guard's
    month-to-date R2 operations like any other; its counters are its own,
    so the publication's tested invariant (Class A ≤ new objects + 3, Specs
    008, 018) is unchanged. Under the merged guard, Dev's `r2StorageBytes`
    falls below 8 GB during the drain; an open breaker still needs the
    manual reset (Spec 026 Behavior 8). Under the dollar-budget amendment,
    retention's own cost stays near $0 (Budget).
12. **Budget per run.** At most 20,000 deletes, and a wall-clock budget of
    10 minutes (the Durable Object alarm limit is 15): when it is spent, the
    run starts no further list, read or delete call, records `status:
    "overrun"` and `remaining`, and the next day's slot continues. If the
    budget runs out before the mark completes, no pool object is deleted in
    that run.

## Budget

Pricing ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)):
`ListObjects` is Class A ($4.50 per million, 1 million a month included);
`GetObject` is Class B ($0.36 per million, 10 million included);
`DeleteObject` is a free operation; storage $0.015 per GB-month over 10 GB.
Limits from `wrangler.*.jsonc`: 20,000 subrequests and 300,000 ms CPU per
invocation; a Durable Object alarm has 15 minutes of wall time.

| Case | Class A (lists) | Class B (gets) | Subrequests | Month |
| --- | --- | --- | --- | --- |
| Dev drain, worst run: every prefix listed (302,468 objects / 1,000 per page); about 510 evidence reads while hourly releases are in the window | ≈ 305 | ≈ 515 (4 pointers + evidence) | ≈ 840 (+ 20 delete calls) | 31 × 305 ≈ 9,500 Class A (0.95 % of the included million); ≈ 16,000 Class B (0.16 %) |
| Dev or Prod steady state (≈ 35 releases with follow-ups, evidence, two pools: ≤ about 40,000 objects) | ≈ 40 | ≤ 40 | ≈ 100 | ≈ 2,500 Class A for both buckets (0.25 %); $0 inside the allowance, about $0.01 if billed |

Storage: each bucket settles near 1.2 GB (Example step 5), the account near
2.5 GB with the other prefixes: inside the included 10 GB, so $0 a month;
about 1.3 GB more than the first draft's 14 releases, which the owner
accepted (O1). Until Dev drains, the current overage (≈ $0.06 a month)
shrinks with it. Retention adds no Class A write.

Memory: marked set ≤ about 160,000 content hashes while the hourly releases
are in the window (≈ 15 MB as strings), ≤ about 40,000 at steady state;
candidates held at most up to the cap (20,000 keys); evidence parsed one
object at a time (≤ 1.8 MB each).

## Test plan

Generated from `apps/data-publisher-worker/test/retention.cases.ts` by
`bun run docs:test-plan` once slice 1 adds the case file; until then the
rows below are the intended retained-set rules (releases written as their
date, ids at 22:07Z; W = 30 days, floor N = 2, grace 48 h, run at
2026-10-22T10:17Z, so the window starts at 2026-09-22T10:17Z).

| id | case | input | retained | candidate |
| --- | --- | --- | --- | --- |
| RT2 | 31 verified daily releases | 09-21 … 10-21, pointers at 10-21 | 09-22 … 10-21 | 09-21 |
| RT2 | pointer rolled back to an old release | 40 verified daily 09-12 … 10-21, Feed pointer at 09-15 | 09-22 … 10-21 + 09-15 | the other 9 |
| RT2 | Feed and Search pointers on different releases | Feed 10-21, Search 10-20 | both kept | — |
| RT2 | embedding job pinned to a release outside the window | `lastRun.releaseId` 09-01 | window + 09-01 | — |
| RT2 | digest pointer outside the window | digest `sourceReleaseId` 09-02 | window + 09-02 | — |
| RT2 | publishing stalled 45 days | verified daily 08-01 … 09-07, pointers at 09-07 | 09-06, 09-07 (floor) | 08-01 … 09-05 |
| RT2 | hourly releases inside the window | verified hourly 09-22T11Z … 10-13 | all | — |
| RT2 | release without evidence, 3 days old | crashed attempt 10-19 | — | 10-19 |
| RT2 | release without evidence, 47 h old | crashed attempt 10-20T11:17Z | kept (grace) | — |
| RT2 | floor = 1 | config | rejected: floor must be ≥ 2 | — |
| RT3 | pool object unmarked, uploaded 49 h ago | — | — | candidate |
| RT3 | pool object unmarked, uploaded 47 h ago | — | kept (grace) | — |
| RT3 | pool object marked only by the oldest release in the window | uploaded 09-02 | kept | — |

## Acceptance

Each item: precondition → action → observable result → evidence. Every
untagged item is `[pending]` until the slice that implements it removes its
tag. IDs are stable: RT1–RT23 keep their numbers (RT2, RT6, RT12, RT15,
RT17–RT20 reworded for the separate job and O1); RT24–RT28 are new.

### Behavior
- RT1: [pending] given `R2_RETENTION` unset, blank, `off`, `dry-run`, `enforce` or `on`, resolving it gives off, off, off, dry-run, enforce, unconfigured; while off or unconfigured a retention tick makes no list or delete call and `/health` has no `retention` key (off) or shows the reason (unconfigured) → worker test.
- RT2: [pending] given the test-plan rows, `retainedReleases` returns exactly the retained and candidate releases of each row (30-day window, floor of the 2 newest verified releases, pins, grace), and a floor below 2 is rejected → case rows.
- RT3: [pending] given the Example's evidence (4,330 pool keys per projection) plus unmarked pool objects at 47 h and 49 h, the marked set holds every evidence pool key and the candidates are exactly the unmarked objects older than 48 h → case rows.
- RT4: [pending] given an in-memory bucket with three releases (one retained), their evidence, two pools, `current.json` keys, a digest pointer and objects under `public/review-queue/` and `internal/`, an `enforce` run deletes exactly the non-retained release prefixes, their evidence and the unmarked old pool objects, and every key outside Behavior 5's prefixes is still present → sweep test.
- RT5: [pending] given the same bucket in `dry-run`, the run reports the same candidate counts and bytes as `enforce` would and makes zero delete calls → sweep test.
- RT6: [pending] given a successful or a failed publication alarm, the publication makes no retention R2 call and writes no `retention-*` key; given a retention tick, retention runs in its own alarm invocation; a second tick on the same UTC day, or a tick while the cost guard pauses the publication, makes no R2 call and records `skipped` → alarm test with a positive control.
- RT7: [pending] given 25,000 candidates, an `enforce` run deletes 20,000 in batches of ≤ 1,000 keys, oldest release first and Search `manifest.json`/Feed `feed/index.json` before the rest of a release, and reports `remaining: 5,000`; the next run deletes the rest → sweep test.
- RT8: [pending] given a Search detail ref whose release manifest is absent, `GET /api/search-detail/:ref` answers 404 `{error: "Search release expired"}` with `cache-control: no-store`; a present release still answers 200 → Pages function test.
- RT24: [pending] given the Dev crons (`7 22 * * *`, `47 22 * * *`, `RETENTION_CRON` `17 10 * * *`), `scheduled` routes the retention cron to `POST /retention` only, and the publication and digest crons never reach it → worker scheduled test.
- RT25: [pending] given a publication running, a requested run, or a follow-up alarm scheduled for later, `POST /retention` records `skipped: "publication-pending"`, leaves the alarm time unchanged and makes no R2 call; given both `retention-pending` and `requested-at` when the alarm fires, the publication runs and retention is recorded skipped → alarm test with a positive control.

### Failure and retry
- RT9: [pending] given a retained release whose evidence is missing or not `osskb.publication-set.v1`, the run sweeps no pool object (fail closed), still sweeps non-retained release prefixes, and records `reason: "evidence-missing"` → sweep test.
- RT10: [pending] given an unreadable or invalid `current.json` (Feed or Search), the run deletes nothing and records `failureKind: "pointer-read"` → sweep test.
- RT11: [pending] given a delete batch that contains a retained-release key or a marked pool key (injected by a faulty candidate function), the run aborts before that batch with `failureKind: "invariant"` and deletes nothing more → sweep test with a positive control.
- RT12: [pending] given a delete call that throws after two batches, the run records `status: "failed"`, the error and the deleted count so far, the alarm handler does not rethrow, the publication's `status` and `lastRun` keys are byte-for-byte unchanged, and the next run finishes the rest without error → sweep and alarm test.
- RT13: [pending] given a run that stops (isolate eviction simulated) between two deletes of one release, every retained release and marked pool object is intact, the runtime's retry of the alarm resumes retention (not a publication), and it removes the release's remaining objects → sweep and alarm test.
- RT14: [pending] given a second run on unchanged data, it deletes nothing and reports `candidates.objects: 0` → sweep test.
- RT15: [pending] given a `POST /run` received while retention runs, the request answers 202, no publication starts before the retention alarm returns, the publication then runs, and the marked set was computed from pointers read before any delete → alarm test.
- RT16: [pending] given a list call that fails, the run deletes nothing for that prefix, records the error and leaves the other prefixes' results reported → sweep test.
- RT26: [pending] given a fake clock that passes the 10-minute budget during the mark, the run starts no further R2 call, deletes no pool object, records `status: "overrun"` and `remaining`; passing it during the sweep stops before the next batch → sweep test.
- RT27: [pending] given a retention run that fails, overruns or throws from inside the sweep, the next publication alarm runs and commits normally, and `/health` keeps the publication's `ok` and HTTP status → alarm and health test with a positive control.

### Budget
- RT17: [measure] the first Dev `dry-run` records `retention.lastRun.r2` with Class A ≤ 400 and Class B ≤ 600 (estimate ≈ 305 and ≈ 515) and `elapsedMs` under the 10-minute budget, and the publication's own `lastRun.r2` unchanged in kind (`curl` of Dev `/health`).
- RT18: [measure] a Dev `enforce` run sends ≤ 1,000 subrequests and stays within the alarm's limits with 20,000 deletes (`/health` `retention.lastRun`, Workers logs).
- RT19: [measure] after 2026-11-13 and the Dev drain, `oss-knowledge-base-dev` stores ≤ 2 GB (expected ≈ 1.2 GB), measured with GraphQL `r2StorageAdaptiveGroups`.

### Observability
- RT20: [pending] `/health` `retention` has Behavior 9's fields and statuses for a `dry-run` (deleted 0), an `enforce` run, a skip and a failure, with `runId` `retention-<UTC date>` → health test.
- RT28: [pending] given each retention status (`ok`, `failed`, `overrun`, `skipped`), the publication's `status` field in `/health` is the same as with retention off → health test.
- RT21: [deploy] Dev `dry-run`: the PR that enables it records the first run's retained releases, candidate counts and bytes, compared with this spec's Example before `enforce` is proposed.
- RT22: [deploy] Dev `enforce`: after each of the first three runs, `bun run verify:health --target dev` and `bun run verify:ui --target dev` pass, `/api/feed` and `/api/search` serve the current release, the digest and embedding job still read their pinned release, and that evening's publication succeeds.
- RT23: [deploy] Prod: `dry-run`, then `enforce`, each in its own PR with the owner's explicit approval (O2), with the same checks as RT21 and RT22 on Prod.

## Rollout (operator sequence, for the implementing PRs)

1. Merge the implementation with `R2_RETENTION` unset everywhere and
   `RETENTION_CRON` added to both configs: the tick fires and does nothing.
2. Dev `dry-run` PR: after the 10:17 UTC slot, `/health` shows
   `retention.status: "ok"`, `lastRun.mode: "dry-run"`, `deleted.objects:
   0`, candidate bytes near the Example's estimate, `retained.releases`
   including both current releases and every release of the last 30 days.
   Stop if a current release is a candidate. That evening's publication
   succeeds unchanged.
3. Dev `enforce` PR (owner reviews the dry-run numbers): each run deletes
   ≤ 20,000 objects; check RT22 after the first three runs. Rollback: set
   `R2_RETENTION` back to `dry-run` or `off` (deleted objects cannot be
   restored; the live release, the previous release and the last 30 days
   are never candidates).
4. Prod `dry-run`, then Prod `enforce`, each in its own PR with explicit
   owner approval (O2).

## Decisions (owner, 2026-10-21)

- **O1. Retention window: decided.** Every verified release of the last 30
  days, with a floor of the 2 newest verified releases so the live and the
  previous successful release are kept after a stall longer than 30 days.
  The owner accepts the extra storage (about 1.3 GB account-wide, still
  inside the included 10 GB) within a $5 a month overage budget. Replaces
  the first draft's "14 newest releases".
- **O2. Prod `dry-run` and Prod `enforce`: decided as written.** Each needs
  its own PR with the owner's explicit approval, after Dev evidence (core
  decision: irreversible deletion on Prod).
- **O3. Evidence of swept releases: decided.** Deleted together with the
  release (about 1.8 MB each); it describes objects that no longer exist.
- **O4. Old `/search/:detailRef` links: decided.** A link to a deleted
  release answers 404 "expired" (Behavior 8).
- **Separate job: decided** (owner principle, 2026-10-21: one job must not
  carry too many tasks). Retention has its own trigger, budget, status and
  failure isolation (Behaviors 2, 7, 9, 12).

## Non-goals

- Digest objects (`public/digest/v1/<projectId>/<releaseId>/…`), review-queue
  objects (`public/review-queue/v1/`), rosters and the activity log
  (`internal/`): other prefixes and owners; gardening G9 keeps them listed.
- Restoring deleted objects, or a recycle bin.
- An R2 lifecycle rule (rejected above).
- Changing the publication's writes or the G10 skip-`head` optimization;
  this spec only guarantees that the previous successful release is always
  retained (Behavior 3).
- The cost guard's dollar-budget amendment (its own PR).
- Any web change beyond Behavior 8.
