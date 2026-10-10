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

Development sets `bm25-reference@2` (`wrangler.development.jsonc`, Spec 016
H42); production does not set the variable and writes `@1`.

- Set `bm25-reference@2` only when the environment's Pages are at or after
  Spec 016 slice 2a. Older Pages answer every search with HTTP 503 for an
  `@2` release.
- To return to `@1`, remove the variable (on Dev: revert the switch PR) and
  deploy; the next run writes an
  `@1` release. No Cron pause or pointer restore is needed, because current
  Pages read both.
- Before rolling Pages back below slice 2a, return to `@1` first and wait for
  `lastRun.search.lexicalRevision` to read `bm25-reference@1`.

## Search embeddings (Spec 016 slice 2b)

`SearchEmbeddingRun` is a separate Durable Object. After each successful
publication the publisher asks it to run; it embeds the current Search
release's chunks with `@cf/baai/bge-m3` through the AI Gateway named by
`SEARCH_GATEWAY_ID` and stores one vector per passage in the Vectorize index
bound as `SEARCH_VECTORS`, one namespace per project. It cannot fail, delay,
or re-run a publication. Nothing reads the vectors before Spec 016 slice 3.

| | Development | Production |
| --- | --- | --- |
| Vectorize index (1,024 dimensions, cosine) | `osskb-search-dev` | none |
| AI Gateway | `osskb-search-dev` (600 requests an hour, spend limit, authenticated) | none |
| `SEARCH_EMBEDDING` | unset (off) | unset (off) |

Preconditions before the Worker is deployed with this binding (the merge of
Spec 016 slice 2b deploys Dev):

- Vectorize index `osskb-search-dev`, 1,024 dimensions, cosine: exists
  (created 2026-10-10).
- AI Gateway `osskb-search-dev`: exists (created 2026-10-10; 600 requests an
  hour, $2 per 30 days, authentication on).
- Unconfirmed: whether the CI `CLOUDFLARE_API_TOKEN` may deploy a Worker
  with a Vectorize binding. If not, the "Deploy the isolated development data
  publisher" step fails after Pages deployed. Dev stays consistent (the
  previous Worker keeps running; no release or state changes). Add the
  Vectorize permission to the token and re-run the job; there is nothing
  else to roll back.

`GET /health` → `searchEmbedding`: `enabled`, `configError`, `today`
(estimated neurons and calls against the daily bounds), `interrupted` (a run
the platform killed), `lastError` (the last model or vector-store failure,
kept until a later run embeds), and `lastRun` (`releaseId`, `chunks`,
`embedded`, `pending`, `deletedThisRun`, `heldDeletes`, `absentProjects`,
`quarantined`, `limited`, `ok`, `error`, `modelErrors`,
`index.mutationsProcessed`, `estimate`).

Bounds: 3,000 chunks and 80 model calls per run; 400 calls and 2,500
estimated neurons per UTC day; 10 minutes per run. A run that reaches one
reports `limited` and the next run continues. The Dev backfill (8,586
chunks) is about 172 calls, 0.76 M estimated tokens, 832 estimated neurons,
under one cent, in three runs within one UTC day.

- `heldDeletes` / `absentProjects`: the release holds no chunk of a project
  (or none at all), so its vectors were kept. They are deleted only at the
  third release in a row without it. Check the publisher's sources first.
- `quarantined`: chunks whose batch the model failed in three runs in a row;
  they are skipped for 24 hours and then tried once. `lastError` says why.

### Dry run (calls no model and no index, writes nothing)

```sh
curl -sS -X POST -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  "https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/search-embedding/run?dryRun=1&profile=bge-m3@1"
```

`estimate` holds the chunks, calls, tokens, neurons, dollars, runs, and days
still needed. `&profile=` is needed only while the flag is off.

### Enable on Dev

1. Run the dry run and read `estimate`.
2. In `apps/data-publisher-worker/wrangler.development.jsonc` add
   `"SEARCH_EMBEDDING": "bge-m3@1"` to `vars`, update the `H45` configuration
   test, and merge. Any other value fails the embedding run (not the
   publication) and `/health` `searchEmbedding.configError` names it.
3. The next publication (minute 7 of the hour) starts a run; `POST
   /search-embedding/run` with the bearer token starts one at once (202;
   409 means one is pending).
4. Watch `searchEmbedding.lastRun` until `pending` is 0 and, a run later,
   `index.mutationsProcessed` is `true`. Check the gateway `osskb-search-dev`
   for the requests; `osskb-digest-dev` must show none of them.
5. After the first real run, compare the tokens and neurons the gateway
   reports with `lastRun.estimatedInputTokens` and `estimatedNeurons`, and
   record the ratio in Spec 016 Results. The daily cap allows the estimate to
   be half the truth; lower `dailyNeuronCap` if the ratio is above 2.

### Turn off or roll back

- Remove `SEARCH_EMBEDDING` and deploy. No further model or index call is
  made. The stored vectors stay; they are only stale.
- `ok: false` with `failureKind: model-limit` means Workers AI or the gateway
  refused (daily allocation, rate limit, spend limit): nothing to do, the
  next run continues. `vector-store` means Vectorize did not answer or the
  index has other dimensions. `release-read` means the Search release could
  not be read whole; nothing was deleted.
- Rolling a Search release back needs no step here: the next run reconciles
  the index with whatever release is current.

### Wipe the index

1. `bunx wrangler vectorize delete osskb-search-dev`, then
   `bunx wrangler vectorize create osskb-search-dev --dimensions=1024 --metric=cosine`.
2. `POST /search-embedding/run?reset=1` with the bearer token. It forgets the
   embedding state, with any quarantine and absent-project count (it is
   served while the flag is off too). Without it the
   state still calls every chunk embedded and nothing is embedded again.
3. With the flag on, the next runs embed every chunk again (one backfill).
