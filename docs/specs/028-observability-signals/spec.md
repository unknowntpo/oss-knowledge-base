# Spec 028: Observability signals (metrics first)

Status: Partially implemented (owner intent 2026-10-21: metrics → structured logs → traces; D1 decided 2026-10-21: metrics in Workers Analytics Engine; refreshed 2026-10-22: every scheduled job is a signal source with one common schema (OB22–OB31); D2–D10 decided by owner 2026-10-22 per the recorded recommendations; slice 0 (Wrangler 4.148.0, OB30) implemented 2026-10-22; slice 1 (signal code behind `OBSERVABILITY_SIGNALS`, off everywhere, no binding) implemented 2026-10-23; Dev enable (flag `on`, `SIGNALS` → `osskb_signals_dev`, `ANALYTICS_SQL`; Dev config only) 2026-10-23; history query fixed for the binding's schema 2026-10-23 (no `_sample_interval`, weighted `COUNT(*)`, no column aliases); OB19–OB21, OB31 pending on Dev; Prod and slices 2–3 not started)
Date: 2026-10-21 (refreshed 2026-10-22)
Traceability: enforced
Builds on: Spec 010, 011, 018, 021 (freshness and stalls), Spec 008 and 018 (R2 Class A invariant), Spec 014 (digest), Spec 016 (embedding job), Spec 019 amendment (7) (identity-links and kip-pages jobs), Spec 026 (cost guard and its 2026-10-21 dollar budget), Spec 029 (R2 retention job), Spec 027 (read-only SRE agent, PR #106, not merged)

## Intent

The owner, and later the SRE agent of Spec 027, can read from the
publisher's `/health` whether a known failure mode is happening now, judged
by fixed rules over recorded numbers, not by a model. Owner intent
(2026-10-21), in order:

1. **Metrics first, then improve gradually**: metrics → structured logs →
   traces, one layer per slice.
2. **Traces are costly**: the last layer, sampled, and only after an explicit
   owner decision. Not enabled by this spec's first slice.
3. **One correlation key on every signal**: a metric data point, a log line
   and (later) a span of the same run carry the same `runId`; Cloudflare's
   own invocation id is added where the platform provides it.
4. **Deterministic detection**: rules judge thresholds. A firing rule is what
   later wakes the Spec 027 agent for diagnosis; the agent never detects.
5. **One job, one responsibility** (owner, 2026-10-21): every scheduled job
   is its own signal source and writes its own data point under its own job
   name and `runId`, even when two jobs share a cron tick or an invocation
   (the cost guard runs on the publication tick). A job's signal never
   changes another job's result.
6. **Stalls are visible, not pushed**: a job that did not run, or keeps
   failing, shows in `/health.signals` (which the owner and the UI read); no
   push alert, email or webhook.
7. **Budget**: Workers Paid ($5) plus the $5-a-month overage budget of Spec
   026; this spec stays inside the included Analytics Engine and Workers
   Observability allowances (Cost estimate).

Today the rules exist only in people's heads, the runbook and Spec 027's
`get_health` derived checks. Nothing keeps history, so "two consecutive
failed days" cannot be judged from one `/health` read, and the Worker's log
lines are free text with no key that joins them to a run.

## Evidence

- Four incidents in Spec 027's Evidence (R2 Class A spike 2026-10-07 → 10-13,
  Dev 49 h stall 2026-09-30 → 10-02, `v0.3.0` tag CI failure, `en` digest
  cache pollution) were found by the owner a day or more late. Three of the
  four are threshold checks on numbers the Worker already has.
- Log lines today are template strings (`apps/data-publisher-worker/src/pipeline.ts`
  `publication ${name} at …ms {…}`, `index.ts` cost-guard and follow-up
  errors); none carries a run identifier, so a failed follow-up cannot be
  joined to the publication that scheduled it.
- `wrangler.{development,production}.jsonc` set `observability.enabled: true`,
  `head_sampling_rate: 1` and no `observability.traces`: logs on, traces off.
- Wrangler in the repository: `^4.125.0` in `apps/data-publisher-worker` and
  `apps/web`, locked at `4.125.0` (`bun.lock`). The `analytics` binding needs
  ≥ 4.145.0, so **a prerequisite slice (slice 0) upgrades Wrangler** before
  any signal code (Workers Issues, D3, needs ≥ 4.134.0 too).

### Jobs since the first draft (read from `main` 2026-10-22)

Seven scheduled jobs now exist or are specified, each with its own status
record. Every one already records `ok`, a status and a duration; four count
their own R2 operations.

| Job (`job`) | Spec | Trigger (Dev) | Status today | Own counters already recorded | R2 Class A/B counted |
| --- | --- | --- | --- | --- | --- |
| `publication` | 018 | cron `7 22 * * *` (Prod `37 22`) | `/health` `lastRun` (Durable Object) | `sources[*].ok`, `pollTruncated`, `copiedObjectCount`, `reusedObjectCount` | yes (`lastRun.r2`) |
| `digest` | 014 | cron `47 22 * * *` (`DIGEST_CRON`) | `/health` `digest.lastRun` (`DigestRun`) | `candidates`, `rejections`, `durationMs` | no |
| `embedding` | 016 | after each publication, then hourly while chunks are pending | `/health` `searchEmbedding.lastRun` (`SearchEmbeddingRun`) | `embeddedThisRun`, `pending`, `quarantined`, `durationMs` | no |
| `cost-guard` | 026 | the publication tick, `COST_GUARD=monitor` on Dev (Dev `enforce` planned from 2026-11-01; Prod unset) | `/health` `costGuard` (`CostGuard`, one storage key) | `status`, breaker, per-metric evaluation; amendment (not implemented): `budget {overageUsd, projectedOverageUsd}` against $5 a month, `r2ClassASpike {last24h, threshold 50,000}` on its own bucket | none needed: it reads the GraphQL Analytics API, no R2 call |
| `retention` | 029 (spec merged, not implemented) | `RETENTION_CRON` `17 10 * * *`, `R2_RETENTION` `off`/`dry-run`/`enforce` (planned, unset) | `/health` `retention {mode, status, reason, lastRun}`; Spec 029 Behavior 10 already reserves its data point | `deleted.objects`, `deleted.bytes`, `remaining`, `elapsedMs` | yes (`lastRun.r2`) |
| `identity-links` | 019 (7) | cron `17 2 * * *` (`IDENTITY_LINKS_CRON`), live on Dev 2026-10-21 | `/health` `identityLinks` (R2 `last-run.json`) | `status` (`ok`/`unchanged`/`no-input`/`failed`), `durationMs`, `links`, `rejected`, `people`, `bytesWritten` | yes (`lastRun.r2`) |
| `kip-pages` | 019 (7) | cron `43 3 * * *` (`KIP_PAGES_CRON`), live on Dev 2026-10-21 | `/health` `kipPages` (R2 `last-run.json`) | `status` (`ok`/`unchanged`/`failed`/`over-budget`), `durationMs`, `pagesRead`, `pagesChanged`, `issuesRead`, `requests` | yes (`lastRun.r2`) |

### Verified sources (read 2026-10-21)

| Fact | Source | Verified |
| --- | --- | --- |
| Workers Analytics Engine (WAE) pricing: Paid includes 10 million data points written and 1 million read queries a month, then $0.25 per million writes and $1.00 per million reads; **not billed yet**; Free 100,000 writes and 10,000 reads a day | [WAE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) | documented |
| WAE limits: 20 blobs, 20 doubles, 1 index (≤ 96 bytes) per point; 16 KB of blobs; 250 points per invocation; **3-month retention**; adaptive sampling at write and read (`_sample_interval`) | [Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/), [Sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/) | documented |
| WAE write: binding `analytics_engine_datasets: [{binding, dataset}]`; `writeDataPoint({blobs, doubles, indexes})` returns immediately (written in the background); exactly one index | [Get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/) | documented |
| Analytics SQL Workers binding: `"analytics": {"binding": "ANALYTICS_SQL"}`, Wrangler ≥ 4.145.0; `env.ANALYTICS_SQL.query({query, params})` → `{data, rows, statistics {elapsed_ms, rows_read, bytes_read}}`; one `SELECT`; time filters in SQL; no `FORMAT`, no `accountTag` predicate (the binding scopes the account); **no API token**; no automatic retry, a thrown error has `retryable`; WAE tables as `events.analyticsEngine."<dataset>"`; Log Explorer-backed datasets not supported | [Workers binding](https://developers.cloudflare.com/analytics/sql-api/workers-binding/) | documented; beta status, limits and pricing not stated on the page |
| Analytics SQL dialect (the binding's), unlike the WAE SQL API: a WAE dataset has `timestamp`, `index1`, `blobN`, `doubleN` but **no `_sample_interval` column** (Dev 2026-10-23: "Schema error: No field named _sample_interval"); a column used in another clause must not carry a SELECT alias (Dev 2026-10-23, run `publication-2026-10-23T02-52-13-074Z`, for `timestamp AS writtenAt` with `GROUP BY … timestamp ORDER BY timestamp`: "the history query failed: Input was invalid: column \`writtenAt\` not found in dataset \`events.analyticsEngine\`"); "The SQL API applies sample weights to supported aggregates" (`COUNT`, `SUM`, `AVG`, …); a row-level `SELECT` returns only retained rows; exact `MIN`/`MAX` are rejected on adaptively sampled datasets | [Datasets](https://developers.cloudflare.com/analytics/sql-api/datasets/), [Functions: adaptive sampling](https://developers.cloudflare.com/analytics/sql-api/sql-reference/functions/), [WAE SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) (where `_sample_interval` does exist) | documented (read 2026-10-23); the missing column observed on Dev |
| SQL API: beta since 2026-10-02, one endpoint for event, state, log (Workers Logs) and WAE datasets, Workers binding without a token, available on all plans, "powers Monitors"; no pricing stated | [Changelog 2026-10-02](https://developers.cloudflare.com/changelog/post/2026-10-02-sql-api-beta/), [SQL API](https://developers.cloudflare.com/analytics/sql-api/) | documented; limits not documented |
| Dataset names: Workers Logs `logs.workersLogs` (example columns `timestamp`, `scriptName`, `logType`); WAE `events.analyticsEngine."<dataset>"` (`timestamp`, `index1`, `blob1`, `double1`); full columns and custom attributes (7 days) only through the introspection endpoint | [Datasets](https://developers.cloudflare.com/analytics/sql-api/datasets/) | documented; whether the binding can read `logs.workersLogs` (Log Explorer-backed or not) and the column holding a logged `runId` are **unverified** (OB21) |
| Monitors: a SQL API query on a schedule (1 min for most datasets) returning one numeric `value`; threshold (`<`…`!=` over a window), anomaly (z-score vs a baseline ≤ 24 h, ≥ 30 min history) or SLO; "a query that returns no rows produces no signal"; delivery by email (≤ 20), webhook, PagerDuty (Business+); repeat interval 1 min–168 h; custom SQL must include an account or zone filter; no documented state or history page | [Monitors](https://developers.cloudflare.com/notifications/monitors/) | documented; pricing and beta status not stated |
| Workers Logs: `console.log` of an object is indexed by field; Paid 20 million events a month, $0.60 per million beyond, 7-day retention, until 2026-12-01, then Observability pricing. The page names no per-event request or invocation id field (`$workers.requestId` is **not** on that page) | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) | documented; invocation-id field name unverified (OB19) |
| From 2026-12-01, Paid: 50 GB ingestion and 10 GB-month storage per billing cycle included, $0.25 per GB and $0.10 per GB-month beyond; logs and traces share the allowance | [Observability pricing](https://developers.cloudflare.com/observability/pricing/) | documented |
| Workers Traces: `observability.traces.enabled`, `head_sampling_rate` (default 1); automatic spans for fetch, bindings (KV, R2, Durable Objects), RPC and handlers; 7-day retention; early beta. Custom spans: `tracing.enterSpan` from `cloudflare:workers`. Span attributes: `faas.invocation_id` on every span, `cloudflare.ray_id` on root spans | [Traces](https://developers.cloudflare.com/workers/observability/traces/), [Custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/), [Spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/) | documented |
| OTLP export: `destinations`, `persist` (default `true`); Workers infrastructure and custom metrics cannot be exported through OpenTelemetry | [OpenTelemetry export](https://developers.cloudflare.com/workers/observability/opentelemetry-export/) | documented; WAE counted as "custom metrics" is an inference |
| Workers Issues: groups one Worker's failures (uncaught exception, failed invocation, 5xx, logged error); automations to an agent, webhook, chat or incident tool; `observability.issues.enabled` (Wrangler ≥ 4.134.0); open beta, free | [Workers Issues](https://developers.cloudflare.com/workers/observability/issues/) | documented |

## Example

Dev `/health`, read 2026-10-20 23:45 UTC (public, unauthenticated `GET`):

```json
{ "environment": "development", "running": false, "followUp": null,
  "lastRun": { "ok": true, "completedAt": "2026-10-20T22:07:19.086Z",
    "pollTruncated": false, "copiedObjectCount": 821, "reusedObjectCount": 7854,
    "r2": { "classA": 824, "classB": 8678 },
    "sources": { "github": { "ok": true, "lastSuccessAt": "2026-10-20T22:07:19.086Z" },
                 "mail": { "ok": true }, "jira": { "ok": true } } },
  "digest": { "enabled": true,
    "lastRun": { "ok": true, "completedAt": "2026-10-20T22:49:08.123Z",
      "candidates": 449, "rejections": { "unparsable": 4, "empty": 1 } } } }
```

The data point this run would have written to `osskb_signals_dev` (`runId`
new; every other value copied from `lastRun`; `durationMs` = `completedAt` −
`startedAt` 22:07:00.000):

```text
indexes: ["publication-2026-10-20T22-07-00-000Z"]
blobs:   ["publication", "development", "ok", ""]                    // job, env, status, sourceRunId
doubles: [1, 19086, 824, 8678, 1, 1792534039086,                     // ok, durationMs, r2ClassA, r2ClassB, r2Counted, completedAtMs
          1, 1, 1, 0, 821, 7854]                                     // c1..c6 for publication: github, mail, jira, pollTruncated, copiedObjectCount, reusedObjectCount
```

The digest run of the same evening writes its own point under its own
`runId` (`digest-2026-10-20T22-47-00-000Z`, `sourceRunId` the publication's),
`r2Counted` 1 (slice 1 counts the digest's R2 requests, D8) and c1..c2 =
`candidates` 449, `rejections` 5. The cost guard, which runs on the
publication's tick, writes a third point (`cost-guard-…`), never fields of
the publication's.

Rules at 2026-10-20 23:45 UTC (`state` = the Durable Object's current
status, read on every `/health`; `analytics` = WAE history, evaluated at the
end of each run):

| Rule | Source | Value | Threshold | Status |
| --- | --- | --- | --- | --- |
| `publication.freshness` | state | 1 h 38 min since the newest `lastSuccessAt` | warn > 24.5 h, firing > 27 h | ok |
| `r2.classAInvariant` | state | excess 824 − (821 + 3) = 0 | excess = `classA − (copiedObjectCount + 3 + putRetries + min(conditionalMisses, 50))`; warn > 3, firing > max(50, 0.5 × `copiedObjectCount`) (D11) | ok |
| `digest.freshness` | state | 56 min | firing > 48 h | ok |
| `source.success` (github, mail, jira) | analytics | all `ok` | firing after 2 consecutive UTC days failed | ok |
| `publication.pollTruncated` | analytics | false | firing when true for > 48 h | ok |
| `digest.rejections` | analytics | 5 | firing when ≥ 10 and > 3 × median of the previous 7 | ok |
| `job.missed` (each job, Behavior 15) | state | e.g. `kip-pages` last run at 03:43, 20 h ago | daily job: warn > 24.5 h, firing > 27 h since its last run of any status | ok |
| `job.failures` (each job) | analytics | 0 failed in a row | warn: current run failed; firing: 2 consecutive runs failed | ok |
| `job.duration` (each job) | analytics | publication 19 s | warn: > 2 × median of the previous 7 runs (≥ 3 needed) | ok |
| `job.r2ClassA` (each job counting R2) | analytics | publication 824 | warn: > 3 × median of the previous 7 runs and > 1,000 | ok |

Expected `/health.signals`: `{status: "ok", evaluatedAt:
"2026-10-20T23:45:03Z", analyticsEvaluatedAt: "2026-10-20T22:49:09Z",
rules: [one entry per rule and job, all "ok"]}`. The 2026-10-13 hourly runs (`classA` ≈ 8,190,
`copiedObjectCount` ≈ 35) would make `r2.classAInvariant` `firing`. The
manual Dev run of 2026-10-23 (`classA` 323, `copiedObjectCount` 316, Class B
exact) is 4 above `copiedObjectCount + 3`, explained by put retries or
conditional misses that were not counted: `warn` without the counters, `ok`
with them (D11).

## Solution space

| Option | Detection | History | Surface | Verdict |
| --- | --- | --- | --- | --- |
| A. Rules in the Worker on Durable Object state only | yes | none beyond the current status | `/health` | keeps the stall rule; cannot judge trends |
| B. A ring of recent records in Durable Object storage (first draft) | yes | 14 runs | `/health` | withdrawn (owner D1, 2026-10-21) |
| **C. WAE data points + Analytics SQL binding, plus A for current-state rules** | yes | 3 months, SQL | `/health` | **chosen** (D1): history and SQL without a token; the stall rule still runs on state when WAE is down |
| D. Cloudflare Monitors on the same WAE dataset | threshold, anomaly or SLO on one numeric `value` per evaluation, every ≥ 1 min | WAE | email, webhook, PagerDuty only; no documented state page | not adopted in slice 1 (below) |
| E. Workers Logs queries only | via the telemetry API (Write-scoped token, Spec 027 Decision 6) | 7 days | none | rejected: logs are for explaining, not judging |

**Monitors (D).** It can express our thresholds (one `value` vs a fixed
number over a window) and a consecutive-failure rule rewritten as a count
over a window (for example failed days in the last 2 UTC days ≥ 2). It
cannot alert on absence as documented: "a query that returns no rows
produces no signal", so a stall (no new point) only fires if the query is
written to always return one row (an aggregate without `GROUP BY` returning
0; an **inference** to test). It delivers only by push (email, webhook,
PagerDuty), and no page lists monitor state, so it does not meet the owner's
rule that stalls are visible in the UI. Custom SQL there must carry an
account filter, while the binding forbids one, so the rules would be written
twice. Recommendation: keep `/health.signals` as the in-product surface and
the only detector in slice 1; reconsider Monitors as the agent's wake-up
path (webhook) under D5, or as an email backup the owner opts into.

## Simplification review

1. **Question every requirement.**
   - A data point per run: two rules (consecutive source failures,
     `pollTruncated` duration) and the rejection baseline need history that
     one `/health` read cannot show. Owner (intent 1, D1).
   - `runId`: owner (intent 3). `feedReleaseId` exists only for a successful
     run, and a publication spans several invocations (follow-ups, alarm
     retries), so Cloudflare's per-invocation id cannot be the run key. It is
     the WAE index, so every point is addressable by it.
   - Current-state rules stay on Durable Object state: owner (D1 revision),
     so `/health` still judges a stall when WAE or the binding is unavailable.
   - `/health.signals`: the owner reads `/health` (no push alerts; the UI
     shows it) and Spec 027's `get_health` already reads it.
   - One point per job, not one point per tick: owner (one job, one
     responsibility); a shared point would make one job's failure look like
     another's.
   - Four generic rules for every job instead of per-job rules: every job
     already records `ok`, a status, a duration and (four of them) R2
     counts; job-specific rules stay only where a job has a known failure
     mode (publication sources, `pollTruncated`, digest rejections).
2. **Delete.**
   - The 14-record ring in Durable Object storage: **deleted** (owner D1);
     the object keeps only the status it already writes, plus the last trend
     result inside that same write.
   - SQL on every `/health` read: `/health` is public and unauthenticated, so
     each read would be a query anyone can trigger. **Deleted**: trend rules
     are evaluated once at the end of each run and stored with the status.
   - A5 cost guard %, A6 site consistency, A9 CI status: owned by Spec 026,
     `bun run verify:health` and Spec 027 `get_ci_status`.
   - An API token for WAE reads: the binding needs none.
   - Per-job datasets: deleted; one dataset per environment, `blob1 = job`.
   - Recomputing the cost guard's budget or spike in signals: deleted; the
     cost-guard job reports its own status.
   - A "did not run" rule in Analytics Engine: deleted; absence has no row
     to query, so `job.missed` is a state rule at read time.
   - Push alerts, Monitors, Workers Issues automations, traces: decided by
     owner 2026-10-22 (D2, D3, D5): traces off until the Dev measurement,
     Issues without automation, no Monitors.
3. **Simplify.** `metricPoint(job, record)`, `trendRules(job, current,
   history)` and `stateRules(records, trends, now)` are pure functions; a
   job run only writes its point, runs ≤ 2 queries (the publication; 1 for
   every other job) and stores the result in the write it already makes.
4. **Shorten the cycle.** Thresholds are one generated case table; WAE and
   the SQL binding are faked in tests; no network.
5. **Automate last.** Waking the agent on `firing` is a Spec 027 amendment
   (D5), after a week on Dev.

## Behavior

### Slice 1: metrics in WAE, rules, correlation key

1. `OBSERVABILITY_SIGNALS` unset, blank or `off`: nothing is written or
   queried, `/health` has no `signals` key, log lines keep today's shape. `on`
   enables Behaviors 2–9 and 13–18. Any other value behaves as off with
   `/health.signals` `{status: "unconfigured", reason}`; `on` without the
   `SIGNALS` (WAE) or `ANALYTICS_SQL` binding runs the state rules and marks
   the analytics rules `unknown` with a reason naming the missing binding.
2. Each run of each job gets `runId = <job> + "-" + <startedAt, ISO with
   ":" and "." replaced by "-">` when it starts (`job` from the table in
   Evidence, for example `publication-2026-10-20T22-07-00-000Z`); follow-up
   invocations and alarm retries of the same run keep it. A run that reads
   another job's output records that run as `sourceRunId` (the digest and
   the embedding job: the publication whose release they read). `runId`
   appears in the job's own `/health` record (`lastRun.runId`,
   `digest.lastRun.runId`, …). Spec 029's interim `retention-<UTC date>`
   becomes this shape.
3. When a run finishes (ok or failed), `metricPoint(job, record)` builds one
   data point from values already in that job's status record, with the
   common positional schema of Behavior 13, and calls
   `env.SIGNALS.writeDataPoint` once per run, not per invocation. Datasets:
   `osskb_signals_dev` and `osskb_signals_prod` (one account, so one per
   environment; every job of an environment writes to the same dataset,
   told apart by `blob1 = job`).
4. Right after the write, `trendRules` reads history through
   `env.ANALYTICS_SQL.query` with ≤ 3 parameterized `SELECT`s on
   `events.analyticsEngine."osskb_signals_<env>"`, each bounded by
   `timestamp` (≤ 8 days back) and by `blob1 = job`, excluding `index1 = runId` (the point just
   written may not be readable yet), and groups by every stored column it
   reads plus `timestamp`, so each row is one stored point and `COUNT(*) AS
   weight` is that point's sample weight. Columns are selected by their raw
   names with no alias (mapped in code); only that aggregate is aliased, and no
   alias appears outside the SELECT list (the binding has no
   `_sample_interval`; it weights `COUNT`). It combines the history with the
   current status in memory. The result `{evaluatedAt, rules}` is stored in
   the status write the run already makes (no extra Durable Object write).
   `/health` never queries WAE.
5. Rules (thresholds are one const profile in code; changing one is a PR):

   | Rule | Source | Input | warn | firing |
   | --- | --- | --- | --- | --- |
   | `publication.freshness` | state, at read time | now − newest `sources[*].lastSuccessAt` (a failed run carries it forward) | > 24.5 h (Spec 021 `OVERDUE_AFTER_MS`) | > 27 h (Spec 010 `STALE_AFTER_MS`) |
   | `r2.classAInvariant` | state | `lastRun`: excess = `classA − (copiedObjectCount + 3 + putRetries + min(conditionalMisses, 50))`; a record without the two counters counts them as 0 and says so in `reason` (D11) | excess > 3 | excess > max(50, 0.5 × `copiedObjectCount`) |
   | `digest.freshness` (only when the digest is enabled) | state, at read time | now − `digest.lastRun.completedAt` of the newest ok run | — | > 48 h |
   | `source.success` (per source) | analytics | newest point per UTC day, plus the current run | current run failed | the newest runs on 2 consecutive UTC days failed |
   | `publication.pollTruncated` | analytics | streak of `pollTruncated = 1` ending at the current run | current run true | streak older than 48 h |
   | `digest.rejections` | analytics | current digest run vs the previous 7 digest points | — | ≥ 10 and > 3 × median (needs ≥ 3 previous) |
   | `job.*` (every job) | state and analytics | Behaviors 15–17 | | |

   Each rule entry is `{id, source, status: ok|warn|firing|unknown, value,
   threshold, since, runId}`; `since` is when the condition first held,
   `runId` the newest run that shows it. Missing data is `unknown`, never
   `firing`.
6. A history row with `weight ≠ 1` (or without `weight`) makes the rules that read it
   `unknown` with reason `sampled`: at about one point a day per environment
   sampling is not expected (an inference, checked by OB19), and an exact
   rule must not run on a sample.
7. `/health.signals` = `{status, evaluatedAt, analyticsEvaluatedAt, rules,
   lastError}`; `status` is the worst rule status (`unknown` counts as ok).
   This is the hand-off contract for Spec 027: the agent reads it through
   `get_health` and does not recompute thresholds.
8. Every log line emitted in a run's path (`pipeline.ts`, the publication,
   follow-up and cost-guard lines of `index.ts`, the digest, embedding,
   identity-links, kip-pages and retention runners)
   is `console.log|error({message, runId, job, ...})` (an object, so Workers
   Logs indexes `runId`); `message` is today's text and still passes the
   sanitizer.
9. No data point, rule entry, query parameter or log field contains a token
   or a request body.

### Slice 1 (refresh 2026-10-22): every job a signal source

Numbered after the first draft's 12 behaviors; nothing above is renumbered.

13. **Common schema.** Every job's point has `indexes: [runId]`, `blobs:
    [job, env, status, sourceRunId]` and `doubles: [ok, durationMs,
    r2ClassA, r2ClassB, r2Counted, completedAtMs, c1, c2, c3, c4, c5, c6]`.
    `status` is the job's own word (`ok`, `failed`, `unchanged`, `no-input`,
    `over-budget`, `skipped`, `overrun`, the cost guard's `ok`/`warn`/
    `tripped`/`unconfigured`). `r2Counted` is 1 when the job counts its own
    R2 operations and 0 otherwise (then `r2ClassA`/`r2ClassB` are 0 and the
    R2 rule is not evaluated for that job). The six job counters, unused
    slots 0:

    | `job` | c1 | c2 | c3 | c4 | c5 | c6 |
    | --- | --- | --- | --- | --- | --- | --- |
    | `publication` | github ok | mail ok | jira ok | `pollTruncated` | `copiedObjectCount` | `reusedObjectCount` |
    | `digest` | `candidates` | rejections (sum) | | | | |
    | `embedding` | `embeddedThisRun` | `pending` | `quarantined` | `deletedThisRun` | | |
    | `cost-guard` | breaker tripped | `budget.overageUsd` | `budget.projectedOverageUsd` | `r2ClassASpike.last24h` | | |
    | `retention` | `deleted.objects` | `deleted.bytes` | `remaining` | `candidates.objects` | dry run | |
    | `identity-links` | `links.corroborated` | rejected (sum) | `people` | `bytesWritten` | | |
    | `kip-pages` | `pagesRead` | `pagesChanged` | `issuesRead` | `requests` | `bytesWritten` | |

    The cost-guard budget fields are 0 until Spec 026's amendment (CG21–CG37)
    lands; the retention point is written when Spec 029 lands (its Behavior
    10). A job added later gets a row here, never a new slot layout.
14. **Own point, own `runId`.** One run writes exactly one point, with its
    own `job` and `runId`, also when it shares an invocation with another job
    (the cost guard on the publication tick writes `cost-guard-…`, never
    fields on the publication's point). Writing the point is the last step
    of the run and is wrapped: a throw is logged with the `runId` and never
    changes that job's result, its `/health` record or any other job.
15. **`job.missed` (state, at `/health` read time).** For each enabled job,
    the age of its last run of any status, read from the record `/health`
    already reads (no new read): daily jobs (`publication`, `digest`,
    `cost-guard` by `checkedAt`, `retention`, `identity-links`,
    `kip-pages`): warn > 24.5 h, firing > 27 h (the publication's Spec 021
    and Spec 010 constants); `embedding`: only while its `pending` > 0,
    warn > 2 h, firing > 3 h (it continues hourly). A disabled job
    (flag unset) has no entry; an enabled job with no run yet is `unknown`
    until 27 h after the flag's deploy is visible, then `firing`. This is
    the "did not run when scheduled" rule and needs no Analytics Engine.
16. **Trend rules per job (analytics, evaluated at the end of that job's
    run, one query per job run over its own `blob1`).** From the job's
    previous ≤ 7 points in 8 days plus the current run in memory:

    | Rule | warn | firing | Jobs |
    | --- | --- | --- | --- |
    | `job.failures` | the current run failed | the current and the previous run failed (2 consecutive runs; the publication's per-source rule stays as Behavior 5) | all |
    | `job.duration` | `durationMs` > 2 × median of the previous runs (≥ 3 needed) | `durationMs` ≥ 80 % of the job's own wall budget, where the job declares one (retention 10 min, kip-pages `KIP_PAGES_CRON_WALL_MS`) | all; firing only with a declared budget |
    | `job.r2ClassA` | `r2ClassA` > 3 × median of the previous runs and > 1,000 | `r2ClassA` > 10 × median and > 5,000 | jobs with `r2Counted` 1 |

    The publication keeps its `r2.classAInvariant` (state, D11); the
    account-wide 50,000-in-24 h Class A spike and the $5 budget stay with
    the cost guard (Spec 026), which `/health.signals` shows through the
    cost-guard job's own status, never recomputes. Retention gets no rule
    of its own beyond these (Spec 029 Behavior 10).
17. **Queries per run.** A job run makes ≤ 2 `SELECT`s (the `job.*` history
    and, for the publication only, the per-day source query; the digest's
    rejection baseline shares the `job.*` query), so Behavior 4's limit of
    3 holds per run. The results are stored in that job's own existing
    status write; a job with no Durable Object (identity-links, kip-pages,
    retention) stores them in the `last-run.json` it already writes (no
    extra R2 operation).
18. **`/health` stays free of Analytics Engine.** `/health` is public and
    unauthenticated: it never queries WAE or the SQL binding, and the
    signals add no Durable Object, R2 or external read to it; it combines
    the stored trend results with the state rules of Behavior 15 at read
    time. `signals` never changes `/health`'s HTTP status or any job's
    `status`/`ok`.
19. **Prerequisite.** Slice 0 upgrades Wrangler in
    `apps/data-publisher-worker` and `apps/web` from the locked 4.125.0 to
    ≥ 4.145.0 (the `analytics` binding) with no other change, and
    `bun run test:ci` stays green; slice 1 starts only after it merges.

### Slice 1 as implemented (2026-10-23)

Clarifications the implementation needed; none changes a threshold.

- **Publication duration.** The publication's `completedAt` is its
  materialization time (the cron's scheduled time on a tick), so its point
  takes `durationMs` and `completedAtMs` from the clock: the run's finish
  minus the trigger time stored with its `runId`. The Example's values are
  unchanged (`completedAt` 22:07:19.086 there is the finish).
- **One query per run, the publication too.** `source.success` and
  `publication.pollTruncated` read the same `job.*` history rows (newest
  point per UTC day), so every job run makes at most one `SELECT` (one more
  only on a `retryable` error); Behavior 17's limit of 2 holds.
- **A failed write is not judged.** When `writeDataPoint` throws, no query
  is made and the run's analytics rules are `unknown` with the write error
  (OB14); the job's own result is unchanged.
- **Rule entries** carry `job` on every entry (Spec 027 reads it), `subject`
  for `source.success` (the source), and `reason` when `unknown`. `since` is
  the start of the condition: the first failure of a failing streak, the
  first truncated run of a truncation streak (+ 48 h when firing), and the
  newest success + the threshold for an age rule.
- **Where results are stored.** Each job's own record carries `runId` and
  `trends {evaluatedAt, rules, lastError}`: `lastRun` (publication),
  `digest.lastRun`, `searchEmbedding.lastRun`, `costGuard` (its one storage
  key), and `lastRun` inside `last-run.json` for identity-links and
  kip-pages; the digest and embedding records also carry `sourceRunId` and
  `r2`. `/health.signals` lists those rules after the state rules; an
  enabled job with no stored result shows its analytics rules as `unknown`
  (`no evaluated run yet`).
- **Baselines.** `job.r2ClassA`, like `job.duration` and `digest.rejections`,
  needs 3 previous runs; with fewer it is `unknown`.
- **No run yet.** `/health` cannot see when the flag's deploy happened, so an
  enabled job with no run stays `unknown` (never `firing`); a stall of a job
  that ran once is caught by its `job.missed` age.
- **Not a run.** A cost-guard check that stops as `unconfigured` stores
  nothing today, so it writes no point; dry runs write none; a refused
  digest or embedding alarm logs with a `runId` but writes no point.
- **Cost-guard `runId`.** The scheduled tick names it from its own
  `scheduledTime` and passes it to the object (`x-run-id`), so the tick's
  log line and the check carry the same id.
- **`digest.freshness` after a failed digest.** The rule reads only
  `digest.lastRun`, the digest's one stored record. When that last run
  failed, the record holds no successful completion, so the rule is
  `unknown`; it is not measured from the latest ok run (no such time is
  stored). A failed run is caught by `job.failures` instead.
- **Edge rows from verification.** The test plan also pins the
  `job.r2ClassA` floors (1,000 and 5,000 against a median of 100), the
  embedding `job.missed` warn edge (2 h), `source.success` taking the newest
  run of a UTC day, and `pollTruncated` reaching `c4` through the record
  mapping; a dry-run cost check writes no point (OB23 test in
  `test/cost-guard.test.ts`).

### Correlation through one SQL interface

10. The join key is `runId`: WAE `index1`, the log field `runId`, and (slice
    3) the span attribute `osskb.run_id`. The SQL API exposes both
    `events.analyticsEngine."osskb_signals_<env>"` and `logs.workersLogs`, so
    one SQL interface can put a run's metrics beside its log lines. Whether
    the Workers binding can read `logs.workersLogs`, and which column holds a
    logged `runId`, are not documented; OB21 checks both on Dev (by the
    introspection endpoint with `include_custom_attributes=true`). Until then
    the join is an operator query, not Worker code.

### Slice 2: structured logs (later)

11. One log schema: `{event, level, runId, kind, env, ...}` with a fixed
    event-name list per phase (start, source read, write, finish, retry,
    error), so a query by `runId` reconstructs one run. Errors keep going
    through `console.error`, so Workers Issues (D3) can group them.

### Slice 3: traces (later, owner decision D2)

12. Only after D2: `observability.traces.enabled: true` at the rate the owner
    picks, and custom spans (`tracing.enterSpan`) around the pipeline phases
    with attribute `osskb.run_id = runId`; `faas.invocation_id` joins spans
    of one invocation.

## Test plan

Generated from `apps/data-publisher-worker/test/signals.cases.ts` by
`bun run docs:test-plan`; `signals.test.ts` runs every row (boundary at,
just under and just over each threshold). Slice 1 added rows for the
2026-10-13 Class A shape, a disabled digest, an enabled job with no run, a
job without a wall budget, and moved the `r2Counted` 0 row to the cost guard
(D8: the digest counts R2 now). D11 (2026-10-23) replaced the `825 / 821`
`firing` row with the excess boundaries (3, max(50, 0.5 × copied)), the
2026-10-23 manual run with and without its counters, and a conditional-miss
row, the miss cap boundary (50 vs 51, A1) and the 2026-10-13 recurrence
with counters; the 2026-10-13 shape still fires.

<!-- test-plan:start apps/data-publisher-worker/test/signals.cases.ts -->
| id | rule | input | status |
| --- | --- | --- | --- |
| OB5 | publication.freshness | 24 h 30 min | ok |
| OB5 | publication.freshness | 24 h 30 min 1 s | warn |
| OB5 | publication.freshness | 27 h | warn |
| OB5 | publication.freshness | 27 h 0 min 1 s | firing |
| OB6 | source.success | jira failed on 10-19 only | warn |
| OB6 | source.success | jira failed on 10-19 and 10-20 | firing |
| OB6 | source.success | jira failed twice on 10-20 (one day) | warn |
| OB6 | source.success | jira failed early 10-19, ok later 10-19, failed 10-20 | warn |
| OB7 | publication.pollTruncated | true since 47 h 59 min | warn |
| OB7 | publication.pollTruncated | true since 48 h 0 min 1 s | firing |
| OB7 | publication.pollTruncated (from the run record) | lastRun pollTruncated true, previous not | warn |
| OB8 | r2.classAInvariant | 824 / 821 (Example) | ok |
| OB8 | r2.classAInvariant | 827 / 821 (excess 3) | ok |
| OB8 | r2.classAInvariant | 828 / 821 (excess 4) | warn |
| OB8 | r2.classAInvariant | 1,234 / 821 (excess 410, firing above 410.5) | warn |
| OB8 | r2.classAInvariant | 1,235 / 821 (excess 411) | firing |
| OB8 | r2.classAInvariant | 88 / 35 (excess 50, firing floor 50) | warn |
| OB8 | r2.classAInvariant | 89 / 35 (excess 51) | firing |
| OB8 | r2.classAInvariant | 323 / 316, putRetries 4 (2026-10-23 manual run) | ok |
| OB8 | r2.classAInvariant | 323 / 316, conditionalMisses 4 | ok |
| OB8 | r2.classAInvariant | 372 / 316, conditionalMisses 50 (cap, excess 3) | ok |
| OB8 | r2.classAInvariant | 373 / 316, conditionalMisses 51 (1 above the cap, excess 4) | warn |
| OB8 | r2.classAInvariant | 323 / 316, no counters (older record) | warn |
| OB8 | r2.classAInvariant | 8,190 / 35 (2026-10-13 shape) | firing |
| OB8 | r2.classAInvariant | 8,190 / 35, putRetries 0, conditionalMisses 0 | firing |
| OB8 | r2.classAInvariant | 8,190 / 35, conditionalMisses 8,152 (2026-10-13 recurrence) | firing |
| OB9 | digest.freshness | 48 h | ok |
| OB9 | digest.freshness | 48 h 0 min 1 s | firing |
| OB9 | digest.freshness | digest disabled | no entry |
| OB10 | digest.rejections | 9, median 2 | ok |
| OB10 | digest.rejections | 10, median 3 | firing |
| OB10 | digest.rejections | 10, median 4 | ok |
| OB10 | digest.rejections | 40, 2 previous points | unknown |
| OB24 | job.missed (kip-pages, daily) | last run 24 h 30 min ago | ok |
| OB24 | job.missed (kip-pages, daily) | 24 h 30 min 1 s | warn |
| OB24 | job.missed (kip-pages, daily) | 27 h 0 min 1 s | firing |
| OB24 | job.missed (embedding) | pending 120, last run 2 h ago | ok |
| OB24 | job.missed (embedding) | pending 120, last run 2 h 0 min 1 s ago | warn |
| OB24 | job.missed (embedding) | pending 120, last run 3 h 0 min 1 s ago | firing |
| OB24 | job.missed (embedding) | pending 0, last run 30 h ago | ok |
| OB24 | job.missed (identity-links) | flag unset | no entry |
| OB24 | job.missed (identity-links) | flag set, no run yet | unknown |
| OB25 | job.failures | current failed, previous ok | warn |
| OB25 | job.failures | current and previous failed | firing |
| OB25 | job.failures | current failed, no previous point | warn |
| OB25 | job.failures (identity-links) | current no-input (ok) | ok |
| OB26 | job.duration | 2 × median exactly | ok |
| OB26 | job.duration | 2 × median + 1 ms | warn |
| OB26 | job.duration | 2 previous points only | unknown |
| OB26 | job.duration (retention) | 8 min (80 % of 10 min) | firing |
| OB26 | job.duration (digest, no wall budget) | 60 × median | warn |
| OB27 | job.r2ClassA | 3,000, median 1,000 | ok |
| OB27 | job.r2ClassA | 3,001, median 1,000 | warn |
| OB27 | job.r2ClassA | 900, median 100 | ok |
| OB27 | job.r2ClassA | 1,000, median 100 | ok |
| OB27 | job.r2ClassA | 1,001, median 100 | warn |
| OB27 | job.r2ClassA | 5,000, median 100 | warn |
| OB27 | job.r2ClassA | 5,001, median 100 | firing |
| OB27 | job.r2ClassA (publication 2026-10-13 shape) | 8,190, median 800 | firing |
| OB27 | job.r2ClassA (cost-guard, r2Counted 0) | any | no entry |
<!-- test-plan:end -->

## Acceptance

Each item: precondition → action → observable result → evidence. Every
untagged item is `[pending]` until the slice that implements it removes its
tag.

### Behavior
- OB1: given `OBSERVABILITY_SIGNALS` unset, blank, `off`, `on` or `yes`, resolving it gives off, off, off, on, invalid; while off a run writes no point, makes no query, `/health` has no `signals` key and log lines keep today's shape → worker test.
- OB2: a publication started at 2026-10-20T22:07:00.000Z gets `runId` `publication-2026-10-20T22-07-00-000Z`; its follow-up invocation and an alarm retry keep it; `/health` `lastRun.runId` equals it; a digest run over that release records it as `sourceRunId` → pipeline test.
- OB3: given the Example's `lastRun`, `metricPoint` returns exactly the Example's indexes, blobs and doubles, and a run with a follow-up invocation calls `writeDataPoint` once → point test.
- OB4: at the end of a run, the fake `ANALYTICS_SQL` receives ≤ 3 `SELECT`s on `events.analyticsEngine."osskb_signals_dev"`, each with a `timestamp` bound ≤ 8 days, the run's `runId` excluded as a parameter, no `accountTag` predicate and no `FORMAT`, naming only columns the binding exposes for a WAE dataset (`timestamp`, `index1`, `blob1`–`blob20`, `double1`–`double20`; no `_sample_interval`, no exact `MIN`/`MAX`) and grouping by every selected column so `COUNT(*) AS weight` is one point's weight; no SELECT alias referenced in `WHERE`/`GROUP BY`/`ORDER BY`/`HAVING`, and no column those clauses use aliased (only aggregates carry an alias); the trend result is stored in the run's existing status write (Durable Object write count unchanged) → trend test.
- OB5: `publication.freshness` gives the statuses of the test-plan rows from Durable Object state at read time → case rows.
- OB6: `source.success` gives the statuses of the test-plan rows from history plus the current run (per UTC day, per source) → case rows.
- OB7: `publication.pollTruncated` gives the statuses of the test-plan rows → case rows.
- OB8: `r2.classAInvariant` gives the statuses of the test-plan rows from state (D11: excess = `classA − (copiedObjectCount + 3 + putRetries + min(conditionalMisses, 50))`, warn > 3, firing > max(50, 0.5 × `copiedObjectCount`)); the 2026-10-13 shape (`classA` 8,190, `copiedObjectCount` 35) fires; a record without `putRetries` and `conditionalMisses` counts them as 0 and its entry's `reason` says so → case rows and rule test.
- OB9: `digest.freshness` gives the statuses of the test-plan rows and is absent while the digest is disabled → case rows.
- OB10: `digest.rejections` gives the statuses of the test-plan rows → case rows.
- OB11: `/health.signals` has `{status, evaluatedAt, analyticsEvaluatedAt, rules, lastError}` with one entry per rule of Behavior 5 and its `source`, `status` the worst entry (`unknown` as ok), for the Example (all ok) and for one firing rule; a `/health` read makes no SQL query → health test.
- OB12: every log call in the run path receives an object with `message`, `runId` and `job`, and `message` equals today's text for the same event → log test.
- OB22: given one recorded run of each of the seven jobs (publication, digest, embedding, cost-guard, retention, identity-links, kip-pages), `metricPoint` returns `indexes [runId]`, `blobs [job, env, status, sourceRunId]` and the 12 doubles of Behavior 13 with that job's c1–c6 and `r2Counted` (1 for every job but the cost guard, D8: the digest and the embedding job count their R2 requests through the bucket they read with), and the Example's publication point exactly → point test.
- OB23: a publication tick with `COST_GUARD=monitor` writes two points, `publication-…` and `cost-guard-…`, each once and with its own `runId`; a digest and an embedding run each write one point whose `sourceRunId` is the publication's `runId`; given `writeDataPoint` throwing for one job, that job's result, its `/health` record and every other job's point are unchanged and the error is logged with its `runId` → worker test with a positive control.
- OB24: `job.missed` gives the statuses of the test-plan rows from the records `/health` already reads, per job and schedule, with no entry for a disabled job → case rows.
- OB25: `job.failures` gives the statuses of the test-plan rows; a status counted as ok by the job (`unchanged`, `no-input`) is not a failure → case rows.
- OB26: `job.duration` gives the statuses of the test-plan rows and fires only for a job that declares a wall budget → case rows.
- OB27: `job.r2ClassA` gives the statuses of the test-plan rows and has no entry for a job with `r2Counted` 0 (the cost guard) → case rows.
- OB28: with all seven jobs enabled, one `/health` read makes 0 SQL queries and 0 `writeDataPoint` calls, the same Durable Object and R2 reads as with `OBSERVABILITY_SIGNALS` off (counted on fakes), and returns the same HTTP status and per-job `status`/`ok` whether a signal rule is `ok` or `firing` → health test with a positive control.
- OB29: at the end of a job run, the fake `ANALYTICS_SQL` receives ≤ 1 `SELECT` (≤ 2 for the publication), each filtered by `blob1` = that job, and the trend result lands in the job's existing status write (Durable Object write count, or R2 `put` count for identity-links, kip-pages and retention, unchanged) → trend test.
- OB30: the slice 0 PR changes only the Wrangler versions (`apps/data-publisher-worker`, `apps/web`, `bun.lock`) to ≥ 4.145.0, and CI (`bun run test:ci`) passes on it; `wrangler deploy --dry-run -c wrangler.development.jsonc` with an `analytics` binding added in a scratch copy is accepted → CI run and the dry-run output in the PR; `scripts/test/wrangler-version.test.ts` keeps both packages and the lock at ≥ 4.145.0 (slice 0: 4.148.0).
- OB13: given no history (first deploy) every analytics rule is `unknown` and `signals.status` is `ok`; given no run for 30 h, `publication.freshness` is `firing` at read time without any run or query → evaluation test.
- OB14: given `writeDataPoint` throwing, or the `SIGNALS` or `ANALYTICS_SQL` binding missing, the publication completes and reports ok, the state rules are evaluated, the analytics rules are `unknown` with a reason, and the error is logged with its `runId` → pipeline test.
- OB15: given the SQL query throwing with `retryable: true` it is retried once after a bounded backoff, with `retryable: false` not at all, and on failure the analytics rules are `unknown` and `lastError` is set; given a history row with `weight` 10, or without `weight`, the rules reading it are `unknown` (`sampled`); given two points with the same `index1` (a retried run) they count once → trend test.
- OB16: given a token value in an error text, no data point, query parameter, `/health` body or log object contains it → sanitizer test.

### Budget
- OB17: [measure] slice 1 adds per run 1 `writeDataPoint`, ≤ 3 SQL queries (1 retry each at most), 0 extra Durable Object writes and 0 R2, Workers AI or external HTTP requests; `/health` makes 0 queries and its evaluation stays under 5 ms CPU; measured by `bun test test/signals.test.ts -t OB17` (in `apps/data-publisher-worker`), which counts binding calls and times the evaluation.
- OB18: [measure] slice 1 adds ≤ 100 bytes per log line and ≤ 20 lines per run (≤ 2 KB a run, ≤ 0.2 MB a month for both environments), measured by `bun test test/signals-worker.test.ts -t OB18` (in `apps/data-publisher-worker`) over a recorded run's log calls.

### Observability
- OB19: [deploy] on Dev with `OBSERVABILITY_SIGNALS=on` and Wrangler ≥ 4.145.0, after the first daily tick `/health.signals.status` is `ok`, `lastRun.runId` is set, a SQL query on `osskb_signals_dev` returns one row with `index1` = that `runId` and `_sample_interval` 1, a Workers Logs query on that `runId` returns the run's lines, and the event's platform invocation-id field name is recorded in the feature map.
- OB20: [deploy] after 7 days on Dev, `/health.signals` matches the rules recomputed by hand from the 7 daily `/health` reads and the WAE rows, with no `firing` the owner does not confirm, and every row has `_sample_interval` 1.
- OB31: [deploy] on Dev, after one daily cycle with `OBSERVABILITY_SIGNALS=on`, `osskb_signals_dev` holds one point per job run of that cycle (publication, digest, cost-guard, identity-links, kip-pages, and embedding while pending; retention once enabled), each with its own `runId` matching the job's `/health` record and `_sample_interval` 1, and `/health.signals` has a `job.missed` entry per enabled job.
- OB32: given a put that fails once with a transient R2 error and then succeeds, and a conditional put whose precondition fails, the publication's R2 destination counts `putRetries` 1 and `conditionalMisses` 1 (each also in `classA`); `/health` `lastRun.r2` carries `{classA, classB, putRetries, conditionalMisses}` for that run only; each retried request (put, head or get) logs one line naming the operation, the key and the error, as `{message, runId, job}` while signals are on; a head retry is no put retry → destination and pipeline tests (D11).
- OB21: [deploy] on Dev, the introspection endpoint on `logs.workersLogs` (with `include_custom_attributes=true`) shows the column holding `runId`; one SQL query (HTTP SQL API by the operator, and the binding if it accepts the dataset) returns a run's log lines and its WAE point by `runId`; the spec and feature map record whether the binding can read `logs.workersLogs`.

## Cost estimate per slice

Allowances are those of Verified sources; both environments are on one account.

| Slice | What is added | Volume (both envs) | Cost |
| --- | --- | --- | --- |
| 0. Wrangler ≥ 4.145.0 | a dev-dependency bump | none at runtime | $0 |
| 1. WAE points + rules + `runId` in logs, every job | 1 point per job run; ≤ 2 binding queries per publication run, 1 per other job run (1 retry each at most); ≤ 2 KB of log text per run; no extra Durable Object or R2 write | Dev: 6 daily jobs ≈ 180 runs a month + embedding (hourly only while chunks are pending; ≤ 720 worst case); Prod: publication (+ cost guard once enabled) ≈ 60 → ≤ 1,000 points and ≤ 2,200 queries a month vs 10 million writes and 1 million reads included (≤ 0.01 % and ≤ 0.3 %); ≤ 2 MB of logs vs 20 million events | $0. WAE is not billed yet; at list price still $0 inside the allowance, so nothing counts toward the $5-a-month overage budget (Spec 026). Whether binding queries count as WAE reads, and SQL API pricing, are not documented (D9) |
| 2. Structured logs | ≈ 30 events × ≤ 500 B per run | ≈ 15 KB a run → ≈ 2 MB a month | $0: < 0.01 % of the 50 GB ingestion and 10 GB-month storage (after 2026-12-01) |
| 3. Traces (D2) | automatic spans for every R2, fetch and Durable Object call | a Dev publication makes ≈ 9,500 R2 calls (`classA` 824 + `classB` 8,678 on 2026-10-20), Prod ≈ 8,400; at an **assumed** 0.5–1 KB a span ≈ 5–10 MB a run → ≈ 0.3–0.6 GB a month at rate 1 | $0 within 50 GB if nothing else on the account ingests much; beyond, $0.25 per GB + $0.10 per GB-month. Span size to measure on Dev first |
| Monitors (D5, if adopted) | ≥ 1 query a minute per monitor | not estimated: Monitors and SQL API pricing are not documented | unknown |

## Caveats

- **Adaptive sampling.** WAE samples heavy traffic per index; at about one
  point per run per index nothing should be sampled. That is an inference;
  Behavior 6 makes a sampled row `unknown` (the binding exposes the weight
  only through weighted aggregates, so the query reads `COUNT(*)` per point),
  and OB19 and OB20 check `_sample_interval` on Dev through the WAE SQL API.
- **Retention.** WAE keeps 3 months; the rules look back ≤ 8 days. Longer
  trends need an export, out of scope.
- **Beta.** The SQL API (and so the binding) is beta since 2026-10-02; WAE
  billing has not started. Both can change; a binding failure degrades only
  the analytics rules (Behavior 1, OB14).
- **Ingestion delay.** A point may not be readable right after
  `writeDataPoint`; the current run is therefore taken from memory and
  excluded from the query (Behavior 4).
- **Wrangler.** The repository locks 4.125.0; slice 0 bumps both Worker
  packages to ≥ 4.145.0 on its own and must keep `bun run test:ci` green
  (OB30); the local E2E server (`wrangler pages dev`) and Miniflare move with
  it, which is why it is its own PR.
- **Embedding volume.** The embedding job is the only one that can run more
  than once a day; at its worst (pending chunks all day) it writes 24 points
  a day, still far inside the allowance.

## Decisions

Decided (owner, 2026-10-21):

1. **D1 Metrics store: Workers Analytics Engine**, one data point per run
   with `runId` as the index; trend rules read it through the Analytics SQL
   binding; current-state rules stay on Durable Object state so `/health`
   still judges a stall without WAE.

Decided by owner 2026-10-22 ("都照你建議": every recommendation below is
adopted as written; options and costs kept for the record; D2–D6 keep their
numbers, D7–D10 are new):

2. **D2 Traces.** (a) off; (b) Dev only, `head_sampling_rate` 1 for 7 days
   after slice 2, to measure span size; (c) `persist: false` with an OTLP
   destination. Head sampling is per invocation and most jobs run once a
   day, so a rate below 1 drops whole days. **Recommend (a) now, (b) after
   slice 2.** Cost: (a) $0; (b) an estimated 0.3–0.6 GB a month, inside the
   50 GB shared logs-and-traces allowance from 2026-12-01, so $0 unless
   measured spans are much larger; (c) an external backend's price.
   **Decided (owner, 2026-10-22):** (a) traces off now; (b) Dev only at `head_sampling_rate` 1 for 7 days after slice 2, to measure span size.
3. **D3 Workers Issues.** (a) off; (b) Dev on after slice 2 (errors carry
   `runId`), no automation; (c) Dev and Prod. **Recommend (b).** Cost: $0
   (free, open beta); needs Wrangler ≥ 4.134.0, covered by slice 0. Any
   automation would be a push alert, so none.
   **Decided (owner, 2026-10-22):** (b) Workers Issues on for Dev after slice 2, no automation.
4. **D4 Thresholds.** (a) adopt the provisional values (digest freshness
   48 h, rejection spike ≥ 10 and > 3 × median, `job.missed` 24.5 h / 27 h,
   embedding 2 h / 3 h, `job.duration` 2 × median, `job.r2ClassA` 3 × /
   10 × median with floors 1,000 / 5,000) and confirm them after OB20;
   (b) tune each now from history. **Recommend (a).** Cost: possibly a few
   false `warn`s during the Dev week; no money. Changing one later is a PR.
   **Decided (owner, 2026-10-22):** (a) the provisional thresholds, confirmed after OB20.
5. **D5 Waking the agent, and Monitors.** (a) a Spec 027 amendment: the
   scheduled agent reads `/health` first and starts the model only when
   `signals.status` is `firing` (or `warn` twice); (b) Cloudflare Monitors
   with a webhook; (c) no wake-up, the owner reads `/health` and the UI.
   **Recommend (a)** after OB20. Cost: (a) one `GET /health` per agent
   schedule, model tokens only on `firing`; (b) Monitors pricing is not
   documented, it is push-shaped, cannot see absence without a rewritten
   query, and the rules would be written twice; (c) $0.
   **Decided (owner, 2026-10-22):** (a) a Spec 027 amendment: the agent reads `/health` first and starts the model only on `firing` (or `warn` twice), after OB20.
6. **D6 Joining logs to a run.** (a) an operator query on the HTTP SQL API
   with a token the owner holds; (b) Worker code reads `logs.workersLogs`
   through the binding, if OB21 shows it can. **Recommend (a)**; no Worker
   code reads logs. Cost: (a) $0, manual; (b) query volume and pricing not
   documented.
   **Decided (owner, 2026-10-22):** (a) logs joined to a run by a manual operator query on the HTTP SQL API; no Worker code reads logs.
7. **D7 Wrangler upgrade as its own slice.** (a) slice 0: bump 4.125.0 →
   ≥ 4.145.0 alone (OB30); (b) bundle it into slice 1. **Recommend (a).**
   Cost: one more small PR and CI run; it keeps a toolchain regression
   (Miniflare, `wrangler pages dev`) apart from the signal code.
   **Decided (owner, 2026-10-22):** (a) the Wrangler upgrade to ≥ 4.145.0 is its own slice 0 PR (OB30).
8. **D8 R2 counting in the digest and the embedding job.** (a) slice 1 wraps
   their bucket in the same counting wrapper as identity-links, so
   `r2Counted` is 1 for six of seven jobs; (b) leave them uncounted
   (`r2Counted` 0, no `job.r2ClassA`). **Recommend (a).** Cost: a small code
   change, 0 extra R2 operations; (b) leaves two jobs blind to a Class A
   regression (the 2026-10-07 spike went unseen for 6 days).
   **Decided (owner, 2026-10-22):** (a) slice 1 counts R2 in the digest and the embedding job too.
9. **D9 Signals inside the cost guard.** (a) no new Spec 026 metric: ≤ 1,000
   points and ≤ 2,200 queries a month are ≤ 0.3 % of the included allowance
   and WAE is not billed yet; revisit when Cloudflare starts billing WAE or
   prices the SQL API; (b) add WAE writes and reads to the $5 budget now.
   **Recommend (a).** Cost: (a) $0; (b) a GraphQL dataset and code for a
   number that stays $0.
   **Decided (owner, 2026-10-22):** (a) no new Spec 026 metric; revisit when Cloudflare bills WAE or prices the SQL API.
10. **D10 Job stalls in the web UI.** Today the site shows only the
    publication's freshness (Spec 010, 011, 021); other jobs' stalls are in
    `/health` JSON only, short of the owner's rule that stalls are visible in
    the UI. (a) `/health` only (plus Spec 027 `get_health`); (b) a later
    slice: the existing stall indicator also says "a background job is
    stalled or failing" (job name, since when) when `signals.status` is
    `firing`, read by the Pages Function from the publisher's `/health`
    with a 5-minute cache; (c) a separate jobs page. **Recommend (b)** after
    the Dev week (OB20). Cost: ≤ 288 `/health` reads a day per environment;
    each reads the two `last-run.json` objects (identity-links, kip-pages),
    ≤ 17,000 Class B a month vs 10 million included, so $0; no Analytics
    Engine query (Behavior 18).
    **Decided (owner, 2026-10-22):** (b) after OB20, the existing UI stall indicator also shows a stalled or failing background job.

11. **D11 `r2.classAInvariant` tolerates counted retries** (owner,
    2026-10-23, "Option A"). The manual Dev run
    `publication-2026-10-23T02-52-13-074Z` fired the rule at `classA` 323
    against `copiedObjectCount` 316 + 3, with Class B exact (8,814 = 316 +
    8,495 + 3): the 4 extra Class A requests were put retries (up to 3
    attempts, each billed, none logged) or conditional puts that found the
    key (counted as reused). Decided: the publication's R2 destination
    counts `putRetries` and `conditionalMisses` into `lastRun.r2` and logs
    each retry with the run's `runId` (OB32); the rule judges
    excess = `classA − (copiedObjectCount + 3 + putRetries +
    min(conditionalMisses, 50))`, `warn` above 3, `firing` above max(50,
    0.5 × `copiedObjectCount`); a record without the counters counts them
    as 0 and says so. **A1 (owner, 2026-10-23):** at most 50 conditional
    misses are subtracted (`classAInvariantMissCap`, equal to the firing
    floor); put retries stay fully subtracted. Without the cap a recurrence
    of the 2026-10-13 cause (a conditional put on every existing key) would
    be counted as `conditionalMisses` and hidden; with it the rule catches a
    recurrence itself (8,190 / 35 with 8,152 misses: excess 8,102, `firing`),
    besides `job.r2ClassA` and the cost guard.

## Rollout

0. **Slice 0 (PR, prerequisite):** Wrangler 4.125.0 → ≥ 4.145.0 in both
   Worker packages and `bun.lock`, nothing else; OB30 (D7).
1. **Slice 1 (PR):** data points for all seven jobs (retention's when Spec
   029 lands), rules, `runId`, behind `OBSERVABILITY_SIGNALS` unset and no
   new binding in any environment; OB1–OB18, OB22–OB29.
2. **Dev enable (PR):** `SIGNALS` (`osskb_signals_dev`) and `ANALYTICS_SQL`
   bindings, `OBSERVABILITY_SIGNALS=on`; OB19, OB21 and OB31 after the next
   daily cycle, OB20 after 7 days. Stop and roll back (unset the flag) on a `firing` the
   owner does not confirm, a failed publication caused by the signal code,
   or a sampled row.
3. **Prod (release)** after OB20, with `osskb_signals_prod`.
4. **Slice 2** (structured logs), then D3; job stalls in the web UI (D10);
   **slice 3** only after D2.

## Non-goals

- Push alerts or notifications (owner rule); Monitors in slice 1.
- Any Analytics Engine or SQL query from `/health` (public endpoint).
- Recomputing the cost guard's budget or Class A spike (Spec 026 owns them).
- The agent's diagnosis and any change to Spec 027 (D5 is its amendment).
- Site consistency (A6), CI status (A9) and cost thresholds (A5, Spec 026).
- Reading R2 directly; any new R2 operation.
- Traces in slice 1; OTLP export destinations.
- Thresholds as runtime config; dashboards; history beyond WAE's 3 months.
