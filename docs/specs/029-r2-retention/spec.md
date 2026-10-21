# Spec 029: R2 release retention (mark and sweep)

Status: Draft (owner direction 2026-10-21: mark-and-sweep retention, dry run first, Dev before Prod; spec only, nothing implemented)
Date: 2026-10-21
Traceability: enforced
Builds on: ADR-0010 (rollback selects earlier pointers), ADR-0013 (content-addressed detail pools; "retention is deferred to its own spec"), Spec 006 (publication-set evidence), Spec 008 (R2 operations, pools), Spec 009 (bounded memory), Spec 013, Spec 014 (digest pins a release), Spec 016 (embedding job reads a release), Spec 018 (daily publication, follow-ups), Spec 026 (cost guard), Spec 028 (observability signals, PR #108, not merged)

## Intent

The owner can see that each R2 bucket stays at a bounded size, instead of
growing by one release (about 34 MB) per publication forever. The
publisher deletes what no reader can reach any more, and never what a
reader, a rollback or a running job can still reach.

Observable outcome: after Dev drains its backlog, the Dev bucket holds
about 0.6 GB instead of 13.37 GB, and Prod stays near 0.6 GB however long it
runs; `/health` `retention` shows each run's retained releases, candidates,
deleted objects and bytes.

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
  included. Cost today is about $0.05 a month, but Spec 026 trips at 80 %
  of the storage allowance (8 GB, CG2): the first Dev cost check will open
  the breaker on `r2StorageBytes`, and under `enforce` that stops the
  digest, the embedding job and semantic queries (Spec 026 Behavior 9).
  Retention is the precondition for Dev `enforce`.
- About 12.5 GB of Dev is superseded releases (prior investigation,
  2026-10-21: about 1,000 releases × release-scoped bytes).

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

A retention run in `dry-run` at the next Dev tick (2026-10-21 22:07 UTC,
after that day's publication `2026-10-21T22-07-…`), with N = 14:

1. **Retained releases**: the current Feed and Search pointers
   (`public/v2/current.json`, `public/search/v1/current.json`), the digest
   pointer's and the embedding job's release, and the 14 newest releases that
   have evidence. Today these are the daily releases 2026-10-13 → 10-21 plus
   follow-up and manual runs; all pinned releases are among them.
2. **Marked pool keys**: the union of pool keys in the 14 evidence objects:
   at least the 4,330 per pool above, plus details that changed within the
   14 releases.
3. **Candidates**: every other release prefix under `public/v2/releases/`
   and `public/search/v1/releases/` (about 1,000 each), their evidence
   objects, and every unmarked pool object uploaded more than 48 h ago.
   Expected bytes: about 12.5 GB of 13.37 GB.
4. **Dry run**: lists and reports; deletes nothing. `/health` shows
   `retention.lastRun {mode: "dry-run", retained: {releases: 14, poolKeys: ≥ 8,660},
   candidates: {releases, evidence, poolObjects, objects, bytes}, deleted: {objects: 0, bytes: 0}}`.
5. **Enforce** (a later PR): deletes at most 20,000 objects a run, oldest
   first; Dev drains in about 15 daily runs and ends near
   14 × 34.5 MB (releases) + about 40 MB (pools) + 14 × 1.8 MB (evidence)
   ≈ 0.55 GB.

## Simplification review

1. **Question every requirement.**
   - Retain the current pointers: every reader (Pages, digest, embedding
     job) starts there.
   - Retain the N newest verified releases: the owner, for rollback
     (ADR-0010: rollback selects an earlier verified pointer). "Verified"
     means its publication-set evidence exists, which the pipeline writes
     only after both pointers switched (`pipeline.ts:268-272`).
   - Retain the digest's and the embedding job's release: both pin a
     release and read it across invocations (`digest/store.ts:80`,
     `search-embedding/run.ts:469`).
   - Retain anything younger than 48 h: a crashed attempt's objects are
     reused by its retry through `head` (Spec 008); defence in depth on top
     of serialization (Behavior 7).
   - Dry run: the owner; the first evidence is counts and bytes with no
     delete.
   - A delete cap per run: the owner; bounds a bug's blast radius and the
     run's work.
   - `/health` `retention`: the owner and the Spec 027 SRE agent, to see
     that it ran and what it removed.
2. **Delete.**
   - A new Worker, cron or lease: the publication Durable Object's alarm
     already runs one job at a time (`index.ts:475-478`; the old
     `run-lease` is gone), so retention runs there after a successful
     publication and cannot interleave with one.
   - Reading shards or detail maps to mark: the evidence already lists every
     immutable key with its byte length; one read per retained release.
   - Reference counts, per-object metadata, tombstones: writes (Class A)
     on every publication; reachability from evidence needs none.
   - A time window *and* a count: a count alone survives a publishing stall
     (no new release, nothing becomes a candidate). The window is an open
     decision (O1) only because the owner proposed "14 days".
   - Verifying the current release after the sweep (one `head` per object,
     about 8,700 Class B a run): safety comes from construction (Behavior 5),
     asserted by tests.
   - Review-queue, digest, activity-log and roster objects: other prefixes,
     other owners (Non-goals).
3. **Simplify.** One pure function computes the retained set and the
   candidates from lists and evidence; the Durable Object only lists, reads
   and deletes.
4. **Shorten the cycle.** The retained-set rules are a generated case table;
   an in-memory bucket stands in for R2; no test calls the network.
5. **Automate last.** Retention rides the existing alarm; the Dev drain
   needs no script.

## Rejected alternatives

- **R2 lifecycle (TTL) rule alone.** Object age is not reachability: a pool
  object written 60 days ago is still referenced by today's release (reuse
  does not refresh its upload time), and a publishing stall longer than the
  TTL deletes the live release itself. Unsafe for pools and releases alike.
- **Dev wipe and reseed.** Deletes the live release (Dev serves nothing
  until a full backfill), loses the rollback window, costs about 300,000
  Class A puts again, and solves Dev once while Prod keeps growing.
- **Delete inside `publish`.** Couples retention failures to the
  publication and lengthens the critical path; running after the commit in
  the same alarm keeps both serialization and isolation.
- **A separate cron Worker.** Loses the alarm's serialization; would need a
  lease shared with the publication (the hazard ADR-0013 names: a pool
  object `head`-checked as existing, then deleted before the pointer switch).

## Behavior

1. `R2_RETENTION` (Worker var) unset, blank or `off`: nothing runs, nothing
   is listed, `/health` has no `retention` key. `dry-run` lists and reports
   without deleting. `enforce` also deletes. Any other value is
   `unconfigured`: nothing runs, `/health` shows the mode and the reason.
   Same shape as `COST_GUARD` (Spec 026 Behavior 1).
2. Retention runs inside `PipelineState.alarm`, after `runDataPublication`
   returned `ok: true` and its state was committed, at most once per UTC day
   (the day of its last run is one Durable Object storage key). It never runs
   after a failed run, while the cost guard pauses the publication (Spec 026
   Behavior 9; the alarm returns before publishing), or from a request.
   Its failure never changes the publication's status.
3. **Retained releases** (re-read after the publication commit):
   - the Feed release of `public/v2/current.json` and the Search release of
     `public/search/v1/current.json`;
   - the release of each digest pointer `public/digest/v1/<projectId>/current.json`
     (`sourceReleaseId`, schema `osskb.digest-pointer.v1`) and the embedding
     job's `lastRun.releaseId`;
   - the N newest releases by release id that have evidence under
     `publication-sets/v1/` (N = 14, O1), each contributing its Feed and
     Search release ids from the evidence;
   - any release whose id time is within the grace period (48 h).
   N below 2 is rejected at startup, so the previous successful release (the
   one a future skip-`head` list would trust, gardening G10) is always kept.
4. **Mark.** The marked pool keys are the union of the pool keys in the
   `immutableObjects` of the retained releases' evidence (schema
   `osskb.publication-set.v1`). Evidence is read one object at a time; only
   the key set is kept (Spec 009).
