# Spec 028: Observability signals (metrics first)

Status: Draft (owner intent 2026-10-21: metrics → structured logs → traces; D1 decided 2026-10-21: metrics in Workers Analytics Engine; spec only, nothing implemented)
Date: 2026-10-21
Traceability: enforced
Builds on: Spec 010, 011, 018, 021 (freshness and stalls), Spec 008 and 018 (R2 Class A invariant), Spec 014 (digest), Spec 026 (cost guard), Spec 027 (read-only SRE agent, PR #106, not merged)

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
  ≥ 4.145.0, so **slice 1 upgrades Wrangler** (Workers Issues, D3, needs
  ≥ 4.134.0 too).

### Verified sources (read 2026-10-21)

| Fact | Source | Verified |
| --- | --- | --- |
| Workers Analytics Engine (WAE) pricing: Paid includes 10 million data points written and 1 million read queries a month, then $0.25 per million writes and $1.00 per million reads; **not billed yet**; Free 100,000 writes and 10,000 reads a day | [WAE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) | documented |
| WAE limits: 20 blobs, 20 doubles, 1 index (≤ 96 bytes) per point; 16 KB of blobs; 250 points per invocation; **3-month retention**; adaptive sampling at write and read (`_sample_interval`) | [Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/), [Sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/) | documented |
| WAE write: binding `analytics_engine_datasets: [{binding, dataset}]`; `writeDataPoint({blobs, doubles, indexes})` returns immediately (written in the background); exactly one index | [Get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/) | documented |
| Analytics SQL Workers binding: `"analytics": {"binding": "ANALYTICS_SQL"}`, Wrangler ≥ 4.145.0; `env.ANALYTICS_SQL.query({query, params})` → `{data, rows, statistics {elapsed_ms, rows_read, bytes_read}}`; one `SELECT`; time filters in SQL; no `FORMAT`, no `accountTag` predicate (the binding scopes the account); **no API token**; no automatic retry, a thrown error has `retryable`; WAE tables as `events.analyticsEngine."<dataset>"`; Log Explorer-backed datasets not supported | [Workers binding](https://developers.cloudflare.com/analytics/sql-api/workers-binding/) | documented; beta status, limits and pricing not stated on the page |
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
new; every other value copied from `lastRun`):

```text
indexes: ["pub-2026-10-20T22-07-00-000Z"]
blobs:   ["publication", "development", ""]                 // kind, env, sourceRunId
doubles: [1, 1, 1, 1, 0, 824, 821, 0, 1792534039086]         // ok, github, mail, jira, pollTruncated, classA, copiedObjectCount, rejections, completedAtMs
```

Rules at 2026-10-20 23:45 UTC (`state` = the Durable Object's current
status, read on every `/health`; `analytics` = WAE history, evaluated at the
end of each run):

| Rule | Source | Value | Threshold | Status |
| --- | --- | --- | --- | --- |
| `publication.freshness` | state | 1 h 38 min since the newest `lastSuccessAt` | warn > 24.5 h, firing > 27 h | ok |
| `r2.classAInvariant` | state | 824 ≤ 821 + 3 | firing when `classA > copiedObjectCount + 3` | ok |
| `digest.freshness` | state | 56 min | firing > 48 h | ok |
| `source.success` (github, mail, jira) | analytics | all `ok` | firing after 2 consecutive UTC days failed | ok |
| `publication.pollTruncated` | analytics | false | firing when true for > 48 h | ok |
| `digest.rejections` | analytics | 5 | firing when ≥ 10 and > 3 × median of the previous 7 | ok |

Expected `/health.signals`: `{status: "ok", evaluatedAt:
"2026-10-20T23:45:03Z", analyticsEvaluatedAt: "2026-10-20T22:49:09Z",
rules: [6 entries, all "ok"]}`. The 2026-10-13 hourly runs (`classA` ≈ 8,190,
`copiedObjectCount` ≈ 35) would make `r2.classAInvariant` `firing`.

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
   - Push alerts, Monitors, Workers Issues automations, traces: owner
     decisions (D2, D3, D5).
3. **Simplify.** `metricPoint(status)`, `trendRules(current, history)` and
   `stateRules(status, trend, now)` are pure functions; the run only writes
   the point, runs ≤ 3 queries and stores the result.
4. **Shorten the cycle.** Thresholds are one generated case table; WAE and
   the SQL binding are faked in tests; no network.
5. **Automate last.** Waking the agent on `firing` is a Spec 027 amendment
   (D5), after a week on Dev.

## Behavior

### Slice 1: metrics in WAE, rules, correlation key

1. `OBSERVABILITY_SIGNALS` unset, blank or `off`: nothing is written or
   queried, `/health` has no `signals` key, log lines keep today's shape. `on`
   enables Behaviors 2–9. Any other value behaves as off with
   `/health.signals` `{status: "unconfigured", reason}`; `on` without the
   `SIGNALS` (WAE) or `ANALYTICS_SQL` binding runs the state rules and marks
   the analytics rules `unknown` with a reason naming the missing binding.
2. Each publication run gets `runId = "pub-" + <startedAt, ISO with ":" and
   "." replaced by "-">` when it starts; follow-up invocations and alarm
   retries of the same run keep it. A digest run gets `"dig-" + …` and
   records `sourceRunId` (the publication whose release it read). `runId`
   appears on `/health` `lastRun.runId` and `digest.lastRun.runId`.
3. When a run finishes (ok or failed), `metricPoint(status)` builds one data
   point from values already in the run status, with the fixed positional
   schema of the Example (`indexes: [runId]`; `blobs: [kind, env,
   sourceRunId]`; `doubles: [ok, github, mail, jira, pollTruncated, classA,
   copiedObjectCount, rejections, completedAtMs]`, unused slots 0), and calls
   `env.SIGNALS.writeDataPoint` once per run, not per invocation. Datasets:
   `osskb_signals_dev` and `osskb_signals_prod` (one account, so one per
   environment).
4. Right after the write, `trendRules` reads history through
   `env.ANALYTICS_SQL.query` with ≤ 3 parameterized `SELECT`s on
   `events.analyticsEngine."osskb_signals_<env>"`, each bounded by
   `timestamp` (≤ 8 days back), excluding `index1 = runId` (the point just
   written may not be readable yet), and combines the history with the
   current status in memory. The result `{evaluatedAt, rules}` is stored in
   the status write the run already makes (no extra Durable Object write).
   `/health` never queries WAE.
5. Rules (thresholds are one const profile in code; changing one is a PR):

   | Rule | Source | Input | warn | firing |
   | --- | --- | --- | --- | --- |
   | `publication.freshness` | state, at read time | now − newest `sources[*].lastSuccessAt` (a failed run carries it forward) | > 24.5 h (Spec 021 `OVERDUE_AFTER_MS`) | > 27 h (Spec 010 `STALE_AFTER_MS`) |
   | `r2.classAInvariant` | state | `lastRun` | — | `classA > copiedObjectCount + 3` |
   | `digest.freshness` (only when the digest is enabled) | state, at read time | now − `digest.lastRun.completedAt` of the newest ok run | — | > 48 h |
   | `source.success` (per source) | analytics | newest point per UTC day, plus the current run | current run failed | the newest runs on 2 consecutive UTC days failed |
   | `publication.pollTruncated` | analytics | streak of `pollTruncated = 1` ending at the current run | current run true | streak older than 48 h |
   | `digest.rejections` | analytics | current digest run vs the previous 7 digest points | — | ≥ 10 and > 3 × median (needs ≥ 3 previous) |

   Each rule entry is `{id, source, status: ok|warn|firing|unknown, value,
   threshold, since, runId}`; `since` is when the condition first held,
   `runId` the newest run that shows it. Missing data is `unknown`, never
   `firing`.
6. A history row with `_sample_interval ≠ 1` makes the rules that read it
   `unknown` with reason `sampled`: at about one point a day per environment
   sampling is not expected (an inference, checked by OB19), and an exact
   rule must not run on a sample.
7. `/health.signals` = `{status, evaluatedAt, analyticsEvaluatedAt, rules,
   lastError}`; `status` is the worst rule status (`unknown` counts as ok).
   This is the hand-off contract for Spec 027: the agent reads it through
   `get_health` and does not recompute thresholds.
8. Every log line emitted in a run's path (`pipeline.ts`, the publication,
   follow-up and cost-guard lines of `index.ts`, digest and embedding runners)
   is `console.log|error({message, runId, kind, ...})` (an object, so Workers
   Logs indexes `runId`); `message` is today's text and still passes the
   sanitizer.
