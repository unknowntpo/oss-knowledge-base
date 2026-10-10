# Spec 003 Acceptance

## R1 — Atomic release visibility

Given a generated Feed payload, when a release is published, then every
immutable Feed/Detail object is written before `current.json`, and a repeatable
test verifies the manifest is the final publication object.

## R2 — Bounded Feed read

Given a valid current manifest, when `/api/feed` is requested, then the response
contains Feed entries and no embedded `FeedDetail` objects.

## R3 — Lazy Detail hydration

Given a Feed entry returned by `/api/feed`, when its detail endpoint is opened,
then the corresponding FeedDetail is loaded through the same current manifest
and contains its complete source records.

## R4 — Missing or invalid manifest

Given no valid current manifest, when Feed is requested, then the function
returns an explicit unavailable response and never guesses an object prefix.

## R5 — Framework migration continuity

Given the Vue build, when Feed and Detail are inspected at desktop and mobile
viewports, then they remain navigable, filters open on mobile, and browser
evidence contains no console errors, page errors, or failed requests.

## R6 — Local Cloudflare proof

Given generated real Kafka and DataFusion GitHub projections in local R2, when
Wrangler runs the Pages project, then `/api/feed` reports
`cloudflare-pages-function-r2` and a FeedDetail request returns cited records.

## R7 — Response caching

Given each endpoint and outcome in the spec's "Response caching" table, when
the Pages Function answers, then `cache-control` is the listed value: no error
is storable, successes revalidate after 30 s, and a Search detail is immutable
→ evidence: `apps/web/test/r2-functions.test.ts` (`R7:` rows).