5. **Sweep candidates**, only under these prefixes:
   - every object under `public/v2/releases/<id>/` and
     `public/search/v1/releases/<id>/` whose `<id>` is not retained;
   - `publication-sets/v1/<setId>.json` whose releases are both not retained
     (O3);
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
7. **Serialization.** Retention and publication share one alarm, so no
   publication starts between the mark and the last delete; a `POST /run`
   arriving meanwhile schedules the next alarm (Spec 018). The grace period
   additionally keeps anything a crashed or concurrent writer created in the
   last 48 h.
8. A `/search/:detailRef` link whose release was swept answers 404
   `{error: "Search release expired"}` with `cache-control: no-store`
   instead of today's 503 (`apps/web/functions/api/search-detail/[ref].ts`),
   so an expired link is not reported as an outage (O4).
9. `/health` `retention` (only while `R2_RETENTION` is set):
   `{mode, status, reason, lastRun}`; `lastRun` is
   `{runId, at, mode, retained: {releases, poolKeys}, candidates:
   {releases, evidence, poolObjects, objects, bytes}, deleted: {objects,
   bytes}, remaining, r2: {classA, classB}, failureKind, error}`. `runId` is
   the publication's `publicationSetId` today and Spec 028's `runId` once
   it lands. Bytes come from the list results, not from extra reads.
