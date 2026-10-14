# Feature map

What a verifier can open, call, and select, and which acceptance IDs cover it.
Derived from the code on `main`; update it in the PR that changes behavior.
Commands: `bun run verify:ui`, `bun run verify:health` (see
[Verification kit](#verification-kit)).

This file is also published as a page, with `docs/gardening.md` and the specs'
status lines: https://unknowntpo.github.io/oss-knowledge-base/ (Spec 020).
`.github/workflows/feature-map-site.yml` rebuilds it on every push to `main`,
to `release/**` and of a `v*` tag, one page per ref (`/main/`, `/v0.2.0/`, …)
with a ref switcher; a pull request gets the same site as the workflow
artifact `feature-map-site-<sha>`. Nothing in it is edited by hand
([runbook](runbooks/feature-map-site.md)).

## Environments

| Environment | Web (Pages) | Publisher worker | R2 bucket |
| --- | --- | --- | --- |
| Local E2E | http://127.0.0.1:8788 (`bun run build && bun run e2e:prepare && bun run e2e:server`; `bun run test:e2e` starts the server itself but does not build, so run `bun run build` first) | none | `oss-knowledge-base-local` (`apps/web/.wrangler/e2e-state`) |
| Dev | https://oss-knowledge-base-dev.pages.dev | https://oss-knowledge-base-data-dev.unknowntpo.workers.dev (Cron `7 22 * * *`: once a day at 22:07 UTC = 06:07 Asia/Taipei, Spec 018; `POST /run` publishes on demand. Cron `47 22 * * *`: the digest, Spec 014 D86) | `oss-knowledge-base-dev` |
| Prod | https://oss-knowledge-base.pages.dev: Pages deployed by `v0.1.0` and `v0.2.0` (2026-08-26, 2026-08-31), serving the bootstrap snapshot generated 2026-08-25; no data is published to it (deploys on a `v*` tag) | `oss-knowledge-base-data-prod`: never deployed (its configuration is newer than the last tag); URL unknown (Cron `37 22 * * *`, once a day, from the next `v*` tag on) | `oss-knowledge-base-prod` |

### Deployed configuration

What each deployed configuration sets (`apps/data-publisher-worker/wrangler.{development,production}.jsonc`,
`apps/web/wrangler.{development,production}.jsonc`). `scripts/test/feature-map.test.ts`
fails when a variable or binding of those files is missing here.

| Name | Where | Dev | Prod | What it does |
| --- | --- | --- | --- | --- |
| `PUBLICATION_ENVIRONMENT` | Worker var | `development` | `production` | Names the environment in `/health` and picks the digest's daily cap |
| `SEARCH_LEXICAL_REVISION` | Worker var | `bm25-reference@3` (Spec 017 N17) | unset: `bm25-reference@1` | The lexical revision a Search release is written at |
| `SEARCH_EMBEDDING` | Worker var | `bge-m3@1` (Spec 016 H52, 2026-10-12) | unset: off | Embeds each release's chunks into Vectorize; also what turns the query gate on |
| `SEARCH_GATEWAY_ID` | Worker var | `osskb-search-dev` | unset | AI Gateway for every embedding call (the job's and the gate's) |
| `SEARCH_SHARD_ROOTS` | Worker var | `true` (Spec 016 slice 3 enable, 2026-10-13) | unset | Each manifest shard declares `firstGroupRootRecordId` |
| `DIGEST_ENABLED`, `DIGEST_MODEL`, `DIGEST_GATEWAY_ID` | Worker vars | `true`, `workers-ai`, `osskb-digest-dev` | unset: digest off | Spec 014 digest on Workers AI |
| `DIGEST_CRON` | Worker var | `47 22 * * *` (Spec 014 D86, 2026-10-14) | unset | The cron tick that starts the digest; the same expression is the second entry of `triggers.crons` |
| `REVIEW_QUEUE_CRON` | Worker var | unset | unset | No cron starts the review queue yet |
| `AI` | Worker binding | Workers AI | none | Digest models and `@cf/baai/bge-m3` |
| `SEARCH_VECTORS` | Worker binding | Vectorize index `osskb-search-dev` (1,024 dimensions, cosine) | none | One namespace per project |
<<<<<<< HEAD
| `OSS_KB_BUCKET` | Worker and Pages binding | `oss-knowledge-base-dev` | `oss-knowledge-base-prod` | R2. Billed by request class: A (`put`, `list`; $4.50 per million, 1 million included) and B (`get`, `head`; $0.36 per million, 10 million included). The hourly publication is the main scheduled writer (the daily Dev digest adds 2–4 Class A a run): about 40 Class A and 8,200 Class B a run on Dev (`/health` `lastRun.r2`); Pages only read. See the runbook, "R2 operations and cost" |
=======
| `OSS_KB_BUCKET` | Worker and Pages binding | `oss-knowledge-base-dev` | `oss-knowledge-base-prod` | R2. Billed by request class: A (`put`, `list`; $4.50 per million, 1 million included) and B (`get`, `head`; $0.36 per million, 10 million included). The daily publication (Spec 018) is the only scheduled writer: new objects + 3 Class A and all objects + 3 Class B a run; the first daily run on Dev (2026-10-13 22:07 UTC) sent 391 Class A (388 new objects + 3) and 8,343 Class B (`/health` `lastRun.r2`); Pages only read. See the runbook, "R2 operations and cost" |
>>>>>>> origin/main
| `PIPELINE_STATE`, `DIGEST_RUN` | Worker Durable Objects (`PipelineState`, `DigestRun`; migrations `v1`, `v2`) | bound | bound | Publisher run and digest run |
| `SEARCH_EMBEDDING_RUN` | Worker Durable Object (`SearchEmbeddingRun`; migration `v3`) | bound | none | Embedding job |
| `SEARCH_QUERY_GATE` | Worker Durable Object (`SearchQueryGate`; migration `v4`) | bound (2026-10-13); enabled because `SEARCH_EMBEDDING` is set | none | Query gate: ledger and caches for query-time embeddings. Bound on the Worker for `/health` only |
| `SEARCH_SEMANTIC` | Pages var | `rrf-group@2` (Spec 016 rollout step 7, 2026-10-13; `rrf-group@1` from enable step 3 until then). The value names the fusion revision; the code runs `rrf-group@1`, `rrf-group@2` (H77), and `rrf-group@3` (H87: implemented, enabled nowhere, not recommended yet, Spec 016 Decision 50), and reverting to `rrf-group@1` is this one value | unset: `/api/search` is lexical | Hybrid search in `/api/search` and its fusion revision |
| Pages binding `SEARCH_QUERY_GATE` | Pages Durable Object binding → class `SearchQueryGate` of the Worker `oss-knowledge-base-data-dev` (`script_name`) | bound (2026-10-13) | none | How the Pages Function reaches the query gate; there is no other route to it |
| `GITHUB_SOURCE_TOKEN`, `MANUAL_TRIGGER_TOKEN` | Worker secrets | set | set | GitHub reads; bearer token of the `POST` routes |

Dev today: one publication a day at 22:07 UTC (Spec 018); lexical `bm25-reference@3`; embeddings on, started by each publication and continued hourly while chunks are pending (Spec 016 Behavior 46);
releases carry shard roots; the query gate enabled; and, since the
2026-10-13 Pages enable, `/api/search` is hybrid: a text query is fused with
semantic candidates (`retrieval.semantic.status: ok`) or answered lexically
with the status that says why. Visitors' queries spend at the gate, inside
its caps. Prod has none of the Spec 016 or 017 flags.

### Dev access (Cloudflare Access)

**Dev is public today (checked 2026-10-13): no Cloudflare Access application
is in front of Dev Pages, and every `/api/*` route answers without a token.**
The tooling below stays so that Access can be turned on without code changes;
with `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` unset, as now, no
header is sent. The publisher worker on `workers.dev` and Prod are not behind
Access either. Because Dev is public, query-time cost is bounded by the query
gate, not by who may ask (Spec 016 Behavior 34).

If Access is turned on for Dev Pages (https://oss-knowledge-base-dev.pages.dev
and its preview subdomains `*.oss-knowledge-base-dev.pages.dev`):

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

## Schedules

What runs by itself. The full inventory, with costs and recommendations, is
in [Spec 018](specs/018-daily-publication/spec.md#everything-that-is-scheduled-2026-10-13).

| What | Cadence | Turned on by |
| --- | --- | --- |
| Publisher (`PipelineState` alarm) | Dev `7 22 * * *`, Prod `37 22 * * *` (UTC, once a day); `POST /run` on demand | `triggers.crons` of each Worker configuration |
| Publisher follow-ups | 5 min after a truncated run (≤ 5); 10, 30, 60 min after a failed run or source (≤ 3) | always (Spec 018) |
| Embedding job (`SearchEmbeddingRun` alarm) | after each successful publication; then hourly while work is left, 00:05 UTC after a day cap | `SEARCH_EMBEDDING` (Dev) |
| Digest (`DigestRun` alarm) | Dev `47 22 * * *` (22:47 UTC, 40 min after the publication); deferred 15 min at a time, at most 4 times, while the publisher runs or a follow-up waits (Spec 014 D59, D87); `POST /digest/run` on demand. Prod: none | a cron entry equal to `DIGEST_CRON` (Dev) |
| Review queue | none; `POST /review-queue/run` only | a cron entry equal to `REVIEW_QUEUE_CRON` (unset); its cadence is an open decision (Spec 018) |
| Confluence ingest (`.github/workflows/ingest.yml`) | none; manual only since 2026-10-14 (was daily 03:17 UTC) | GitHub Actions `workflow_dispatch`; not read by this site (legacy `viewer/` only) |
| Feature-map site (`.github/workflows/feature-map-site.yml`) | none; on each push to `main`, to `release/**`, of a `v*` tag, and by hand | GitHub Actions `push`; publishes to GitHub Pages, no Cloudflare resource (Spec 020) |

## Upstream sources

The publisher reads these every run (once a day, Spec 018), anonymously, sequentially, with
`User-Agent: oss-knowledge-base/1.0 (+https://github.com/unknowntpo/oss-knowledge-base)`
(`packages/reference-pipeline/src/kafka-connectors.ts`). One retry after a 5xx,
429 or network error when `Retry-After` ≤ 60 s; a response over 4 MiB fails the
source as `too-large`.

| Source key | Source instance | Endpoint | Window and cursor | Covered by |
| --- | --- | --- | --- | --- |
| `github` | `kafka:github`, `datafusion:github` | GitHub REST (token); ≤ 200 issues per repository per run (`MAX_ISSUES_PER_SOURCE`, kept after the 128 MB Durable Object memory incidents) | see Spec 004; a day is 66 and 96 issues (2026-10-13) | 004 G1–G12, 018 T10–T13 |
| `mail` | `kafka:mail:dev` | `https://lists.apache.org/api/stats.lua?list=dev&domain=kafka.apache.org&d=lte=<N>d` (Pony Mail), 1 request | first run 30 d; then `ceil(gap in days) + 1`, at least 2, at most 30; cursor = newest message time, at most now. Drops subjects starting `[jira]`/`[PR]` after reply prefixes; skips messages dated > 1 h ahead | 012 K1–K3, K9–K13, K15, K20–K21 |
| `jira` | `kafka:jira` | `https://issues.apache.org/jira/rest/api/2/search?jql=project = KAFKA AND updated >= "-<N>m" ORDER BY updated ASC, key ASC&fields=summary,description,status,updated,created,reporter,comment&maxResults=100&startAt=…`, ≤ 2 pages (200 issues) per run; a day is 48 issues (2026-10-13) | first run 43,200 min; then `ceil(gap in minutes) + 10`, at most 43,200; cursor = newest `updated` read (normalized to UTC `Z`) | 012 K4, K9–K10, K12, K14, K16–K17, K20, K22, K28 |

A run that reads a cap's worth and has more (`lastRun.pollTruncated`) is
followed by another 5 minutes later, at most 5 times; a failed run or source
is retried after 10, 30 and 60 minutes (Spec 018 T4–T12; `/health`
`followUp`). `bun run measure:daily-volume` prints a day's updates per source
against the caps.

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
| Search | `/#/<projectKey>/threads` with text in `#q` (or Enter in the top bar `#topbar-q`) | same view; cards become `SearchResultCard` | type into `#q` (180 ms debounce) | 005 S1–S18 |
| Feed detail | `/#/feed/:id` (the entry's `displayId`: `KAFKA-PR-<n>`, `KAFKA-ISSUE-<n>`, `KAFKA-<n>` for Jira, `KAFKA-MAIL-<8 hex>` for a dev@ thread, `DATAFUSION-…`) | `apps/web/src/views/FeedDetailView.vue` (`#view-topic`) | click a `.card` or a `.related-item` | 001 A1–A13, 002 F6–F8, 003 R3, 008 C4–C5, 011 V1/V5, 012 K6–K7 |
| Search detail | `/#/search/:detailRef` (`sdr1.…`) | same component, `detailRef` prop; `.topic-id` shows the Detail's `displayId` (falls back to the root title's prefix for older details); `.topic-meta` has no "Release" item (a search detail has no source label) | click a `.search-card` | 005 S4, S16, 008 C4/C6, 011 V1/V5, 012 K8 |

App shell (`apps/web/src/App.vue`) fetches `/api/feed` once and shares it via
`apps/web/src/store.ts`; the topbar is on every view.

## UI elements

No `data-testid` attributes; tests select by class, id, and role.

| Selector | Meaning and states | Covered by |
| --- | --- | --- |
| `.topbar` | Header row; must not scroll sideways (`scrollWidth <= clientWidth`) | 011 V1 |
| `.brand`, `.brand-mark`, `.brand-name`, `.brand-scope` | Home link "K"; scope hidden at ≤768 px, name hidden at ≤420 px | 011 V1 |
| `.demo-pill` | Freshness pill, text from `syncLabel` in `apps/web/src/App.vue`. Class: `is-stale` when `metadata.stale === true` or age > 27 h (`STALE_AFTER_MS` = `PUBLICATION_CADENCE_MS` 24 h + `STALE_GRACE_MS` 3 h in `apps/web/src/freshness.ts`; Spec 018 T2 holds the cadence to the Worker's crons), else `is-live`. Text, first match wins: "Loading"/"載入中" while the feed loads; "Live error" after a failed load; in R2 serving mode (`metadata.servingMode === "cloudflare-pages-function-r2"`) the freshness text — "Updated just now / {n} min ago / {n} h ago", or past 27 h "Data may be out of date · {n} h ago" ("· {n} d ago" from 48 h) — or "Published snapshot"/"已發佈快照" when `generatedAt` is unparsable; in any other mode "Cached" (`metadata.stale`) or "GitHub live". `metadata.stale` alone changes the class, not the R2-mode text. At ≤420 px hidden unless `is-stale`, then wraps (`apps/web/styles.css`). Clock: browser `Date.now()`, re-read every 60 s | 010 F1–F7, 011 V1–V6, 018 T2 |
| `.locale-control` | Locale `<select>`: `zh-Hant` or `en`. Initial locale (`apps/web/i18n.js`; `apps/web/src/i18n.ts` only wraps it): `localStorage["community-kb-locale"]` if valid, else `navigator.language` (`zh*` → zh-Hant, anything else → en). `<html lang>` is `zh-Hant` in `index.html` and is updated only when the select changes, not on first load (gardening G1) | 010 F1, 011 V1 |
| `.topbar-stat` | Topic and record counts; hidden at ≤768 px | — |
| `#q` | Search input; examples and clear button beside it. Text here switches the Feed view to Search | 005 S11, S14 |
| `#filters`, `.filters-toggle` | Facet sidebar (`apps/web/src/views/FeedView.vue`). `.filter-row[aria-pressed]` groups: project (always), source (no query only), status (only with a project selected), time window (query only). Tags are `.tag-chip[aria-pressed]` (no query only) | 005 S6, S14 |
| `#sort` | hot / recent / relevance; the control renders only without a query, and without a query "relevance" orders like hot (`visibleEntries` uses an empty query; gardening G15) | 002 F10 |
| `.card` (`FeedCard.vue`) | Feed card linking to `/feed/<displayId>`; `.topic-id`, `.status-badge.status-<x>` (GitHub `open`/`merged`/`closed`; dev@ thread `discussing` "Discussing"/"討論中"; Jira `open` or `resolved` "Resolved"/"已解決"), `.card-project`, `.card-title`, `.trending-reason`, `.tag-pill`. Search results are also `.card` (`class="card search-card"`), so `.card` matches both | 002 F10–F11 |
| `.search-card` (`SearchResultCard.vue`) | Search result linking to `/search/<detailRef>`; `.evidence`, `.exact-match` ("Exact match" / 「精確命中」 on a match with `signals.exactIdentifier`). No search-method badge: `.search-match-badge` and `.semantic-match-badge` were removed on 2026-10-13 (owner decision), and nothing in the UI reads `lexicalRank`, `semanticRank` or `retrieval.semantic` | 005 S1–S5, S12, S16, 016 H70 |
| `.results-divider` (`FeedView.vue`, an `h3` inside `.search-results`) | "Other related results" / 「其他相關結果」 before the first non-exact card, only when the list starts with exact matches and other results follow (`otherResultsStart`, `apps/web/src/search-results.ts`); the cards keep the API's order | 005 S17 |
| `.results-count` (`FeedView.vue`, `aria-live`) | With a query: the count line from `searchCount` / `searchCountText` (`apps/web/src/search-results.ts`): shown = `results.length`, exact = results with an exact match, total = the selected project's `facets.projects[].count` or the sum of all of them; e.g. "1 exact match · showing 20 of 152 matching threads" / 「1 個精確命中 · 顯示 152 個相符討論中的前 20 個」, "7 matching threads", "No matching threads"; empty while loading or failed. Without a query: "`N` entries" | 005 S18 |
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

All GET, R2 binding `OSS_KB_BUCKET` (`/api/search` also reads the `SEARCH_SEMANTIC` variable and the `SEARCH_QUERY_GATE` binding: set on Dev, absent on Prod and locally). Errors are `{error}`. `cache-control`
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
| `/api/search?q=` | `SearchResponseV1 {schema, query, results[] (entry, projectStatus?, matches, detailRef), facets.projects[], retrieval {indexRevision, lexicalRevision, generatedAt, stale}}`. `q` 1–500 chars; `limit` 1–50 (default 20); repeatable `projectId`, `sourceInstanceId`, `projectStatus`, `tag`; `occurredAfter`, `occurredBefore`. 400 for a client error, 503 otherwise | `public/search/v1/current.json` → `releases/<indexRevision>/manifest.json`. Release v3 (Spec 013): `terms.json` (term → document frequency and shard numbers) selects which `lexical/<projectId>/<n>.json` shards to read; v1/v2 read one shard per project. The manifest's `lexicalRevision` chooses the tokenizer and ranking: `bm25-reference@1`, or `bm25-reference@2` with the community search profiles (`packages/reference-pipeline/src/search/profiles.ts`), so `KIP770` equals `KIP-770` and a bare number lists every identifier, or `bm25-reference@3` (Spec 017: the `@2` index, a thread score bounded at 4/3 of its best chunk, and a bonus for adjacent query words); any other revision is HTTP 503 (Spec 016). Dev's publisher writes `@3` since the Spec 017 switch (N17; `@2` between Spec 016 H42 and then); Prod writes `@1`. Hybrid search (Spec 016 slice 3) is **on for Dev since 2026-10-13** and off for Prod and locally: with the Pages variable `SEARCH_SEMANTIC=rrf-group@1` and the Durable Object binding `SEARCH_QUERY_GATE`, the reader also asks the data Worker's `SearchQueryGate` for semantic matches, resolves them against the release's shards (the manifest's `shards[n].firstGroupRootRecordId`, written with `SEARCH_SHARD_ROOTS=true`), fuses with the revision the variable names (`rrf-group@2` on Dev since 2026-10-13: Spec 016 Behavior 38, the leading lexical threads that hold every query word keep their places, so a one-word query with a lexical hit is lexical-first; `rrf-group@1` is plain RRF), and adds `retrieval.fusionRevision`, `retrieval.semanticRevision` (status `ok` only), `retrieval.semantic {status: ok\|disabled\|skipped\|uncovered\|over-budget\|timed-out\|failed, reason?, candidates?, cached?}`, and per match `signals.semanticRank?` with `signals.semanticScore?` (the similarity of the thread's best passage, H78; `signals.lexicalRank` is absent on a thread only semantic retrieval found). Query parameter `semantic=off` returns the lexical ranking on such a deployment (status `disabled`) and is ignored elsewhere. An identifier query (`KIP770`, `770`, `a.b()`) and a query with fewer than two letters or digits are `skipped` and never reach the gate. Every status other than `ok` is the lexical response with HTTP 200. Without the flag the response is byte-identical to before | 005 S1–S15, 006 P10, 013 L1–L3, L8, 016 H25, H28, H29, H34, H37, H57–H61, H65, H66, 017 N5, N9, N11 |
| `/api/search-detail/:ref` | `FeedDetail`; 400 (missing or invalid ref), 404 (not found; for a v3 ref also a shard that is absent, out of range or of another project, or a group not in the shard), 503 (any other error, including a malformed `%` escape or a detail mismatch) | ref (`sdr1.…`, base64url JSON) carries `indexRevision`, project, group, `query`, `matchedRecordIds` and, for v3, its shard; v2/v3 details → `public/search/v1/objects/details/<hex>.json`, v1 details → `releases/<rev>/details/<name>.json` | 005 S4/S12, 008 C4/C6, 013 L4/L9 |

## Publisher API (`apps/data-publisher-worker/src/index.ts`)

| Endpoint | Auth | Returns | Covered by |
| --- | --- | --- | --- |
| `GET /health` | none | `environment`, `running`, `scheduled` (also `true` while a follow-up waits), `followUp` (Spec 018: `null`, or `{reason: catch-up\|retry, at, catchUps, retries}` for the run that is waiting), `phase` (null or `{phase, startedAt, materializedAt, counts}`), `lastRun` (null; success: `ok, environment, completedAt, publicationSetId, feedReleaseId, searchRevision, inputEventCount, logicalEventCount, pageCount, pollTruncated, copiedObjectCount, reusedObjectCount, r2 {classA, classB} (the R2 requests the run's publication sent, by billing class: Spec 008 C9; also on a failed run), search {lexicalRevision, chunkCount, shardCount, shardBytes, largestShardBytes, termsBytes, shardRoots?}, sources` (`shardRoots: true` only for a release whose manifest declares shard roots: Dev since 2026-10-13); failure: `ok:false, environment, completedAt, failureKind, error, retryAfterSeconds, sources`), `sources` (same as `lastRun.sources`, or null): per key `github`, `mail`, `jira` → `{ok, lastSuccessAt, cursor, durationMs, read, skipped, filtered, conflicts, published, gapCapped, failureKind?, error?}`. A run is `ok` when at least one source polled and publication succeeded (ADR-0014); a failed source keeps its checkpoint cursor and its previous `lastSuccessAt`; a publication failure records every source as failed (`failureKind: "pipeline"`) with both carried forward | 009 M6/M7, 010 F6, 011 V5, 013 L18, 012 K11, K23, K30, K32, 016 H38, H41, H57, H66, H69 |
| `POST /run` | `Bearer MANUAL_TRIGGER_TOKEN` | **Publishes on demand** (the Cron is once a day; [runbook](runbooks/cloudflare-data-publisher.md#publish-now-manual-run)). 202 `{ok, scheduled}` (also while a follow-up waits: it is replaced), 409 `{ok:false, skipped:"already-running"}` while a run is active or its alarm is due, 401 without the token. Verifiers never call it | 009 M9, 018 T9 |
| `POST /digest/run[?dryRun=1]` | `Bearer MANUAL_TRIGGER_TOKEN` | Spec 014 digest (Durable Object `DigestRun`, binding `DIGEST_RUN`). 202 `{ok, scheduled}` (alarm), 409 `{ok:false, skipped:"already-running"}`, 401 without the token. `?dryRun=1` runs inline and returns the run result with `objects {en, "zh-Hant"}`; it writes nothing to R2 but its spend counts toward `today`. On Dev the cron `47 22 * * *` starts it once a day (D86; [runbook](runbooks/cloudflare-data-publisher.md#topic-digest-spec-014)); keep two runs 60 minutes apart (the gateway allows 60 requests an hour, and a refusal ends the run `limited`, D88). On Dev (`DIGEST_ENABLED=true`, `DIGEST_MODEL=workers-ai`, `DIGEST_GATEWAY_ID=osskb-digest-dev`, `ai` binding) runs classify with Clef-flash and summarize and translate on Workers AI through the gateway; the dry-run result also carries `modelErrors`, `calibration` (with `clefCalls`, `clefCallsWithUsage`, `clefCanaryMisses`), `style {sentences, personLed, contentFree}`, `rejections`, and (dry runs only) up to 10 `rawSamples {call, reason, text ≤ 600 chars}` (D35, D66, D72, D78, D80, D81, D83). Both locale objects carry the same `coverage` (D79); a run makes at most 50 model requests (D71, D74). On Prod the digest is off: 403 `{ok:false, disabled:true}`. Verifiers do not call it on Prod | 014 D22, D59–D61 |
| `POST /search-embedding/run[?dryRun=1[&profile=bge-m3@1]][?reset=1]` | `Bearer MANUAL_TRIGGER_TOKEN` | Spec 016 embedding job (Durable Object `SearchEmbeddingRun`). 202 `{ok, scheduled}` (a waiting continuation is replaced), 409 while a run is active or its alarm is due, 403 `{ok:false, disabled:true}` where the object is not bound (Prod) or the flag is off, 401 without the token. `?dryRun=1` returns the estimate (chunks, calls, tokens, neurons, dollars, runs) and calls no model or index (`&profile=` only while the flag is off); `?reset=1` forgets the vector state so the next run embeds every chunk again; both together are 400. A real run that leaves work sets its own alarm (an hour later; 00:05 UTC after a day cap). Verifiers use `?dryRun=1` only | 016 H51, H92, H93 |
| `POST /review-queue/run[?dryRun=1]` | `Bearer MANUAL_TRIGGER_TOKEN` | Spec 015 review-queue job (`apps/data-publisher-worker/src/review-queue/`), run while the caller waits (no Durable Object, about 1–2 min). 200 or 502 with the run record (`last-run`); a dry run writes nothing. Verifiers use `?dryRun=1` only | 015 Q40, Q57, Q58 |

`/health` also carries `reviewQueue` (Spec 015 Q40): the review queue's `last-run.json` (`ok` (at least one source read and the object published; `failureKind: no-source` when none was read, and then nothing is published), `dryRun, startedAt, completedAt, durationMs, objectKey, pointerUpdated, sources {github, mail, roster} {ok, requests, bytes, durationMs, failureKind?}, droppedNodes, unavailable, counts, failureKind?`), or `null` before the first run. The review-queue cron is the variable `REVIEW_QUEUE_CRON`, unset on Dev and Prod until a Dev dry run (no cron trigger yet); R2 objects `public/review-queue/v1/<projectId>/{<sha256>.json, current.json, last-run.json}` and `internal/rosters/v1/asf/kafka.json`. `bun run measure:review-queue -- --warm [--scale N] [--memory-only]` measures requests, bytes, time and memory (Q34–Q36, Q38).

`/health` also carries `digest` (Spec 014 D31): `{enabled, running, scheduled, today {date, estimatedNeurons, cap}, lastRun}` (neurons are calibrated, price table × 1.28, and the cap is 5,000 a UTC day: D90, D91; the ledger is stored before each model request, so while a run is active it includes requests in flight: D93), or `null` when the digest object does not answer; the publisher fields are unchanged.

`/health` also carries `searchEmbedding` (Spec 016 H51): `{enabled, configError?, model, revision, semanticRevision, running, scheduled, interrupted, today {date, estimatedNeurons, cap, calls, callCap}, lastMutation {id, acceptedAt}, lastError {kind, message, at, batchSize} (kept until a later run embeds), lastRun}`, `null` when the embedding object does not answer, and `enabled: false` where it is not bound (Prod). `lastRun`: `ok, failureKind? (config, release-read, model, model-limit, vector-store, internal), error?, dryRun, completedAt, durationMs, releaseId, model, revision, semanticRevision, chunks, embedded, pending, embeddedThisRun, deletedThisRun, deletePending, heldDeletes, absentProjects[], quarantined, quarantinedIds[], retryCalls, retriesDeferred, storedVectors, storedDimensions, modelCalls, estimatedInputTokens, estimatedNeurons, spentToday, limited (chunks-per-run, calls-per-run, calls-per-day, daily-neurons, deadline, model-limit, model-down, vector-store, or null), modelErrors[], index {vectorCount, mutationsProcessed}, lastMutationId, estimate {chunks, calls, inputTokens, neurons, usd, runs, days}`. The object is `SearchEmbeddingRun` (`apps/data-publisher-worker/src/search-embedding/`); it embeds the current Search release's chunks with `@cf/baai/bge-m3` through the AI Gateway `SEARCH_GATEWAY_ID` into the Vectorize index bound as `SEARCH_VECTORS` (Dev: `osskb-search-dev`, one namespace per project), only when `SEARCH_EMBEDDING` is set (Dev: `bge-m3@1` since Spec 016 H52, 2026-10-12; unset on Prod). The deployed E2E asserts `searchEmbedding.enabled === true` with no `configError` on Dev. `estimatedNeurons` and the daily `cap` (2,500) are the token estimate times 1.8 since Spec 016 slice 3 (H67). The route `POST /search-embedding/run` is in the table above. The vectors are read only by the query gate (next paragraph), and no visitor reaches it until the Pages binding exists.

`/health` also carries `searchQuery` (Spec 016 H69): the query gate's `{enabled, configError?, semanticRevision, today {date, neurons, modelCalls, indexQueries, hour, hourModelCalls, neuronCap, indexQueryCap, hourModelCallCap}, pausedUntil, lastError {kind, message, at}, sinceStart {requests, cached, embedded, overBudget, failed}}`, `null` when the object does not answer, and `enabled: false` with the caps where it is not bound (Prod, local). On Dev it is bound and `enabled: true` since the 2026-10-13 enable (caps: 1,000 neurons and 1,000 index queries a UTC day, 100 model calls an hour); since the Pages enable of the same day its counts grow with visitors' uncached queries. The object is `SearchQueryGate` (`packages/semantic-vectorize/src/query-gate.ts`, wired in `apps/data-publisher-worker/src/search-query/gate.ts`); inside it answers `POST /query` and `GET /status`, and the Worker has no public route to either (H69). The deployed E2E (`H32`) asserts `searchQuery.enabled === true` with no `configError` on Dev, that `KIP770` is `skipped`, that `semantic=off` is `disabled`, and that the fixed query `交易逾時` carries a legitimate status (`ok`, `timed-out`, `over-budget`, `failed`, `uncovered`; it is asked up to four times for `ok`, and fails only when the field is missing, the status is another one, the gate lost its configuration, or every attempt is `failed`). It costs the gate at most 1 neuron and 2 index queries a run, and nothing while its hour-old matches are cached.

There is no public `/status`: it exists only inside the Durable Object, and
`/health` proxies to it. Freshness reference: `lastRun.completedAt` equals
`/api/feed` `metadata.manifest.generatedAt` for the same release.

## Acceptance IDs by spec

| Spec | IDs | Surface |
| --- | --- | --- |
| [001](specs/001-kafka-decision-thread/acceptance.md) | A1–A13 | Domain, pipeline, detail page; A13 also covers upstream text on every view at phone width |
| [002](specs/002-generated-hot-feed/acceptance.md) | F1–F11 | Feed generation, cards, key points |
| [003](specs/003-r2-feed-projection/acceptance.md) | R1–R7 | `/api/feed`, `/api/detail`; `cache-control` of every Pages response (R7) |
| [004](specs/004-replayable-github-feed/acceptance.md) | G1–G12 | GitHub publisher, pipeline |
| [005](specs/005-evidence-search/acceptance.md) | S1–S18 | `/api/search*`, `#q`, `.search-card`, `.results-divider`, `.results-count`, facets |
| [006](specs/006-environment-isolated-r2-publication/acceptance.md) | P1–P15 | Environments, CI, R2 isolation |
| [007](specs/007-fluss-flink-compatibility-spike/acceptance.md) | C1–C7 | Spike only (`spikes/`) |
| [008](specs/008-content-addressed-details/spec.md) | C1–C10 | Detail pool, detail endpoints; R2 operations of a publication: an existing object costs one `head` (Class B) and no put (C8), `/health` `lastRun.r2` (C9) |
| [009](specs/009-bounded-memory-publication/spec.md) | M1–M10 | Publisher memory, `/health` phase, `/run`; a retried run publishes under its own release id (M10) |
| [010](specs/010-feed-freshness/spec.md) | F1–F7 | `.demo-pill` text and class; stale after 27 h, days from 48 h (F7) |
| [011](specs/011-stall-visibility/spec.md) | V1–V6 | `.demo-pill` at ≤420 px on Feed, Feed detail, Search detail |
| [012](specs/012-kafka-mailing-list-jira/spec.md) | K1–K32 | dev@ and Jira connectors (K1–K5, K9–K10, K12–K14, K20–K22, K28), Feed entries and statuses (K6, K16–K17), Detail `.related-item` (K7), Search hit display id (K8), per-source run and `/health` (K11, K15, K18–K19, K23, K30, K32), memory and payload (K24–K27, `measure:memory -- --kafka 1`), deployed checks (K29–K31) |
| [013](specs/013-search-streaming/spec.md) | L1–L18 | Search v3 shards and `terms.json`, `/api/search*`, publisher memory |
| [014](specs/014-topic-digest/spec.md) | D1–D94 (D41, D51, D52 withdrawn) | Slice 2e (D86–D94): the Dev cron, the calibrated ledger and cap, the gateway rate limit, the ledger stored before each request. Slice 1: deterministic core (`packages/reference-pipeline/src/digest/`, `bun run digest -- eval\|measure`). Slice 2: `DigestRun` (`apps/data-publisher-worker/src/digest/`), `POST /digest/run`, `/health.digest`, R2 `public/digest/v1/`. Slice 3 (web): `/api/digest`, This week, Proposals and Topic pages (see Views and UI elements) |
| [015](specs/015-review-queue/spec.md) | Q1–Q58 (Q39 removed) | Slice 1: deterministic core (`packages/reference-pipeline/src/review-queue/`: PR buckets, KIP candidates and threads, vote lines, `tallyVote`, governance profiles and ASF preset, ASF roster parsing, `reviewQueueCounts`). Slice 2: the job (`apps/data-publisher-worker/src/review-queue/`), `POST /review-queue/run`, `/health.reviewQueue`, R2 `public/review-queue/v1/`, `measure:review-queue`, `verify:health` review-queue line. Slice 3 (web) pending |
| [016](specs/016-semantic-search/spec.md) | H1–H93 (H92, H93: the embedding job continues on its own alarm while work is left; H33 pending; H31, H32, H42, H52, H79 deploy; H27, H40, H68, H82, H91 measure). Fusion `rrf-group@3` (2026-10-13: implemented, enabled nowhere, not recommended yet; Dev stays on `rrf-group@2` and fusion tuning stops, Decision 50): `rrf-group@2`, and a thread precedes one of the first three lexical threads only if lexical search ranks it above or its similarity stands 0.04 above the query's 20th semantic thread (`fuseRankings`, H85, H89); selected by `SEARCH_SEMANTIC=rrf-group@3` (H87); the scored capture and the separation report (H88, H90); the verifier's 20 queries and ten clean ones (H83, H84); the replay acceptance (H86). Fusion `rrf-group@2` (2026-10-13, Dev switched to it the same day, H79): the leading lexical threads that hold every query word keep their places (`fuseRankings`, `lexicalQueryWords`; H73, H80), `rrf-group@1` pinned (H74), the revision selected by `SEARCH_SEMANTIC` (H77), `signals.semanticScore` (H78), the replay fixtures `apps/web/test/fixtures/hybrid-replay*.2026-10-13.json` and the ablation `hybrid-fusion-ablation.txt` (H72, H75, H81), 14 new queries (H76). Enabled on Dev (2026-10-13): the publisher sets `SEARCH_SHARD_ROOTS` and binds `SearchQueryGate`, and Pages sets `SEARCH_SEMANTIC=rrf-group@1` and binds the gate (H66; the deployed E2E checks `/health` `searchQuery` and the hybrid response, H32). H31 and slice 4 (H33) are measured with `bun run measure:search-hybrid`. Slice 3: shard roots (H57), query gate `SearchQueryGate` (H30, H62–H64, H69), hybrid search in `/api/search` (H28, H29, H58–H61, H65, H66), the badge (H70), calibrated neurons (H67), slice 4's queries and command (H71) | Slice 1, library only (`packages/search`): `bm25-reference@2` tokens and identifier profiles (H1–H4, H10, H15, H18), `SemanticRetriever`, `fuseRankings`, `hybridSearch` (H5–H7, H11–H14, H19), metrics, golden v2 and `bun run eval:search` (H8, H9, H16, H17, H20). Slice 2a: community search profiles (H26), `/api/search` reads `bm25-reference@1` and `@2` and fails closed on any other revision (H25, H34, H37), the publisher writes `@2` when `SEARCH_LEXICAL_REVISION=bm25-reference@2` (H35, H36, H38; set for Dev, unset for Prod, H39), `/health` `lastRun.search` (H41), `bun run measure:search-revisions` (H40). Switch (H42, `[deploy]`): `wrangler.development.jsonc` sets the variable, so Dev serves `bm25-reference@2` from the first publication after that deploy; the deployed E2E checks that the served revision equals `/health` `lastRun.search.lexicalRevision` and, at `@2`, that `KIP770` equals `KIP-770`. Slice 2b: embedding publication (`apps/data-publisher-worker/src/search-embedding/`, H21–H23, H45–H49, H53–H56), `VectorizeSemanticRetriever` and the release consistency rule (`packages/semantic-vectorize`, H24, H43, H44, H50), `/health` `searchEmbedding` and `POST /search-embedding/run` (H51), `bun run measure:search-embedding` (H27); `SEARCH_EMBEDDING` is `bge-m3@1` on Dev and unset on Prod (H45); enabling it on Dev is H52 (`[deploy]`): the deployed E2E checks `/health` `searchEmbedding.enabled` with no `configError`, and the first runs are observed by hand |
| [017](specs/017-lexical-ranking/spec.md) | N1–N19 (N15, N16 measure; N17 deploy) | `bm25-reference@3` in `packages/search`: geometric thread score (N1), phrase bonus (N2), the real-corpus snapshot and its 21 queries (N3, N13), the `@2` stored format (N4), `/api/search` reads `@3` and fails closed on any other revision (N5, N9, N11), the publisher writes `@3` when `SEARCH_LEXICAL_REVISION=bm25-reference@3` (N6, N10), `@1` and `@2` unchanged (N7, N8, N12, N14), guard rows against over-correction with their known limitations (N18), the ablation table from the committed snapshot (N19). Switch (N17, `[deploy]`): `wrangler.development.jsonc` sets the variable, so Dev serves `@3` from the first publication after that deploy; the deployed E2E checks that the served revision equals `/health` `lastRun.search.lexicalRevision` and records the first threads of `request manager` |
| [018](specs/018-daily-publication/spec.md) | T1–T16 (T13 measure; T14–T16 deploy) | The publisher's crons (T1–T3), the follow-up runs after a truncated or failed publication and `/health` `followUp` (T4–T9), a day's and a backlog's batch against the per-run caps (T10–T13), and the inventory of everything scheduled |
| [020](specs/020-feature-map-site/spec.md) | B1–B18 (B15 measure; B16–B18 deploy) | The feature-map site (`scripts/feature-map-site/`, `bun run docs:feature-map-site`): data and page per ref (B1–B3, B7), slugs, `versions.json` and the root page (B4, B5, B12), the ref switcher (B6, B11), refs without a feature map or that cannot be built (B8–B10), the workflow `.github/workflows/feature-map-site.yml` and its Pages gate (B13, B14) |

## Verification kit

| Command | Does | Example |
| --- | --- | --- |
| `bun run verify:ui` | Opens views in Chromium with a viewport, locale and clock; writes `<view>.png` and `summary.json` (per selector: count, visible, class, text, box, `overflowX`; per view: URL, `<html lang>`, page horizontal overflow) | `bun run verify:ui -- --target dev --view feed,feed-detail,search-detail --width 375 --locale en --at +3h23m --out evidence/v5` |
| `bun run verify:health` | Prints `/health` `lastRun` and `/api/feed` generatedAt/releaseId, whether they agree, the age, and whether the UI would show stale; exits 1 when they disagree | `bun run verify:health -- --target dev` |
| `bun run digest -- eval\|measure` | Spec 014 offline digest replay on the committed Kafka fixture with recorded (hand-authored) responses: `eval` prints counts, cards, sentence drops by rule, error-class results and recall (pending labels); `measure` prints cold/steady neurons, model calls and R2 reads and exits 1 over the D25/D26 limits. No network | `bun run digest -- measure` |
| `bun run eval:search` | Spec 016 golden v2 evaluation, offline: Recall@20, MRR and nDCG@10 per query and aggregate for `bm25-reference@1`, `bm25-reference@2` and `@2` fused with a fake semantic retriever (plumbing only, not model quality); prints a table and rewrites `packages/search/test/fixtures/golden-evaluation.v2.json`, which `golden-v2.test.ts` compares with a fresh run | `bun run eval:search -- --out /tmp/report.json` |
| `bun run eval:search` (second report) | Spec 017 real-corpus evaluation, offline: the same metrics for `bm25-reference@2` and `@3` over `real-corpus-snapshot.v1.json` (1,134 chunks of the Dev release of 2026-10-12, scored with that release's statistics); rewrites `packages/search/test/fixtures/real-corpus-evaluation.v1.json`, which `real-corpus.test.ts` compares with a fresh run | `bun run eval:search -- --real-corpus-out /tmp/real.json` |
| `bun run --cwd packages/search real-corpus` | Spec 017 N15, N16, N18, N19, offline over the committed snapshot: prints each case and guard query's ranks at `@2` and `@3`; `--ablation` measures each ranking change alone plus an evaluation-only coverage variant (output committed as `real-corpus-ablation.txt`), `--latency` times ranking per query. With `--release <dir>` (one `search-release.v3` on disk, from an export the owner authorised; do not read the bucket directly) the same on the whole release, and `--check` proves the snapshot ranks like the release, `--write` rewrites it | `bun run --cwd packages/search real-corpus -- --ablation` |

| `bun run --cwd apps/data-publisher-worker measure:search-latency` | Spec 013 L15, L17, offline: p50 and p95 of the Pages reader per seeded query over an in-memory bucket, R2 reads and bytes per query | `bun run --cwd apps/data-publisher-worker measure:search-latency` |
| `bun run test:e2e:development` | The deployed E2E (`apps/web/deployed-e2e/development.spec.ts`), run by CI after each Dev deploy: Feed, detail and search on Dev, `/health` against `/api/feed`, the served lexical revision (016 H42, 017 N17), `searchEmbedding.enabled` (H52), `searchQuery.enabled` and the hybrid response of `/api/search` (H32) | `DEV_BASE_URL=… DEV_WORKER_URL=… bun run test:e2e:development` |
| `bun run check:traceability`, `bun run check:test-plan`, `bun run docs:test-plan` | Gates: every acceptance ID of an enforced spec has a test; every spec's test-plan table equals its case file (`docs:test-plan` rewrites them) | `bun run check:traceability && bun run check:test-plan` |
| `bun run measure:search-revisions` | Spec 016 H40 and Spec 017 N15, offline: publishes the recorded Feed snapshot (or `--seed <r2-seed directory>`) at every supported lexical revision with the search profiles and prints chunk count, distinct terms, `terms.json` bytes, shard bytes and the growth of each revision over the one before (`@3` over `@2`: none) | `bun run measure:search-revisions` |
| `bun run measure:search-hybrid` | Spec 016 H31, H33, H71: asks a deployed `/api/search` (default Dev, public GETs, one a second) the 21 Spec 017 queries, its 6 guard queries, and 8 Chinese and 8 vocabulary-gap queries, and 5 unlabelled abbreviation probes (`RM`, `ISR`, `HW`, `EOS`, `LSO`), each with `semantic=off` and hybrid; prints the expected threads' ranks, `retrieval.semantic.status`, latencies, the timed-out share of uncached queries, regressions, the rerank rule, and each probe's first threads. One run costs the query gate at most 48 model calls and 96 index queries (none of the first on a repeat within 7 days). Against a deployment without hybrid search it prints the lexical ranks alone | `bun run measure:search-hybrid -- --out report.json` |
| `bun run capture:search-replay` | Spec 016 H72, H81: asks a deployed `/api/search` (default Dev, public GETs, one a second) each labelled query with `semantic=off` and hybrid, limit 50, and writes a replay fixture (`--out`): per thread its lexical rank, semantic rank, live fused rank, matched-term masks, and similarity when served; no title or excerpt. `--queries <json>` replaces the list, `--raw <dir>` keeps the responses, `--from-raw <dir>` rebuilds offline. At most one model call and two index queries a query, none while cached |
| `bun run eval:search-fusion` | Spec 016 H75, H76, H82, offline: replays `rrf-group@1`, `rrf-group@2`, and the weighed alternatives over the committed capture and prints the ablation by set (tuning, held-out, new); `--write` rewrites `apps/web/test/fixtures/hybrid-fusion-ablation.txt` (compared in CI), `--rows` prints each row's ranks, `--time` the CPU time of one fusion per revision |
| `bun run eval:search-similarity` | Spec 016 H86, H88, offline: over the scored capture (`apps/web/test/fixtures/hybrid-replay.scored.2026-10-13.json`, `hybrid-replay.clean-3.2026-10-13.json`) and the hand labels, prints how the similarity separates relevant from irrelevant semantic candidates (floor, distance to the best, margin over the 20th; by query type; Chinese against other queries) and the ablation of score-aware fusion alternatives by set (tuning, held-out, new, verifier, clean-3); `--write` rewrites `apps/web/test/fixtures/hybrid-similarity-report.txt` (compared in CI), `--rows` prints each row's ranks at lexical-only, `rrf-group@1`, `@2`, `@3` |
| `bun run measure:search-query-budget` | Spec 016 H68, offline: the query gate's caps, the neurons charged per query against the calibrated estimate and the upper bound, the three daily neuron caps at their calibrated cost (digest × 1.28) against the included 10,000, and Vectorize's stored and queried dimensions for `--chunks` (default 8,780) | `bun run measure:search-query-budget -- --chunks 12000` |
| `bun run docs:feature-map-site` | Spec 020: builds the feature-map site from git, every ref (`main`, `release/*`, `v*`) into `<out>/<slug>/index.html` and `data.json`, plus `versions.json` and the root page; prints each page's status and bytes and the total time. `--preview <name>` adds the working tree as a branch; `--tree <dir> --ref … --kind … --sha … --date …` builds one ref from a directory. Reads only `docs/feature-map.md`, `docs/gardening.md` and `docs/specs/*/spec.md`; no network | `bun run docs:feature-map-site -- --out /tmp/fm-site --preview my-branch` |
| `bun run measure:daily-volume` | Spec 018 T13: issues each source updated in the last 24 h (`-- --hours N`) against the publisher's per-run caps; three public GETs (GitHub search, ASF Jira) | `bun run measure:daily-volume -- --hours 168` |
| `bun run measure:search-embedding` | Spec 016 H27, offline: publishes the recorded Feed snapshot (or `--fixture <file>`), runs the real embedding run dry and then to completion with a fake model and an in-memory index, and prints estimated tokens per chunk, model calls, neurons, dollars, stored dimensions and runs under the default bounds, scaled to `--chunks` (default 8,586) | `bun run measure:search-embedding -- --chunks 30000` |

`verify:ui` options: `--target local|dev`, `--view feed|feed-detail|search|search-detail|week|proposals|topic` (Feed views open `/#/kafka/threads`; `week`, `proposals`, `topic` open the Spec 014 pages for `kafka`)
(comma list), `--route /feed/<id>` (open a hash route directly), `--query`
(default `KIP-405`), `--width` (375), `--height` (800), `--locale en|zh-Hant`,
`--at now|<ISO with zone>|±<offset from generatedAt>` (e.g. `+27h1s`, `-30s`),
`--frozen` (fixed clock instead of a running one), `--selector` (repeatable,
adds to the defaults), `--out` (default `test-results/verify/<time>`). Both
commands only issue GET requests. `--target local` needs the fixture server running (see
Environments). A smoke run is part of `bun run test:e2e`
(`apps/web/e2e/verify-kit.spec.ts`), which needs `bun run build` first.
