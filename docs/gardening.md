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
- **Progress:** Spec 015 slice 1 classifies GitHub reviewers and authors
  with `isMachineAuthor` plus GitHub's `Bot` type (`isMachineActor`); the
  publisher's `isBot` still uses the substring rule.

### G9. No R2 retention or garbage collection
- **Where:** `public/v2/releases/*`, `public/v2/objects/details/*`,
  `public/search/v1/releases/*` in every bucket.
- **Why:** every hourly run adds a release and new pool objects; nothing is
  deleted, so storage and list cost grow without bound.
- **Fix:** own spec: keep the last N releases plus anything reachable from
  them; mark-and-sweep with a dry-run report first.
- **Also:** Spec 015 adds `public/review-queue/v1/<projectId>/<sha256>.json`
  (one object per changed hourly run) and `internal/rosters/v1/`; keep the
  objects `current.json` points to and the last few.
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
- **Where:** `PRICES` in `packages/reference-pipeline/src/digest/estimate.ts`. Includes the Clef decision models since slice 2b ($0.09 and $0.24 per M input tokens, from the Clef-flash model page, 2026-10-08).
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

### G25. Review-queue voter identity is a display name
- **Where:** `matchesRosterName` and `tallyVote` in
  `packages/reference-pipeline/src/review-queue/`.
- **Why:** votes are matched to the ASF roster by exact display name
  (Spec 015 Behavior 23). A person who mails under two names counts twice;
  two people with one name count once; a misspelled committer counts as
  "unmarked". The roster is today's, not the one at the vote's date.
- **Fix:** none until a wrong count is seen; then add an alias list to the
  roster object (data, not a rule).
- **Layer:** test rows (Q10, Q11) plus the visible "via roster" and
  "unmarked" parts of the tally.
- **Source:** Spec 015 governance review (2026-10-08).

### G26. Emeritus committers count as binding via the roster
- **Where:** `parseAsfRoster` (`packages/reference-pipeline/src/review-queue/roster.ts`).
- **Why:** no public ASF source marks emeritus committers; the LDAP group
  still holds 5 incubator-era mentors. Their unmarked +1 would count as
  binding, so a vote can look passing when it is not.
- **Fix:** intersect with the kafka-site committer list once its 7 spelling
  differences are resolved (ADR-0016 revisit trigger).
- **Layer:** structure (roster entries) plus the "via roster" label.
- **Source:** Spec 015 Evidence.

### G27. A rebase-only force-push counts as an author update
- **Where:** `classifyPr` (`packages/reference-pipeline/src/review-queue/prs.ts`).
- **Why:** GitHub's timeline does not say whether a force-push changed the
  code, so a rebase moves a PR from "author's turn" to "waiting".
- **Fix:** none intended; documented in Spec 015 Behavior 4.
- **Layer:** test row (Q22).
- **Source:** Spec 015.

### G28. A `[RESULT]` older than the Feed window re-queues a closed vote
- **Where:** `kipCandidates` (`packages/reference-pipeline/src/review-queue/threads.ts`).
- **Why:** the `[RESULT]` check sees only the pinned Feed release (about 30
  days). A late reply to an old vote thread makes it a candidate again.
- **Fix:** when seen, look up `[RESULT]` subjects for the key in Pony Mail.
- **Layer:** test row, once a real case exists.
- **Source:** Spec 015 review finding 16.

### G29. The 0.6 topic gate was set for self-reported confidence, not Clef
- **Where:** `placement` (`packages/reference-pipeline/src/digest/classify.ts`).
- **Why:** on the first Dev dry run, Clef's renormalised topic probability
  had a median of 0.61; 119 of 276 non-routine threads had a non-`other`
  best topic below 0.6 and went to `other` (Uncategorized since slice 2c).
  Some are right (a flaky test at kraft 0.30 is noise); others are not.
- **Interim (slice 2d):** the gate is 0.35, chosen from the second Dev dry
  run's confidence deciles (Uncategorized 99 of 316 instead of 168).
- **Fix:** set the Clef gate from the D34 golden-set labels.
- **Layer:** test row in `digest -- eval`, once labels exist.
- **Source:** Spec 014 slice 2c, first Dev dry run 2026-10-08.

### G31. Reply chunks repeat the thread title at title weight
- **Where:** `chunkTerms` and `assembleGroup` (`packages/search/src/lexical-search.ts`).
- **Why:** every message of a mail thread is a chunk with the thread title
  at weight 4, and a group adds 0.25 of each further matching chunk. On
  golden v2 the four-message "4.4.0 Release Manager" thread ranks first for
  `RequestManager` and `request manager`, above records that hold both
  words (Spec 016 Results).
- **Fix:** decide in Spec 016 slice 4 (open question 6): count the title
  once per thread, lower the further-chunk weight, a proximity signal, or
  rerank. Each needs its own measurement.
- **Layer:** test row (golden v2 already fails on it).
- **Source:** Spec 016 slice 1 evaluation, 2026-10-10.