10. **Spec 028 (light).** When `OBSERVABILITY_SIGNALS` lands, the
    publication's data point carries `retention.deleted.objects`,
    `retention.deleted.bytes` and `retention.remaining` under the same
    `runId`; no new rule is added here.
11. **Spec 026.** Retention's lists count toward the guard's month-to-date
    Class A like any other operation; its counters are its own, so the
    publication's tested invariant (Class A ≤ new objects + 3, Specs 008,
    018) is unchanged. After Dev drains, `r2StorageBytes` falls below 8 GB;
    an open breaker still needs the manual reset (Spec 026 Behavior 8).

## Budget

Pricing ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)):
`ListObjects` is Class A ($4.50 per million, 1 million a month included);
`GetObject` is Class B; `DeleteObject` is a free operation. Limits from
`wrangler.jsonc`: 20,000 subrequests and 300,000 ms CPU per invocation.

| Case | Class A (lists) | Class B (gets) | Subrequests | Month |
| --- | --- | --- | --- | --- |
| Dev drain, worst run: every prefix listed (302,468 objects / 1,000 per page) | ≈ 305 | ≤ 20 (pointers, ≤ 17 evidence) | ≈ 345 (+ 20 delete calls) | 31 × 305 ≈ 9,500 Class A: 0.95 % of the included million |
| Dev or Prod steady state (≈ 14 releases, two pools, evidence: about 10,000 objects) | ≈ 12 | ≤ 20 | ≈ 50 | ≈ 400 Class A |
| Worst case if the once-a-day rule failed and every follow-up ran it (24 a day on Dev during the drain) | 24 × 305 = 7,320 a day | — | — | 227,000: 23 % of the free Class A; the once-a-day key is tested (RT6) for this reason |

Memory: marked set ≤ about 20,000 keys (two pools × 4,330 live keys plus
changed details within 14 releases); candidates held at most up to the cap
(20,000 keys); evidence parsed one object at a time (1.8 MB each).

## Test plan

Generated from `apps/data-publisher-worker/test/retention.cases.ts` by
`bun run docs:test-plan` once slice 1 adds the case file; until then the
rows below are the intended retained-set rules (releases written as their
date; N = 14, grace 48 h, run at 2026-10-21T22:10Z).

