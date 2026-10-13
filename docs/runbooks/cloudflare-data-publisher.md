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

Development sets `bm25-reference@3` (`wrangler.development.jsonc`; `@2` from
Spec 016 H42, `@3` from Spec 017 N17); production does not set the variable
and writes `@1`.

- Set `bm25-reference@2` only when the environment's Pages are at or after
  Spec 016 slice 2a. Older Pages answer every search with HTTP 503 for an
  `@2` release.
- To return to `@1`, remove the variable (on Dev: revert the switch PR) and
  deploy; the next run writes an
  `@1` release. No Cron pause or pointer restore is needed, because current
  Pages read both.
- Before rolling Pages back below slice 2a, return to `@1` first and wait for
  `lastRun.search.lexicalRevision` to read `bm25-reference@1`.
- `bm25-reference@3` (Spec 017) stores what `@2` stores and ranks threads
  differently. Development sets it. Set it only when the
  environment's Pages are at or after Spec 017; to turn it off, set
  `bm25-reference@2` again. Before rolling Pages back below Spec 017, return
  to `@2` first and wait for `lastRun.search.lexicalRevision` to read it.

## Search embeddings (Spec 016 slice 2b)

`SearchEmbeddingRun` is a separate Durable Object. After each successful
publication the publisher asks it to run; it embeds the current Search
release's chunks with `@cf/baai/bge-m3` through the AI Gateway named by
`SEARCH_GATEWAY_ID` and stores one vector per passage in the Vectorize index
bound as `SEARCH_VECTORS`, one namespace per project. It cannot fail, delay,
or re-run a publication. The vectors are read only by the query gate (below), once hybrid search is enabled.

| | Development | Production |
| --- | --- | --- |
| Vectorize index (1,024 dimensions, cosine) | `osskb-search-dev` | none |
| AI Gateway | `osskb-search-dev` (600 requests an hour, spend limit, authenticated) | none |
| `SEARCH_EMBEDDING` | `bge-m3@1` (on since Spec 016 H52, 2026-10-12) | unset (off) |

Preconditions before the Worker is deployed with this binding (the merge of
Spec 016 slice 2b deploys Dev):

- Vectorize index `osskb-search-dev`, 1,024 dimensions, cosine: exists
  (created 2026-10-10).
- AI Gateway `osskb-search-dev`: exists (created 2026-10-10; 600 requests an
  hour, $2 per 30 days, authentication on).
- The CI `CLOUDFLARE_API_TOKEN` may deploy a Worker with a Vectorize binding
  and the `v3` migration: the Dev deploy of slice 2b succeeded (2026-10-10).

`GET /health` → `searchEmbedding`: `enabled`, `configError`, `today`
(estimated neurons and calls against the daily bounds), `interrupted` (a run
the platform killed), `lastError` (the last model or vector-store failure,
kept until a later run embeds), and `lastRun` (`releaseId`, `chunks`,
`embedded`, `pending`, `deletedThisRun`, `heldDeletes`, `absentProjects`,
`quarantined`, `limited`, `ok`, `error`, `modelErrors`,
`index.mutationsProcessed`, `estimate`).

Bounds: 3,000 chunks and 80 model calls per run; 400 calls and 2,500
estimated neurons per UTC day (since Spec 016 slice 3 the neurons are the
token estimate times 1.8, the ratio measured on the Dev backfill of
2026-10-12). No model call or delete starts after 10
minutes and each call is abandoned after 30 seconds, so a run ends within
11 min 35 s (the alarm limit is 15 minutes). A run that reaches one
reports `limited` and the next run continues. The Dev backfill, by the dry
run of 2026-10-10 on the Dev release: 8,586 chunks, 172 calls, 727,738
estimated tokens, 794 estimated neurons, $0.0087, three runs within one UTC
day.

- `heldDeletes` / `absentProjects`: the release holds no chunk of a project
  (or none at all), so its vectors were kept. They are deleted only at the
  third release in a row without it: about three hours at one release an
  hour. A rollback to an older release counts as a release too. Check the
  publisher's sources first.
- `quarantined`: texts that failed alone in three runs in a row; they are
  skipped for 24 hours and then tried once (at most 2 calls); each further
  failure doubles the wait, up to 30 days. `lastError` says why. A failed
  batch is split in halves to find such a text: at most 15 calls for a batch
  of 50, and the other texts are embedded in the same run.
