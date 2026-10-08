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

### G1. `<html lang>` is not set on first load
- **Where:** `apps/web/index.html` (`<html lang="zh-Hant">`); `apps/web/i18n.js`
  updates `document.documentElement.lang` in `apply()` (line 327), which runs
  when the user changes the locale select (`setLocale`, line 345) but not
  when the initial locale is resolved. A page that starts in English keeps
  `lang="zh-Hant"` until the user switches.
- **Why:** screen readers and hyphenation use the wrong language for every
  English visitor whose locale came from storage or `navigator.language`.
  Reproduced: `bun run verify:ui -- --target dev --locale en` reports `lang=zh-Hant`.
- **Fix:** set `lang` once at startup from the resolved locale.
- **Layer:** test (E2E asserting `<html lang>` per locale).
- **Source:** [PR #26 verifier, note 3](https://github.com/unknowntpo/oss-knowledge-base/pull/26#issuecomment-6012144497).
  `apps/web/i18n.js` is changed by open PR #27; fix after it merges.

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

### G14. API cache headers: errors are cached, Search detail is not immutable
- **Where:** `jsonResponse` in `apps/web/functions/_shared/r2-projection.ts`
  (lines 79–84) always sets `cache-control: public, max-age=30,
  stale-while-revalidate=120`, overwriting the `no-store` (errors in
  `feed.ts`, `search.ts`, `detail/[id].ts`, `search-detail/[ref].ts`) and
  `public, max-age=31536000, immutable` (`search-detail/[ref].ts`) headers the
  handlers pass.
- **Why:** a transient 503 or a 404 is cached for 30 s plus 120 s stale, so
  the page keeps failing after R2 recovers; immutable Search details are
  re-fetched every 30 s. Observed on Dev: `/api/search-detail/bogus` → 400
  and `/api/detail/NOPE-1` → 404, both with `max-age=30`.
- **Fix:** set the default only when `init.headers` has no `cache-control`.
- **Layer:** test (Functions test asserting the header per status and
  endpoint).
- **Source:** [PR #29 verifier, 2a](https://github.com/unknowntpo/oss-knowledge-base/pull/29#issuecomment-6014587324).

### G15. "Relevance" sort is dead code on the Feed
- **Where:** `apps/web/src/views/FeedView.vue`: `visibleEntries` fixes
  `normalized = ""` (line 126), so the relevance branch (line 137) never runs;
  `#sort` is rendered only without a query (line 254).
- **Why:** choosing "relevance" orders like "hot"; the option and the
  `searchScore` helper suggest behavior that does not exist.
- **Fix:** delete the relevance option and `searchScore`, or define what it
  means without a query.
- **Layer:** structure (remove the unreachable option) — delete, do not explain.
- **Source:** [PR #29 verifier, 2d](https://github.com/unknowntpo/oss-knowledge-base/pull/29#issuecomment-6014587324).

## Publisher and data

### G8. `isBot` is a substring match on the login
- **Where:** `apps/github-publisher/github-connector.ts:100` —
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
- **Note (Spec 014):** the digest already classifies authors with
  `isMachineAuthor` (`[bot]` suffix plus the profile's `machineUsers`) in
  `packages/reference-pipeline/src/digest/candidates.ts`; the publisher fix
  should reuse it. That fix changes Feed authors and signals, so it rewrites
  Details and needs a full-scale rehearsal (Spec 012 incident).

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

### G16. The 4 MiB response limit is checked after the whole body is read
- **Where:** `getText` in `packages/reference-pipeline/src/kafka-connectors.ts`
  reads `response.text()` and only then compares its length with
  `MAX_RESPONSE_CHARS`.
- **Why:** an oversized Pony Mail or Jira response is fully buffered in the
  128 MB Durable Object before it is rejected; the length is in UTF-16 code
  units, not bytes.
- **Fix:** check `content-length` first and stop reading the stream past the
  limit.
- **Layer:** test (a streamed body larger than the limit is cancelled).
- **Source:** Spec 012 implementation (PR #27).

### G17. dev@ notification filter is a subject-prefix rule
- **Where:** `isNotificationSubject` in
  `packages/reference-pipeline/src/kafka-rules.ts`.
- **Why:** Jira and GitHub notification mail is recognised only by a
  `[jira]`/`[PR]` subject prefix; a renamed bot prefix would publish
  notification mail as threads.
- **Fix:** also match the sender (`… (Jira)`, GitHub bot) if Pony Mail keeps
  it stable; count `filtered` in `/health` (already reported) and alert on a
  sudden drop.
- **Layer:** test plus runtime (`sources.mail.filtered` on Dev).
- **Source:** Spec 012 implementation (PR #27).

### G18. Digest rules classifier leaves many threads in `other`
- **Where:** `rulesClassify` in `packages/reference-pipeline/src/digest/classify.ts`.
- **Why:** it is the deterministic fallback behind the model classifier
  (Spec 014 Behavior 6). On the captured week it put 45 of 172 non-routine
  Kafka threads in `other`, and it misfiles build tooling (for example
  `KAFKA-PR-23691`). More regexes would hide the model's job; the golden set
  decides the model instead.
- **Fix:** none intended. Revisit only if the model is unavailable often
  enough that fallback digests become common (`/health.digest.lastRun.fallbacks`).
- **Layer:** measurement (`bun run digest -- eval` share of `other`).
- **Source:** Spec 014 slice 1.

### G19. Workers AI price table is copied into code
- **Where:** `PRICES` in `packages/reference-pipeline/src/digest/estimate.ts`.
- **Why:** the daily spend cap (Spec 014 Behavior 15) and `bun run digest --
  measure` use these numbers; a Cloudflare price change makes the cap wrong
  silently.
- **Fix:** recalibrate against AI Gateway logs (Spec 014 D35) and update the
  table with its source URL and date.
- **Layer:** runtime (D35 calibration on Dev), then test (the table's date is
  checked in review).
- **Source:** Spec 014 slice 1.

### G20. Lowercase proposal keys are not "other proposals"
- **Where:** `rejectSentence` in
  `packages/reference-pipeline/src/digest/validate.ts` (one-proposal rule).
- **Why:** the profile `keyPattern` is case-sensitive (Spec 012), so a
  generated KIP-1163 line that says `kip-1165` is kept. Spec 014 Behavior 30
  does not say whether that counts as naming another proposal.
- **Fix:** decide in the spec; if it counts, match keys case-insensitively in
  the validator only (not in key extraction).
- **Layer:** test (a case row once decided).
- **Source:** [PR #33 verifier, F3](https://github.com/unknowntpo/oss-knowledge-base/pull/33#issuecomment-6052403167).

### G21. Digest spend after a failed model call is the full estimate
- **Where:** `ModelCalls.call` in
  `apps/data-publisher-worker/src/digest/model.ts`.
- **Why:** a call that throws adds its pre-call bound (input + `max_tokens`)
  to today's spend, because the real usage of a failed call is unknown. That
  is conservative: repeated failures can reach the daily cap early.
- **Decision (PR #35 review):** keep the conservative rule for now; it is
  asserted by a D14 row ("a call that fails twice": both attempts add the
  pre-call estimate).
- **Fix:** replace it with gateway-reported usage once D35 shows the error
  shapes.
- **Layer:** runtime (D35 calibration on Dev).
- **Source:** Spec 014 slice 2.

### G23. Proposal titles taken from PR titles keep noise
- **Where:** `proposalTitle` in `apps/web/src/digest-view.ts`.
- **Why:** when a KIP has no tagged dev@ subject, the title comes from a PR
  title, which keeps prefixes and phrasing such as "MINOR: Clarify KIP-1331
  …", "[DRAFT] KIP-1289 — …", or "Implement compression support for
  KIP-1332". A row without a generated line also repeats its subject as the
  fallback line (KIP-1163).
- **Fix:** strip `MINOR:`, bracket tags, and the KIP key from PR-derived
  titles. Show chips only when the fallback line equals the title.
- **Layer:** test (case rows on the captured week's titles).
- **Source:** [PR #36 verifier, N3](https://github.com/unknowntpo/oss-knowledge-base/pull/36#issuecomment-6054011406).

### G24. Thread excerpts include PR-body trailers
- **Where:** the root excerpt (`selectCandidates` in
  `packages/reference-pipeline/src/digest/candidates.ts`), shown on topic-page
  thread cards.
- **Why:** PR descriptions end with "Reviewers: … <redacted>" trailers, which
  fill the 280-character excerpt with noise.
- **Fix:** drop trailer lines (`Reviewers:`, `Co-authored-by:`) before
  truncating.
- **Layer:** test (a case row with a captured PR body).
- **Source:** [PR #36 verifier, N4](https://github.com/unknowntpo/oss-knowledge-base/pull/36#issuecomment-6054011406).

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

### G13. `viewer/` placeholders
- **Where:** `viewer/src/components/AskView.tsx:5` ("deferred for now"),
  `viewer/wrangler.toml:2` ("Static-only for now").
- **Why:** the legacy viewer is not part of `apps/web`; its placeholders read
  as live intent.
- **Fix:** decide whether `viewer/` is still deployed; delete it or record it
  as frozen.
- **Layer:** rule (README states which apps are live).
- **Source:** repository grep, 2026-10-06.

### G22. `/api/feed` ships the whole Feed index (11 MB) to every visitor
- **Where:** `apps/web/functions/api/feed.ts`, `apps/web/src/api.ts`.
- **Why:** after Spec 012 the index is 11.05 MB uncompressed (3,743 entries
  with `searchText`). Every page load downloads it, and Chromium's inspector
  can no longer return its body, which broke the deployed E2E from #31 to #35
  unnoticed (PR checks skip deployed E2E).
- **Fix:** page or project-scope the Feed response and drop `searchText` from
  it; Spec 014's `/#/<project>/threads` is the natural cut. Separately, make a
  red deployed E2E on `main` visible before the next merge.
- **Layer:** structure (response shape) and gate (merge only on a green `main`).
- **Source:** deployed E2E failures on `main`, 2026-10-07/08.
