# Spec 028: Observability signals (metrics first)

Status: Draft (owner intent 2026-10-21: metrics → structured logs → traces; spec only, nothing implemented)
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
3. **One correlation key on every signal**: a metric record, a log line and
   (later) a span of the same run carry the same `runId`; Cloudflare's own
   invocation id is added where the platform provides it.
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

### Verified sources (read 2026-10-21)

| Fact | Source | Verified |
| --- | --- | --- |
| Workers Traces: `observability.traces.enabled`, `head_sampling_rate` (default 1); automatic spans for fetch, binding calls (KV, R2, Durable Objects), RPC and handlers (fetch, scheduled, queue); 7-day retention; early beta; `observability.enabled` alone turns on logs only | [Traces](https://developers.cloudflare.com/workers/observability/traces/) | documented |
| Custom spans: `import { tracing } from "cloudflare:workers"` (also `ctx.tracing`), `enterSpan(name, cb, ...args)`, `startActiveSpan`, `startSpan`, `getActiveSpan` | [Custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/) | documented (on the subpage, not the main Traces page) |
| Span attributes: `faas.invocation_id` on every span; `cloudflare.ray_id` on root spans; `faas.cron`, `cloudflare.scheduled_time` on scheduled handlers | [Spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/) | documented |
| Workers Logs: `console.log` of an object is indexed by field (filterable keys); Paid 20 million events a month, $0.60 per million beyond, 7-day retention, until 2026-12-01, then Cloudflare Observability pricing. The page names no per-event request or invocation id field (`$workers.requestId` is **not** on that page) | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) | documented; invocation-id field name unverified (OB19) |
| From 2026-12-01, Paid: 50 GB ingestion and 10 GB-month storage per billing cycle included, $0.25 per GB ingestion and $0.10 per GB-month beyond; logs and traces share the allowance; Free: 0.5 GB a day | [Observability pricing](https://developers.cloudflare.com/observability/pricing/) | documented |
| OTLP export: `observability.traces` / `.logs` take `destinations` and `persist` (default `true`; `false` exports without storing at Cloudflare). Workers infrastructure metrics and custom metrics cannot be exported through OpenTelemetry; only traces and logs | [OpenTelemetry export](https://developers.cloudflare.com/workers/observability/opentelemetry-export/) | documented; that Analytics Engine counts as "custom metrics" is an inference (the page does not name it) |
| Workers Issues: groups occurrences of one Worker's failures (uncaught exception, failed invocation, 5xx, logged error) into issues; per-issue automations to a coding agent, webhook, chat or incident tool; `observability.issues.enabled: true` (Wrangler ≥ 4.134.0); open beta, free; no history before enabling | [Workers Issues](https://developers.cloudflare.com/workers/observability/issues/) | documented |
| Workers Analytics Engine (WAE): Paid includes 10 million data points written and 1 million read queries a month, then $0.25 per million writes and $1.00 per million reads; **not billed yet**; Free 100,000 writes and 10,000 reads a day | [WAE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) | documented |
| WAE limits: 20 blobs, 20 doubles, 1 index (≤ 96 bytes) per point; 16 KB of blobs; 250 points per invocation; 3-month retention; adaptive sampling at write and read (`_sample_interval`; use `sum(_sample_interval)` instead of `count()`) | [Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/), [Sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/) | documented |
| WAE API: binding `analytics_engine_datasets: [{binding, dataset}]`; `writeDataPoint({blobs, doubles, indexes})` returns immediately (written in the background); SQL at `POST /client/v4/accounts/{account_id}/analytics_engine/sql` with a token holding Account Analytics Read (the same permission as Spec 026's `CF_ANALYTICS_TOKEN`) | [Get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/), [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) | documented; query limits not documented |

## Example

Dev `/health`, read 2026-10-20 23:45 UTC (public, unauthenticated `GET`):

```json
{ "environment": "development", "running": false, "followUp": null,
  "lastRun": { "ok": true, "completedAt": "2026-10-20T22:07:19.086Z",
    "pollTruncated": false, "copiedObjectCount": 821, "reusedObjectCount": 7854,
    "r2": { "classA": 824, "classB": 8678 },
    "sources": { "github": { "ok": true }, "mail": { "ok": true }, "jira": { "ok": true } } },
  "digest": { "enabled": true,
    "lastRun": { "ok": true, "completedAt": "2026-10-20T22:49:08.123Z",
      "candidates": 449, "rejections": { "unparsable": 4, "empty": 1 } } } }
```

The slice 1 record this run would have stored (`runId` new; every other value
copied from `lastRun`):

```json
{ "runId": "pub-2026-10-20T22-07-00-000Z", "kind": "publication",
  "completedAt": "2026-10-20T22:07:19.086Z", "ok": true,
  "sources": { "github": true, "mail": true, "jira": true },
  "pollTruncated": false, "classA": 824, "copiedObjectCount": 821 }
```

Rules evaluated at 2026-10-20 23:45 UTC with that record (plus a digest
record with 5 rejections and earlier days' records alike):

| Rule | Value | Threshold | Status |
| --- | --- | --- | --- |
| `publication.freshness` | 1 h 38 min since `completedAt` | warn > 24.5 h, firing > 27 h | ok |
| `source.success` (github, mail, jira) | all `ok` | firing after 2 consecutive UTC days failed | ok |
| `publication.pollTruncated` | false | firing when true for > 48 h | ok |
| `r2.classAInvariant` | 824 ≤ 821 + 3 | firing when `classA > copiedObjectCount + 3` | ok |
| `digest.freshness` | 56 min | firing > 48 h | ok |
| `digest.rejections` | 5 | firing when ≥ 10 and > 3 × median of the previous 7 | ok |

Expected `/health.signals`: `{status: "ok", evaluatedAt:
"2026-10-20T23:45:03Z", rules: [6 entries, all "ok"]}`. The 2026-10-13 hourly
runs (`classA` ≈ 8,190, `copiedObjectCount` ≈ 35) would make
`r2.classAInvariant` `firing` with `since` = the first such run's
`completedAt` and `runId` = the newest offending run.

## Simplification review

1. **Question every requirement.**
   - A run record: needed because two rules (A2, A3) judge history that one
     `/health` read cannot show. Owner (intent 1).
   - `runId`: owner (intent 3). No existing id fits: `feedReleaseId` exists
     only for a successful run, and a publication spans several invocations
     (follow-ups, alarm retries), so Cloudflare's per-invocation id cannot be
     the run key; it is added beside it (Behavior 6).
   - `/health.signals`: the owner reads `/health` (owner rule: no push
     alerts; the UI shows it) and Spec 027's `get_health` already reads
     it, so no new route.
2. **Delete.**
   - A5 cost guard %: `costGuard.status` (Spec 026) already applies 60 / 80;
     a second copy would drift. **Deleted**; the agent reads `costGuard`.
   - A6 site consistency (Pages `/api/feed` vs `/health`): the Worker cannot
     see the Pages site; `bun run verify:health` already compares them.
     **Deferred** to the CI/agent side (non-goal here).
   - A9 CI on `main`/tag: GitHub, not the Worker; Spec 027's
     `get_ci_status` covers it. **Deleted** from this spec.
   - An external metrics store in slice 1: the rules need ≤ 14 records per
     kind; Durable Object storage already holds run state, needs no binding,
     no token and no query API. WAE stays an owner decision (D1).
   - A new cron or route: rules are evaluated when `/health` is read, so a
     stall (no run at all) still shows.
   - Push alerts, Workers Issues automations, traces: owner decisions (D2, D3).
3. **Simplify.** `metricRecord(status)` and `evaluateSignals(records, now)`
   are pure functions; the Durable Object only appends and trims.
4. **Shorten the cycle.** Thresholds are one generated case table; tests use
   recorded `/health` shapes and a fixed clock; no network.
5. **Automate last.** Waking the agent on `firing` is a Spec 027 amendment,
   after the rules have run on Dev for a week (Rollout).

## Behavior

### Slice 1: metric records, rules, correlation key

1. `OBSERVABILITY_SIGNALS` unset, blank or `off`: no record is written,
   `/health` has no `signals` key, no log line changes shape. `on` enables
   Behaviors 2–8. Any other value behaves as off and `/health.signals` is
   `{status: "unconfigured", reason}`.
2. Each publication run gets `runId = "pub-" + <startedAt, ISO with ":" and
   "." replaced by "-">` when it starts; follow-up invocations and alarm
   retries of the same run keep it. A digest run gets `"dig-" + …` and
   records `sourceRunId` (the publication whose release it read). `runId`
   appears on `/health` `lastRun.runId` and `digest.lastRun.runId`.
3. When a run finishes (ok or failed), `metricRecord(status)` builds one
   record from values already in the run status: publication `{runId, kind,
   completedAt, ok, sources {key: ok}, pollTruncated, classA,
   copiedObjectCount}`; digest `{runId, kind, sourceRunId, completedAt, ok,
   rejections (sum of values)}`. No new measurement is taken.
4. The owning Durable Object (`PipelineState` for publications, `DigestRun`
   for digests) appends the record to one storage key and keeps the newest
   14; one storage write per run, no R2 operation.
5. Reading `/health` evaluates `evaluateSignals(records, now)` with these
   rules (thresholds are one const profile in code; changing one is a PR):

   | Rule | Input | warn | firing |
   | --- | --- | --- | --- |
   | `publication.freshness` | now − newest ok publication `completedAt` | > 24.5 h (Spec 021 `OVERDUE_AFTER_MS`) | > 27 h (Spec 010 `STALE_AFTER_MS`) |
   | `source.success` (per source) | newest `sources[key]` per UTC day | newest run failed | the newest runs on 2 consecutive UTC days failed |
   | `publication.pollTruncated` | streak of `pollTruncated: true` | newest run true | streak older than 48 h |
   | `r2.classAInvariant` | newest publication | — | `classA > copiedObjectCount + 3` |
   | `digest.freshness` (only when the digest is enabled) | now − newest ok digest `completedAt` | — | > 48 h |
   | `digest.rejections` | newest digest record | — | ≥ 10 and > 3 × median of the previous 7 (needs ≥ 3 previous) |

   Each rule entry is `{id, status: ok|warn|firing|unknown, value,
   threshold, since, runId}`; `since` is when the condition first held,
   `runId` the newest record that shows it. A rule without enough records is
   `unknown` (never `firing` on missing data).
6. `/health.signals` = `{status, evaluatedAt, rules}`; `status` is the worst
   rule status (`unknown` counts as ok). This is the hand-off contract for
   Spec 027: the agent reads it through `get_health`; it does not recompute
   the thresholds.
7. Every log line emitted in a run's path (`pipeline.ts`, the publication,
   follow-up and cost-guard lines of `index.ts`, digest and embedding runners)
   is `console.log|error({message, runId, kind, ...})` (an object, so Workers
   Logs indexes `runId`); the `message` text is the one logged today and
   still passes the sanitizer. The platform's own per-invocation metadata on
   each event is kept as is; its field name is recorded in the feature map
   once OB19 reads a real Dev event.
8. No record, rule entry or log field contains a token or a request body.

### Slice 2: structured logs (later)

9. One log schema for the Worker: `{event, level, runId, kind, env, ...}`
   with a fixed event-name list per phase (start, source read, write, finish,
   retry, error), so a Workers Logs query by `runId` reconstructs one run.
   Errors keep going through `console.error`, so Workers Issues (D3) can group
   them without extra code.

### Slice 3: traces (later, owner decision D2)

10. Only after D2: `observability.traces.enabled: true` with the sampling
    rate the owner picks, and custom spans (`tracing.enterSpan`) around the
    pipeline phases with attribute `osskb.run_id = runId`, so a span joins
    the metric record and log lines by `runId` and Cloudflare's
    `faas.invocation_id` joins spans of one invocation.

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
| OB10 | `digest.rejections` | 40, 2 previous records | unknown |

## Acceptance

Each item: precondition → action → observable result → evidence. Every
untagged item is `[pending]` until the slice that implements it removes its
tag.

### Behavior
- OB1: [pending] given `OBSERVABILITY_SIGNALS` unset, blank, `off`, `on` or `yes`, resolving it gives off, off, off, on, invalid; while off a run writes no record, `/health` has no `signals` key and log lines keep today's shape → worker test.
- OB2: [pending] a publication started at 2026-10-20T22:07:00.000Z gets `runId` `pub-2026-10-20T22-07-00-000Z`; its follow-up invocation and an alarm retry keep it; `/health` `lastRun.runId` equals it; a digest run over that release records it as `sourceRunId` → pipeline test.
- OB3: [pending] given the Example's `lastRun`, `metricRecord` returns exactly the Example record; a failed run yields `ok: false` and the sources' `ok` values → record test.
- OB4: [pending] given 14 stored records, a 15th run leaves the newest 14, with one storage write and no R2 call → Durable Object test.
- OB5: [pending] `publication.freshness` gives the statuses of the test-plan rows → case rows.
- OB6: [pending] `source.success` gives the statuses of the test-plan rows (per UTC day, per source) → case rows.
- OB7: [pending] `publication.pollTruncated` gives the statuses of the test-plan rows → case rows.
- OB8: [pending] `r2.classAInvariant` gives the statuses of the test-plan rows; the 2026-10-13 shape (`classA` 8,190, `copiedObjectCount` 35) fires with `since` at the first offending record → case rows.
- OB9: [pending] `digest.freshness` gives the statuses of the test-plan rows and is absent while the digest is disabled → case rows.
- OB10: [pending] `digest.rejections` gives the statuses of the test-plan rows → case rows.
- OB11: [pending] `/health.signals` has `{status, evaluatedAt, rules}` with one entry per rule of Behavior 5, `status` the worst entry (`unknown` as ok), for the Example (all ok) and for one firing rule → health test.
- OB12: [pending] every log call in the run path receives an object with `message`, `runId` and `kind`, and `message` equals today's text for the same event → log test.

### Failure and retry
- OB13: [pending] given no records (first deploy) every rule is `unknown` and `signals.status` is `ok`; given records but no run for 30 h, `publication.freshness` is `firing` at read time without any run → evaluation test.
- OB14: [pending] given the record write throwing, the publication still completes and reports ok, and the error is logged with its `runId` → pipeline test.
- OB15: [pending] given a crash after the run status is written but before the record, the next run's evaluation treats the gap as missing data (no false `firing` from the missing record); given the same record appended twice (retry), it is stored once (keyed by `runId`) → Durable Object test.
- OB16: [pending] given a token value in an error text, no record, `/health` body or log object contains it → sanitizer test.

### Budget
- OB17: [measure] slice 1 adds per run one Durable Object storage write (record ≤ 1 KB, key ≤ 14 KB) and zero R2, Workers AI or external requests; `/health` evaluation stays under 5 ms CPU for 14 + 14 records; measured by `bun test test/signals.test.ts -t OB17` (in `apps/data-publisher-worker`), which counts calls and times the evaluation.
- OB18: [measure] slice 1 adds ≤ 100 bytes per log line and ≤ 20 lines per run (≤ 2 KB a run, ≤ 0.2 MB a month for both environments), measured by `bun test test/signals.test.ts -t OB18` over a recorded run's log calls.

### Observability
- OB19: [deploy] on Dev with `OBSERVABILITY_SIGNALS=on`, after the first daily tick `/health.signals.status` is `ok`, `lastRun.runId` is set, a Workers Logs query filtered on that `runId` returns the run's lines, and the event's platform invocation-id field name is recorded in the feature map.
- OB20: [deploy] after 7 days on Dev, `/health.signals` matches the rules recomputed by hand from the 7 daily `/health` reads, with no `firing` the owner does not confirm.

## Cost estimate per slice

Allowances are those of Verified sources; both environments are on one account.

| Slice | What is added | Volume | Cost |
| --- | --- | --- | --- |
| 1. Metric records + rules + `runId` in logs | 1 Durable Object write per run; ≤ 2 KB of log text per run; CPU on `/health` | ≈ 2 runs/day/env → ≈ 120 writes and ≤ 0.24 MB of logs a month (both envs) | $0: inside Workers Paid included Durable Object requests and Workers Logs (20 million events; after 2026-12-01, ≪ 50 GB) |
| 1b. (if D1 = WAE) one data point per run | `writeDataPoint` + ≤ 2 SQL reads per day per env | ≈ 120 points and ≈ 120 reads a month vs 10 million / 1 million included | $0 (WAE is not billed yet; at list price still $0 within the allowance) |
| 2. Structured logs | ≈ 30 events × ≤ 500 B per run | ≈ 15 KB/run → ≈ 2 MB a month (both envs) | $0: < 0.01 % of the 50 GB ingestion and 10 GB-month storage |
| 3. Traces (D2) | automatic spans for every R2, fetch and DO call | a Dev publication makes ≈ 9,500 R2 calls (`classA` 824 + `classB` 8,678 on 2026-10-20), Prod ≈ 8,400; assuming 0.5–1 KB a span: ≈ 5–10 MB per run → ≈ 0.3–0.6 GB a month for both at rate 1 | $0 within 50 GB if nothing else on the account ingests much; each GB beyond costs $0.25 + $0.10/GB-month. Span size is an **assumption** to measure on Dev before Prod |

## Decisions still open (owner)

1. **D1 Metrics store.** Recommend slice 1 on Durable Object storage only
   (no binding, no token, rules testable offline). Option: also write each
   record to WAE (3-month history, SQL, $0 today) once a dashboard or
   month-long trend is wanted; reading it needs the Account Analytics Read
   token (the same permission as Spec 026). WAE data cannot be exported via
   OTel, and sampling needs `_sample_interval`-weighted queries.
2. **D2 Traces: whether, when, and the rate.** Not in slice 1. Head sampling
   decides per invocation, and the publisher runs about once a day, so a rate
   of 0.1 would drop 9 of 10 daily runs entirely: for this Worker the useful
   choices are 1 (all, ≈ 0.3–0.6 GB a month, measured first on Dev) or off.
   Alternative: `persist: false` with an OTLP destination, which exports
   without counting toward Cloudflare storage.
3. **D3 Workers Issues.** Free, open beta, groups `console.error` and failed
   invocations; recommend enabling on Dev after slice 2 (errors carry
   `runId`), with no automation until Spec 027 can take a webhook; owner rule
   "no push alerts" applies to any automation.
4. **D4 Thresholds.** The 48 h digest freshness and the rejection spike
   (≥ 10 and > 3 × median) are first guesses from one week of Dev data;
   confirm or adjust after OB20.
5. **D5 Waking the agent.** Recommend a Spec 027 amendment: the scheduled run
   calls `/health` first and starts the model only when `signals.status` is
   `firing` (or `warn` twice), so a healthy day costs no model call.

## Rollout

1. **Slice 1 (PR):** records, rules, `runId`, behind `OBSERVABILITY_SIGNALS`
   unset everywhere; OB1–OB18.
2. **Dev enable (PR):** `OBSERVABILITY_SIGNALS=on`; OB19 after the next
   tick, OB20 after 7 days. Stop and roll back (unset) on a `firing` the
   owner does not confirm, or a failed publication caused by the record write.
3. **Prod (release)** after OB20.
4. **Slice 2** (structured logs), then D3; **slice 3** only after D2.

## Non-goals

- Push alerts or notifications (owner rule).
- The agent's diagnosis and any change to Spec 027 (D5 is its amendment).
- Site consistency (A6) and CI status (A9) checks; cost thresholds (A5,
  Spec 026 owns them).
- Reading R2 directly; any new R2 operation.
- Traces in slice 1; OTLP export destinations.
- Thresholds as runtime config; dashboards.
