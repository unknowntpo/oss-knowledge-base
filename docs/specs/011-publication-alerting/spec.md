# Spec 011: Publication alerting

Status: Draft (for intent review)
Date: 2026-10-06
Traceability: enforced
Builds on: Spec 006, Spec 009, Spec 010

## Intent

When Dev data publication stops or fails, the maintainer is notified without
opening the Dashboard. A small, separate Cloudflare Worker checks the
publisher's `/health` on a Cron trigger and keeps one GitHub issue in
`unknowntpo/oss-knowledge-base` open while publication is unhealthy, and
comments on and closes it when publication recovers.

## Evidence

- From 2026-09-30 01:07 to 2026-10-02 02:42 UTC Dev published nothing for
  about 49 h. Nobody was told; it was found by opening the Dashboard.
- Spec 010 made staleness visible on the Feed page only. Its non-goals and
  pilot 001's open limits name alerting as the missing piece.
- The failures behind that outage (128 MB Durable Object memory, 15-min
  alarm wall time, subrequest limits, a stuck lease) killed or blocked runs
  inside the publisher Worker. A check running in that Worker shares the
  failure domain, so the checker is a separate Worker (human decision).

## Example

Captured from Dev `/health` at 2026-10-06T07:11:18Z, while the 07:07 run was
writing (`phase.counts` trimmed):

```json
{
  "environment": "development",
  "running": true,
  "scheduled": false,
  "phase": { "phase": "writing-feed", "startedAt": "2026-10-06T07:09:44.627Z",
             "materializedAt": "2026-10-06T07:07:13.000Z" },
  "lastRun": {
    "ok": true,
    "environment": "development",
    "completedAt": "2026-10-06T06:07:13.000Z",
    "publicationSetId": "github-2026-10-06T06-07-13-000Z",
    "feedReleaseId": "2026-10-06T06-07-13-000Z",
    "inputEventCount": 15,
    "logicalEventCount": 7422,
    "pollTruncated": false
  }
}
```

At the same moment `/api/feed` on https://oss-knowledge-base-dev.pages.dev
returned `metadata.manifest.generatedAt` `2026-10-06T06:07:13.000Z` and
`releaseId` `2026-10-06T06-07-13-000Z`: the same instant as
`lastRun.completedAt`. In the publisher code (`apps/data-publisher-worker/src/pipeline.ts`)
`completedAt` is the run's scheduled start (`materializedAt`), not its
finish, and a failed run overwrites `lastRun` with
`{ ok: false, completedAt, failureKind, error, retryAfterSeconds }`.

What the checker (Cron `37 * * * *`) does with real values:

| Check at (UTC) | `/health` | Open alert issue | Action |
| --- | --- | --- | --- |
| 2026-10-06 07:11:18 | ok, completedAt 06:07:13 (1 h 4 min) | none | nothing |
| (boundary, not a Cron time) 2026-10-06 09:07:14 | ok, completedAt 06:07:13 (3 h 0 min 1 s) | none | open issue, reason `stale` |
| 2026-09-30 04:37:00 | ok, completedAt 01:07:13 (3 h 29 min) | none | open issue, reason `stale` (the 49 h outage would have alerted here) |
| 2026-10-02 03:37:00 | ok, completedAt 02:42 (55 min) | #N open | comment "recovered" and close #N |

The issue opened on 2026-09-30 would read:

> **Title:** Dev data publication alert
> **Labels:** `publication-alert`
>
> Dev data publication is unhealthy: `stale`.
> Last successful run: 2026-09-30T01:07:13.000Z (3 h 29 min before this check at 2026-09-30T04:37:00Z), release `2026-09-30T01-07-13-000Z`.
> Health: https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health · Dashboard: https://oss-knowledge-base-dev.pages.dev
> This issue is closed automatically when a run succeeds again.

## Simplification review