### G32. Search identifier patterns are written twice
- **Where:** `packages/reference-pipeline/src/search/profiles.ts` (the
  source both the publisher and the Pages reader import) and
  `identifierProfiles` in
  `packages/search/test/fixtures/golden-queries.v2.json`.
- **Why:** `packages/search` cannot import `reference-pipeline`, so golden v2
  keeps its own copy; `search-profiles.test.ts` fails when they differ.
  `proposal.keyPattern` and `issueKeyPattern` (Spec 014) describe the same
  Kafka identifiers a third time, without a capture group (Spec 016 open
  question 5 keeps them separate).
- **Fix:** if a third consumer appears, move the profile data below
  `packages/search` in the dependency order and let the fixture import it.
- **Layer:** test (equality) today; structure (one module) if it moves.
- **Source:** Spec 016 slices 1 and 2a.

### G33. Hybrid evaluation numbers come from a hand-written fake embedder
- **Where:** `packages/search/test/support/fake-embedder.ts`,
  `golden-evaluation.v2.json` configuration "hybrid … + fake semantic".
- **Why:** slice 1 calls no model. The fake maps `txn`, `交易` and
  `transaction` to one concept by hand, so its hybrid row shows that fusion
  and fallback work, not how `@cf/baai/bge-m3` ranks.
- **Fix:** Spec 016 slice 4 (H33) replaces the row with recorded real-model
  vectors; delete the concept table then.
- **Layer:** test.
- **Source:** Spec 016 slice 1.

### G34. `SEARCH_LEXICAL_REVISION` is a rollout flag with two live code paths
- **Where:** `resolveSearchLexicalRevision`
  (`apps/data-publisher-worker/src/pipeline.ts`), `releaseLexicalConfig`
  (`apps/web/functions/_shared/search-projection.ts`), the `H39` test in
  `apps/data-publisher-worker/test/pipeline.test.ts`.
- **Why:** slice 2a ships the `bm25-reference@2` writer off so no deployed
  reader meets a revision it rejects. Dev sets the variable since the switch
  (H42); Prod does not. Until both write `@2`, the publisher and the reader
  keep the `@1` path, and `H39` pins Dev to `@2` and Prod to unset.
- **Fix:** set the variable for Prod in its own PR before a release tag.
  Once Prod writes `@2` and no `@1` release is needed for rollback, make `@2`
  the default, delete the variable, and keep `@1` only as a read path.
- **Layer:** test (H39) now; structure (one default) at the end.
- **Source:** Spec 016 slice 2a.

### G35. A second local Pages server only to serve an `@2` Search release
- **Where:** `playwright.lexical2.config.ts`, `apps/web/e2e-lexical2/`,
  the `lexical2` half of `apps/web/scripts/prepare-e2e-r2.ts`.
- **Why:** one bucket has one Search `current.json`, and the default local E2E
  must keep proving `@1` while Prod serves it, so the `@2` cases get their own
  bucket state and port (8789). `e2e:prepare` takes about 20 s longer.
- **Fix:** when `@2` is the default (G34), seed the one E2E bucket with golden
  v2 at `@2`, move the cases into `apps/web/e2e/`, and delete the second
  config.
- **Layer:** test.
- **Source:** Spec 016 slice 2a.

### G36. The size growth of `@2` is measured on 4% of the Dev corpus
- **Where:** `apps/web/scripts/measure-search-revisions.ts`, Spec 016
  "Results (slice 2a)".
- **Why:** the largest recorded Feed snapshot in the repository has 353
  chunks and no dev@ or Jira record. The Dev `@1` baseline is recorded in the
  spec (8,586 chunks, 17.5 MB of shards, `terms.json` 493 KB); the `@2`
  values exist only after the first publication following the switch.
- **Fix:** read `/health` `lastRun.search` on Dev once it reports
  `bm25-reference@2`, add the values and the growth to the spec's Results,
  and delete this item.
- **Layer:** measurement.
- **Source:** Spec 016 slice 2a.

### G40. `SEARCH_EMBEDDING` is a rollout flag; embedding is built but off
- **Where:** `searchEmbeddingConfig`
  (`apps/data-publisher-worker/src/search-embedding/runner.ts`),
  `searchEmbeddingTrigger` (`src/index.ts`), the `H45` configuration test in
  `test/search-embedding-runner.test.ts`, `wrangler.development.jsonc`
  (binding, object, and gateway id without the flag).
- **Why:** slice 2b ships the embedding run without a real Workers AI or
  Vectorize call ever having been made, so the first one happens on Dev by a
  one-line change (H52), after a dry run. Until then a Durable Object class
  and a Vectorize binding are deployed and unused.
- **Fix:** Spec 016 H52 sets the variable for Dev and updates the H45 test.
  When slice 3 reads the vectors and Prod has its own index and gateway,
  decide whether the flag stays as the profile selector or becomes a default.
- **Layer:** test (H45) now.
- **Source:** Spec 016 slice 2b.

