# Feature map

What a verifier can open, call, and select, and which acceptance IDs cover it.
Derived from the code on `main`; update it in the PR that changes behavior.
Commands: `bun run verify:ui`, `bun run verify:health` (see
[Verification kit](#verification-kit)).

## Environments

| Environment | Web (Pages) | Publisher worker | R2 bucket |
| --- | --- | --- | --- |
| Local E2E | http://127.0.0.1:8788 (`bun run e2e:prepare && bun run build && bun run e2e:server`) | none | `oss-knowledge-base-local` (`apps/web/.wrangler/e2e-state`) |
| Dev | https://oss-knowledge-base-dev.pages.dev | https://oss-knowledge-base-data-dev.unknowntpo.workers.dev (Cron `7 * * * *`) | `oss-knowledge-base-dev` |
| Prod | not live (https://oss-knowledge-base.pages.dev deploys on a `v*` tag) | `oss-knowledge-base-data-prod`, no public URL (Cron `37 * * * *`) | `oss-knowledge-base-prod` |

Local fixture: `packages/reference-pipeline/test/fixtures/github-feed-projection.v1.json`,
3 Feed cards (Kafka, DataFusion), `generatedAt` `2026-08-25T12:00:00Z`; search
fixture from `packages/search/test/fixtures/golden-queries.v1.json` (`KIP-405`
returns results). Config: `apps/web/wrangler*.jsonc`, `playwright*.config.ts`.

## Views

Hash routing (`apps/web/src/main.ts`): every URL is `/#/…`. No query
parameters: search text, filters and sort live in component state.

| View | Route | Component | Reach it | Covered by |
| --- | --- | --- | --- | --- |
| Feed | `/#/` | `apps/web/src/views/FeedView.vue` (`#view-feed`) | open `/` | 002 F1–F11, 003 R2/R5, 010 F1–F5, 011 V1–V6 |
| Search | `/#/` with text in `#q` | same view; cards become `SearchResultCard` | type into `#q` (180 ms debounce) | 005 S1–S15 |
| Feed detail | `/#/feed/:displayId` | `apps/web/src/views/FeedDetailView.vue` (`#view-topic`) | click a `.card` | 001 A1–A12, 002 F6–F8, 003 R3, 008 C4–C5, 011 V1/V5 |
| Search detail | `/#/search/:detailRef` (`sdr1.…`) | same component, `detailRef` prop | click a `.search-card` | 005 S4/S12, 008 C4/C6, 011 V1/V5 |

App shell (`apps/web/src/App.vue`) fetches `/api/feed` once and shares it via
`apps/web/src/store.ts`; the topbar is on every view.

## UI elements

No `data-testid` attributes; tests select by class, id, and role.

| Selector | Meaning and states | Covered by |
| --- | --- | --- |
| `.topbar` | Header row; must not scroll sideways (`scrollWidth <= clientWidth`) | 011 V1 |
| `.brand`, `.brand-mark`, `.brand-name`, `.brand-scope` | Home link "K"; name and scope hidden at ≤420 px | 011 V1 |
| `.demo-pill` | Freshness pill. Class `is-live` or `is-stale` (`metadata.stale === true` or age > 3 h, `apps/web/src/freshness.ts` `STALE_AFTER_MS`). At ≤420 px hidden unless `is-stale`, then wraps (`apps/web/styles.css`). Text: "Updated just now / {n} min ago / {n} h ago", stale "Data may be out of date · {n} h ago"; "Published snapshot" when `generatedAt` is unparsable. Clock: browser `Date.now()`, re-read every 60 s | 010 F1–F6, 011 V1–V6 |
| `.locale-control` | Locale `<select>`: `zh-Hant` (default) or `en`. Persisted in `localStorage["community-kb-locale"]`; otherwise `navigator.language` (`zh*` → zh-Hant). `<html lang>` is not updated (see gardening) | 010 F1, 011 V1 |
| `.topbar-stat` | Topic and record counts | — |
| `#q` | Search input; examples and clear button beside it | 005 S11, S14 |
| `#filters`, `.filters-toggle`, `.filter-row` (`aria-pressed`) | Project, source, status, tag and time-window facets | 005 S6, S14 |
| `#sort` | hot / recent / relevance (no query only) | 002 F10 |
| `.card` (`FeedCard.vue`) | Feed card linking to `/feed/<displayId>`; `.topic-id`, `.status-badge.status-<x>`, `.card-project`, `.card-title`, `.trending-reason`, `.tag-pill` | 002 F1–F3, F10–F11 |
| `.search-card` (`SearchResultCard.vue`) | Search result linking to `/search/<detailRef>`; `.search-match-badge`, `.evidence`, `.exact-match` | 005 S1–S5, S12 |
| `.topic-wrap` | Loaded detail: `h1#topic-title`, `.status-badge`, `.source-links`, `.ai-card` / `.key-points-state`, `.tl-filter`, `ol.timeline > li.tl-item` (`.tl-link`), `.rail` | 001 A1–A9, 002 F6–F8 |
| `.load-error` | Load failure with Retry; the detail view also uses it for its "Loading detail…" state | 003 R4 |

## Web API (Pages Functions, `apps/web/functions`)

All GET, R2 binding `OSS_KB_BUCKET`, `cache-control: public, max-age=30,
stale-while-revalidate=120` unless noted; errors are `{error}` with `no-store`.

| Endpoint | Returns | Data source | Covered by |
| --- | --- | --- | --- |
| `/api/feed` | Feed index: `generatedAt`, `projects[]`, `entries[]`, `metadata` with `servingMode`, `stale?`, `manifest {schema, releaseId, generatedAt, feedIndexKey, detailMapKey, entryCount}`; 503 on error | `public/v2/current.json` → `manifest.feedIndexKey` | 003 R1/R2/R4, 006 P1/P4, 010 F4/F6 |
| `/api/detail/:id` | `FeedDetail {entry, records[], keyPoints}`; 400/404/503 | detail map → `public/v2/objects/details/<sha256>.json` | 003 R3, 008 C1–C5 |
| `/api/search?q=&limit=20` (+ `projectId`, `sourceInstanceId`, `projectStatus`, `tag`, `occurredAfter`, `occurredBefore`) | `SearchResponseV1 {query, results[], facets.projects[], retrieval {indexRevision, generatedAt, stale}}`; 400/503 | `public/search/v1/current.json` → release manifest → shards | 005 S1–S15, 006 P10 |
| `/api/search-detail/:ref` | `FeedDetail`; `immutable` for a year | `public/search/v1/objects/details/<hex>.json` | 005 S4/S12, 008 C4/C6 |

## Publisher API (`apps/data-publisher-worker/src/index.ts`)

| Endpoint | Auth | Returns | Covered by |
| --- | --- | --- | --- |
| `GET /health` | none | `environment`, `running`, `scheduled`, `phase` (null or `{phase, startedAt, materializedAt, counts}`), `lastRun` (null; success: `ok, completedAt, publicationSetId, feedReleaseId, searchRevision, inputEventCount, logicalEventCount, pageCount, pollTruncated, copiedObjectCount, reusedObjectCount`; failure: `ok:false, completedAt, failureKind, error, retryAfterSeconds`) | 009 M6/M7, 010 F6, 011 V5 |
| `POST /run` | `Bearer MANUAL_TRIGGER_TOKEN` | 202 `{ok, scheduled}` or 409 `{skipped:"already-running"}`. Verifiers never call it | 009 M9 |

There is no public `/status`: it exists only inside the Durable Object, and
`/health` proxies to it. Freshness reference: `lastRun.completedAt` equals
`/api/feed` `metadata.manifest.generatedAt` for the same release.

## Acceptance IDs by spec

| Spec | IDs | Surface |
| --- | --- | --- |
| [001](specs/001-kafka-decision-thread/acceptance.md) | A1–A12 | Domain, pipeline, detail page |
| [002](specs/002-generated-hot-feed/acceptance.md) | F1–F11 | Feed generation, cards, key points |
| [003](specs/003-r2-feed-projection/spec.md) | R1–R6 | `/api/feed`, `/api/detail` |
| [004](specs/004-replayable-github-feed/spec.md) | G1–G12 | GitHub publisher, pipeline |
| [005](specs/005-evidence-search/spec.md) | S1–S15 | `/api/search*`, `#q`, `.search-card`, facets |
| [006](specs/006-environment-isolated-r2-publication/spec.md) | P1–P15 | Environments, CI, R2 isolation |
| [007](specs/007-fluss-flink-compatibility-spike/spec.md) | C1–C7 | Spike only (`spikes/`) |
| [008](specs/008-content-addressed-details/spec.md) | C1–C7 | Detail pool, detail endpoints |
| [009](specs/009-bounded-memory-publication/spec.md) | M1–M9 | Publisher memory, `/health` phase, `/run` |
| [010](specs/010-feed-freshness/spec.md) | F1–F6 | `.demo-pill` text and class |
| [011](specs/011-stall-visibility/spec.md) | V1–V6 | `.demo-pill` at ≤420 px on Feed, Feed detail, Search detail |

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
commands only issue GET requests. Local needs the fixture server running; a
smoke run is part of `bun run test:e2e` (`apps/web/e2e/verify-kit.spec.ts`).
