# Cloudflare data publisher runbook

## Environment map

| Environment | Worker | Cron (UTC) | State | R2 target | Code release |
| --- | --- | --- | --- | --- | --- |
| Development | `oss-knowledge-base-data-dev` | `7 22 * * *` (daily, 06:07 Asia/Taipei) | environment-local Durable Object | `oss-knowledge-base-dev` | push to `main` |
| Production | `oss-knowledge-base-data-prod` | `37 22 * * *` (daily; deployed by `v0.3.1` on 2026-10-19, see below) | environment-local Durable Object | `oss-knowledge-base-prod` | reachable `vX.Y.Z` tag |

Publication is **once a day** (Spec 018, owner's decision of 2026-10-13; it
was hourly). A change that needs a new release — a new lexical revision, a
flag, a fixed source — is otherwise visible only after the next 22:07 UTC.
**To publish now, use the manual run below.**

The Workers require the Standard (paid) Workers limits. Each environment needs
two Worker secrets:

- `GITHUB_SOURCE_TOKEN`: fine-grained GitHub token with read-only access to
  public repository metadata;
- `MANUAL_TRIGGER_TOKEN`: random bearer token for `POST /run`.

Do not put either value in Wrangler configuration, Git, logs, or Pages.

## First Prod release

Done: `v0.3.1` (`71b8f99`) deployed Prod Pages and, for the first time, the
Prod data Worker on 2026-10-19 (`v0.3.0` failed CI and deployed nothing).
First `POST /run` 10:19 UTC; backlog complete 12:56 UTC (`pollTruncated`
false, 6,950 chunks); first Cron run 22:37 UTC ok. Before it Prod served the
recorded snapshot of 2026-08-25 (184 entries, `bm25-reference@1`). The steps
below are the record of that release and the procedure for rebuilding Prod.

### What the tag turns on

| Feature | Prod | Why |
| --- | --- | --- |
| Daily publication: GitHub, dev@ (Pony Mail), Jira | on, `37 22 * * *` | the product; Jira and dev@ are anonymous, GitHub needs `GITHUB_SOURCE_TOKEN` |
| First GitHub window 30 days (`GITHUB_INITIAL_LOOKBACK_DAYS=30`) | on | without it a new publisher reads GitHub one day back beside 30 days of Jira and dev@; used only while a repository has no cursor (Spec 018 T17–T20) |
| Lexical search `bm25-reference@3` | on (`SEARCH_LEXICAL_REVISION`) | Pages deploy before the Worker in the same job, so the reader is at Spec 017 first |
| Design system, dark theme (Specs 023, 024) | on | Pages only |
| Semantic search (Spec 016) | off | needs a Prod index, gateway and backfill, and a Pages binding to the Worker's `SearchQueryGate`, which must exist before the Pages deploy: a second release |
| Topic digest (Spec 014) | off | no `osskb-digest-prod` gateway; Spec 014 D34 eval thresholds come first |
| Review ingestion, activity log, contributor profiles (Specs 022, 019) | off | Spec 019 decisions 3 and 8; nothing on Prod reads them |

Cost with this set: one publication a day (plus up to 5 catch-ups and 3
retries). Dev's steady run is about 620 Class A and 8,500 Class B; Prod
adds about the same, about 19 thousand Class A and 0.26 million Class B a
month, against the account's included 1 million and 10 million. No Workers
AI, Vectorize or AI Gateway use. Storage is billed already: the Dev bucket
holds 13.3 GB (2026-10-19) against the 10 GB included (gardening G9).

### Owner steps, in order

Avoid 21:50–22:50 UTC (Dev publication 22:07, Prod 22:37, Dev digest 22:47)
and minutes :03–:18 (transient deploy API errors).

1. **Merge** the release-prep PR. Wait for `main` CI and the Dev deploy to
   pass.
2. **Secrets** (needs `bunx wrangler login` on this Mac, and a GitHub
   fine-grained token: github.com → Settings → Developer settings →
   Fine-grained tokens, resource owner your account, "Public repositories",
   no permissions beyond the default read of public data, expiry at least 90
   days):

   ```sh
   scripts/release/put-prod-secrets.sh          # prompts for the GitHub token; generates MANUAL_TRIGGER_TOKEN into the Keychain
   scripts/release/put-prod-secrets.sh --check  # present: GITHUB_SOURCE_TOKEN, present: MANUAL_TRIGGER_TOKEN
   ```

   Before the first deploy, `wrangler secret put` creates an empty draft
   Worker `oss-knowledge-base-data-prod` to hold them (no cron, no data
   access); the tag's deploy replaces its code and keeps the secrets. The
   CI step "Require provisioned production runtime secrets" runs before
   any deploy step, so a tag pushed without them fails and changes nothing;
   a publication with no GitHub token would throw in its alarm and record
   nothing (gardening G94).
3. **Save the current Prod pointers** (the rollback target; read-only):

   ```sh
   cd apps/data-publisher-worker
   mkdir -p ~/osskb-prod-rollback
   for k in public/v2/current.json public/search/v1/current.json; do
     bunx wrangler r2 object get "oss-knowledge-base-prod/$k" --remote --pipe > ~/osskb-prod-rollback/$(echo $k | tr / _)
   done
   ```

   Expected (2026-10-19): `osskb.feed-manifest.v2` with `releaseId`
   `2026-08-25T08-29-41-122Z`, `entryCount` 184, and
   `osskb.search-current.v1` with `indexRevision`
   `feed-2026-08-25T08-29-41-122Z`.
4. **Tag** the merged `main` commit:

   ```sh
   git switch main && git pull --ff-only
   git tag -a v0.3.0 -m "Release v0.3.0" && git push origin v0.3.0
   ```

   CI runs the full suite, then `deploy-production`: the secret check,
   Pages, then the Worker (migrations `v1`, `v2`, cron `37 22 * * *`).
