# Spec 031: Path URLs instead of hash routing

Status: Implemented (owner decision 2026-10-25)
Date: 2026-10-25
Traceability: enforced
Builds on: Spec 014 (Behavior 27, project-scoped routes, D62), Spec 019 (the profile route `/<project>/people/<id>`)

## Intent

The owner wants normal, RESTful-looking URLs that can be shared and read:
`https://oss-knowledge-base-dev.pages.dev/kafka/people/github%3Am1a2st`
instead of `https://oss-knowledge-base-dev.pages.dev/#/kafka/people/github%3Am1a2st`
(owner decision, 2026-10-25).

Observable outcome: every page of the web app has a path URL. Opening a path
URL directly (a bookmark, a pasted link, a reload) shows that page. Every old
`#/…` link still lands on the same page, rewritten to its path form.

## Evidence

- `apps/web/src/main.ts` used `createWebHashHistory()`. No spec, ADR, or PR
  records a reason for hash mode.
- Cloudflare Pages serves `index.html` for any path that has no static file
  when the build has no top-level `404.html` (single-page-application
  fallback). `apps/web/dist` holds only the Vite build: `index.html` and
  `assets/`. There is no `_redirects` or `_routes.json`; the only Pages
  Functions are under `apps/web/functions/api/`, so the generated routes
  cover `/api/*` only and do not shadow page paths.
- Vite's default `base` is `/`, so the built `index.html` references
  `/assets/<name>-<hash>.js` and `.css` with absolute paths; a page at
  `/kafka/people/x` loads the same files.
- Old links exist outside the app: bookmarks, chat messages, and this
  repository's own specs and runbooks use `/#/…`.

## Example

Local `wrangler pages dev dist` (the E2E server, fixture data), 2026-10-25:

| Opened URL | Lands on | Shows |
| --- | --- | --- |
| `/kafka/people/github%3Aalice` | `/kafka/people/github%3Aalice` | alice's profile |
| `/#/kafka/people/github%3Aalice` | `/kafka/people/github%3Aalice` | alice's profile |
| `/kafka/people/x#/kafka/` | `/kafka/` | This week |
| `/kafka/threads#main` | `/kafka/threads#main` | All threads (the hash is an in-page anchor) |
| `/api/feed` | `/api/feed` | the Feed JSON from the Pages Function |

## Behavior

1. The router uses `createWebHistory()`. Routes (`createRoutes` in
   `apps/web/src/routes.ts`) are unchanged; only the URL form changes from
   `/#/<route>` to `/<route>`.
