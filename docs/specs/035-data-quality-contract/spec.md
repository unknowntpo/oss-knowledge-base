# Spec 035: Release quality gate and data contracts

Status: Draft — spec only, no code (2026-11-16). Every tested item is `[pending]`. Owner decisions DQ-O1–DQ-O6 are open; each has a recommendation.
Date: 2026-11-16
Traceability: enforced
Builds on: ADR-0010 (verify all immutable objects, then switch each pointer last), ADR-0013 (content-addressed detail pools), Spec 006 (publication-set evidence), Spec 008 (count and orphan invariants), Spec 009 (bounded memory, pointers last), Spec 010 (stale pill), Spec 018 (daily publication, catch-up and retry runs), Spec 021 (overdue pill), Spec 028 (`/health` signals), Spec 029 (retention sweeps unreachable releases)

## Intent

The maintainer can trust that every release the site serves passed explicit
content rules, and can see why a release was refused. Today the publisher
refuses a release only when its objects are structurally broken (wrong
digest, wrong count, orphan detail). It switches the pointers to a release
whose GitHub source returned nothing, whose entries repeat, or whose fields
are missing, as long as the objects agree with each other.

Two parts, one intent ("what a release must satisfy before readers see it"):

1. **Quality gate.** Named rules for freshness, completeness, duplicates and
   schema run on the release after its objects are written and verified and
   before `switching-pointers`. Each run writes one quality report. A run
   with a blocking violation does not switch either pointer: readers keep
   the current release, and the run ends `ok: false`.
2. **Data contracts.** Each R2 snapshot object kind and each read-only API
   response that others read gets a versioned JSON Schema file in the
   repository. CI validates writer output and API responses against those
   files (contract tests), and the gate's schema rules use the same files at
   runtime.

Observable outcome: `/health` `lastRun.quality` shows the verdict, the rule
IDs that warned or blocked, and the report key; a blocked run leaves
`public/v2/current.json` and `public/search/v1/current.json` unchanged; a PR
that changes a published object shape without a schema change fails CI.

## Evidence

Inventory of what exists (read 2026-11-16 on `origin/main` `18a4624`).

### Checks that already block a release (keep; do not re-implement)

| Check | Where | Spec |
| --- | --- | --- |
| Domain event shape (ISO timestamps, http URLs) on ingest | `packages/domain/src/v1/validation.ts:167` `parseDomainEventV1` | 004 |
| Same event identity with different content | `packages/reference-pipeline/src/state.ts:27,36` (`EventIdentityConflictError`); `appendKeepingStored` keeps the stored copy and counts `sources.*.conflicts` | 012 |
| Pool key equals the SHA-256 of its bytes; byte length matches | `packages/serving-contract/src/publication-set.ts:423` `streamedObjectFailure` | 008 C3, 009 M5 |
| An existing key with different bytes (`destination-conflict`) | `publication-set.ts:454-531` | 008 C8, 009 M4 |
| Publication-set schema, ids, one Feed and one Search projection, keys under their prefix, unique keys, v2 detail count equals `entryCount` | `publication-set.ts:168-200`, `:588-670` `publicationSetValidationIssues` | 006, 008 |
| Detail map equals `entryCount`, no undeclared or orphan detail | `publication-set.ts:682-705` `verifyFeedDetailMap` | 008 C1–C2 |
| Search manifest guard, `objectDigests` equals the declared set, shards and terms declared, group count | `publication-set.ts:728-794` `verifySearchManifest`, guard `isSearchReleaseManifest` (`search-r2.ts:549`) | 013 |
| Pointers switch last, Search before Feed, only when bytes differ | `publication-set.ts:365-372`, `switchPointer` `:435-448` | 009 Behavior 4, 006 P3/P4 |

A failure returns a `PublicationFailure`; `runDataPublication` throws at
`apps/data-publisher-worker/src/pipeline.ts:286` before `recording-evidence`
and `committing-state`, so the cursors do not advance and Spec 018 schedules
a retry (10, 30, 60 min).