9. No data point, rule entry, query parameter or log field contains a token
   or a request body.

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
`bun run docs:test-plan` once slice 1 adds the case file; until then the
rows below are the intended thresholds (boundary at, just under and just
over each).

| id | rule | input | status |
| --- | --- | --- | --- |
| OB5 | `publication.freshness` | 24 h 30 min | ok |
| OB5 | `publication.freshness` | 24 h 30 min 1 s | warn |
| OB5 | `publication.freshness` | 27 h | warn |
| OB5 | `publication.freshness` | 27 h 0 min 1 s | firing |
| OB6 | `source.success` | jira failed on 10-19 only | warn |
| OB6 | `source.success` | jira failed on 10-19 and 10-20 | firing |
| OB6 | `source.success` | jira failed twice on 10-20 (one day) | warn |
| OB7 | `publication.pollTruncated` | true since 47 h 59 min | warn |
| OB7 | `publication.pollTruncated` | true since 48 h 0 min 1 s | firing |
| OB8 | `r2.classAInvariant` | 824 / 821 (Example) | ok |
| OB8 | `r2.classAInvariant` | 825 / 821 | firing |
| OB9 | `digest.freshness` | 48 h | ok |
| OB9 | `digest.freshness` | 48 h 0 min 1 s | firing |
| OB10 | `digest.rejections` | 9, median 2 | ok |
| OB10 | `digest.rejections` | 10, median 3 | firing |
| OB10 | `digest.rejections` | 10, median 4 | ok |
| OB10 | `digest.rejections` | 40, 2 previous points | unknown |

