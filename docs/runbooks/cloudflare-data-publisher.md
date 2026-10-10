# Cloudflare data publisher runbook

## Environment map

| Environment | Worker | Cron (UTC) | State | R2 target | Code release |
| --- | --- | --- | --- | --- | --- |
| Development | `oss-knowledge-base-data-dev` | `7 * * * *` | environment-local Durable Object | `oss-knowledge-base-dev` | push to `main` |
| Production | `oss-knowledge-base-data-prod` | `37 * * * *` | environment-local Durable Object | `oss-knowledge-base-prod` | reachable `vX.Y.Z` tag |

The Workers require the Standard (paid) Workers limits. Each environment needs
two Worker secrets:

- `GITHUB_SOURCE_TOKEN`: fine-grained GitHub token with read-only access to
  public repository metadata;
- `MANUAL_TRIGGER_TOKEN`: random bearer token for `POST /run`.

Do not put either value in Wrangler configuration, Git, logs, or Pages.

## Health and manual run

`GET /health` returns only the environment, whether a run is active or
scheduled, and the last bounded status. It never returns credentials or event
payloads.

Both the Cron and `POST /run` only schedule a run on the environment's Durable
Object and return; the run itself executes in the object's alarm. The runtime
never runs two alarms at once and retries an alarm that dies, so no lock has to
expire before the next run. An alarm has a 15-minute wall-time limit.

An authorized manual run calls `POST /run` with
`Authorization: Bearer <MANUAL_TRIGGER_TOKEN>`; HTTP 202 means it was scheduled.
Poll `/health` for the result. Use it once after initial secret
provisioning, then confirm Feed and Search both changed to complete releases
before relying on the Cron.

## Failure and rollback

- A GitHub error, incomplete page sequence, validation error, or R2 error keeps
  the previous complete pointers readable.
- HTTP 409 from a manual run means a run is already scheduled or active; do not
  start another retry.
- To hold a rollback, pause the affected Cron first. Verify every immutable
  object for the chosen release, restore its Feed/Search pointers, and only then
  re-enable the Cron.
- Never copy checkpoints or Durable Object state between development and
  production.

## Search lexical revision (Spec 016)

`SEARCH_LEXICAL_REVISION` in a Worker's `vars` selects the lexical revision a
run writes. Unset writes `bm25-reference@1`; `bm25-reference@2` writes `@2`;
any other value fails the run before polling and `/health` `lastRun.error`
names it. `/health` `lastRun.search.lexicalRevision` shows what the last run
wrote; `/api/search` `retrieval.lexicalRevision` shows what is served.

- Set `bm25-reference@2` only when the environment's Pages are at or after
  Spec 016 slice 2a. Older Pages answer every search with HTTP 503 for an
  `@2` release.
- To return to `@1`, remove the variable and deploy; the next run writes an
  `@1` release. No Cron pause or pointer restore is needed, because current
  Pages read both.
- Before rolling Pages back below slice 2a, return to `@1` first and wait for
  `lastRun.search.lexicalRevision` to read `bm25-reference@1`.
