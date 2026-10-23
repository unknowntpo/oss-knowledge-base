# Spec 026: Account-wide cost guard and circuit breaker

Status: Partially implemented: CG1–CG20 implemented (#105, 2026-10-20; owner decisions 2026-10-20; no web change); rollout step 1 (Dev monitor: `COST_GUARD=monitor`, `COST_GUARD_STATE`, migration `v5`, `CF_ACCOUNT_ID`) in the Dev monitor enable PR, 2026-10-21; CG19 waits for the first successful check; `COST_GUARD` unset on Prod; amended 2026-10-21 (owner decisions: a $5-a-month dollar budget; its open decisions resolved the same day: 7-day projection, own-bucket spike, UTC month, provisional spike threshold, warn on projection); CG21 and CG35 implemented (owner decision 2026-10-23: the per-metric projection uses the 7-day rate now, before the budget; dollars per metric in `/health`; no spike), CG22–CG34, CG36, CG37 not implemented
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

## Amendment 2026-10-21: an owner-approved dollar budget

Owner decision, 2026-10-21 (core: cost). The account is on Workers Paid
($5 a month fixed). On top of that, the owner approves **$5 a month** of
usage-based overage across every metric the guard reads. The guard stops
judging each metric against a percentage of its free allowance; it prices
each metric's use beyond its allowance at list price (table above), sums the
dollars, and judges the sum against the budget. One metric keeps a trip of
its own: R2 Class A, because an incident burns it fastest (2026-10-13:
8,150 an hour, about 196,000 a day).

Cloudflare offers no hard spending cap; its budget alerts only send email
(the account has $0.01, $5 and $10 alerts). The stops are this guard and
the Dev AI Gateway limit of $2 per 30 days.

Until the implementing slice lands, Behavior 1–14 below describe what runs;
the items they replace are marked "(amended)". The slice folds this section
into them, regenerates the tables and removes the `[pending]` tags.

### Example (dollars, real October, 2026-10-21 02:04 UTC)

The R2 counts are the Dev guard's dry run of 2026-10-21 (02:04 UTC), the
account's `r2OperationsAdaptiveGroups` by day and bucket. 20 d 2 h 4 min of
31 d have passed; 10 d 21 h 56 min (10.9139 days) remain. Storage is still
an estimate (the dry run did not read it).

| Metric | Month to date | Included | Overage now | Rate (7 complete days, 10-14..20) | Projected month end |
| --- | --- | --- | --- | --- | --- |
| R2 Class A (account) | 2,062,716 | 1,000,000 | $4.7822 | 33,676 (4,811 a day) | $5.0184 (2,115,221) |
| R2 Class B (account) | 269,830 | 10,000,000 | $0 | 218,882 | $0 (0.61 M) |
| R2 storage (gauge) | 13.9 GB (Dev 13.37 GB, pending Spec 029 retention, #111) | 10 GB-month | $0.0585 | — | $0.0585 |
| Vectorize stored dimensions (gauge) | 9,939 × 1,024 = 10,177,536 | 10,000,000 | $0.0000888 (shown $0.0000) | — | $0.0000888 |
| Vectorize queried dimensions | (≈ 250 + 9,939) × 1,024 = 10,433,536 | 50,000,000 | $0 | no per-day history yet | $0 |
| Workers AI neurons (today) | 3 | 10,000 / day | $0 | — | $0 |
| **Sum** | | | **$4.8408 (96.81 % of $5)** | | **$5.0770 (101.54 %)** |

October's Class A came almost entirely from the incident: Dev's bucket
wrote 97,970 to 204,728 Class A a day from 10-02 to 10-12 and 82,310 on
10-13 (1,991,719 of the account's 2,062,716); since 10-14 the account runs
at 3,000 to 4,000 a day (12,670 on 10-19, Prod's first publications).

`costGuard.budget.status` is `tripped`: the money already spent, $4.84, is
over the $4 trip on its own. The projection does not cause it: the quiet
last week adds $0.24 to the month. The month-to-date projection of the
original amendment would have projected 3.18 million Class A ($9.83 for Class A alone).
The 7-day rate does what Decision 9 asks of it for the future: the same
week after a smaller burst (1.23 million by 10-21) projects $1.25 for Class
A and leaves the budget `ok` (CG35, CG22 rows), where the month-to-date
projection gave $3.70. No projection rule can un-spend October's $4.78; see
Open owner decision 1.

24-hour Class A per guard (Decision 10; the real 10-20 UTC day): Dev guard
`oss-knowledge-base-dev` 976, Prod guard `oss-knowledge-base-prod` 359,
against a spike threshold of 50,000 (provisional, Decision 12). Neither
spikes.

Under the old per-metric rules storage would also trip (13.9 GB is 139 %
of 10 GB, over the 80 % trip) and stored dimensions warn; now storage costs
about $0.06 a month and stored dimensions less than $0.0001, and neither
trips on its own. Storage alone would trip the budget at 10 + 4 / 0.015 ≈
277 GB.

### Simplification review

1. **Question every requirement.**
   - A dollar budget: the owner; a percentage of a free allowance says
     nothing about the bill once a metric is past it (storage has been since
     before the guard existed), and a few cents of Vectorize overage should
     never stop search.
   - A separate Class A trip: the owner; at 196,000 a day an incident burns
     $0.88 a day once past the allowance, and the dollar sum reacts only after
     dollars are spent.
   - Counting only the guard's own bucket for that trip: the owner; another
     project or the other environment must not pause this one, and the
     writer that causes an incident is the one to stop. Dollars stay
     account-wide, because that is what is billed.
   - A 7-day rate for the projection: the owner; a month-to-date average
     carries a burst that has stopped into every later day of the month.
2. **Delete.**
   - The per-metric 60 % / 80 % thresholds and Behavior 6's stored-dimension
     exception: one budget replaces them, and the exception has nothing left
     to except.
   - The per-metric `warn` and `tripped` statuses: a metric is `ok` or
     `unavailable`; its `overageUsd` says what it costs.
   - The monthly Class A trip at 800,000: the 24-hour spike rule catches an
     incident faster, and a slow leak is a cost question the budget answers.
   - The quarter-of-the-month wait before any projection: the 7-day rate
     reads days before the month began, so it projects from the 1st.
   - Month-to-date storage history: the guard reads today's bytes and treats
     them as the month's average (Behavior 5a). Storage would need to grow by
     hundreds of GB for the error to matter.
   - Neuron history: a month-to-date neuron sum needs a ledger per day; the
     projection uses today's rate instead (Behavior 5a). This Worker's
     neuron caps sum to 10,000 a day (digest 5,000, embedding 2,500, queries
     1,000, and since Spec 027 slice 2 the sre-agent 1,500), the 10,000
     included, so its neurons never bill.
3. **Simplify.** One pure function prices a metric, one sums and judges the
   budget, one judges the spike; the breaker and refusals are unchanged.
4. **Shorten the cycle.** The prices and the budget boundaries are two
   generated tables; the bucket filter is a fixture row.
5. **Automate last.** No new cron, route, binding, variable or request: the
   7-day and 24-hour reads ride the existing GraphQL request as aliased
   selections, and the bucket follows from `PUBLICATION_ENVIRONMENT`.

### Behavior (amended)

These replace Behavior 5, 6 and 13, the trip condition of Behavior 7 and the
publication trigger of Behavior 9.

- 3a. The one GraphQL request adds two aliased `r2OperationsAdaptiveGroups`
  selections: the account's operations by `date` over the 7 complete UTC
  days before today (for the rate, Behavior 5a), and the last 24 hours with
  `bucketName` the guard's own bucket: `oss-knowledge-base-dev` when
  `PUBLICATION_ENVIRONMENT` is `development`, `oss-knowledge-base-prod` when
  it is `production` (the `OSS_KB_BUCKET` binding's `bucket_name` in each
  wrangler file). `r2OperationsAdaptiveGroups` and `r2StorageAdaptiveGroups`
  both accept the `bucketName` dimension (verified 2026-10-21), and the two
  new selections span at most 7 days, within the account's 32-day limit.
  Month-to-date operations and storage stay account-wide.
- 5a. Dollars per metric: `overageUsd = max(0, value − included) × price`
  (table above; stored dimensions at $0.05 per 100 million). Projected
  month-end value:
  - a counter (R2 Class A and B, queried dimensions): `value + rate ×
    remainingDays`, where `remainingDays` is the time from now to the end
    of the UTC month in days and `rate` is the counter's sum over the 7
    complete UTC days before today divided by 7 (owner, Decision 9). The
    window may reach into the previous month; it never includes today.
    When the source holds fewer than 7 complete days, the rate is the sum
    over the complete days it holds divided by their number; with none, the
    projection is `value`. R2 always has 7 (the GraphQL dataset keeps more
    than a month). The query gate's ledger holds one count a month today;
    the implementing slice adds a count per UTC day kept for 8 days, so
    queried dimensions start with no history and gain a day a day. Their
    rate counts index queries only: the stored vectors enter the formula
    once a month;
  - a gauge (storage, stored dimensions) projects as its current value;
  - neurons project today's overage, at `value / elapsedDay` from a quarter
    of the day (before that, today's value), times the days of the month.
  `projectedOverageUsd` prices the projected value. Storage is billed in
  GB-month, the average over the month; the guard approximates it by the
  newest reading (Behavior 3), an upper bound while storage grows and a
  lower bound after a deletion such as Spec 029's retention. Neurons now
  are only today's overage, a lower bound for the month. Every metric has a
  projection from the first check of the month.
- 6a. Budget: `overageUsd` and `projectedOverageUsd` are the sums over the
  metrics that could be read (an unavailable one counts $0 and is listed in
  `missing`); `percent` and `projectedPercent` are those over $5 × 100,
  floored to 0.01 for display. Budget status: `tripped` when `percent ≥ 80`
  or `projectedPercent > 100`; else `warn` when `percent ≥ 60` or
  `projectedPercent ≥ 60` (Decision 13: a projection warns, it never trips
  below 100 %); else `ok`. `warn` shows only in `/health` and the UI's
  existing stall surfaces; it opens nothing.
- 6b. Class A spike: `tripped` when the guard's own bucket (Behavior 3a)
  has 50,000 or more Class A over the last 24 hours, whatever the dollars;
  `unavailable` when the request failed. Another bucket, including the
  other environment's, never trips it. Normal: under 1,000 a day on Dev,
  a few hundred on Prod (Example); a backfill adds at most about 300; the
  incident ran at 196,000. The 50,000 is provisional (Decision 12, CG37).
- 7a. The breaker opens on a budget trip with `metric: "budget"`, `value` the
  dollars that tripped (overage now, or the projection), `threshold` $4 or
  $5, and `overageUsd` per metric at that moment; on a spike trip with
  `metric: "r2ClassA"`, `value` the 24-hour count, `threshold` 50,000 and
  `bucket`. `metrics` holds `budget`, `r2ClassA`, or both. Everything else
  in Behavior 7 and 8 stays: a later check adds a newly tripped key; only a
  reset closes it; a reset while still over reopens on the next check. A
  new month starts the dollar sums from zero but does not close the
  breaker.
- 9a. What a trip pauses is unchanged: any trip makes the digest, the
  embedding job and the query gate refuse (Behavior 9); the publication and
  the review ingestion pause only when `metrics` includes `r2ClassA`, now the
  spike of the guard's own bucket, so an incident pauses only the
  environment that wrote it. A budget trip does not pause the publication:
  its Class A is bounded by the tested invariant, and R2 reads from Pages
  (`/api/*`) are not paused by any trip (the Feed keeps working). A budget
  driven by Class B or storage therefore stops only the optional spend;
  `overageUsd` per metric shows the owner where to act.
- 13a. `/health` `costGuard`: `{mode, status, reason, checkedAt, budget
  {limitUsd, overageUsd, projectedOverageUsd, percent, projectedPercent,
  status, missing[]}, r2ClassASpike {last24h, threshold, bucket, status},
  metrics, breaker, lastResetAt, lastError}`. `metrics[key]` is `{value,
  included, overageUsd, projectedOverageUsd, rateDays, period, scope,
  source, status (ok|unavailable)}`, where `rateDays` is the number of
  complete days the rate used (0–7; null for gauges and neurons). `status`
  is `tripped` if the breaker is open, else `unconfigured`, else `pending`,
  else the budget status.

### Billing period

The guard sums from 00:00 UTC on the 1st to the end of the UTC calendar
month (Decision 11). The account's invoice cycle starts about the 7th, so
the guard's month and an invoice overlap for about three weeks and the sums
differ from the invoice. The budget's margin absorbs that: the trip on
money spent is at $4, a dollar under the $5, and a burst that lands in two
calendar months is still caught by the spike rule within a day.

### Decisions (owner, 2026-10-21)

5. **A $5-a-month overage budget, not per-metric percentages.** Thresholds
   60 % warn, 80 % trip, projected over 100 % trips, as before but over
   dollars. Replaces Decision 1. Alternative: keep percentages and exempt
   each metric already past its allowance (storage, stored dimensions).
6. **R2 Class A keeps its own trip: 50,000 or more in the last 24 hours on
   the guard's own bucket.** Chosen over keeping the 80 %-of-1-million
   monthly trip because it fires on the first daily check after an incident
   starts, whatever the day of the month (the monthly trip had no
   projection for the first 7.75 days and needed four incident days to
   reach 800,000), and its threshold sits about 50 times above a normal Dev
   day and four times below the incident rate. A leak under 50,000 a day
   (at most about $2.5 a month beyond the allowance) is left to the
   budget.
7. **Dollars account-wide, the spike per bucket.** The bill is account-wide,
   so the budget is; another project's writes must not pause this one
   (refined by Decision 10).
8. **Storage and stored dimensions count only through dollars.**

Resolutions of the amendment's open decisions, approved by the owner on
2026-10-21:

9. **Project from the last 7 days.** Projected = money already spent this
   month + the last-7-complete-days average rate × the remaining days
   (Behavior 5a), not month to date divided by the elapsed fraction, so a
   burst that has stopped does not keep projecting over the budget for the
   rest of the month. With fewer than 7 complete days of history the rate
   uses the days there are; with none, the projection is the money spent.
   Alternatives: accept the month-to-date projection; enable `enforce` on
   Dev only from November 1.
10. **The spike counts only the guard's own environment bucket.** Dev's
    guard reads `oss-knowledge-base-dev`, Prod's `oss-knowledge-base-prod`,
    so an incident pauses only the environment that caused it. Dollars stay
    account-wide. Alternative (the original amendment): both OSS KB
    buckets, which made Dev pause on a Prod incident it cannot stop.
11. **The UTC calendar month.** Kept although the invoice cycle starts about
    the 7th; the budget's margin absorbs the difference (Billing period).
12. **50,000 Class A in 24 hours is provisional.** Set from the 10-19 and
    10-20 publications (Dev 748 and 976, Prod 9,300 on its first day and
    359 after); the first real per-bucket check confirms it before
    `enforce` (CG37).
13. **Warn on projection.** The budget warns, in `/health` and the UI only
    and without tripping, once the projected month-end overage reaches 60 %
    of the budget ($3), as well as once the money spent does.

### Open owner decisions

1. **October is already spent.** With the real counts, October's overage is
   $4.84 (96.81 %) on 2026-10-21, almost all the 10-02..13 incident's R2
   Class A, so the budget is `tripped` by money already spent, whatever the
   projection rule (Example). Under `monitor` nothing pauses, but a real
   check opens the breaker, and an open breaker stays open across November
   1 until a reset (Behavior 7a). Options: reset the breaker on November 1
   before Dev `enforce`; or enable `enforce` on Dev only from November 1
   (the implementing slice is not yet built, so it may land after then).

### Rollout

Unchanged steps (Rollout below). The implementing slice ships under the
current `COST_GUARD=monitor` on Dev (no new binding, secret, variable or
migration); its dry check (CG33) comes before Dev `enforce`. The runbook's
cost-guard section is updated in that slice.

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
   now (31 days at most by construction), the same operations over the 7
   complete UTC days before today (an aliased selection for the rate of
   Behavior 5; CG35), and R2 storage over the last two
   days (newest row per bucket, `payloadSize + metadataSize`, summed). The
   token is sent only in the `Authorization` header.
4. In-app estimates: neurons today = digest `today.estimatedNeurons` +
   embedding `today.estimatedNeurons` + query gate `today.neurons` (each 0
   when its object is not bound; the metric is unavailable without the `AI`
   binding) + the Spec 027 `sre-agent` job's `today.neurons` from
   `internal/sre/v1/<env>/state.json` (0 with no read while `SRE_AGENT` is
   off, and for a ledger of another UTC day; Spec 027 B31, SRE62). Vectorize (only with `SEARCH_VECTORS`): stored =
   `vectorCount × dimensions`; queried = (month-to-date gate index queries +
   `vectorCount`) × `dimensions`.
5. (amended: 5a) Per metric: `percent = value / allowance × 100`. A month
   counter (R2 operations, queried dimensions) has `projectedPercent` = its
   projected month-end value of Behavior 5a (`value + rate ×
   remainingDays`, the rate over the 7 complete UTC days before today;
   owner decision 2026-10-23, CG35) over the allowance, from the 1st of the
   month; `rateDays` says how many days the rate used (R2: 7; queried
   dimensions: 0 until the gate's per-day read lands, gardening G101, so
   they project as month to date). Neurons have `projectedPercent =
   percent / elapsed`, where `elapsed` is the fraction of the UTC day that
   has passed, but only once `elapsed ≥ 0.25`; before that, and for gauges
   (storage, stored dimensions), it is null. Each metric also carries
   `overageUsd` and `projectedOverageUsd` (Behavior 5a, CG21); they inform
   and trip nothing until the budget (CG22) lands.
   Displayed percents are floored to 0.01; comparisons use the exact values.
6. (amended: 6a, 6b) Status per metric: `tripped` when `percent ≥ 80` or `projectedPercent >
   100`; else `warn` when `percent ≥ 60`; else `ok`; `unavailable` when the
   value could not be read. Vectorize stored dimensions never trip (its
   overage is $0.05 per 100 million dimensions; the Example shows it at
   99.98 % today): at or above 60 % it is `warn`.
7. (trip condition amended: 7a) Breaker: closed `{tripped:false}`. A real check (not a dry run) that finds
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
   - (trigger amended: 9a) the publication, the GitHub review ingestion and the Feed keep running
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
13. (amended: 13a) `/health` `costGuard` (only while `COST_GUARD` is set):
    `{mode, status, reason, checkedAt, metrics, breaker, lastResetAt,
    lastError}`. `status` is `tripped` if the breaker is open, else
    `unconfigured` if a requirement is missing, else `pending` before the
    first check, else the worst metric status (`warn` or `ok`; `unavailable`
    counts as ok). `metrics[key]` is `{value, allowance, percent,
    projectedPercent, overageUsd, projectedOverageUsd, rateDays, period,
    scope, source, status}`.
14. No log line, `/health` field, stored state or response contains the
    token. Every error text passes the existing sanitizer.

## Test plan

Generated from `apps/data-publisher-worker/test/cost-guard.cases.ts` by
`bun run docs:test-plan`; the unit tests run exactly these rows.

<!-- test-plan:start apps/data-publisher-worker/test/cost-guard.cases.ts -->
| id | case | metric | value | recent | days | now | percent | projectedPercent | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CG2 | R2 Class A just under warn, month end | r2ClassA | 599999 | 140000 | 7 | 2026-10-31T22:07:00Z | 59.99 | 60.15 | ok |
| CG2 | R2 Class A at 60 %: warn | r2ClassA | 600000 | 140000 | 7 | 2026-10-31T22:07:00Z | 60 | 60.15 | warn |
| CG2 | R2 Class A just under 80 % | r2ClassA | 799999 | 140000 | 7 | 2026-10-31T22:07:00Z | 79.99 | 80.15 | warn |
| CG2 | R2 Class A at 80 %: trip | r2ClassA | 800000 | 140000 | 7 | 2026-10-31T22:07:00Z | 80 | 80.15 | tripped |
| CG35 | real October (Example): the 7-day rate projects 211 %, not month to date's 318 % | r2ClassA | 2062716 | 33676 | 7 | 2026-10-21T02:04:00Z | 206.27 | 211.52 | tripped |
| CG35 | a past burst of 700,000 with a quiet week: warns, no longer projected over | r2ClassA | 700000 | 33676 | 7 | 2026-10-21T22:07:00Z | 70 | 74.84 | warn |
| CG35 | projected exactly 100 %: not over | r2ClassA | 280000 | 210000 | 7 | 2026-10-08T00:00:00Z | 28 | 100 | ok |
| CG35 | projected just over 100 % (shown floored) | r2ClassA | 280001 | 210000 | 7 | 2026-10-08T00:00:00Z | 28 | 100 | tripped |
| CG35 | November 1 00:30: October's last 7 days project from the 1st | r2ClassA | 100 | 1400000 | 7 | 2026-11-01T00:30:00Z | 0.01 | 599.59 | tripped |
| CG35 | February has 28 days: 14 remain | r2ClassA | 400000 | 280000 | 7 | 2026-02-15T00:00:00Z | 40 | 96 | ok |
| CG2 | R2 Class B at 60 % | r2ClassB | 6000000 | 1400000 | 7 | 2026-10-31T22:07:00Z | 60 | 60.15 | warn |
| CG2 | R2 storage just under 80 %: a gauge has no projection | r2StorageBytes | 7999999999 | — | — | 2026-10-20T22:07:00Z | 79.99 | — | warn |
| CG2 | R2 storage at 8 GB: trip | r2StorageBytes | 8000000000 | — | — | 2026-10-20T22:07:00Z | 80 | — | tripped |
| CG2 | Vectorize stored dimensions today (Example): warn, never trips | vectorizeStoredDimensions | 9998336 | — | — | 2026-10-20T22:07:00Z | 99.98 | — | warn |
| CG2 | Vectorize stored dimensions under 60 % | vectorizeStoredDimensions | 5999999 | — | — | 2026-10-20T22:07:00Z | 59.99 | — | ok |
| CG35 | queried dimensions (Example), no complete day of history: projects as month to date | vectorizeQueriedDimensions | 10244096 | 0 | 0 | 2026-10-20T22:07:00Z | 20.48 | 20.48 | ok |
| CG35 | queried dimensions with 3 complete days: the rate uses 3 | vectorizeQueriedDimensions | 15000000 | 3000000 | 3 | 2026-10-21T22:07:00Z | 30 | 50.15 | ok |
| CG2 | neurons today just under warn at the Dev tick | workersAiNeurons | 5999 | — | — | 2026-10-20T22:07:00Z | 59.99 | 65.09 | ok |
| CG2 | neurons today at 60 % | workersAiNeurons | 6000 | — | — | 2026-10-20T22:07:00Z | 60 | 65.1 | warn |
| CG2 | neurons today just under 80 % | workersAiNeurons | 7999 | — | — | 2026-10-20T22:07:00Z | 79.99 | 86.8 | warn |
| CG2 | neurons today at 80 %: trip | workersAiNeurons | 8000 | — | — | 2026-10-20T22:07:00Z | 80 | 86.81 | tripped |
| CG2 | neurons one second before a quarter of the day: no projection | workersAiNeurons | 5000 | — | — | 2026-10-20T05:59:59Z | 50 | — | ok |
| CG2 | neurons at a quarter of the day: projected 200 % trips | workersAiNeurons | 5000 | — | — | 2026-10-20T06:00:00Z | 50 | 200 | tripped |
| CG2 | a value that could not be read | r2ClassA | — | — | — | 2026-10-20T22:07:00Z | — | — | unavailable |
<!-- test-plan:end -->

### Amendment 2026-10-21

Dollars per metric now and projected (CG21; the 7-day projection of counters, CG35), generated from
`apps/data-publisher-worker/test/cost-guard-dollars.cases.ts`:

<!-- test-plan:start apps/data-publisher-worker/test/cost-guard-dollars.cases.ts -->
| id | case | metric | value | recent | days | now | overageUsd | projectedOverageUsd |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CG21 | R2 storage 13.9 GB (Example): a gauge projects as itself | r2StorageBytes | 13900000000 | — | — | 2026-10-21T02:04:00Z | 0.0585 | 0.0585 |
| CG21 | R2 storage at exactly 10 GB | r2StorageBytes | 10000000000 | — | — | 2026-10-21T22:07:00Z | 0 | 0 |
| CG21 | Vectorize stored dimensions (Example): $0.0000888, shown floored | vectorizeStoredDimensions | 10177536 | — | — | 2026-10-21T02:04:00Z | 0 | 0 |
| CG21 | Vectorize stored dimensions 200 million over | vectorizeStoredDimensions | 210000000 | — | — | 2026-10-21T22:07:00Z | 0.1 | 0.1 |
| CG21 | neurons at the sum of this Worker's daily caps: never billed | workersAiNeurons | 8500 | — | — | 2026-10-21T22:07:00Z | 0 | 0 |
| CG21 | neurons 20,000 today at the Dev tick | workersAiNeurons | 20000 | — | — | 2026-10-21T22:07:00Z | 0.11 | 3.9907 |
| CG21 | neurons before a quarter of the day: today is not extrapolated | workersAiNeurons | 20000 | — | — | 2026-10-21T05:59:59Z | 0.11 | 3.41 |
| CG21 | a value that could not be read | r2ClassA | — | — | — | 2026-10-21T22:07:00Z | — | — |
| CG35 | real October to date (Example): the incident's dollars are spent, the quiet week adds little | r2ClassA | 2062716 | 33676 | 7 | 2026-10-21T02:04:00Z | 4.7822 | 5.0184 |
| CG35 | a past burst of 1.23 million with the same quiet week: no longer projected over | r2ClassA | 1230000 | 33676 | 7 | 2026-10-21T22:07:00Z | 1.035 | 1.2531 |
| CG35 | R2 Class A at the included million: nothing billed yet | r2ClassA | 1000000 | 33676 | 7 | 2026-10-21T22:07:00Z | 0 | 0.2181 |
| CG35 | the incident on its seventh day (real 10-01..07): projected far over | r2ClassA | 953503 | 953503 | 7 | 2026-10-08T00:00:00Z | 0 | 14.5019 |
| CG35 | November 1 00:30: October's last 7 days give the rate | r2ClassA | 100 | 1400000 | 7 | 2026-11-01T00:30:00Z | 0 | 22.4817 |
| CG35 | February has 28 days | r2ClassA | 1600000 | 33676 | 7 | 2026-02-15T00:00:00Z | 2.7 | 3.003 |
| CG35 | R2 Class B (Example) under its 10 million | r2ClassB | 269830 | 218882 | 7 | 2026-10-21T02:04:00Z | 0 | 0 |
| CG35 | R2 Class B over its 10 million | r2ClassB | 12000000 | 2100000 | 7 | 2026-10-21T22:07:00Z | 0.72 | 1.8084 |
| CG35 | queried dimensions with 3 complete days of history: the rate uses 3 | vectorizeQueriedDimensions | 150000000 | 30000000 | 3 | 2026-10-21T22:07:00Z | 1 | 2.0078 |
| CG35 | no complete day of history: projects as month to date | vectorizeQueriedDimensions | 150000000 | 0 | 0 | 2026-10-21T22:07:00Z | 1 | 1 |
| CG35 | queried dimensions (Example): no per-day history yet | vectorizeQueriedDimensions | 10433536 | 0 | 0 | 2026-10-21T02:04:00Z | 0 | 0 |
<!-- test-plan:end -->

Pending: the budget, its warn on projection and the Class A spike (CG22, CG34, CG23), generated from
`apps/data-publisher-worker/test/cost-guard-budget.cases.ts`:

<!-- test-plan:start apps/data-publisher-worker/test/cost-guard-budget.cases.ts [pending] -->
| id | case | overageUsd | projectedOverageUsd | classA24h | percent | projectedPercent | status | trips |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CG22 | just under warn | 2.9999 | 2.9999 | 976 | 59.99 | 59.99 | ok | — |
| CG22 | $3 spent: warn | 3 | 3 | 976 | 60 | 60 | warn | — |
| CG22 | just under $4 | 3.9999 | 4.9 | 976 | 79.99 | 98 | warn | — |
| CG22 | $4 spent: trip | 4 | 4.9 | 976 | 80 | 98 | tripped | budget |
| CG22 | projected exactly $5: not over, warns | 1 | 5 | 976 | 20 | 100 | warn | — |
| CG22 | projected just over $5 (shown floored) | 1 | 5.0001 | 976 | 20 | 100 | tripped | budget |
| CG22 | real October (Example): the spent dollars alone trip | 4.8408 | 5.077 | 976 | 96.81 | 101.54 | tripped | budget |
| CG22 | a past 1.23 million burst with a quiet week | 1.0935 | 1.3117 | 976 | 21.87 | 26.23 | ok | — |
| CG22 | nothing over any allowance | 0 | 0 | 976 | 0 | 0 | ok | — |
| CG34 | projection just under 60 % | 1 | 2.9999 | 976 | 20 | 59.99 | ok | — |
| CG34 | projection at 60 %: warn, no trip | 1 | 3 | 976 | 20 | 60 | warn | — |
| CG34 | nothing spent yet, projection at 60 % | 0 | 3 | 976 | 0 | 60 | warn | — |
| CG23 | Class A just under the spike threshold | 0 | 0 | 49999 | 0 | 0 | ok | — |
| CG23 | Class A at the spike threshold: trips with no dollars spent | 0 | 0 | 50000 | 0 | 0 | tripped | r2ClassA |
| CG23 | the 10-13 incident rate (8,150 an hour) | 0 | 0 | 195600 | 0 | 0 | tripped | r2ClassA |
| CG23 | budget and spike together | 4 | 4.9 | 60000 | 80 | 98 | tripped | budget, r2ClassA |
| CG23 | the bucket read failed: no spike trip on missing data | 0 | 0 | — | 0 | 0 | ok | — |
<!-- test-plan:end -->

The CG35 slice (2026-10-23) replaced the quarter-of-the-month projection
rows of the first table with 7-day-rate rows. The budget slice replaces
the CG2 rows for storage and stored dimensions, which then no longer trip
or warn.

## Acceptance

Each item: precondition → action → observable result → evidence.

### Behavior
- CG1: given `COST_GUARD` unset, blank, `off`, `monitor`, `enforce` or `on`, resolving it gives off, off, off, monitor, enforce, invalid; while off a publisher tick makes only the publication call, `/health` has no `costGuard` key, and `POST /cost-guard/check` and `/cost-guard/reset` answer 403 → worker test.
- CG2: given the threshold rows, `evaluateMetric` gives the percent, projected percent and status of each row (60 % warn, 80 % trip, projection over 100 % trips, a month counter projected by its 7-day rate (CG35), neurons only from a quarter of the day, gauges never projected, stored dimensions never trip) → case rows.
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

### Amendment 2026-10-21: dollar budget

#### Behavior
- CG21: given the CG21 rows, `metricOverage` gives each metric's overage now and projected month-end overage in dollars (gauges as themselves, neurons by today's rate times the days of the month, an unread value as null), and `/health` `costGuard.metrics[key]` carries them as `overageUsd` and `projectedOverageUsd` → case rows (the CG11 health test checks the keys).
- CG22: [pending] given the CG22 rows, `evaluateBudget` gives percent and projected percent of $5 and the status (60 % warn, 80 % trip, projected over 100 % trips; the real October trips on money spent) → case rows.
- CG23: [pending] given the CG23 rows, a 24-hour Class A count of 50,000 or more on the guard's own bucket trips `r2ClassA` whatever the dollars, and a missing count trips nothing → case rows.
- CG24: [pending] given the Example's inputs (13.9 GB stored, 10,177,536 stored dimensions, Class A 2,062,716 month to date and 33,676 over 10-14..20, 976 in 24 h on the Dev bucket, at 2026-10-21T02:04Z), a dry run reports `budget` $4.8408 now and $5.0770 projected, status `tripped` (`budget`), each metric `ok`, the spike `ok`, and the breaker untouched; with Class A 1,230,000 instead it reports $1.3117 projected and `ok`; storage alone at 13.9 GB or stored dimensions at 102 % never trips → check test.
- CG25: [pending] the request stays one POST and adds two `r2OperationsAdaptiveGroups` selections: the account's 7 complete UTC days before today by `date`, and the last 24 hours filtered by `bucketName` the guard's own bucket; given a fixture with a third bucket's 100,000 Class A in the last 24 hours, those count in the account's dollars and not in the spike → fixture test.
- CG26: [pending] given `enforce` and a breaker opened by `budget` only, the digest, embedding job and query gate refuse and `POST /run` and the publication alarm run; opened by `r2ClassA` (the spike), the publication also pauses; the breaker records `metric`, `value`, `threshold` ($4, $5 or 50,000) and `overageUsd` per metric → breaker and route tests.
- CG27: [pending] `/health` `costGuard` has the shape of Behavior 13a for `pending`, `ok`, `warn`, `tripped` and `unconfigured`, with no per-metric `percent` or `warn` → health test.

- CG34: [pending] given the CG34 rows, a projected month-end overage at 60 % of the budget or more makes the budget `warn` (in `/health` only) while the money spent is under 60 %, and never trips below a projection of 100 % (Decision 13) → case rows.
- CG35: given the CG35 rows, a counter projects month to date plus its average over the 7 complete UTC days before today times the remaining days, across a month boundary and from the 1st; with fewer than 7 complete days it uses the days it has, and with none it projects as month to date (Decision 9). The per-metric `projectedPercent` and the dollars use the same projection (real October: 211.52 %, not month to date's 318 %), and the one GraphQL request reads the account's R2 operations over those 7 days (`datetime_geq` the 7th day before today, `datetime_lt` today) → case rows and fixture test.
- CG36: [pending] given a GraphQL fixture where `oss-knowledge-base-prod` wrote 195,600 Class A in the last 24 hours and `oss-knowledge-base-dev` 976, the Dev guard (`PUBLICATION_ENVIRONMENT=development`) requests only its own bucket, its spike stays `ok` and its publication runs, while the same fixture trips the Prod guard's spike; both count the 196,576 in the account's dollars (Decision 10) → fixture and route tests.
#### Failure and retry
- CG28: [pending] given a GraphQL failure, the R2 metrics and the spike are `unavailable`, the budget sums the in-app metrics only, lists the R2 keys in `missing`, and nothing trips on missing data → check test.
- CG29: [pending] given a budget still at $4 or more after a reset, the next real check opens the breaker again; on the 1st of the next month the sums restart from $0 and the breaker stays open until reset → breaker test.
- CG30: [pending] given a check at 00:30 UTC on November 1, the dollars cover 30 minutes of November, the rate covers October 25–31, and the spike covers the last 24 hours across the month boundary → fixture test.
- CG31: [pending] given an unknown R2 action type on an OSS KB bucket, it counts as Class A in both the dollars and the spike and is listed in `unclassifiedActions` → fixture test.

#### Budget
- CG32: [measure] after the implementing slice, a real check is still one GraphQL request and one Durable Object write, with no R2 operation; measured by `bun test test/cost-guard.test.ts -t CG32` (in `apps/data-publisher-worker`), which counts the calls.

- CG37: [measure] the spike threshold (Decision 12): after the implementing slice, the first real per-bucket checks on Dev and Prod show `r2ClassASpike.last24h` on a publication day at or under 5,000 (a tenth of 50,000); measured by `POST /cost-guard/check?dryRun=1` on each environment and recorded in the PR that enables `enforce`, which keeps or changes the 50,000.
#### Observability
- CG33: [deploy] after the implementing slice, on Dev under `monitor`, `POST /cost-guard/check?dryRun=1` shows the R2 dollars within $0.10 of the dashboard's billable usage this month and the 24-hour Class A within 5 % of the per-bucket R2 metrics; the owner reads `budget` and `r2ClassASpike` before `enforce`.

## Decisions (confirmed by the owner, 2026-10-20)

The owner decided to build the guard and, on reviewing #105, confirmed the
four choices below and removed the web part (Simplification review).

1. **Vectorize stored dimensions warn and never trip** (Behavior 6; replaced by Decision 5, 2026-10-21). Dev is
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