## Acceptance

Each item: precondition → action → observable result → evidence. Every
untagged item is `[pending]` until the slice that implements it removes its
tag.

### Behavior
- OB1: [pending] given `OBSERVABILITY_SIGNALS` unset, blank, `off`, `on` or `yes`, resolving it gives off, off, off, on, invalid; while off a run writes no point, makes no query, `/health` has no `signals` key and log lines keep today's shape → worker test.
- OB2: [pending] a publication started at 2026-10-20T22:07:00.000Z gets `runId` `pub-2026-10-20T22-07-00-000Z`; its follow-up invocation and an alarm retry keep it; `/health` `lastRun.runId` equals it; a digest run over that release records it as `sourceRunId` → pipeline test.
- OB3: [pending] given the Example's `lastRun`, `metricPoint` returns exactly the Example's indexes, blobs and doubles, and a run with a follow-up invocation calls `writeDataPoint` once → point test.
- OB4: [pending] at the end of a run, the fake `ANALYTICS_SQL` receives ≤ 3 `SELECT`s on `events.analyticsEngine."osskb_signals_dev"`, each with a `timestamp` bound ≤ 8 days, the run's `runId` excluded as a parameter, no `accountTag` predicate and no `FORMAT`; the trend result is stored in the run's existing status write (Durable Object write count unchanged) → trend test.
- OB5: [pending] `publication.freshness` gives the statuses of the test-plan rows from Durable Object state at read time → case rows.
- OB6: [pending] `source.success` gives the statuses of the test-plan rows from history plus the current run (per UTC day, per source) → case rows.
- OB7: [pending] `publication.pollTruncated` gives the statuses of the test-plan rows → case rows.
- OB8: [pending] `r2.classAInvariant` gives the statuses of the test-plan rows from state; the 2026-10-13 shape (`classA` 8,190, `copiedObjectCount` 35) fires → case rows.
- OB9: [pending] `digest.freshness` gives the statuses of the test-plan rows and is absent while the digest is disabled → case rows.
- OB10: [pending] `digest.rejections` gives the statuses of the test-plan rows → case rows.
- OB11: [pending] `/health.signals` has `{status, evaluatedAt, analyticsEvaluatedAt, rules, lastError}` with one entry per rule of Behavior 5 and its `source`, `status` the worst entry (`unknown` as ok), for the Example (all ok) and for one firing rule; a `/health` read makes no SQL query → health test.
- OB12: [pending] every log call in the run path receives an object with `message`, `runId` and `kind`, and `message` equals today's text for the same event → log test.

