# Gardening list

Known workarounds, stale copy, follow-ups recorded as non-goals, and test
gaps. Agents copy what they see, so an item left here spreads. Rules
([workflow](process/workflow.md#gardening)): no new workaround lands without
an entry; a gardener pass fixes or deletes items and removes them from this
list in the same PR.

Trust layers, strongest first: structure (types, schemas) → static check (CI
gate) → test → rule (workflow.md) → automated review → skill → human review.
"Layer" names where the fix should land so the lesson cannot recur.

Last full pass: 2026-10-06 (`main` 6cfbfc6). Repository grep for
`TODO|FIXME|HACK|XXX|workaround|for now` outside docs and fixtures found only
the two `viewer/` items below.

## Web UI

### G1. `<html lang>` stays `zh-Hant` in the English UI
- **Where:** `apps/web/index.html` (`<html lang="zh-Hant">`); `apps/web/i18n.js`
  sets `document.documentElement.lang` only in `apply()`, which runs on
  `setLocale`, not on first load.
- **Why:** screen readers and hyphenation use the wrong language for every
  English visitor whose locale came from storage or `navigator.language`.
  Reproduced: `bun run verify:ui -- --target dev --locale en` reports `lang=zh-Hant`.
- **Fix:** set `lang` once at startup from the resolved locale.
- **Layer:** test (E2E asserting `<html lang>` per locale).
- **Source:** [PR #26 verifier, note 3](https://github.com/unknowntpo/oss-knowledge-base/pull/26#issuecomment-6012144497).
  `apps/web/i18n.js` is changed by open PR #27; fix after it merges.

### G2. Stale pill touches the brand mark at 320 px, English
- **Where:** `apps/web/styles.css`, `.brand` (flex item with `min-width: 0`).
- **Why:** `.brand` shrinks to 16 px, narrower than its 26 px `.brand-mark`,
  so the topbar gap collapses. Reproduced locally: `.brand` width 16 with
  `overflowX`, `.brand-mark` right edge 42, `.demo-pill` x 42.
- **Fix:** `flex-shrink: 0` on `.brand`.
- **Layer:** test (extend Spec 011 V1: `pill.x >= brand-mark.right + gap`).
- **Source:** [PR #26 verifier, note 1](https://github.com/unknowntpo/oss-knowledge-base/pull/26#issuecomment-6012144497).
  `apps/web/styles.css` is changed by open PR #27.

### G3. `metadata.stale` shows stale styling with fresh text
- **Where:** `apps/web/src/App.vue` (pill class uses `metadata.stale`, text
  uses `freshness` only).
- **Why:** a cached Feed with a recent `generatedAt` reads "Updated 2 h ago"
  in warning colours; the two signals contradict each other.
- **Fix:** one function returns both class and text from
  `(metadata.stale, freshness)`; stale wording wins.
- **Layer:** structure (a single `pillState` result, so class and text cannot
  diverge) plus a case row in `apps/web/test/freshness.cases.ts`.
- **Source:** [Spec 011 Non-goals](specs/011-stall-visibility/spec.md#non-goals),
  [PR #26 verifier](https://github.com/unknowntpo/oss-knowledge-base/pull/26#issuecomment-6011850693).

### G4. Search detail horizontal overflow at 375 px (unconfirmed)
- **Where:** Search detail view (`apps/web/src/views/FeedDetailView.vue`).
- **Why:** reported from Spec 011 Evidence screenshots. Not reproduced on
  2026-10-06: `verify:ui --view search-detail --width 375` (first `KIP-405`
  result, en and zh-Hant, local fixture and Dev) shows no page overflow and no
  element past the viewport.
- **Fix:** find the detail that overflows (likely a long unbroken URL or code
  span) and add `overflow-wrap: anywhere`; otherwise close the item.
- **Layer:** test (E2E: `document.body.scrollWidth <= innerWidth` on detail views).
- **Source:** [Spec 011 Non-goals](specs/011-stall-visibility/spec.md#non-goals).

### G5. Detail loading state reuses `.load-error` and is not translated
- **Where:** `apps/web/src/views/FeedDetailView.vue` lines 113 and 138
  (`<div class="load-error"><p>Loading detail…</p>`).
- **Why:** an error class marks a normal state (selectors for "error" match
  loading); the zh-Hant UI shows English. Found while building `verify:ui`,
  which has to exclude it explicitly.
- **Fix:** a `.loading` class and an i18n key.
- **Layer:** test (zh-Hant detail E2E asserts no untranslated text).
- **Source:** this PR (`scripts/verify/ui.ts`, `openView`).
  `FeedDetailView.vue` is changed by open PR #27.

### G6. Feed subtitle says "Ranked by GitHub activity signals"
- **Where:** `apps/web/i18n.js` `stream.trending.description` (en line 209,
  zh-Hant line 65).
- **Why:** inaccurate once Spec 012 adds mailing-list and Jira sources.
- **Fix:** source-neutral copy in the Spec 012 PR or right after it.
- **Layer:** rule (spec template: list user-visible copy a source change
  affects) — copy cannot be checked mechanically.
- **Source:** [PR #27, Spec 012](https://github.com/unknowntpo/oss-knowledge-base/pull/27).

### G7. Per-source failure is not visible in the UI
- **Where:** Spec 012 adds per-source `/health` fields; the web app reads only
  `/api/feed` freshness.
- **Why:** a dead mailing-list or Jira source looks fresh because GitHub still
  publishes; the Spec 011 pill cannot show it.
- **Fix:** follow-up spec: expose per-source freshness in `metadata` and show
  it in the pill or Feed header.
- **Layer:** test plus runtime (`/health` per-source age, asserted in the
  deployed E2E).
- **Source:** [Spec 012 Non-goals, "Alerting on a failed source"](https://github.com/unknowntpo/oss-knowledge-base/blob/41dc4d39ef0312277349098f76f0e4131c4c01a8/docs/specs/012-kafka-mailing-list-jira/spec.md#non-goals).

## Publisher and data

### G8. `isBot` is a substring match on the login
- **Where:** `apps/github-publisher/github-connector.ts:99` —
  `login.toLowerCase().includes("bot")`.
- **Why:** misses bots without "bot" in the login (`codecov-commenter`) and
  flags humans whose login contains it (`abbott`); bot comments then count
  toward hot ranking, authors, and key-point candidates
  (`packages/reference-pipeline/src/materializer.ts`).
- **Fix:** classify from GitHub's `user.type === "Bot"` or a `[bot]` suffix,
  plus an explicit per-profile list of machine users (`codecov-commenter` is
  a regular user account); `isBot` is already an event field, so replay stays
  deterministic.
- **Layer:** structure (classification from a typed field, not a name) plus
  case rows.
- **Source:** reported by the human, 2026-10-06 (verification-kit brief).

### G9. No R2 retention or garbage collection
- **Where:** `public/v2/releases/*`, `public/v2/objects/details/*`,
  `public/search/v1/releases/*` in every bucket.
- **Why:** every hourly run adds a release and new pool objects; nothing is
  deleted, so storage and list cost grow without bound.
- **Fix:** own spec: keep the last N releases plus anything reachable from
  them; mark-and-sweep with a dry-run report first.
- **Layer:** test plus measurement (object count per day on Dev).
- **Source:** [Spec 008 Non-goals](specs/008-content-addressed-details/spec.md#non-goals),
  [ADR 0013](architecture/decisions/0013-share-detail-objects-by-content-digest.md).

### G10. Feed-index write is the next memory peak
- **Where:** publisher Feed index serialization
  (`apps/data-publisher-worker/src/pipeline.ts`).
- **Why:** after Spec 013 streams Search, the Feed index write peaks at
  138 MB at 25,800 events (3x today), above the 128 MB Durable Object limit.
- **Fix:** stream the Feed index the way Spec 013 streams Search shards.
- **Layer:** measurement (`bun run --cwd apps/data-publisher-worker measure:memory` budget row at 3x).
- **Source:** [PR #28 body](https://github.com/unknowntpo/oss-knowledge-base/pull/28).

## Process and docs

### G11. Spec status lines drift from reality
- **Where:** `docs/specs/*/spec.md`. Specs 008 and 009 said `Status: Draft`
  after PRs #21 and #23 merged (fixed in this PR); 001 says "Draft for
  implementation" and 002 "Implemented POC" in a list-item form the other
  specs do not use.
- **Why:** readers and agents use status to decide what is binding.
- **Fix:** one `Status:` line form with a fixed vocabulary (Draft, Accepted,
  Implemented (PR #n), Superseded); the merging PR updates it.
- **Layer:** static check (extend `check:traceability` to require a valid
  `Status:` line in every spec).
- **Source:** gardener pass 2026-10-06.

### G12. Spec 011 test gaps that mutations survived
- **Where:** `apps/web/e2e/stall-visibility.spec.ts`.
- **Why:** a stale pill clipped vertically (`max-height: 16px; overflow:
  hidden`) or drawn over the brand mark (`margin-left: -34px`) still passes V1.
- **Fix:** assert `scrollHeight <= clientHeight` and `pill.x >= brand-mark.right`.
- **Layer:** test.
- **Source:** [PR #26 verifier mutation run](https://github.com/unknowntpo/oss-knowledge-base/pull/26#issuecomment-6012144497).

### G13. `viewer/` placeholders
- **Where:** `viewer/src/components/AskView.tsx:5` ("deferred for now"),
  `viewer/wrangler.toml:2` ("Static-only for now").
- **Why:** the legacy viewer is not part of `apps/web`; its placeholders read
  as live intent.
- **Fix:** decide whether `viewer/` is still deployed; delete it or record it
  as frozen.
- **Layer:** rule (README states which apps are live).
- **Source:** repository grep, 2026-10-06.