5. **First publication now**, instead of waiting for 22:37 UTC:

   ```sh
   W=https://oss-knowledge-base-data-prod.unknowntpo.workers.dev
   curl -sS -X POST -H "Authorization: Bearer $(security find-generic-password -s osskb-prod-manual-trigger -a oss-knowledge-base-data-prod -w)" $W/run
   # 202 {"ok":true,"scheduled":true}
   ```

   The `$(security … -w)` expands to the token in this shell's command
   line: run it in your own terminal, not a shared or recorded one, and do
   not screenshot or paste it.

### Verify after the release

```sh
W=https://oss-knowledge-base-data-prod.unknowntpo.workers.dev
P=https://oss-knowledge-base.pages.dev
curl -sS $W/health | jq '{environment, running, scheduled, followUp, lastRun: (.lastRun | {ok, completedAt, feedReleaseId, pollTruncated, copiedObjectCount, r2, search}), sources: (.sources | map_values({ok, lastSuccessAt, failureKind})), digest: .digest.enabled, embedding: .searchEmbedding.enabled, gate: .searchQuery.enabled, reviews: has("githubReviews")}'
curl -sS $P/api/feed | jq '{schema, generatedAt, sources: (.sourceTypes | keys)}'
curl -sS "$P/api/search?q=transaction&limit=3" | jq '.retrieval'
bun run verify:health -- --target prod
```

| When | Expected |
| --- | --- |
| After `deploy-production` passed, before any run | `/health` `environment: "production"`, `lastRun: null`, `digest: false`, `embedding: false`, `gate: false`, `reviews: false`. Pages still serves the 2026-08-25 snapshot, now with the stale notice |
| A few minutes after step 5 | `lastRun.ok: true`, `lastRun.search.lexicalRevision: "bm25-reference@3"`, `sources.github/mail/jira.ok: true`, `pollTruncated: true`, `followUp.reason: "catch-up"`: the 30-day window is larger than one run's 200 issues a source, and up to 5 catch-ups 5 minutes apart follow by themselves |
| About 30 minutes after step 5 (`followUp: null`, `running: false`) | 6 runs read up to 1,200 issues a source. Measured 2026-10-19 for 30 days (`bun run measure:daily-volume -- --hours 720`): Kafka GitHub 621 (4 runs, complete), Kafka Jira 494 (3 runs, complete), DataFusion GitHub 2,905 (15 runs: 1,200 read, oldest first). So `pollTruncated: true` still; DataFusion's newest updates are missing until it is complete |
| Backlog complete: the 22:37 UTC tick and the next day's (1–3 ticks in all), or sooner with another `POST /run` each time `followUp` is `null` (each starts 6 more runs; 2 more are enough) | `pollTruncated: false`; `lastRun.r2.classA` = `copiedObjectCount + 3`; `/api/feed` within 150 s: `generatedAt` = `lastRun.completedAt`, sources `github`, `jira`, `mail`; `/api/search` `lexicalRevision: "bm25-reference@3"`; `verify:health` prints `consistent=true` |
| After the 22:37 UTC run | a new `lastRun.completedAt` near 22:37; `classA` near the new objects + 3 |
| Browser, desktop and 375 px | Feed with Jira and dev@ cards, Search, Detail, theme toggle; no person links (`/api/people` 404) and no digest on `/#/kafka/` (the no-digest notice) |

Memory: the full 30-day state is about Dev's 35-day state (9,323 events on
2026-10-14). `bun run --cwd apps/data-publisher-worker measure:memory --
--events 10000 --kafka 1` (10,000 GitHub and 1,454 dev@/Jira events)
peaked at 62.1 MB at "write feed" against the 128 MB limit (2026-10-19).

Stop and roll back when: `lastRun.ok: false` after the retries
(`followUp: null`), a source `ok: false` two days in a row, `classA` far
above `copiedObjectCount + 3 + putRetries + min(conditionalMisses, 50)`
(`r2.classAInvariant` `firing`), or `/api/feed` or `/api/search` answers 503.

### Roll back

Releases are immutable; a rollback moves pointers and deploys. Pages at
`v0.2.0` read only `feed-manifest.v2` and lexical `@1`, so restore the data
before the Pages.

1. Stop the Prod publisher: Cloudflare dashboard → Workers →
   `oss-knowledge-base-data-prod` → Settings → Trigger events → delete the
   cron (browser). Check `/health` `running: false` and `followUp: null`.
2. Restore the saved pointers:

   ```sh
   cd apps/data-publisher-worker
   bunx wrangler r2 object put oss-knowledge-base-prod/public/v2/current.json --remote --content-type application/json --file ~/osskb-prod-rollback/public_v2_current.json
   bunx wrangler r2 object put oss-knowledge-base-prod/public/search/v1/current.json --remote --content-type application/json --file ~/osskb-prod-rollback/public_search_v1_current.json
   ```

   `/api/feed` then shows `generatedAt` 2026-08-25 again (new Pages read v2).
3. Only if the Pages themselves are wrong: Cloudflare dashboard → Pages →
   `oss-knowledge-base` → Deployments → the `v0.2.0` deployment → Rollback
   (browser).

Do not use the `bootstrap-r2` workflow for this: its Prod job runs after,
and needs, a Dev job that re-points Dev to the recorded snapshot too. Fix
forward with a patch tag when the problem is in the code; the Worker cron
is restored by that tag's deploy.

## Health and manual run

`GET /health` returns only the environment, whether a run is active or
scheduled, and the last bounded status. It never returns credentials or event
payloads.

Both the Cron and `POST /run` only schedule a run on the environment's Durable
Object and return; the run itself executes in the object's alarm. The runtime
never runs two alarms at once and retries an alarm that dies, so no lock has to
expire before the next run. An alarm has a 15-minute wall-time limit.

### Publish now (manual run)

```sh
curl -sS -X POST -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/run
# 202 {"ok":true,"scheduled":true}; then, until running is false:
curl -sS https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health
```

