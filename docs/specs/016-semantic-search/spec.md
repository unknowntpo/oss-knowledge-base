# Spec 016: Semantic candidates and hybrid fusion for Search

Status: Draft for human review — decisions of 2026-10-08..10 recorded below; slices 1 and 2a implemented, Dev switched to `@2` (H42), slices 2b–4 pending
Date: 2026-10-10
Traceability: enforced
Builds on: Spec 005 (Phases 2 and 3, LLM boundary), Spec 013 (lexical shards, `bm25-reference@1`), Spec 014 (community profile `proposal`), Spec 015 (profile blocks, ADR-0016)

## Intent

A reader types what they remember: an identifier without its hyphen, a bare
number, a class-name fragment, an abbreviation, or a question in Chinese.
Search today answers only when the query's tokens are spelled exactly as in the
evidence.

Requirements (human, 2026-10-08..10):

- **R1 Exact identifiers.** `KAFKA-13412`, `KIP-770`, and `KIP770` (no hyphen)
  are treated the same as the hyphenated form. A bare number such as `770`
  lists all matching identifiers (KIP-770, KAFKA-770, PR #770); it does not
  pick one.
- **R2 Term queries.** `txn`, `request manager`, and `RequestManager` find the
  related threads. Abbreviations match full words without a hard-coded synonym
  table. Chinese queries (for example 「交易逾時」) find English content.
- **R3 "Ask AI" answer with citations.** Out of scope here; a later spec.

Outcome: Search ranks lexical (BM25) and semantic (embedding) candidates
fused with reciprocal-rank fusion, keeps exact identifiers first, and answers
with lexical results alone whenever semantic retrieval is disabled or fails
(Spec 005). This spec implements Spec 005 Phase 2 and Phase 3 without graph
expansion.

## Evidence

Dev, `GET https://oss-knowledge-base-dev.pages.dev/api/search?q=…&limit=8`,
2026-10-10 ~05:30 UTC, release `feed-2026-10-10T05-07-12-000Z`,
`bm25-reference@1`:

| Query | Result |
| --- | --- |
| `RequestManager` | 0 results |
| `KIP770` | 0 results |
| `交易逾時` | 0 results |
| `770` | 2 results: the PR "KAFKA-13152: Add input.buffer.max.bytes based on KIP-770", and KAFKA-19890 (an attachment named `…-36-47-770.png`) |
| `txn` | 2 results, both spelling `txn`; `transaction timeout` returns 8 others |
| `consumer network thread request manager` | 1st "4.4.0 Release Manager" (dev@, 5 evidence matches); 6th KAFKA-19804 "Improve heartbeat request manager initial HB interval"; KAFKA-20765 and KAFKA-19738 are not in the first 8 |

Causes:

- `HeartbeatRequestManager` is one token, so `request` and `manager` do not
  match it, and `RequestManager` matches nothing.
- `KIP770` is one token; `KIP-770` is indexed as `kip-770`, `kip`, `770`.
- A GitHub pull request's number is in its record id, not in its title.
- No token of `交易逾時` or `txn` occurs in a thread that says "transaction".

Corpus size, from `GET /api/feed` on the same release (sum of
`entry.recordIds` lengths): 8,577 records in 4,051 groups (DataFusion 6,383
records, Kafka 2,194). The Search materializer makes one chunk part per record
(`parts: [{ key: "excerpt", … }]`) and excerpts are clipped far below the
180-word window, so the release holds about 8,577 chunks. The exact value is
`chunkCount` in the Search manifest, which is not publicly readable; since
slice 2a the publisher reports it at `/health` `lastRun.search.chunkCount`
(H41).

## Example

Golden v2 (`packages/search/test/fixtures/golden-queries.v2.json`) holds the 10
chunks and 8 queries of golden v1 unchanged, 15 hand-written records, and 8
new queries. The new records copy titles from the Dev release above where one
exists; bodies are shortened. `provenance.syntheticRecordIds` lists every
hand-written record.

The human labelled one query on 2026-10-09:

| Query | Expected, in order (grade 2) | Acceptable (grade 1) | Must not rank in the top 3 |
| --- | --- | --- | --- |
| `consumer network thread request manager` | KAFKA-19804, KAFKA-20765, KAFKA-19738 | KAFKA-20397 | dev@ "4.4.0 Release Manager" |

`bun run eval:search` on that query:

| Configuration | Top 5 | Recall@20 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- |
| `bm25-reference@1` | KAFKA-19804, KAFKA-19919, Release Manager, KAFKA-20397, KIP-405 | 1.0 | 1.0 | 0.7981 |
| `bm25-reference@2` | KAFKA-19919, KAFKA-19804, KAFKA-19738, Release Manager, KAFKA-20765 | 1.0 | 0.5 | 0.7162 |

KAFKA-20765 is the record `kafka:github:pull:22747` (its pull request): the
fixture keeps one group per key, while Dev has the Jira issue and the pull
request as separate groups.

At `@2` the Release Manager thread leaves the top 3 and KAFKA-19738
(`OffsetsRequestManager`) enters it. KAFKA-19919 ("Network Threads Blocked…",
unjudged) moves to rank 1, because splitting class names raises the document
frequency of `request` and `manager`, and KAFKA-20765 (`CommitRequestManager`
only in the body) is 5th. The expected order is not reached by lexical search;
see Results.

## Decisions (human, 2026-10-08..10)

1. **Hybrid.** Lexical (the existing BM25) plus a semantic retriever, fused
   with RRF (k = 60) under a versioned fusion revision. Lexical-only fallback
   whenever semantic retrieval fails or is disabled (Spec 005).
2. **Embedding unit: the chunk**, the same chunks lexical search indexes, so
   results merge by thread and can cite the passage.
3. **Model: multilingual `@cf/baai/bge-m3`** (1,024 dimensions) on Workers AI
   at publish time and at query time. The same model on both sides; the model
   and its revision are recorded with the vectors; a model change invalidates
   all vectors.
4. **Store: Cloudflare Vectorize** is the first implementation, behind a
   replaceable `SemanticRetriever` interface (Spec 005 forbids making a managed
   vector database the public contract). One namespace per project.
5. **Reranking (Clef) is not part of this spec.** It is added only if
   golden-query measurement shows correct answers land in the top 20 but rank
   low. Spec 005's phase order stands: semantic → fusion → rerank.
6. **Generic and community-specific rules.** Generic code-text normalization
   (splitting camelCase `RequestManager` into `request`, `manager` while
   keeping the original token) is allowed in core. Community identifier
   patterns (KIP-n, KAFKA-n) belong in the community profile, not hard-coded in
   core search.

## Simplification review

1. **Question every requirement.**
   - Code-text tokens: owned by R2 (`RequestManager`, `request manager`).
   - Identifier patterns: owned by R1. Regular expressions rather than a
     prefix list, because one family needs several spellings and a GitHub
     number is only in the record id.
   - `SemanticRetriever`, RRF, fallback: owned by decisions 1 and 4.
   - Metrics and the runner: owned by decision 5 (rerank is decided from
     measurements) and Spec 005 "Quality and evaluation".
   - `retrieval.semantic` status: owned by Observability; without it a
     permanent fallback is invisible.
2. **Delete.**
   - No synonym or abbreviation table (R2 forbids it).
   - No letter–digit split (`KIP770` → `kip`, `770`): it would also split
     `sha256`, `utf8`, `log4j`; the profile handles identifiers instead.
   - No snake_case split: not required by R2.
   - No graph expansion (Spec 005 Phase 3 lists it; nothing here needs it).
   - No second lexical ranking formula: `@2` keeps the `@1` BM25 and weights.
   - No raw-score blending: fusion reads ranks only (Spec 005).
   - No stored vectors, Vectorize code, or model call in slice 1.
3. **Simplify.** One revision string selects the tokenizer; profiles are
   plain data (`kind`, `canonicalPrefix`, two optional patterns); fusion is
   one pure function; passthrough is the same function with no semantic
   candidates.
4. **Shorten the cycle.** `bun run eval:search` runs three configurations on
   golden v2 in under a second and rewrites one JSON report that a test
   compares with a fresh run.
5. **Automate last.** No new CI job; the comparison runs in the unit tests.

## Behavior

Lexical revision `bm25-reference@2` (slice 1):

1. **Revisions.** `bm25-reference@1` is unchanged and remains
   `DEFAULT_LEXICAL_REVISION`: the publisher writes it unless told otherwise
   (rule 13). `bm25-reference@2` uses the `@1` formula, weights, and group
   assembly with the tokens of rules 2 and 3. Postings and chunk lengths
   differ, so a release is one revision or the other. Readers accept both
   since slice 2a (rule 12).
2. **Code-text tokens.** In addition to the `@1` tokens, a word with a case
   boundary is also indexed and queried as its parts, lower-cased, after the
   token it comes from. Boundaries: lower-case letter or digit before an
   upper-case letter; and inside an upper-case run before its last letter when
   a lower-case letter follows (`HTTPServer` → `http`, `server`). A
   single-letter part stays with its neighbour, so case splitting adds no
   one-letter term.
   Index and query use the same tokenizer.
3. **Identifier profiles.** A lexical config may carry, per project, a list
   of `IdentifierPatternV1 { kind, canonicalPrefix, textPattern?,
   recordIdPattern? }`. Patterns are regular-expression sources with one
   capture group, the number; `textPattern` is matched case-insensitively.
   A match whose group is absent, empty, or not digits is not an identifier.
   A pattern with a quantified group that holds a quantifier (`(\d+)+`) is
   rejected. Profiles are valid only with `bm25-reference@2`.
   - Index: every identifier a title's `textPattern` or the record id's
     `recordIdPattern` yields is added to the chunk's title tokens in canonical
     form (`canonicalPrefix` + number, lower-cased, plus its tokens), unless
     already present.
   - Query: every spelling a `textPattern` recognizes is rewritten to the
     canonical form before tokenizing, so `KIP770`, `kip770`, and `KIP-770`
     are one query.
   - A query that is exactly one canonical identifier is an exact match for
     chunks whose title tokens hold it.
   - A query that is only digits is an exact match for every chunk holding
     any of its own project's identifiers with that number.
   - Exact matches keep the `@1` boost and rank first; among them BM25 decides.
   - Core search contains no community literal. The patterns live in the
     community search profiles (rule 12); the golden fixture holds a copy that
     a test keeps equal.

Semantic retrieval and fusion (slice 1: interface, fusion, in-memory
retriever; slices 2–3: model and store):

4. **`SemanticRetriever`.** `retrieve({ query, filters?, limit, signal? }) →
   { semanticRevision, candidates[] }`; candidates are chunks (`chunkId`,
   `recordId`, `groupRootRecordId`, `projectId`, `score`), best first. The
   retriever applies the filters. Nothing outside an adapter depends on a
   vector store's API.
5. **Embedding unit.** One vector per `SourceRecordChunkV1`, of the text
   `title + "\n" + text` (`title-text@1`).
6. **Revision.** `SemanticRevisionV1 { model, modelRevision, dimensions,
   textAssemblyRevision }` is recorded with the vectors and returned as
   `semanticRevision`. Vectors of different revisions are never compared; a
   change to any field re-embeds every chunk.
7. **Grouping.** A thread takes the rank of its best semantic chunk and keeps
   up to 5 of its chunks as citable passages.
8. **Fusion `rrf-group@1`.** `score(thread) = Σ 1 / (60 + rank)` over the
   lexical and semantic thread rankings. Order: lexical exact matches first,
   then score, then lexical rank, then group root id. The function is pure.
9. **Fallback.** With no retriever (`disabled`), a retriever that throws or
   returns a malformed answer (`failed`), or one slower than the timeout
   (`timed-out`, default 1,000 ms, and the request is aborted), the lexical
   results pass through in lexical order. `retrieval.semantic` carries the
   state; only `ok` has a `semanticRevision`. A semantic candidate outside the
   project filter or the eligible groups is dropped before fusion.

Evaluation (slice 1):

10. **Metrics.** Grades: 2 expected, 1 acceptable, unjudged 0. Recall@20 is
    the share of grade 2 threads in the first 20; MRR is 1 / rank of the first
    grade 2 thread; nDCG@10 uses gain `2^grade − 1` and discount
    `log2(rank + 1)`. Aggregates are arithmetic means, rounded to 4 decimals.
11. **Golden v2 and the runner.** Each query has `requires: lexical |
    semantic`, graded judgments, hard negatives with `negativeWithin`,
    `requiredWithin`, and optionally `ordered`. A query passes when every
    grade 2 thread ranks within `requiredWithin`, no negative ranks within
    `negativeWithin`, and required evidence is shown. A `semantic` query that
    fails on a lexical-only configuration is `semantic-required`, not `fail`.
    `ordered` is reported, not gated. `bun run eval:search` evaluates
    `bm25-reference@1`, `bm25-reference@2` with the fixture's profiles, and
    `@2` fused with a fake semantic retriever; it prints a table and writes
    `packages/search/test/fixtures/golden-evaluation.v2.json`. The fake
    retriever maps a few surface forms to concepts by hand: its numbers show
    that fusion, fallback, and reporting work, not the quality of `bge-m3`.

Serving `bm25-reference@2` (slice 2a):

12. **Search profiles and the reader.**
    `packages/reference-pipeline/src/search/profiles.ts` holds one
    `SearchProfile { projectId, identifiers }` per project: Kafka has `kip`
    (`KIP-`), `jira` (`KAFKA-`), and `github-number` (`#`); DataFusion has
    `github-number`. The module is data with one type import, exported as
    `@oss-knowledge-base/reference-pipeline/search-profiles`; the publisher
    and the Pages reader both import it. A release's lexical config is
    `lexicalSearchConfigFor(revision, profiles)`: `@1` ignores the profiles,
    `@2` applies them, any other revision throws. The reader reads the
    manifest's `lexicalRevision`, selects shards with
    `lexicalQueryTerms(query, config)`, and scores with the same config, for
    v3 and for whole-release (v1/v2) layouts. A release of any other revision
    is not answered: HTTP 503, and nothing after the manifest is read.
    `SearchResponseV1` is unchanged; `retrieval.lexicalRevision` names the
    revision served.
13. **Publisher flag.** The Worker variable `SEARCH_LEXICAL_REVISION` selects
    the revision a run writes: unset or blank writes `bm25-reference@1`,
    byte-identical to before; `bm25-reference@2` writes `@2` postings, chunk
    lengths, and term statistics with the search profiles and stamps the
    manifest. Any other value fails the run before a source is polled or an
    object written, and `/health` shows the error. Slice 2a set the variable
    in neither deployed configuration; since the switch (H42) the development
    configuration sets `bm25-reference@2` and production still sets none. A successful run records
    `lastRun.search { lexicalRevision, chunkCount, shardCount, shardBytes,
    largestShardBytes, termsBytes }` from the manifest and object sizes of the
    release it wrote.

## Community profile fit

Checked: `packages/reference-pipeline/src/digest/profiles.ts` (Spec 014,
`DigestProfile.proposal { keyPattern, issueKeyPattern }`) and
`review-queue/governance.ts` (Spec 015, `ReviewProfile`, ASF preset).

- The mechanism fits: one TypeScript profile object per project and concern
  (`KAFKA_DIGEST_PROFILE`, `KAFKA_REVIEW_PROFILE`), regular-expression sources
  as strings, no rule language. Slice 2a adds `KAFKA_SEARCH_PROFILE` and
  `DATAFUSION_SEARCH_PROFILE` the same way (Behavior 12).
- The existing fields do not fit as they are: `proposal.keyPattern`
  (`\bKIP-\d+\b`) requires the hyphen and has no capture group, and nothing
  describes a GitHub number.
- `packages/search` cannot import the profile (`reference-pipeline` depends on
  `serving-contract`, which depends on `search`), so the type lives in
  `packages/search` and the values are passed in: the Worker passes them to
  `searchProjectionObjects`, the reader to `lexicalSearchConfigFor`.

Decided in slice 2a (implementer, to confirm):

- **Location.** A profile module inside `reference-pipeline`, next to the
  digest and review profiles, with its own package export so the Pages bundle
  takes the data and nothing else. A new package was not needed.
- **Open question 5.** `proposal.keyPattern` and `issueKeyPattern` (Spec 014)
  stay separate: they have no capture group and answer "does this text name a
  proposal", not "which spellings are one identifier". One test keeps the
  search profile's project ids equal to the digest profiles'.
- **Space and leading zero.** `KIP 770` is not normalized: with a space
  allowed, the title "Apache Kafka 4.2.0" would index `KAFKA-4`. `KIP-0770`
  stays a different identifier from `KIP-770`. Both have a test.
- **Linear time.** Each pattern handles 50,000-character adversarial input in
  under 500 ms in a test over the real profiles; validation still rejects only
  the obvious nested quantifier.

## Slices

1. **This PR.** Evaluation harness (golden v2, metrics, runner), lexical
   `bm25-reference@2` (code-text tokens, identifier profiles), fusion core
   (`SemanticRetriever`, `rrf-group@1`, fallback, in-memory retriever). No
   cloud resource, deploy configuration, model call, or deployed behavior
   change.
2. **`bm25-reference@2` on Dev, then embeddings.**
   - **2a (this PR).** Search profiles (H26); the reader answers `@1` and
     `@2` (H25, H34, H37); the publisher can write `@2` behind
     `SEARCH_LEXICAL_REVISION`, off in both deployed configurations (H35,
     H36, H38, H39); `/health` `lastRun.search` (H41); size measurement (H40).
     No model call, Vectorize, binding, or new cloud resource. Dev serves
     `@1` after the merge.
   - **Switch (done).** `wrangler.development.jsonc` sets the variable, so
     Dev writes `@2` from the first run after that deploy (H42). Production
     is unchanged.
   - **2b.** Publisher embedding step and Vectorize adapter. H21–H24, H27.
3. **Query-time wiring** in the web API behind a flag. H28–H32.
4. **Measured comparison** with the real model and the decision on rerank.
   H33.

Each slice removes the `[pending]` tags of the IDs it implements.

## Contract changes and rollout

Slice 1 changes no stored object and no response:

- `DEFAULT_LEXICAL_REVISION` is still `bm25-reference@1`; `@1` postings of
  the golden v2 corpus are byte-identical to `origin/main` 899283f (H10).
- New exports of `packages/search`: `CODE_TEXT_LEXICAL_REVISION`,
  `codeTextLexicalSearchConfig`, `lexicalTokenizer`, `lexicalQueryTerms`,
  `LexicalSearchConfigV1.identifiers`, `IdentifierPatternV1`,
  `SemanticRetriever` and its types, `createInMemorySemanticRetriever`,
  `fuseRankings`, `hybridSearch`, the metrics, golden v2, and the runner.

Slice 2a changes, all additive:

- `packages/search`: `SUPPORTED_LEXICAL_REVISIONS`, `lexicalSearchConfigFor`.
- `packages/serving-contract`: `searchProjectionObjects` and
  `buildR2SearchProjection` take `identifiers`, and the former
  `lexicalRevision`; without them the objects are byte-identical (the
  recorded publication parity still holds for every object, pointer, and
  evidence record). `SearchReleaseManifestV3.lexicalRevision` may now be
  `bm25-reference@2`; the manifest, shard, and terms schemas are unchanged.
- `packages/reference-pipeline`: the `./search-profiles` export.
- Publisher `/health`: `lastRun.search` on a successful run.
- `SearchResponseV1`: unchanged.

Rolling out `bm25-reference@2` changes the stored index. Pages and the Worker
deploy from one CI job, Pages first, and the Worker's Cron (`7 * * * *`) can
run at any time, so the order is enforced by a flag, not by timing
(Spec 013 Behavior 7 gives the pattern):

1. **Slice 2a merges.** Pages read `@1` and `@2`. The Worker can write `@2`
   but `SEARCH_LEXICAL_REVISION` is unset, so every run still writes `@1`.
   Nothing a reader sees changes; `/health` gains `lastRun.search`.
2. **Switch (H42), done for Dev.** With the slice 2a deploy and its deployed
   E2E green on `main`,
   `apps/data-publisher-worker/wrangler.development.jsonc` sets
   `"SEARCH_LEXICAL_REVISION": "bm25-reference@2"` and H39 pins Dev to `@2`
   and Prod to unset. Dev serves `@1` until the first run after that deploy
   switches `current.json`. Production gets the same one-line change in its
   own PR, before a release tag.
   Every commit that sets the variable also contains the dual reader and CI
   deploys Pages before the Worker, so no deployed reader meets a revision it
   rejects. Each run writes a complete release, so the next hourly run
   republishes every shard at `@2`; no backfill.
3. **Turning `@2` off.** Remove the variable (revert the switch PR). The next
   run writes an `@1` release and moves `current.json`; the reader serves the
   `@2` release until then and `@1` after. Releases are immutable and
   content-addressed, so nothing is deleted and no Cron pause is needed.
   `POST /run` shortens the wait.
4. **Rolling Pages back below slice 2a.** A pre-2a reader answers every
   `/api/search` query with HTTP 503 ("unsupported lexical revision") while
   the current release is `@2`; Feed, detail, and `detailRef` hydration do
   not read the revision and keep working. So first do step 3 and wait for
   `/health` `lastRun.search.lexicalRevision` to read `bm25-reference@1` (or
   pause the Cron and restore a retained `@1` `current.json`, per the
   publisher runbook), then roll Pages back.
5. **A wrong value** of the variable publishes nothing: the run fails before
   polling, both pointers stay, `/health` names the value.
6. A profile pattern is part of the index: a change takes effect with the
   next release, and until then affected identifier queries lose their exact
   match but still return lexical results. Reader and publisher take the
   patterns from one module at one commit.

Slices 2–3 add to `SearchResponseV1.retrieval` the fields Spec 005 already
names (`semanticRevision`, `fusionRevision`) plus `semantic`, and to each
match `signals.semanticRank`.

## Test plan

Generated by `bun run docs:test-plan`. Edit the case files, not these tables.

Code-text tokens (`bm25-reference@2`), from
`packages/search/test/code-tokens.cases.ts`:

<!-- test-plan:start packages/search/test/code-tokens.cases.ts -->
| id | case | input | tokens |
| --- | --- | --- | --- |
| H1 | PascalCase class name | HeartbeatRequestManager | heartbeatrequestmanager heartbeat request manager |
| H1 | camelCase method name | checkInflightPoll | checkinflightpoll check inflight poll |
| H1 | two-word fragment | RequestManager | requestmanager request manager |
| H1 | acronym before a word | HTTPServer | httpserver http server |
| H1 | one leading capital stays with its word | KRaftMetadataCache | kraftmetadatacache kraft metadata cache |
| H1 | one trailing capital stays with its word | getX | getx |
| H1 | plural acronym is one word | IDs | ids |
| H1 | shortest split: two letters each side | abCd | abcd ab cd |
| H1 | one letter each side is not split | aB | ab |
| H1 | digits stay with the word before them | Log4jAppender | log4jappender log4j appender |
| H1 | upper-case constant is not split | STALE_MEMBER_EPOCH | stale_member_epoch |
| H1 | capitalized word is not split | Manager | manager |
| H1 | dotted symbol keeps its @1 tokens first | RecordAccumulator.ready() | recordaccumulator.ready() recordaccumulator ready record accumulator |
| H1 | hyphenated identifier is unchanged | KAFKA-20983 | kafka-20983 kafka 20983 |
| H1 | letters followed by digits are not split | KIP770 | kip770 |
| H1 | text without case is unchanged | 交易逾時 | 交易逾時 |
<!-- test-plan:end -->

Identifiers, from `packages/search/test/identifiers.cases.ts`. Each row
searches golden v2 with `bm25-reference@2` and the fixture's profiles; `exact`
lists the exact matches in rank order, and they rank before every other
result:

<!-- test-plan:start packages/search/test/identifiers.cases.ts -->
| id | case | query | projects | exact |
| --- | --- | --- | --- | --- |
| H3 | canonical spelling | KIP-770 | — | kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss |
| H3 | no hyphen | KIP770 | — | kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss |
| H3 | lower case, no hyphen | kip770 | — | kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss |
| H3 | lower case with hyphen | kip-770 | — | kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss |
| H3 | second family, no hyphen | KAFKA13152 | — | kafka:github:pull:22458 |
| H3 | same number, other family | KAFKA-770 | — | kafka:jira:issue:KAFKA-770 |
| H3 | a shorter number is another identifier | KIP-77 | — |  |
| H3 | a longer number is another identifier | KIP-7700 | — |  |
| H3 | number sign names a GitHub record | #770 | — | datafusion:github:pull:770 |
| H4 | bare number lists every family | 770 | — | datafusion:github:pull:770 kafka:jira:issue:KAFKA-770 kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss |
| H4 | bare number across projects | 20983 | apache-datafusion apache-kafka | datafusion:github:issue:20983 kafka:github:issue:20983 |
| H4 | bare number within one project | 770 | apache-datafusion | datafusion:github:pull:770 |
| H4 | a shorter bare number matches nothing | 77 | — |  |
| H4 | a number that is no identifier | 405000 | — |  |
<!-- test-plan:end -->

Reader at both revisions (slice 2a), from
`apps/web/test/search-lexical-revisions.cases.ts`. Each row publishes golden
v2 as a search-release.v3 at `revision` (2 chunks per shard, `@2` with the
search profiles) and searches it through the Pages reader; the result must
also equal the whole-corpus index of that revision. The rows without a
project filter at `@2` run again in the browser (`apps/web/e2e-lexical2`):

<!-- test-plan:start apps/web/test/search-lexical-revisions.cases.ts -->
| id | case | revision | query | projects | exact | includes | results |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H34 | identifier without its hyphen | bm25-reference@2 | KIP770 | — | kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss | — | 7 |
| H34 | canonical identifier | bm25-reference@2 | KIP-770 | — | kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss | — | 7 |
| H34 | bare number lists every kind | bm25-reference@2 | 770 | — | datafusion:github:pull:770 kafka:jira:issue:KAFKA-770 kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss | — | 4 |
| H34 | bare number within one project | bm25-reference@2 | 770 | apache-datafusion | datafusion:github:pull:770 | — | 1 |
| H34 | number sign names a GitHub record | bm25-reference@2 | #770 | — | datafusion:github:pull:770 | — | 4 |
| H34 | class-name fragment | bm25-reference@2 | RequestManager | — | — | kafka:jira:issue:KAFKA-19804 kafka:github:pull:22747 kafka:jira:issue:KAFKA-19738 | 8 |
| H34 | the fragment as two words | bm25-reference@2 | request manager | — | — | kafka:jira:issue:KAFKA-19804 kafka:github:pull:22747 kafka:jira:issue:KAFKA-19738 | 8 |
| H34 | a golden v1 identifier is unchanged | bm25-reference@2 | KIP-405 | — | kafka:wiki:kip-405 | — | 5 |
| H25 | no hyphen finds nothing at @1 | bm25-reference@1 | KIP770 | — | — | — | 0 |
| H25 | canonical identifier at @1 | bm25-reference@1 | KIP-770 | — | kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss | — | 6 |
| H25 | bare number is an ordinary term at @1 | bm25-reference@1 | 770 | — | — | kafka:jira:issue:KAFKA-770 | 3 |
| H25 | class-name fragment finds nothing at @1 | bm25-reference@1 | RequestManager | — | — | — | 0 |
| H25 | two words at @1 miss the class names | bm25-reference@1 | request manager | — | — | kafka:jira:issue:KAFKA-19804 kafka:github:pull:22747 | 7 |
<!-- test-plan:end -->

## Acceptance

Items tagged `[pending]` belong to the `@2` switch and slices 2b–4.

### Behavior
- H1: given each row of the code-text token plan, the `@2` tokenizer returns
  exactly the listed tokens, and a query yields the same tokens as a document
  → evidence: `code-tokens.test.ts` rows.
- H2: given golden v2, `RequestManager` and `request manager` return
  KAFKA-19804, KAFKA-20765, and KAFKA-19738 at `@2` (`RequestManager` returns
  nothing at `@1`); for the human-labelled query the Release Manager thread is
  3rd at `@1` and 4th at `@2`; lexical Recall@20 over the lexical queries is
  1.0 at `@2` and no query that passes at `@1` fails at `@2` → evidence:
  `code-tokens.test.ts`, `golden-v2.test.ts`.
- H3: given each `H3` row of the identifier plan, the listed threads are the
  exact matches; `KIP770`, `kip770`, and `kip-770` return exactly the results
  of `KIP-770`; a spelling inside a longer query is rewritten; a title written
  `kip770` is found by `KIP-770` → evidence: `identifiers.test.ts`.
- H4: given each `H4` row, a bare number lists every identifier with that
  number across families and projects, and none for a shorter number; without
  a profile it is an ordinary term → evidence: `identifiers.test.ts`.
- H5: given chunks and an injected `embed`, the in-memory retriever returns
  chunk candidates by cosine similarity, best first, with its
  `semanticRevision`, applies the filters and the limit → evidence:
  `fusion.test.ts`.
- H6: given a lexical and a semantic ranking, `fuseRankings` returns each
  thread once with score `Σ 1 / (60 + rank)`, its ranks, its lexical result,
  and up to `maxSemanticMatches` passages; equal scores follow lexical rank,
  then id; the same input gives the same output → evidence: hand-computed
  cases in `fusion.test.ts`.
- H7: given an exact lexical match and another thread with a higher fused
  score, the exact match stays first; `KIP770` under hybrid search with a
  retriever that prefers every other thread still returns its two exact
  matches first → evidence: `fusion.test.ts`.
- H8: given hand-computed rankings, Recall@K, MRR, and nDCG@K return the
  computed values, including cutoffs and zero or negative grades → evidence:
  `metrics.test.ts`.
- H9: given golden v2, the fixture holds golden v1 unchanged and declares
  every other record synthetic; one query is graded on required rank,
  negatives, evidence, and order; the runner's report equals the committed
  `golden-evaluation.v2.json` and a second run → evidence:
  `golden-v2.test.ts`.
- H18: given golden v2 in shards of 1, 2, 3, and 1,000 chunks with `@2`
  postings, `rankLexicalShard` returns the in-memory `@2` results → evidence:
  `code-tokens.test.ts`.

### Failure and retry
- H10: given this change, `bm25-reference@1` is still the default, its
  tokens and the digest of its postings are unchanged, and the 7 Phase 1
  golden v1 queries keep their grades at `@1` and at `@2` → evidence:
  `code-tokens.test.ts`, the existing Spec 005 and 013 tests.
- H11: given no semantic retriever, `hybridSearch` returns the lexical
  results in lexical order with `semantic: disabled`, for every golden v2 query
  → evidence: `fusion.test.ts`.
- H12: given a retriever that rejects, throws, returns a malformed answer, or
  embeds with the wrong dimension, the lexical results pass through with
  `semantic: failed` and the error → evidence: `fusion.test.ts`.
- H13: given a retriever slower than `timeoutMs`, the lexical results pass
  through with `semantic: timed-out` and the request's signal is aborted; a
  retriever answering in time is used → evidence: `fusion.test.ts`.
- H14: given a project filter or eligible groups, semantic candidates outside
  them are dropped before fusion; the retriever receives the query, filters,
  and depth → evidence: `fusion.test.ts`.
- H15: given identifier profiles with `bm25-reference@1`, or a pattern with
  no pattern, no or two capture groups, an invalid expression, a nested
  quantifier, or an empty prefix or kind, building an index or postings fails;
  a match whose number group is absent, empty, or not digits yields no
  identifier and leaves the query unchanged; every fixture pattern handles
  50,000-character adversarial input in under 500 ms → evidence:
  `identifiers.test.ts`.
- H16: given a golden v2 file with a judgment on a missing or non-root
  record, a thread graded twice, a grade outside 1–2, no grade 2 thread, too
  small a `requiredWithin`, an unknown `requires`, an undeclared synthetic
  record, misplaced evidence, or an invalid profile, parsing fails → evidence:
  `golden-v2.test.ts`.
- H17: given a `semantic` query that fails on a lexical-only configuration,
  its status is `semantic-required` and it is not counted as `fail`; the same
  failure with a semantic retriever is `fail`; the three `semantic` queries
  pass with the fake retriever → evidence: `golden-v2.test.ts`.
- H19: given a lexical ranking that repeats a thread, a thread in two
  projects, a non-positive `k`, an empty revision, or an invalid limit, depth,
  or timeout, fusion fails instead of returning a ranking → evidence:
  `fusion.test.ts`.
- H20: given a metric cutoff that is not a positive integer, no expected
  item, or a ranking that repeats an id, the metric fails → evidence:
  `metrics.test.ts`.
- H21: [pending] given a publisher run, every chunk without a vector of the
  current `SemanticRevisionV1` is embedded with `@cf/baai/bge-m3` and upserted
  into its project's namespace under its chunk id with the revision; a chunk
  whose content hash is unchanged is not embedded again; a removed chunk's
  vector is deleted.
- H22: [pending] given a change of model, model revision, dimensions, or text
  assembly, every chunk is embedded again and a query never compares vectors
  of two revisions.
- H23: [pending] given a Workers AI or Vectorize failure during a run, the
  lexical release still publishes, the previous vectors stay queryable, and
  `/health` shows the embedding step's failure.
- H37: given a release whose manifest declares any other revision
  (`bm25-reference@3`, `bm25:v1`), in the v3 or the whole-release layout, the
  reader throws, reads no terms object or shard, and `/api/search` answers
  HTTP 503 naming the revision, `no-store` (Spec 003 R7) so the error is not
  replayed after the switch; the same objects answer once they declare a
  supported one; `lexicalSearchConfigFor` throws for an unknown revision →
  evidence: `search-lexical-revisions.test.ts`, `code-tokens.test.ts`.
- H38: given `SEARCH_LEXICAL_REVISION` set to an unsupported value, the run
  fails before a source is polled or an object written (its last phase
  marker is `reading-state`, never `polling`), both pointers stay,
  `/health` `lastRun.error` names the value, and a later run with a supported
  value publishes; the Worker passes its variable to the run;
  `searchProjectionObjects` and `buildR2SearchProjection` refuse an unknown
  revision before the first object → evidence: `pipeline.test.ts`,
  `durable-object-state.test.ts`, `search-shards.test.ts`.
- H39: given the deployed publisher configurations, development sets
  `SEARCH_LEXICAL_REVISION` to `bm25-reference@2` and production does not set
  it, so only Dev writes `@2` → evidence: `pipeline.test.ts`. (Slice 2a
  shipped with neither set.)
- H29: [pending] given a query-embedding failure, timeout, or quota error,
  `/api/search` returns HTTP 200 with lexical results and `retrieval.semantic`
  set to the state.

### Behavior (slice 2a)
- H25: given golden v2 published at `@1` and at `@2`, the reader answers each
  release with its own tokens: every `H25` row of the reader plan holds;
  switching `current.json` `@1` → `@2` → `@1` in one bucket answers each time
  and every earlier `detailRef` still resolves; an `@1` release is
  byte-identical with or without profiles and a query is not rewritten; a
  whole-release layout of an `@2` index answers like its shards; the local
  `@1` E2E bucket still serves `@1` → evidence:
  `search-lexical-revisions.test.ts`, `feed-detail.spec.ts`, and the unchanged
  Spec 005 and 013 reader tests.
- H26: given the search profiles, every published project has one keyed by
  its project id; Kafka names KIP, Jira, and GitHub numbers and DataFusion
  GitHub numbers; a comment's record id and a mail message name none; a space
  is not a spelling; the profiles equal golden v2's, pass the lexical config
  validation, and stay under 500 ms on 50,000-character adversarial input;
  `packages/search/src`, `packages/serving-contract/src`, and
  `apps/web/functions` hold no community literal outside comments →
  evidence: `search-profiles.test.ts`.
- H34: given each `H34` row of the reader plan, `/api/search` over an `@2`
  release returns the listed exact matches first, the listed threads, and the
  listed number of results, equal to the whole-corpus `@2` index, reading only
  the shards that hold a term of `lexicalQueryTerms`; the response keeps the
  `osskb.search-response.v1` fields; in the browser the same queries show that
  many cards, the exact badge on the exact matches only, and open a detail →
  evidence: `search-lexical-revisions.test.ts`,
  `apps/web/e2e-lexical2/search.spec.ts`.
- H35: given `lexicalRevision: bm25-reference@2` and identifier profiles,
  `searchProjectionObjects` stamps the manifest and writes postings, chunk
  lengths, and term statistics equal to `lexicalShardPostings` and the
  whole-corpus index at `@2`, for shards of 1, 2, and 1,000 chunks, and
  `rankLexicalShard` over them returns the in-memory results; without a
  revision the release is `@1`, byte-identical with or without profiles →
  evidence: `search-shards.test.ts`, `publication-parity.test.ts`.
- H36: given `SEARCH_LEXICAL_REVISION` unset, blank, or `bm25-reference@1`,
  a publisher run writes the same objects as before; given
  `bm25-reference@2` it publishes an `@2` release whose terms hold the
  identifiers the record ids name; a later run without the variable writes
  `@1` again and leaves the `@2` release in place → evidence:
  `pipeline.test.ts`.

### Behavior (later slices)
- H24: [pending] given a Vectorize index, the adapter implements
  `SemanticRetriever` (project namespace, filters, chunk candidates) and
  passes the contract tests the in-memory retriever passes.
- H28: [pending] given the flag on, `/api/search` returns fused results with
  `retrieval.semanticRevision`, `fusionRevision`, and per-match
  `signals.semanticRank`; with the flag off the response is unchanged.
- H33: [pending] given golden v2 and the real model, `eval:search` reports
  lexical `@2` against hybrid, the report is committed, and the rerank
  decision (decision 5) is recorded with the numbers.

### Budget
- H27: [pending] Vectorize stored dimensions (`lastRun.search.chunkCount` ×
  1,024) and embedding neurons per run, each with a committed measuring
  command.
- H40: [measure] growth of `terms.json` and lexical shard bytes from `@1` to
  `@2` for the same Feed → `bun run measure:search-revisions` (Results,
  slice 2a); on Dev, `/health` `lastRun.search` before and after the switch.
- H31: [pending] added p50 latency of hybrid search on Dev against the
  lexical-only response, and Workers AI and Vectorize requests per query.

### Observability
- H30: [pending] query-time embedding uses its own AI Gateway with abuse
  protection, not `osskb-digest-dev`; its usage is visible separately from the
  digest's.
- H32: [pending] on Dev, `/api/search` `retrieval.semantic` and `/health`
  show whether semantic retrieval answered, without tailing logs.
- H41: given a successful run at `@1` or `@2`, `/health` `lastRun.search`
  holds the release's `lexicalRevision`, the manifest's `chunkCount`, the
  shard count, the summed and largest shard bytes, and the `terms.json` bytes
  as written → evidence: `pipeline.test.ts`.
- H42: [deploy] given slice 2a live on Dev and the variable set for Dev, the
  next run's `/health` `lastRun.search.lexicalRevision` is
  `bm25-reference@2`, and Dev `/api/search` returns results for `KIP770` and
  `RequestManager` with `retrieval.lexicalRevision` `bm25-reference@2` →
  evidence: the post-merge checks in the switch PR. The deployed E2E
  (`development.spec.ts`) asserts on every run that the served
  `retrieval.lexicalRevision` equals `/health` `lastRun.search.lexicalRevision`
  and, once that is `@2`, that `KIP770` returns the threads of `KIP-770`. It
  cannot require `@2`: it runs right after the deploy, before the next hourly
  publication.

## Results (slice 1, 2026-10-10)

`bun run eval:search`, golden v2 (16 queries: 13 lexical, 3 semantic), depth
20:

| Configuration | Queries | Pass | Semantic-required | Fail | Recall@20 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| lexical `bm25-reference@1` | all 16 | 9 | 2 | 5 | 0.7083 | 0.6875 | 0.6670 |
| lexical `bm25-reference@1` | lexical 13 | 8 | 0 | 5 | 0.7949 | 0.7692 | 0.7573 |
| lexical `bm25-reference@2` | all 16 | 11 | 2 | 3 | 0.9063 | 0.7813 | 0.8246 |
| lexical `bm25-reference@2` | lexical 13 | 10 | 0 | 3 | 1.0000 | 0.8077 | 0.9042 |
| `@2` + fake semantic | all 16 | 13 | 0 | 3 | 1.0000 | 0.8438 | 0.9113 |
| `@2` + fake semantic | semantic 3 | 3 | 0 | 0 | 1.0000 | 1.0000 | 0.9421 |

The fake-semantic rows prove plumbing only (Behavior 11).

What `@2` fixes: `KIP770`, the bare number `770`, `RequestManager` recall
(0 → 1.0), and `txn` now finds KAFKA-20785 through `EndTxn`.

What `@2` does not fix — three lexical queries still fail, on rank, not on
recall:

| Query | At `@2` |
| --- | --- |
| `consumer network thread request manager` | KAFKA-20765 is 5th (required: top 3); expected order not met; MRR falls 1.0 → 0.5 because unjudged KAFKA-19919 is 1st |
| `RequestManager` | Release Manager thread is 1st; KAFKA-20765 is 4th |
| `request manager` | Release Manager thread is 1st; KAFKA-20765 is 4th |

The Release Manager negative on the last two queries was added by the
implementer by analogy with the human-labelled query; the human has not
labelled it.

Cause, read from the scores: each reply of a mail thread repeats the thread
title at title weight 4, and a thread adds 0.25 of every further matching
chunk, so a four-message thread whose title holds one query word outscores a
single record holding both. These are answers in the top 20 that rank low —
the condition decision 5 names for considering rerank — but the fixture has 25
chunks, so Recall@20 here is weak evidence. Slice 4 decides with the real
model.

Mutation evidence (one mutant per behavior, each seen failing) is listed in
the PR.

## Results (slice 2a, 2026-10-10)

`bun run measure:search-revisions`, on the version-controlled recorded Feed
snapshot (`apps/web/test/fixtures/recorded-feed-publication.v1.json`, release
`2026-08-25T08-29-41-122Z`: real GitHub records of both projects, 184 groups,
353 chunks, 2 shards), published at each revision with the search profiles:

| | `@1` | `@2` | Growth |
| --- | --- | --- | --- |
| `terms.json` bytes | 61,969 | 66,196 | +6.8% |
| Distinct terms | 3,703 | 3,983 | +7.6% |
| Lexical shard bytes | 768,249 | 776,293 | +1.0% |
| Largest shard bytes | 605,016 | 610,719 | +0.9% |
| Total chunk length (weighted tokens) | 31,976 | 35,030 | +9.6% |

Chunks and excerpts dominate a shard, so the added postings barely move it.
The snapshot is 4% of the Dev corpus and holds no dev@ or Jira record, whose
titles carry more class names; a larger recorded snapshot is measured with
`--seed <directory>`.

Dev at `@1`, `GET /health` `lastRun.search` of release
`feed-2026-10-10T08-07-12-000Z` (read 2026-10-10, before the switch):
8,586 chunks in 10 shards, 17,479,986 shard bytes (largest 2,391,134),
`terms.json` 493,176 bytes. This is the real chunk count (open question 4).
The `@2` values are read the same way after the switch.

Golden v1, golden v2, and `bun run eval:search` are unchanged
(`golden-evaluation.v2.json` is byte-identical). The recorded publication
parity changed only in `statuses[].search`.

## Open questions

Not decided here:

1. **Workers Paid plan.** Vectorize stored dimensions are about 30.7 M at an
   estimated 30,000 chunks, above the free 5 M. At the measured 8,577 records
   (about one chunk each) they are about 8.8 M, still above it.
2. **AI Gateway and abuse protection** for query-time embedding. Search must
   not share the digest gateway `osskb-digest-dev`.
3. **Query embedding in the browser or on the server.** Spec 005 leaves it to
   a measured spike.
4. **Actual chunk count.** Answered: 8,586 on Dev on 2026-10-10
   (`/health` `lastRun.search.chunkCount`, H41); the 8,577 above was inferred
   from the Feed index.
5. **One source for identifiers.** Slice 2a keeps `proposal.keyPattern` and
   `issueKeyPattern` (Spec 014) separate from the search profile (see
   "Community profile fit"); to confirm.
6. **Thread-title repetition** (Results). Candidates: count the title once
   per thread, lower the further-chunk weight, a phrase-proximity signal, or
   leave it to rerank. Each changes the lexical ranking and needs its own
   measurement.
7. **Labels.** Should `RequestManager` and `request manager` carry the
   Release Manager negative, and is "top 3" the right bound for the three
   expected threads?

Known limitations of the profile patterns (kept in slice 2a, see "Community
profile fit"):

- `KIP 770` (a space) is not normalized to `KIP-770`. Dev excerpts do contain
  `KAFKA 13152` and `Kip 770`.
- `KIP-0770` (a leading zero) is another identifier than `KIP-770`.
- A title that cites `#770` indexes that number for its own record too, so
  `#770` also exact-matches records that mention the pull request.
- Profile patterns are trusted repository data. Validation rejects only the
  obvious nested quantifier; a test bounds each real pattern on adversarial
  input but does not prove linear time. The API caps a query at 500
  characters.
- The manifest does not record which profile revision indexed it (rollout 6).

## Non-goals

- R3: an AI answer with citations.
- Reranking, query rewriting, and graph expansion.
- Any cloud resource, deploy configuration, model call, or change to what
  Dev serves (slice 1). Slice 2a adds no cloud resource, binding, or model
  call and leaves `/api/search` on Dev at `@1`.
- A ranking change for the repeated thread title (open question 6, G31).
- A different BM25 formula or field weights.
- Estimating production recall from the golden fixture.
