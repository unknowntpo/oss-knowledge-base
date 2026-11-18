# Spec 037: Contributor profiles read from person shards

Status: Draft (2026-11-18; written for owner review before any code; FC15–FC16 open; PS1–PS24 [pending]/[measure]/[deploy])
Date: 2026-11-18
Traceability: enforced
Builds on: Spec 019 (contributor profile: "Publish time, request time", W18, W29, G75; the activity log of slice 2b), Spec 022 (review store), Spec 030 (`/api/activity` shares the reader cache), Spec 026 (cost guard, CG23), Spec 018 (daily publication and its retries)

> **Why a new spec, not a Spec 019 amendment.** The change adds a derived
> store with its own job, flags, acceptance prefix and cost line. Spec 019
> is 2,949 lines with eight amendments; one more would hide the decision.
> Spec 019 keeps its contract (`osskb.people-profile.v1`), and this spec
> changes only how the reader builds it. Spec numbers 034–036 are taken by
> open PRs #197, #198 and #196, so this is 037.

## Intent

A visitor opens a contributor profile (`/<project>/people/<id>`, Dev only,
`PEOPLE_PROFILES=true`). Today the Pages reader rebuilds the profile at
request time from every month object of two stores (Spec 019 "Publish time,
request time"). Spec 019 rejected per-person precomputed objects as "a
performance guess" (its simplification table). This spec replaces the guess
with measured numbers and picks a stored shape.

Observable outcome: a cold profile request reads at most 4 R2 objects and
parses at most 2 MiB, at any log age up to the 12-month horizon and at twice
today's volume. The response equals today's response for the same store
snapshot. Spec 019 W18 then holds without a deadline, and G75 closes.

### Non-goals

- No change to `osskb.people-profile.v1`, the page, or the route.
- No change to the activity log's month objects or to Spec 022's review
  months. Prod writes the activity log (`PEOPLE_ACTIVITY=log@1`).
- Person search (Spec 019 slice 3, W43) and `/api/activity` (Spec 030) keep
  reading the month objects. Both stay inside W18 today (see Example).
- No Prod enablement. `PEOPLE_PROFILES` stays unset on Prod.

## Example

Recorded 2026-11-18 05:43–06:08 UTC. Each number is labelled: **observed**
(Dev `/health` or an anonymous Dev GET), **derived** (code plus Dev state),
or **constructed** (`bun run measure:people`, a deterministic store).

### The stores on Dev today

| Fact | Value | Label |
| --- | --- | --- |
| Activity log `coverageFrom` | 2026-09-10T02:45:16Z, both projects (first append 2026-10-15) | observed, `/health` `lastRun.activity` |
| Activity log month objects | 3 per project: 2026-09, 2026-10, 2026-11 | observed, `/health` `identityLinks.lastRun.inputs.months` |
| Last append | 6 months written, 0 unchanged, 8,363 rows, 1,120 identities, 4,477,691 bytes (months plus their `.summary.json`), 14 Class A, 8 Class B, 23.5 s | observed, `/health` `lastRun.activity` |
| Review store `coverageFrom` | 2025-10-14, both projects; 12-month view from 2025-12 | observed, `/health` `githubReviews` |
| Review store, last daily tick | Kafka 396 reviews, 120 added, 2 months written, 758,531 bytes | observed |
| `.summary.json` readers | none in production code (only the writer, its tests and an E2E fixture) | derived, `grep` of `peopleActivitySummaryKey` |
| Per-project log size | not reported anywhere | `/health` has no per-project or per-month byte count |

### One profile request today

Reads on a cold isolate (derived from `readPersonProfile` and the state
above): 1 review `state.json` + 1 activity `state.json` + 12 review months +
3 activity months = **17 R2 Class B per project**, plus 2 with `PEOPLE_KIPS`
on Kafka. The 12-month worst case is 26 (28 with KIPs). A warm request
within 10 minutes per isolate reads nothing (`cached()`, W29).

Latency, anonymous GETs to `https://oss-knowledge-base-dev.pages.dev`, a
fresh query string each time so no HTTP cache answers (observed):

| Request | 1st (after ≥ 10 min idle) | 2nd, 3rd | Response gzip / raw |
| --- | --- | --- | --- |
| `datafusion/github:alamb` | 3.44 s (05:43) | 0.24 s, 0.17 s | 90.6 KB / 638 KB |
| `kafka/github:chia7712` | 0.81 s (05:43) | 0.18 s, 0.19 s | 52.9 KB / 390 KB |
| `kafka/github:m1a2st` (after chia7712, same isolate) | 0.08 s | 0.10 s, 0.21 s | 20.9 KB |

Two more rounds after ≥ 10 minutes idle (05:55 and 06:07 UTC, observed):
DataFusion `alamb` first request 2.21 s and 1.94 s, second 0.28 s and
0.23 s; Kafka `chia7712` first 1.58 s and 1.71 s, second 0.20 s and 1.49 s
(the 1.49 s likely landed on another isolate). Over n = 3 rounds, the first
request after idle took **1.9–3.4 s for DataFusion and 0.8–1.7 s for
Kafka**; a warm request took 0.17–0.28 s.

The first request mixes a Pages cold start with the R2 reads; the outside
cannot tell them apart. So these numbers show the order of magnitude only.
The `[measure]` items below measure reads and bytes with a counting bucket.

What the response carries (observed): alamb 1,239 reviews given, 418
received, 1,142 activity records, 645 threads; chia7712 2,297 given, 12
received, 99 records, 80 threads. **The response is row lists, not
counters.** A counters-only summary cannot reproduce it.

### Bytes parsed, by log age (constructed)

`bun run measure:people --months N --report-only` (12 review months plus N
activity months; heaviest reviewer per project):

| Log age (month objects) | Kafka `chia7712` parsed | DataFusion `alamb` parsed | DataFusion isolate heap kept | W18 (16 MiB) |
| --- | --- | --- | --- | --- |
| 3 (today) | 5.1 MiB | 7.6 MiB | 14.4 MB | pass |
| 6 | 7.1 MiB | 12.4 MiB | 23.3 MB | pass |
| 8 | 8.4 MiB | 15.7 MiB | 27.8 MB | pass |
| 9 | 9.1 MiB | 17.3 MiB | 30.7 MB | **fail** |
| 12 | 11.1 MiB | 22.1 MiB | 39.4 MB | **fail** |

Fit for DataFusion: about 2.8 MiB of review months plus 1.62 MiB per
activity month (constructed). Kafka never fails at 1×.

### When W18 breaks on real data

- The real volume is smaller than the model. The last append wrote 4.48 MB
  for both projects' 3 month objects **with** their summaries, about 2.2
  months of coverage (2026-09 holds 20 days, 2026-11 holds 17). The model
  gives about 5.3 MB for the same coverage **without** summaries. So the
  real month is at most about 0.84 of the model (derived).
- "Months old" here counts month objects from 2026-09, the month of
  `coverageFrom`; 2026-09 holds only 0.7 of a month.
- **Model rate:** DataFusion passes 16 MiB at about 8.45 month-equivalents:
  the 9th object, **about 2027-05-14**.
- **Real rate (≤ 0.84 of the model):** about 10 month-equivalents: **about
  2027-07-01**.
- **At 2× volume** (DataFusion's activity doubles): about 3.3 months,
  **about 2026-12**, which is next month.
- G75's "fix before the log is 6 months old" means 2027-03-10 counted from
  `coverageFrom`, or 2027-04-15 counted from the first append.

### What a stored shape costs (derived)

- Identities: 1,120 in a 35-day window (observed). Over 12 months the count
  is unknown; this spec assumes 3,000–5,000 (hypothesis H1, measured by
  PS19).
- Changed identities a day: about 240 activity rows a day (8,363 / 35) and
  about 400–700 reviews a day across both projects, each review touching
  two identities. So about 300–600 identities change a day (hypothesis H2).
- Runs a day: 1 cron + 5 catch-ups + 3 retries + 6 platform retries = 15
  (Spec 019 cost table).
- Cost guard: with `enforce`, 50,000 Class A in 24 hours pauses the
  publication (CG23). Dev runs `monitor`.
- Isolate cache: `CACHE_ENTRIES = 64` keys per bucket. Today a profile of
  each project keeps 19 keys; at 12 months, 28 per project, 56 for both.

## Forces (約束)

Kinds: hard limit, quality, taste, assumption. **Owner** marks the two Forces
the owner decides; the AI decided the rest.

| ID | Force | Kind | Source | Conflicts with |
| --- | --- | --- | --- | --- |
| FC1 | A cold profile parses at most 16 MiB (W18), as a tripwire under the 128 MB isolate | hard limit | Spec 019 W18; measured above | FC7 |
| FC2 | A Pages isolate has 128 MB; profile, person search (28.8 MB parsed) and `/api/activity` share it | hard limit | platform limit; Spec 019 Budget | FC7 |
| FC3 | R2 Class A stays far under 1 M a month, and no path can reach the cost guard's 50,000 Class A in 24 hours | hard limit | Spec 026 CG23; the 2026-10-13 Class A incident | FC5 |
| FC4 | R2 Class B stays far under 10 M a month (the publication alone sent 7,099 in its last run) | hard limit | `/health` `lastRun.r2` | — |
| FC5 | Object count and per-run writes do not grow with the number of identities (Spec 019's G59 reason) | hard limit | Spec 019 "Publish time, request time"; G59 | FC6 |
| FC6 | A profile reads few objects and parses only bytes near its own identity | quality | Example: 17–28 reads, 7.6–22 MiB parsed | FC5 |
| FC7 | The response equals today's for the same store snapshot, `generatedAt` aside | quality | the task; `osskb.people-profile.v1` readers | FC1, FC6 |
| FC8 | Suppression (P-e) and bot filtering act at request time, so a removal never waits for a build | quality | Spec 019 P-e, W12 | FC6 |
| FC9 | Prod writes the activity log; its format does not change here | hard limit | `PEOPLE_ACTIVITY=log@1` on Prod since `v0.3.7` | FC6 |
| FC10 | Person search, `kipMonthFacts`, the identity-link job, the identity backfill and the append's byte-compare merge read the month objects; none of them changes | hard limit | code readers of `peopleActivityMonthKey` | FC6 |
| FC11 | One job, one responsibility: a new build runs as its own job with its own trigger, budget and `/health` status, never inside the publication | quality | owner rule "Small jobs"; W19 (publication peak 102.7 MB at 2×) | FC16 |
| FC12 | A failed or missing build never turns a profile into an error page; the page stays as honest as today (`unavailableMonths`) | quality | Spec 019 W29, failure items | — |
| FC13 | Several jobs feed a profile: the publication's append (22:07), Spec 022 reviews and `refresh-areas` (same tick), identity links (02:17), KIP pages (03:43) | assumption | Dev crons, feature map | FC16 |
| FC14 | Each name states its output | taste | workflow "Naming" | — |
| FC15 | **Owner: what "better" means.** (a) Only W18's 16 MiB parse budget holds through 12 months at 2×; or (b) also a cold-request latency target on Dev, for example W18's existing "under 500 ms", which the first-request samples above already miss | quality | owner decision needed | FC5, FC3 |
| FC16 | **Owner: how stale a profile may be.** Proposed: at most 1 hour behind the newest input store after a successful daily run; after a failed build, the last good build, with its real `period.until` | quality | owner decision needed | FC11, FC7 |

Problem: find a stored shape that keeps FC1, FC2 and FC6 at 12 months and
2× volume, keeps FC3–FC5 bounded whatever the number of identities, and
returns the FC7-equal response, without changing a format Prod writes
(FC9, FC10).

### Solution space

The alternatives differ in one knob: how many identities share one stored
object (S shards per project). S = 1 is a per-project summary; S = number of
identities is per-person objects.

| Alternative | Cold reads | Parsed (DF, 12 mo, 2×) | Class A per build, worst | Objects | FC verdict |
| --- | --- | --- | --- | --- | --- |
| A. Null: request-time aggregation | 26–28 | 46 MiB | 0 | 0 new | fails FC1 at about 2027-05–07 (1×) and next month at 2×; fails FC6; FC15(b) already missed on first requests |
| B. Split each log month by a hash of the person id (G75) | 26–28 (each month still read) | about 5.6 MiB reviews + small parts | 12 months × S parts × 15 runs | S × 12 × 2 | fails FC9 and FC10 (Prod format and five readers change); review months are Spec 022's, not split; FC6 only on bytes |
| C. One compacted summary per project, written at publish time (S = 1) | 2–4 | about 30 MiB (rows must stay, FC7) | 2 | 2 | fails FC1 at 2× and FC2; publish-time build fails FC11 |
| D. Per-person objects, revisited (S = identities) | 2–4 | under 2 MiB (one person) | normal about 300–600; a full rewrite 3,000–5,000 × 15 runs = 45,000–75,000 a day | 3,000–5,000, growing | passes FC1, FC6; **fails FC3 and FC5** on the full-rewrite path (a format revision, or a popular thread retitled); needs a write cap that then breaks FC7 until the backlog drains |
| **E. Person shards, S = 64, built by their own job** | 2–4 | about 1–2 MiB (46 MiB / 64, plus thread metadata repeated in each shard that has a participant) | 130 a build (64 shards + 1 manifest, per project); 15 builds = 1,950 a day | 130, fixed | passes FC1–FC12 within the measured margins; trades FC16 (freshness lag) |

Decision: **E**. It is the only alternative whose worst case is bounded by a
constant (FC3, FC5) while a profile reads 2–4 objects (FC6). D wins on bytes
parsed, but its worst case grows with identities and approaches the cost
guard's 50,000 Class A trip. C is E with S = 1 and fails at 2×. B changes a
format Prod writes and five readers, and still reads 26 objects.

Pattern: hash partitioning of a derived, rebuildable read model. The source
of truth stays the two stores. Deleting every shard loses nothing.

## Design (alternative E)

### What is stored

Under `internal/profile-shards/v1/<projectId>/` (new prefix, nothing under
`public/`):

| Object | Schema | Content |
| --- | --- | --- |
| `manifest.json` | `osskb.profile-shards-manifest.v1` | `builtAt`; `inputs` (both stores' `updatedAt` and `coverageFrom`, the activity log's `firstAppendAt`, the month lists read); `shards` (count 64, and the SHA-256 of each shard's bytes); `bots` (learned bot logins of the review months); `kipFacts` (per month: the project-wide facts `kipMonthFacts` derives today) |
| `<NN>.json`, `00`–`63` | `osskb.profile-shard.v1` | for each identity whose key hashes to NN: its review rows given and received, per month; its activity rows, per month; the `threads{}` entries and `people{}` names those rows refer to; the `pulls` metadata and public name its review rows need |

The shard keeps rows per month, so the reader applies the 12-month window,
`coverageFrom`, the Jira "newest month wins" rule, suppression and bot
filtering at request time, exactly as today (FC7, FC8).

### Who builds it

A new job, `profile-shards` (FC11, FC14), in its own Durable Object alarm
invocation, behind the Worker var `PROFILE_SHARDS=build@1`:

- Trigger: an hourly cron at minute 37, and `POST /profile-shards/run`.
- Each tick reads the two `state.json` objects per project and the
  manifest (6 Class B for both projects). It builds only when an input's
  `updatedAt` differs from the manifest's `inputs` (FC13: a later
  `refresh-areas` or a retried publication changes `updatedAt` and causes a
  rebuild).
- A build reads the month objects one at a time, in one or more passes of
  shard groups, so its heap stays under the Spec 009 budgets (pass count set
  by PS18).
- It writes only shards whose SHA-256 differs from the manifest, then the
  manifest last, so a crash leaves the previous manifest pointing at
  consistent shards for every unchanged shard (see Failure).
- `/health` `profileShards {revision, lastRun {ok, status, at, durationMs, inputs, shardsWritten, bytesWritten, largestShardBytes, r2 {classA, classB}, error?}, lastGoodAt}`.

### Who reads it

The Pages var `PEOPLE_PROFILE_READ`:

- unset or `months`: today's path, unchanged.
- `shards@1`: read the manifest and the identity's shard; with
  `PEOPLE_KIPS=true` also the two KIP tables, as today. `kips` uses the
  manifest's `kipFacts` in place of the month objects.
- While `shards@1` is set on Dev, `?read=months` serves today's path for one
  request, so the equivalence check (PS1) compares both on the same store.

### Simplification (stop writing `.summary.json`)

The append writes a `<YYYY-MM>.summary.json` beside every changed month
(decision 10, for slice 7's list), and nothing reads it. A later slice stops
writing it: half of the append's Class A. Objects already stored stay
(Spec 029 retention decides). Slice 7's list, when built, reads per-identity
counters from the shards instead. This touches the Prod publisher, so it
ships in its own PR with its own Prod tag (FC9 is about the month format;
the summary is a separate, unread object).

## Behavior

1. The `profile-shards` job builds the shards from the two stores and never
   from anything else; a build with unchanged inputs writes nothing (FC3,
   FC11, FC13).
2. Shard number = the first byte of SHA-256(`<projectId>\0<personKey>`)
   mod 64, with `personKey` as the reader computes it today
   (`github:<lower-case login>`, `jira:…`, `mail:…`) (FC5, FC6).
3. A shard holds the identity's rows per month and only the thread, name
   and pull metadata those rows refer to (FC6, FC7).
4. The manifest is written after every shard of the build; a reader uses a
   shard only when its SHA-256 equals the manifest's entry (FC12).
5. With `PEOPLE_PROFILE_READ=shards@1`, the reader returns the same body as
   the months path for the same inputs and `nowMs` (FC7). Suppression, bot
   filtering, the 12-month window and coverage stay request-time (FC8).
6. When the manifest is missing or unreadable, or the identity's shard is
   missing, unreadable or fails its digest, the reader serves that request
   by the months path and adds `x-people-read: months-fallback` (FC12).
   Otherwise it adds `x-people-read: shards`.
7. A profile's `period.until` and `coverage` come from the manifest's
   `inputs`, so a lagging build shows its real dates (FC16).
8. Person search and `/api/activity` are unchanged (FC10).

## Acceptance

All testable items are `[pending]` until slice 1. One tag per item.

### Behavior

- PS1: [deploy] on Dev with `shards@1`, after a build whose `inputs` equal
  both stores' current `state.json`, for the sample set (`kafka/github:chia7712`,
  `kafka/github:m1a2st`, `datafusion/github:alamb`, `kafka/jira:chia-ping tsai`,
  `kafka/mail:andrew schofield`, `kafka/github:AndrewJSchofield`, and 20
  identities drawn at random from the shards) → GET each profile with and
  without `?read=months` → the two bodies are deep-equal after removing
  `generatedAt`, and the status codes match → a committed compare script's
  report in the PR.
- PS2: [pending] given a constructed store and fixed `nowMs` → `readPersonProfile`
  through the months path and through the shards built from the same store
  → deep-equal bodies, for every identity in the store → unit test iterating
  a case file.
- PS3: [pending] given a Jira issue present in two month objects → both
  paths → one record, from the newer month → unit test.
- PS4: [pending] given `nowMs` on the first day of a month, so the 12-month
  window drops the oldest month → both paths, shards built the day before →
  equal bodies → unit test.
- PS5: [pending] given a bot login, `ghost`, an unknown id and a suppressed
  id → both paths → the same 404 bodies → unit test.
- PS6: [pending] given a suppression added after the build → the shards path
  → 404 at once, with no rebuild (positive control: the same id returns 200
  without the suppression) → unit test.
- PS7: [pending] given `PEOPLE_KIPS=true` and a Kafka store with KIP threads →
  both paths → equal `kips` → unit test.
- PS8: [pending] given the shard function → 10,000 random person keys → every
  shard number in 0–63, and the same key always gives the same number →
  unit test.
- PS9: [pending] given `PEOPLE_PROFILE_READ` unset, `months`, blank or an
  unknown value → a profile request → the months path, and no shard key is
  read → API test with a counting bucket.

### Failure and retry

- PS10: [pending] given a manifest that is missing → a profile request with
  `shards@1` → the months path's body and `x-people-read: months-fallback` →
  API test.
- PS11: [pending] given a shard whose bytes differ from the manifest's
  SHA-256 (a crash between a shard write and the manifest write) → the
  request → the months path for that request; other shards still serve →
  unit test.
- PS12: [pending] given a build that fails after writing 10 of 64 shards →
  the next build → the manifest still names the previous digests until the
  build completes; the next build writes the remaining shards and then the
  manifest → job test with a failing bucket.
- PS13: [pending] given a tick whose inputs equal the manifest's → the job →
  0 Class A, 6 Class B, `status: "unchanged"` → job test.
- PS14: [pending] given a month object that cannot be read during a build →
  the job → `ok: false`, no manifest write, the previous build stays
  served → job test.
- PS15: [pending] given `PROFILE_SHARDS` unset → the cron tick and the route →
  no R2 request, 404 on the route, no `/health` field → job test.
- PS16: [pending] given an input `updatedAt` newer than the manifest's
  `inputs` → a profile request → the body's `period.until` equals the
  manifest's input, not the store's (FC16 honesty) → unit test.

### Budget

- PS17: [measure] `bun run measure:people --read shards` at 12 months, 1× and
  2× → a cold profile reads at most 4 objects and parses at most 2 MiB for
  `alamb` and `chia7712`; the isolate keeps at most 8 MB for both
  projects' profiles (FC1, FC2, FC6).
- PS18: [measure] `bun run measure:profile-shards` at 12 months, 1× and 2× →
  the build's peak heap stays within the Spec 009 budget (96 MB) and the
  report names the pass count used (FC11).
- PS19: [measure] the first Dev build reports identities per project,
  largest shard bytes, total bytes, Class A and Class B; the PR checks
  hypotheses H1 and H2 against them.
- PS20: [measure] worst case stated in the slice PR: 130 Class A per build ×
  15 builds = 1,950 a day, 58,500 a month (5.9 % of the free million), and
  no path above 50,000 Class A in 24 hours; Class B 6 per tick × 24 ticks +
  52 per build pass × 15 builds per day.
- PS21: [deploy] FC15(b), if the owner chooses it: on Dev, 10 profile requests
  after ≥ 10 minutes idle each, for `datafusion/github:alamb`, answer under
  the chosen target at p50, read from `x-people-read: shards` responses.

### Observability

- PS22: [pending] `/health` `profileShards` has the fields of "Who builds it"
  while `PROFILE_SHARDS` is set → unit test on the field.
- PS23: [pending] every profile response with `shards@1` carries
  `x-people-read` (`shards` or `months-fallback`) → API test.
- PS24: [pending] `/health` `profileShards.lastRun.largestShardBytes` and the
  manifest's `builtAt` make a stale or oversized build visible without
  reading R2; a build older than 26 hours shows `status: "stale"` → unit test.

## Simplification review

1. **Question every requirement.**

   | Item | Who needs it, which Force | Kept? |
   | --- | --- | --- |
   | Shards | FC1, FC2, FC6 | yes |
   | Manifest with digests | FC3 (write only changed shards without reading them), FC12 | yes |
   | `kipFacts` in the manifest | FC7 (`kips` must match), FC6 | yes |
   | `bots` in the manifest | FC7 (learned bots come from every review month) | yes |
   | Months fallback in the reader | FC12; it already exists | yes, reused, no new code path |
   | `?read=months` | PS1 only | yes, Dev only, deleted with the months path's retirement |
   | Hourly cron | FC16 | yes, unless the owner accepts "next day" |
   | Per-identity counters for slice 7 | nobody yet | **deleted**; slice 7 decides |
   | `.summary.json` beside each month | nobody reads it | **deleted** in a later slice |
   | Splitting the log months (G75's first fix) | FC6 only | **deleted**: FC9, FC10 |
   | Shard count as a variable | nobody | **deleted**: fixed at 64; a change is a new revision |
   | Compression of shard bytes | FC1 is met without it | **deleted** |

2. **Delete what upstream gives.** The months path stays as the fallback, so
   no second aggregation is written: the shards path calls the same
   aggregation on fewer rows.
3. **Simplify.** One shard format for every source; the reader's
   aggregation function is shared by both paths.
4. **Shorten the cycle.** PS2 runs both paths on one constructed store in a
   unit test; PS1 runs the same comparison on Dev with one script.
5. **Automate last.** No alert. `/health` shows stale builds (PS24); the SRE
   agent (Spec 027) reads `/health` already.

## Test plan

Scope: `packages/reference-pipeline/test/profile-shards.test.ts` (to be
added; calls the shard builder and `readPersonProfile` through both paths),
`apps/web/test/people-api.test.ts` (calls the `/api/people/:project/:id`
handler with a counting bucket), `apps/data-publisher-worker/test/profile-shards-run.test.ts`
(to be added; runs the job against a failing and a counting bucket). The
case file `packages/reference-pipeline/test/fixtures/profile-shards-cases.ts`
and the generated table come with slice 1; until then every untagged item is
`[pending]`.

## Slices

1. Shard builder and the shards read path, merged off (`PROFILE_SHARDS` and
   `PEOPLE_PROFILE_READ` unset everywhere): PS2–PS16, PS17, PS18, PS22–PS24.
2. Dev enable PR: `PROFILE_SHARDS=build@1`, then `PEOPLE_PROFILE_READ=shards@1`
   after the first build; PS1, PS19–PS21; operator sequence in that PR.
3. Stop writing `.summary.json` (publisher; ships to Prod only with a tag the
   owner approves).
4. Retire the months path from profiles once PS1 has passed on 7
   consecutive days; G75 closes.

## Open decisions (owner)

- FC15: (a) the 16 MiB budget only, or (b) also a cold latency target; if (b),
  which number (proposed: W18's 500 ms at p50 on Dev).
- FC16: the freshness lag (proposed: ≤ 1 hour after a successful input run;
  after a failed build, the last good build with honest dates). The
  alternative, "next build tomorrow", saves the hourly ticks (about 144
  Class B a day) and makes a profile up to a day old.

## Non-goals

- FC10's other readers keep the month objects (person search, `/api/activity`,
  identity links, identity backfill).
- Prod enablement (`PEOPLE_PROFILES` stays unset on Prod).
- A people list (Spec 019 slice 7).
- Pruning old month objects or summaries (Spec 029 retention).