HTTP 202 means the run was scheduled; it starts within seconds and takes a
few minutes. It is done when `/health` shows `running: false` and
`lastRun.completedAt` is the time of the request; `/api/feed` serves it
within 150 seconds. A manual run is a full publication: it costs what a
Cron run costs and starts the embedding job like one. Use it

- after a deploy whose effect needs a new release (wherever a runbook or
  spec says "the next publication" or "the next run");
- after the deploy that moved the Cron to once a day, so that Dev is not
  left without an update until 22:07 UTC;
- once after initial secret provisioning, then confirm Feed and Search both
  changed to complete releases before relying on the Cron.

### Follow-up runs (Spec 018)

The Cron fires once a day, so a run that left work behind schedules its own
follow-up on the same alarm:

| After a run that | The object runs again | At most |
| --- | --- | --- |
| published but was cut short by a per-run cap (`lastRun.pollTruncated: true`) | 5 minutes later | 5 times per trigger |
| failed (`lastRun.ok: false`) or published while a source failed (`sources.<key>.ok: false`) | after 10, then 30, then 60 minutes | 3 times per trigger |

`/health` `followUp` shows the one that is waiting
(`{reason, at, catchUps, retries}`) and `scheduled` is `true`; `null` means
nothing will run before the next Cron tick. A Cron tick or `POST /run`
replaces a waiting follow-up and starts new counts. When the retries are
used up and `lastRun.ok` is still `false`, fix the cause and publish
manually; otherwise the next attempt is the next day's tick, and the page
shows the stale warning 27 hours after the last good publication.

## Topic digest (Spec 014)

Dev runs the digest once a day at 22:47 UTC (`DIGEST_CRON` and the second
`triggers.crons` entry, `47 22 * * *`), 40 minutes after the publication.
Its alarm waits 15 minutes at a time, at most 4 times, while the publisher
runs or a follow-up is waiting, so the latest start is 23:47 UTC. Prod has
no digest.

Limits a run works under:

- **5,000 neurons a UTC day** (`/health` `digest.today`), counted as the
  price table's estimate × 1.28. One run is about 2,200; dry runs count.
- **60 requests an hour** on the gateway `osskb-digest-dev`. One run makes
  about 38 and at most 50. Keep the end of one run and the start of the
  next 60 minutes apart, the 22:47 run included. A refused call
  (`2003: Rate limited`) is not retried: the run ends `limited`.

### Dry run (calls the models, writes nothing)

```sh
curl -sS -X POST -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  "https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/digest/run?dryRun=1" > dry-run.json
```

The answer comes after one to two minutes: the run result with
`objects {en, "zh-Hant"}` and up to 10 `rawSamples`. It spends neurons and
gateway requests like a real run. Check:

| Field | Good |
| --- | --- |
| `ok`, `limited` | `true`, `false` |
| `modelErrors` | `[]` |
| `modelCalls` | at most 50 (about 38) |
| `estimatedNeurons` | about 2,200; over 2,500 means a second run that UTC day may end `limited` |
| `calibration.clefCanaryMisses`, `clefCalls` | 0, above 0 |
| `fallbacks`, `rejections`, `style` | few fallbacks; `rejections` explains each empty card; `style.contentFree` a small share of `style.sentences` |
| `objects.en.cards`, `objects["zh-Hant"]` | read the sentences |

Then compare cost: in the gateway `osskb-digest-dev`, the logged cost of the
run's requests divided by $0.000011 is its neurons; divided by
`estimatedNeurons` it should be between 0.8 and 1.2. Outside that,
`DIGEST_NEURON_CALIBRATION` is wrong (gardening G51).

### Real run (publishes)

```sh
curl -sS -X POST -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/digest/run
# 202 {"ok":true,"scheduled":true}; 409 while a digest run is pending
```

The run executes in the object's alarm. A run for a release whose complete
pair exists calls no model (`reused: "pair"`). The page serves the new
digest within 150 seconds.

### Reading `/health` `digest`

- `enabled`, `running`, `scheduled`: the flag, an active run, a pending
  alarm (also a deferred one).
- `today {date, estimatedNeurons, cap}`: the UTC day's ledger. It is
  stored before each model request (Spec 014 D93), so during a run it
  includes the requests in flight, and a run that died leaves what it
  spent: a retry starts from there.
- `lastRun`: the last run, dry or real (`dryRun`).
  - `ok: true`, `limited: false`, `fallbacks: 0`: complete.
  - `limited: true`: the daily cap, the 50-request ceiling, or a platform
    refusal (`modelErrors` with kind `limit`) stopped the models. The
    digest was still published with fallback cards. The next day's run
    replaces it; so does a manual run for the same release.
  - `ok: false` with `failureKind`: nothing was published and the page
    keeps the previous digest, which turns stale 36 hours after it was
    generated.
  - `sourceReleaseId`: the Feed release it read; after 22:47 UTC it should
    be that day's `…T22-07-…` release.
  - `deferred`: how many times the alarm waited for the publisher.
  - `reused`, `objectKeys`, `modelCalls`, `estimatedNeurons`,
    `spentToday`, `calibration`, `style`, `rejections`.

### First scheduled run after the deploy (Spec 014 D92)

The deploy sets the cron, so the next 22:47 UTC tick publishes.

1. Merge at least three hours before 22:47 UTC, on a UTC day with no
   digest run (`digest.today.estimatedNeurons` 0).
2. `/health`: `digest.today.cap` is 5000 once the deploy is live.
3. Dry run, ended before 21:47 UTC. Check it as above.
4. Good: do nothing; the 22:47 tick publishes. Bad: merge a PR that removes
   `DIGEST_CRON` and its cron entry before the tick.
5. After 22:50 UTC (later by 15 minutes per deferral): `digest.lastRun`
   has `dryRun: false`, `ok: true`, `limited: false`, that day's
   `sourceReleaseId`, and `objectKeys`;
   `/api/digest?projectId=apache-kafka&locale=zh-Hant` on Dev answers 200
   and `/#/kafka/` shows the digest.

