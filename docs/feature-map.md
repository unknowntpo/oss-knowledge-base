# Feature map

What a verifier can open, call, and select, and which acceptance IDs cover it.
Derived from the code on `main`; update it in the PR that changes behavior.
Commands: `bun run verify:ui`, `bun run verify:health` (see
[Verification kit](#verification-kit)).

## Environments

| Environment | Web (Pages) | Publisher worker | R2 bucket |
| --- | --- | --- | --- |
| Local E2E | http://127.0.0.1:8788 (`bun run build && bun run e2e:prepare && bun run e2e:server`; `bun run test:e2e` starts the server itself but does not build, so run `bun run build` first) | none | `oss-knowledge-base-local` (`apps/web/.wrangler/e2e-state`) |
| Dev | https://oss-knowledge-base-dev.pages.dev | https://oss-knowledge-base-data-dev.unknowntpo.workers.dev (Cron `7 * * * *`) | `oss-knowledge-base-dev` |
| Prod | not live (https://oss-knowledge-base.pages.dev deploys on a `v*` tag) | `oss-knowledge-base-data-prod`; URL unknown (no `workers.dev` URL is recorded in the repo) (Cron `37 * * * *`) | `oss-knowledge-base-prod` |

### Dev access (Cloudflare Access)

Dev Pages (https://oss-knowledge-base-dev.pages.dev and its preview subdomains
`*.oss-knowledge-base-dev.pages.dev`) is meant to sit behind Cloudflare Access.
The publisher worker on `workers.dev` and Prod are not behind Access.

- Automated clients authenticate with a service token: `CF_ACCESS_CLIENT_ID`
  and `CF_ACCESS_CLIENT_SECRET`, sent as `CF-Access-Client-Id` /
  `CF-Access-Client-Secret` headers. Both unset means no headers (the behavior
  before Access existed); only one set is an error.
- The headers go only to https URLs on the Dev Pages host or its subdomains
  (`isAccessProtected` in `scripts/verify/access.ts`), never to the publisher,
  Prod, local, or third-party origins.
- Redirects never carry the token. In the browser, `accessRouteHandler`
  fetches Dev Pages requests with `maxRedirects: 0` and fulfils the response,
  a 3xx included; the browser follows that redirect itself with only its own
  headers. Playwright does not route the redirected hop, so it is not
  re-checked: a same-site redirect (Dev to Dev or to a preview subdomain) also
  arrives without the token and would be challenged once Access is on (Dev
  Pages has none today). The token-bearing `request` context has
  `maxRedirects: 0`.
- CI: the `E2E — deployed development` job reads both from GitHub Actions
  secrets. `apps/web/deployed-e2e/fixtures.ts` routes Dev Pages browser
  requests through `accessRouteHandler`, gives `request` a Pages-only context
  (errors rethrown with the values replaced by `***`; every target, including
  protocol-relative, backslash and mixed-case-scheme forms and `Request`
  objects, is resolved against `baseURL` and refused unless it is on the Dev
  Pages host), and calls the publisher through a separate
  `publisherRequest` context without the token.
- Evidence is public, so before upload `scripts/verify/redact-artifacts.ts`
  replaces both values in every file of the report and test results (inside
  trace zips and the report's embedded zip too), then fails the job, and skips
  the upload, if any copy (plain or base64) is left. Known limit: see
  [gardening G30](gardening.md#g30-the-evidence-redaction-gate-does-not-decode-every-encoding). Playwright's HTML report records request
  headers of a failed API call even when the error is redacted, so this step is
  required. Tracing also stays off while a token is set.
- `bun run test:e2e:access` (part of `test:e2e`) checks the scoping on the
  wire with a dummy token through a local proxy (`apps/web/access-e2e`); the
  unit suite forces a connection failure and checks that no evidence file keeps
  the dummy value after redaction (`scripts/test/access-leak.test.ts`).
- `verify:ui` and `verify:health --target dev` read the same variables. Without
  them, an Access login redirect (to `*.cloudflareaccess.com`) or a 401/403
  from Dev Pages fails with a message telling you to set them; with a token
  sent, the message says it was rejected. Values are used exactly as set (not
  trimmed).
  Neither command prints the values.
- Local use: keep the token in the macOS Keychain and export it only for the
  command, never echo it:

  ```sh
  security add-generic-password -s oss-kb-cf-access-id -a "$USER" -w      # prompts for the value
  security add-generic-password -s oss-kb-cf-access-secret -a "$USER" -w
  export CF_ACCESS_CLIENT_ID=$(security find-generic-password -s oss-kb-cf-access-id -w)
  export CF_ACCESS_CLIENT_SECRET=$(security find-generic-password -s oss-kb-cf-access-secret -w)
  bun run verify:health -- --target dev
  ```

Local fixture: `packages/reference-pipeline/test/fixtures/github-feed-projection.v1.json`, plus the Spec 014 digest fixtures `apps/web/test/fixtures/digest/apache-kafka.{en,zh-Hant}.json` (regenerate with `bun apps/data-publisher-worker/scripts/build-digest-fixture.ts`; zh-Hant uses hand translations),
3 Feed cards (Kafka, DataFusion), `generatedAt` `2026-08-25T12:00:00Z`; search
fixture from `packages/search/test/fixtures/golden-queries.v1.json` (`KIP-405`
returns results), published at `bm25-reference@1`. `e2e:prepare` also seeds a
second local bucket state (`apps/web/.wrangler/e2e-state-lexical2`, served at
`http://127.0.0.1:8789` by `playwright.lexical2.config.ts`, `bun run
test:e2e:lexical2`) whose Search release is golden v2 at `bm25-reference@2`
(Spec 016 H34). Config: `apps/web/wrangler*.jsonc`, `playwright*.config.ts`.
The local fixtures carry no dev@ or Jira entries; Spec 012 data exists on Dev
after deployment and in `packages/reference-pipeline/test/fixtures/kafka-sources.v1.json`
(captured 2026-10-06, used by the Spec 012 tests).

## Upstream sources

The publisher reads these every hourly run, anonymously, sequentially, with
`User-Agent: oss-knowledge-base/1.0 (+https://github.com/unknowntpo/oss-knowledge-base)`
(`packages/reference-pipeline/src/kafka-connectors.ts`). One retry after a 5xx,
429 or network error when `Retry-After` ≤ 60 s; a response over 4 MiB fails the
source as `too-large`.

| Source key | Source instance | Endpoint | Window and cursor | Covered by |
| --- | --- | --- | --- | --- |
| `github` | `kafka:github`, `datafusion:github` | GitHub REST (token) | see Spec 004 | 004 G1–G12 |
| `mail` | `kafka:mail:dev` | `https://lists.apache.org/api/stats.lua?list=dev&domain=kafka.apache.org&d=lte=<N>d` (Pony Mail), 1 request | first run 30 d; then `ceil(gap in days) + 1`, at least 2, at most 30; cursor = newest message time, at most now. Drops subjects starting `[jira]`/`[PR]` after reply prefixes; skips messages dated > 1 h ahead | 012 K1–K3, K9–K13, K15, K20–K21 |
| `jira` | `kafka:jira` | `https://issues.apache.org/jira/rest/api/2/search?jql=project = KAFKA AND updated >= "-<N>m" ORDER BY updated ASC, key ASC&fields=summary,description,status,updated,created,reporter,comment&maxResults=100&startAt=…`, ≤ 2 pages (200 issues) per run | first run 43,200 min; then `ceil(gap in minutes) + 10`, at most 43,200; cursor = newest `updated` read (normalized to UTC `Z`) | 012 K4, K9–K10, K12, K14, K16–K17, K20, K22, K28 |

Record URLs: mail `https://lists.apache.org/thread/<mid>`; Jira issue
`https://issues.apache.org/jira/browse/<KEY>`, comment `…/browse/<KEY>?focusedCommentId=<id>`.

## Views

Hash routing (`apps/web/src/main.ts`): every URL is `/#/…`. No query
parameters: search text, filters and sort live in component state.

| View | Route | Component | Reach it | Covered by |
| --- | --- | --- | --- | --- |
| Home | `/#/` | redirect | open `/` → `/#/<last project>/` (`localStorage["community-kb-project"]`, try/catch), else `/#/kafka/` | 014 D62 |
| This week | `/#/<projectKey>/` (`kafka`, `datafusion`) | `apps/web/src/views/WeekView.vue` (`#view-week`, `#digest`) → `components/digest/DigestWeek.vue` | brand link, tab "This week", switcher | 014 D12, D17, D18, D23, D30, D44 |
| Proposals | `/#/<projectKey>/proposals` | `views/ProposalsView.vue` (`#view-proposals`, `.proposals-tab`) | tab "Proposals"; `kind: null` redirects to This week | 014 D36, D42 |
| Topic page | `/#/<projectKey>/topic/<topicKey>` | `views/TopicView.vue` → `components/digest/TopicPage.vue` (`#view-topic-page`) | click a `.topic-card-title a` | 014 D43, D53, D54 |
| Feed (All threads) | `/#/<projectKey>/threads` | `apps/web/src/views/FeedView.vue` (`#view-feed`), list filtered to the route project; a typed query searches all projects | tab "All threads" | 002 F10–F11, 003 R2/R5, 010 F1–F5, 011 V1–V6, 014 D62 |
| Search | `/#/<projectKey>/threads` with text in `#q` (or Enter in the top bar `#topbar-q`) | same view; cards become `SearchResultCard` | type into `#q` (180 ms debounce) | 005 S1–S15 |
| Feed detail | `/#/feed/:id` (the entry's `displayId`: `KAFKA-PR-<n>`, `KAFKA-ISSUE-<n>`, `KAFKA-<n>` for Jira, `KAFKA-MAIL-<8 hex>` for a dev@ thread, `DATAFUSION-…`) | `apps/web/src/views/FeedDetailView.vue` (`#view-topic`) | click a `.card` or a `.related-item` | 001 A1–A13, 002 F6–F8, 003 R3, 008 C4–C5, 011 V1/V5, 012 K6–K7 |
| Search detail | `/#/search/:detailRef` (`sdr1.…`) | same component, `detailRef` prop; `.topic-id` shows the Detail's `displayId` (falls back to the root title's prefix for older details) | click a `.search-card` | 005 S4, 008 C4/C6, 011 V1/V5, 012 K8 |

App shell (`apps/web/src/App.vue`) fetches `/api/feed` once and shares it via
`apps/web/src/store.ts`; the topbar is on every view.

## UI elements

No `data-testid` attributes; tests select by class, id, and role.

| Selector | Meaning and states | Covered by |
| --- | --- | --- |
| `.topbar` | Header row; must not scroll sideways (`scrollWidth <= clientWidth`) | 011 V1 |
| `.brand`, `.brand-mark`, `.brand-name`, `.brand-scope` | Home link "K"; scope hidden at ≤768 px, name hidden at ≤420 px | 011 V1 |
| `.demo-pill` | Freshness pill, text from `syncLabel` in `apps/web/src/App.vue`. Class: `is-stale` when `metadata.stale === true` or age > 3 h (`STALE_AFTER_MS` in `apps/web/src/freshness.ts`), else `is-live`. Text, first match wins: "Loading"/"載入中" while the feed loads; "Live error" after a failed load; in R2 serving mode (`metadata.servingMode === "cloudflare-pages-function-r2"`) the freshness text — "Updated just now / {n} min ago / {n} h ago", or "Data may be out of date · {n} h ago" past 3 h — or "Published snapshot"/"已發佈快照" when `generatedAt` is unparsable; in any other mode "Cached" (`metadata.stale`) or "GitHub live". `metadata.stale` alone changes the class, not the R2-mode text. At ≤420 px hidden unless `is-stale`, then wraps (`apps/web/styles.css`). Clock: browser `Date.now()`, re-read every 60 s | 010 F1–F6, 011 V1–V6 |
| `.locale-control` | Locale `<select>`: `zh-Hant` or `en`. Initial locale (`apps/web/i18n.js`; `apps/web/src/i18n.ts` only wraps it): `localStorage["community-kb-locale"]` if valid, else `navigator.language` (`zh*` → zh-Hant, anything else → en). `<html lang>` is `zh-Hant` in `index.html` and is updated only when the select changes, not on first load (gardening G1) | 010 F1, 011 V1 |
| `.topbar-stat` | Topic and record counts; hidden at ≤768 px | — |
| `#q` | Search input; examples and clear button beside it. Text here switches the Feed view to Search | 005 S11, S14 |
| `#filters`, `.filters-toggle` | Facet sidebar (`apps/web/src/views/FeedView.vue`). `.filter-row[aria-pressed]` groups: project (always), source (no query only), status (only with a project selected), time window (query only). Tags are `.tag-chip[aria-pressed]` (no query only) | 005 S6, S14 |
| `#sort` | hot / recent / relevance; the control renders only without a query, and without a query "relevance" orders like hot (`visibleEntries` uses an empty query; gardening G15) | 002 F10 |
| `.card` (`FeedCard.vue`) | Feed card linking to `/feed/<displayId>`; `.topic-id`, `.status-badge.status-<x>` (GitHub `open`/`merged`/`closed`; dev@ thread `discussing` "Discussing"/"討論中"; Jira `open` or `resolved` "Resolved"/"已解決"), `.card-project`, `.card-title`, `.trending-reason`, `.tag-pill`. Search results are also `.card` (`class="card search-card"`), so `.card` matches both | 002 F10–F11 |
| `.search-card` (`SearchResultCard.vue`) | Search result linking to `/search/<detailRef>`; `.search-match-badge`, `.evidence`, `.exact-match` | 005 S1–S5, S12 |
| `.topic-wrap` | Loaded detail: `h1#topic-title`, `.status-badge`, `.source-links`, `.ai-card` / `.key-points-state`, `.tl-filter`, `ol.timeline > li.tl-item` (`.tl-link`), `.rail` | 001 A1–A9, 002 F6–F8 |
| `.rail .related-list > a.related-item` | Detail "Related topics"/"相關主題", only when the Detail has `related[]`. Each links to `/feed/<displayId>`; `.rid` = "<displayId> · <source label> · <rule label>", `.rtitle` = the entry title. Rules: `key-in-title` "Title cites the issue key"/"標題引用議題編號" (a GitHub title or dev@ subject cites `KAFKA-<n>` ↔ that Jira entry); `same-kip` "Same KIP"/"同一個 KIP" (dev@ threads and Jira issues naming the same `KIP-<n>`). Source labels: `github` "GitHub", `mail` "Mailing list"/"郵件論壇", `jira` "Jira" | 012 K7 |
| `.community-switcher` | Top bar project `<select>`; lists projects in the published Feed; navigates to `/#/<key>/` | 014 D62 |
| `.top-tabs` `.top-tab.is-active`, `#topbar-q` | Tabs This week / Proposals (hidden for `proposal.kind: null`) / All threads; top bar search (not on All threads) hands its query to All threads | 014 D43, D62 |
| `#digest` `.digest-window-range` `.digest-freshness.is-live\|is-stale` | Window label (`formatRange`) and digest age; stale after 36 h | 014 D18, D30, D39 |
| `.digest-headline`, `.digest-stats`, `.digest-lag`, `.ai-label` | Headline with chips; stats from `digestCounts`; lagging sources; model label (both models on zh-Hant) | 014 D12, D21, D30, D39 |
| `.digest-highlight` | Up to 3 highlights, each with chips | 014 D37, D44, D55 |
| `.digest-kips .stage-column[data-stage] .kip-row[data-stage]`, `.stage-badge.stage-<key>`, `.vote-link`, `.stage-more` | Proposal columns in process order; badges for every stage; ≤ 6 rows per column on This week, then "+n more" | 014 D5, D36, D42 |
| `.topic-card[data-topic]`, `.keyword`, `a.cite` | Topic cards with generated sentences or "AI summary unavailable"; citation chips link to `#/feed/<id>` or, when the thread is not in the current Feed, its source URL | 014 D7, D18, D44 |
| `details.digest-routine` | Collapsed routine list | 014 D7, D12 |
| `#digest-uncategorized details.digest-uncategorized` | Collapsed Uncategorized list: threads whose topic is `other` (no `other` card); hidden when empty or absent | 014 D76, D77 |
| `.no-digest-notice`, `.digest-unavailable`, `.not-found`, `.digest-empty` | No digest (404 / `digest: false`), failed read (503), unknown project or topic, empty week | 014 D17, D23, D53 |
| `.thread-filter[data-filter][aria-pressed]`, `.thread-card`, `.thread-title` | Topic page filters All / PR / dev@ / JIRA with counts; thread cards link to the source URL, the id to Detail | 014 D43, D54 |
| Upstream text: `.card > *`, `.topic-id`, `#topic-title`, `.topic-lede`, `.topic-meta`, `.ai-item p`, `.tl-meta .author`, `.tl-kind`, `.tl-title`, `.tl-excerpt`, `.related-item`, `.tag-chip`, `.digest-headline`, `.highlight-title`, `.digest-sentence`, `.kip-title`, `.keyword`, `.thread-title`, `.thread-excerpt`, `.thread-meta` | Text written upstream (titles, excerpts, authors, tags, keywords) wraps inside its card even without a break opportunity (`overflow-wrap: anywhere`, one rule at the top of `apps/web/styles.css`); no view scrolls sideways at 375 px. Still clamped: `.search-card .card-summary` (3 lines), `.search-card .evidence-text` (4 lines). Still one line: `.status-badge`, `.source-badge`, `.stage-badge`, `.cite`, `.card-project`, `.tl-time` | 001 A13 |
| `.load-error` | App shell: feed load failure with a Retry button. Detail view: "Loading detail…" and detail errors, without Retry (gardening G5) | 003 R4 |

## Web API (Pages Functions, `apps/web/functions`)

All GET, R2 binding `OSS_KB_BUCKET`. Errors are `{error}`. `cache-control`
(Spec 003 R7, `jsonResponse` in `apps/web/functions/_shared/r2-projection.ts`):
every 4xx/5xx is `no-store`; every 200 is `public, max-age=30,
stale-while-revalidate=120`, including `/api/search-detail/:ref` (gardening
G37). A handler's own `cache-control` wins over these defaults; none passes
one for a 200 today.

| Endpoint | Returns | Data source | Covered by |
| --- | --- | --- | --- |
| `/api/feed` | Feed index: `generatedAt`, `projects[]`, `entries[]`, `metadata` with `servingMode`, `stale?`, `manifest {schema, releaseId, generatedAt, feedIndexKey, detailMapKey, entryCount}`; 503 on error | `public/v2/current.json` → `manifest.feedIndexKey` | 003 R1/R2/R4, 006 P1/P4, 010 F4/F6 |
| `/api/detail/:id` | `FeedDetail {displayId?, entry, records[], connections[], keyPoints, related?[]}` (`related[]`: `{displayId, title, source, rule, ruleRevision}`, Spec 012/ADR-0014; `records[].source` is `github`, `mail` or `jira`); 400 (no id), 404, 503 | detail map → `public/v2/objects/details/<sha256>.json` | 003 R3, 008 C1–C5 |
| `/api/digest?projectId=&locale=` | The current digest object for that locale without `features`/`translations`, plus `localeFallback`; 400 unknown project or locale (not `en`/`zh-Hant`), 404 project without a digest or no pointer yet, 503 otherwise (including a pointer outside the project prefix) | `public/digest/v1/<projectId>/current.json` → `objectKeys[locale]` (Spec 014) | 014 D12, D58 |
| `/api/search?q=` | `SearchResponseV1 {schema, query, results[] (entry, projectStatus?, matches, detailRef), facets.projects[], retrieval {indexRevision, lexicalRevision, generatedAt, stale}}`. `q` 1–500 chars; `limit` 1–50 (default 20); repeatable `projectId`, `sourceInstanceId`, `projectStatus`, `tag`; `occurredAfter`, `occurredBefore`. 400 for a client error, 503 otherwise | `public/search/v1/current.json` → `releases/<indexRevision>/manifest.json`. Release v3 (Spec 013): `terms.json` (term → document frequency and shard numbers) selects which `lexical/<projectId>/<n>.json` shards to read; v1/v2 read one shard per project. The manifest's `lexicalRevision` chooses the tokenizer: `bm25-reference@1`, or `bm25-reference@2` with the community search profiles (`packages/reference-pipeline/src/search/profiles.ts`), so `KIP770` equals `KIP-770` and a bare number lists every identifier; any other revision is HTTP 503 (Spec 016). Dev's publisher writes `@2` since the Spec 016 switch (H42); Prod writes `@1` | 005 S1–S15, 006 P10, 013 L1–L3, L8, 016 H25, H34, H37 |
| `/api/search-detail/:ref` | `FeedDetail`; 400 (missing or invalid ref), 404 (not found; for a v3 ref also a shard that is absent, out of range or of another project, or a group not in the shard), 503 (any other error, including a malformed `%` escape or a detail mismatch) | ref (`sdr1.…`, base64url JSON) carries `indexRevision`, project, group, `query`, `matchedRecordIds` and, for v3, its shard; v2/v3 details → `public/search/v1/objects/details/<hex>.json`, v1 details → `releases/<rev>/details/<name>.json` | 005 S4/S12, 008 C4/C6, 013 L4/L9 |

## Publisher API (`apps/data-publisher-worker/src/index.ts`)

| Endpoint | Auth | Returns | Covered by |
| --- | --- | --- | --- |
| `GET /health` | none | `environment`, `running`, `scheduled`, `phase` (null or `{phase, startedAt, materializedAt, counts}`), `lastRun` (null; success: `ok, environment, completedAt, publicationSetId, feedReleaseId, searchRevision, inputEventCount, logicalEventCount, pageCount, pollTruncated, copiedObjectCount, reusedObjectCount, search {lexicalRevision, chunkCount, shardCount, shardBytes, largestShardBytes, termsBytes}, sources`; failure: `ok:false, environment, completedAt, failureKind, error, retryAfterSeconds, sources`), `sources` (same as `lastRun.sources`, or null): per key `github`, `mail`, `jira` → `{ok, lastSuccessAt, cursor, durationMs, read, skipped, filtered, conflicts, published, gapCapped, failureKind?, error?}`. A run is `ok` when at least one source polled and publication succeeded (ADR-0014); a failed source keeps its checkpoint cursor and its previous `lastSuccessAt`; a publication failure records every source as failed (`failureKind: "pipeline"`) with both carried forward | 009 M6/M7, 010 F6, 011 V5, 013 L18, 012 K11, K23, K30, K32, 016 H38, H41 |
| `POST /run` | `Bearer MANUAL_TRIGGER_TOKEN` | 202 `{ok, scheduled}`, 409 `{ok:false, skipped:"already-running"}`, 401 without the token. Verifiers never call it | 009 M9 |
| `POST /digest/run[?dryRun=1]` | `Bearer MANUAL_TRIGGER_TOKEN` | Spec 014 digest (Durable Object `DigestRun`, binding `DIGEST_RUN`). 202 `{ok, scheduled}` (alarm), 409 `{ok:false, skipped:"already-running"}`, 401 without the token. `?dryRun=1` runs inline and returns the run result with `objects {en, "zh-Hant"}`; it writes nothing to R2 but its spend counts toward `today`. No cron starts it yet (`DIGEST_CRON` unset until a reviewed Dev dry run). On Dev (`DIGEST_ENABLED=true`, `DIGEST_MODEL=workers-ai`, `DIGEST_GATEWAY_ID=osskb-digest-dev`, `ai` binding) runs classify with Clef-flash and summarize and translate on Workers AI through the gateway; the dry-run result also carries `modelErrors`, `calibration` (with `clefCalls`, `clefCallsWithUsage`, `clefCanaryMisses`), `style {sentences, personLed, contentFree}`, `rejections`, and (dry runs only) up to 10 `rawSamples {call, reason, text ≤ 600 chars}` (D35, D66, D72, D78, D80, D81, D83). Both locale objects carry the same `coverage` (D79); a run makes at most 50 model requests (D71, D74). On Prod the digest is off: 403 `{ok:false, disabled:true}`. Verifiers do not call it on Prod | 014 D22, D59–D61 |
| `POST /review-queue/run[?dryRun=1]` | `Bearer MANUAL_TRIGGER_TOKEN` | Spec 015 review-queue job (`apps/data-publisher-worker/src/review-queue/`), run while the caller waits (no Durable Object, about 1–2 min). 200 or 502 with the run record (`last-run`); a dry run writes nothing. Verifiers use `?dryRun=1` only | 015 Q40, Q57, Q58 |

`/health` also carries `reviewQueue` (Spec 015 Q40): the review queue's `last-run.json` (`ok` (at least one source read and the object published; `failureKind: no-source` when none was read, and then nothing is published), `dryRun, startedAt, completedAt, durationMs, objectKey, pointerUpdated, sources {github, mail, roster} {ok, requests, bytes, durationMs, failureKind?}, droppedNodes, unavailable, counts, failureKind?`), or `null` before the first run. The review-queue cron is the variable `REVIEW_QUEUE_CRON`, unset on Dev and Prod until a Dev dry run (no cron trigger yet); R2 objects `public/review-queue/v1/<projectId>/{<sha256>.json, current.json, last-run.json}` and `internal/rosters/v1/asf/kafka.json`. `bun run measure:review-queue -- --warm [--scale N] [--memory-only]` measures requests, bytes, time and memory (Q34–Q36, Q38).

`/health` also carries `digest` (Spec 014 D31): `{enabled, running, scheduled, today {date, estimatedNeurons, cap}, lastRun}`, or `null` when the digest object does not answer; the publisher fields are unchanged.

There is no public `/status`: it exists only inside the Durable Object, and
`/health` proxies to it. Freshness reference: `lastRun.completedAt` equals
`/api/feed` `metadata.manifest.generatedAt` for the same release.

## Acceptance IDs by spec

| Spec | IDs | Surface |
| --- | --- | --- |
| [001](specs/001-kafka-decision-thread/acceptance.md) | A1–A13 | Domain, pipeline, detail page; A13 also covers upstream text on every view at phone width |
| [002](specs/002-generated-hot-feed/acceptance.md) | F1–F11 | Feed generation, cards, key points |
| [003](specs/003-r2-feed-projection/acceptance.md) | R1–R6 | `/api/feed`, `/api/detail` |
| [004](specs/004-replayable-github-feed/acceptance.md) | G1–G12 | GitHub publisher, pipeline |
| [005](specs/005-evidence-search/acceptance.md) | S1–S15 | `/api/search*`, `#q`, `.search-card`, facets |
| [006](specs/006-environment-isolated-r2-publication/acceptance.md) | P1–P15 | Environments, CI, R2 isolation |
| [007](specs/007-fluss-flink-compatibility-spike/acceptance.md) | C1–C7 | Spike only (`spikes/`) |
| [008](specs/008-content-addressed-details/spec.md) | C1–C7 | Detail pool, detail endpoints |
| [009](specs/009-bounded-memory-publication/spec.md) | M1–M9 | Publisher memory, `/health` phase, `/run` |
| [010](specs/010-feed-freshness/spec.md) | F1–F6 | `.demo-pill` text and class |
| [011](specs/011-stall-visibility/spec.md) | V1–V6 | `.demo-pill` at ≤420 px on Feed, Feed detail, Search detail |
| [012](specs/012-kafka-mailing-list-jira/spec.md) | K1–K32 | dev@ and Jira connectors (K1–K5, K9–K10, K12–K14, K20–K22, K28), Feed entries and statuses (K6, K16–K17), Detail `.related-item` (K7), Search hit display id (K8), per-source run and `/health` (K11, K15, K18–K19, K23, K30, K32), memory and payload (K24–K27, `measure:memory -- --kafka 1`), deployed checks (K29–K31) |
| [013](specs/013-search-streaming/spec.md) | L1–L18 | Search v3 shards and `terms.json`, `/api/search*`, publisher memory |
| [014](specs/014-topic-digest/spec.md) | D1–D62 (D41, D51, D52 withdrawn) | Slice 1: deterministic core (`packages/reference-pipeline/src/digest/`, `bun run digest -- eval\|measure`). Slice 2: `DigestRun` (`apps/data-publisher-worker/src/digest/`), `POST /digest/run`, `/health.digest`, R2 `public/digest/v1/`. Slice 3 (web) pending |
| [015](specs/015-review-queue/spec.md) | Q1–Q58 (Q39 removed) | Slice 1: deterministic core (`packages/reference-pipeline/src/review-queue/`: PR buckets, KIP candidates and threads, vote lines, `tallyVote`, governance profiles and ASF preset, ASF roster parsing, `reviewQueueCounts`). Slice 2: the job (`apps/data-publisher-worker/src/review-queue/`), `POST /review-queue/run`, `/health.reviewQueue`, R2 `public/review-queue/v1/`, `measure:review-queue`, `verify:health` review-queue line. Slice 3 (web) pending |
| [016](specs/016-semantic-search/spec.md) | H1–H42 (H21–H24, H27–H33 pending) | Slice 1, library only (`packages/search`): `bm25-reference@2` tokens and identifier profiles (H1–H4, H10, H15, H18), `SemanticRetriever`, `fuseRankings`, `hybridSearch` (H5–H7, H11–H14, H19), metrics, golden v2 and `bun run eval:search` (H8, H9, H16, H17, H20). Slice 2a: community search profiles (H26), `/api/search` reads `bm25-reference@1` and `@2` and fails closed on any other revision (H25, H34, H37), the publisher writes `@2` when `SEARCH_LEXICAL_REVISION=bm25-reference@2` (H35, H36, H38; set for Dev, unset for Prod, H39), `/health` `lastRun.search` (H41), `bun run measure:search-revisions` (H40). Switch (H42, `[deploy]`): `wrangler.development.jsonc` sets the variable, so Dev serves `bm25-reference@2` from the first publication after that deploy; the deployed E2E checks that the served revision equals `/health` `lastRun.search.lexicalRevision` and, at `@2`, that `KIP770` equals `KIP-770` |

## Verification kit

| Command | Does | Example |
| --- | --- | --- |
| `bun run verify:ui` | Opens views in Chromium with a viewport, locale and clock; writes `<view>.png` and `summary.json` (per selector: count, visible, class, text, box, `overflowX`; per view: URL, `<html lang>`, page horizontal overflow) | `bun run verify:ui -- --target dev --view feed,feed-detail,search-detail --width 375 --locale en --at +3h23m --out evidence/v5` |
| `bun run verify:health` | Prints `/health` `lastRun` and `/api/feed` generatedAt/releaseId, whether they agree, the age, and whether the UI would show stale; exits 1 when they disagree | `bun run verify:health -- --target dev` |
| `bun run digest -- eval\|measure` | Spec 014 offline digest replay on the committed Kafka fixture with recorded (hand-authored) responses: `eval` prints counts, cards, sentence drops by rule, error-class results and recall (pending labels); `measure` prints cold/steady neurons, model calls and R2 reads and exits 1 over the D25/D26 limits. No network | `bun run digest -- measure` |
| `bun run eval:search` | Spec 016 golden v2 evaluation, offline: Recall@20, MRR and nDCG@10 per query and aggregate for `bm25-reference@1`, `bm25-reference@2` and `@2` fused with a fake semantic retriever (plumbing only, not model quality); prints a table and rewrites `packages/search/test/fixtures/golden-evaluation.v2.json`, which `golden-v2.test.ts` compares with a fresh run | `bun run eval:search -- --out /tmp/report.json` |

| `bun run measure:search-revisions` | Spec 016 H40, offline: publishes the recorded Feed snapshot (or `--seed <r2-seed directory>`) at `bm25-reference@1` and `@2` with the search profiles and prints chunk count, distinct terms, `terms.json` bytes, shard bytes and their growth | `bun run measure:search-revisions` |

`verify:ui` options: `--target local|dev`, `--view feed|feed-detail|search|search-detail|week|proposals|topic` (Feed views open `/#/kafka/threads`; `week`, `proposals`, `topic` open the Spec 014 pages for `kafka`)
(comma list), `--route /feed/<id>` (open a hash route directly), `--query`
(default `KIP-405`), `--width` (375), `--height` (800), `--locale en|zh-Hant`,
`--at now|<ISO with zone>|±<offset from generatedAt>` (e.g. `+3h1s`, `-30s`),
`--frozen` (fixed clock instead of a running one), `--selector` (repeatable,
adds to the defaults), `--out` (default `test-results/verify/<time>`). Both
commands only issue GET requests. `--target local` needs the fixture server running (see
Environments). A smoke run is part of `bun run test:e2e`
(`apps/web/e2e/verify-kit.spec.ts`), which needs `bun run build` first.
