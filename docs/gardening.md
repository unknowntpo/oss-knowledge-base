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

### G38. `.topic-grid` is defined twice
- **Where:** `apps/web/styles.css`: the detail page's
  `.topic-grid { grid-template-columns: minmax(0, 1fr) 268px }` and its
  `max-width: 900px` override, then the Spec 014 block's
  `.topic-grid { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)) }`
  for the This week topic cards. The later rule wins everywhere.
- **Why:** the detail page (`FeedDetailView.vue`) gets two equal columns at
  1280 px instead of a timeline and a 268 px rail, and its one-column layout
  below 900 px works only because 300 px happens to fit. Found while fixing
  Spec 001 A13; not changed there (desktop layout was out of scope).
- **Fix:** rename one of the two classes; decide which detail layout is meant.
- **Layer:** test (detail E2E asserting the rail width at 1280 px).
- **Source:** this PR (Spec 001 A13).

### G39. The E2E suite runs Chromium only
- **Where:** `playwright.config.ts` (both projects use `browserName:
  "chromium"`; "mobile-chromium" is an iPhone 13 viewport, not WebKit), CI
  installs only Chromium.
- **Why:** layout bugs reported from iOS Safari (Spec 001 A13) are reproduced
  and verified in a different engine. Line breaking differs between engines:
  Chromium breaks a URL after `?` and `/`, so a URL that overflows in Safari
  can fit in the test.
- **Fix:** a WebKit project for the layout specs (`long-text.spec.ts`,
  `stall-visibility.spec.ts`).