2. In-app links are path URLs. Links built as strings (`citeTarget`, the topic
   page's thread id) start with `/` and render as `RouterLink`, so a click
   navigates inside the app without reloading the page. External links stay
   plain `<a>` elements.
3. Legacy hash: when the page loads with a hash that starts with `#/`, the
   app replaces the URL with `<hash without "#">` (`history.replaceState`)
   before the router is created, so the first navigation is the path route.
   (`router.replace` before `app.use` was tried first: the router's own
   initial navigation to the original URL raced it and won.)
   The path part of the old URL is ignored (the old router ignored it too), so
   `/kafka/people/x#/kafka/` lands on `/kafka/`. Replacing keeps the history
   length; the back button does not return to the hash URL. Any other hash
   (`#main`, `#`, empty) is left alone, and so is `#//host` or `#/\host`:
   as a URL it names another origin, which `history.replaceState` rejects.
4. No server change: Pages' single-page fallback serves `index.html` for page
   paths and the Pages Functions keep `/api/*`. No `_redirects`, no
   `_routes.json`, no catch-all Function.
5. Code outside `apps/web/src` that builds web URLs uses the path form:
   `feedLink` in `packages/reference-pipeline/src/review-queue/threads.ts`,
   `scripts/verify/ui.ts`, the E2E and deployed E2E suites.

Simplification review: a server-side redirect from `/#/…` is impossible (the
hash never reaches the server), so the client mapping is the only place it can
live. A `_redirects` file was considered and deleted: the fallback already
does what it would do. A per-route compatibility table was deleted: the old
hash is exactly the new path.

## Acceptance

### Behavior

- U1: given the local Pages server, opening `/kafka/people/github%3Aalice`
  directly shows alice's profile, the URL has no `#`, and the HTML response
  for that path is `index.html` with absolute `/assets/` script and style
  URLs. Evidence: `apps/web/e2e/path-urls.spec.ts`.
- U2: in-app links are path URLs: a GitHub author in Detail links to
  `/kafka/people/github%3Abob`, a citation or topic thread id links to
  `/feed/<displayId>`, and clicking one changes the URL without a page load.
  Evidence: `apps/web/test/digest-ui.test.ts`,
  `apps/web/e2e/people.spec.ts`, `apps/web/e2e/path-urls.spec.ts`.
- U3: a `#/` hash maps to its path form (the case file below). Evidence:
  `apps/web/test/legacy-hash.test.ts`.
- U4: given the local Pages server, opening `/#/kafka/people/github%3Aalice`
  lands on `/kafka/people/github%3Aalice` and shows the profile; opening
  `/kafka/people/x#/kafka/` lands on `/kafka/`. Evidence:
  `apps/web/e2e/path-urls.spec.ts`.

### Failure and retry

- U5: a hash that does not start with `#/` is not a legacy route: the case
  file's `#main`, `#`, and empty rows map to nothing, and `/kafka/threads#main`
  keeps its URL in the browser. Evidence: `legacy-hash.test.ts`,
  `path-urls.spec.ts`.
- U6: a path no route knows (`/kafka/no/such/page`) still gets `index.html`
  and the not-found state, and `/api/feed` still returns the Feed JSON, not
  `index.html`. Evidence: `path-urls.spec.ts`.

### Budget

Not applicable: no new request, object, or Function. The legacy mapping is one
string check before the first navigation.

### Observability

- U7: [deploy] after the merge deploys Dev, `bun run test:e2e:development`
  opens path URLs (`/kafka/threads`, `/kafka/`) on Dev and passes.

<!-- test-plan:start apps/web/test/legacy-hash.cases.ts -->
| id | case | path | hash | lands |
| --- | --- | --- | --- | --- |
| U3 | a profile link from the hash router | / | #/kafka/people/github%3Am1a2st | /kafka/people/github%3Am1a2st |
| U3 | the old path is ignored, as the hash router ignored it | /kafka/people/x | #/kafka/ | /kafka/ |
| U3 | bare hash root opens Home (then the last project) | / | #/ | / |
| U3 | Detail | / | #/feed/KAFKA-PR-43 | /feed/KAFKA-PR-43 |
| U3 | Search detail | / | #/search/sdr1.abc | /search/sdr1.abc |
| U5 | an in-page anchor (skip link) | /kafka/threads | #main | — |
| U5 | an empty fragment | /kafka/ | # | — |
| U5 | no hash | /kafka/ |  | — |
| U5 | a fragment that only looks like a path | /kafka/ | #kafka/threads | — |
| U5 | a protocol-relative URL (another origin) is refused | / | #//evil.example/x | — |
| U5 | a backslash form of the same is refused | / | #/\evil.example/x | — |
<!-- test-plan:end -->

## Non-goals

- Query parameters for search text or filters (still component state).
- Rewriting historical spec prose: older specs keep `/#/…` as written at the
  time; this spec and `docs/feature-map.md` state the current form.
- A server redirect for old links (the hash never reaches the server).

## Risks

- Old bookmarks keep working only through the client mapping (U3, U4); a
  crawler or tool that does not run JavaScript sees `index.html` for both.
- `deployed-e2e` against a Dev deployment built before this change would fail
  on path assertions; it runs after the Dev deploy of this change (U7).
