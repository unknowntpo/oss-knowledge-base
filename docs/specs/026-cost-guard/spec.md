# Spec 026: Account-wide cost guard and circuit breaker

Status: Draft (owner decisions 2026-10-20; implemented behind `COST_GUARD`, unset in every environment; no web change)
Date: 2026-10-20
Traceability: enforced
Builds on: Spec 008 (R2 operations), Spec 010, 021 (a paused publication shows as a stall), Spec 014 (digest neuron ledger), Spec 016 (embedding ledger, query gate), Spec 018 (daily publication)

## Intent

The owner learns that the account is heading past a Cloudflare free
allowance from the Worker's `/health`, a day after it starts, not from
a billing email weeks later. When a metric is clearly past its threshold,
the optional spend (digest, embeddings, semantic queries) stops by itself
until the owner resets it; lexical search and the Feed keep working.

Today every guard is per feature: the query gate's daily caps
(`packages/semantic-vectorize/src/query-gate.ts`), the embedding job's daily
ledger, the digest's neuron ledger (`DigestRun`, Spec 014 D90–D93), AI Gateway
limits, the publication's R2 write invariant (Class A ≤ new objects + 3,
Specs 008 and 018), and Cloudflare's billing emails. Nothing reads the
account's month-to-date use, nothing stops R2 or Vectorize spend, and the
emails arrive late.

## Evidence

- 2026-10-13: 8,150 failed conditional puts an hour (each a Class A
  operation) ran for six days and cost $4.50 before a billing email showed
  it (Spec 008 "R2 operations", runbook "R2 operations and cost").
- Dev `/health`, 2026-10-19 22:18 UTC: the embedding job stores 9,764
  vectors of 1,024 dimensions, `storedDimensions` 9,998,336, which is
  99.98 % of Vectorize's 10 million included stored dimensions. No guard
  shows this today.

### Verified sources (read 2026-10-20)