- `quarantined` growing, with `retryCalls` and `retriesDeferred` above zero
  run after run, means many texts fail alone while the model answers:
  usually one cause (texts the model rejects, a changed limit), not many.
  It cannot slow the healthy work: retries run only after it, with at most
  10 calls a run and 100 a day. Read `lastError` and `quarantinedIds`, fix
  the cause, then clear the quarantine with `POST
  /search-embedding/run?reset=1` (one backfill, under a cent) or wait: a
  text whose retry succeeds leaves quarantine by itself, and a changed
  chunk or a new revision is tried at once.
- `limited: model-down`: after three failed calls in a row (or before any
  call of the run succeeded) a probe text failed too. The run stopped
  embedding and struck nothing: 4 calls when the model is down from the
  start, at most 4 more when it stops in mid-run. The next run tries again.
- Error texts in `/health`, in the endpoint's answers, and in the logs have
  bearer tokens and tokens of 32 or more characters (hex, base64) replaced
  by `[redacted]`; object keys and URL paths stay readable, except a path
  segment of 32 or more characters such as an account id or a digest.

### Dry run (calls no model and no index, writes nothing)

```sh
curl -sS -X POST -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  "https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/search-embedding/run?dryRun=1&profile=bge-m3@1"
```

`estimate` holds the chunks, calls, tokens, neurons, dollars, runs, and days
still needed. `&profile=` is needed only while the flag is off.

### Enable on Dev

Steps 1 and 2 are done for Dev (dry run 2026-10-10, flag set 2026-10-12,
Spec 016 H52); steps 3 to 5 follow that deploy. To enable again after a
rollback, repeat from step 1.

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
5. After the first real run, compare the cost the gateway reports with
   `lastRun.estimatedNeurons`. Done for the backfill of 2026-10-12: $0.0157
   against an estimate of $0.0088, a ratio of 1.78; the estimate has been
   multiplied by 1.8 since (`EMBEDDING_TOKEN_CALIBRATION`). Measure again
   and change the constant if a later month's ratio leaves 1.5–2.1.

### Switch the fusion revision

`SEARCH_SEMANTIC` names how lexical and semantic rankings are fused
(Spec 016 Behavior 38, 39). The code runs `rrf-group@1` (plain RRF) and
`rrf-group@2` (the leading lexical threads that hold every query word keep
their places), and `rrf-group@3` (`rrf-group@2`, and only a semantic thread
whose similarity stands out passes the first three lexical threads; enabled
nowhere); any other value answers lexically with `failed`. The gate,
its caches, and the embeddings are the same for both, so a switch costs no
model call and no index query, and nothing stored changes.

Compare offline first (no network):

```sh
bun run eval:search-fusion --rows     # both revisions over the committed capture
bun run eval:search-similarity --rows # rrf-group@3 and the similarity report, over the scored capture
```

Switch (one PR; Dev is at `rrf-group@1` until Spec 016 rollout step 7):

1. `apps/web/wrangler.development.jsonc`: `"SEARCH_SEMANTIC": "rrf-group@2"`.
2. `apps/web/test/search-hybrid.test.ts`: the `H66` pin of that value.
3. The `SEARCH_SEMANTIC` row of `docs/feature-map.md`, the table above, and
   the status of Spec 016. The deployed E2E reads the revision from the
   committed configuration and needs no edit.

After the deploy:

```sh
P=https://oss-knowledge-base-dev.pages.dev
curl -sS "$P/api/search?q=transaction+manager&limit=5" | jq '{fusion: .retrieval.fusionRevision, semantic: .retrieval.semantic, top: [.results[] | {title: .entry.title, signals: .matches[0].signals}]}'
bun run measure:search-hybrid -- --out /tmp/hybrid-report.json    # no model call within 7 days of the last run
bun run capture:search-replay -- --out /tmp/hybrid-replay.json    # records signals.semanticScore
```

Expected: `fusion: rrf-group@2`; the two KAFKA-20237 threads first; no
Spec 017 or guard row in the report's `regressions`; `/health`
`searchQuery.today.modelCalls` unchanged by cached queries.

Roll back: revert that PR. The next Pages deploy answers with
`rrf-group@1`; no cache, vector, or release is touched.

### Turn off or roll back