### Turn off

Remove `DIGEST_CRON` and the `47 22 * * *` entry of `triggers.crons`
together (test `D86`) and deploy; `POST /digest/run` still works. The
published digest stays; deleting `public/digest/v1/apache-kafka/current.json`
returns the page to the no-digest notice.

## R2 operations and cost

R2 bills requests by class, for the whole account (both buckets):

| Class | Requests | Price | Included a month |
| --- | --- | --- | --- |
| A | `put`, `list`, copy, multipart | $4.50 per million | 1 million |
| B | `get`, `head` | $0.36 per million | 10 million |

A conditional put whose precondition fails (`if-none-match: *` on an existing
key) is still a Class A operation. Deletes are free.

`/health` `lastRun.r2 { classA, classB, putRetries, conditionalMisses }` is
what the last run's publication sent, retries included (Spec 008 C9).
`putRetries` counts put attempts after the first (R2 errors such as 10001,
up to 3 attempts, each billed); `conditionalMisses` counts conditional puts
that found the key already written (counted as reused). Both are already in
`classA`; records before Spec 028 D11 (2026-10-23) lack them. Expected for a
steady daily run: `classA` = `copiedObjectCount + 3 + putRetries +
conditionalMisses` (two pointers, one evidence object; `r2.classAInvariant`
subtracts at most 50 `conditionalMisses`, see below) and `classB` =
`copiedObjectCount + reusedObjectCount + 3` (plus head and get retries).
Each retry is one log line, `r2 <op> retry <n> of 2 for <key>: <error>`,
carrying the run's `runId` while `OBSERVABILITY_SIGNALS` is on.

`r2.classAInvariant` (Spec 028 D11, A1) judges excess = `classA −
(copiedObjectCount + 3 + putRetries + min(conditionalMisses, 50))`: `warn`
above 3, `firing` above max(50, 0.5 × `copiedObjectCount`). A `warn` on a
record without the two counters is the 2026-10-23 shape (a few uncounted
retries). At most 50 conditional misses are subtracted, so a recurrence of
the 2026-10-13 cause (a large `conditionalMisses`) still fires this rule.

```sh
curl -sS https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health | jq '.lastRun | {ok, completedAt, copiedObjectCount, reusedObjectCount, r2}'
```

| Who | When | Class A | Class B |
| --- | --- | --- | --- |
| Publication | once a day, each environment (Spec 018), plus follow-up and manual runs | new objects + 3 (Dev: 391 on the first daily run, 2026-10-13; an hourly run was about 40) | objects + 3 (Dev: 8,343 on that run) |
| Embedding job | after each publication, and hourly while work is left, Dev | 0 | 2 + shards (about 12) |
| Digest | once a day on Dev (22:47 UTC), plus manual `POST /digest/run` | 2–4 (one `list`, the pointer, two objects when new) | up to 300 |
| Review queue | manual `POST /review-queue/run` | 3–4 | 4–5 |
| GitHub review ingestion (Spec 022) | Dev: each publisher tick (`GITHUB_REVIEWS=metadata@1`); Prod: off | 5 (two month objects, two cursors, the run record); up to 9 | 4; up to 8 |
| GitHub review backfill (Spec 022, once) | manual `POST /github-reviews/backfill`, about 12 calls | per call: months written (at most 13 per project), progress per project, the record; about 120 in all, bound about 300 | per call: cursor, progress, months read per project; at most about 300 in all |
| `/health` | per request | 0 | 1; 3 while `GITHUB_REVIEWS` is set (also `githubReviews` and `githubReviewsBackfill`) |
| Pages `/api/*` | per request | 0 | 2–3; `/api/search` at most 13 on Dev |
| CI `bootstrap-r2` | manual workflow | one per object | 0 |

A month of daily Dev publications is about 12 thousand Class A and 0.25
million Class B at the first daily run's volume (391 and 8,343; Spec 018
estimated 1.2 thousand Class A from an hourly run's 40 new objects, but a
daily run writes a day's new objects: gardening G68). Hourly, until Spec 018:
about 28 thousand and 6.0 million. Act when:

- `lastRun.r2.classA` is far above `copiedObjectCount + 3`, or
  `conditionalMisses` is more than a handful: something writes
  what already exists (the incident of 2026-10-13, Spec 008 "R2 operations":
  8,150 failed conditional puts an hour, $4.50 in six days).
- `lastRun.r2.classB` passes about 13,700 a run in one environment, or the
  two environments together pass it: Class B leaves the included 10 million
  ($0.36 per further million). The fix is gardening G59.
- `classA + classB` nears 20,000: that is the run's R2 requests against the
  Worker's `limits.subrequests`.

## Cost guard (Spec 026)

Account-wide cost monitoring and a circuit breaker
([spec](../specs/026-cost-guard/spec.md)). Dev: `monitor` since the Dev
monitor enable PR (2026-10-21). Prod: off (`COST_GUARD` unset, no
`COST_GUARD_STATE` binding, no token). The check rides
the publisher tick once a day, reads R2 operations and storage for the whole
account over the GraphQL Analytics API, and adds Vectorize and Workers AI
estimates from this Worker's own ledgers. It writes one Durable Object key
and makes no R2 request.

### Create the token (owner, once per environment)

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → Create
   Custom Token.
2. Permissions: **Account › Account Analytics › Read**, and nothing else.
   Account Resources: include only this account. No zone permission, no IP
   filter needed, a TTL if you want one.
3. Put it as a Worker secret (it is read from stdin, never echoed):

```sh
cd apps/data-publisher-worker
bunx wrangler secret put CF_ANALYTICS_TOKEN -c wrangler.development.jsonc
```

The account id is not secret: the enable PR sets `CF_ACCOUNT_ID` as a var.

### Enable `monitor` on Dev (the enable PR)