| Metric | Source | Verified |
| --- | --- | --- |
| R2 Class A and B operations, month to date | GraphQL `r2OperationsAdaptiveGroups` under `viewer.accounts(filter:{accountTag})`, `sum { requests }`, `dimensions { actionType }`, filter `datetime_geq`/`datetime_leq`, at most 31 days per query ([R2 metrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)) | dataset, fields, filter, range: documented. That `actionType` values are the operation names of the [pricing page](https://developers.cloudflare.com/r2/pricing/) is **assumed** (not stated); an unknown name counts as Class A |
| R2 storage | GraphQL `r2StorageAdaptiveGroups`, `max { payloadSize metadataSize }`, `dimensions { bucketName datetime }`, `orderBy: [datetime_DESC]` (same page) | documented |
| Vectorize stored and queried dimensions | **No GraphQL dataset is documented** (no Vectorize metrics page; no `vectorize*Adaptive*` in the docs). In-app estimate: the index's `describe()` (`vectorCount × dimensions`) and the query gate's daily ledgers, with the [pricing formula](https://developers.cloudflare.com/vectorize/platform/pricing/) queried = (queries + stored vectors) × dimensions | estimate; covers this Worker's index only |
| Workers AI neurons | `aiInferenceAdaptive` is named once in a footnote of the [data-localization page](https://developers.cloudflare.com/data-localization/compatibility/) with no fields. **Not used.** In-app estimate: today's digest, embedding and query-gate ledgers (all upper bounds) | estimate; this Worker only (gardening G96) |
| Token permission | Account › Account Analytics › Read ([API token auth](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)) | documented |
| GraphQL limits | one account per query; 300 queries per 5 min per user ([limits](https://developers.cloudflare.com/analytics/graphql-api/limits/)) | documented |

### Allowances on Workers Paid

| Metric | Included | Over it | Source |
| --- | --- | --- | --- |
| R2 Class A | 1 million / month | $4.50 / million | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| R2 Class B | 10 million / month | $0.36 / million | same |
| R2 storage (Standard) | 10 GB-month | $0.015 / GB-month | same |
| Vectorize queried dimensions | 50 million / month | $0.01 / million | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) |
| Vectorize stored dimensions | 10 million | $0.05 / 100 million | same |
| Workers AI | 10,000 neurons / day (resets 00:00 UTC) | $0.011 / 1,000 neurons | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |

The guard uses 10 GB = 10 × 10⁹ bytes (the smaller reading of GB).

## Example

Dev `/health`, 2026-10-20 03:08 UTC (real): last publication `r2 {classA: 794,
classB: 8590}`; `digest.today.estimatedNeurons` 0; `searchEmbedding.today
.estimatedNeurons` 0 (46 on 10-19); `searchQuery.today.indexQueries` 12;
`searchEmbedding.lastRun.storedVectors` 9,764 at 1,024 dimensions.

A check at 2026-10-20 22:07 UTC (19 d 22 h 7 min of 31 d: 64.3 % of the
month; 92.2 % of the day). R2 numbers are estimates from the daily runs
until the token exists (Dev monitor step captures the real ones):

| Metric | Value | Allowance | % | Projected % | Status |
| --- | --- | --- | --- | --- | --- |
| `r2ClassA` | ≈ 16,000 (20 × 794) | 1,000,000 | 1.6 | 2.48 | ok |
| `r2ClassB` | ≈ 172,000 (20 × 8,590) | 10,000,000 | 1.72 | 2.67 | ok |
| `vectorizeStoredDimensions` | 9,998,336 | 10,000,000 | 99.98 | — | warn (does not trip, Behavior 6) |
| `vectorizeQueriedDimensions` | (240 + 9,764) × 1,024 = 10,244,096 | 50,000,000 | 20.48 | 31.88 | ok |
| `workersAiNeurons` (today) | 0 | 10,000 | 0 | 0 | ok |

`costGuard.status` is `warn` (the stored dimensions) and the breaker stays
closed.

## Simplification review

1. **Question every requirement.**
   - Account-wide R2 numbers: the owner; the 10-13 incident was visible only
     account-wide (billing). Both environments share one account, so either
     Worker sees both buckets.
   - Vectorize and neurons: the owner listed them; no account-wide source
     exists (above), so they are estimates from ledgers this Worker already
     keeps, labelled `scope: "worker"`.
   - A breaker, not only a warning: the owner; an alert alone did not stop
     the incident for six days.
   - Manual reset only: the owner; an automatic reset would re-open into the
     same fault.
   - Dry run: the operator, to see the numbers before enabling `enforce`.

2. **Delete.**
   - A new cron: the check rides the publication tick (Dev 22:07, Prod 22:37).
   - An R2 state object: the breaker and the last check live in Durable
     Object storage; the guard adds **no** R2 operation.
   - `aiInferenceAdaptive` and any guessed Vectorize dataset: unverifiable
     fields would be a guess in production code.
   - A breaker per metric: one breaker; it remembers every metric that
     tripped while it was open.
   - Config vars per threshold: one const profile in code; changing it is a PR.
   - Any web change (owner, 2026-10-20). No visitor flow needs the breaker
     state: a paused publication already shows through the freshness pill
     (Specs 010, 021), a digest that did not run shows "Digest updated X
     ago", and the fallback from semantic to lexical search is invisible to
     readers. The state lives only in the Worker's `/health.costGuard`, for
     the owner and a future SRE agent. (A first draft added
     `GET /api/cost-guard` and a top-bar notice; withdrawn with CG12.)
   - Re-enforcing the publication's Class A invariant at runtime: it is
     already tested (Specs 008, 018); the guard pauses the publication only
     when R2 Class A itself trips (Behavior 9).
3. **Simplify.** Pure functions for the window, threshold math and breaker
   transition; the Durable Object only stores and fetches.
4. **Shorten the cycle.** The threshold boundaries are a generated table;
   GraphQL parsing runs on fixtures; no test calls the network.
5. **Automate last.** Nothing added beyond the daily check.

## Behavior

1. `COST_GUARD` unset, blank or `off`: nothing runs, nothing is read, no
   feature asks the guard, `/health` has no `costGuard` key, and the cost
   routes answer 403 `{ok:false, disabled:true}`. `monitor` checks and
   records; `enforce` also makes guarded features refuse while the breaker
   is open. Any other value is `unconfigured` (no check, nothing refused).
2. A check needs the Worker secret `CF_ANALYTICS_TOKEN`, the var
   `CF_ACCOUNT_ID` and the Durable Object binding `COST_GUARD_STATE`
   (class `CostGuard`). If one is missing the status is `unconfigured`
   with a `reason` that names what is missing (never a value), and the check
   makes no request and writes nothing.
3. The check runs on each publisher cron tick (`waitUntil`, after scheduling
   the publication, also when the publication is paused) and on
   `POST /cost-guard/check` (bearer `MANUAL_TRIGGER_TOKEN`). One GraphQL
   request reads R2 operations from the first instant of the UTC month to
   now (31 days at most by construction) and R2 storage over the last two
   days (newest row per bucket, `payloadSize + metadataSize`, summed). The
   token is sent only in the `Authorization` header.
4. In-app estimates: neurons today = digest `today.estimatedNeurons` +
   embedding `today.estimatedNeurons` + query gate `today.neurons` (each 0
   when its object is not bound; the metric is unavailable without the `AI`
   binding). Vectorize (only with `SEARCH_VECTORS`): stored =
   `vectorCount × dimensions`; queried = (month-to-date gate index queries +
   `vectorCount`) × `dimensions`.
5. Per metric: `percent = value / allowance × 100`. A counter (R2
   operations, queried dimensions, neurons) also has `projectedPercent =
   percent / elapsed`, where `elapsed` is the fraction of its period (UTC
   month or UTC day) that has passed, but only once `elapsed ≥ 0.25`;
   before that, and for gauges (storage, stored dimensions), it is null.
   Displayed percents are floored to 0.01; comparisons use the exact values.
6. Status per metric: `tripped` when `percent ≥ 80` or `projectedPercent >
   100`; else `warn` when `percent ≥ 60`; else `ok`; `unavailable` when the
   value could not be read. Vectorize stored dimensions never trip (its
   overage is $0.05 per 100 million dimensions; the Example shows it at
   99.98 % today): at or above 60 % it is `warn`.
7. Breaker: closed `{tripped:false}`. A real check (not a dry run) that finds
   a tripped metric while closed opens it with `{tripped:true, reason,
   metric, value, threshold, trippedAt, metrics}` from the metric with the
   highest percent; `threshold` is the value at which it tripped (80 % of
   the allowance, or the allowance for a projection). While open, a later
   check adds newly tripped metrics to `metrics` and changes nothing else. It
   opens in `monitor` too, so `/health` shows what `enforce` would do.
8. The breaker closes only on `POST /cost-guard/reset` with the bearer
   token; never by a check, a new month, or a deploy. The reset is recorded
   (`lastResetAt`). A reset while a metric is still over its threshold is
   reopened by the next check.
9. While `enforce` and the breaker is open:
   - the digest refuses `POST /digest/run` (dry run too) with 503
     `{ok:false, skipped:"cost-guard"}` and its alarm runs nothing;
   - the embedding job refuses every request but `reset=1` with the same
     503 (a reset clears its state and schedules nothing), and its alarm
     (including continuations) runs nothing;
   - the query gate answers `{status:"over-budget", retryAfterMs:3600000}`
     without touching its ledger, the model or the index, so `/api/search`
     answers lexically (Spec 016's over-budget path);
   - the publication, the GitHub review ingestion and the Feed keep running
     under their own limits, **unless `metrics` includes `r2ClassA`**: then
     `POST /run` answers 503 `{ok:false, skipped:"cost-guard"}`, the
     publication alarm runs nothing, and the tick skips the review ingestion.
     The stall shows on the page through Specs 010/021. Reason: the only
     Class A incident came from the publication's writes; a Class A trip at
     800,000 means something writes far beyond the ≈ 24,000 a month the
     tested invariant allows, and pausing every R2 writer bounds it.
10. If the guard object cannot be read, features proceed (fail open): the
    per-feature caps still bound each one, and the guard must not become a
    single point of failure for search.
11. `POST /cost-guard/check?dryRun=1` evaluates now and returns the result
    without writing state or opening the breaker.
12. A failed GraphQL request (HTTP error, `errors[]`, malformed body) leaves
    the R2 metrics `unavailable`, records `lastError {message, at}`
    (sanitized; the next successful real check sets it back to null), keeps the in-app metrics, and never opens the breaker on
    missing data. Each real check is one Durable Object write.
13. `/health` `costGuard` (only while `COST_GUARD` is set):
    `{mode, status, reason, checkedAt, metrics, breaker, lastResetAt,
    lastError}`. `status` is `tripped` if the breaker is open, else
    `unconfigured` if a requirement is missing, else `pending` before the
    first check, else the worst metric status (`warn` or `ok`; `unavailable`
    counts as ok). `metrics[key]` is `{value, allowance, percent,
    projectedPercent, period, scope, source, status}`.
14. No log line, `/health` field, stored state or response contains the
    token. Every error text passes the existing sanitizer.

## Test plan

Generated from `apps/data-publisher-worker/test/cost-guard.cases.ts` by
`bun run docs:test-plan`; the unit tests run exactly these rows.

<!-- test-plan:start apps/data-publisher-worker/test/cost-guard.cases.ts -->
| id | case | metric | value | now | percent | projectedPercent | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CG2 | R2 Class A just under warn, month end | r2ClassA | 599999 | 2026-10-31T22:07:00Z | 59.99 | 60.15 | ok |
| CG2 | R2 Class A at 60 %: warn | r2ClassA | 600000 | 2026-10-31T22:07:00Z | 60 | 60.15 | warn |
| CG2 | R2 Class A just under 80 % | r2ClassA | 799999 | 2026-10-31T22:07:00Z | 79.99 | 80.2 | warn |
| CG2 | R2 Class A at 80 %: trip | r2ClassA | 800000 | 2026-10-31T22:07:00Z | 80 | 80.2 | tripped |
| CG2 | one second before a quarter of the month: no projection | r2ClassA | 300000 | 2026-10-08T17:59:59Z | 30 | — | ok |
| CG2 | a quarter of the month: projected 120 % trips | r2ClassA | 300000 | 2026-10-08T18:00:00Z | 30 | 120 | tripped |
| CG2 | projected exactly 100 %: not over | r2ClassA | 250000 | 2026-10-08T18:00:00Z | 25 | 100 | ok |
| CG2 | projected just over 100 % (shown floored) | r2ClassA | 250001 | 2026-10-08T18:00:00Z | 25 | 100 | tripped |
| CG2 | February has 28 days | r2ClassA | 400000 | 2026-02-15T00:00:00Z | 40 | 80 | ok |
| CG2 | R2 Class B at 60 % | r2ClassB | 6000000 | 2026-10-31T22:07:00Z | 60 | 60.15 | warn |
| CG2 | R2 storage just under 80 %: a gauge has no projection | r2StorageBytes | 7999999999 | 2026-10-20T22:07:00Z | 79.99 | — | warn |
| CG2 | R2 storage at 8 GB: trip | r2StorageBytes | 8000000000 | 2026-10-20T22:07:00Z | 80 | — | tripped |
| CG2 | Vectorize stored dimensions today (Example): warn, never trips | vectorizeStoredDimensions | 9998336 | 2026-10-20T22:07:00Z | 99.98 | — | warn |
| CG2 | Vectorize stored dimensions under 60 % | vectorizeStoredDimensions | 5999999 | 2026-10-20T22:07:00Z | 59.99 | — | ok |
| CG2 | Vectorize queried dimensions (Example) | vectorizeQueriedDimensions | 10244096 | 2026-10-20T22:07:00Z | 20.48 | 31.88 | ok |
| CG2 | neurons today just under warn at the Dev tick | workersAiNeurons | 5999 | 2026-10-20T22:07:00Z | 59.99 | 65.09 | ok |
| CG2 | neurons today at 60 % | workersAiNeurons | 6000 | 2026-10-20T22:07:00Z | 60 | 65.1 | warn |
| CG2 | neurons today just under 80 % | workersAiNeurons | 7999 | 2026-10-20T22:07:00Z | 79.99 | 86.8 | warn |
| CG2 | neurons today at 80 %: trip | workersAiNeurons | 8000 | 2026-10-20T22:07:00Z | 80 | 86.81 | tripped |
| CG2 | neurons one second before a quarter of the day: no projection | workersAiNeurons | 5000 | 2026-10-20T05:59:59Z | 50 | — | ok |
| CG2 | neurons at a quarter of the day: projected 200 % trips | workersAiNeurons | 5000 | 2026-10-20T06:00:00Z | 50 | 200 | tripped |
| CG2 | a value that could not be read | r2ClassA | — | 2026-10-20T22:07:00Z | — | — | unavailable |
<!-- test-plan:end -->


## Acceptance

Each item: precondition → action → observable result → evidence.

### Behavior
- CG1: given `COST_GUARD` unset, blank, `off`, `monitor`, `enforce` or `on`, resolving it gives off, off, off, monitor, enforce, invalid; while off a publisher tick makes only the publication call, `/health` has no `costGuard` key, and `POST /cost-guard/check` and `/cost-guard/reset` answer 403 → worker test.
- CG2: given the threshold rows, `evaluateMetric` gives the percent, projected percent and status of each row (60 % warn, 80 % trip, projection over 100 % only from a quarter of the period, gauges never projected, stored dimensions never trip) → case rows.
- CG3: given the recorded-shape GraphQL fixture, parsing gives Class A, Class B (free operations excluded, unknown action types counted as Class A and listed) and storage as the newest row per bucket summed → fixture test.
- CG4: the request is one POST to `https://api.cloudflare.com/client/v4/graphql` with `Authorization: Bearer <token>`, the account tag, the month start and now; no test calls the network → fixture test.
- CG5: given a closed breaker and a check with a tripped metric, the breaker opens with `reason, metric, value, threshold, trippedAt, metrics`; a later check adds newly tripped metrics and keeps the rest; a check with no tripped metric leaves it open → breaker test.
- CG6: given an open breaker, `POST /cost-guard/reset` with the token closes it and records `lastResetAt`; without the token it answers 401 and the breaker stays open → route test.
- CG7: given `enforce` and an open breaker, the digest's request and alarm, the embedding job's request (not `reset=1`) and alarm, and the query gate refuse as Behavior 9 says, each with no model, index or bucket call; given `monitor` and the same breaker, each runs → feature tests with positive controls.
- CG8: given `enforce` and an open breaker whose `metrics` include `r2ClassA`, `POST /run` answers 503 and the publication alarm runs nothing, and the tick skips the review ingestion; with only `vectorizeQueriedDimensions` in `metrics`, the publication runs → route and alarm tests.
- CG9: given in-app ledgers (digest 120, embedding 46, gate 3 neurons today; index 9,764 vectors of 1,024 dimensions; 240 index queries this month), the check reports 169 neurons, 9,998,336 stored and 10,244,096 queried dimensions; without the `AI` binding the neuron metric is unavailable, without `SEARCH_VECTORS` both Vectorize metrics are → check test.
- CG10: `POST /cost-guard/check?dryRun=1` returns the evaluation and writes nothing, also when a metric is tripped → route test.
- CG11: `/health` `costGuard` has the shape of Behavior 13 for `pending`, `ok`, `warn`, `tripped` and `unconfigured` → health test.

CG12 (a page notice from `GET /api/cost-guard`) is withdrawn: the owner
removed the web part on 2026-10-20 (Simplification review, Delete).

### Failure and retry
- CG13: given `monitor` and a missing token, account id or binding, the check returns `unconfigured` with a reason naming the missing item, makes no fetch and writes nothing → check test.
- CG14: given a GraphQL HTTP 500, a body with `errors[]`, or a malformed body, the R2 metrics are `unavailable`, `lastError` is set, in-app metrics are kept and the breaker stays closed; a later successful check clears `lastError` → check test.
- CG15: given the guard object throwing or answering 500 under `enforce`, the digest, embedding and query gate proceed (fail open) → feature test.
- CG16: given a token value, no console output, stored state, `/health` body or check response of a successful or failing check contains it → log test.
- CG17: given a metric over its threshold after a reset, the next real check opens the breaker again; a new month does not close it → breaker test.

### Budget
- CG18: [measure] a real check is one GraphQL request (well under 300 per 5 min), three Durable Object status reads, one `describe()`, one gate month read and one Durable Object write; no R2 operation; measured by `bun test test/cost-guard.test.ts -t CG18` (in `apps/data-publisher-worker`), which counts the calls.

### Observability
- CG19: [deploy] on Dev with `COST_GUARD=monitor` and the token set, `POST /cost-guard/check?dryRun=1` returns R2 numbers within 5 % of the dashboard's month-to-date operations, and the real GraphQL response is saved as a fixture that replaces the documented-shape one (G96).
- CG20: [deploy] after the first daily tick, `/health` `costGuard.checkedAt` is that tick's time, and the web app has no request or element for the cost guard.

## Decisions (confirmed by the owner, 2026-10-20)

The owner decided to build the guard and, on reviewing #105, confirmed the
four choices below and removed the web part (Simplification review).

1. **Vectorize stored dimensions warn and never trip** (Behavior 6). Dev is
   already at 99.98 % of the 10 million included, and the overage is $0.05 per
   100 million dimensions, so tripping would turn off semantic search for a
   cost of fractions of a cent. Alternative: trip at 80 % like the others.
2. **Publication pauses only on an R2 Class A trip** (Behavior 9). It is the
   core product and its Class A is bounded by a tested invariant (≈ 24,000 a
   month); a Class A trip at 800,000 means something writes far beyond that,
   and the only Class A incident came from the publication. Alternatives:
   never pause it, or pause it on any trip.
3. **Fail open** (Behavior 10). When the guard object cannot answer, every
   feature proceeds under its own caps, so the guard is not a single point of
   failure for search. Alternative: fail closed, which stops semantic search
   and the digest whenever the object is unavailable.
4. **A separate `CostGuard` Durable Object, not `PipelineState`.** The query
   gate asks for a decision on every semantic query; `PipelineState` runs
   the publication for minutes of CPU (`cpu_ms` 300,000), and a request to it
   waits while that work holds the object. The check must also run while the
   publication is stuck or paused, since the Class A incident came from the
   publication. Cost: one new class and migration per environment (in the
   enable PRs). Alternative: keep the breaker in `PipelineState` storage, with
   no migration and the query path behind the publication.

## Rollout

This PR: `COST_GUARD` unset on Dev and Prod; no binding, no secret, no
migration. Owner creates the token after review.

1. **Dev monitor** (PR): add the `CostGuard` class migration (`v5`) and the
   `COST_GUARD_STATE` binding on the Worker, `CF_ACCOUNT_ID`,
   `COST_GUARD=monitor`. Put the secret, run the dry check (CG19), watch one week of daily checks.
2. **Dev enforce** (PR): `COST_GUARD=enforce` after `/health` shows the
   breaker closed; check that a forced trip (reset afterwards) refuses as CG7.
3. **Prod** (release): same as 1, then 2, with migration `v3` and the
   Prod secret. On Prod the neuron and Vectorize metrics are unavailable
   (no `AI`, no index); R2 is account-wide and therefore covered by either.

Stop and roll back (`COST_GUARD` unset) if the check errors on two
consecutive days or the breaker opens on a metric the dashboard does not
confirm.

## Non-goals

- Push alerts (owner's rule: the UI shows it).
- Account-wide Vectorize and Workers AI numbers (no documented dataset;
  gardening G96 tracks verifying `aiInferenceAdaptive` by introspection).
- Workers requests, Durable Object, Pages Functions or AI Gateway billing.
- Thresholds as runtime config.
- Stopping spend inside a running digest or embedding batch: refusal starts
  at the next request or alarm; their own ledgers bound a running one.