- Remove `SEARCH_EMBEDDING` and deploy (on Dev: revert the enable PR, which
  also returns the `H45` test and the deployed E2E's `enabled` check). No
  further model or index call is made. The stored vectors stay; they are
  only stale.
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

## Hybrid search at query time (Spec 016 slice 3)

Enabled on Dev since 2026-10-13, in two steps: the Worker (shard roots, the gate) and then Pages (the flag and the binding). Prod has none of it. With it on, `/api/search`
fuses lexical results with semantic candidates; whenever semantic retrieval
is missing it answers lexically and says why.

| Piece | Where | Flag or binding |
| --- | --- | --- |
| Shard roots in the Search manifest | publisher | Worker var `SEARCH_SHARD_ROOTS=true` |
| Query gate (`SearchQueryGate`, one Durable Object: ledger and caches) | data Worker | class migration `v4`; Worker binding `SEARCH_QUERY_GATE` (for `/health`) |
| Hybrid search in `/api/search` | Pages Function | Pages var `SEARCH_SEMANTIC=rrf-group@1` (the value names the fusion revision; see "Switch the fusion revision"); Pages Durable Object binding `SEARCH_QUERY_GATE` → `SearchQueryGate` of `oss-knowledge-base-data-dev` |

The gate uses the embedding job's profile, gateway (`osskb-search-dev`), and
index. It has no public route. Nothing is created by hand: no index, gateway,
token, or dashboard setting.

### Estimate before enabling (no deployment, no network)

```sh
bun run measure:search-query-budget          # caps, per-query charge, Vectorize dimensions
bun run measure:search-hybrid                # lexical baseline of the labelled queries on Dev (public GETs)
```

The caps: per UTC day 1,000 neurons of query embeddings (1 a query) and
1,000 index queries (2 a search on Dev, so 500 uncached searches); 100 model
calls a clock hour. With the digest's 4,500 at its measured cost (× 1.28 = 5,760)
and the embedding job's 2,500 that is 9,260 of the 10,000 neurons a day the
plan includes (740 of headroom); 31 days of
index queries plus the stored vectors are 40.7 M of Vectorize's included
50 M dimensions.

### Enable on Dev (two PRs, in this order)

1. **Worker (done 2026-10-13).** In `apps/data-publisher-worker/wrangler.development.jsonc`
   add `"SEARCH_SHARD_ROOTS": "true"` to `vars`, `{ "name":
   "SEARCH_QUERY_GATE", "class_name": "SearchQueryGate" }` to
   `durable_objects.bindings`, and `{ "tag": "v4", "new_sqlite_classes":
   ["SearchQueryGate"] }` to `migrations`; update the `H66` configuration
   test in `search-query-gate.test.ts`. After the deploy `/health`
   `searchQuery.enabled` is `true` with no `configError`; after the next
   publication `lastRun.search.shardRoots` is `true`. Visitors cannot reach
   the gate yet. Check with:

   ```sh
   W=https://oss-knowledge-base-data-dev.unknowntpo.workers.dev
   curl -sS $W/health | jq '{gate: .searchQuery | {enabled, configError, semanticRevision, today}, run: .lastRun | {ok, completedAt, search}, embedding: .searchEmbedding | {enabled, lastError, lastRun: (.lastRun | {ok, releaseId, pending, limited})}}'
   curl -sS 'https://oss-knowledge-base-dev.pages.dev/api/search?q=txn&limit=1' | jq .retrieval
   ```

   Expected: `gate.enabled: true`, no `configError`, `today` all zero;
   after minute 7 of the next hour `run.search.shardRoots: true` and the
   embedding run `ok` with `pending: 0`; `retrieval` with four fields and no
   `semantic`.
2. **Pages (done 2026-10-13)**, only after step 1 is deployed (CI deploys
   Pages before the Worker) and a release with shard roots is current
   (`/health` `lastRun.search.shardRoots: true`). In `apps/web/wrangler.development.jsonc` add `"vars": {
   "SEARCH_SEMANTIC": "rrf-group@1" }` and `"durable_objects": { "bindings":
   [{ "name": "SEARCH_QUERY_GATE", "class_name": "SearchQueryGate",
   "script_name": "oss-knowledge-base-data-dev" }] }`; update the `H66`
   configuration test in `search-hybrid.test.ts` and the deployed E2E's
   `H32` test (it asserts that `/api/search` has no hybrid field).
3. First observations (Spec 016 H31, H32). The deployed E2E checks the
   shape on every deploy and costs the gate at most 3 model calls ever and
   6 index queries a run; the commands:

   ```sh
   P=https://oss-knowledge-base-dev.pages.dev
   W=https://oss-knowledge-base-data-dev.unknowntpo.workers.dev
   curl -sS -G "$P/api/search" --data-urlencode 'q=交易逾時' -d limit=5 | jq '{semantic: .retrieval.semantic, revision: .retrieval.semanticRevision, results: [.results[] | {title: .entry.title, signals: .matches[0].signals}]}'
   curl -sS -G "$P/api/search" --data-urlencode 'q=交易逾時' -d limit=5 | jq .retrieval.semantic      # cached: true
   curl -sS "$P/api/search?q=KIP770&limit=1" | jq .retrieval.semantic                               # skipped
   curl -sS -G "$P/api/search" --data-urlencode 'q=交易逾時' -d semantic=off | jq .retrieval.semantic  # disabled
   curl -sS $W/health | jq '.searchQuery | {enabled, configError, today, pausedUntil, lastError, sinceStart}'
   bun run measure:search-hybrid -- --out report.json   # 144 GETs, about 7 minutes; at most 48 model calls and 96 index queries
   ```

   - `GET /api/search?q=交易逾時` → `retrieval.semantic { status: "ok",
     candidates, cached: false }` and results; again → `cached: true`.
   - `/health` `searchQuery.today`: 1 neuron, 1 model call, 2 index queries.
   - The gateway `osskb-search-dev` shows one more request;
     `osskb-digest-dev` none.
   - `bun run measure:search-hybrid -- --out report.json`: ranks with and
     without semantic retrieval, statuses, and the added latency. Compare
     with the estimate in Spec 016 Results (slice 3).

Revert the Pages PR when: `timedOutShare` in the summary of
`measure:search-hybrid` is above about 0.3 (or raise the timeout first);
`searchQuery.lastError.kind` is `model` or `vector-store` on the first
queries; or `pausedUntil` is set repeatedly. `over-budget` alone is the cap
working.

### Reading the response and `/health`

`retrieval.semantic.status` in `/api/search`:

| Status | Meaning | Do |
| --- | --- | --- |
| `ok` | Candidates were fused; `cached` says no model call was made | — |
| `skipped` | An identifier query or fewer than two letters | — |
| `disabled` | The request said `semantic=off`, or the gate has no `SEARCH_EMBEDDING` | Check the Worker's variables if unexpected |
| `uncovered` | The served release has no shard roots | Check `SEARCH_SHARD_ROOTS` and `lastRun.search.shardRoots` |
| `over-budget` | A daily or hourly cap is spent, or model calls are paused after a refusal | Read `searchQuery.today` and `pausedUntil`; it resets by itself |
| `timed-out` | The gate took over 1,000 ms | Read `searchQuery.lastError`; watch the share with `measure:search-hybrid` |
| `failed` | Anything else: a model or index error, a bad flag value, a missing binding | Read `searchQuery.lastError` and `configError`; the Pages log has the sanitized error |

No field at all means `SEARCH_SEMANTIC` is unset on that deployment.

`/health` `searchQuery`: `enabled`, `configError`, `semanticRevision`,
`today { date, neurons, modelCalls, indexQueries, hour, hourModelCalls,
neuronCap, indexQueryCap, hourModelCallCap }`, `pausedUntil` (model calls
are paused for 15 minutes after Workers AI or the gateway refuses a call),
`lastError { kind, message, at }` (`model`, `model-limit`, `vector-store`,
`internal`), and `sinceStart { requests, cached, embedded, overBudget,
failed }`, which restarts whenever the platform restarts the object. It is
`null` when the object does not answer and `enabled: false` with the caps
where it is not bound.

### Turn off

- Revert the Pages enable PR as a whole and let CI deploy. `/api/search` is
  the lexical reader again, byte for byte. Removing only `SEARCH_SEMANTIC`
  leaves `main` red: the deployed E2E's `H32` test and the `H66`
  configuration test expect the hybrid configuration.
- Nothing needs doing in a hurry: a failing gate, a spent budget, and a
  timeout already answer lexically.
- Removing `SEARCH_SHARD_ROOTS` makes the next release `uncovered`. The
  object and its cache may stay; removing the class needs a `deleted_classes`
  migration.
- To compare without deploying, add `&semantic=off` to a request.