### Failure and retry
- OB13: [pending] given no history (first deploy) every analytics rule is `unknown` and `signals.status` is `ok`; given no run for 30 h, `publication.freshness` is `firing` at read time without any run or query → evaluation test.
- OB14: [pending] given `writeDataPoint` throwing, or the `SIGNALS` or `ANALYTICS_SQL` binding missing, the publication completes and reports ok, the state rules are evaluated, the analytics rules are `unknown` with a reason, and the error is logged with its `runId` → pipeline test.
- OB15: [pending] given the SQL query throwing with `retryable: true` it is retried once after a bounded backoff, with `retryable: false` not at all, and on failure the analytics rules are `unknown` and `lastError` is set; given a history row with `_sample_interval` 10 the rules reading it are `unknown` (`sampled`); given two points with the same `index1` (a retried run) they count once → trend test.
- OB16: [pending] given a token value in an error text, no data point, query parameter, `/health` body or log object contains it → sanitizer test.

### Budget
- OB17: [measure] slice 1 adds per run 1 `writeDataPoint`, ≤ 3 SQL queries (1 retry each at most), 0 extra Durable Object writes and 0 R2, Workers AI or external HTTP requests; `/health` makes 0 queries and its evaluation stays under 5 ms CPU; measured by `bun test test/signals.test.ts -t OB17` (in `apps/data-publisher-worker`), which counts binding calls and times the evaluation.
- OB18: [measure] slice 1 adds ≤ 100 bytes per log line and ≤ 20 lines per run (≤ 2 KB a run, ≤ 0.2 MB a month for both environments), measured by `bun test test/signals.test.ts -t OB18` over a recorded run's log calls.

### Observability
- OB19: [deploy] on Dev with `OBSERVABILITY_SIGNALS=on` and Wrangler ≥ 4.145.0, after the first daily tick `/health.signals.status` is `ok`, `lastRun.runId` is set, a SQL query on `osskb_signals_dev` returns one row with `index1` = that `runId` and `_sample_interval` 1, a Workers Logs query on that `runId` returns the run's lines, and the event's platform invocation-id field name is recorded in the feature map.
- OB20: [deploy] after 7 days on Dev, `/health.signals` matches the rules recomputed by hand from the 7 daily `/health` reads and the WAE rows, with no `firing` the owner does not confirm, and every row has `_sample_interval` 1.
- OB21: [deploy] on Dev, the introspection endpoint on `logs.workersLogs` (with `include_custom_attributes=true`) shows the column holding `runId`; one SQL query (HTTP SQL API by the operator, and the binding if it accepts the dataset) returns a run's log lines and its WAE point by `runId`; the spec and feature map record whether the binding can read `logs.workersLogs`.

## Cost estimate per slice

Allowances are those of Verified sources; both environments are on one account.

| Slice | What is added | Volume (both envs) | Cost |
| --- | --- | --- | --- |
| 1. WAE points + rules + `runId` in logs | 1 point per run; ≤ 3 binding queries per run; ≤ 2 KB of log text per run; no extra Durable Object write | ≈ 3 runs a day (Dev publication + digest, Prod publication) → ≈ 90 points and ≤ 300 queries a month vs 10 million writes and 1 million reads included; ≤ 0.2 MB of logs | $0. WAE is not billed yet; at list price still $0 inside the allowance. Whether binding queries count as WAE reads, and SQL API pricing, are not documented |
| 2. Structured logs | ≈ 30 events × ≤ 500 B per run | ≈ 15 KB a run → ≈ 2 MB a month | $0: < 0.01 % of the 50 GB ingestion and 10 GB-month storage (after 2026-12-01) |
| 3. Traces (D2) | automatic spans for every R2, fetch and Durable Object call | a Dev publication makes ≈ 9,500 R2 calls (`classA` 824 + `classB` 8,678 on 2026-10-20), Prod ≈ 8,400; at an **assumed** 0.5–1 KB a span ≈ 5–10 MB a run → ≈ 0.3–0.6 GB a month at rate 1 | $0 within 50 GB if nothing else on the account ingests much; beyond, $0.25 per GB + $0.10 per GB-month. Span size to measure on Dev first |
| Monitors (D5, if adopted) | ≥ 1 query a minute per monitor | not estimated: Monitors and SQL API pricing are not documented | unknown |

