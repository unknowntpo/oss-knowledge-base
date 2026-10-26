# Invariant playbook: `job.missed`

Status: proposed example (2026-10-22). The rule is Spec 028 Behavior 15 (PR
#108, not merged); the agent that reads this playbook is a pending Spec 027
amendment (PR #106). Nothing here is implemented. Map of signals and rules:
[SRE signal map](../../architecture/sre-signal-map.md).

Kind: **hard** invariant (checked by code; a `firing` entry starts one
diagnosis). Incident type (1), missed or stalled job.

## Statement

Every enabled scheduled job completes a run within its expected interval.

| Job | warn | firing | Source |
| --- | --- | --- | --- |
| `publication`, `digest`, `cost-guard` (by `checkedAt`), `identity-links`, `kip-pages`, `retention`, `identity-backfill` (daily; a `complete` record is not due) | > 24.5 h since its last run of any status | > 27 h | Spec 028 Behavior 15 and D4; the 27 h boundary is Spec 018's (Spec 010 `STALE_AFTER_MS`), 24.5 h is Spec 021's `OVERDUE_AFTER_MS` |
| `embedding` (only while `pending` > 0) | > 2 h | > 3 h | Spec 028 Behavior 15 and D4 |

A disabled job has no entry. An enabled job with no run yet is `unknown` for
27 h after its flag's deploy, then `firing`.

## Why

A job that stops is silent: the previous release stays readable, so nothing
looks broken except the age. Dev published nothing for about 49 h
(2026-09-30 01:07 → 10-02 02:42 UTC) and the page still said "Published
snapshot" (Spec 010 Intent, Spec 011 Evidence). The owner's rule is that a
stall is visible, not pushed; this playbook explains a stall once it fires.

## Evidence the agent gets

The harness builds this bundle before the first model call. Quote only from it.

| Evidence | Where it comes from |
| --- | --- |
| The rule entry: `job`, `status`, `value` (age), `since`, `runId`, last `completedAt` | `/health.signals.rules[]` |
| The job's last N data points: start (`runId`), `status`, `durationMs` | WAE `osskb_signals_<env>`, filtered by `blob1 = job`, 8 days |
| The job's current state | DO state (`lastRun`, `running`, `scheduled`, `followUp`, `phase` for the publication; `digest`, `searchEmbedding`) or `last-run.json` (`identityLinks`, `kipPages`, `retention`, `identityBackfill`) as `/health` serves it |
| Cost guard | `/health` `costGuard {mode, status, breaker}`: a tripped breaker under `enforce` pauses the publication |
| Deploys and CI around `since` | GitHub Actions runs on `main` and `v*` tags within ± 24 h of `since` (public API) |
| Upstream health | `lastRun.sources[*] {ok, lastSuccessAt}` and the job's own `error`, if recorded |

Workers Logs are not in the v1 bundle (Spec 028 D6).

## Hard check

`job.missed` is `firing` (Spec 028 Behavior 15). The agent never recomputes it.

## Causes, in order

Check them in this order; stop at the first one the evidence supports. A
diagnosis names the cause by its id (`cause` in the record); `unknown` needs
no runbook.

| # | Cause id | Cause | Distinguishing evidence | Runbook |
| --- | --- | --- | --- | --- |
| 1 | `cron-not-fired` | The cron did not fire, or the scheduled handler threw before recording a start | No data point and no state change after the last good run; `running: false`, `scheduled: false`, `followUp: null`; the cron entry or the job's flag missing from the deployed configuration | [Health and manual run](../cloudflare-data-publisher.md#health-and-manual-run) |
| 2 | `alarm-stuck` | The run started but never completed: the Durable Object alarm is stuck, or a follow-up was lost | `running: true` or `phase` set with an old `startedAt`; or `scheduled: true` with a `followUp.at` in the past; a start without a matching finish in the data points | [Follow-up runs](../cloudflare-data-publisher.md#follow-up-runs-spec-018) |
| 3 | `cost-guard-paused` | The cost guard paused the job (`enforce` mode) | `costGuard.mode: "enforce"`, `breaker.tripped: true`, `breaker.trippedAt` at or before `since`. Under `monitor` nothing is paused, so this cause does not apply | [Cost guard: read `/health`](../cloudflare-data-publisher.md#read-health), [Reset the breaker](../cloudflare-data-publisher.md#reset-the-breaker) |
| 4 | `upstream-failure` | Upstream failure (GitHub or Jira rate limit or outage) made every run fail early | Runs exist but each ended `ok: false` with short `durationMs`; `sources.<key>.ok: false` and an old `lastSuccessAt`. This normally fires `job.failures` too | [Follow-up runs](../cloudflare-data-publisher.md#follow-up-runs-spec-018), [Failure and rollback](../cloudflare-data-publisher.md#failure-and-rollback) |
| 5 | `deploy-broke-job` | A deploy broke the job | A deploy (CI `deploy-development` or `deploy-production`) between the last good run and `since`, and no good run after it | [Roll back](../cloudflare-data-publisher.md#roll-back) |
| 6 | `unknown` | Unknown | None of the above is supported by the bundle | Say so and list the missing evidence |

## Judgment guidance

- **Quote only the bundle.** Every item in `evidence` is a verbatim quote of a
  field in the bundle. A deterministic check rejects a diagnosis whose quote is
  not there (fabrication).
- **Confidence.**
  - `high`: one cause's distinguishing evidence is present and nothing in the
    bundle contradicts it.
  - `medium`: one cause fits, but a field that would confirm it is missing
    (for example no data points because Spec 028 was off).
  - `low`: two or more causes fit equally, or the cause rests on timing alone
    (a deploy near `since` without a failed run after it).
- **Answer "unknown"** (cause 6) when no cause has its distinguishing
  evidence. Pick the verdict by why the cause is unknown:
  - `inconclusive`: the bundle lacks the evidence that would decide it. List
    exactly which fields would decide it in `ownerAction`.
  - `unexplained`: the cited evidence rules out every cause 1–5. The firing is
    real, but no listed cause fits.
  "Unknown" with a precise gap is a correct answer; a guess is not. A cause
  1–5 with its evidence cited is `explained`, at any confidence.
- **Owner actions, never agent actions.** `ownerAction` may suggest a manual
  publication (`POST /run`), a breaker reset, a rollback or a deploy as text
  for the owner. The agent never performs or schedules any of them, and
  never says it did.
- **One cause, then context.** If the cost guard explains the stop (cause
  3), say so first; a second firing for the same window is context, not a
  second diagnosis.

## Worked example: Dev, 2026-09-30 → 10-02 (eval case 1)

**What the specs record.**

- Spec 010 Intent and Spec 011 Evidence: from 2026-09-30 01:07 to 2026-10-02
  02:42 UTC Dev published nothing for about 49 h, and the page still said
  "Published snapshot".
- Publication was hourly at the time (Spec 008 Evidence: "Hourly development
  releases"); Spec 018 made it daily on 2026-10-13.
- Spec 009 Evidence: "Development succeeded at 4,612 events and failed with
  `exceededMemory` above 5,000"; Spec 009 was implemented by PR #23, merged
  2026-10-02 02:48 UTC (git: `37f100f`).
- Git history: PR #20 (alarm-driven runs) merged 2026-09-30 00:24 UTC and PR
  #21 (Spec 008) merged 2026-09-30 00:48 UTC, before the 01:07 start.

**What the specs do not record (gaps).**

- No `/health` reading from inside the window, no failed run record, no log
  line. No spec states the cause of this stall.
- Whether the hourly runs failed with `exceededMemory` during the window, or
  did not run at all, is not recorded. The stall ended at 02:42 UTC, six
  minutes before PR #23 merged, so how it ended is not recorded either.
- Spec 028 (data points, `job.missed`) and the cost guard did not exist; the
  eval bundle is a reconstruction with these fields absent.

**Fixture to build.** Rule entry `job.missed`, `job: publication`, `env: dev`,
`since` 2026-09-30T01:07Z (the last good run; firing at the then boundary,
or 27 h later under today's rule), `value` ≈ 49 h at the end; `lastRun` with
`completedAt` 2026-09-30T01:07Z; no data points; `costGuard` absent; CI
history with the PR #20, #21 and #23 merges and their Dev deploys. Only fields
the specs state; anything else is marked unknown in the fixture.

**Expected diagnosis.**

| Field | Expected |
| --- | --- |
| `verdict` | `inconclusive` (the bundle has no run records in the window, so the evidence that would decide the cause is missing) |
| `cause` | Cause 6 with cause 5 as the leading suspect: two deploys (PR #20, #21) landed within 43 min before the last good run and no good run followed for about 49 h; the bundle has no failed-run record to confirm it. (Spec 009's `exceededMemory` above 5,000 events is a plausible mechanism, but it is not in the bundle unless the fixture adds it.) |
| `confidence` | `low` |
| `evidence` | the rule entry's `since` and `value`; `lastRun.completedAt` 2026-09-30T01:07Z; the CI runs for PR #20 and #21 with their times |
| `runbook` | [Roll back](../cloudflare-data-publisher.md#roll-back) for cause 5; [Health and manual run](../cloudflare-data-publisher.md#health-and-manual-run) for checking state |
| missing evidence | the job's run records in the window (`ok`, `error`, `durationMs`), Workers Logs for an `exceededMemory` outcome, `running`/`scheduled`/`followUp` at the time |
| `ownerAction` | "Check the Dev runs after 2026-09-30 01:07 UTC for a failure such as `exceededMemory`; if the deploys caused it, roll back or fix forward, then publish manually (`POST /run`)." Text for the owner only |

A diagnosis that names `exceededMemory` as the confirmed cause, or quotes a
field the fixture does not contain, fails this case.