The PR adds the `CostGuard` migration (`v5`), the Worker's
`COST_GUARD_STATE` binding, `CF_ACCOUNT_ID`, and `COST_GUARD=monitor`. The
breaker state is read only from `/health`; the web app shows nothing for it. After its deploy:

```sh
DEV=https://oss-knowledge-base-data-dev.unknowntpo.workers.dev
# Evaluate now; writes nothing, opens nothing.
curl -sS -X POST -H "authorization: Bearer $MANUAL_TRIGGER_TOKEN" "$DEV/cost-guard/check?dryRun=1" \
  | jq '{ok, status, metrics: (.metrics | map_values({value, percent, projectedPercent, rateDays, overageUsd, projectedOverageUsd, status})), unclassifiedActions, lastError}'
```

`projectedPercent` of R2 Class A and B and of queried dimensions is month to
date plus the average of the 7 complete UTC days before today times the
remaining days of the month (`rateDays` says how many days it used; 0 means
no history, and the projection equals month to date). A burst that has
stopped is therefore not projected for the rest of the month: on
2026-10-21 Class A showed 211.52 %, where month to date ÷ days elapsed gave
318 %. Neurons still project today's value over the elapsed day.
`overageUsd` and `projectedOverageUsd` are each metric's dollars over its
allowance at list price; nothing trips on them yet.

Expect `ok: true` and R2 Class A/B within a few percent of the dashboard's
R2 → Metrics month to date. `unclassifiedActions` lists action types the
pricing page does not name (counted as Class A); report any. Save the raw
GraphQL answer as the fixture (CG19). Stop and unset `COST_GUARD` if `ok` is
false twice.

If `lastError.message` reads `GraphQL answered 403` or a GraphQL error such
as "not authorized", the token lacks **Account Analytics › Read** (for
example it was made with Account Settings › Read). Edit the token's
permissions in the dashboard, or create a new one and put it again with
`wrangler secret put`; no deploy is needed. Then run the dry check again.

### Read `/health`

```sh
curl -sS "$DEV/health" | jq '.costGuard | {mode, status, reason, checkedAt, breaker, lastError, metrics: (.metrics | map_values("\(.percent)% \(.status)"))}'
```

| `status` | Meaning | Do |
| --- | --- | --- |
| `pending` | configured, no check yet | wait for the next tick, or run the dry check |
| `ok` | every metric under 60 % | nothing |
| `warn` | a metric at 60 % or more (Vectorize stored dimensions only ever warns) | look at the metric |
| `tripped` | the breaker is open (`breaker.reason`, `breaker.metrics`) | under `enforce`: digest, embeddings and semantic queries refuse; publication pauses only if `breaker.metrics` has `r2ClassA` |
| `unconfigured` | `reason` names the missing token, account id or binding | fix the configuration |

`scope: "account"` metrics (R2) cover both environments; `scope: "worker"`
ones only this Worker (Prod has no `AI` or index, so they are `unavailable`).

### Reset the breaker

Only by hand; a check, a new month or a deploy never closes it.

```sh
curl -sS -X POST -H "authorization: Bearer $MANUAL_TRIGGER_TOKEN" "$DEV/cost-guard/reset"
# {"ok":true,"breaker":{"tripped":false},"lastResetAt":"…"}
```

Before resetting, find and fix the cause (for R2 Class A: compare
`lastRun.r2.classA` with `copiedObjectCount + 3 + putRetries +
conditionalMisses`, section above). If the
metric is still over its threshold, the next check opens the breaker again;
to keep working until the month renews, set `COST_GUARD=monitor` instead.

### Turn off

Unset `COST_GUARD` (a var change and deploy). Nothing is refused, no check
runs, and `/health` loses `costGuard`; the stored breaker stays in the object
and applies again only if `enforce` is set again.

## R2 retention dry run (Spec 029)

Retention is its own job: its own cron (`RETENTION_CRON`, Dev `17 10 * * *`),
its own alarm invocation of `PipelineState`, its own `/health` field. This
build only lists and reports; it has no code that deletes or writes R2.
`enforce` is reported as `unconfigured`. Prod has no flag and no cron.

| `R2_RETENTION` | Effect |
| --- | --- |
| unset, blank, `off` (Prod) | the 10:17 tick does nothing; no `/health.retention`; `/retention/report` 404 |
| `dry-run` (Dev since 2026-10-23) | once a UTC day: lists, reads, stores `retention-last-run` and `retention-report` in the Durable Object |
| anything else, `enforce` included | nothing runs; `/health.retention {status: "unconfigured", reason}` |

Per run: at most 400 list calls (Class A), 600 get calls (Class B) and
10 minutes, else `status: "overrun"`. Expected on Dev today: about 306
Class A and 527 Class B; about 9,500 Class A a month if left on daily.

### Enable `dry-run` on Dev (its own PR)

1. Change `R2_RETENTION` to `"dry-run"` in `wrangler.development.jsonc`
   only. Merge outside 21:50–23:05, 02:05–02:30 and 03:30–03:55 UTC; the
   deploy job publishes it.
2. Before 10:17 UTC: `/health.retention` is
   `{mode: "dry-run", status: "pending", lastRun: null}`.
3. After 10:17 UTC (the run takes under a minute; the 10-minute cap is the
   stop):

   ```bash
   curl -s https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health | jq .retention
   curl -s -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
     https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/retention/report > retention-report.json
   jq '{pointers, retained: (.retained | length), releases: (.candidates.releases | length), evidence: (.candidates.evidence | length), pool: .candidates.pool | {objects, bytes}, truncated}' retention-report.json
   ```

   Expect `status: "ok"`, `lastRun.deleted {objects: 0, bytes: 0}`,
   `complete` all `true`, `reason: null`, `r2.classA` ≤ 400, `r2.classB`
   ≤ 600; candidate releases only from 2026-09-02 up to about 30 days
   before the run; `lastRun.pointers` equal to `/api/feed`'s release.