### Checks that only report

- Freshness in the page: `apps/web/src/freshness.ts` — overdue after 24 h 30 min (Spec 021), stale after 27 h (Spec 010). It never blocks (Spec 010 F4).
- `/health` `signals` rules (Spec 028, `apps/data-publisher-worker/src/signals/rules.ts`): `publication.freshness`, `job.missed`, `source.success`, `publication.pollTruncated`, `job.failures`, `job.duration`, `job.r2ClassA`. They never change a run or an HTTP status (OB28).
- `/health` `sources.*`: `read`, `skipped`, `filtered`, `conflicts`, `published`, `gapCapped`.

### Gaps this spec closes

1. **Completeness.** Nothing refuses a release whose `entryCount`, or one source's entries, fell to 0 or far below the current release.
2. **Duplicates.** Event conflicts are counted, but nothing checks for two Feed entries with one id, one display id or one source URL.
3. **Freshness before publishing.** Nothing refuses a release whose newest activity for a source is older than the current release's (data moving backwards).
4. **Schema.** The FeedIndex body (`osskb.feed-index.v2`), FeedEntry and FeedDetail have no runtime check; all checks are hand-written type guards (the only zod use is in `packages/sre-agent`). `/api/feed` casts the index body without a check (`apps/web/functions/api/_shared/r2-projection.ts:29-37`).
5. **Contracts.** No versioned schema file and no CI contract test exist for `/api/feed`, `/api/search` or the R2 snapshot objects. Parity tests compare bytes with recorded fixtures (`apps/data-publisher-worker/test/publication-parity.test.ts`), which catches every change, wanted or not, and says nothing about which readers break.
6. **No report.** A refused release leaves only `lastRun.ok: false` and an error string; a passed release leaves no record of what was checked.

### Versions in use (from `packages/serving-contract/src/`)

The Search release manifest written today is `osskb.search-release.v3`
(`search-r2.ts:17`); `v2` and `v1` are still read for rollback and older
detail refs (`:19-20`). The Feed pointer is `osskb.feed-manifest.v3` (v2 still
readable, `index.ts:52,62`).

## Example

Dev, captured 2026-11-15 23:34 UTC from the public `GET /health` of
`oss-knowledge-base-data-dev` and `GET /api/feed` of
`oss-knowledge-base-dev.pages.dev` (no R2 read). Prod's release
`2026-11-15T22-37-00-155Z` showed the same counts.

Input: release `2026-11-15T22-07-32-254Z` (`materializedAt`
`2026-11-15T22:07:32.254Z`). `/health` `lastRun`: `ok: true`,
`logicalEventCount` 11,136; `sources`: github read 219 / published 2,918,
mail read 59 / filtered 46 / published 83, jira read 26 / published 405;
`conflicts` 0 for each. `/api/feed`: `schema` `osskb.feed-index.v2`,
manifest `osskb.feed-manifest.v3`, `entryCount` 3,406 = entries 3,406
(datafusion/github 2,047, kafka/github 871, kafka/jira 405, kafka/mail 83).

Walk through each rule (thresholds are the recommended defaults, DQ-O2):

| Rule | Value on this release | Threshold | Status |
| --- | --- | --- | --- |
| `schema.objects` | 0 violations in 3,406 entries, the manifest, the detail map and the Search manifest | any violation blocks | pass |
| `completeness.entries` | 3,406 against the current release's count | block below 80 % of current | pass (previous days were similar; calibrate in report mode, DQ20) |
| `completeness.source` | github 2,918, jira 405, mail 83 | block when a source had entries in the current release and has 0 | pass |
| `completeness.authors` | 66 of 3,406 entries (1.9 %) have `authors: []`, all GitHub (for example `DATAFUSION-ISSUE-25610`) | warn above 5 % | pass |
| `duplicates.entries` | 0 duplicate `entry.id`, 0 duplicate `displayId`, 0 duplicate source URL (3,406 unique of 3,406) | any duplicate blocks | pass |
| `duplicates.events` | conflicts 0 of 304 events read | warn when > 0 | pass |
| `freshness.regression` | newest `lastActivityAt`: github `2026-11-15T22:06:09Z`, jira `2026-11-15T22:04:48.000Z`, mail `2026-11-15T16:17:21.000Z` | block when a source's newest activity is older than in the current release | pass |
| `freshness.lag` | github 83 s, jira 2 min 44 s, mail 5 h 50 min behind `materializedAt` | warn above 72 h | pass |