| id | case | input | retained | candidate |
| --- | --- | --- | --- | --- |
| RT2 | 15 verified daily releases | 10-07 … 10-21, pointers at 10-21 | 10-08 … 10-21 | 10-07 |
| RT2 | pointer rolled back to an old release | 30 verified, Feed pointer at 09-15 | 14 newest + 09-15 | the other 15 |
| RT2 | Feed and Search pointers on different releases | Feed 10-21, Search 10-20 | both kept | — |
| RT2 | embedding job pinned to a release outside N | `lastRun.releaseId` 10-01 | 14 newest + 10-01 | — |
| RT2 | digest pointer outside N | digest `sourceReleaseId` 10-02 | 14 newest + 10-02 | — |
| RT2 | publishing stalled 30 days | 14 verified, newest 09-21 | all 14 | none |
| RT2 | release without evidence, 3 days old | crashed attempt 10-18 | — | 10-18 |
| RT2 | release without evidence, 47 h old | crashed attempt 10-19T23:10Z | kept (grace) | — |
| RT2 | N = 1 | config | rejected: N must be ≥ 2 | — |
| RT3 | pool object unmarked, uploaded 49 h ago | — | — | candidate |
| RT3 | pool object unmarked, uploaded 47 h ago | — | kept (grace) | — |
| RT3 | pool object marked by only the 14th-newest release | uploaded 09-02 | kept | — |

## Acceptance

Each item: precondition → action → observable result → evidence. Every
untagged item is `[pending]` until the slice that implements it removes its
tag.

### Behavior
- RT1: [pending] given `R2_RETENTION` unset, blank, `off`, `dry-run`, `enforce` or `on`, resolving it gives off, off, off, dry-run, enforce, unconfigured; while off or unconfigured a successful publication alarm makes no list or delete call and `/health` has no `retention` key (off) or shows the reason (unconfigured) → worker test.
- RT2: [pending] given the test-plan rows, `retainedReleases` returns exactly the retained and candidate releases of each row, and N < 2 is rejected → case rows.
- RT3: [pending] given the Example's evidence (4,330 pool keys per projection) plus unmarked pool objects at 47 h and 49 h, the marked set holds every evidence pool key and the candidates are exactly the unmarked objects older than 48 h → case rows.
- RT4: [pending] given an in-memory bucket with three releases (one retained), their evidence, two pools, `current.json` keys, a digest pointer and objects under `public/review-queue/` and `internal/`, an `enforce` run deletes exactly the non-retained release prefixes, their evidence and the unmarked old pool objects, and every key outside Behavior 5's prefixes is still present → sweep test.
- RT5: [pending] given the same bucket in `dry-run`, the run reports the same candidate counts and bytes as `enforce` would and makes zero delete calls → sweep test.
- RT6: [pending] given a successful publication, retention runs after the state commit in the same alarm; given a failed publication, or a second successful run on the same UTC day, or the cost guard pausing the publication, it makes no R2 call → alarm test with a positive control.
- RT7: [pending] given 25,000 candidates, an `enforce` run deletes 20,000 in batches of ≤ 1,000 keys, oldest release first and Search `manifest.json`/Feed `feed/index.json` before the rest of a release, and reports `remaining: 5,000`; the next run deletes the rest → sweep test.
- RT8: [pending] given a Search detail ref whose release manifest is absent, `GET /api/search-detail/:ref` answers 404 `{error: "Search release expired"}` with `cache-control: no-store`; a present release still answers 200 → Pages function test.

### Failure and retry
- RT9: [pending] given a retained release whose evidence is missing or not `osskb.publication-set.v1`, the run sweeps no pool object (fail closed), still sweeps non-retained release prefixes, and records `reason: "evidence-missing"` → sweep test.
- RT10: [pending] given an unreadable or invalid `current.json` (Feed or Search), the run deletes nothing and records `failureKind: "pointer-read"` → sweep test.
- RT11: [pending] given a delete batch that contains a retained-release key or a marked pool key (injected by a faulty candidate function), the run aborts before that batch with `failureKind: "invariant"` and deletes nothing more → sweep test with a positive control.
- RT12: [pending] given a delete call that throws after two batches, the run records the error and the deleted count so far, the publication's `lastRun` keeps `ok: true`, and the next run finishes the rest without error → sweep test.
- RT13: [pending] given a run that stops (isolate eviction simulated) between two deletes of one release, every retained release and marked pool object is intact and the next run removes the release's remaining objects → sweep test.
- RT14: [pending] given a second run on unchanged data, it deletes nothing and reports `candidates.objects: 0` → sweep test.
- RT15: [pending] given a `POST /run` received while retention runs, no publication starts before the retention run ends (the alarm serializes them) and the marked set was computed after the publication commit → alarm test.
- RT16: [pending] given a list call that fails, the run deletes nothing for that prefix, records the error and leaves the other prefixes' results reported → sweep test.

