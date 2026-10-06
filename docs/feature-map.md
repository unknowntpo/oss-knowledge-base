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

Local fixture: `packages/reference-pipeline/test/fixtures/github-feed-projection.v1.json`,
3 Feed cards (Kafka, DataFusion), `generatedAt` `2026-08-25T12:00:00Z`; search
fixture from `packages/search/test/fixtures/golden-queries.v1.json` (`KIP-405`
returns results). Config: `apps/web/wrangler*.jsonc`, `playwright*.config.ts`.

## Views

Hash routing (`apps/web/src/main.ts`): every URL is `/#/…`. No query
parameters: search text, filters and sort live in component state.

| View | Route | Component | Reach it | Covered by |
| --- | --- | --- | --- | --- |
| Feed | `/#/` | `apps/web/src/views/FeedView.vue` (`#view-feed`) | open `/` | 002 F10–F11, 003 R2/R5, 010 F1–F5, 011 V1–V6 |
| Search | `/#/` with text in `#q` | same view; cards become `SearchResultCard` | type into `#q` (180 ms debounce) | 005 S1–S15 |
| Feed detail | `/#/feed/:id` (the entry's `displayId`) | `apps/web/src/views/FeedDetailView.vue` (`#view-topic`) | click a `.card` | 001 A1–A12, 002 F6–F8, 003 R3, 008 C4–C5, 011 V1/V5 |
| Search detail | `/#/search/:detailRef` (`sdr1.…`) | same component, `detailRef` prop | click a `.search-card` | 005 S4, 008 C4/C6, 011 V1/V5 |

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
| `.card` (`FeedCard.vue`) | Feed card linking to `/feed/<displayId>`; `.topic-id`, `.status-badge.status-<x>`, `.card-project`, `.card-title`, `.trending-reason`, `.tag-pill`. Search results are also `.card` (`class="card search-card"`), so `.card` matches both | 002 F10–F11 |
| `.search-card` (`SearchResultCard.vue`) | Search result linking to `/search/<detailRef>`; `.search-match-badge`, `.evidence`, `.exact-match` | 005 S1–S5, S12 |
| `.topic-wrap` | Loaded detail: `h1#topic-title`, `.status-badge`, `.source-links`, `.ai-card` / `.key-points-state`, `.tl-filter`, `ol.timeline > li.tl-item` (`.tl-link`), `.rail` | 001 A1–A9, 002 F6–F8 |
| `.load-error` | App shell: feed load failure with a Retry button. Detail view: "Loading detail…" and detail errors, without Retry (gardening G5) | 003 R4 |

## Web API (Pages Functions, `apps/web/functions`)

All GET, R2 binding `OSS_KB_BUCKET`. Every response, including errors, carries
`cache-control: public, max-age=30, stale-while-revalidate=120`: `jsonResponse`
(`apps/web/functions/_shared/r2-projection.ts`) overwrites the `no-store` and
`immutable` headers the handlers pass (gardening G14). Errors are `{error}`.

| Endpoint | Returns | Data source | Covered by |
| --- | --- | --- | --- |
| `/api/feed` | Feed index: `generatedAt`, `projects[]`, `entries[]`, `metadata` with `servingMode`, `stale?`, `manifest {schema, releaseId, generatedAt, feedIndexKey, detailMapKey, entryCount}`; 503 on error | `public/v2/current.json` → `manifest.feedIndexKey` | 003 R1/R2/R4, 006 P1/P4, 010 F4/F6 |
| `/api/detail/:id` | `FeedDetail {entry, records[], keyPoints}`; 400 (no id), 404, 503 | detail map → `public/v2/objects/details/<sha256>.json` | 003 R3, 008 C1–C5 |
| `/api/search?q=` | `SearchResponseV1 {schema, query, results[] (entry, projectStatus?, matches, detailRef), facets.projects[], retrieval {indexRevision, lexicalRevision, generatedAt, stale}}`. `q` 1–500 chars; `limit` 1–50 (default 20); repeatable `projectId`, `sourceInstanceId`, `projectStatus`, `tag`; `occurredAfter`, `occurredBefore`. 400 for a client error, 503 otherwise | `public/search/v1/current.json` → `releases/<indexRevision>/manifest.json`. Release v3 (Spec 013): `terms.json` (term → document frequency and shard numbers) selects which `lexical/<projectId>/<n>.json` shards to read; v1/v2 read one shard per project | 005 S1–S15, 006 P10, 013 L1–L3, L8 |
| `/api/search-detail/:ref` | `FeedDetail`; 400 (missing or invalid ref), 404 (not found; for a v3 ref also a shard that is absent, out of range or of another project, or a group not in the shard), 503 (any other error, including a malformed `%` escape or a detail mismatch) | ref (`sdr1.…`, base64url JSON) carries `indexRevision`, project, group, `query`, `matchedRecordIds` and, for v3, its shard; v2/v3 details → `public/search/v1/objects/details/<hex>.json`, v1 details → `releases/<rev>/details/<name>.json` | 005 S4/S12, 008 C4/C6, 013 L4/L9 |

## Publisher API (`apps/data-publisher-worker/src/index.ts`)

| Endpoint | Auth | Returns | Covered by |
| --- | --- | --- | --- |
| `GET /health` | none | `environment`, `running`, `scheduled`, `phase` (null or `{phase, startedAt, materializedAt, counts}`), `lastRun` (null; success: `ok, environment, completedAt, publicationSetId, feedReleaseId, searchRevision, inputEventCount, logicalEventCount, pageCount, pollTruncated, copiedObjectCount, reusedObjectCount`; failure: `ok:false, environment, completedAt, failureKind, error, retryAfterSeconds`) | 009 M6/M7, 010 F6, 011 V5, 013 L18 |
| `POST /run` | `Bearer MANUAL_TRIGGER_TOKEN` | 202 `{ok, scheduled}`, 409 `{ok:false, skipped:"already-running"}`, 401 without the token. Verifiers never call it | 009 M9 |

There is no public `/status`: it exists only inside the Durable Object, and
`/health` proxies to it. Freshness reference: `lastRun.completedAt` equals
`/api/feed` `metadata.manifest.generatedAt` for the same release.

## Acceptance IDs by spec

| Spec | IDs | Surface |
| --- | --- | --- |
| [001](specs/001-kafka-decision-thread/acceptance.md) | A1–A12 | Domain, pipeline, detail page |
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
| [013](specs/013-search-streaming/spec.md) | L1–L18 | Search v3 shards and `terms.json`, `/api/search*`, publisher memory |

## Verification kit

| Command | Does | Example |
| --- | --- | --- |
| `bun run verify:ui` | Opens views in Chromium with a viewport, locale and clock; writes `<view>.png` and `summary.json` (per selector: count, visible, class, text, box, `overflowX`; per view: URL, `<html lang>`, page horizontal overflow) | `bun run verify:ui -- --target dev --view feed,feed-detail,search-detail --width 375 --locale en --at +3h23m --out evidence/v5` |
| `bun run verify:health` | Prints `/health` `lastRun` and `/api/feed` generatedAt/releaseId, whether they agree, the age, and whether the UI would show stale; exits 1 when they disagree | `bun run verify:health -- --target dev` |

`verify:ui` options: `--target local|dev`, `--view feed|feed-detail|search|search-detail`
(comma list), `--route /feed/<id>` (open a hash route directly), `--query`
(default `KIP-405`), `--width` (375), `--height` (800), `--locale en|zh-Hant`,
`--at now|<ISO with zone>|±<offset from generatedAt>` (e.g. `+3h1s`, `-30s`),
`--frozen` (fixed clock instead of a running one), `--selector` (repeatable,
adds to the defaults), `--out` (default `test-results/verify/<time>`). Both
commands only issue GET requests. `--target local` needs the fixture server running (see
Environments). A smoke run is part of `bun run test:e2e`
(`apps/web/e2e/verify-kit.spec.ts`), which needs `bun run build` first.