1. **Question every requirement.**
   - Owner of the whole feature: the maintainer, who must hear about a stop
     within hours without polling the Dashboard.
   - The 3-hour threshold: same rule and boundary as Spec 010 F2 (stale when
     older than 3 h, not at exactly 3 h), so the issue and the page agree.
     Hourly publication means two missed runs.
   - "Last run failed" as its own trigger: human decision; it reports a
     failure the pipeline caught (`!poll.complete` or the `catch` block in
     `pipeline.ts`) about 30 min after it happens instead of 3 h later. A
     run the platform kills (memory, wall time) records no status, so it is
     seen only as `stale`.
   - Unreachable `/health`: needed because a deleted or crashing publisher
     Worker never reports itself stale.
2. **Delete.**
   - `/api/feed` as a second signal: its `generatedAt` is the same instant
     as `lastRun.completedAt` (Example), so it adds a request and a parser
     and no information.
   - Checker storage (KV or Durable Object) and a "consecutive failures"
     counter: the open GitHub issue is the only state. Unreachability is
     confirmed by retries inside one check instead of across checks.
   - Configurable threshold: one constant, as in Spec 010.
   - `running`, `scheduled`, `phase`, `environment` from `/health`: a killed
     or stuck run already shows as an old `completedAt`; nobody needs them
     for the decision. They stay in the issue only via the `/health` link.
     With one target, a mis-pointed `HEALTH_URL` is caught by the A17 drill;
     an `environment` check is reconsidered when Prod is added.
   - Comments on every unhealthy check, or when the reason changes while
     open: noise; the issue already says "open until a run succeeds".
   - Reopening the previous issue on a new episode: one issue per episode is
     simpler and the history is in the closed issues.
   - The checker creating its label: the human creates `publication-alert`
     once, together with the token.
   - Other channels (email, Slack, webhook): GitHub's notification email is
     the channel.
3. **Simplify.** One pure function decides `none` / `open` / `close` from
   (`/health` outcome, open alert issues, clock); a thin GitHub client and a
   `scheduled` handler wrap it. Dedup key: label `publication-alert` plus
   the exact title `Dev data publication alert`.
4. **Shorten the cycle.** The decision is table-tested from the case file
   below with no network; the sequence tests use a fake `/health` and a fake
   GitHub; a local `wrangler dev --test-scheduled` run checks the Worker
   wiring before any deploy.
5. **Automate last.** The checker is deployed by the same CI Dev deploy as
   the publisher, as one more `wrangler deploy` step, only after the drill
   (A17) has passed once by hand.

## Behavior

1. A Worker separate from the publisher (`apps/publication-alert-worker`,
   name `oss-knowledge-base-publication-alert`) runs one check on Cron
   `37 * * * *` UTC, 30 min after the Dev publisher's `7 * * * *`.
2. A check reads `HEALTH_URL` (Dev:
   https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health).
   Each attempt times out after 10 s, as does every GitHub call; GitHub
   calls are sequential and not retried within a check. For `/health`, a
   network error, timeout, or non-2xx
   status is retried, at most 3 attempts 5 s apart. If every attempt fails,
   the outcome is `unreachable`.
3. The outcome is:
   - `failed` when `lastRun.ok` is `false` (only failures the pipeline
     records; a killed run leaves the previous `lastRun` and becomes `stale`);
   - `invalid` when the body is not JSON, `lastRun` is missing or null, or
     `lastRun.completedAt` does not parse as a time (`lastRun` is null only
     before a new publisher Durable Object's first run; existing storage
     survives deploys, so ordinary redeploys do not alert);
   - `stale` when `lastRun.ok` is `true` and now − `completedAt` > 3 h;
   - `fresh` otherwise. A `completedAt` in the future is `fresh` (clock skew).
4. The check lists open issues with label `publication-alert` and title
   `Dev data publication alert` (at most 10).
   - Unhealthy outcome (`failed`, `invalid`, `stale`, `unreachable`) and no
     open alert issue: create one issue with that title and label. The body
     names the outcome and links `/health` and the Dashboard, plus:
     `stale` — last successful `completedAt`, its age, `feedReleaseId`;
     `failed` — the failed run's `completedAt`, `failureKind`, `error`;
     `unreachable` — the last attempt's error or status;
     `invalid` — which check failed (not JSON, no `lastRun`, bad time).
   - Unhealthy outcome and an alert issue already open: do nothing. If the
     maintainer closes an issue by hand while still unhealthy, the next check
     opens a new one (there is no snooze).
   - `fresh` and one or more alert issues open: on each, comment with the
     new `completedAt` and `feedReleaseId`, then close it.
   - `fresh` and none open: do nothing.
