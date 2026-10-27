# Invariant playbook: `job.failures`

Status: active (2026-10-25). The rule is Spec 028 Behavior 16 (`trendRules`
in `apps/data-publisher-worker/src/signals/rules.ts`); the agent that reads
this playbook is Spec 027 Amendment (2). Map of signals and rules:
[SRE signal map](../../architecture/sre-signal-map.md).

Kind: **hard** invariant (checked by code; a `firing` entry starts one
diagnosis). Incident type (2), repeated failures.

## Statement

A scheduled job's runs succeed. One failed run is `warn`; two consecutive
failed runs of the same job (one per `runId`, newest first, from the job's
data points) are `firing`, with `since` the end of the first failed run of
the streak.

## Why

A failed run keeps the previous output readable (every job fails closed), so
a failure looks like a stale page a day later, not like an error. One
failure is often a passing upstream blip that the next run absorbs; two in a
row means the next scheduled run will likely fail too.

## Evidence the agent gets

The harness builds this bundle before the first model call. Quote only from it.

| Evidence | Where it comes from |
| --- | --- |
| The rule entry: `job`, `status`, `value` (streak length), `since`, `runId` | `/health.signals.rules[]` |
| The job's state: `lastRun.ok`, `status`, `error`, `at`, `durationMs`, request counts | `/health` for the job (for example `kipPages.lastRun`) |
| The job's last runs: `runId`, `status`, `ok`, `durationMs` | `Q-history`: WAE `osskb_signals_<env>`, `blob1 = job`, 8 days |
| Every job's runs within ± 12 h of `since` | `Q-window`: the same dataset, all jobs |
| Cost guard | `/health.costGuard {mode, status, breaker}` |

## Hard check

`job.failures` is `firing` (Spec 028 Behavior 16). The agent never recomputes it.

## Causes, in order

Check them in this order; stop at the first one the evidence supports. A
diagnosis names the cause by its id (`cause` in the record); `unknown` needs
no runbook.

| # | Cause id | Cause | Distinguishing evidence | Runbook |
| --- | --- | --- | --- | --- |
| 1 | `upstream-unavailable` | The job's upstream (GitHub, cwiki, Jira) was down or erroring | `lastRun.error` names a host with a 5xx answer (`<host> answered 503`), a timeout or a connection error; short `durationMs`; `Q-window` shows other jobs `ok` in the same hours, so the Worker itself ran | [Upstream failures](../cloudflare-data-publisher.md#upstream-failures-job-runs) |
| 2 | `upstream-rate-limited` | The upstream refused for rate: HTTP 403 or 429, or a recorded `retryAfter` | `lastRun.error` names a host with 403 or 429, or the record has `retryAfter` | [Upstream failures](../cloudflare-data-publisher.md#upstream-failures-job-runs) |
| 3 | `deploy-broke-job` | A deploy broke the job | the error is not an upstream answer (a parse or validation error, an exception in the job's code), and the first failed run follows a deploy | [Roll back](../cloudflare-data-publisher.md#roll-back) |
| 4 | `config-invalid` | The job's flag, secret or binding is wrong | the error names a flag value, a missing secret or binding, or an upstream 401 | [Environment map](../cloudflare-data-publisher.md#environment-map) |
| 5 | `unknown` | Unknown | None of the above is supported by the bundle | Say so and list the missing evidence |

## Judgment guidance

- **Cite only the bundle.** Every entry in `evidence` cites one field of an
  item: a path for a JSON item, a quote (an exact substring) for a text item. A
  deterministic check rejects any other citation.
- **Name the host and the status.** For causes 1 and 2, quote the job's
  `lastRun.error` (it carries the host and the HTTP status) and the
  `Q-window` result that shows whether other jobs ran normally.
- **Confidence.** `high`: the error names an upstream 5xx (or 403/429) and
  other jobs are `ok` in `Q-window`. `medium`: the error fits but `Q-window`
  is unavailable or empty. `low`: the error does not name the upstream.
- **Owner actions, never agent actions.** `ownerAction` may suggest checking
  the upstream's status and a manual run of the job once it recovers, as text
  for the owner. The agent never runs, pauses or deploys anything.