### Budget
- RT17: [measure] the first Dev `dry-run` records `retention.lastRun.r2` with Class A ≤ 400 and Class B ≤ 30 (estimate ≈ 305 and ≤ 20), and the publication's own `lastRun.r2` unchanged in kind (`curl` of Dev `/health`).
- RT18: [measure] a Dev `enforce` run sends ≤ 400 subrequests and stays within the alarm's limits with 20,000 deletes (`/health` `retention.lastRun`, Workers logs).
- RT19: [measure] after the Dev drain, `oss-knowledge-base-dev` stores ≤ 1.5 GB (expected ≈ 0.6 GB), measured with GraphQL `r2StorageAdaptiveGroups`.

### Observability
- RT20: [pending] `/health` `retention` has Behavior 9's fields for a `dry-run` (deleted 0) and for an `enforce` run, with `runId` equal to `lastRun.publicationSetId` → health test.
- RT21: [deploy] Dev `dry-run`: the PR that enables it records the first run's retained releases, candidate counts and bytes, compared with this spec's Example before `enforce` is proposed.
- RT22: [deploy] Dev `enforce`: after each of the first three runs, `bun run verify:health --target dev` and `bun run verify:ui --target dev` pass, `/api/feed` and `/api/search` serve the current release, and the digest and embedding job still read their pinned release.
- RT23: [deploy] Prod: `dry-run`, then `enforce`, each in its own PR with the owner's explicit approval (O2), with the same checks as RT21 and RT22 on Prod.

## Rollout (operator sequence, for the implementing PRs)

1. Merge the implementation with `R2_RETENTION` unset everywhere: nothing
   changes at runtime.
2. Dev `dry-run` PR: after the 22:07 UTC tick, `/health` shows
   `retention.lastRun.mode: "dry-run"`, `deleted.objects: 0`, candidate
   bytes near 12.5 GB, `retained.releases` ≥ 14 and including both current
   releases. Stop if a current release is a candidate.
3. Dev `enforce` PR (owner reviews the dry-run numbers): each run deletes
   ≤ 20,000 objects; check RT22 after the first three runs. Rollback: set
   `R2_RETENTION` back to `dry-run` (deleted objects cannot be restored;
   the live release and the 14 newest are never candidates).
4. Prod `dry-run`, then Prod `enforce`, each with explicit owner approval.

## Open decisions for the owner

- **O1. Retention size.** Proposal: the 14 newest verified releases. ADR-0010
  states no window; with daily releases 14 releases ≈ 14 days, but Spec 018
  follow-up and manual runs make the window shorter. Alternative: every
  release of the last 14 days *and* at least 14 (more storage after bursts).
- **O2. Prod `enforce`.** Core decision (irreversible deletion on Prod):
  needs the owner's explicit approval in its own PR, after Dev evidence.
  Prod `dry-run` also gets its own PR.
- **O3. Evidence of swept releases.** Proposal: delete it with the release
  (about 1.8 MB each, about 1.8 GB on Dev); it describes objects that no
  longer exist. Alternative: keep all evidence as an audit log.
- **O4. Old `/search/:detailRef` links.** A shared Search Detail link older
  than the retained releases stops working. Proposal: answer 404 "expired"
  (Behavior 8). Alternative: a later spec resolves the ref against the
  current release.

## Non-goals

- Digest objects (`public/digest/v1/<projectId>/<releaseId>/…`), review-queue
  objects (`public/review-queue/v1/`), rosters and the activity log
  (`internal/`): other prefixes and owners; gardening G9 keeps them listed.
- Restoring deleted objects, or a recycle bin.
- An R2 lifecycle rule (rejected above).
- Changing the publication's writes or the G10 skip-`head` optimization;
  this spec only guarantees that the previous successful release is always
  retained (Behavior 3).
- Any web change beyond Behavior 8.