## Caveats

- **Adaptive sampling.** WAE samples heavy traffic per index; at about one
  point per run per index nothing should be sampled. That is an inference;
  Behavior 6 makes a sampled row `unknown`, and OB19 and OB20 check
  `_sample_interval` on Dev.
- **Retention.** WAE keeps 3 months; the rules look back ≤ 8 days. Longer
  trends need an export, out of scope.
- **Beta.** The SQL API (and so the binding) is beta since 2026-10-02; WAE
  billing has not started. Both can change; a binding failure degrades only
  the analytics rules (Behavior 1, OB14).
- **Ingestion delay.** A point may not be readable right after
  `writeDataPoint`; the current run is therefore taken from memory and
  excluded from the query (Behavior 4).
- **Wrangler.** The repository locks 4.125.0; slice 1 bumps both Worker
  packages to ≥ 4.145.0 and must keep `bun run test:ci` green.

## Decisions

Decided (owner, 2026-10-21):

1. **D1 Metrics store: Workers Analytics Engine**, one data point per run
   with `runId` as the index; trend rules read it through the Analytics SQL
   binding; current-state rules stay on Durable Object state so `/health`
   still judges a stall without WAE.

Still open:

2. **D2 Traces: whether, when, and the rate.** Not in slice 1. Head sampling
   decides per invocation and the publisher runs about once a day, so a rate
   of 0.1 would drop 9 of 10 daily runs entirely: for this Worker the useful
   choices are 1 (≈ 0.3–0.6 GB a month, measured on Dev first) or off.
   Alternative: `persist: false` with an OTLP destination.
3. **D3 Workers Issues.** Free, open beta; recommend enabling on Dev after
   slice 2 (errors carry `runId`), with no automation; "no push alerts"
   applies to any automation.
4. **D4 Thresholds.** The 48 h digest freshness and the rejection spike
   (≥ 10 and > 3 × median) are first guesses; confirm after OB20.
5. **D5 Waking the agent, and Monitors.** Recommend a Spec 027 amendment:
   the scheduled run reads `/health` first and starts the model only when
   `signals.status` is `firing` (or `warn` twice). Monitors (webhook) is the
   alternative wake-up path if the agent moves to Cloudflare; not adopted
   now (Solution space).
6. **D6 Binding for logs.** If OB21 shows the binding cannot read
   `logs.workersLogs`, the run-level join stays an operator query (HTTP SQL
   API with a token the owner holds); no Worker code reads logs.

## Rollout

1. **Slice 1 (PR):** Wrangler ≥ 4.145.0, data points, rules, `runId`, behind
   `OBSERVABILITY_SIGNALS` unset and no new binding in any environment;
   OB1–OB18.
2. **Dev enable (PR):** `SIGNALS` (`osskb_signals_dev`) and `ANALYTICS_SQL`
   bindings, `OBSERVABILITY_SIGNALS=on`; OB19 and OB21 after the next tick,
   OB20 after 7 days. Stop and roll back (unset the flag) on a `firing` the
   owner does not confirm, a failed publication caused by the signal code,
   or a sampled row.
3. **Prod (release)** after OB20, with `osskb_signals_prod`.
4. **Slice 2** (structured logs), then D3; **slice 3** only after D2.

## Non-goals

- Push alerts or notifications (owner rule); Monitors in slice 1.
- The agent's diagnosis and any change to Spec 027 (D5 is its amendment).
- Site consistency (A6), CI status (A9) and cost thresholds (A5, Spec 026).
- Reading R2 directly; any new R2 operation.
- Traces in slice 1; OTLP export destinations.
- Thresholds as runtime config; dashboards; history beyond WAE's 3 months.
