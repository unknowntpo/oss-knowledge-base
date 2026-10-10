# Spec 003: Versioned R2 Feed Projection

Status: POC deployed

## Intent

Serve the Vue Feed and FeedDetail from a private R2 bucket through same-origin
Cloudflare Pages Functions, without placing ingestion or stream-processing
systems in the browser request path.

## Scope

- Vue 3, Vite, TypeScript, and Vue Router preserve the accepted Feed → Detail
  interaction and existing visual language.
- A deterministic publisher converts one `FeedPublication` into an immutable
  `FeedIndex`, one object per `FeedDetail`, and a current manifest.
- Pages Functions hydrate Feed and Detail through an R2 binding.
- Local Wrangler/Miniflare and an isolated Cloudflare deployment prove the same
  Pages Functions → private R2 boundary.

## Non-goals

- Deploying or provisioning a production Pages project or R2 bucket.
- Replacing Fluss/Flink as the target event and processing plane.
- Implementing semantic search, authentication, or personalized ranking.
- Making R2 the owner of connector checkpoints or canonical events.

## Public object contract

```text
public/v2/current.json
public/v2/releases/{releaseId}/feed/index.json
public/v2/releases/{releaseId}/details/{safeFeedEntryId}.json
```

The publisher writes the manifest last. Release objects are immutable. Feed
index records contain only the data needed to render and filter cards; complete
records, connections, and key points live in FeedDetail.

The publisher rejects missing or orphaned details before producing any object.
The manifest is the final object in the generated publication sequence.

## Response caching

Added 2026-10-10 (acceptance R7) after `jsonResponse` was found overwriting the
headers its callers passed, so a 503 could be replayed for 30 s plus 120 s
stale. It covers every Pages Function under `apps/web/functions/api`, including
the Search and digest endpoints of later specs, because they share the helper.

- An error (status ≥ 400) is `no-store`.
- A success is `public, max-age=30, stale-while-revalidate=120`: it follows the
  mutable `current.json` pointers.
- A `/api/search-detail/:ref` success uses the same default, not `immutable`.
  The objects a ref reads never change, but the handler shapes the body
  (`reason.label`, `highlightedRecordIds`, and `FeedDetail` fields that are
  still being added), so the response is not a pure function of the ref and a
  one-year browser cache would pin old shapes (gardening G37).
- A `cache-control` passed by a handler wins; the defaults above apply only
  when it passes none.

Generated from `apps/web/test/api-cache.cases.ts` by `bun run docs:test-plan`;
`r2-functions.test.ts` runs exactly these rows against the handlers. Edit the
case file, not this table.

<!-- test-plan:start apps/web/test/api-cache.cases.ts -->
| id | endpoint | outcome | status | cacheControl |
| --- | --- | --- | --- | --- |
| R7 | /api/feed | current release | 200 | public, max-age=30, stale-while-revalidate=120 |
| R7 | /api/feed | no manifest | 503 | no-store |
| R7 | /api/detail/:id | entry of the current release | 200 | public, max-age=30, stale-while-revalidate=120 |
| R7 | /api/detail/:id | no id | 400 | no-store |
| R7 | /api/detail/:id | unknown id | 404 | no-store |
| R7 | /api/detail/:id | no manifest | 503 | no-store |
| R7 | /api/search | query with results | 200 | public, max-age=30, stale-while-revalidate=120 |
| R7 | /api/search | empty query | 400 | no-store |
| R7 | /api/search | no current pointer | 503 | no-store |
| R7 | /api/search | unsupported lexical revision | 503 | no-store |
| R7 | /api/search-detail/:ref | ref of a published release | 200 | public, max-age=30, stale-while-revalidate=120 |
| R7 | /api/search-detail/:ref | no ref | 400 | no-store |
| R7 | /api/search-detail/:ref | invalid ref | 400 | no-store |
| R7 | /api/search-detail/:ref | detail object absent | 404 | no-store |
| R7 | /api/search-detail/:ref | release manifest absent | 503 | no-store |
| R7 | /api/digest | current digest | 200 | public, max-age=30, stale-while-revalidate=120 |
| R7 | /api/digest | unknown project | 400 | no-store |
| R7 | /api/digest | unsupported locale | 400 | no-store |
| R7 | /api/digest | no pointer yet | 404 | no-store |
| R7 | /api/digest | pointer outside the project prefix | 503 | no-store |
<!-- test-plan:end -->