5. The checker keeps no state of its own; every decision uses only the
   current `/health` outcome, the open alert issues, and the clock.
6. Each check logs one JSON line: `environment`, `outcome`, `ageSeconds`
   (or null), `action`, issue numbers acted on, and any GitHub error status.

Credential: `GITHUB_ALERT_TOKEN`, a fine-grained personal access token with
repository access to `unknowntpo/oss-knowledge-base` only and permission
Issues: Read and write (Metadata: Read is implied), stored as a Worker
secret (`wrangler secret put`). The human creates the token, stores the
secret, and creates the `publication-alert` label. The agent never handles
the token value. Issues created with the human's own token are the human's
own activity, which GitHub does not email by default; the human either
enables "Include your own updates" in notification settings or uses a token
from a separate account (open question). A separate account must be a
repository collaborator with write access: GitHub silently drops `labels`
on issue creation without push access, which would break dedup and open a
new issue every hour (A17 asserts the label).

## Test plan

Generated from `apps/publication-alert-worker/test/alert.cases.ts` by
`bun run docs:test-plan`; the decision unit tests run exactly these rows.
Edit the case file, not this table. Ages are now − `completedAt`.

<!-- test-plan:start apps/publication-alert-worker/test/alert.cases.ts -->
| id | health | completedAt | now | open | action | reason |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | ok | 2026-10-06T06:07:13Z | 2026-10-06T07:11:18Z | 0 | none | fresh |
| A1 | ok | 2026-10-06T06:07:13Z | 2026-10-06T09:07:13Z | 0 | none | fresh |
| A2 | ok | 2026-10-06T06:07:13Z | 2026-10-06T09:07:14Z | 0 | open | stale |
| A2 | ok | 2026-09-30T01:07:13Z | 2026-09-30T04:37:00Z | 0 | open | stale |
| A3 | failed | 2026-10-06T07:07:13Z | 2026-10-06T07:37:00Z | 0 | open | failed |
| A4 | ok | 2026-10-06T06:07:13Z | 2026-10-06T07:11:18Z | 1 | close | fresh |
| A4 | ok | 2026-10-06T06:07:13Z | 2026-10-06T09:07:13Z | 1 | close | fresh |
| A5 | unreachable | — | 2026-10-06T07:37:00Z | 0 | open | unreachable |
| A6 | no run | — | 2026-10-06T07:37:00Z | 0 | open | invalid |
| A6 | not JSON | — | 2026-10-06T07:37:00Z | 0 | open | invalid |
| A6 | ok | not-a-time | 2026-10-06T07:37:00Z | 0 | open | invalid |
| A7 | ok | 2026-10-06T06:07:13Z | 2026-10-06T09:07:14Z | 1 | none | stale |
| A7 | failed | 2026-10-06T07:07:13Z | 2026-10-06T07:37:00Z | 1 | none | failed |
| A7 | unreachable | — | 2026-10-06T07:37:00Z | 1 | none | unreachable |
| A12 | ok | 2026-10-06T06:07:13Z | 2026-10-06T07:11:18Z | 2 | close | fresh |
| A12 | ok | 2026-10-06T06:07:13Z | 2026-10-06T09:07:14Z | 2 | none | stale |
| A13 | ok | 2026-10-06T07:08:13Z | 2026-10-06T07:07:13Z | 0 | none | fresh |
<!-- test-plan:end -->

Step-based scenarios run as named tests against a fake `/health` and a fake
GitHub API (`apps/publication-alert-worker/test/check.test.ts`):