Verdict `pass`; the pointers switch as today; the report is written to
`internal/quality/v1/2026-11-15T22-07-32-254Z.json` and `/health` shows
`lastRun.quality: {verdict: "pass", warned: [], blocked: [], reportKey: …}`.

Counter-example (constructed from the numbers above, not observed): the
GitHub token loses its scope, GitHub answers 200 with no items, and the
connector keeps its cursor. The run's index would then hold only the stored
GitHub events still inside the window. Suppose it holds 1,120 entries.
`completeness.entries` reports 1,120 < 0.8 × 3,406 = 2,724.8 → `block`.
Under `enforce`, both pointers stay on `2026-11-15T22-07-32-254Z`, the run
ends `ok: false` with `quality-gate: completeness.entries`, Spec 018 retries,
and the page shows the overdue pill from 24 h 30 min (Spec 021) as for any
missed run. The report for the refused release names the rule, the value,
the threshold and the current release's value.

Found while writing the Example: `lastActivityAt` is `…Z` for GitHub and
`….000Z` for Jira and dev@. Both are RFC 3339; the contract uses
`format: date-time` and does not pin one form.

## Behavior

1. **Mode flag.** `DATA_QUALITY` = `off` (default, every environment at
   merge) | `report` | `enforce`. `off`: no rule runs. `report`: rules run
   and the report is written; nothing blocks. `enforce`: a `block` verdict
   stops the switch. Owner: the maintainer, so the gate ships dark and is
   calibrated before it can refuse a release (workflow "separate merge from
   enable").
2. **Place in the pipeline.** The gate runs inside `publishProjectionStreams`
   after `verifySearchManifest` and `verifyFeedDetailMap` pass and before the
   `switching-pointers` phase, as a new phase `checking-quality`. It reads
   the release's in-memory index and manifests, plus two small objects: the
   current Feed pointer `public/v2/current.json` (`switchPointer` reads it
   anyway and can reuse the bytes) and the current release's quality report
   (Behavior 5). It reads no index or detail of the current release. Owner: the maintainer, because only this point both sees
   the whole release and precedes the switch.
3. **Rules.** Each rule has an id, a severity per outcome (`pass`, `warn`,
   `block`), a threshold and a measured value. The first set:
   - `schema.objects`: the FeedIndex, the Feed manifest, the detail map and
     the Search release manifest validate against their contract files
     (Behavior 7). Any violation blocks. Owner: every reader of those objects.
   - `completeness.entries`: `entryCount` ≥ 80 % of the current release's.
     Below blocks. No current release (first publication) → `pass`.
   - `completeness.source`: a source with ≥ 1 entry in the current release
     has ≥ 1 entry in the new one. Otherwise blocks.
   - `completeness.authors`: share of entries with `authors: []`. Above 5 %
     warns; never blocks.
   - `duplicates.entries`: number of `entry.id`, `displayId` and source-URL
     values that occur more than once across entries. Any blocks.
   - `duplicates.events`: per source, `conflicts / read`. Above 0 warns; never
     blocks (the stored copy is kept by design).
   - `freshness.regression`: per source, the newest `lastActivityAt` is not
     older than in the current release. Older blocks. The current value comes
     from the current release's report (Behavior 5), so the previous index
     is never read.
     No earlier report → `pass` with value `null`.
   - `freshness.lag`: per source, `materializedAt` − newest `lastActivityAt`.
     Above 72 h warns; never blocks (the page's freshness pill already covers
     a late run; this covers a quiet source).
4. **Verdict.** `block` if any rule blocks, else `warn` if any warns, else
   `pass`. Under `enforce` a `block` returns
   `PublicationFailure{kind: "quality-gate"}` with the blocking rule ids; the
   run then follows the existing failure path (no evidence, no state commit,
   Spec 018 retry). Under `report` the verdict is recorded and the switch
   proceeds.
5. **Report.** One immutable object per evaluated release:
   `internal/quality/v1/<releaseId>.json`, schema `osskb.quality-report.v1`:
   `releaseId`, `evaluatedAt`, `mode`, `verdict`, `currentReleaseId` (or
   `null`), and `rules[]` of `{id, status, value, threshold, current, sample}`,
   where `sample` lists at most 5 offending ids. It is written for `pass`,
   `warn` and `block`, before the switch, with `putImmutableIfAbsent`. One
   Class A put per run. Owner: the maintainer (why a release was refused) and
   `freshness.regression` (yesterday's values). No Pages Function reads
   `internal/`, so the report is not public.
6. **`/health`.** `lastRun.quality` = `{mode, verdict, warned: string[],
   blocked: string[], reportKey}` or `null` when `off`. A Spec 028 rule
   `publication.quality` warns on `warn`, fires on `block`. Owner: the
   maintainer and the SRE agent (Spec 027), who already read `/health`.
7. **Contract files.** `packages/serving-contract/contracts/<schema>.schema.json`,
   JSON Schema 2020-12, one file per schema name. First set:
   `osskb.feed-index.v2`, `osskb.feed-manifest.v3`, `osskb.feed-detail-map.v1`,
   `osskb.search-current.v1`, `osskb.search-release.v3`,
   `osskb.search-release.v2` (read for rollback), `osskb.search-response.v1`,
   `osskb.quality-report.v1`. The `/api/feed` response is the FeedIndex plus
   `metadata.manifest`; its file references the two object schemas. Owner:
   the web Functions, the embedding job, the digest, retention and the
   verifier, which read these objects.
8. **Versioning.** The schema name carries the major version. In one version
   only optional fields may be added. Removing or renaming a field, changing
   a type, or adding a required field needs a new version file; the old file
   stays while any reader or rollback reads that version. Object schemas set
   `additionalProperties: false`, so an unplanned new field fails a contract
   test and appears in the PR as a contract-file change (a core decision under
   the merge-authority rules).
9. **Frozen versions.** `contracts/frozen.json` maps each released schema file
   to its SHA-256. `bun run check:contracts` fails when a frozen file changed
   or a referenced file is missing. Adding an optional field updates both the
   file and its digest in the same PR, so the change is visible.
10. **Contract tests in CI.** `bun run check:contracts` runs in the `static`
    job. The `unit` job runs:
    - writer tests: the recorded publication fixtures and a reference-pipeline
      run produce objects that validate against their files;
    - reader tests: `apps/web` Functions serve `/api/feed`, `/api/search`
      bodies that validate against their files (against the recorded R2 seed);
    - negative controls: each schema rejects a mutated copy (required field
      removed, wrong type, extra field), so a schema that accepts everything
      fails.
11. **Validator.** `@cfworker/json-schema` (no code generation, which Workers
    forbid; Ajv compiles with `new Function`). The same files feed the
    Worker gate and the tests. Choice recorded as DQ-O4.
12. **Retention.** A refused release's immutable objects are unreachable from
    every pointer, so Spec 029 sweeps them; the report under
    Spec 029 never lists `internal/` for deletion today (its Behavior 5), so
   reports accumulate (about 2 KB a run). A 30-day rule for
   `internal/quality/v1/` is a follow-up amendment to Spec 029, not part of
   this spec.

## Acceptance

### Behavior
- DQ1: [pending] Given `DATA_QUALITY=enforce` and a release that passes every rule → the run switches both pointers, writes `internal/quality/v1/<releaseId>.json` with `verdict: "pass"`, and `/health` `lastRun.quality.verdict` is `pass`. Evidence: unit test on `publishProjectionStreams` with an in-memory store.
- DQ2: [pending] Given the Example's values (3,406 entries; github 2,918, jira 405, mail 83; 66 empty `authors`) as a case-file row → every rule returns the status in the Example table. Evidence: case file `quality-rules.cases.ts`, rendered test plan.
- DQ3: [pending] Given `DATA_QUALITY=report` and a release that would block → the pointers switch, the report says `block`, `lastRun.ok` is `true` and `lastRun.quality.blocked` lists the rule. Evidence: unit test.
- DQ4: [pending] Given `DATA_QUALITY=off` → no rule runs, no report is written, `lastRun.quality` is `null`, and R2 operations equal today's. Evidence: unit test counting store calls.
- DQ5: [pending] Given each contract file → the writer output of `recorded-feed-publication.v1.json` and `publication-parity.v2.json` validates against it. Evidence: contract test.
- DQ6: [pending] Given the recorded R2 seed → `/api/feed` and `/api/search?q=share%20groups` bodies validate against `osskb.feed-index.v2` (+ manifest) and `osskb.search-response.v1`. Evidence: contract test in `apps/web/test`.

### Failure and retry
- DQ7: [pending] Given `enforce` and a release with `entryCount` below 80 % of the current release → neither `public/search/v1/current.json` nor `public/v2/current.json` changes, the run ends `ok: false` with `quality-gate: completeness.entries`, and the report holds value, threshold and current value. Evidence: unit test asserting the pointer bytes.
- DQ8: [pending] Given `enforce` and a source with entries in the current release and 0 in the new one → `completeness.source` blocks and names the source. Evidence: unit test.
- DQ9: [pending] Given two entries with the same `displayId` (or `entry.id`, or source URL) → `duplicates.entries` blocks and `sample` lists the ids. Evidence: case-file rows, one per key.
- DQ10: [pending] Given a source whose newest `lastActivityAt` is older than in the current release's report → `freshness.regression` blocks. Given no earlier report → `pass` with value `null`. Evidence: unit test.
- DQ11: [pending] Given a FeedEntry without `lastActivityAt`, or with an extra field → `schema.objects` blocks and the sample names the entry. Evidence: unit test.
- DQ12: [pending] Given a blocked run → the Spec 018 retry runs with its normal waits, and a retry that passes switches the pointers; the cursors did not advance in the blocked run. Evidence: pipeline test.
- DQ13: [pending] Given a crash after the report is written and before the switch → the retry run has a new release id and writes its own report; the old report stays and no pointer names the old release. Evidence: unit test with a failing `putCurrent`.
- DQ14: [pending] Given a report write that fails → under `enforce` the run fails before the switch (`store-error`); under `report` the switch proceeds and `lastRun.quality.reportKey` is `null`. Evidence: unit test.
- DQ15: [pending] Given the first publication (no current release) → completeness and freshness rules `pass` with `current: null`. Evidence: unit test.
- DQ16: [pending] Given a frozen contract file edited without updating `frozen.json`, or a schema that accepts a mutated copy → `bun run check:contracts` or the negative-control test fails. Evidence: test of the check script on a fixture tree.

### Budget
- DQ17: [measure] Gate time and memory on the Example release (3,406 entries, 11.3 MB `/api/feed` body): added publication time ≤ 2 s and peak heap within the Spec 009 bound. Command: `bun run measure:quality-gate` (to be added).
- DQ18: [measure] R2 cost: one Class A put and at most two Class B gets per evaluated run; with at most 4 runs a day (1 + 3 retries), ≤ 124 Class A and ≤ 248 Class B operations a month per environment. Command: count from `lastRun.r2` on Dev before and after `report`.
- DQ19: [measure] Bundle: the validator and contract files add ≤ 100 KiB to the publisher Worker. Command: `wrangler deploy --dry-run --outdir` size diff.

### Observability
- DQ20: [deploy] On Dev under `report` for 14 days → each day's `/health` `lastRun.quality` and report exist; the largest day-over-day drop of `entryCount` and per-source counts is recorded in this spec before `enforce` is proposed (calibrates DQ-O2).
- DQ21: [pending] Given a `warn` or `block` verdict → `/health` `signals` rule `publication.quality` shows `warn` or `firing` with the rule ids. Evidence: signals test.

## Simplification review

1. **Questioned.** Every rule names the failure it catches and its reader.
   A per-project `completeness` rule was questioned: per source covers the
   observed failure modes (a connector or token breaks per source).
2. **Deleted.** A count-consistency rule (index entries = manifest
   `entryCount` = detail map): `verifyFeedDetailMap` already blocks it. A
   rule on digest or key layout: Spec 008 already blocks it. A separate
   quality job: the gate must sit before the switch, so it is a phase, not a
   job. A runtime schema check in Pages Functions: the writer is the only
   producer, so CI and the gate cover it without per-request CPU. A
   generated TypeScript-from-schema step: the types stay hand-written; the
   contract tests catch drift.
3. **Simplified.** `freshness.regression` reads yesterday's report instead of
   the previous index (one get of a small object instead of an 11 MB read;
   the report key follows from the current pointer's `releaseId`).
4. **Shortened the cycle.** Rule logic is pure functions over the index and
   two reports, tested with case-file rows; no R2 in rule tests.
5. **Automated last.** `check:contracts` and the `publication.quality`
   signal come after the rules and files exist.

## Owner decisions (open)

- DQ-O1: Gate scope — both pointers or Feed only? Recommend both: Feed and Search are built from one index, and a bad index harms both.
- DQ-O2: Thresholds (80 % entries, 5 % empty authors, 72 h lag). Recommend these as provisional; fix them from the DQ20 report-mode data.
- DQ-O3: Override for a known-good drop (for example a project removed from the profile). Recommend none in slice 1: the drop is a config change, so the same PR updates the rule's exception list in code. An operator flag on `POST /run` can come later if a real case needs it.
- DQ-O4: Validator `@cfworker/json-schema` vs hand-written guards generated from schema. Recommend `@cfworker/json-schema` (one source of truth; works in Workers).
- DQ-O5: Retry after a block. Recommend the existing Spec 018 retries (no new branch); a deterministic block costs at most 3 runs of about 671 Class A operations (Dev `lastRun.r2.classA` on 2026-11-15).
- DQ-O6: Contract files are a data format read by others, so adding or changing one is a core decision. Recommend the owner approves each new major version; optional-field additions follow the normal PR review with the `frozen.json` diff visible.

## Slices

1. Rules as pure functions + case file + report schema; `DATA_QUALITY=off` everywhere (DQ2, DQ4, DQ9–DQ11, DQ15).
2. Contract files, `check:contracts`, writer/reader/negative tests in CI (DQ5, DQ6, DQ16).
3. Gate phase, report write, `/health` field and signal (DQ1, DQ3, DQ7, DQ8, DQ12–DQ14, DQ21); measure DQ17–DQ19.
4. Dev `report` for 14 days (DQ20) → thresholds decided → Dev `enforce` → Prod `report` → Prod `enforce`, each its own PR with an operator sequence.

## Non-goals

- Validating upstream source data beyond what a release holds (connectors keep their own rules, Spec 012).
- Search quality (ranking, recall); Spec 016 and 017 own it.
- Checking digest, review-queue, people or activity-log objects in slice 1; they have their own pointers and specs and can adopt the same contract files later.
- Blocking on page freshness: the stale and overdue pills (Specs 010, 021) stay report-only.
- Publishing the contracts on a public site.