- **Layer:** test.
- **Source:** this PR (Spec 001 A13).

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
- **Progress (Spec 022):** review rows classify with `isReviewBot` (GitHub's
  `Bot` type, the `[bot]` suffix, the project's machine users). That is a
  third copy of the rule; fold the three into one when the publisher's is
  fixed.

### G9. No R2 retention or garbage collection
- **Where:** `public/v2/releases/*`, `public/v2/objects/details/*`,
  `public/search/v1/releases/*` in every bucket.
- **Why:** every run (one a day since Spec 018, plus follow-ups and manual
  runs) adds a release and new pool objects; nothing is
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
  (H42), and sets `bm25-reference@3` since Spec 017 N17; Prod does not set
  it. Until both write `@2` or later, the publisher and the reader keep the
  `@1` path, and `H39` pins Dev to `@3` and Prod to unset.
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

### G40. `SEARCH_EMBEDDING` is a rollout flag; on for Dev, off for Prod
- **Where:** `searchEmbeddingConfig`
  (`apps/data-publisher-worker/src/search-embedding/runner.ts`),
  `searchEmbeddingTrigger` (`src/index.ts`), the `H45` configuration test in
  `test/search-embedding-runner.test.ts`, `wrangler.development.jsonc`
  (binding, object, gateway id, and since 2026-10-12 the flag).
- **Why:** slice 2b shipped the embedding run without a real Workers AI or
  Vectorize call ever having been made, so the first one happens on Dev by a
  one-line change (H52), after a dry run. Dev sets `bge-m3@1` since
  2026-10-12; nothing reads the vectors before slice 3, and Prod has no
  index, gateway, or flag.
- **Fix:** record the H52 observations in Spec 016 Results. When slice 3
  reads the vectors and Prod has its own index and gateway, decide whether
  the flag stays as the profile selector or becomes a default.
- **Layer:** test (H45: Dev `bge-m3@1`, Prod unset) and the deployed E2E
  (`enabled`, no `configError`).
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
  the bounds, and correct the fake where Dev disagreed. The ratio of the gateway's
  reported cost to the estimate is recorded: 1.78 on the 2026-10-12
  backfill, applied as `EMBEDDING_TOKEN_CALIBRATION` since Spec 016
  slice 3. A batch that
  fails in three runs in a row is quarantined for a day and shows in
  `/health` `lastRun.quarantined` and `lastError`.
- **Layer:** measurement (H52), then test (the fake).
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

### G44. Record-kind tags are indexed as words
- **Where:** `chunkTerms` (`packages/search/src/lexical-search.ts`) indexes
  every tag at weight 2; the Feed tags each GitHub pull request `Pull
  Request` and each Jira issue `Jira`.
- **Why:** on the Dev release of 2026-10-12 `request` is in 6,962 of 8,700
  chunks and `pull` in 6,759, so both words carry almost no score and a
  query such as `request manager` is decided by `manager` alone. The phrase
  bonus of Spec 017 compensates for adjacent words only.
- **Fix:** index a kind tag as one token (or not at all) and filter by it
  through `filters.tags`. It changes postings, so it needs a lexical revision
  and its own measurement on the real-corpus snapshot.
- **Layer:** test row (`real-corpus.cases.ts`).
- **Source:** Spec 017 Evidence.

### G45. `bm25-reference@3` is a third revision behind the rollout flag, and its limits
- **Where:** `threadPhraseLexicalSearchConfig`, `assembleGroup`, and
  `phraseBonus` (`packages/search/src/lexical-search.ts`); G34 lists the flag
  and its tests.
- **Why:** Dev writes `@3` since Spec 017 N17 (it replaced G31: every reply
  of a mail thread repeats the title at weight 4, and `@1`/`@2` add a flat
  quarter of each further chunk). Prod writes `@1`. Until no environment
  needs an `@1` or `@2` release, the search package keeps their flat thread
  sum next to the geometric one. Known limits of `@3` (Spec 017 Results,
  guard rows): without adjacency in query order only the thread bound helps,
  so `manager request` still returns the long thread first; a pair of two
  common words (`consumer group`) earns the bonus like a rare one.
- **Fix:** when no environment needs an `@2` release for rollback, delete the
  flat sum with `@2` (G34). For the limits: G44 first (it removes most of the
  `request` noise), then measure an unordered or windowed proximity signal on
  the guard rows.
- **Layer:** test (H39, `real-corpus-guards.cases.ts`) now; structure (one
  ranking) at the end.
- **Source:** Spec 017.

### G46. The real-corpus evaluation is one day's release with implementer labels
- **Where:** `packages/search/test/fixtures/real-corpus-snapshot.v1.json`,
  `packages/search/test/real-corpus.cases.ts`, the snapshot digests in
  `lexical-revision-3.test.ts` (N7).
- **Why:** the snapshot is the Dev release of 2026-10-12 (1,134 of 8,700
  chunks). 20 of its 21 queries are labelled by the implementer from titles.
  It was captured by reading the Dev R2 bucket with a local wrangler login,
  which was not authorised (Spec 017 Provenance). The public API cannot give
  the release statistics a snapshot needs (total chunk length, document
  frequencies), so new queries with new words cannot be scored: three
  verifier-requested rows are listed unscored in Spec 017 Results. Refreshing
  also needs the two `@2` digests recomputed at e9984d0.
- **Fix:** have the owner confirm or correct the labels. Decide how a
  snapshot may be taken: an authorised export, or a public read-only endpoint
  for a release's term statistics. Then refresh (`bun run --cwd
  packages/search real-corpus -- --release <dir> --write`) and score the
  unscored rows; drop the snapshot digests once `@2` is deleted (G45).
- **Layer:** test rows (owner-confirmed labels).
- **Source:** Spec 017.

### G71. `GITHUB_REVIEWS` is on for Dev only, and RV25 is not yet recorded
- **Where:** `apps/data-publisher-worker/wrangler.development.jsonc`
  (`metadata@1` since 2026-10-14, Spec 022 decision 3); unset in
  `wrangler.production.jsonc`.
- **Why:** until the Dev dry run, the first and the second real run are
  seen, the Dev token's GraphQL access and the conditional month write
  (`onlyIf.etagMatches`) are unproven in the runtime.
- **Fix:** follow the spec's enabling steps and record RV25. Delete this
  entry when RV25 is recorded and the flag is on wherever the publisher
  runs (Prod's data Worker is not deployed, Spec 018).
- **Layer:** owner decision, then deploy evidence.
- **Source:** Spec 022, 2026-10-14.

### G72. Review ingestion: the 12-month backfill is built but not run; hindsight stays bounded
- **Where:** `apps/data-publisher-worker/src/github-reviews/run.ts`
  (`runGithubReviewsBackfill`, `REVIEW_WINDOW_MS`, `listUpdated`).
- **Why:** until the backfill (Spec 022 Behavior 13, decision 5: 12 months
  from 2025-10-14) has been run on Dev, coverage starts one day before the
  first run (`coverageFrom`). After it: a review dismissed more than 35 days
  after it was submitted keeps its stored verdict; a pull request with more
  than 100 reviews is read partially (`reviewsTruncated`); a deleted review
  keeps its row; nothing prunes months (Behavior 14, about 8 MB a year).
  (Fixed: both runs now page the listing by key, so GitHub's 422 for deep
  offsets, seen at page 15 on 2026-10-14, cannot stop the daily run after a
  day of more than about 1,000 updated issues; RV9.)
- **Fix:** run the backfill by the runbook ("GitHub review ingestion
  (Spec 022)", "Backfill") and record RV35 with
  `bun run measure:github-reviews -- --backfill-from 2025-10-14`; pruning
  only when a reader needs it. GitHub's native `after`/`before` cursors
  are a later option for the listing.
- **Layer:** operator run, then measured evidence.
- **Source:** Spec 022 "Known limits" and Behavior 13–14, 2026-10-14.

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

### G47. Hybrid search is three rollout flags and a binding, all set on Dev
- **Where:** Pages `SEARCH_SEMANTIC` and the `SEARCH_QUERY_GATE` binding
  (`apps/web/functions/_shared/semantic-gate.ts`), Worker
  `SEARCH_SHARD_ROOTS` (`apps/data-publisher-worker/src/pipeline.ts`) and
  the `SearchQueryGate` class. All set and bound on Dev since 2026-10-13,
  none on Prod.
- **Why:** Spec 016 slice 3 shipped the code with nothing enabled and Dev
  was enabled by two configuration PRs.
- **Fix:** after slice 4, write shard roots always (delete
  `SEARCH_SHARD_ROOTS` and its off path) and fold `SEARCH_SEMANTIC` into
  the presence of the binding, or keep one flag and say why.
- **Layer:** structure (fewer flags), then test (the `H66` pins).
- **Source:** Spec 016 slice 3.

### G48. Query-time latency and platform behaviour are estimates
- **Where:** Spec 016 Results (slice 3) "Design in numbers"; open
  question 18.
- **Why:** no Workers AI, Vectorize, or deployed Durable Object call was
  made while building the slice: the time of a single-text embedding, of an
  index query, of the round trip to the gate object, and whether the object
  finishes an embedding after the reader timed out are assumed. Vectorize
  billing is taken from its pricing page.
- **Fix:** at the enable, run `bun run measure:search-hybrid`, read
  `/health` `searchQuery`, and replace the estimates with the measurements
  (H31, H32); move the timeout or the caps if they do not fit.
- **Layer:** measurement, then the constants.
- **Source:** Spec 016 slice 3.

### G49. The Worker's entry module may export only handlers and classes
- **Where:** `apps/data-publisher-worker/src/index.ts`; guarded by `H69: the
  Worker's entry module exports only handlers…` in
  `search-query-gate.test.ts`.
- **Why:** workerd refuses to start a Worker whose entry module exports a
  constant, and `wrangler deploy --dry-run` does not notice. A string
  constant exported there during slice 3 would have stopped the Dev Worker;
  only a local `wrangler dev` run showed it.
- **Fix:** keep helpers that tests import out of the entry module (move
  `mergeHealth`, `cronTarget`, `digestModel`, `searchEmbeddingTrigger` to
  their own modules), and run the Worker once under local `wrangler dev` in
  CI.
- **Layer:** test today; structure and a CI step when fixed.
- **Source:** Spec 016 slice 3.

### G50. `SemanticReleaseView` has only an in-memory implementation, by design
- **Where:** `packages/semantic-vectorize/src/release-view.ts`,
  `VectorizeSemanticRetriever`.
- **Why:** the Pages reader resolves semantic matches inside its one pass
  over the shards (Spec 016 Decision 26) and shares the retriever's two
  steps, not the retriever. The view and the retriever remain for the
  `SemanticRetriever` contract tests and offline evaluation. Formerly G42.
- **Fix:** if no other reader needs them after slice 4, delete the
  retriever and the view and keep `proposeSemanticMatches` and
  `acceptSemanticMatch`.
- **Layer:** structure.
- **Source:** Spec 016 slice 3.

### G51. The daily neuron budget rests on two single measurements (headroom 1,500)
- **Where:** `DAILY_NEURON_BUDGET`, `DIGEST_NEURON_CALIBRATION` (1.28) and
  `EMBEDDING_TOKEN_CALIBRATION` (1.8) in
  `packages/reference-pipeline/src/digest/estimate.ts`.
- **Why:** each ratio was measured once (2026-10-08 and 2026-10-12). Since
  Spec 014 slice 2e (2026-10-14) the digest's ledger applies its factor and
  its cap is 5,000, so the caps are 8,500 of the 10,000 included. The Dev
  digest cron was set without a second measurement.
- **Fix:** measure the digest's ratio on the staged dry run (runbook,
  "Topic digest": gateway cost over `estimatedNeurons`, expected 0.8–1.2)
  and the embedding ratio from `osskb-search-dev`; change the constants if
  either is outside.