### G41. Embedding bounds and the fake index rest on documentation, not measurement
- **Where:** `DEFAULT_EMBEDDING_LIMITS`
  (`apps/data-publisher-worker/src/search-embedding/run.ts`): 50 texts and
  20,000 estimated tokens per call; `VECTOR_LIMITS` and `FakeVectorIndex`
  (`packages/semantic-vectorize/src/`); the response shape in
  `embeddingVectors`; the token estimate (`estimateTokens`, 4 characters per
  token) and the copied price (G19).
- **Why:** no test may call Cloudflare. The batch size `@cf/baai/bge-m3`
  accepts, its error texts, the real token counts, and how long a mutation
  takes to become queryable are unknown until H52; the fake index enforces
  the limits as documented on 2026-10-10 and will drift when they change.
- **Fix:** after H52, write the observed values into Spec 016 Results, tune
  the bounds, and correct the fake where Dev disagreed. Record the ratio of
  the gateway's reported tokens to the estimate (the estimate may undercount
  by up to about 2×; the daily cap of 2,500 allows for that). A batch that
  fails in three runs in a row is quarantined for a day and shows in
  `/health` `lastRun.quarantined` and `lastError`.
- **Layer:** measurement (H52), then test (the fake).
- **Source:** Spec 016 slice 2b.

### G42. No reader can find a release's chunk for a stored vector yet
- **Where:** `SemanticReleaseView`
  (`packages/semantic-vectorize/src/release-view.ts`); the only
  implementation is `createInMemoryReleaseView`, used by tests.
- **Why:** the retriever answers a match with the release's own chunk
  (Spec 016 Behavior 22), but a release has no record → shard lookup; the
  lexical reader finds shards by term. Slice 2b stops at the interface.
- **Fix:** Spec 016 slice 3 implements the view over R2 (open question 9:
  shard ranges in the manifest, or a per-release side object) and wires the
  retriever into `/api/search`. Do not copy the in-memory view into Pages.
- **Layer:** structure (the manifest or side object), then test.
- **Source:** Spec 016 slice 2b.

### G43. The digest surfaces model error text unredacted
- **Where:** `errorShape` and `ModelCalls`
  (`apps/data-publisher-worker/src/digest/model.ts`), `DigestRunResult`
  `modelErrors` and `error` (`src/digest/run.ts`), served by the public
  `/health` `digest.lastRun`.
- **Why:** `errorShape` cuts a message to 200 characters and redacts
  nothing, so a bearer token or key echoed by Workers AI or the gateway would
  be published. Spec 016 slice 2b redacts in the embedding path only
  (`src/search-embedding/sanitize.ts`) and replaces the message `errorShape`
  returns, because changing the digest was out of that PR's scope.
- **Fix:** route the digest's error texts through `sanitizeErrorMessage`
  (move it beside `errorShape`), then drop the local replacement in
  `search-embedding/run.ts`.
- **Layer:** structure (one function every surfaced error passes), then test.
- **Source:** PR #50 verifier, second verdict.

## CI evidence

### G30. The evidence redaction gate does not decode every encoding
- **Where:** `scripts/verify/redact-artifacts.ts` (the "Redact the Access
  token from the evidence" step before the deployed E2E upload).
- **Why:** it rewrites plain copies of the Cloudflare Access token (also
  inside zips and the HTML report's embedded zip) and blocks the upload on
  base64/base64url copies, but does not detect gzip, hex, `\u`-escaped JSON,
  UTF-16, a value split across lines, or a reversed value. Playwright writes
  none of these for header values today (traces are zipped NDJSON, the report
  an embedded zip, `error-context.md` plain text), so the risk is theoretical
  until a reporter or trace format changes.
- **Fix:** if Playwright's output format changes, add the new encoding to
  `findSecrets` with a row in `scripts/test/redact-artifacts.test.ts`; or stop
  uploading evidence from runs that carry the token.
- **Layer:** test (`scripts/test/access-leak.test.ts` fails if real Playwright
  output keeps the value after redaction).
- **Source:** [PR #42 verifier, round 2](https://github.com/unknowntpo/oss-knowledge-base/pull/42#issuecomment-6056529926).

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

### G37. Search detail responses are re-fetched every 30 s
- **Where:** `apps/web/functions/api/search-detail/[ref].ts` answers a 200
  with the default `public, max-age=30, stale-while-revalidate=120` (Spec 003
  R7).
- **Why:** the objects behind a `detailRef` never change, but the handler
  shapes the body (`reason.label`, `highlightedRecordIds`, new `FeedDetail`
  fields), so `immutable` would pin old shapes in browsers for a year. The
  handler asked for `immutable` until PR #47; it never took effect.
- **Fix:** make the response a pure function of the ref (for example a
  shaping version in the ref or the URL), then pass `immutable` again.
- **Layer:** test (the R7 row for this endpoint).
- **Source:** [PR #47](https://github.com/unknowntpo/oss-knowledge-base/pull/47).