4. **Stop** (set `R2_RETENTION` back to `off`) if a current release, the
   digest's `sourceReleaseId` or the embedding job's `lastRun.releaseId`
   is among `candidates.releases`; if `status` is `failed` or `overrun`
   twice; or if that evening's publication or digest fails.
5. The owner reviews `retention-report.json` before any `enforce` PR
   (RT21). Do not commit the report; attach its summary to that PR.

`skipped` reasons: `publication-pending` (a publication was running,
requested or scheduled at 10:17; the next day's slot runs),
`already-ran-today`, `paused` (cost guard). None changes the publication's
`/health` fields or HTTP status.

### Turn off

Set `R2_RETENTION` to `off` (or remove it). The stored report stays in the
Durable Object and is no longer served; nothing in R2 changed.

## Observability / logs

Workers Logs is on for both data Workers (`observability.enabled: true`,
`head_sampling_rate: 1` in `apps/data-publisher-worker/wrangler.{development,production}.jsonc`):
every invocation (Cron, alarm, `fetch`) and its `console` output is kept. Pages
(`apps/web`) has no Workers Logs setting.

- **Where:** Cloudflare dashboard → Workers & Pages → `oss-knowledge-base-data-dev`
  (or `oss-knowledge-base-data-prod`) → Observability. Filter by trigger
  (cron, alarm, fetch) or search the message text, e.g.
  `search embedding run failed`, `after-publication hook failed`. Live tail without
  storage: `bunx wrangler tail -c wrangler.development.jsonc` in `apps/data-publisher-worker`.
- **Retention and budget:** 7 days on Workers Paid; 20 million log events a
  month included per account (both Workers together), billed per further
  million. Each invocation is at least one event; scheduled runs and their
  alarms stay far below the budget, so check the dashboard's usage if
  `/health` or `POST` routes see unusual traffic.
- **What is logged:** every error text goes through `errorText` /
  `sanitizeErrorMessage` (`packages/semantic-vectorize/src/sanitize.ts`), which
  redacts `Bearer …` and token-like strings; no route logs request headers.
  `apps/data-publisher-worker/test/observability.test.ts` fails on a `console`
  call that interpolates a raw `error.message`.
- **Disable:** set `"enabled": false` (or lower `head_sampling_rate`, 0–1) in the
  environment's config and deploy it the usual way (Dev: merge to `main`; Prod:
  the next `v*` tag; Prod gets Workers Logs with `v0.3.2`). A dashboard toggle works at once but the next deploy
  restores the config's value.

## Failure and rollback

- A GitHub error, incomplete page sequence, validation error, or R2 error keeps
  the previous complete pointers readable.
- HTTP 409 from a manual run means a run is active or about to start; do not
  start another. A follow-up that is only waiting does not cause 409: the
  manual run replaces it.
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
Spec 016 H42, `@3` from Spec 017 N17); production sets `bm25-reference@3`
from the first Prod release on (`wrangler.production.jsonc`, test `H39`).

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
publication (once a day, Spec 018) the publisher asks it to run, and while a
run leaves work it runs again by itself an hour later (00:05 UTC of the next
day after a day cap; Spec 016 Behavior 46), so "the next run" below is at
most an hour away, not a day; it embeds the current Search
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
  third release in a row without it: about three days at one release a
  day. A rollback to an older release counts as a release too. Check the
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
3. The next publication (22:07 UTC, or `POST /run` to publish now) starts a
   run, which continues hourly by itself until `pending` is 0; `POST
   /search-embedding/run` with the bearer token starts one at once (202;
   409 means one is pending).
4. Watch `searchEmbedding.lastRun` until `pending` is 0 and, a run later,
   `index.mutationsProcessed` is `true` (once nothing is pending the next
   run is the next publication's, or `POST /search-embedding/run`). Check the gateway `osskb-search-dev`
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
whose similarity stands out passes the first three lexical threads;
implemented, enabled nowhere, and not recommended yet: Spec 016 Decision 50
keeps Dev on `rrf-group@2` until the embedding text has been revisited); any other value answers lexically with `failed`. The gate,
its caches, and the embeddings are the same for both, so a switch costs no
model call and no index query, and nothing stored changes.

Compare offline first (no network):

```sh
bun run eval:search-fusion --rows     # both revisions over the committed capture
bun run eval:search-similarity --rows # rrf-group@3 and the similarity report, over the scored capture
```

Switch (one PR; Dev is at `rrf-group@2` since Spec 016 rollout step 7, 2026-10-13, so the steps below name the value to change to):

1. `apps/web/wrangler.development.jsonc`: `"SEARCH_SEMANTIC": "<revision>"`
   (`rrf-group@1`, `rrf-group@2`, or `rrf-group@3`).
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
| Hybrid search in `/api/search` | Pages Function | Pages var `SEARCH_SEMANTIC=rrf-group@2` (the value names the fusion revision; see "Switch the fusion revision"); Pages Durable Object binding `SEARCH_QUERY_GATE` → `SearchQueryGate` of `oss-knowledge-base-data-dev` |

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
calls a clock hour. With the digest's 5,000 (its ledger counts measured cost, Spec 014 D90)
and the embedding job's 2,500 that is 8,500 of the 10,000 neurons a day the
plan includes (1,500 of headroom); 31 days of
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
   after the next publication (22:07 UTC, or `POST /run`) `run.search.shardRoots: true` and the
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

## Contributor activity log (Spec 019 slice 2b)