- **Layer:** measurement, then the constants and the `H67` test.
- **Source:** verifier of PR #54.

### G52. The feature map is checked for names, not for truth
- **Where:** `scripts/test/feature-map.test.ts`, `docs/feature-map.md`.
- **Why:** the test fails when a Pages or Worker route, a deployed variable
  or binding, a verification command, or a spec's newest acceptance ID is
  not named in the map. It cannot tell whether the sentence around the name
  is still right: the map said Dev was behind Access and that nothing read
  the vectors long after both were false.
- **Fix:** keep stating environment facts in the one "Deployed
  configuration" table and derive it from the wrangler files, so only prose
  can drift.
- **Layer:** test today; generation when fixed.
- **Source:** owner's instruction of 2026-10-13.

### G53. The deployed E2E and the measurement spend the visitors' query budget
- **Where:** `apps/web/deployed-e2e/development.spec.ts` (`H32`, and the
  older tests' `Kafka Streams` and `request manager`),
  `apps/web/scripts/measure-search-hybrid.ts`.
- **Why:** on Dev every text query, a test's included, goes through the
  query gate. The E2E uses three fixed strings, so it costs at most 6 index
  queries a deploy and no model call once cached; one measurement run costs
  at most 48 model calls and 96 index queries. Both come out of the same
  1,000 a day and 100 model calls an hour that visitors use, and the E2E's
  status check is deliberately lenient (`timed-out`, `over-budget`, and one
  `failed` do not fail it).
- **Fix:** if the budget ever matters, give tests their own allowance in
  the gate; if leniency hides a real regression, add a threshold to the
  E2E from what `measure:search-hybrid` shows on Dev.
- **Layer:** test.
- **Source:** Spec 016 enable step 3.

### G54. Fusion `rrf-group@2` cannot tell an adjacent word pair from a scattered one
- **Where:** `packages/search/src/fusion.ts` (`isFullLexicalMatch`),
  `apps/web/test/search-fusion-replay.test.ts` (the reversed guard queries).
- **Why:** the rule keeps the leading lexical threads that hold every query
  word in one passage, and engages only when the first lexical thread does.
  A one-word query with any lexical hit is therefore lexical-first
  (semantic threads appended), and a query whose first lexical thread
  misses a word gets no protection: on the verifier's 20 clean queries
  `rrf-group@2` tied `rrf-group@1` on 19, and three lexical-right queries
  stay worse than lexical-only under both (`LogManager cleanup` 1, 3, 2, 4
  → 23, 3, 1, 6; `StreamsPartitionAssignor` 2, 8, 1 → 26, 7, 6;
  `deduplicate strings when spilling` 4, 1 → 1, 21). For `manager request` and `storage tiered` those
  threads hold the words apart, lexical search ranks them without its
  phrase bonus, and `rrf-group@1` had ranked the expected threads higher
  (1, 4, 8, 6, 9 against 7, 9, 12, 10, 13). The response and the replay
  fixture do not say whether a thread earned the phrase bonus.
- **Fix:** expose that evidence to fusion and to the fixture, then compare
  "kept only when the pair is adjacent" on the replay before changing the
  rule (Spec 016 open question 26).
- **Layer:** test today (the trade is pinned); structure when fixed.
- **Source:** Spec 016 fusion, 2026-10-13.

### G55. The replay cannot see past 50 results
- **Where:** `apps/web/scripts/capture-search-replay.ts`,
  `apps/web/scripts/eval-search-similarity.ts` (`backgroundOf`).
- **Why:** `/api/search` returns at most 50 threads, so semantic candidates
  below them have no recorded rank or similarity and are placeholders in
  the replay. The threshold question this entry first recorded is answered
  (Spec 016 Decision 43: no usable floor). What remains: alternatives that
  admit unseen candidates are approximate, and the background of
  `rrf-group@3` is an upper bound in the few queries whose 20th semantic
  thread was not shown.
- **Fix:** none needed while the 20th thread is shown; a capture endpoint
  would be a contract change and is not proposed.
- **Layer:** measurement.
- **Source:** Spec 016 fusion, 2026-10-13.

### G56. The owner's query is no better under hybrid search than under lexical search
- **Where:** `apps/web/test/search-fusion-replay.test.ts` (the owner's row).
- **Why:** `consumer network thread request manager` ranks its threads 2,
  21, 9 lexically and 3, 39, 24 under either fusion revision: no passage
  holds its five words, and two of the three threads are not semantic
  candidates at all.
- **Fix:** none known that keeps the vocabulary-gap gains; candidates are
  the threshold (G55) and a reranker (Spec 016 H33).
- **Layer:** test (pinned as a known limitation).
- **Source:** Spec 016 fusion, 2026-10-13.

### G57. A record is embedded as its title and a 280-character excerpt
- **Where:** `packages/search/src/semantic.ts` (`title-text@1`), the
  publisher's record `excerpt`.
- **Why:** the owner's query `consumer network thread request manager`
  expects three threads whose stored text never says `network thread`; two
  of them are not among the 100 semantic candidates and the third is 28th.
  No fusion rule can rank a thread retrieval did not return (Spec 016
  Results, "The owner's query and the embedding text").
- **Priority:** the next lever for Search quality (Spec 016 Decision 50);
  fusion tuning has stopped.
- **Fix:** a follow-up spec for the embedding text (`title-text@2`): what
  is embedded per record, measured on a capture before any re-embedding
  (about $0.08 and three days of the job's cap for text five times longer).
- **Layer:** measurement, then data.
- **Source:** Spec 016 fusion `rrf-group@3`, 2026-10-13.

### G58. Fusion `rrf-group@3` rests on three constants fitted on few rows
- **Where:** `packages/search/src/fusion.ts` (`lexicalHeadFusionConfig`:
  head 3, reference 20, margin 0.04).
- **Why:** chosen on 76 labelled rows and 112 hand labels; a head of 2 and
  a margin of 0.03 are indistinguishable on them. Two of the verifier's
  lexical-right queries are still worse than lexical-only at their bound
  (`LogManager cleanup` 3, 4, 1, 7; `ListingTable partition pruning` 6, 1,
  3, 2, 5), and on ten clean queries the rule changed one rank.
- **Decision (2026-10-13, Spec 016 Decision 50):** stays off; Dev remains
  on `rrf-group@2`. The verifier's 15 fresh queries: better than
  `rrf-group@2` on 1, worse on 2, same on 11. The rule protects lexical
  ranks 1 to 3 whether or not they are relevant, so it lifts irrelevant
  head threads too (`consumer close hangs forever` 7, 4, 3, 2 → 9, 6, 5,
  2). The constants are on a plateau (head 2 to 3, reference 20 to 30,
  margin 0.02 to 0.04); the benefit on new queries is about zero.
- **Fix:** none in fusion: tuning stops here. Re-evaluate after G57 (the
  embedding text), because richer vectors change what stands out; delete
  the revision if it still shows no gain then.
- **Layer:** test today (the limits are pinned).
- **Source:** Spec 016 fusion `rrf-group@3`, 2026-10-13.

### G59. A reused object still costs one R2 request per run
- **Where:** `apps/data-publisher-worker/src/r2-destination.ts`
  (`putVerifiedImmutableIfAbsent`), `packages/serving-contract/src/publication-set.ts`
  (`promoteVerified`).
- **Why:** since the Class A incident of 2026-10-13 (Spec 008 C8) an
  existing object costs one `head` (Class B) instead of a failed conditional
  put (Class A). That is still about 8,150 requests an hour on Dev: 6.0 of
  the 10 million Class B a month, and 8,225 of the run's 20,000 subrequests.
  Both grow with the corpus; a second environment of the same size leaves
  the included Class B ($0.36 per further million).
- **Fix:** own spec. Skip the request for a key the previous successful
  release already lists (its publication-set evidence, or the Search
  manifest's `objectDigests` and the Feed detail map): 0 requests for a
  reused object, about 80 a run. To decide there: a previous run that failed
  midway (its evidence was never written, so its objects are simply checked
  again), a pointer rolled back to an older release, objects deleted by a
  future retention job (G9: a skipped key that was deleted publishes a
  release with a missing detail, so retention and this list must agree), an
  evidence object of an older layout, and the memory of holding 8,000 keys
  (Spec 009).
- **Layer:** test (`C8` bounds Class A today; add the Class B bound) plus
  measurement (`/health` `lastRun.r2`).
- **Source:** Spec 008 "R2 operations", 2026-10-13.

### G60. Jobs that write R2 objects whose content did not change
- **Where:** `apps/data-publisher-worker/src/digest/run.ts` (the pointer is
  put again when the pair is reused; one `list` a run, also on a dry run),
  `apps/data-publisher-worker/src/review-queue/run.ts` (the object embeds
  `generatedAt`, so every run writes a new object, the pointer, and
  `last-run.json`).
- **Why:** 2–4 Class A operations a run each. The digest runs once a day
  on Dev since 2026-10-14 (about 120 Class A a month, 0.012% of the
  included million; the unchanged pointer is put again only when a manual
  run reuses a pair). The review queue runs only by hand
  (`REVIEW_QUEUE_CRON` is unset); an
  hourly cron would add about 5,000 Class A a month, 0.5% of the included
  million. Spec 014 D26 counts the `list` among "R2 reads" and D60 says a
  dry run makes "0 R2 writes": the `list` is a Class A operation.
- **Fix:** before either job runs more often than daily: skip the pointer
  put when its bytes are unchanged (as the publisher's `switchPointer`
  does), and correct D26 and D60.
- **Layer:** test.
- **Source:** R2 call audit, 2026-10-13.

### G70. The digest runs daily on Dev with two D35 checks open
- **Where:** Spec 014 D35 and "Schedule on Dev"; `DIGEST_CRON` in
  `apps/data-publisher-worker/wrangler.development.jsonc`.
- **Why:** the owner enabled the schedule on 2026-10-14. D35's canary probe
  (four Clef requests of about 4,000 state tokens that must all miss) has
  no recorded result, and whether the gateway's 60 requests an hour is a
  fixed or a sliding window is unknown. A `limited` or failed scheduled
  run shows only in `/health` `digest.lastRun` until the digest is 36 h
  old (the page's stale rule); `bun run verify:health` does not print the
  digest (D32 says it does).
- **Fix:** run the probe once and record it in Spec 014; add the digest's
  age and `lastRun.ok`/`limited` to `verify:health`.
- **Layer:** measurement (the probe); verification kit (`verify:health`).
- **Source:** Spec 014 slice 2e, 2026-10-14.

### G61. The Feed count line is hard-coded English, beside unused count strings
- **Where:** `apps/web/src/views/FeedView.vue` (`.results-count` without a
  query renders `${visibleEntries.length} entries` in both locales);
  `apps/web/i18n.js` keeps `results.related`, `results.hits`,
  `results.filtered`, `results.all`, which no component reads.
- **Why:** a zh-Hant reader sees "12 entries"; the unused keys look like
  the strings to edit. The search count line was moved to `results.search.*`
  on 2026-10-13 (Spec 005 S18); the Feed's was left as it was.
- **Fix:** render the Feed count from `results.all` / `results.filtered`
  (plain text, no `<strong>`), delete the keys still unused.
- **Layer:** test (a unit row per locale, as S18 has).
- **Source:** search result cards change, 2026-10-13.

### G62. The review queue's hourly decision and its 2 h check predate the daily publication
- **Where:** `docs/specs/015-review-queue/spec.md` (Decision 6 "Hourly", crons
  `27 * * * *` / `57 * * * *`, "stale after `STALE_AFTER_MS` (3 h)");
  `REVIEW_QUEUE_MAX_AGE_MS = 2 h` in `scripts/verify/args.ts`; ADR-0016.
- **Why:** Spec 018 made the publication daily. The review queue is not
  scheduled, so nothing is wrong today, but enabling it as specified would
  run it hourly against a Feed release up to a day old, and its page would
  inherit a 27 h stale rule it was not designed for.
- **Fix:** the owner decides the cadence (Spec 018, open decision 1); then
  the spec, the cron, the 2 h check and the page's stale rule follow.
- **Layer:** spec decision, then a config test like Spec 018 T2.
- **Source:** Spec 018, 2026-10-13.

### G63. The Confluence ingest is manual only and the deployed site does not read it
- **Where:** `.github/workflows/ingest.yml` (manual), `tools/ingest/`,
  `vault/`, branch `automation/confluence-ingest`, issue #12;
  `.github/workflows/backfill.yml` (manual).
- **Why:** nothing under `apps/` or `packages/` reads its output; only the
  legacy `viewer/` does. A manual run force-pushes an automation branch and
  edits an issue when a KIP page changed.
- **Fix:** decided 2026-10-14 (owner; Spec 018, open decision 2): manual
  only, the daily `schedule` is removed. Left: remove it with the legacy
  viewer, or reuse it when KIP bodies go into search (a separate spec).
- **Layer:** owner decision.
- **Source:** Spec 018 inventory, 2026-10-13; updated 2026-10-14.

### G64. Specs and ADRs written under the hourly publication still say "hourly"
- **Where:** Specs 008, 009, 012, 013, 014, 015, 016, 017, ADR-0013,
  ADR-0014, ADR-0016: phrases such as "hourly run", "the next hourly
  publication", "minute 7"; the helper `hourly` and "6 days of hourly runs"
  in `apps/data-publisher-worker/test/search-embedding-run.test.ts`
  (H56) and the comment in `publication-parity.test.ts`.
- **Why:** Spec 018 put a dated note at the top of each affected spec and
  rewrote only the sentences an operator acts on; the rest is history of the
  measurements. For the embedding tests "hourly" is still right: it is the
  continuation's pace (Spec 016 Behavior 46).
- **Fix:** rewrite a passage when its spec is next edited; do not copy the
  hourly wording into new text.
- **Layer:** rule (this entry).
- **Source:** Spec 018, 2026-10-13.

### G65. A retry run republishes everything to retry one source
- **Where:** `planFollowUp` in `apps/data-publisher-worker/src/run-schedule.ts`.
- **Why:** when one source fails and the others succeed, the retry (10, 30,
  60 minutes later) is a whole publication: every source is polled again and
  a new release is written. Simple and bounded (3 per trigger), but it
  spends R2 writes to retry one request.
- **Fix:** only if the cost shows: poll the failed source alone and skip the
  publication when it fails again.
- **Layer:** measurement (`copiedObjectCount` of retry runs on Dev).
- **Source:** Spec 018 simplification review, 2026-10-13.

### G66. After a follow-up or manual release, an overdue daily run shows late
- **Where:** `apps/web/src/freshness.ts` (`OVERDUE_AFTER_MS`),
  `apps/data-publisher-worker/src/pipeline.ts` (`generatedAt` =
  `materializedAt`); `/health` `lastRun.ok`, `lastRun.sources`, `followUp`.
- **Why:** Spec 021 shows "Daily feed late" from 24 h 30 min after the
  release the page has (issue #64). A release from a catch-up, retry or
  `POST /run` carries that run's time, not the Cron tick's, so the next
  day's missed run is shown later by that offset (up to 2 h 55 min after the
  last retry; more after a manual run), at worst only by the stale pill. A
  run that published while one source failed, and a waiting retry, are
  still visible only in `/health`. The deployed E2E runs only on deploys,
  so CI does not notice a missed daily run either.
- **Fix:** put the Cron tick's time (or the next expected run) in the Feed
  manifest, which is written anyway (no extra R2 write), and count from it;
  a manifest contract change, so the owner decides. Consider a scheduled
  check of `/health`.
- **Layer:** spec (manifest contract), then the Spec 021 case file.
- **Source:** independent verifier of PR #62, Spec 018 "Known limits";
  Spec 021 "Known limits".

### G67. The feature-map site parses a subset of Markdown with its own parser
- **Where:** `scripts/feature-map-site/markdown.ts` (headings, pipe tables,
  lists, fenced code, quotes, paragraphs; inline code, bold, links).
- **Why:** no dependency, so the workflow needs no `bun install`. Anything
  else (images, HTML, nested emphasis, tables without a leading pipe,
  reference links) is shown as text, and a list item's nested block is
  flattened. `docs/feature-map.md` and `docs/gardening.md` use none of these
  today.
- **Fix:** keep the sources inside the subset; replace the parser with a
  library only if they outgrow it.
- **Layer:** test (`B7` rows in `scripts/test/feature-map-site.test.ts`).
- **Source:** Spec 020 simplification review, 2026-10-14.

### G68. Spec 018's monthly Class A estimate used an hourly run's size
- **Where:** `docs/specs/018-daily-publication/spec.md` (Decision rationale,
  "about 1.2 thousand Class A" a month; "about 40 Class A" in the schedule
  inventory and Known limit 3).
- **Why:** a daily run writes a day's new objects, not an hour's: the first
  daily run on Dev (2026-10-13 22:07 UTC) sent 391 Class A (388 new objects
  + 3), so a month is about 12 thousand, ten times the estimate and still
  1.2% of the included million. One run; the weekday pattern is unknown.
- **Fix:** record a week of `lastRun.r2` and correct the spec's figures; the
  runbook and the feature map already carry the measured run.
- **Layer:** measurement (`/health` `lastRun.r2`).
- **Source:** Spec 020 (found while regenerating the feature map), 2026-10-14.

### G69. The generated site lacks live Dev status and the owner's pending decisions
- **Where:** `scripts/feature-map-site/generate.ts`; Spec 020 "Proposed, not
  built".
- **Why:** neither is in the tree. The hand-made overview page had both, so
  it cannot be retired without them or a decision to drop them.
- **Fix:** `docs/decisions-pending.md` as a generated section; a client-side
  read of Dev `/health` after the Worker sends a CORS header for the site's
  origin (its own PR).
- **Layer:** spec (Spec 020 Decisions 5 and 6).
- **Source:** Spec 020 non-goals, 2026-10-14.

### G73. The profile's suppression digest uses a public, constant salt
- **Where:** `packages/reference-pipeline/src/people/index.ts`
  (`suppressionDigest`, `PEOPLE_SUPPRESSED`).
- **Why:** Spec 019 P-e asks for a salted hash so the list does not spell a
  name. A salt kept in this public repository only stops a casual reader: a
  login can be checked against the list by hashing it. The list is empty.
- **Fix:** before the first entry, keep the salt (or the list) in a Pages
  secret, or accept the limit in Spec 019 P-e.
- **Layer:** spec decision, then configuration.
- **Source:** Spec 019 slice 2a, 2026-10-15.

### G74. `measure:people` times the reader in Bun, not in workerd
- **Where:** `apps/web/scripts/measure-people.ts`.
- **Why:** sizes and R2 reads are exact, but CPU time comes from Bun's JSC.
  The workerd timing (local `wrangler pages dev`, seeded with `--dump`) is a
  manual step, and Cloudflare reports CPU per invocation only after deploy.
- **Fix:** read the Pages Function's CPU time on Dev (Workers analytics) for
  `github:chia7712` after the first deploy and record it in Spec 019 W18.
- **Layer:** measurement.
- **Source:** Spec 019 slice 2a, 2026-10-15.

### G75. A profile request parses every identity's activity rows of 12 months
- **Where:** `packages/reference-pipeline/src/people/index.ts`
  (`readActivityMonth`), format in `src/people/activity.ts`.
- **Why:** month objects are per project, so a profile parses all rows of up
  to 12 months. `measure:people` with 12 full months: DataFusion 23.2 MB
  parsed and 39 MB kept by the isolate cache (46 MB and 75 MB at 2×),
  against W18's 16 MB budget and the 128 MB isolate. The log starts with 2
  months; the budget fails when the DataFusion log is about 8 months old.
- **Fix:** before the log holds 6 months: split each month by a hash of the
  person id (a profile reads one part per month), or compact rows (drop
  `source` and derivable URLs). Re-measure with `measure:people`.
- **Layer:** measurement gate: `bun run measure:people` exits 1 when a cold
  profile parses more than 16 MiB (W18); `--months N` sets the log's age
  (8 months: DataFusion 15.7 MiB, pass; 9 months: 17.3 MiB, fail; 12, the
  default: fail); `--report-only` reports without failing. Not in CI.
- **Source:** Spec 019 slice 2b, 2026-10-15.

### G76. Jira and dev@ identities are display names
- **Where:** `activityPersonId` in `packages/reference-pipeline/src/people/activity.ts`.
- **Why:** the connectors keep only the Jira display name and the From name.
  Two people with one name share a page (the page says so); a renamed
  person splits. Slice 4 moves Jira to the account key, which changes
  `jira:` ids and URLs.
- **Fix:** slice 4: keep Jira `name`/`key` in `jira-record@1`, redirect old
  ids.
- **Layer:** data contract (connector), then spec.
- **Source:** Spec 019 slice 2b, 2026-10-15.

### G77. A Jira issue counts in the month of its last update
- **Where:** `activityMonthsFromEvents` (`src/people/activity-log.ts`); the
  Jira connector drops `fields.created`.
- **Why:** "issues reported" means "reported issues updated in the period",
  as in the Example, and an issue updated in two months is stored twice
  (counted once).
- **Fix:** keep `created` in `jira-record@1` (changes every Jira event's
  content hash; plan with the parity fixtures).
- **Layer:** data contract.
- **Source:** Spec 019 slice 2b, 2026-10-15.

### G78. Votes marked "(binding)" are not on the profile
- **Where:** Spec 019 sections 3 and 6; `mail-record@1` keeps a 200-character
  excerpt the log does not store.
- **Why:** the log is metadata only, and a vote line is in the body.
- **Fix:** reuse Spec 015's `[VOTE]` body read to add a `vote` field to dev@
  rows, or drop the item from the spec.
- **Layer:** spec decision.
- **Source:** Spec 019 slice 2b, 2026-10-15.

### G79. The log's GitHub bot rule is the connector's substring rule
- **Where:** `isBot` in `apps/github-publisher/github-connector.ts`, read by
  `activityMonthsFromEvents`.
- **Why:** a login containing "bot" is not logged even when a person owns
  it; a bot without "bot" in its login (`codecov-commenter`) is logged and
  only hidden by the reader's bot list.
- **Fix:** apply the profile's bot list (`isBotLogin`) at write time too, and
  narrow the connector rule to `[bot]` plus the list.
- **Layer:** test row (a human login containing "bot").
- **Source:** Spec 019 slice 2b, 2026-10-15.

### G80. Works with has one activity relation
- **Where:** `activityView` in `src/people/index.ts`.
- **Why:** section 7 lists "commented on their pull requests" and "same dev@
  threads"; the reader keeps only the person's rows, so only "wrote in
  threads started by" is built.
- **Fix:** derive the other relations from the month index (all identities
  are indexed already) and cap each at 10.
- **Layer:** spec (section 7) and case rows.
- **Source:** Spec 019 slice 2b, 2026-10-15.

### G81. Month summaries are written but read by nothing
- **Where:** `internal/people/v1/<projectId>/<YYYY-MM>.summary.json`.
- **Why:** they exist for slice 7 (decision 10). Review counters are not in
  them: reviews are written by Spec 022's job, not by the publication.
- **Fix:** slice 7 decides whether Spec 022's job writes a review summary or
  the list reads review months; delete the activity summary if the list
  does not use it.
- **Layer:** spec (slice 7).
- **Source:** Spec 019 slice 2b, 2026-10-15.

### G85. Person search matches GitHub logins only, and has no entry besides the search box
- **Where:** `packages/reference-pipeline/src/people/search.ts` (`peopleIndex`,
  `personQueryKey`); `apps/web/src/views/FeedView.vue`.
- **Why:** the review store holds logins, not names, so "Chia-Ping Tsai"
  finds no person until slice 2b adds Jira and dev@ identities with display
  names. The only visible entry is the search box; a 「貢獻者」 nav item and
  list are slice 7 (decision 10). Slice 2b (#76) shipped the log without
  widening the index: a display name has spaces, which `personQueryKey`
  rejects (W41), and GitHub identities with activity but no review row have
  a profile but are not in the index.
- **Fix:** 2b's follow-up adds `PersonIndexEntry` values for its sources keyed by
  display name (and widens `PersonSource`); slice 7 adds the list and its
  nav item. Neither changes `osskb.people-search.v1`.
- **Layer:** spec slices 2b and 7.
- **Source:** Spec 019 slice 3, 2026-10-15.
  Spec 019 amendment (4) stores GitHub public names (`identity.name`,
  search `name`), but the index still matches logins only.

### G86. "Own pull requests" in Areas counts only own pull requests someone reviewed
- **Where:** `apps/web/src/components/PersonAreas.vue` (`received` side),
  `packages/reference-pipeline/src/people/areas.ts` (`profileAreaSide`).
- **Why:** the side is built from `reviewsReceived`, the only own pull
  requests the review store knows. Pull requests the person opened that nobody
  reviewed are in the activity log (slice 2b) with their labels, and are shown
  in its separate "Threads in the activity log" list instead of the chart.
- **Fix:** feed the activity log's `pull-request` threads (by number) into the
  same `profileAreaSide` input, deduplicated with `reviewsReceived`; one chart
  for "own pull requests".
- **Layer:** spec (Spec 019 W48) and a case row.
- **Source:** Spec 019 amendment (4), 2026-10-15.

### G87. Stored labels and names change only when their month is written again
- **Where:** `apps/data-publisher-worker/src/github-reviews/run.ts`
  (`writeMonths`), `refresh.ts`.
- **Why:** a month's `pulls` and `people` are written with that month's rows
  (reviews of the last 35 days) or by the refresh, which only fills missing
  entries. A label set or a name cleared on GitHub after a month left the
  35-day window stays as last read; a cleared name stays in older months.
- **Fix:** a `refresh-areas?all=1` mode that re-reads every entry (bounded the
  same way), run when a name removal is requested; or prune months with
  Behavior 14.
- **Layer:** spec (Spec 022 Behavior 15) and a run test.
- **Source:** Spec 022 amendment 2026-10-15.

### G88. The area taxonomy is a hand-kept list of process labels
- **Where:** `packages/reference-pipeline/src/people/areas.ts`
  (`AREA_TAXONOMIES`).
- **Why:** a label the list does not know counts as an area, so a new path
  label shows up without a change, but a new process label (a new lifecycle
  bot, a new release label pattern) shows up as an area until someone adds it.
- **Fix:** a measurement that lists label names seen in the stored `pulls`
  entries and in each repository's labeler configuration, and fails when a
  stored label is in neither the labeler's areas nor the process list.
- **Layer:** measurement script, then a CI check.
- **Source:** Spec 019 amendment (4), 2026-10-15.

### G90. A Jira or dev@ page's data range still lists the review store
- **Where:** `apps/web/src/components/PersonProfile.vue` (`details.person-range`
  `.person-coverage`).
- **Why:** the opened "Data range" keeps W27's list, which names every source
  the community records, including "Reviews: <from> to <until>" on a Jira or
  dev@ identity that can have no review (strict identity). The collapsed line
  and the chart already show the identity's own sources only.
- **Fix:** amend W27 to list the identity's own sources (plus the
  not-recorded ones of its source), then filter the list.
- **Layer:** spec, then component test.
- **Source:** Spec 019 amendment (5), 2026-10-16.

### G91. A bucket where a source's coverage begins is drawn like a full one
- **Where:** `apps/web/src/profile-chart.ts` (`ChartBucket.partial`,
  `clipped`).
- **Why:** the month or week in which the activity log (or the period) starts
  holds only part of that bucket's activity, but its bar has the same style as
  a complete bucket; only the tooltip says "recorded since 9/10". A reader
  comparing bars can read the first bucket as a drop.
- **Fix:** if readers misread it, draw partial buckets with a lighter fill or
  a marker, from `partial` and `clipped`, with a case row.
- **Layer:** chart model and its case file.
- **Source:** Spec 019 amendment (5), 2026-10-16.