| ID | Scenario | Expected |
| --- | --- | --- |
| A1 | Fresh check, no open issue | fake GitHub records only the list call |
| A2, A3, A5, A6 | Stale / failed / unreachable / invalid check with no open issue | one `POST /issues` whose title, label, and body match Behavior 4 for that outcome |
| A4 | Fresh check with alert #7 open | `POST /issues/7/comments` with the new `completedAt` and release, then `PATCH /issues/7 {state: closed}` |
| A5 | `/health` fails twice (timeout, then 503), then returns fresh | 3 attempts, outcome `fresh`, no GitHub write |
| A8 | Listing issues returns 500, 401, 403 rate-limited, or a network error (one test each) | no create, comment, or close; log line has `githubError` with the status; the next check with a working API acts normally |
| A9 | Create returns 502 on check 1 | check 1 logs the error; check 2 creates the issue (exactly one open after check 2) |
| A9 | Comment succeeds and close returns 502 on recovery (stands in for a crash between them) | check 2 comments again and closes; no alert issue left open |
| A10 | Checker absent for 10 hourly checks while Dev recovered, then runs | one comment + close for the open issue; no issue created for the missed hours |
| A11 | Outcomes stale, fresh, stale, fresh on four checks | open, close, open (new issue), close; never more than one open alert issue |
| A14 | Worst cases: unreachable (3 attempts) + list + create; fresh on the 3rd attempt with 10 open issues | subrequests = 5 and = 24 |
| A15 | `/health` never responds, then the create call stalls | check ends in ≤ 50 s (3 × 10 s + 2 × 5 s + list + 10 s timeout) with outcome `unreachable` and a logged GitHub timeout |

## Acceptance

### Behavior
- A1: with `lastRun.ok` true and `completedAt` at most 3 h before now
  (including exactly 3 h), a check with no open alert issue makes no GitHub
  write → evidence: case rows A1, fake GitHub records only the list call.
- A2: with `lastRun.ok` true and `completedAt` more than 3 h before now
  (3 h 1 s), a check with no open alert issue creates one issue titled
  "Dev data publication alert", labelled `publication-alert`, with outcome
  `stale`, age, release, and links → evidence: case rows A2, named test A2.
- A3: with `lastRun.ok` false, a check with no open alert issue creates one
  issue with outcome `failed`, `failureKind`, and `error` → evidence: case
  row A3, named test A3.
- A4: with an open alert issue and a `fresh` outcome, the check comments the
  new `completedAt` and `feedReleaseId` on it and closes it → evidence: case
  rows A4, named test A4.

### Failure and retry
- A5: with `/health` failing (network error, timeout, non-2xx) on every one
  of 3 attempts, the check opens an issue with outcome `unreachable`, which
  the body distinguishes from `stale`; with a later attempt succeeding, the
  check uses that response → evidence: case row A5, named test A5.
- A6: with `/health` 200 but not JSON, `lastRun` null, or an unparsable
  `completedAt`, the check opens an issue with outcome `invalid` instead of
  treating it as fresh or crashing → evidence: case rows A6.
- A7: with an alert issue already open, an unhealthy check (any outcome)
  creates no issue and posts no comment → evidence: case rows A7.
- A8: when listing issues fails (5xx, 401/403, rate limit, network), the
  check writes nothing to GitHub and logs the status; the next check acts
  normally → evidence: named test A8.
- A9: when a create, comment, or close fails, the check logs it and the next
  check repeats the needed action; a crash between comment and close leaves
  at most one extra comment and no open issue after the next fresh check →
  evidence: named tests A9.
- A10: after the checker was down or restarted for any number of checks, the
  next check acts only on the current state (no backlog of issues or
  comments) → evidence: named test A10.
- A11: when the outcome alternates between unhealthy and fresh, each check
  makes at most one transition, and at most one alert issue is open at any
  time → evidence: named test A11.
- A12: with more than one alert issue open (for example from a concurrent
  duplicate run), a fresh check closes all of them and an unhealthy check
  creates none → evidence: case rows A12.
- A13: with `completedAt` 60 s in the future, the outcome is `fresh` →
  evidence: case row A13.