`PEOPLE_ACTIVITY=log@1` makes each publication append the records its state
holds to `internal/people/v1/<projectId>/` (month objects, their summaries,
`state.json`) before the state is compacted. On for Dev (`log@1`, the enable
PR of 2026-10-15); off on Prod. Unset: no R2 request, no `appending-activity` phase, no
`lastRun.activity`. Format, identity rules and cost: [Spec 019 amendment
(2)](../specs/019-contributor-profile/spec.md#amendment-2026-10-15-2-slice-2b-the-activity-log).

When it is on:

- It runs inside the publication Durable Object, after the evidence is
  recorded and before `committing-state`. Its failure never fails the
  publication: `lastRun.ok` stays `true`, `lastRun.activity.ok` is `false`
  with `error`, and `state.json` keeps the previous `updatedAt`. The next run
  rebuilds every row from the state (35 days), so a missed day is repaired
  without action.
- `/health` `lastRun.activity`: `ok`, `revision`, `rows`, `monthsRead`,
  `monthsWritten`, `monthsUnchanged`, `identities`, `earliestMonth{}`,
  `coverageFrom{}`, `bytesWritten`, `durationMs`, `r2 {classA, classB}`.
  These R2 counts are the append's own; `lastRun.r2` is still the
  publication's alone.
- Limits per run, both projects: `r2.classB` ≤ 26, `r2.classA` ≤ 50. A run
  whose months did not change writes only the two `state.json` objects
  (`classA` 2). `monthsWritten` above 4 on an ordinary day is unusual (a
  pull request opened in an older month changed); above 24 is impossible and
  means a bug.
- `/api/people` (Pages) lists `recorded` sources per project; Jira and dev@
  author names in Detail link only once the log's `state.json` exists.

### Enable on Dev (the enable PR)

Do not merge between 21:50 and 22:50 UTC: the daily publication (22:07),
the review ingestion on the same tick and the digest (22:47) run then.

1. Before merging, read Dev `/health`: `lastRun.ok` is `true`, `phase` is
   `null`, `running` is `false`, and `lastRun.activity` is absent. Stop if a
   run is in progress or the last run failed.
2. Merge. CI deploys the Worker with `PEOPLE_ACTIVITY=log@1`. Check `/health`
   again: still no `lastRun.activity` (no run since the deploy).
3. First append: the next 22:07 UTC run (or the owner's `POST /run`).
   Expected `/health` after it: `lastRun.ok: true`; `lastRun.activity.ok:
   true`, `revision: "log@1"`, `monthsRead` = `monthsWritten` = 2 per
   project with rows (Kafka and DataFusion: September and October, so 4),
   `monthsUnchanged: 0`, `rows` about 7,000–9,500 (Dev held 9,323 events on
   2026-10-14, bots and roots older than the coverage excluded),
   `identities` several hundred, `coverageFrom` 35 days before the run for
   both projects, `r2` about `{classA: 10, classB: 6}`, `durationMs` under
   10,000. `lastRun.r2` and the run's total time near the previous day's.
   Then `/api/people` lists `kafka: ["github-reviews", "github", "jira",
   "mail"]`, and `/#/kafka/people/mail%3Aandrew%20schofield` shows dev@
   counts with the coverage line "Comments, pull requests, Jira, dev@:
   <coverageFrom> to <run date>".
4. Second run (the next day's, or a second `POST /run`): `activity.ok:
   true`, `monthsUnchanged` at least 1, `monthsWritten` small (the current
   month, plus any month whose rows changed), `r2.classA` = 2 × `monthsWritten`
   + 2, `coverageFrom` unchanged. Every write is a plain put, so there is no
   conflict state to check; a second run that writes every month again
   (`monthsUnchanged: 0` with no new records) means the encoding is not
   stable: turn it off.
5. Stop and roll back if: `lastRun.ok` turns `false` after the deploy; a run
   is killed in `appending-activity` (`phase.phase`); `activity.durationMs`
   above 60,000; `r2.classA` above 50; or the run's total time grows by more
   than a minute.

### Turn off or roll back

Remove `PEOPLE_ACTIVITY` from `apps/data-publisher-worker/wrangler.development.jsonc`
and merge (CI redeploys). The next run has no append and no
`lastRun.activity`. The objects under `internal/people/v1/` stay; profiles
keep showing the log's data up to its last append with that end date. To
hide it as well, delete the two `state.json` objects
(`internal/people/v1/apache-kafka/state.json`,
`internal/people/v1/apache-datafusion/state.json`): the page then says "not
recorded yet" again and Jira and dev@ names stop linking. Deleting objects is
the owner's step. Re-enabling after the state was deleted starts a new
coverage 35 days before that run.

## GitHub review ingestion (Spec 022)

On for Dev (`GITHUB_REVIEWS=metadata@1` since 2026-10-14, `metadata@2` since 2026-10-15, Spec 022
decision 3); off on Prod, where the Worker sends no request for it and
`/health` has no `githubReviews` field. The first Dev tick after the deploy
reads one day back and stores `coverageFrom` there (RV26). The steps, the
dry run that checks the token first, and the expected values are in
[Spec 022, Enabling on Dev](../specs/022-github-reviews/spec.md#enabling-on-dev).

Three checks when enabling, all in the spec's steps:

1. The dry run (`POST /github-reviews/run?dryRun=1`) must answer `ok: true`
   for both projects: it proves the Dev token may use GraphQL. `auth` means
   it may not; stop.
2. The **second** real run must replace a month object (`monthsWritten` at
   least 1 or `changed` above 0) with no `failureKind: conflict`. The write
   is conditional on the ETag read (`R2Object.etag` passed to
   `onlyIf.etagMatches`), and that has only been tested against a fake
   bucket. On `conflict`, remove the variable.
3. A run cut at the cap takes about 70 s. Until one has completed from the
   Cron (`truncated: true`, `ok: true`), use the manual route for anything
   backfill-sized; it runs while the caller waits.

When it is on:

- It runs in the Worker invocation of the daily tick, not in the
  publication's Durable Object. A failure never changes a publication, and
  nothing retries it before the next tick; `POST /github-reviews/run` with
  the bearer token runs it now, `?dryRun=1` without writing.
- `/health` `githubReviews` is the last run record. Per project: `ok`,
  `cursor`, `coverageFrom` (reviews before it were never read), `pulls`,
  `reviews`, `added`, `truncated`, `restRequests`, `graphqlRequests`,
  `failureKind`.
- `failureKind: config`: the flag value is not `metadata@1` or `metadata@2`, or the token is
  missing. `auth`: GitHub refused the token (a token without GraphQL access
  fails here). `rate-limit`, `transport`, `schema`: the project keeps its
  cursor and the next tick reads the same reviews. `conflict`: two runs
  overlapped; the next one repairs it.
- `truncated: true` means more than 500 pull requests were waiting; each
  further run reads 500 more.
- To turn off, remove the variable. The objects under
  `internal/github-reviews/v1/` stay; nothing reads them.

### Backfill (Spec 022 Behavior 13; decision 5: 12 months)

Once, by hand, on Dev only. It fills the review store from `from` up to the
daily run's `coverageFrom`, then moves `coverageFrom` to `from`. The daily
cursor's `updatedAt` is never touched, so the daily tick goes on as before.

Before the first call:

1. The daily ingestion has run at least twice on Dev and the **second** run
   passed the conflict check above (`monthsWritten` at least 1 or `changed`
   above 0, no `conflict`). The backfill replaces month objects with the
   same conditional write.
2. The whole sequence takes about 14 minutes: finish before 22:00 UTC or
   start after 22:30 UTC (the daily tick). An overlap is safe (a
   `conflict`, repaired by the next call) but wastes a call.

Dry call (reads GitHub, writes nothing; expect `ok: true`, each project
`pulls` about 500, `done: false`):

```sh
curl -sS --max-time 300 -X POST -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  'https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/github-reviews/backfill?from=2025-10-14&dryRun=1' \
  | jq '{ok, from, projects: (.projects | map_values({ok, done, pulls, reviews, restRequests, graphqlRequests, durationMs, failureKind, error}))}'
```

Then the calls, about **12** (Kafka is done after about 8, DataFusion after
about 12); each takes up to about 70 s while `curl` waits, about 12 minutes
of calls (about 14 with the dry call and checks). In bash or zsh:

```sh
URL='https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/github-reviews/backfill?from=2025-10-14'
for call in $(seq 1 20); do
  body=$(curl -sS --max-time 300 -X POST -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" "$URL")
  echo "$body" | jq -c '{call: '"$call"', ok, projects: (.projects | map_values({done, pulls, added, monthsWritten, cursor, failureKind}))}'
  echo "$body" | jq -e '.ok' >/dev/null || break
  echo "$body" | jq -e '[.projects[].done] | all' >/dev/null && break
done
```

Progress, at any time:

```sh
curl -sS https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health \
  | jq '{backfill: (.githubReviewsBackfill | {ok, from, completedAt, projects: (.projects | map_values({done, until, cursor, coverageFrom, pulls, added, reviewsTruncated, failureKind}))}), daily: (.githubReviews.projects | map_values({coverageFrom, cursor}))}'
```

`cursor` walks from 2025-10-14 towards today (the update time of the last
pull request read); `done: true` means the listing reached the present and
`coverageFrom` is `2025-10-14T00:00:00.000Z`. The daily `githubReviews`
shows the new `coverageFrom` from its next run on.

**Resume:** call again with the same `from`. Progress lives in
`internal/github-reviews/v1/<projectId>/backfill.json` and moves only after
the call's months are written, so a cut connection, a timeout, a
`conflict`, `transport` or a short `rate-limit` costs one repeated chunk and
no row. A project that is done sends nothing to GitHub on later calls.

**Stop and investigate when:**

- `failureKind: config`: no daily cursor yet (run the daily ingestion
  first), or "a backfill from X is in progress" (call with `from=X`), or the
  flag or token is wrong.
- `auth`, or `rate-limit` with a `Retry-After` above 60 s: stop for an hour;
  the backfill and the daily publication share the token.
- `schema`, `internal`, or the same failure three calls in a row.
- 20 calls without both projects `done` (about 12 are expected).
- `reviewsTruncated` above 0 is not a stop: note the count (Spec 022 known
  limit 5).

Expected at the end: both projects `done: true`, about 17,000 Kafka and
15,000 to 18,000 DataFusion rows added in all, 13 month objects per project
(about 4 MB each project), about 150 listing and 400 GraphQL requests (at most about 475 with the 300 s overlap), and
R2 about 120 Class A (bound about 300) and at most about 300 Class B. Record
the totals as RV35 evidence.

### Areas and names (`metadata@2`, Spec 022 amendment 2026-10-15)

`GITHUB_REVIEWS=metadata@2` makes the same daily run also store, per month,
each reviewed pull request's label names and title KIP ids (`pulls`) and
logins' public names (`people`), with no extra request. Months written before
it have none until the refresh fills them; the profile draws no area chart for
a period that is not fully covered (Spec 019 W49).

Refresh, once, by hand: `POST /github-reviews/refresh-areas[?dryRun=1]` with
the bearer token, repeated until `/health` `githubReviewsRefresh.projects.*.done`
are both `true` (8 to 12 calls of about 70 s on Dev's 12 months). It lists
nothing and keeps no progress object: each call reads the cursor and the
store's months, takes up to 500 pull requests without an entry, oldest month
first, and writes the months it filled. Steps, expected values and stop
conditions: [Spec 022, Enabling `metadata@2` on Dev](../specs/022-github-reviews/spec.md#enabling-metadata2-on-dev-operator-sequence).
Avoid 21:55–22:35 UTC (the tick) and 22:45–22:50 UTC (the digest).

- `failureKind: config` on the refresh: the flag is `metadata@1`, or the
  project has no daily cursor. `conflict`: the daily run wrote a month
  meanwhile; call again. `labelsTruncated` above 0: a pull request has more
  than 30 labels; raise `LABELS_PER_PULL` before going on.
- To turn off: set the variable back to `metadata@1`. Stored `pulls` and
  `people` stay and are kept by later runs.