### Budget
- A14: a check makes at most 5 subrequests when unhealthy (3 `/health`
  attempts + 1 list + 1 create) and at most 3 + 1 + 2 × 10 = 24 when
  closing 10 open issues. Limits (the account is on Workers Paid, as the
  publisher's `cpu_ms: 300000` requires): 1,000 subrequests per invocation;
  GitHub 5,000 requests per hour per token and secondary limits on content
  creation (about 80 per minute; writes are sequential). Normal use is 1 to
  3 GitHub requests per hour, at most 21 in one check → evidence: named
  test A14 counts the fake `fetch` calls.
- A15: a check's wall time is bounded by its timeouts: 40 s for `/health`
  (3 × 10 s + 2 × 5 s) plus 10 s per GitHub call, at most 21 calls → 250 s
  worst case, below the 15-min Cron limit → evidence: named test A15 with an
  injected clock and a stalling fake GitHub.
- A18: [measure] CPU and wall time per check, read from Workers Logs
  (`cpuTime`, `wallTime`) for 3 Dev checks after deploy, recorded in the PR
  with the query used; expected well under 1 s CPU (Paid default 30 s).

### Observability
- A16: [deploy] on Dev, every hourly check appears in Workers Logs (the
  checker sets `observability.enabled`) as one JSON line with `outcome`,
  `ageSeconds`, and `action`; for 3 consecutive checks the logged
  `ageSeconds` agrees with `/health` `lastRun.completedAt`. This is also
  the gate that a Worker can fetch the publisher's `workers.dev` host on
  the same account.
- A17: [deploy] drill, run once by the human or with the human's approval
  because it creates a real issue: run the checker locally
  (`wrangler dev --test-scheduled`) with the real token and `HEALTH_URL`
  pointed at a local fixture returning a `failed` run → an issue appears in
  `unknowntpo/oss-knowledge-base` carrying the `publication-alert` label
  (in the create response and on GitHub), the maintainer receives a GitHub
  notification email, and a second check opens no second issue; switch the
  fixture to a fresh run → the issue gets a comment and is closed.

## Adding Prod later

Prod has no live publisher yet. To add it: deploy the Prod publisher, then
give the checker a second target (`environment: production`, Prod
`/health` URL, title `Prod data publication alert`) in its config. The
decision, label, and token are reused; dedup stays per title (a renamed
issue breaks dedup once: one extra issue, then stable). Raise the list
limit above 10, and add an `environment` match on the `/health` body so a
mis-pointed URL is caught. Prod's Cron
is `37 * * * *`, so the checker's `:37` check sees Prod's previous hour,
which the 3 h rule tolerates. No new spec is needed unless Prod wants a
different threshold or channel.

## Review log

Independent review (Fable, stage 2, 2026-10-06); 13 findings.

| # | Finding | Handling |
| --- | --- | --- |
| 1 | Killed runs never write `failed` | Applied: Behavior 3 and simplification review say they show as `stale` |
| 2 | Notification and label depend on token identity | Applied: credential notes, A17 asserts label + email; identity left as open question |
| 3 | A14 worst case is 24, not 22 | Applied |
| 4 | GitHub calls had no timeout; 45 s bound unproven | Applied: 10 s per GitHub call, bound 250 s, A15 stalls GitHub |
| 5 | Budget named the wrong plan; no CPU/wall measurement | Applied: Paid plan limits, A18 `[measure]` |
| 6 | Flapping / manual close noise | Documented in Behavior 4 and Non-goals; open question |
| 7 | `lastRun: null` after a deploy | Rebutted with a note: DO storage survives deploys; null only for a new DO |
| 8 | Body undefined for `failed`/`unreachable`/`invalid` | Applied: body per outcome |
| 9 | Evidence gaps in named tests (A1, A5, A8, A9) | Applied |
| 10 | Example row at 09:07:14 is not a Cron time | Applied: labelled boundary |
| 11 | Exact-title dedup fragile, 10-issue cap | Noted under Adding Prod later |
| 12 | Mis-pointed `HEALTH_URL` undetectable | Rebutted for Dev (A17 drill); `environment` match added when Prod is added |
| 13 | Cross-Worker `workers.dev` fetch | Applied: A16 is the gate |

## Non-goals

- Prod alerting now (see above).
- Alerting on the Pages Dashboard itself being down; this spec covers
  publication only.
- Watching the checker: if the checker Worker stops or its token expires,
  nothing alerts (the A8 log line shows a 401). The token's expiry is the
  human's to track.
- Alerts for `pollTruncated`, memory, or other degraded-but-successful runs.
- Escalation, paging, or channels other than a GitHub issue.
- Snoozing, or hysteresis against flapping: a single transient run failure
  opens an issue and the next good run closes it (consequence of alerting
  on any failed run).
