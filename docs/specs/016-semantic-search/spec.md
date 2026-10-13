# Spec 016: Semantic candidates and hybrid fusion for Search

Status: Draft for human review — decisions of 2026-10-08..12 recorded below; slices 1, 2a, 2b and 3 implemented (3: query-time hybrid search in the web API, behind `SEARCH_SEMANTIC`, off in every deployed configuration), Dev switched to `@2` (H42) and `@3` (Spec 017), embeddings enabled on Dev (`SEARCH_EMBEDDING=bge-m3@1`, owner's approval 2026-10-12), the query gate and shard roots enabled on the Dev publisher (enable step 1, owner's approval 2026-10-13), hybrid search enabled on Dev Pages (enable step 3, 2026-10-13; H31 and H32 observed after its deploy), fusion `rrf-group@2` implemented behind the same flag after the 2026-10-13 measurement and Dev switched to it (rollout step 7, 2026-10-13; H79 observed after its deploy), fusion `rrf-group@3` (only a semantic standout passes the first three lexical threads) implemented behind the same flag and kept off by decision of 2026-10-13 (Dev remains on `rrf-group@2`; fusion tuning stops; the next lever is the embedding text), Prod has no flag, slice 4's rerank decision pending
Date: 2026-10-13
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
(H41). Measured there on 2026-10-10: 8,586 chunks in 10 shards; the slice 2b
numbers use that value.

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

### Example (slice 3): Dev before hybrid search, 2026-10-12

`bun run measure:search-hybrid` against the public Dev API at 11:16 UTC,
release `feed-2026-10-12T11-07-57-000Z`, `bm25-reference@3`, hybrid search
off (the response has no `retrieval.semantic`), `limit=50`. `/health` at
10:42 UTC: 8,780 chunks in 10 shards, 17,956,963 shard bytes (largest
2,423,328), `terms.json` 556,993 bytes; `searchEmbedding`: 8,780 embedded, 0
pending, semantic revision `@cf/baai/bge-m3@1:1024:title-text@1`.

| Query | Kind | Expected threads, lexical ranks | Time |
| --- | --- | --- | --- |
| `consumer network thread request manager` | owner's | KAFKA-19804 2nd, pull request 22747 21st, KAFKA-19738 9th | 1.9–4.1 s |
| `交易逾時` | Chinese | none in the first 50 (0 results) | 0.7 s |
| `消費者重新平衡很慢` | Chinese | none in the first 50 (0 results) | 0.8 s |
| `反向 DNS 查詢阻塞網路執行緒` | Chinese | 7th, 3rd (through the word `DNS`) | 1.0 s |
| `txn` | abbreviation | 1st to 5th: only threads that spell `Txn` | 1.1 s |
| `SMJ spill` | abbreviation | 49th, not in 50, 29th | 1.4 s |
| `two-phase commit` | vocabulary gap | not in 50 (the title says `2PC`) | 1.8 s |
| `client spins at 100% cpu` | vocabulary gap | 3rd, three more not in 50 | 1.8 s |

Of the 16 Chinese and vocabulary-gap queries written for slice 4 (test plan
below), 3 are met lexically. A query whose words are in no shard reads three
objects and takes 0.7 s; one whose words are in every shard reads 13 and
takes 1.0–2.3 s (median over the 43 measured queries: 1.67 s). Those two
numbers are the budget the semantic path has to fit beside.

### Example (fusion): Dev with hybrid search on, 2026-10-13

`GET https://oss-knowledge-base-dev.pages.dev/api/search?q=transaction+manager&limit=50`,
read 01:27 UTC, release `feed-2026-10-13T01-07-01-000Z`. `retrieval` said
`lexicalRevision: bm25-reference@3`, `fusionRevision: rrf-group@1`,
`semantic: { status: "ok", candidates: 100, cached: true }`. The 100
candidates are passages, 50 from each project's namespace whatever their
similarity; they made at least 70 threads. Lexical threads are ranked to 50.

| fused | thread | lexical | semantic | score |
| --- | --- | --- | --- | --- |
| 1 | pull 23630, KAFKA-21181: Return NOT_COORDINATOR from a stale transaction coordinator cache | 3 | 1 | 1/63 + 1/61 = 0.0323 |
| 2 | KAFKA-21181 | 4 | 3 | 0.0315 |
| 3 | KAFKA-21230: Long rebalances can cause OOM errors with transactional state stores | 6 | 2 | 0.0313 |
| 10 | pull 23555, KAFKA-19818: Move ClientQuotaMetadataManager to metadata module | 30 | 11 | 0.0252 |
| 12 | pull 23687, KAFKA-19804: Improve heartbeat request manager initial HB interval | 49 | 14 | 0.0227 |
| 19 | pull 23646, MINOR: Validate client quota values and cap throttle time to int range | 45 | 70 | 1/105 + 1/130 = 0.0172 |
| 20 | pull 23547, KAFKA-20237: Stuck transaction manager after ssl handshake failure | 1 | — | 1/61 = 0.0164 |
| 21 | KAFKA-20237: TransactionManager stuck in `INITIALIZING` state | 2 | — | 0.0161 |
| 22 | pull 21715, KAFKA-20237: Re-enqueue InitProducerId request after authentication failure | 5 | — | 0.0154 |
| 23 | pull 23625, MINOR: Add PartitionsWithLateTransactionsCount description | — | 6 | 0.0152 |
| 24 | datafusion pull 21621, Push down topk through join | — | 9 | 0.0145 |

What the values mean:

- The two threads the row expects (KAFKA-20237 and its pull request) are
  lexical ranks 1 and 2 and are not among the 100 semantic candidates. A
  thread in one list scores at most 1/61 = 0.0164; a thread in both scores
  at least 1/110 + 1/160 = 0.0153, and 0.0172 at lexical 45 and semantic 70.
  Nineteen threads found twice therefore precede the best lexical thread.
- A semantic rank says how the candidates are ordered, not that a candidate
  is similar: `Push down topk through join` is the ninth semantic thread
  for `transaction manager`.
- The first six lexical threads hold `transaction` and `manager` in one
  returned passage; the seventh holds `transaction` only. Under
  `rrf-group@2` (Behavior 38) those six keep places 1 to 6, and the rest
  follow in the order above: KAFKA-20734 (lexical 8, semantic 7) is 7th.

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

## Decisions (slice 2b, implementer, 2026-10-10; Decision 9 confirmed 2026-10-12)

Human decisions 2–4 fixed the unit, the model, the store, the namespace per
project, and the separate gateway. These were left to the implementer:

7. **State in the embedding object's storage**, one entry per vector
   (Behavior 18). Rejected: an R2 object (rewritten whole on every batch, or
   progress is lost when a run dies; a mutable object beside
   content-addressed releases); Vectorize metadata as the state (listing is
   paged and eventually consistent, the exact property that would cause
   re-embedding). Durable Object storage is strongly consistent and written
   per batch. Size: about 100 bytes per vector, 0.9 MB at 8,586 chunks and
   3 MB at 30,000, far under the 128 MB memory limit; values are far under
   the per-value limit; writes go 100 keys per call (the limit is 128).
8. **A separate Durable Object**, not a step in the publisher's alarm. The
   publisher's object has already hit the 128 MB limit and the 15-minute
   alarm wall time, and a retried publisher alarm publishes again. Embedding
   in its own object cannot extend, fail, or re-run a publication
   (Behavior 15).
9. **Vector id per passage, not per chunk id** (Behavior 17). H21 used to
   say "under its chunk id": a chunk id is 76 bytes (limit 64) and changes
   with every `sourceVersion`, which would re-embed a thread on every new
   comment. This changes the wording of H21, not its intent.
10. **No metadata index and no revision in the id.** A new revision
    overwrites each vector in place, so storage never doubles; during the
    change the index is mixed, and the retriever drops other revisions by
    metadata (Behavior 22). Cost: until the backfill ends, other-revision
    matches use part of the 50 returned per namespace.
11. **An unknown `SEARCH_EMBEDDING` fails the embedding run, not the
    publication** (Behavior 14).
12. **Bounds** (Behavior 19): 3,000 chunks and 80 model calls per run, 400
    calls and 2,500 estimated neurons per UTC day, 50 texts and 20,000
    estimated tokens per call. Arithmetic in Results (slice 2b). The
    embedding ledger is its own. The token estimate may undercount the
    model's tokenizer by up to about 2× on CJK and identifier text (verifier,
    PR #50), so the cap is set so that twice it plus the digest's 4,500 is
    9,500, under the 10,000 neurons a day the plan includes.
13. **Our own bounds are not failures; refusals are.** A run stopped by a
    bound of Behavior 19 is `ok` with `limited`. Code 3036, a gateway 429, and
    a spend-limit refusal are `ok: false`, `failureKind: model-limit`, because
    someone has to look.
14. **Coverage is in `/health`, not in the manifest** (Behavior 22).
15. **A new package, `packages/semantic-vectorize`**, holds what the
    publisher and the query side share (profile, vector id and metadata, the
    `VectorIndex` port, the Workers AI embedder, the retriever, the fakes).
    The Pages reader will import it in slice 3; `packages/search` and
    `packages/serving-contract` do not depend on it (a test checks).
16. **Deployed configuration.** Dev gets the Vectorize binding, the
    `SearchEmbeddingRun` object (migration `v3`), and `SEARCH_GATEWAY_ID`.
    Prod gets nothing, not even the inert object binding the digest has.
17. **Small ones.** `truncate_inputs: true` on the model call; the gateway
    cache is skipped when publishing; non-positive similarities are not
    candidates (as in the in-memory retriever); `reset=1` and a dry run with
    `profile=` are served while the flag is off, because they call nothing.

18. **Vectors of a missing project are kept** until three releases in a
    row hold none of its chunks (Behavior 23). Three, because the publisher
    writes one release an hour and a source outage that empties a project is
    more likely than a project ending; counting releases rather than runs
    means repeated manual triggers cannot shorten the wait.
19. **Quarantine is by time, not forever** (Behavior 24). A text that fails
    alone in three runs in a row is skipped for 24 hours and then tried once
    more (at most 2 calls), so a wrong conviction heals by itself; each
    further failure doubles the wait, up to 30 days.
20. **A failed batch is split, not retried whole** (Behavior 25, after the
    second verdict on PR #50). Retrying 50 texts as one call can only fail
    again when one of them is bad, and the 49 others stay unembedded beside it
    for good. Halving finds the bad text in `1 + 2 × ceil(log2 n)` calls (13
    for 50) and stores the rest in the same run. The halves take the place of
    the whole-batch retry, so a transient error costs 3 calls instead of 2.
    A probe text tells a bad batch from a model that is down, because both
    look the same from one batch: without it, either two bad texts in the
    first batch are never separated or an outage splits every batch. The
    evidence has to be recent (third verdict): "some call succeeded earlier
    in this run" let a model that died in mid-run get healthy texts struck,
    so three failures in a row call for a new probe, and a text struck before
    is treated like any other.
21. **Every error text is redacted** (Behavior 24), in the embedding path
    only. The digest shares `errorShape` and still surfaces model errors
    unredacted (gardening G43).
22. **The deadline is checked before every model call, and the call timeout
    is 30 seconds, not 60** (Behavior 19, third verdict). Checked only
    between batches, one split with 60-second timeouts could run 13 minutes
    and a late batch past the alarm's 15, leaving no result at all. A normal
    call takes a few seconds; 30 keeps the worst case at 11 min 35 s.
23. **A path is not a token** (Behavior 24, third verdict). Redacting every
    run of 32 token characters also removed object keys and URL paths from
    foreign error text, which is what an operator needs to read.
24. **Retries never compete with healthy work** (Behavior 26, fourth
    verdict). Retried in release order with up to 3 calls each, 133
    quarantined texts used a whole day's calls and the backlog starved (the
    verifier's 8,586 chunks with 172 bad texts had not converged after 500
    runs). Healthy first, a small separate budget, and a doubling quarantine
    make the cost of bad texts independent of how many there are.

Owner's answers (2026-10-10, after the PR #50 verdict):

- (a) Decision 9, one vector per passage with id = hash of project, record,
  and ordinal: **confirmed by the owner on 2026-10-12**.
- (b) The slice 3 release-view contract (open question 9): deferred to the
  slice 3 spec.
- (c) Decision 11, an unknown flag value fails only the embedding run:
  accepted.
- (d) Depth of 50 per namespace (open question 10): measure in slice 4.
- (e) Decision 16: Prod gets nothing until the Prod launch.
- (f) An empty release: guard, do not wipe (Decision 18, Behavior 23).

Owner's decision (2026-10-12): enable embeddings on Dev with `bge-m3@1`,
after the dry run of 2026-10-10 on the Dev release (Results, "Dev dry run").
Prod stays without the flag.

## Decisions (slice 3, 2026-10-12)

Decided by the owner before the slice: hybrid search fuses lexical `@3` with
Vectorize candidates through `rrf-group@1`; exact identifiers stay first;
any missing semantic retrieval is the lexical answer; the semantic timeout
is 1,000 ms; every query-time model call goes through `osskb-search-dev`;
visitor queries must not cost money; the flag is off in this PR on Dev and
Prod; `SearchResponseV1` changes only by addition.

Left to the implementer, to confirm:

25. **A release names the shard of a group in its manifest** (Behavior 27;
    answers open question 9 and G42). `shards[n].firstGroupRootRecordId`.
    A project's shards hold its groups in group-root order (Spec 013), a
    vector carries its group root, and a vector whose root differs from the
    release's has another fingerprint and is dropped anyway (Behavior 22),
    so the stored root is a complete address. Cost: 0 extra R2 reads and
    about 60 bytes a shard (0.6 KB on Dev's 10 shards). Rejected: a
    per-release side object (`record → shard, fingerprint`: about 0.7 MB
    and one more read per query, and filters and display still need the
    shard); the shard number in vector metadata (shard boundaries move with
    every release, so the hint is wrong after an hour and after a rollback,
    and a wrong hint is a silent miss). The field is not a new revision:
    readers before this slice validate a shard reference by `projectId` and
    `key` only and ignore it (a test), so nothing needs to reject anything;
    a release without it is served lexically (`uncovered`). It is still
    behind a publisher flag, `SEARCH_SHARD_ROOTS`, like every other change
    to stored bytes, so that merging changes no object.
26. **One pass over the shards, with the gate asked first** (Behavior 28).
    A semantic match is validated against the release's chunk and shown
    from it, and both need the shard. Lexical ranking reads the same shards
    and releases each after ranking it (Spec 013), so the reader asks the
    gate as soon as it has the manifest, reads shards while the gate
    answers, and ranks and resolves each shard once. A shard is never read
    twice and never kept: at most 3 + shards reads a query and four shards
    in flight, the Spec 013 bounds. Rejected: implementing
    `SemanticReleaseView` over R2 beside the lexical reader (every shard
    with a match read a second time: up to 18 MB more a query); ranking
    lexically first and re-reading shards for the matches (the same).
    The price: the lexical ranking waits for the gate, at most the timeout.
    `VectorizeSemanticRetriever` and `SemanticReleaseView` stay as the
    `SemanticRetriever` seam with their contract tests; the reader shares
    their two steps (`proposeSemanticMatches`, `acceptSemanticMatch`).
27. **The gate is a Durable Object the Pages Function calls through a
    binding** (Behavior 32). Pages Functions keep no state, and a hard cap
    needs one strongly consistent ledger. The object lives in the data
    Worker, which already has the AI binding, the index, and the gateway
    id, so the Pages project gets one binding and no AI or Vectorize
    binding. It is its own class and object: query traffic cannot reach the
    publisher's or the embedding job's object, storage, or ledger.
    Rejected: an `ai` and a `vectorize` binding on Pages with the ledger in
    an object (three bindings, and the embedding call outside the place
    that counts it); a public route on the Worker with a shared secret (a
    secret to manage and a route to defend); a second instance of
    `SearchEmbeddingRun` (no migration, but the Pages binding could then
    address the embedding run); KV for the ledger (eventually consistent:
    not a hard cap); the Cache API for the embedding (per data centre, so a
    repeat elsewhere pays again, and it cannot hold the ledger).
28. **The gate caches the query embedding and each project's matches**
    (Behavior 33). The embedding alone would leave every repeat paying an
    index query, and Vectorize bills queried dimensions (Decision 30).
    Matches may be up to an hour old: a stale match is dropped by the
    fingerprint check, so staleness costs recall for chunks embedded within
    the hour, never correctness.
29. **All of a release's projects are asked, whatever the project filter**
    (Behavior 29). Lexical search also reads every shard a term names and
    filters projects afterwards, because facets ignore the project filter.
    Asking only the filtered project would make the other project's facet
    count change when a filter is clicked. Cost: 2 index queries for an
    uncached query on Dev instead of 1 when a filter is set; the cache key
    then holds no filter at all, so no filter can poison it.
30. **Budget** (Behavior 34): per UTC day 1,000 neurons and 1,000 index
    queries; per clock hour 100 model calls. Arithmetic in Results
    (slice 3). The charge for an embedding is an upper bound, not an
    estimate, and at least 1 neuron a call.
31. **Queries that can match exactly are not embedded** (Behavior 30).
    The owner asked to skip pure identifier queries and queries where
    lexical search already has an exact match. The second is known only
    after the shards are read, and the gate is asked before; but an exact
    match is possible only for a query that is one identifier, a bare
    number, or a symbol, which is known from the query alone. So the two
    rules are one test on the query.
32. **Statuses** (Behavior 31) keep the names of slice 1 (`ok`, `disabled`,
    `failed`, `timed-out`) and add `skipped`, `uncovered`, `over-budget`.
    `signals.lexicalRank` becomes optional, as Spec 005 declares it: a
    thread only semantic retrieval found has none.
33. **Calibration** (Results, slice 3): the embedding job's neurons are the
    token estimate times 1.8, the ratio measured on the Dev backfill. The
    job's cap stays 2,500, now in calibrated neurons.
34. **The Worker's entry module exports no constant.** workerd refuses to
    start a Worker that exports a string from its entry module; a dry-run
    deploy does not catch it, a local run did. A test now checks every
    export.

### Simplification review (slice 3)

1. **Question every requirement.**
   - Shard roots: owned by Behavior 22 (a match is the release's chunk).
   - The gate, its ledger, the two caches, the hourly cap: owned by the
     owner's cost requirement; the hourly cap by the embedding job, which
     shares the gateway's 600 requests an hour.
   - `retrieval.semantic`: owned by Observability; `semantic=off` by
     slice 4's comparison.
   - The badge (removed 2026-10-13, Behavior 36): owned by the reader, who otherwise sees a result that holds
     none of the words typed.
   - `/health` `searchQuery`: owned by the operator; without it the budget
     is invisible.
2. **Delete.**
   - No AI or Vectorize binding on Pages; no side object; no new revision.
   - No Worker flag for the gate: it is on when `SEARCH_EMBEDDING` is.
   - No call cap per day beside the neuron cap (every call is at least one
     neuron), no cache of fused results (they depend on the release, the
     filters, and the limit), no cache in the Pages isolate, no
     `SemanticReleaseView` over R2, no global cut of semantic candidates.
   - No second excerpt function: a semantic passage is cut by the lexical
     one, from its start.
   - No rate limiter per visitor: there is no visitor identity without
     Access, and the day's cap bounds the cost whoever asks.
   - Deleted and added back: a memo, per isolate, of "the budget is spent
     until T". Without it every search after the cap still calls the
     object.
3. **Simplify.** One status string; one object for the ledger and both
   caches; one test on the query for both skip rules; cache keys hold the
   query and the revision only.
4. **Shorten the cycle.** The whole path runs offline through the real gate
   with a fake embedder and a fake index (`search-hybrid.test.ts`); the
   byte-identity of the flag-off response is a digest file written on
   `origin/main`; `measure:search-hybrid` works against any deployment,
   hybrid or not.
5. **Automate last.** No new CI job. Two committed commands,
   `measure:search-hybrid` and `measure:search-query-budget`.

## Decisions (fusion `rrf-group@2`, 2026-10-13)

Hybrid search went live on Dev on 2026-10-13 and the first measurement
(Results) showed a net regression where lexical search was already right
(Spec 017's 20 rows: 20 met lexically, 13 hybrid) beside the gains it was
built for (Chinese rows 1 → 3, vocabulary-gap rows 2 → 4). Decided by the
owner before this change: fix the fusion in a new revision chosen by
ablation on recorded data, never change `rrf-group@1`, keep exact
identifiers first, no community-specific constant, no extra model or index
call, contracts by addition only, and leave Dev's configuration alone in
this PR. Left to the implementer, to confirm:

35. **The rule: the leading full lexical matches keep their places**
    (Behavior 38). The mechanism of the regression is that RRF with k = 60
    counts a second, weak rank for more than a first, strong one: a thread
    in both lists scores at least 1/110 + 1/160 = 0.0153 and a thread in
    one list at most 1/61 = 0.0164, and about a third of the lexical
    threads are also among the 100 semantic candidates (Results). So the
    rule protects exactly what was lost: threads at the head of the lexical
    ranking that hold every word of the query in one passage. Everything
    below them is fused as before, which keeps every gain: a Chinese query
    has no such thread, and a question in other words rarely has one first.
    It is the only alternative family with no row worse than lexical-only
    and no lost gain on the tuning rows (ablation, Results):
    - Weighted RRF (candidate 1) still lets a thread found twice pass the
      first lexical thread: at semantic × 0.5, 6 tuning rows stay worse and
      2 gains are lost; at × 0.25, 5 and 3.
    - Lexical first with semantic threads appended (candidate 2) has no
      worse row and loses all 6 tuning gains; keeping the first three
      lexical threads whatever they hold leaves 3 rows worse and loses 2.
    - Fewer semantic candidates (candidate 5) is worse than `rrf-group@1`:
      7 and 8 rows worse at 20 and 10 threads, because the deep ranks also
      carried the right threads.
    - A similarity threshold (candidate 3) could not be evaluated: the
      response did not serve the similarity (Decision 40).
    - Dynamic trust (candidate 4) is this rule. Its first form, every full
      match first wherever it ranks, has the same numbers on the tuning
      rows, but it reorders lexical results with no semantic evidence at
      all (a full match at lexical 10 would jump over nine threads even
      when semantic retrieval returns nothing), so the fallback would no
      longer be the lexical order. The leading run does not.
36. **`rrf-group@1` stays, pinned.** It is the default config, the rollback
    target, and what the replay is checked against: its config, its order
    for any input, and its 3,052 live ranks are tests (H74). The flag's
    value names the revision; a name this code does not run answers
    lexically with `failed`, as an unknown value always did.
37. **k stays 60.** Under the rule, k = 10 is better on the tuning rows
    (nDCG@10 0.7063 against 0.6840, one more Chinese row met) and not on
    the rows it was not chosen on (held-out 0.7643 against 0.7728, new
    0.6527 against 0.6585), and k = 5 loses a gain. One row decides it, so
    it is not adopted; semantic × 0.75 under the rule moves the owner's
    first thread from 3 to 2 and moves the one Chinese thread found by
    meaning alone from 13 to 28, so it is not adopted either.
38. **"Worse than lexical-only" is judged at the row's bound.** A row is
    worse when an expected thread that lexical-only ranks within the bound
    is outside it, or gone. Threads lexical-only already ranks outside the
    bound may move: any fusion that shows threads found by meaning alone
    pushes some lexical thread down, so "no expected thread ever lower" is
    met only by the lexical order itself. Those moves are counted and
    reported (`lowered`), not gated. Owner to confirm, in particular for
    the owner's own row (open question 28).
39. **Chosen on a recorded replay, not on Dev.** The public response holds
    each result's lexical and semantic rank, so two GETs a query record
    what fusion read. Replayed, `rrf-group@1` reproduces every live rank,
    and `rrf-group@2` is exact for the first 50 results, because its order
    is the kept threads followed by the live order without them (H75).
    The other alternatives are approximate where a semantic candidate below
    the response's 50 results would have entered. The fixture holds ranks,
    ids, and matched-term masks, no title or excerpt.
40. **`signals.semanticScore` is added** (Behavior 40), for open question
    15 only. Without it a threshold cannot be judged from outside, and with
    it the next capture can. No revision reads it. It is the similarity of
    a match already validated against the release (Behavior 22), never
    index metadata.
41. **Against fitting 43 rows.** Every third row of each kind was held out
    of the comparison of parameters (12 rows), and 14 new queries were
    written, labelled, and asked before the rule existed (H76). The rule
    itself was designed after reading all 43 rows, so only the 14 new
    queries are evidence the rule was not fitted; the held-out rows are
    evidence for the parameters (Decision 37).
42. **Dev stays at `rrf-group@1` in this PR** (the owner's instruction);
    the switch is rollout step 7. The implementer's recommendation is to
    make it as soon as this is verified: on the same candidates
    `rrf-group@1` has 10 of 57 rows worse than lexical-only and
    `rrf-group@2` none, and nothing else differs.

### Simplification review (fusion)

1. **Question every requirement.**
   - The rule: owned by the regression (H75).
   - `rrf-group@1` kept: owned by rollback and by the replay's check.
   - The fixture and `capture:search-replay`: owned by H75, which has to
     run in CI without the network or a model call.
   - `eval:search-fusion` and its committed table: owned by the choice
     (Decision 35), which must be repeatable.
   - `signals.semanticScore`: owned by open question 15.
   - The hold-out and the new queries: owned by Decision 41.
2. **Delete.**
   - No weight, threshold, depth, or second RRF constant; no phrase signal;
     no new status, flag, variable, or cache key (the existing variable's
     value names the revision).
   - No field saying a thread was kept: its `fusedRank` equals its
     `lexicalRank`.
   - No lexical score in the response and no title in the fixture.
   - "Every full match first": deleted for the leading run (Decision 35).
   - The check for missing words in `hybridSearch`: `fuseRankings` makes
     it, and a mutant without the copy changed no result.
   - Deleted and added back: the semantic ranks the response did not show.
     Without placeholders for them a thread's semantic rank shifts and the
     replay of `rrf-group@1` no longer reproduces the live ranks.
3. **Simplify.** One boolean in the fusion config and two comparator lines;
   the query's words come from the function the phrase bonus already uses,
   so "every word" means what lexical search means by it.
4. **Shorten the cycle.** The replay runs in 0.2 s; the live measurement
   takes seven minutes and up to 96 index queries of the visitors' budget.
5. **Automate last.** No CI job: the ablation is a text file the unit tests
   compare, like Spec 017's.

## Decisions (fusion `rrf-group@3`, 2026-10-13)

The verifier of PR #57 found that `rrf-group@2` is a narrow fix: on its own
20 queries it tied `rrf-group@1` on 19, and three queries lexical search
answers stay worse than lexical-only, because the rule engages only when
the first lexical thread holds every query word. Decided by the owner
before this change: capture the similarities now that the response serves
them, look at what they separate before designing anything, stop with a
recommendation if they separate nothing, never change `rrf-group@1` or
`rrf-group@2`, leave Dev's configuration alone, and write up the embedding
text without changing it. Left to the implementer, to confirm:

43. **What the similarity separates** (Results, "What the similarity
    says"). Over 112 hand-labelled candidates:
    - **No absolute floor.** Relevant candidates range from 0.466 to 0.658
      and irrelevant ones from 0.383 to 0.620 (AUC 0.736). A floor of 0.50
      already loses 2 of 19 relevant candidates and keeps 58 of 73
      irrelevant ones. The level belongs to the query, not to relevance:
      every candidate of `txn` is below 0.50 and every candidate of `kafka
      release` is between 0.555 and 0.598, and none of the labelled ones
      of either is relevant.
    - **Chinese queries are not scored lower.** Median best similarity
      0.582 against 0.592 for other queries; median 20th 0.524 against
      0.512. No separate threshold is needed for them.
    - **The distance to the best candidate** is little better (AUC 0.762).
    - **A margin over the query's own background does separate the
      candidates that stand out** (AUC 0.871). With the background taken
      as the similarity of the query's 20th semantic thread, a margin of
      0.05 keeps 15 of 19 relevant candidates and 3 of 73 irrelevant ones;
      0.04 keeps 17 and 19.
    - **It finds standouts, not relevance.** Of the 148 expected threads
      that have a similarity, 77 are 0.04 above their background; the
      median margin is 0.041. Half of the right threads sit in the pack
      with the wrong ones, so no rule that drops or down-weights the pack
      can be right.
44. **The rule: only a standout passes the first lexical threads**
    (Behavior 43). The similarity is used for the one thing it supports: a
    thread may precede one of the first three lexical threads only if
    lexical search ranks it above that thread or it stands out. A thread
    semantic retrieval did not return is thereby treated as missing
    evidence about the lexical head, not as evidence against it, which is
    the failure the verifier found. Nothing is dropped and no score is
    reweighted. Rejected, on the same capture (ablation, Results):
    - an absolute floor: no effect at 0.45 and 0.50; at 0.54 it loses rows
      in three sets;
    - a distance to the best candidate: every value tried makes a row
      worse than `rrf-group@2`;
    - weighting or gating the semantic contribution by the margin: each
      makes rows worse than `rrf-group@2` in two or more sets, because the
      pack holds right threads too (Decision 43);
    - a neutral semantic rank for an absent lexical thread: at rank 50 or
      30 it changes no verifier row and makes tuning rows worse;
    - a head of 1 leaves the owner's row worse; a head of 5 or 10, or a
      margin of 0.05, loses a gain of `rrf-group@2`.
45. **The constants: head 3, reference 20, margin 0.04.** On the 76
    labelled rows captured before the rule existed, heads of 2 and 3 with
    margins of 0.03 and 0.04 are the only variants with no row worse than
    `rrf-group@2` and fewer rows worse than lexical-only; they agree on
    every row's status. 0.04 rather than 0.03 because it admits half as
    many irrelevant candidates (19 against 37 of 73) for the same 17
    relevant ones; 3 rather than 2 with no evidence either way. The
    reference is where the hand labels were measured; it was not varied.
    These are three numbers fitted on few rows: owner to confirm, and
    open question 30.
46. **Shipped, although one acceptance criterion is not met.** The owner's
    criterion "no lexical-right query of the verifier's set worse than
    lexical-only at its bound" holds for 7 of the 9, not 9: the rows worse
    than lexical-only fall from 4 to 2 (Results, known limitations). The
    other criteria hold: no row of any set worse than `rrf-group@2` at its
    bound, no gain of `rrf-group@2` lost, rows met not lower in any set.
    The implementer's judgement is that this is a small, safe improvement
    rather than a fix: it is behind the flag, off, and the report says so.
47. **Clean evidence: ten more queries.** The rule was designed after
    reading the verifier's set, so that set no longer proves anything
    about fitting. Ten queries were written and labelled after the
    constants were fixed and before the rule ran on them (H84): 9 tie
    `rrf-group@2`, 1 has a thread one rank higher, none is worse. The
    honest reading is that the rule does no harm there and rarely acts.
48. **The embedding text is the larger lever, and is not changed here**
    (Results, "The owner's query and the embedding text"; open question
    29).
49. **Dev's configuration is not changed in this PR.**
50. **DECISION (2026-10-13): `rrf-group@3` is implemented and stays OFF;
    Dev remains on `rrf-group@2`; fusion tuning stops here.** The deciding
    evidence is the verifier's fresh clean set for PR #59 (Results, "The
    verifier's clean set for `rrf-group@3`"): 15 new queries written for
    the class `rrf-group@2` cannot fix, on which `rrf-group@3` is better
    than `rrf-group@2` on 1, worse on 2, and the same on 11. What it shows:
    - `rrf-group@3` protects lexical ranks 1 to 3 **regardless of
      relevance**. When those threads are right it helps; when they are
      not, it lifts irrelevant lexical threads above relevant ones. Its
      gain over `rrf-group@2` is therefore small and two-sided.
    - The constants sit on a plateau (head 2 to 3 × reference 20 to 30 ×
      margin 0.02 to 0.04 are equivalent; a margin of 0.05 or more, or a
      head of 4 or more, is worse on some set), so the result is not an
      accident of the three numbers; but the benefit is about zero on
      genuinely new queries.
    - The next lever is the embedding text (a follow-up spec,
      `title-text@2`; Decision 48, open question 29). After it,
      `rrf-group@3` may be re-evaluated, because richer vectors change
      what stands out.
    This supersedes the implementer's earlier recommendation to switch
    (open question 31) and rollout step 8.

### Simplification review (fusion `rrf-group@3`)

1. **Question every requirement.**
   - The scored capture and `eval:search-similarity`: owned by Decision 43,
     which must be repeatable from committed data.
   - The hand labels: owned by the same decision; without them "separates"
     has no meaning.
   - The rule and its three constants: owned by the verifier's finding.
   - The verifier's rows and the ten clean rows: owned by Decisions 46, 47.
2. **Delete.**
   - No floor, no distance to the best, no weighting, no neutral rank.
   - No threshold for Chinese queries.
   - No new response field: a reader does not need to know which thread
     stood out, and the capture already holds the similarities.
   - No change to the gate, the candidates, or the embedding.
   - No second copy of the replay harness: the scored evaluation imports
     the first one's judges.
   - Deleted and added back: the similarity of semantic threads the
     response did not show. Without a value for them the 20th thread, and
     so the background, would be read from the wrong thread.
3. **Simplify.** One pass over the `rrf-group@2` order; the background is
   one array lookup; the rule moves threads and never rescores them.
4. **Shorten the cycle.** 0.5 s offline for the separation report and the
   ablation over 86 fused queries.
5. **Automate last.** No CI job: the report is a text file the unit tests
   compare.

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
    configuration sets `bm25-reference@2` (`bm25-reference@3` since Spec 017
    N17) and production still sets none. A successful run records
    `lastRun.search { lexicalRevision, chunkCount, shardCount, shardBytes,
    largestShardBytes, termsBytes }` from the manifest and object sizes of the
    release it wrote.

Embedding publication and the Vectorize adapter (slice 2b):

14. **Flag and profile.** The Worker variable `SEARCH_EMBEDDING` names an
    embedding profile; `bge-m3@1` is `SemanticRevisionV1 { model:
    "@cf/baai/bge-m3", modelRevision: "1", dimensions: 1024,
    textAssemblyRevision: "title-text@1" }`. Unset or blank is off: the
    publisher makes no model, Vectorize, or embedding-object call and writes
    the same objects as before. Any other value, or a missing gateway id, AI
    binding, or vector index, is a configuration error: the embedding run
    fails naming it, calls nothing, and `/health` shows it. It does not fail
    the publication (Spec 005: lexical search never depends on embeddings),
    which is where this flag differs from `SEARCH_LEXICAL_REVISION`.
15. **Its own object.** `SearchEmbeddingRun` is a Durable Object with its own
    isolate, memory, storage, and alarm, like `DigestRun`. After a successful
    publication the publisher asks it to run and ignores the answer; a
    failure, timeout, or crash there cannot fail, delay, or re-run a
    publication. `POST /search-embedding/run` starts it by hand.
16. **One run.** A run pins the current Search release
    (`public/search/v1/current.json` → manifest → shards) and reads one shard
    at a time. Each chunk has a vector id and a fingerprint (rule 17). A chunk
    is embedded when the state holds no entry for its id with the same
    fingerprint and semantic revision. Texts go to the model in batches of at
    most 50 texts and 20,000 estimated tokens, through the AI Gateway named by
    `SEARCH_GATEWAY_ID`; each batch is upserted into Vectorize and then
    recorded in the state. Ids in the state that the release no longer holds
    are deleted from the index (Behavior 23), 100 per call, then from the state; nothing is
    deleted unless every shard was read and the chunks seen equal the
    manifest's `chunkCount`.
17. **Vector identity.** The id is the first 48 hex characters of
    `sha256(projectId, recordId, ordinal)`: a chunk id is 76 bytes and changes
    with every `sourceVersion`, while this id is 48 bytes and stays with the
    record's passage. The namespace is the project id. The fingerprint is the
    first 32 hex characters of `sha256(title + "\n" + text, groupRootRecordId)`.
    Metadata is `{ r: semantic revision id, h: fingerprint, record, ord,
    root }`, under 10 KiB, with no metadata index. A new `sourceVersion` with
    the same title, text, and group is not embedded again; a changed title,
    text, or group is embedded again under the same id, replacing the vector.
18. **State.** The object's storage holds one small entry per vector
    (`v:<id>` → `{ p: projectId, h, r }`), the day's ledger, the last mutation
    id, and the last result. It is the only source for "is this chunk
    embedded": the index is never asked, so Vectorize's asynchronous
    mutations (an upsert returns a mutation id and becomes queryable later)
    cannot cause a second embedding. A run starts with `describe()`: the index
    must answer with the profile's dimensions, or the run fails before any
    model call; whether the index has processed the last accepted mutation is
    reported, not acted on.
19. **Bounds.** Per run: at most 3,000 chunks, 80 model calls, and 2,000
    deletes. No model call (a batch, a half, a retry, a probe) and no delete
    starts 10 minutes or more after the run began, and each model or
    Vectorize call is abandoned after 30 seconds. So the longest run is the
    deadline, plus the last model call, plus its upsert timing out, waiting 5
    seconds, and timing out again: 600 + 30 + 65 = 695 seconds, 11 min 35 s,
    under the alarm's 15 minutes (`worstCaseWallMs`). Reads of the release
    from R2 and listings of the object's storage are not individually timed:
    a read that hangs can still take a run past the alarm limit; the runtime
    then retries the alarm, and because every stored batch is recorded as it
    is stored the state stays correct. Per UTC day: at most 400 model calls and
    2,500 estimated neurons (`@cf/baai/bge-m3` at 1,091 neurons per million
    input tokens, estimated with the digest's token estimate; every call
    counts at least 1). The ledger is written before each model call, so a
    run that dies and is retried counts both attempts. A run that reaches a
    bound stops embedding, keeps what it recorded, reports `limited`, and the
    next run continues from the state.
20. **Failures.** A model call that fails is followed, after 5 seconds, by
    its halves (Behavior 25); a single text is retried once. Workers AI code
    3036, a gateway 429, and a spend-limit refusal stop model use for the run
    without a retry. A wrong number of vectors or a wrong dimension is a
    model error. A failed upsert is retried once, then embedding stops for
    the run (the store is down; further model calls would be wasted). A
    failed delete is retried once, then deletes stop. Every failure leaves
    the vectors already stored in place and is reported in `/health`.
21. **`VectorizeSemanticRetriever`.** Embeds the query with the same profile
    through the same gateway, queries each requested project's namespace
    (all the release's projects without a project filter) for
    `min(limit, 50)` matches with metadata, and maps each match through the
    release it serves (rule 22). It applies the evidence filters to the
    release's chunk, drops non-positive scores, orders by score then chunk
    id, and returns `semanticRevisionId(profile)`. An embedding, dimension,
    or index error rejects, and it rejects as soon as the request's signal is
    aborted; `hybridSearch` turns that into `failed` or `timed-out`
    (Behavior 9). It imports no Cloudflare type: the index is the structural
    `VectorIndex` port, and nothing in `packages/search` or the response
    contract names Vectorize. Slice 2b does not call it from the web API.
22. **Consistency with releases.** The index is mutable and has one vector
    per passage; releases are immutable. A match becomes a candidate only when
    the release the query is served from holds a chunk of the same project,
    record, and ordinal whose fingerprint equals the vector's `h`, and the
    vector's `r` is the profile's revision. The candidate's ids come from the
    release's chunk, never from metadata. So a vector newer or older than the
    release, a vector of a removed chunk, and a vector of another revision
    are dropped; a chunk not yet embedded is simply absent. After a rollback
    to an older release, chunks whose passage is unchanged keep their
    semantic candidates and the rest fall back to lexical ranking until the
    next embedding run, which reconciles the index with whatever release is
    current. Release objects and `SearchResponseV1` are unchanged; the
    release a run embedded and its coverage (`releaseId`, `chunks`,
    `embedded`, `pending`) are in `/health` `searchEmbedding.lastRun`, not in
    the manifest, because a release is written before its vectors exist.
23. **A missing project.** Vectors of chunks the release no longer holds are
    deleted only for a project the release still holds at least one chunk of.
    When a release holds none of a project's chunks (an empty release is
    every project at once), that project's vectors and state are left as they
    are, the result reports `heldDeletes` and `absentProjects { projectId,
    vectors, releases }`, and the run is still `ok`. Each further release
    without the project counts once, however many runs read it; at the third
    in a row the vectors are deleted like any other, and the count with them.
    At one release an hour that is about three hours. A rollback to an older
    release is a release like any other: it counts when it lacks the project
    and ends the count when it holds it. A release that holds the
    project again ends the count, and nothing is embedded again.
24. **The last error, redaction, and quarantine.** The last model or
    vector-store failure that the run did not recover from is kept as
    `/health` `searchEmbedding.lastError { kind, message, at, batchSize }`
    until a later run embeds at least one chunk without a failure; a run that
    only reaches a bound leaves it. Every error text this path stores,
    returns, or logs (`lastError`, a run's `error` and `modelErrors`, the
    body of `POST /search-embedding/run`, `configError`, `console.error`) has
    `Bearer …` and every token replaced by `[redacted]` and is then cut to
    200 characters. A token is a run of 32 or more characters out of letters,
    digits, and `_ - + / =` (hex, base64, base64url), unless the run is a
    path: it holds a `/`, holds no `+` or `=`, and none of its words (split
    on `/ - _`) mixes lower-case and upper-case letters. In a path only a
    segment of 32 or more characters (a digest, an account id) is redacted.
    Object keys the run itself names are never touched. A text that fails alone (Behavior 25) in
    three runs in a row, at the same fingerprint and revision, is
    quarantined: skipped for 24 hours, then tried once more. A run reports
    `quarantined` and the first five ids. A changed chunk, another revision,
    and `reset=1` end a quarantine.
25. **Splitting a failed batch.** When a call for more than one text fails
    (not a refusal), each half is sent once; a half that succeeds is stored
    at once, a half that fails is halved again, down to single texts. A text
    that fails alone is struck (Behavior 24) and from then on is sent alone,
    so it cannot fail a batch again. Every call, probes included, is counted
    in the ledger before it is made and is subject to the deadline and the
    per-run and per-day bounds; a bound reached part-way leaves the stored
    halves stored and the rest pending and unstruck. One batch may spend at
    most `4 × ceil(log2 n)` calls on its parts (24 for 50: two bad texts);
    parts not reached wait for the next run.

    A failure is blamed on the texts, that is, a failed part is split
    further or a single text struck, only while the model demonstrably
    answers: a call of this run has succeeded and fewer than 3 calls have
    failed in a row since. Otherwise one probe text (`ok`) is embedded first.
    If the probe succeeds the work goes on; if it fails the model is down:
    the run stops embedding with `limited: model-down` and `ok: false`, and
    nothing is struck, whether the text was struck before or not. A refusal
    or a store failure stops the run as before and never splits.

    | Case | Model calls |
    | --- | --- |
    | One bad text in a batch of 50, first run | at most 15: 13 on texts (`1 + 2 × ceil(log2 50)`) and a probe per 3 failures in a row (12 in the test) |
    | That text in a later run (Behavior 26) | 1, or 2 with a probe (none succeeded yet in the run, or 3 failed in a row) |
    | That text once quarantined | at most 2 after 24 hours, then after 48, 96 … up to every 30 days: at most 8 calls in its first 30 days |
    | That text, first day | at most 19 |
    | All retries together | at most 10 calls a run and 100 of the day's 400, and none in a run that left healthy work |
    | Two bad texts in one batch | at most 33 (1 + 24 + probes) |
    | The model down from the start | 4 a run (batch, two halves, probe); 3 for a single text; 96 a day at one run an hour; no strike |
    | The model going down in mid-run | at most 4 after it stops (3 failures in a row, then the probe); no strike |
    | A transient error on one batch | 3 |
26. **Retries of texts that failed alone.** A text with a strike is never
    put in a batch again. In every run all chunks without a strike are
    embedded first; only then, and only if no bound stopped the run, are the
    struck texts whose quarantine is not running retried, oldest failure
    first, one call each (no second try; the blame rule of Behavior 25
    applies, so a failure is a new strike only while the model answers).
    Retries and their probes may use at most 10 calls a run and 100 calls a
    UTC day (`maxRetryCallsPerRun`, `maxRetryCallsPerDay`, counted apart in
    the day's ledger), so at least 300 of the day's 400 calls are never
    theirs; a retry that does not get a call is counted in
    `retriesDeferred`, a run's `retryCalls` says what it spent, and
    `estimate` counts only chunks without a strike. The first quarantine is
    24 hours; every further failed retry doubles it (48 h, 96 h …) up to 30
    days. A changed chunk, another revision, and `reset=1` end it.

Query-time hybrid search (slice 3):

27. **Shard roots.** When the publisher runs with `SEARCH_SHARD_ROOTS=true`
    each `shards[n]` of the manifest also carries `firstGroupRootRecordId`,
    the first group root the shard holds. The shard of a group is its
    project's last shard whose first root is not after the group's root, in
    the publisher's own order (`localeCompare`); a root before the
    project's first, a project the release does not hold, and a release in
    which any shard lacks the field have none. Unset or blank, the manifest
    and every other object are byte-identical to before; any other value
    fails the run before a source is polled, as an unknown lexical revision
    does. `/health` `lastRun.search.shardRoots` is `true` for a release
    that has them. No other object, schema, or revision changes.
28. **The query path.** With `SEARCH_SEMANTIC` unset or blank `/api/search`
    is the lexical reader: the same reads, no gate call, and a response
    byte-identical to before this slice. With `rrf-group@1` and the gate
    binding the reader reads the pointer and the manifest, asks the gate
    (Behavior 32) with the query and every project of the release, and
    meanwhile reads the terms object and the shards a query term names. A
    shard is ranked lexically and its semantic matches resolved once the
    gate has answered or the timeout has passed; then the shards that hold
    a match and no term are read. Every shard is read at most once, at most
    four at a time: at most 3 + shards reads a query. A match is located by
    its project and group root (Behavior 27) and accepted by Behavior 22:
    the shard holds a chunk of that record and ordinal with an equal
    fingerprint. Every field of a candidate comes from that chunk.
29. **Candidates, fusion, and results.** Up to 50 matches per project are
    asked for; the accepted ones are filtered exactly as lexical chunks are
    (source, tags, time bounds, the group's status) and then by the project
    filter. Lexical threads are ranked to depth 50 whatever the request's
    `limit`, so a thread's lexical rank does not depend on the limit.
    `fuseRankings` (`rrf-group@1`, k = 60) orders the threads: exact matches
    first, then score, then lexical rank, then id; the first `limit` are
    returned (`rrf-group@2`: Behavior 38). A thread lexical retrieval returned shows its lexical matches;
    a thread only semantic retrieval returned shows up to five of its
    passages, best first, each as the release's chunk: its text from the
    start, cut like a lexical excerpt (280 characters), its link, author,
    and time, `matchedTerms: []`, and no `signals.lexicalRank`. Its
    `detailRef` opens the same detail. A project's facet counts each thread
    once, lexical or semantic, before the project filter, so it does not
    change when a project is selected.
30. **Queries that are not embedded.** A query that can match exactly (one
    canonical identifier in any spelling a profile knows, a bare number, a
    structured identifier, or a dotted symbol) and a query with fewer than
    two letters or digits are answered lexically without a gate call:
    `skipped` with `identifier-query` or `short-query`. An identifier inside
    a longer query is embedded. Exact matches therefore never meet semantic
    candidates; if they did, fusion keeps them first.
31. **What the response says.** With the flag on, `retrieval` also carries
    `fusionRevision` (`rrf-group@1`), `semantic { status, reason?,
    candidates?, cached? }`, and, only when the status is `ok`,
    `semanticRevision`. `ok`: candidates were fused; `candidates` counts the
    passages that entered fusion and `cached` is true when no model call was
    made. Every other status is the lexical response unchanged: `disabled`
    (the request said `semantic=off`, or the gate has no embedding profile),
    `skipped` (Behavior 30), `uncovered` (the release has no shard roots or
    is a whole-release layout), `over-budget` (Behavior 34), `timed-out`
    (the gate took longer than 1,000 ms; the call is aborted), `failed`
    (anything else, including an unknown flag value and a missing binding).
    The status is HTTP 200 in every case and no error text is in the
    response; the reader logs the sanitized error. `semantic=off` is honoured
    only where the flag is on; elsewhere it is ignored. Each match's
    `signals` gains `semanticRank` when semantic retrieval returned its
    thread; `lexicalRank` is absent when lexical retrieval did not.
32. **The gate.** `SearchQueryGate` is a Durable Object class of the data
    Worker with one object (`search-query-gate-v1`), its own storage, and no
    public route. `POST /query { query, projectIds }` answers `{ status: ok,
    semanticRevision, cached, matches[] }`, `{ status: over-budget,
    retryAfterMs }`, `{ status: disabled }`, or `{ status: failed }`; a match
    is `{ projectId, recordId, ordinal, groupRootRecordId, fingerprint,
    score }`. It embeds with the embedding job's profile (`SEARCH_EMBEDDING`)
    through `SEARCH_GATEWAY_ID`, never the gateway cache and never the
    digest's gateway, and asks each project's namespace for 50 matches with
    metadata, dropping other revisions, malformed metadata, and non-positive
    scores. Without the profile it is `disabled`; with a profile and a
    missing gateway id, AI binding, index, or price it is `failed` and
    `/health` names what is missing. A text longer than 500 characters after
    normalization, an empty text, no project, or more than 8 projects is
    `failed` with nothing called.
33. **Caches.** The text embedded is the query in NFKC with runs of
    whitespace as one space, trimmed; case is kept. The cache key is a hash
    of the semantic revision and that text. The query embedding is stored
    for at least 7 days; each project's matches for 1 hour. A request whose
    projects all have fresh matches costs nothing; one with a stored
    embedding costs index queries only. Identical requests made at once
    share one answer. Evidence filters, the limit, and the release are not
    in the key: they are applied by the reader to the release's chunks. Each
    request that embeds also removes up to four entries past retention.
34. **Budget.** Per UTC day at most 1,000 neurons of query embeddings and
    1,000 index queries; per clock hour at most 100 model calls. A model
    call is charged before it is made, at an upper bound on what the model
    can bill for the text (its characters plus 3 tokens) and at least 1
    neuron; every accepted text is 1 neuron at the `bge-m3` price. A request
    that would pass a cap is `over-budget` with the time until the cap
    resets, and spends nothing; the index-query cap is checked before the
    model is called. Requests are counted one at a time, so concurrent
    queries cannot pass a cap together. The reader remembers per isolate
    that the budget is spent and does not call the gate until it resets.
    The gate's ledger is its own object's: it shares nothing with the
    embedding job's caps (Behavior 19) or the digest's.
35. **Gate failures and health.** A model error, a wrong number of vectors
    or dimension, a call that does not answer within 10 seconds, and an
    index error are `failed`; the charge stays in the ledger. A refusal by
    the platform (Workers AI code 3036, a gateway 429, a spend-limit
    refusal) also pauses model calls for 15 minutes: until then a query that
    needs an embedding is `over-budget`. An embedding already paid for is
    kept when the index fails. A cache write that fails does not fail the
    answer. `/health` `searchQuery` reports `enabled`, `configError`,
    `semanticRevision`, `today { date, neurons, modelCalls, indexQueries,
    hour, hourModelCalls, neuronCap, indexQueryCap, hourModelCallCap }`,
    `pausedUntil`, `lastError { kind, message, at }` (sanitized as in
    Behavior 24), and `sinceStart { requests, cached, embedded, overBudget,
    failed }`, counted in memory since the object last started.
36. **No method badge (superseded 2026-10-13).** As first built, a result
    none of whose matches has a `lexicalRank` showed a second badge beside
    "Evidence search": "Similar meaning" / 「意思相近」. The owner, after
    searching `KIP770` on Dev: readers do not care how a result was found;
    put the exact matches first and whatever else matched after them. Both
    badges are removed. A result card names no search method, and nothing
    in the UI reads `lexicalRank`, `semanticRank`, `semanticScore`, or
    `retrieval.semantic`; the response still carries them unchanged. The
    result list is owned by Spec 005 (S16–S18).
37. **Flags.** Pages: `SEARCH_SEMANTIC` (`rrf-group@1`) and the Durable
    Object binding `SEARCH_QUERY_GATE`. Worker: `SEARCH_SHARD_ROOTS`
    (`true`), the binding `SEARCH_QUERY_GATE` for `/health`, and the class's
    migration. This slice sets none of them in any deployed configuration.

Fusion `rrf-group@2` (2026-10-13):

38. **Fusion `rrf-group@2`.** The query's words are its distinct words after
    identifier normalization, cut at dots, hyphens, and case boundaries
    (`lexicalQueryWords`: `RequestManager` is `request`, `manager`). A
    lexical thread is a **full match** when one of its returned passages
    (the lexical evidence, at most five a thread) matched every word. The
    **leading full matches** are the lexical threads from rank 1 up to, and
    not including, the first that is not a full match. Order: lexical exact
    matches first; then the leading full matches in lexical order; then
    every other thread by the `rrf-group@1` score (k = 60), lexical rank,
    and id. The reported `score` is the RRF sum for every thread. It
    follows that with no semantic candidate the order is the lexical one;
    that when the first lexical thread is not a full match, or the query
    has no word any passage holds (a Chinese query), the order is
    `rrf-group@1`'s; and that a thread found by meaning alone is never
    shown above a leading full match. The function is pure and reads no
    similarity. Two consequences that are easy to miss:
    - **A one-word query with any lexical hit is lexical-first.** Every
      lexical thread holds the one word, so the whole lexical ranking is
      kept and semantic threads are appended after it (`txn`: the 8 lexical
      threads, then the threads found by meaning alone). Semantic retrieval
      cannot reorder such a query; it can only add to it.
    - **The rule engages only when the first lexical thread holds every
      query word in one passage.** When it does not, nothing is kept and
      the order is `rrf-group@1`'s, with its failure intact: a lexical
      first result that is not a semantic candidate still falls behind
      threads found twice (Results, "The verifier's clean set").
39. **Selecting the revision.** `SEARCH_SEMANTIC` names it: `rrf-group@1`
    or `rrf-group@2`, exactly, after trimming. Any other value answers
    lexically with `failed` (Behavior 28). `retrieval.fusionRevision` is
    the selected revision under every status. The gate is asked the same
    question whatever the revision and its caches hold no revision, so a
    switch costs no model call and no index query. Candidates, filters,
    facets, `semantic=off`, the statuses, and the timeout are unchanged.
40. **`signals.semanticScore`.** When the status is `ok`, every match of a
    thread that has a `semanticRank` also carries the similarity of the
    thread's best passage, as the index reported it for a match accepted by
    Behavior 22 (positive and finite). A thread without a semantic rank,
    and every response that is not fused, carries none.
41. **The replay.** `bun run capture:search-replay` asks a deployment each
    labelled query with `semantic=off` and hybrid (limit 50) and writes,
    per query, its terms, its words, and one row a thread: id, project,
    lexical rank, semantic rank, live fused rank, a term mask per returned
    passage, the exact flag, and the similarity when served. It refuses a
    pair of responses that disagree on a lexical rank or on the release.
    `bun run eval:search-fusion` replays the revisions and the weighed
    alternatives over the committed capture and prints the ablation.

Fusion `rrf-group@3` (2026-10-13):

43. **Fusion `rrf-group@3`.** `rrf-group@2`, then one pass over its order.
    The **head** is the lexical threads at ranks 1 to 3. The **background**
    of a query is the similarity of its 20th semantic thread, or of its
    last one when there are fewer. A semantic thread **stands out** when
    the similarity of its best passage is at least 0.04 above the
    background. The order is walked from the top; before a thread that
    does not stand out is placed, every head thread not yet placed that
    lexical search ranks above it (every head thread, when it has no
    lexical rank) is placed, in lexical order. So a head thread is
    preceded only by threads lexical search ranks above it, by standouts,
    and by exact matches; every other thread keeps its `rrf-group@2` order;
    no thread is dropped and no score changes. Kept full matches and exact
    matches are where `rrf-group@2` puts them. With no semantic candidate
    the order is the lexical one. A similarity that is not a finite number
    never stands out. A query whose every semantic thread is within 0.04
    of its 20th (`kafka release`, `txn`) has no standout: its three best
    lexical threads then lead in lexical order.
44. **Selecting it.** `SEARCH_SEMANTIC=rrf-group@3`, as Behavior 39. The
    gate is asked the same question; nothing else in the response changes.
45. **The scored capture and its report.** `bun run capture:search-replay`
    now records `signals.semanticScore`. `bun run eval:search-similarity`
    reads the committed capture and the hand labels and prints the
    separation of relevant from irrelevant candidates (by similarity, by
    distance to the best, by margin; by query type; Chinese against other
    queries) and the ablation of the score-aware alternatives by set.

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
   - **2b (this PR).** The embedding object, run, and state (H21–H23,
     H45–H49), the Vectorize adapter with the release consistency rule (H24,
     H43, H44, H50), `/health` and the trigger endpoint (H51), the cost
     measurement (H27). `SEARCH_EMBEDDING` is unset in both deployed
     configurations: nothing is embedded after the merge.
   - **Enable (done for Dev, 2026-10-12).** `wrangler.development.jsonc`
     sets `"SEARCH_EMBEDDING": "bge-m3@1"`, so each successful publication
     after that deploy triggers an embedding run (H52). Production is
     unchanged.
3. **Query-time wiring (this PR).** Shard roots in the manifest (H57), the
   query gate with its caches and budget (H30, H62–H64, H69), hybrid search
   in the Pages reader (H28, H29, H58–H61, H65, H66), the badge (H70), the
   calibrated neuron estimate (H67), and slice 4's query list and measuring
   command (H71). Every flag is unset and no binding is added: Dev and Prod
   answer as before. Enabling Dev is two configuration PRs (rollout below);
   H31 and H32 are observed then.
4. **Measured comparison** with the real model and the decision on rerank.
   H33. Measured at `rrf-group@1` on 2026-10-13 (Results): a net regression
   on queries lexical search already answered, so the fusion is fixed first.
5. **Fusion `rrf-group@2` (this PR).** The replay fixture and its capture
   command (H72, H81), the rule (H73, H80), `rrf-group@1` pinned (H74), the
   acceptance on the replay and on new queries (H75, H76), the revision
   selected by the flag (H77), `signals.semanticScore` (H78), and the
   timing command (H82). Dev's configuration is not changed: the switch is
   rollout step 7 (H79).

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

Slice 2b changes, all additive:

- New package `packages/semantic-vectorize` (Decision 15).
- `packages/reference-pipeline`: the price of `@cf/baai/bge-m3` in `PRICES`
  and `USD_PER_NEURON`.
- Publisher: `runDataPublication` takes `onPublished`; `/health` gains
  `searchEmbedding`; `POST /search-embedding/run`; the Worker exports
  `SearchEmbeddingRun`.
- Dev Worker configuration: `vectorize` binding `SEARCH_VECTORS` →
  `osskb-search-dev`, Durable Object `SEARCH_EMBEDDING_RUN` (migration `v3`),
  `SEARCH_GATEWAY_ID=osskb-search-dev`. Prod configuration: unchanged.
- Release objects, `SearchResponseV1`, and the Pages bundle: unchanged.
  `packages/search/test/fusion.test.ts` now runs the shared retriever
  contract; `golden-evaluation.v2.json` is byte-identical.

Rolling out embeddings on Dev. Preconditions, before slice 2b is merged
(the merge deploys the Dev Worker):

- The Vectorize index `osskb-search-dev` exists with 1,024 dimensions and
  the cosine metric (created 2026-10-10). A deploy that binds a missing index
  fails.
- The AI Gateway `osskb-search-dev` exists (created 2026-10-10: 600 requests
  an hour, a $2 per 30 days spend limit, authentication on). It is used only
  once the flag is set.
- The CI `CLOUDFLARE_API_TOKEN` may deploy a Worker with a Vectorize
  binding and the `v3` migration: confirmed by the Dev deploy of slice 2b
  (PR #50, 2026-10-10), which succeeded.

1. **Slice 2b merges.** The Dev deploy creates the object class and attaches
   the index. The flag is unset: the publisher has no trigger, no model or
   index call is made, `/health` `searchEmbedding.enabled` is `false`.
2. **Estimate (done 2026-10-10).** `POST
   /search-embedding/run?dryRun=1&profile=bge-m3@1` returns the chunks,
   calls, tokens, neurons, dollars, and runs (H52): 8,586 chunks, 172 calls,
   794 neurons, $0.0087, 3 runs (Results, "Dev dry run").
3. **Enable (done for Dev, 2026-10-12).** `"SEARCH_EMBEDDING": "bge-m3@1"`
   is set in `wrangler.development.jsonc` and the H45 configuration test
   pins Dev to `bge-m3@1` and Prod to unset. Each successful publication
   then triggers a run; the backfill takes about three. After the first real
   run, compare the tokens and neurons the gateway `osskb-search-dev` reports
   with `lastRun.estimatedInputTokens` and `estimatedNeurons`, and record the
   ratio in Results (the daily cap allows for 2×). The observations are
   listed under H52.
4. **Turn off.** Remove the variable (on Dev: revert the enable PR). No
   further call is made; stored vectors stay and are simply not updated. Nothing reads them before
   slice 3.
5. **Start over.** Delete and recreate the index (1,024 dimensions, cosine),
   then `POST /search-embedding/run?reset=1`; without the reset the state
   would still call every chunk embedded.
6. **A release rollback** needs no step here (Behavior 22).

Slice 3 changes, all additive:

- `packages/serving-contract`: `SearchShardRefV1.firstGroupRootRecordId?`,
  `SearchReleaseOptions.shardRoots`, `searchReleaseHasShardRoots`,
  `searchShardForGroupRoot`; `SearchResponseV1.retrieval` gains
  `fusionRevision?`, `semanticRevision?`, `semantic?`; a match's `signals`
  gains `semanticRank?` and `lexicalRank` becomes optional (as Spec 005
  declares both). No Cloudflare or Vectorize type is in the contract.
- `packages/search`: `isExactLexicalQuery`, `passageExcerpt`.
- `packages/semantic-vectorize`: the query gate (`SemanticQueryGate`, its
  port and answer types), `proposeSemanticMatches`, `acceptSemanticMatch`,
  and the sanitizer, moved here from the Worker so the reader shares it.
- `packages/reference-pipeline`: `EMBEDDING_TOKEN_CALIBRATION`,
  `embeddingNeurons`, `DAILY_NEURON_BUDGET`.
- Worker: the `SearchQueryGate` class (exported, not bound), the
  `SEARCH_SHARD_ROOTS` variable, `/health` `searchQuery` and
  `lastRun.search.shardRoots`; the embedding job reports calibrated neurons.
- Pages: `/api/search` reads `SEARCH_SEMANTIC`, `SEARCH_QUERY_GATE`, and the
  query parameter `semantic=off`; the web app shows the badge.
- Deployed configurations: unchanged.

What changes on Dev when slice 3 merges: `/health` gains `searchQuery`
(`enabled: false`, the caps, zero spend), and `searchEmbedding`'s
`estimatedNeurons` are 1.8 times what the same tokens gave before (the caps
are unchanged numbers). `/api/search` answers byte for byte as before; no
release object changes; nothing is embedded or queried at query time.

Enabling hybrid search on Dev. Nothing is created by hand: both steps are
configuration PRs that CI deploys. The owner approved the `SearchQueryGate`
class and the caps as shipped on 2026-10-13.

1. **Estimate (done 2026-10-12, no deployment).** `bun run
   measure:search-query-budget` prints the caps and what they can cost; `bun
   run measure:search-hybrid` recorded the lexical baseline (Example,
   slice 3).
2. **Worker PR (this change, 2026-10-13).**
   `apps/data-publisher-worker/wrangler.development.jsonc` sets
   `"SEARCH_SHARD_ROOTS": "true"`, binds `{ "name": "SEARCH_QUERY_GATE",
   "class_name": "SearchQueryGate" }`, and adds the migration `{ "tag": "v4",
   "new_sqlite_classes": ["SearchQueryGate"] }`; the H66 configuration test
   pins Dev to that and Prod to none of it. The Pages configuration is not
   touched: no visitor can reach the gate. To observe after the deploy
   (H32, first half), through public endpoints only:
   - `/health` `searchQuery.enabled` is `true`, with no `configError`,
     `semanticRevision` `@cf/baai/bge-m3@1:1024:title-text@1`, and `today`
     all zero. The deployed E2E asserts this on every run.
   - After the next publication (minute 7 of the hour): `/health`
     `lastRun.ok` is `true` and `lastRun.search.shardRoots` is `true`. The
     manifest itself is not served by any public route; `shardRoots` is
     computed from the manifest the run wrote (H57).
   - `/api/search` is unchanged for visitors: `retrieval` holds exactly
     `indexRevision`, `lexicalRevision`, `generatedAt`, `stale`, with or
     without `semantic=off` (asserted by the deployed E2E), and
     `searchQuery.sinceStart.requests` stays 0.
   - The embedding job is unaffected: after that publication
     `searchEmbedding.lastRun.ok` is `true` with `pending: 0` and no new
     `lastError`; `searchEmbedding.today` grows only by that run's calls.
   - Roll back: revert the PR. The next release has no shard roots and the
     gate is no longer bound for `/health`; the class stays deployed, and
     removing it later needs a `deleted_classes` migration.
3. **Pages PR (this change, 2026-10-13).** Precondition for merging: a
   release with shard roots is current on Dev (`/health`
   `lastRun.search.shardRoots: true`; the first is the publication after
   step 2's deploy). Without it every text query is `uncovered` until the
   next publication, which is harmless but shows nothing.
   - `apps/web/wrangler.development.jsonc` sets `"vars": {
     "SEARCH_SEMANTIC": "rrf-group@1" }` and `"durable_objects": {
     "bindings": [{ "name": "SEARCH_QUERY_GATE", "class_name":
     "SearchQueryGate", "script_name": "oss-knowledge-base-data-dev" }] }`.
     `wrangler.production.jsonc`, the local `wrangler.jsonc`, and both
     Worker configurations are untouched. The H66 test pins this.
   - What changes for visitors of Dev: a text query is fused with semantic
     candidates; a Chinese query that returned nothing returns threads; a
     thread found by meaning alone carries the "Similar meaning" badge
     (removed 2026-10-13, Behavior 36).
     Identifier queries and every failure mode answer as before.
   - The deployed E2E (`H32`) after each Dev deploy: the gate is enabled
     with no `configError`; `KIP770` is `skipped` (`identifier-query`);
     `交易逾時&semantic=off` is `disabled` with the lexical fields; `交易逾時`
     carries `fusionRevision` and a status among `ok`, `timed-out`,
     `over-budget`, `failed`, `uncovered`, asked up to four times, 2 s
     apart, for `ok`. It fails on a hard signal only: the field missing
     after 60 s, another status, the gate no longer enabled or with a
     `configError`, a ledger over its cap, or `failed` on every attempt.
     Otherwise it records the statuses and `/health` `searchQuery` as
     annotations. When fused, it also checks `semanticRevision`,
     `candidates`, `cached`, and that every result has a lexical or a
     semantic rank.
   - What the deployed E2E spends at the gate: three fixed text queries
     (`交易逾時`, and the older tests' `Kafka Streams` and `request manager`).
     The first run ever: 3 model calls (3 neurons) and 6 index queries.
     Every later run: 0 model calls while the embeddings are cached (at
     least 7 days) and at most 6 index queries, none when the previous run
     was within the hour. A day of ten deploys is at most 60 of the 1,000
     index queries.
   - Observe by hand after the deploy (H31, H32): `GET
     /api/search?q=交易逾時` has `retrieval.semantic.status` `ok` and
     results; the same query again says `cached: true`; `/health`
     `searchQuery.today` counts the calls and `lastError` is null; the
     gateway `osskb-search-dev` shows the calls and `osskb-digest-dev` does
     not; the badge shows on that query in the browser; then the
     measurement below.
   - Measurement (H31, and the input to H33): `bun run measure:search-hybrid
     -- --out <file>` against the public Dev API. 48 queries: the 21
     Spec 017 rows (the owner's query and `txn` among them), its 6 guard
     rows, the 16 implementer-labelled Chinese and vocabulary-gap queries,
     and 5 unlabelled abbreviation probes the owner asked about (`RM`,
     `ISR`, `HW`, `EOS`, `LSO`; with `txn` that is six abbreviations). Each
     is asked with `semantic=off`, hybrid, and hybrid again: 144 GETs, one a
     second. It reports ranks lexical against hybrid, statuses, latencies
     (cold, cached, added), `timedOutShare` (timed-out among the cold
     requests that reached the gate), regressions, the rerank rule, and for
     each probe the first five threads of both answers. Cost at the gate:
     at most 48 model calls (48 neurons; the four identifier rows make
     none, so 44 in fact) and 96 index queries, under the hourly 100 and the
     daily 1,000 and 1,000; a second run within 7 days makes no model call.
     The script refuses to start if its list could need more than 80 model
     calls in an hour.
   - Revert this PR when (verifier, PR #54): `timedOutShare` is above about
     0.3 and raising the timeout is not acceptable (otherwise raise it
     first); `searchQuery.lastError.kind` is `model` or `vector-store` on
     the first queries; or `searchQuery.pausedUntil` is set repeatedly (the
     platform keeps refusing). `over-budget` alone is not a reason: it is
     the cap working.
   - Rollback: revert the whole PR. `/api/search` is the lexical reader
     again, byte for byte. Removing only the variable is not enough for a
     green `main`: the deployed E2E's `H32` test and the H66 pin expect the
     hybrid configuration, so they have to go back with it.
4. **Turn off.** Revert the Pages PR (step 3): the next Pages deploy
   answers lexically, byte for byte as before. Without a
   deploy: every response already degrades by itself when the gate fails or
   the budget is spent. Removing `SEARCH_SHARD_ROOTS` makes the next release
   `uncovered`. The class and its stored cache may stay; deleting the class
   needs a `deleted_classes` migration.
5. **Pages rolled back below slice 3** answers lexically and ignores the
   binding, the flag, and the manifest field. **A release rollback** to a
   release without shard roots is `uncovered` until the next publication.
6. **Prod** gets none of this until it has an index, a gateway, and the
   embedding flag (open question 16).

7. **Switch Dev to `rrf-group@2` (done 2026-10-13, a separate PR after
   PR #57 was verified and deployed; H79).** No precondition beyond this change being deployed: the
   embeddings, the gate, and its caches are the same for both revisions.
   - The PR: in `apps/web/wrangler.development.jsonc`, `"SEARCH_SEMANTIC":
     "rrf-group@2"`; in `apps/web/test/search-hybrid.test.ts`, the `H66`
     pin of that value; the "Deployed configuration" row of
     `docs/feature-map.md`, the runbook's table row, and this spec's
     status. The deployed E2E needs no edit: it expects the revision the
     committed configuration names.
   - What changes for visitors of Dev: for a query whose best lexical
     threads hold all its words, those threads stay first instead of
     following threads found by both retrievers; other queries answer as
     today. No response field changes but `retrieval.fusionRevision`.
   - After the deploy: the deployed E2E is green; `GET
     /api/search?q=transaction+manager&limit=5` has `fusionRevision:
     rrf-group@2` and KAFKA-20237 and its pull request first and second;
     `/health` `searchQuery.today.modelCalls` did not move for cached
     queries; then `bun run measure:search-hybrid -- --out <file>` (no
     model call within 7 days of 2026-10-13; at most 96 index queries) must
     report no regression among the Spec 017 and guard rows and the Chinese
     and vocabulary-gap rows as on 2026-10-13, and `bun run
     capture:search-replay` records the similarities for open question 15.
   - Revert the switch when the measurement shows a row worse than
     lexical-only that the replay did not, or a gain lost.
   - Rollback: revert the one-line PR; the next Pages deploy answers with
     `rrf-group@1`. Nothing stored changes in either direction. Step 4
     still turns hybrid search off altogether.

8. **`rrf-group@3` is not switched on (Decision 50, 2026-10-13).** Dev
   remains on `rrf-group@2`. The value is accepted by the code and set
   nowhere. Do not switch until the embedding text has been revisited
   (open question 29) and `rrf-group@3` re-evaluated on a new capture. If
   it is ever switched, it is the same one-value change as step 7
   (`"SEARCH_SEMANTIC": "rrf-group@3"`, the `H66` pin, the feature map,
   the runbook, this status): no model call, no index query, no stored
   change, rollback by reverting it; then `bun run measure:search-hybrid`
   must show no Spec 017 or guard regression and no row worse than under
   `rrf-group@2` at its bound.

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

Embedding run (slice 2b), from
`apps/data-publisher-worker/test/search-embedding.cases.ts`. Each row runs
against a release of five chunks in two projects (two shards) with two texts
per model call, so three batches. `start` is `empty`, or `one extra` (all five
embedded plus one vector of a chunk the release no longer holds); `fault`
happens during the first run only; `days` is the UTC day of each run;
`expected` lists, per run, model calls, chunks embedded of chunks read,
vectors deleted, the bound reached, and `ok` or the failure kind:

<!-- test-plan:start apps/data-publisher-worker/test/search-embedding.cases.ts -->
| id | case | start | limits | fault | days | expected |
| --- | --- | --- | --- | --- | --- | --- |
| H21 | everything is embedded, then nothing is left to do | empty | — | — | 1 1 | 3 calls, 5/5 embedded, 0 deleted, not limited, ok → 0 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H21 | a vector the release dropped is deleted | one extra | — | — | 1 1 | 0 calls, 5/5 embedded, 1 deleted, not limited, ok → 0 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H46 | chunks per run | empty | maxChunksPerRun=3 | — | 1 1 | 2 calls, 3/5 embedded, 0 deleted, chunks-per-run, ok → 1 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H46 | model calls per run | empty | maxCallsPerRun=1 | — | 1 1 1 | 1 calls, 2/5 embedded, 0 deleted, calls-per-run, ok → 1 calls, 4/5 embedded, 0 deleted, calls-per-run, ok → 1 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H46 | model calls per UTC day | empty | maxCallsPerDay=2 | — | 1 1 2 | 2 calls, 4/5 embedded, 0 deleted, calls-per-day, ok → 0 calls, 4/5 embedded, 0 deleted, calls-per-day, ok → 1 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H46 | estimated neurons per UTC day | empty | dailyNeuronCap=2 | — | 1 1 2 | 2 calls, 4/5 embedded, 0 deleted, daily-neurons, ok → 0 calls, 4/5 embedded, 0 deleted, daily-neurons, ok → 1 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H46 | the deadline | empty | deadlineMs=1500 callMs=1000 | — | 1 1 | 2 calls, 4/5 embedded, 0 deleted, deadline, ok → 1 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H46 | a bound of zero embeds nothing | empty | maxChunksPerRun=0 | — | 1 | 0 calls, 0/5 embedded, 0 deleted, chunks-per-run, ok |
| H48 | a model error, then its halves succeed | empty | — | model: call 1 fails | 1 1 | 5 calls, 5/5 embedded, 0 deleted, not limited, ok → 0 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H55 | a batch and one half fail: the other half is embedded | empty | — | model: calls 2 and 3 fail | 1 1 | 5 calls, 4/5 embedded, 0 deleted, not limited, model → 1 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H55 | a batch and both halves fail while the model answers a probe | empty | — | model: calls 1, 2 and 3 fail | 1 1 | 6 calls, 3/5 embedded, 0 deleted, not limited, model → 2 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H55 | the model is down: one batch, its halves, and a probe | empty | — | model: every call fails | 1 1 | 4 calls, 0/5 embedded, 0 deleted, model-down, model → 3 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H48 | Workers AI code 3036 stops model use | empty | — | model: call 1 is refused with code 3036 | 1 1 | 1 calls, 0/5 embedded, 0 deleted, model-limit, model-limit → 3 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H48 | a gateway 429 stops model use | empty | — | model: call 2 is refused with a gateway 429 | 1 1 | 2 calls, 2/5 embedded, 0 deleted, model-limit, model-limit → 2 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H48 | a spend-limit refusal stops model use | empty | — | model: call 3 is refused for the spend limit | 1 1 | 3 calls, 4/5 embedded, 0 deleted, model-limit, model-limit → 1 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H48 | too few vectors | empty | — | model: calls 1 and 2 return one vector too few | 1 1 | 5 calls, 4/5 embedded, 0 deleted, not limited, model → 1 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H48 | a wrong dimension | empty | — | model: calls 1 and 2 return 3-dimension vectors | 1 1 | 5 calls, 4/5 embedded, 0 deleted, not limited, model → 1 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H48 | a model call that never answers | empty | callTimeoutMs=5 | model: calls 1 and 2 never answer | 1 1 | 5 calls, 4/5 embedded, 0 deleted, not limited, model → 1 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H48 | an upsert error, then success | empty | — | index: upsert 1 fails | 1 1 | 3 calls, 5/5 embedded, 0 deleted, not limited, ok → 0 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H48 | an upsert error twice stops embedding | empty | — | index: upserts 2 and 3 fail | 1 1 | 2 calls, 2/5 embedded, 0 deleted, vector-store, vector-store → 2 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H48 | an index that does not answer | empty | — | index: describe fails | 1 1 | 0 calls, 0/0 embedded, 0 deleted, not limited, vector-store → 3 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H48 | an index of other dimensions | empty | — | index: has 768 dimensions | 1 | 0 calls, 0/0 embedded, 0 deleted, not limited, config |
| H48 | a delete error, then success | one extra | — | index: delete 1 fails | 1 | 0 calls, 5/5 embedded, 1 deleted, not limited, ok |
| H48 | a delete error twice keeps the vector and its state | one extra | — | index: deletes 1 and 2 fail | 1 1 | 0 calls, 5/5 embedded, 0 deleted, not limited, vector-store → 0 calls, 5/5 embedded, 1 deleted, not limited, ok |
| H48 | an unreadable shard keeps what was embedded before it | empty | — | release: the second shard cannot be read | 1 1 | 1 calls, 2/3 embedded, 0 deleted, not limited, release-read → 2 calls, 5/5 embedded, 0 deleted, not limited, ok |
| H48 | an unreadable shard deletes nothing | one extra | — | release: the second shard cannot be read | 1 1 | 0 calls, 3/3 embedded, 0 deleted, not limited, release-read → 0 calls, 5/5 embedded, 1 deleted, not limited, ok |
| H48 | a manifest whose chunk count disagrees deletes nothing | one extra | — | release: the manifest declares 6 chunks | 1 1 | 0 calls, 5/5 embedded, 0 deleted, not limited, release-read → 0 calls, 5/5 embedded, 1 deleted, not limited, ok |
| H48 | a release that is not search-release.v3 | one extra | — | release: a search-release.v2 manifest | 1 | 0 calls, 0/0 embedded, 0 deleted, not limited, release-read |
| H48 | no current pointer | one extra | — | release: no current pointer | 1 | 0 calls, 0/0 embedded, 0 deleted, not limited, release-read |
<!-- test-plan:end -->

Shard roots (slice 3), from
`packages/serving-contract/test/search-shard-roots.cases.ts`. Each row
publishes `groups` (`project/groupRoot:chunks`, in the publisher's order)
with shard roots. `roots` lists `shard project firstGroupRoot` as the
manifest declares them; `lookups` lists `project/groupRoot=shard`, where
`none` means the release cannot hold that group:

<!-- test-plan:start packages/serving-contract/test/search-shard-roots.cases.ts -->
| id | case | maxShardChunks | groups | roots | lookups |
| --- | --- | --- | --- | --- | --- |
| H57 | one shard: its first root, a root between two groups, and one past the last | 4 | kafka/b:1 kafka/d:1 | 0 kafka b | kafka/b=0 kafka/c=0 kafka/d=0 kafka/z=0 |
| H57 | a root before the project's first, and another project | 4 | kafka/b:1 kafka/d:1 | 0 kafka b | kafka/a=none datafusion/b=none |
| H57 | each side of a shard boundary | 4 | kafka/b:2 kafka/d:2 kafka/f:2 | 0 kafka b; 1 kafka f | kafka/d=0 kafka/e=0 kafka/f=1 kafka/g=1 |
| H57 | two projects: a root is looked up among its own project's shards | 4 | datafusion/m:1 kafka/c:1 | 0 datafusion m; 1 kafka c | datafusion/m=0 datafusion/z=0 datafusion/a=none kafka/c=1 kafka/a=none kafka/n=1 |
| H57 | a group larger than the limit, alone in its shard | 4 | kafka/a:1 kafka/b:5 kafka/c:1 | 0 kafka a; 1 kafka b; 2 kafka c | kafka/a=0 kafka/b=1 kafka/bb=1 kafka/c=2 |
| H57 | the publisher's order, not code-point order: a < A < B < b10 < b2 < b9 | 4 | kafka/a:2 kafka/B:2 kafka/b10:2 kafka/b9:2 | 0 kafka a; 1 kafka b10 | kafka/A=0 kafka/B=0 kafka/b1=0 kafka/b10=1 kafka/b2=1 kafka/b9=1 |
| H57 | no groups | 4 |  |  | kafka/a=none |
<!-- test-plan:end -->

Hybrid search through the Pages reader (slice 3), from
`apps/web/test/search-hybrid.cases.ts`. Each row publishes golden v2 as a
search-release.v3 at `bm25-reference@3` (2 chunks per shard, 12 shards) and
searches it with hybrid search on. `release`: `roots` declares shard roots,
`no roots` does not, `v2` is the whole-release layout. `gate`: `answers` is
the real query gate over a fake concept embedder and a fake vector index;
otherwise a gate that `throws`, `never answers` (timeout 20 ms), is `over
budget`, is `disabled`, or `must not be asked`. `results` are the threads in
rank order; `semanticOnly` are those no lexical match returned. A row whose
status is not `ok` must also equal the lexical response:

<!-- test-plan:start apps/web/test/search-hybrid.cases.ts -->
| id | case | query | projects | release | gate | status | reason | results | semanticOnly |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H28 | a Chinese query finds English threads | 交易逾時 | — | roots | answers | ok | — | kafka:jira:issue:KAFKA-20785 kafka:jira:issue:KAFKA-20734 | kafka:jira:issue:KAFKA-20785 kafka:jira:issue:KAFKA-20734 |
| H28 | an abbreviation: the lexical thread stays first, a second one is added | txn | — | roots | answers | ok | — | kafka:jira:issue:KAFKA-20785 kafka:jira:issue:KAFKA-20734 | kafka:jira:issue:KAFKA-20734 |
| H28 | a thread both retrievers return rises from 4th to 1st | cold data | — | roots | answers | ok | — | kafka:wiki:kip-405 kafka:jira:issue:KAFKA-20397 datafusion:github:issue:19877 datafusion:github:pull:770 datafusion:github:issue:20983 | — |
| H28 | both retrievers agree: the order is the lexical one | transaction timeout | — | roots | answers | ok | — | kafka:jira:issue:KAFKA-20785 kafka:jira:issue:KAFKA-20734 | — |
| H28 | no semantic candidate: the lexical order | consumer network thread request manager | — | roots | answers | ok | — | kafka:jira:issue:KAFKA-19804 kafka:jira:issue:KAFKA-19738 kafka:jira:issue:KAFKA-19919 kafka:github:pull:22747 kafka:mail:dev:release-manager-4-4-0 kafka:wiki:kip-405 kafka:jira:issue:KAFKA-20397 kafka:github:issue:20983 datafusion:github:pull:770 kafka:github:pull:22458 kafka:jira:issue:KAFKA-20785 kafka:github:issue:20970 | — |
| H59 | the project filter keeps semantic threads of that project | 交易逾時 | apache-kafka | roots | answers | ok | — | kafka:jira:issue:KAFKA-20785 kafka:jira:issue:KAFKA-20734 | kafka:jira:issue:KAFKA-20785 kafka:jira:issue:KAFKA-20734 |
| H59 | the project filter drops semantic threads of another project | 交易逾時 | apache-datafusion | roots | answers | ok | — | — | — |
| H61 | two letters are enough to ask | 交易 | — | roots | answers | ok | — | kafka:jira:issue:KAFKA-20734 kafka:jira:issue:KAFKA-20785 | kafka:jira:issue:KAFKA-20734 kafka:jira:issue:KAFKA-20785 |
| H61 | one letter is not | 交 | — | roots | must not be asked | skipped | short-query | — | — |
| H61 | one letter among punctuation is not | ?? a !! | — | roots | must not be asked | skipped | short-query | kafka:jira:issue:KAFKA-19804 kafka:jira:issue:KAFKA-20734 kafka:mail:dev:kip-770-discuss kafka:mail:dev:release-manager-4-4-0 kafka:github:issue:20970 kafka:wiki:kip-405 datafusion:github:issue:20983 datafusion:github:issue:19877 kafka:github:issue:20983 kafka:jira:issue:KAFKA-20397 kafka:jira:issue:KAFKA-20785 | — |
| H61 | an identifier without its hyphen | KIP770 | — | roots | must not be asked | skipped | identifier-query | kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss datafusion:github:pull:770 kafka:wiki:kip-405 kafka:jira:issue:KAFKA-770 kafka:wiki:kip-1150 kafka:jira:issue:KAFKA-19804 | — |
| H61 | a bare number | 770 | — | roots | must not be asked | skipped | identifier-query | datafusion:github:pull:770 kafka:jira:issue:KAFKA-770 kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss | — |
| H61 | a code symbol | RecordAccumulator.ready() | — | roots | must not be asked | skipped | identifier-query | kafka:github:pr:23203 kafka:mail:dev:kip-770-discuss | — |
| H61 | an identifier inside a longer query is asked | KIP770 transaction | — | roots | answers | ok | — | kafka:jira:issue:KAFKA-20734 kafka:jira:issue:KAFKA-20785 kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss datafusion:github:pull:770 kafka:wiki:kip-405 kafka:jira:issue:KAFKA-770 kafka:wiki:kip-1150 kafka:jira:issue:KAFKA-19804 | — |
| H29 | the gate throws | txn | — | roots | throws | failed | — | kafka:jira:issue:KAFKA-20785 | — |
| H29 | the gate throws and lexical search finds nothing | 交易逾時 | — | roots | throws | failed | — | — | — |
| H29 | the gate never answers | txn | — | roots | never answers | timed-out | — | kafka:jira:issue:KAFKA-20785 | — |
| H29 | the day's budget is spent | txn | — | roots | over budget | over-budget | — | kafka:jira:issue:KAFKA-20785 | — |
| H29 | the gate is disabled | txn | — | roots | disabled | disabled | — | kafka:jira:issue:KAFKA-20785 | — |
| H65 | a release without shard roots | txn | — | no roots | must not be asked | uncovered | — | kafka:jira:issue:KAFKA-20785 | — |
| H65 | a whole-release (search-release.v2) layout | txn | — | v2 | must not be asked | uncovered | — | kafka:jira:issue:KAFKA-20785 | — |
<!-- test-plan:end -->

Queries for the measured comparison (slice 4 preparation), from
`apps/web/test/search-hybrid-eval.cases.ts`. `bun run measure:search-hybrid`
asks the public Dev API these, the 21 Spec 017 rows, and its 6 guard rows,
each once with `semantic=off` and once hybrid. They were written on
2026-10-12 before any hybrid output existed, from thread titles in the Spec
017 snapshot. A row is met when every `expected` thread ranks within
`within`. **Every row is implementer-labelled, owner to confirm**; the first
two queries are the owner's examples:

<!-- test-plan:start apps/web/test/search-hybrid-eval.cases.ts -->
| id | kind | labels | query | expected | acceptable | within | why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H71 | chinese | implementer | 交易逾時 | kafka:jira:issue:KAFKA-20237 kafka:github:pull:23547 | kafka:jira:issue:KAFKA-20785 kafka:github:pull:23204 kafka:jira:issue:KAFKA-21181 kafka:github:pull:23630 kafka:github:pull:19276 | 10 | The owner's example query (transaction timeout). No title says timeout; the stuck TransactionManager (KAFKA-20237) is the closest, other transaction threads are acceptable. |
| H71 | chinese | implementer | 消費者重新平衡很慢 | kafka:jira:issue:KAFKA-21249 kafka:github:pull:23760 | kafka:github:pull:23115 kafka:github:pull:20863 | 10 | The owner's example query (consumer rebalance is slow). No title says slow; pre-rebalance auto-commit retries (KAFKA-21249) is the closest. |
| H71 | chinese | implementer | 分層儲存的配額沒有生效 | kafka:jira:issue:KAFKA-19968 kafka:github:pull:21108 | kafka:github:pull:23456 | 5 | Tiered storage quota not enforced: KAFKA-19968 and its pull request. |
| H71 | chinese | implementer | 重新認證失敗後 CPU 使用率過高 | kafka:github:pull:21714 | kafka:github:pull:23348 kafka:jira:issue:KAFKA-21031 kafka:github:pull:23357 | 5 | KAFKA-20253: high CPU loop after failed re-authentication; the busy-loop threads are acceptable. |
| H71 | chinese | implementer | 反向 DNS 查詢阻塞網路執行緒 | kafka:jira:issue:KAFKA-19919 kafka:github:pull:22569 | — | 5 | KAFKA-19919: network threads blocked by synchronous reverse DNS lookups. |
| H71 | chinese | implementer | 心跳請求的初始間隔 | kafka:jira:issue:KAFKA-19804 kafka:github:pull:23687 | kafka:github:pull:20964 | 5 | KAFKA-19804: heartbeat request manager initial HB interval. |
| H71 | chinese | implementer | 排序合併連接溢出到磁碟時遺失資料列 | datafusion:github:pull:24056 | datafusion:github:pull:23988 datafusion:github:pull:24192 datafusion:github:pull:25250 datafusion:github:pull:22230 | 5 | DataFusion: keep every spilled slice of a sort-merge join inner key group; other sort-merge spill threads are acceptable. |
| H71 | chinese | implementer | 發布流程移除 MD5 校驗檔 | kafka:github:pull:23654 | — | 5 | KAFKA-21183: remove MD5 and SHA-1 checksum files from the release process. |
| H71 | vocabulary-gap | implementer | controller sign-up retried after timing out | kafka:github:pull:19321 | — | 5 | KAFKA-18874: Fix KRaft controller registration retry on timeout; the title says registration. |
| H71 | vocabulary-gap | implementer | SMJ spill | datafusion:github:pull:24056 datafusion:github:pull:23988 datafusion:github:pull:22230 | datafusion:github:pull:24192 datafusion:github:pull:25250 | 10 | SMJ abbreviates sort-merge join; the titles spell it out. |
| H71 | vocabulary-gap | implementer | two-phase commit | kafka:github:pull:21735 | — | 5 | KAFKA-15370: Support Participation in 2PC (KIP-939); the title says 2PC. |
| H71 | vocabulary-gap | implementer | client spins at 100% cpu | kafka:github:pull:21714 kafka:jira:issue:KAFKA-21031 kafka:github:pull:23357 kafka:github:pull:23348 | — | 10 | The titles say high CPU loop and busy loop. |
| H71 | vocabulary-gap | implementer | remote storage file handle not closed | kafka:jira:issue:KAFKA-20967 kafka:github:pull:23211 | kafka:github:pull:23604 | 5 | KAFKA-20967: RemoteLogManager.read() leaks the remote segment InputStream. |
| H71 | vocabulary-gap | implementer | hash join that fits in limited RAM | datafusion:github:issue:24768 | — | 5 | DataFusion: [EPIC] Spilling Hash Join, run any join in a bounded memory budget. |
| H71 | vocabulary-gap | implementer | mark directory as failed on disk error | kafka:jira:issue:KAFKA-16304 kafka:github:pull:23697 | — | 5 | KAFKA-16304 and KAFKA-13468: take the log dir offline on a disk I/O error. |
| H71 | vocabulary-gap | implementer | HB interval | kafka:jira:issue:KAFKA-19804 kafka:github:pull:23687 | — | 5 | HB abbreviates heartbeat; KAFKA-19804's title holds both spellings. |
<!-- test-plan:end -->

Queries added on 2026-10-13 against fitting `rrf-group@2` to the measured
rows, from `apps/web/test/search-fusion-new.cases.ts`. They were written
before the rule was chosen and before any `rrf-group@2` output existed,
from thread titles the public Dev API had shown, asked once, and not
edited since. `lexical-right`: the title holds the words, so hybrid search
must not make the row worse; `gap`: other words or another language, so it
should help. **Every row is implementer-labelled, owner to confirm**:

<!-- test-plan:start apps/web/test/search-fusion-new.cases.ts -->
| id | kind | labels | query | expected | within | why |
| --- | --- | --- | --- | --- | --- | --- |
| H76 | lexical-right | implementer | ClientQuotaMetadataManager | kafka:jira:issue:KAFKA-19818 kafka:github:pull:23555 | 2 | KAFKA-19818: Move ClientQuotaMetadataManager to metadata module, and its pull request: the only two titles naming the class. |
| H76 | lexical-right | implementer | LogManagerBuilder | kafka:jira:issue:KAFKA-21038 kafka:github:pull:23385 | 2 | KAFKA-21038: Move LogManagerBuilder to jmh module, and its pull request. |
| H76 | lexical-right | implementer | stale transaction coordinator cache | kafka:github:pull:23630 kafka:jira:issue:KAFKA-21181 | 3 | KAFKA-21181: Return NOT_COORDINATOR from a stale transaction coordinator cache: the title holds the four words. |
| H76 | lexical-right | implementer | record collector offsets | kafka:github:pull:23791 kafka:jira:issue:KAFKA-21253 | 3 | KAFKA-21253: Always clear record collector offsets in closeDirty, and its issue. |
| H76 | lexical-right | implementer | push down topk through join | datafusion:github:pull:21621 datafusion:github:pull:25093 | 3 | DataFusion: Push down topk through join, and its benchmark-only rebase. |
| H76 | lexical-right | implementer | windowed restore optimisation | kafka:jira:issue:KAFKA-20876 | 3 | KAFKA-20876: Windowed restore optimisation gives up when endOffset-1 is a transaction marker. |
| H76 | lexical-right | implementer | PartitionsWithLateTransactionsCount | kafka:github:pull:23625 | 1 | MINOR: Add PartitionsWithLateTransactionsCount description to monitoring.md: the only title naming the metric. |
| H76 | gap | implementer | 交易協調器回傳過期的快取結果 | kafka:github:pull:23630 kafka:jira:issue:KAFKA-21181 | 5 | Chinese for: the transaction coordinator returns a stale cached result (KAFKA-21181). |
| H76 | gap | implementer | 長時間重新平衡造成記憶體不足 | kafka:jira:issue:KAFKA-21230 | 5 | Chinese for: a long rebalance causes out of memory (KAFKA-21230: Long rebalances can cause OOM errors). |
| H76 | gap | implementer | out of memory during a long rebalance | kafka:jira:issue:KAFKA-21230 | 5 | KAFKA-21230; the title says OOM. |
| H76 | gap | implementer | abandon a hanging transaction from the command line | kafka:jira:issue:KAFKA-19003 kafka:github:pull:19276 | 5 | KAFKA-19003: Add force-terminate feature to kafka-transactions CLI; the titles say force-terminate and CLI. |
| H76 | gap | implementer | commit markers lost when a partition is unavailable | kafka:jira:issue:KAFKA-20734 | 5 | KAFKA-20734: Offline partition can cause loss of transaction markers. |
| H76 | gap | implementer | how to report a vulnerability | datafusion:github:pull:25917 | 5 | DataFusion: Add SECURITY.md for DataFusion; no title says vulnerability. |
| H76 | gap | implementer | 用戶端配額數值檢查 | kafka:github:pull:23646 | 5 | Chinese for: client quota value validation (MINOR: Validate client quota values and cap throttle time to int range). |
<!-- test-plan:end -->

The verifier's clean set for PR #57, from
`apps/web/test/search-fusion-verifier.cases.ts`: 20 queries the verifier
wrote before running `rrf-group@2`, with its expected threads, copied
unchanged. The bound of 5 is the implementer's; **labelled by the
verifier, owner to confirm**:

<!-- test-plan:start apps/web/test/search-fusion-verifier.cases.ts -->
| id | kind | labels | query | expected | within |
| --- | --- | --- | --- | --- | --- |
| H83 | lexical-right | verifier | LogManager cleanup | kafka:jira:issue:KAFKA-20390 kafka:github:pull:23772 kafka:github:pull:23385 kafka:jira:issue:KAFKA-21038 | 5 |
| H83 | lexical-right | verifier | ReplicaManager fetch | — | 5 |
| H83 | lexical-right | verifier | StreamsPartitionAssignor | kafka:jira:issue:KAFKA-20790 kafka:github:pull:23597 kafka:github:pull:23706 | 5 |
| H83 | lexical-right | verifier | max.poll.interval.ms | kafka:jira:issue:KAFKA-19804 kafka:github:pull:23348 | 5 |
| H83 | lexical-right | verifier | remote.log.storage.enable | kafka:github:pull:23626 kafka:github:pull:23569 kafka:jira:issue:KAFKA-17249 | 5 |
| H83 | lexical-right | verifier | SortMergeJoinExec spill | datafusion:github:pull:23988 datafusion:github:issue:25205 | 5 |
| H83 | lexical-right | verifier | ListingTable partition pruning | datafusion:github:pull:25212 datafusion:github:issue:26130 datafusion:github:pull:25819 datafusion:github:issue:23341 datafusion:github:pull:23402 | 5 |
| H83 | lexical-right | verifier | unclean leader election | kafka:github:pull:23680 kafka:github:pull:20610 | 5 |
| H83 | lexical-right | verifier | offset commit callback | kafka:github:pull:21359 kafka:jira:issue:KAFKA-21229 kafka:github:pull:23725 | 5 |
| H83 | gap | verifier | consumer stuck after network timeout | kafka:jira:issue:KAFKA-17734 kafka:jira:issue:KAFKA-21220 kafka:github:pull:23714 | 5 |
| H83 | gap | verifier | broker runs out of file descriptors | kafka:jira:issue:KAFKA-20967 kafka:github:pull:23211 kafka:github:pull:23604 | 5 |
| H83 | gap | verifier | slow group rebalance memory | kafka:jira:issue:KAFKA-21230 | 5 |
| H83 | gap | verifier | producer blocked on metadata | kafka:github:pull:23474 kafka:github:pull:23753 kafka:jira:issue:KAFKA-21243 | 5 |
| H83 | gap | verifier | deduplicate strings when spilling | datafusion:github:pull:23565 datafusion:github:pull:25716 | 5 |
| H83 | gap | verifier | config value validation for client quotas | kafka:github:pull:23640 kafka:github:pull:23641 | 5 |
| H83 | gap | verifier | merge join loses rows | datafusion:github:issue:26115 datafusion:github:pull:24336 datafusion:github:issue:25957 | 5 |
| H83 | gap | verifier | vulnerability disclosure process | datafusion:github:pull:25917 | 5 |
| H83 | chinese | verifier | 日誌管理器 | kafka:jira:issue:KAFKA-20390 kafka:github:pull:23772 kafka:github:pull:23385 kafka:jira:issue:KAFKA-21038 | 5 |
| H83 | chinese | verifier | 分區領導者選舉 | kafka:github:pull:20610 kafka:github:pull:23680 | 5 |
| H83 | chinese | verifier | 遠端儲存指標 | kafka:github:pull:23463 kafka:github:pull:23508 | 5 |
<!-- test-plan:end -->

Ten clean queries for `rrf-group@3`, from
`apps/web/test/search-fusion-clean3.cases.ts`, written and labelled after
its constants were fixed and before it ran on them. **Implementer-labelled,
owner to confirm**:

<!-- test-plan:start apps/web/test/search-fusion-clean3.cases.ts -->
| id | kind | labels | query | expected | within |
| --- | --- | --- | --- | --- | --- |
| H84 | lexical-right | implementer | AsyncKafkaConsumer bug | kafka:github:pull:23756 kafka:github:pull:23123 kafka:jira:issue:KAFKA-21229 | 5 |
| H84 | lexical-right | implementer | ClientQuotaMetadataManager migration | kafka:jira:issue:KAFKA-19818 kafka:github:pull:23555 | 5 |
| H84 | lexical-right | implementer | LogManagerBuilder removal | kafka:github:pull:23385 kafka:jira:issue:KAFKA-21038 | 5 |
| H84 | lexical-right | implementer | stale coordinator cache fix | kafka:github:pull:23630 kafka:jira:issue:KAFKA-21181 | 5 |
| H84 | lexical-right | implementer | windowed restore optimisation backport | kafka:github:pull:23434 kafka:jira:issue:KAFKA-20876 kafka:github:pull:23435 | 5 |
| H84 | lexical-right | implementer | push down topk join benchmark | datafusion:github:pull:25093 datafusion:github:pull:21621 datafusion:github:pull:22760 | 5 |
| H84 | lexical-right | implementer | heartbeat request manager performance | kafka:jira:issue:KAFKA-19804 kafka:github:pull:23687 kafka:github:pull:20964 | 5 |
| H84 | gap | implementer | why does the controller not retry registering | kafka:jira:issue:KAFKA-18874 kafka:github:pull:19321 | 5 |
| H84 | gap | implementer | 安全性政策 | datafusion:github:issue:25916 datafusion:github:pull:25917 | 5 |
| H84 | gap | implementer | CPU busy loop after login failure | kafka:github:pull:21714 kafka:jira:issue:KAFKA-20253 | 5 |
<!-- test-plan:end -->

Hand labels of semantic candidates, from
`apps/web/test/search-similarity-labels.cases.ts`: one letter for each of
a query's first seven semantic threads (`R` relevant, `P` partly, `I`
irrelevant), judged from titles before any score-aware rule was tried.
**Implementer-labelled, owner to confirm**:

<!-- test-plan:start apps/web/test/search-similarity-labels.cases.ts -->
| id | type | query | judgements |
| --- | --- | --- | --- |
| H88 | english phrase | transaction manager | PIPPPPP |
| H88 | english phrase | kafka release | IIIIIII |
| H88 | english phrase | tiered storage | PPRRRRR |
| H88 | class name | CommitRequestManager | IIIPIIR |
| H88 | class name | StreamsPartitionAssignor | PPPPIPP |
| H88 | class name | LogManager cleanup | RIIIIII |
| H88 | chinese | 交易逾時 | RPIIPIP |
| H88 | chinese | 重新認證失敗後 CPU 使用率過高 | RRIIIII |
| H88 | chinese | 分區領導者選舉 | RIIIIII |
| H88 | chinese | 日誌管理器 | IIRIIII |
| H88 | paraphrase | controller sign-up retried after timing out | RRIIIII |
| H88 | paraphrase | broker runs out of file descriptors | IIIIIII |
| H88 | paraphrase | how to report a vulnerability | RIIPIII |
| H88 | paraphrase | consumer network thread request manager | RRIIIII |
| H88 | one word | txn | IIIIIII |
| H88 | one word | ISR | PRRIIII |
<!-- test-plan:end -->

## Acceptance

Items tagged `[pending]` belong to slice 4.

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
- H29: given each `H29` row of the hybrid plan and a gate that throws,
  answers `failed` or nonsense, never answers, is over budget, or is
  disabled, `/api/search` returns HTTP 200 with exactly the lexical response
  plus `retrieval.fusionRevision` and `retrieval.semantic.status` (`failed`,
  `timed-out`, `over-budget`, `disabled`); no error text is in the body and
  the thrown error is logged once, sanitized; a gate slower than the timeout
  is aborted, its later rejection is handled, and one answering in time is
  used; the timeout's timer is cleared when the gate answers or fails first
  and the default is 1,000 ms; after an `over-budget` answer the isolate
  does not ask again until the stated time, and one millisecond later it
  does; with the real gate over its cap, queries fall back in mid-day while
  cached ones still answer; on all 27 Spec 017 real-corpus and guard queries
  over 1,134 real chunks, hybrid search with a failing gate, `semantic=off`,
  a gate with no match, or an unusable flag equals the lexical response →
  evidence: `search-hybrid.test.ts`.

### Behavior (slice 2b)
- H21: given a published release and `SEARCH_EMBEDDING=bge-m3@1`, a run embeds
  every chunk through the search gateway with `@cf/baai/bge-m3` and upserts
  one vector per passage (id = hash of project, record, and ordinal;
  Decision 9, confirmed by the owner 2026-10-12) into its project's
  namespace; a second run on the same
  release makes no model call and no mutation; a new `sourceVersion` with the
  same title, text, and group is not embedded again; a changed text is
  embedded alone and replaces the vector under the same id; a removed chunk's
  vector is deleted → evidence: `search-embedding-run.test.ts`.
- H22: given a profile that differs in model, model revision, dimensions, or
  text assembly, every chunk is embedded again in place, and the retriever
  returns no candidate from a vector of another revision, during and after
  the change → evidence: `search-embedding-run.test.ts`, `retriever.test.ts`.
- H24: given an index filled by the publisher's own vector function, the
  adapter passes every row of the `SemanticRetriever` contract the in-memory
  retriever passes (ranking, revision, limit, tie order, evidence filters),
  queries only the namespaces of the requested projects, and imports no
  Cloudflare type → evidence: `retriever.test.ts`, the contract in
  `packages/search/test/support/semantic-retriever-contract.ts`.
- H43: given any record id (long, non-ASCII) the vector id is 48 hex
  characters, at most 64 bytes, and differs by project, record, and ordinal;
  the metadata holds only `r`, `h`, `record`, `ord`, `root` and stays under
  10 KiB or the vector is refused; a model call carries at most 50 texts and
  20,000 estimated tokens and a delete at most 100 ids; the fake index
  enforces Vectorize's documented limits (64-byte id and namespace, 10 KiB
  metadata, dimensions, 1,000 vectors per upsert, `topK` 50 with metadata) →
  evidence: `vector.test.ts`, `search-embedding-run.test.ts`.
- H44: given a release and an index, a match is a candidate only when the
  release holds a chunk of the same project, record, and ordinal with the
  vector's fingerprint, and its ids are the release's; a vector of a changed,
  regrouped, or removed chunk, of another project's namespace, with malformed
  metadata, or newer than a rolled-back release is dropped, while an
  unchanged passage keeps its candidate across releases → evidence:
  `retriever.test.ts`.
- H45: given `SEARCH_EMBEDDING` unset or blank, a publication writes
  byte-identical objects, the publisher has no embedding trigger, and a run
  or alarm of the embedding object calls no model and no index; given the
  flag, a successful publication triggers one embedding run and a failed one
  none; given an unsupported value or a missing gateway id, AI binding, or
  index, the embedding run fails naming it and calls nothing while the
  publication still succeeds; the Dev configuration binds the index, the
  object, and `SEARCH_GATEWAY_ID=osskb-search-dev` (not the digest gateway)
  and sets `SEARCH_EMBEDDING=bge-m3@1` (since H52; without the flag the same
  configuration is off), and the Prod configuration has none of them →
  evidence:
  `search-embedding-runner.test.ts`, `pipeline.test.ts`.

### Failure and retry (slice 2b)
- H23: given a trigger that throws, never answers, or answers an error, the
  publication's result, objects, and recorded status are those of a run
  without it; given a Workers AI or Vectorize failure during an embedding
  run, vectors stored earlier are untouched and still answer queries, and
  `/health` `searchEmbedding.lastRun` shows `ok: false` with the error →
  evidence: `pipeline.test.ts`, `search-embedding-run.test.ts`,
  `search-embedding-runner.test.ts`.
- H46: given each `H46` row of the embedding run plan, a run that reaches a
  bound (chunks or model calls per run, model calls or neurons per UTC day,
  the deadline) stops embedding, records what it stored, reports `limited`,
  and later runs embed only the rest, until nothing is pending; given model
  calls that each take their whole 30-second timeout, no call (batch, half,
  single-text retry, probe) starts at or after the deadline, a deadline that
  falls inside a split leaves the stored halves stored and the rest pending
  and unstruck, a call due exactly at the deadline does not start, and the run ends within `worstCaseWallMs`, which is 695
  seconds for the default bounds and under 12 minutes → evidence:
  `search-embedding-run.test.ts` rows and tests.
- H47: given a run that dies after the model answered, after the upsert was
  accepted, or while the state is written, the retried run embeds at most
  that batch again, the day's ledger holds both attempts, the state names
  exactly the vectors in the index, and no chunk has two vectors; an alarm
  that throws is recorded and does not throw again → evidence:
  `search-embedding-run.test.ts`, `search-embedding-runner.test.ts`.
- H48: given each `H48` row of the embedding run plan (a model error whose
  halves then succeed, code 3036, a gateway 429, a spend-limit refusal, too few vectors, a
  wrong dimension, a call that never answers, an upsert or delete that fails
  once or twice, an index that does not answer or has other dimensions, an
  unreadable shard, a manifest whose chunk count disagrees, an unsupported
  release), the run ends as listed and deletes nothing it could not verify →
  evidence: `search-embedding-run.test.ts` rows.
- H53: given a release with no chunk at all, or none of one project, the
  run deletes none of that project's vectors, leaves its state, and reports
  `heldDeletes` and `absentProjects`, while a chunk dropped from a project
  the release still holds is deleted as before; the same release read twice
  counts once and a dry run counts nothing; a project that returns is neither
  deleted nor embedded again and its count starts over; at the third release
  in a row without it its vectors are deleted and the count removed in that
  run → evidence:
  `search-embedding-run.test.ts`.
- H54: given a model or vector-store failure, `/health`
  `searchEmbedding.lastError` holds its kind, message, time, and batch size
  through runs that only reach a bound and through a dry run, until a run
  embeds without a failure; given a bearer token, a base64 string with
  `+ / =`, or a long hex string in an error from the model, the index, the
  bucket, or the storage, no result, stored value, HTTP body, or log line of
  the embedding path holds it (the publisher's log lines for a failed
  trigger included), redaction comes before the 200-character cut, and the
  object key in a release-read error stays; given each sanitizer row (an R2
  key path and a gateway URL path kept, a digest, a 48-hex id, base64 with
  `/` `+` `=`, a bearer token with slashes redacted, 31 characters kept and
  32 redacted, for a run and for a path segment) the text is as listed; given a text that fails
  alone in three runs in a row, later runs skip it, report `quarantined` and
  its id, and spend no call on it for 24 hours, then try once (H56 for what
  follows); a refusal, a
  model outage, a store failure, a changed chunk, another revision, and
  `reset=1` do not or no longer quarantine → evidence:
  `search-embedding-run.test.ts`, `search-embedding-runner.test.ts`.
- H55: given each `H55` row of the embedding run plan and a batch of 50 with
  one failing text, the other 49 are embedded in the same run in at most 15
  calls and only that text is struck, then sent alone; two failing texts in
  one batch are both isolated within the split budget; a bound reached
  while splitting leaves the stored halves stored, strikes nothing, and
  later runs finish; when every call fails a run makes 4 calls (3 for a
  single text), reports `limited: model-down`, and strikes nothing; when the
  model stops answering in mid-run, between batches or inside a split, at
  most 3 calls fail before a probe, the run reports `model-down`, and no
  text is struck, including one struck before, while the same failure with
  the probe answered is a strike; a refusal or a store failure makes one
  call and no split; every call of a split is in the day's ledger →
  evidence: `search-embedding-run.test.ts` rows and tests.
- H56: given 8,586 chunks with one failing text in every batch of 50 (172)
  and the default bounds, hourly runs embed every healthy chunk in 124 runs
  (under 6 days), no run that leaves healthy work spends a call on a retry,
  and afterwards retries use at most 10 calls a run and 100 a day; given 500
  struck texts due at once and 60 new chunks an hour, every run embeds all
  new chunks; a retry comes after the run's healthy chunks, oldest failure
  first, is one call, and is a strike only while the model answers; a run a
  bound stopped and a dry run make none and count them in `retriesDeferred`;
  a failed retry doubles the quarantine from 24 hours up to 30 days; the
  day's ledger equals the calls made and names the retry calls → evidence:
  `search-embedding-run.test.ts`.
- H49: given an index that accepts mutations without applying them, the run
  records each chunk as embedded, a second run embeds nothing, and `/health`
  reports the last mutation id and that the index has not processed it; once
  the index applies them it reports that it has and queries return the
  vectors → evidence: `search-embedding-run.test.ts`.
- H50: given a query embedding that fails, has the wrong dimension, or never
  answers, an index query that fails, or an aborted signal, the retriever
  rejects, and `hybridSearch` returns the lexical results in lexical order
  with `semantic: failed` or `timed-out`; a `limit` above 50 asks each
  namespace for 50 → evidence: `retriever.test.ts`.

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

### Behavior (slice 3)
- H28: given each `H28` row of the hybrid plan, `/api/search` returns the
  listed threads in order with `retrieval.fusionRevision` `rrf-group@1`,
  `semanticRevision`, `semantic { status: ok, candidates, cached }`, and
  per-match `signals.semanticRank` and (since H78) `signals.semanticScore`,
  and adds no other field; a repeated
  query says `cached: true`; golden v2's three semantic queries pass through
  the reader with the gate, and two of them do not without it; for 33
  requests (9 queries at three limits, and six filters) the threads, their
  ranks, and their matches equal `hybridSearch` over the whole corpus, and
  more than 8 differ from the lexical order; a thread's lexical rank does
  not depend on `limit`; given the flag unset or blank, with or without the
  gate binding, on a release with or without shard roots, the status and
  body of 35 requests (21 queries, limits, every filter, `semantic=off`, two
  errors) hash to the digests written on `origin/main` fb70705, the reader
  reads what it read before, and a binding that throws when touched is
  never touched → evidence: `search-hybrid.test.ts`,
  `apps/web/test/fixtures/search-responses.lexical.json`.
- H57: given each `H57` row of the shard-root plan, the manifest declares
  the listed first group roots and `searchShardForGroupRoot` names the
  listed shard, each side of every boundary, in the publisher's order and
  not code-point order; without the option every object is byte-identical
  and with it only the manifest differs, which a reader from before this
  slice still validates; a release is covered only when every shard
  declares a non-empty root, and a whole-release layout never is; given
  `SEARCH_SHARD_ROOTS` unset or blank a publisher run writes the objects it
  wrote before, given `true` it adds the roots to the manifest only,
  `/health` `lastRun.search.shardRoots` is `true`, and a later run without
  it leaves them out again → evidence: `search-shards.test.ts`,
  `pipeline.test.ts`.
- H58: given a match, it becomes a result only as the release's own chunk
  (a gate answer holding null or malformed matches, or no list, does not
  fail the search: they are dropped):
  a fingerprint of other text or another group, a record or ordinal the
  release lacks, a group root that names another shard or none, the record
  under another project, and an unknown project are dropped, and a result's
  fields come from the chunk; given an index that moved on (a passage
  re-embedded from newer text, a removed record, another revision), only
  the unchanged passage is a candidate; each shard is read at most once,
  four at a time, at most 3 + shards reads, only shards holding a term or a
  match, the lexical shards first; the gate is asked after the manifest and
  before the terms object, and shards are read while it answers; an answer
  from the gate is parsed defensively (malformed matches dropped, anything
  else `failed`); on 1,134 real chunks with a bag-of-words embedder every
  result is a thread of the release, once, with its true lexical rank →
  evidence: `search-hybrid.test.ts`, `query-gate.test.ts`.
- H59: given each `H59` row and a gate proposing five passages, the source,
  time-bound (strict, each side), tag, and project-status filters keep
  exactly the passages a lexical chunk with those fields would pass; the
  project filter narrows results and leaves both projects' facet counts as
  they are without it; a thread both retrievers return is counted once →
  evidence: `search-hybrid.test.ts`.
- H60: given a thread only semantic retrieval returned, its match is the
  release's chunk: the text from its start (cut at 280 characters with an
  ellipsis), its link, author, time, and source version, `matchedTerms: []`,
  `signals { exactIdentifier: false, semanticRank, fusedRank }` and no
  `lexicalRank`; its entry is a `search-match` entry naming the matched
  records, its `detailRef` opens the detail, and a thread shows at most five
  passages, best first → evidence: `search-hybrid.test.ts`,
  `identifiers.test.ts`.
- H61: given each `H61` row, a query that can match exactly (an identifier
  in any profile spelling, a bare number, a symbol) or has fewer than two
  letters or digits is answered lexically with `skipped` and its reason and
  the gate is not asked, two letters and an identifier inside a longer
  query are asked; only such a query ever yields an exact match; `semantic=off`
  on a hybrid deployment returns the lexical response with `disabled` and
  asks nothing, and no other value of the parameter does → evidence:
  `search-hybrid.test.ts`, `identifiers.test.ts`.
- H62: given the gate, a query is embedded once and each project's
  namespace asked for 50 matches of the profile's revision; a repeat,
  however spaced or composed, makes no model call and no index query, and
  another case does; matches are cached per project (another project costs
  one index query, no model call, and never another project's matches); a
  tampered cache entry cannot answer for another project; another revision
  shares no entry; matches are asked again after one hour and not one
  millisecond earlier, with the cached embedding; identical requests made
  at once share one model call; entries past retention are removed, a few
  per miss, the cutoff day kept → evidence: `query-gate.test.ts`.
- H63: given the caps, the next distinct query after the day's neurons are
  spent is `over-budget` with the time to UTC midnight and no call, cached
  queries still answer, and the next UTC day starts over; the hourly cap
  refuses until the next clock hour; the index-query cap is checked before
  the model call, so a refused request spends nothing; 50 distinct queries
  made at once, and 30 with interleaving storage, make exactly the capped
  number of calls; a call that fails or never answers is still in the
  ledger; the charge is at least 1 neuron and an upper bound on the
  tokenizer (500 characters cannot exceed 0.55 neurons at the `bge-m3`
  price); a text longer than 500 characters after NFKC is not embedded; the
  gate's ledger is its own key in its own object and its cap is the
  `searchQuery` share of the daily budget → evidence: `query-gate.test.ts`,
  `search-query-gate.test.ts`.
- H70: (changed 2026-10-13 by the owner's decision, Behavior 36: it used to
  assert the "Similar meaning" badge) given a response in which result 1
  has both ranks, result 2 has no `lexicalRank`, and result 3 has only a
  `lexicalRank`, at 375 px in English and zh-Hant no card shows a method
  badge or the words "Evidence search" / 「證據搜尋」 / "Similar meaning" /
  「意思相近」, the semantic-only card shows its title and excerpt, a long
  unbreakable title stays inside the card, the page does not scroll
  sideways, and the card opens its detail, whose header names no method
  either; given a response whose semantic status is `over-budget`,
  `timed-out`, `failed`, or `skipped`, the lexical cards render with no
  badge and no error → evidence: `apps/web/e2e/search-semantic.spec.ts`,
  `apps/web/test/search-results-view.test.ts` (Spec 005 S16).
- H71: given the labelled queries, each names threads of the Dev snapshot
  and a rank bound; the list holds 8 Chinese and 8 vocabulary-gap queries
  beside the 21 Spec 017 rows and 6 guard rows, each query once; the
  measuring command's report gives lexical and hybrid ranks, the semantic
  status, and latencies, marks a query as a rerank candidate when every
  expected thread is in the hybrid top 20 and one is outside its bound
  (each side of both bounds), lists regressions and threads not retrieved,
  applies the 30% rule to fused queries only, reports the timed-out share
  of the cold requests that reached the gate, asks the five unlabelled
  abbreviation probes without counting them as met or missed, fits the
  gate's hourly and daily caps in one run (at most 48 model calls), and reports lexical ranks
  alone against a deployment without hybrid search → evidence:
  `search-hybrid-eval.test.ts`.

### Failure and retry (slice 3)
- H64: given a model error, the gate answers `failed`, records the
  sanitized error (a bearer token and a long key redacted), caches nothing,
  and the next query works; a wrong dimension, two vectors, and no vector
  are model failures; a refusal (Workers AI 3036, a gateway 429, a
  spend-limit refusal) pauses model calls for 15 minutes, during which a
  query needing an embedding is `over-budget` and cached ones answer, while
  another error does not pause; an index failure is `failed` and keeps the
  embedding, so the retry makes no model call; without a profile the gate
  is `disabled`, and with a configuration error `failed`, calling nothing;
  an empty or non-string query, no project, too many projects, and an
  invalid project id are `failed` with nothing called or counted; a cache
  write that fails does not fail the answer; a ledger that cannot be
  written refuses to spend → evidence: `query-gate.test.ts`,
  `search-query-gate.test.ts`.
- H65: given each `H65` row (a release without shard roots, a
  whole-release layout), the response is the lexical one with `uncovered`
  and the gate is not asked → evidence: `search-hybrid.test.ts`.
- H66: given `SEARCH_SEMANTIC=rrf-group@1` and the binding, the handler
  calls the gate object `search-query-gate-v1` with `POST /query` and every
  project of the release; given any other value of the flag, or the flag
  without the binding, it answers lexically with `failed` and asks nothing,
  even a gate that would answer; the gate's client fails on a non-200 and
  reads a malformed body as `failed`; given `SEARCH_SHARD_ROOTS` set to
  anything but `true`, the run fails before a source is polled or an object
  written and `/health` names the value, and the Worker passes its variable
  to the run; since enable step 3 the development Pages configuration sets
  the flag and binds the gate of `oss-knowledge-base-data-dev`, and the
  production and local Pages configurations do neither; since enable step 2 the development publisher sets
  `SEARCH_SHARD_ROOTS=true`, binds `SEARCH_QUERY_GATE`, and migrates the
  class (`v4`), every bound class being exported and migrated once, and the
  production publisher has none of them →
  evidence: `search-hybrid.test.ts`, `pipeline.test.ts`,
  `durable-object-state.test.ts`, `search-query-gate.test.ts`.
- H67: given the embedding job, a run's neurons, its ledger, its daily cap,
  and its estimate use the token estimate times 1.8 (`EMBEDDING_TOKEN_CALIBRATION`,
  from the 2026-10-12 backfill), while tokens and batch sizes do not; the
  digest's 4,500 at its measured cost (× 1.28, `DIGEST_NEURON_CALIBRATION`:
  5,760), the job's 2,500, and the gate's 1,000 are 9,260 of the 10,000
  neurons a day; 31 days of 1,000 index queries and the stored
  vectors are within Vectorize's 50 M queried dimensions up to 17,828
  chunks; the gate's hourly calls and two embedding runs are under the
  gateway's 600 requests an hour → evidence: `search-embedding-run.test.ts`,
  `search-query-gate.test.ts`.

### Behavior (fusion `rrf-group@2`)
- H72: given the capture of 2026-10-13, the two fixtures are dated, name
  the deployment, release, and revisions, hold exactly the 48 measured
  queries and the 14 new ones, are each under 200,000 bytes with under 200
  bytes a thread and no title or excerpt, and every thread has a retriever,
  contiguous lexical and fused ranks, and term masks within the query's
  terms; each query's terms and words are what the release's lexical
  revision makes of it; one query is recorded as its lexical ranks,
  semantic ranks, live fused ranks, masks, and similarity → evidence:
  `search-fusion-replay.test.ts`.
- H73: given hand-computed rankings, the leading threads that hold every
  query word in one passage keep their places and the rest is fused as in
  `rrf-group@1`, at any depth of the threads found twice; a full match is
  one passage, not words spread over passages, and never an empty
  requirement; when the first lexical thread is not a full match, or no
  word matched, the result is `rrf-group@1`'s; without semantic candidates
  every lexical ranking passes through in order; an exact identifier stays
  ahead of a kept thread; the words of a query are distinct, follow
  identifier normalization, and are cut at dots, hyphens, and case
  boundaries → evidence: `fusion.test.ts`.
- H75: given the replay, each of the ten rows `rrf-group@1` makes worse
  than lexical-only (`RequestManager`, `CommitRequestManager`,
  `AsyncKafkaConsumer`, `txn`, `disk manager`, `transaction manager`,
  `SortMergeJoinExec`, `tiered storage`, `kafka release`, `record collector
  offsets`) fails at `rrf-group@1` and is met at `rrf-group@2` with the
  lexical ranks; no row of any kind is worse than lexical-only (Decision
  38, each side of the bound); the owner's query keeps its thread within
  the bound; each of the nine gains on Chinese and vocabulary-gap rows is
  kept with the ranks `rrf-group@1` gave; rows met by kind and set are as
  in Results (43 rows: lexical 26, `rrf-group@1` 22, `rrf-group@2` 30);
  the two reversed guard queries give up what `rrf-group@1` gained; the
  first 50 results are exactly the kept threads then the live order
  without them; the alternatives' scorer agrees with `fuseRankings` for
  both revisions; the committed ablation is what the replay computes →
  evidence: `search-fusion-replay.test.ts`.
- H76: given the 14 queries written before the rule, seven lexical-right
  and seven gap rows, none measured before, each is not worse than
  lexical-only and has no expected thread lowered; the seven lexical-right
  rows keep their lexical ranks (7 of 7 met, 6 at `rrf-group@1`); the gap
  rows met are 2 of 7 as at `rrf-group@1` (1 lexically), and the three
  rows no retriever answers are recorded → evidence:
  `search-fusion-replay.test.ts`.

### Failure and retry (fusion `rrf-group@2`)
- H74: given `rrf-group@1`, its name, config, and order are unchanged
  whatever words it is given; replayed through `fuseRankings` it
  reproduces every one of the 3,052 fused ranks of the 62 live responses;
  a revision name selects its config and any other name selects none →
  evidence: `fusion.test.ts`, `search-fusion-replay.test.ts`.
- H77: given `SEARCH_SEMANTIC=rrf-group@2` and the binding, the handler
  keeps the leading full matches first where `rrf-group@1` puts four
  threads found twice before them, names the revision, changes nothing
  else in the response, and asks the gate exactly what `rrf-group@1` asks;
  every request ranks as `hybridSearch` over the whole corpus does at
  `rrf-group@2`, whatever the limit and the project filter; `failed`,
  `timed-out`, `over-budget`, `disabled`, `semantic=off`, `uncovered`,
  `skipped`, and an `ok` answer without candidates are the lexical response
  naming `rrf-group@2`; a revision in another spelling or an unknown one
  answers lexically with `failed` (the `H66` rows) → evidence:
  `search-hybrid.test.ts`.
- H80: given a similarity that is NaN, negative, zero, infinite, or
  absent, no revision's order changes; fusion is deterministic and breaks
  ties by lexical rank then id; `rrf-group@2` without the query's words is
  rejected by fusion and by hybrid search, and with them a disabled or
  failing retriever is still the lexical order → evidence:
  `fusion.test.ts`.
- H81: given a hybrid response whose lexical rank for a thread differs
  from the lexical response's, or names a lexical thread that response
  does not hold, or a response that matched a term the query does not
  have, the capture is refused, and the same ranking in both is accepted →
  evidence: `search-fusion-replay.test.ts`.

### Observability (fusion `rrf-group@2`)
- H78: given a fused response, every match of a thread with a semantic
  rank carries the similarity of the thread's best passage and no other
  match does, under both revisions; a lexical thread, a `semantic=off`
  response, a lexical response, and a response whose matches were refused
  carry none → evidence: `search-hybrid.test.ts`; the deployed E2E checks
  the field on Dev.
- H79: [deploy] after rollout step 7, Dev answers `fusionRevision:
  rrf-group@2`, the deployed E2E is green, and `measure:search-hybrid`
  shows no Spec 017 or guard row worse than lexical-only and the Chinese
  and vocabulary-gap rows as on 2026-10-13.

### Budget (fusion `rrf-group@2`)
- H82: [measure] one fusion of a captured query (50 lexical threads, up to
  100 semantic ones) takes the same CPU time at both revisions → `bun run
  eval:search-fusion --time` (Results: 24 to 25 µs each); a switch makes no
  model call and no index query (H77).

### Behavior (fusion `rrf-group@3`)
- H85: given hand-computed rankings, a head thread that semantic retrieval
  missed is passed by a standout and by no thread of the pack, and the
  threads behind the head keep their `rrf-group@2` order; the margin is
  measured from the 20th semantic thread, on each side of 0.04, from the
  last thread when there are fewer, and a lone candidate never stands out;
  only the first three lexical threads are protected, a thread never
  passes a head thread it does not outrank lexically, and a standout
  among the head threads passes the others; exact matches and kept full
  matches stay where `rrf-group@2` puts them; a thread stands out by its
  best passage; without candidates the order is lexical → evidence:
  `fusion.test.ts`.
- H86: given the scored replay, `StreamsPartitionAssignor` (2, 8, 1 →
  26, 7, 6) and `deduplicate strings when spilling` (4, 1 → 1, 21) are
  worse than lexical-only at `rrf-group@2` and not at `rrf-group@3` (3, 8,
  2 and 1, 2), and `LogManager cleanup` (1, 3, 2, 4 → 23, 3, 1, 6) becomes
  3, 4, 1, 7, still worse by one thread; rows worse than lexical-only fall
  from 4 to 2 on the verifier's set and none appears in another set; no
  row of any set is worse than `rrf-group@2` at its bound and rows met do
  not fall in any set; the owner's first thread is back at its lexical
  rank; ten gains of `rrf-group@2` on Chinese and gap rows keep their
  ranks and six lowered threads stay within their bounds; the
  alternatives' scorer agrees with `fuseRankings`; only a head of 2 or 3
  at a margin of 0.03 or 0.04 has no row worse than `rrf-group@2` and
  fewer worse than lexical-only → evidence: `search-fusion-scores.test.ts`.

### Failure and retry (fusion `rrf-group@3`)
- H87: given `SEARCH_SEMANTIC=rrf-group@3` and the binding, the handler
  lets a standout pass the first three lexical threads and no thread of
  the pack, names the revision, returns the same threads and facets as
  `rrf-group@2`, and asks the gate the same question; the reader ranks as
  `hybridSearch` does at `rrf-group@3`; `failed`, `timed-out`,
  `over-budget`, `semantic=off`, and an `ok` answer without candidates are
  the lexical response naming `rrf-group@3`; an unknown revision
  (`rrf-group@4`) answers lexically with `failed` (the `H66` rows) →
  evidence: `search-hybrid.test.ts`.
- H89: given a similarity that is NaN, infinite, absent, or a string, or a
  background that is not a number, nothing stands out and nothing is
  thrown; an invalid head (zero or fractional threads or reference, a zero
  margin) and missing query words are rejected; `rrf-group@1` and
  `rrf-group@2` read no similarity; fusion at `rrf-group@3` is
  deterministic and returns every thread once → evidence: `fusion.test.ts`.

### Evidence (fusion `rrf-group@3`)
- H83: given the verifier's 20 queries with the verifier's labels (9
  lexical-right, 8 gap, 3 Chinese, one unlabelled), each is in the scored
  capture, and none is worse under `rrf-group@3` than under `rrf-group@2`
  at its bound → evidence: `search-fusion-verifier.test.ts`,
  `search-fusion-scores.test.ts`.
- H84: given the ten clean queries written after the constants were fixed,
  none asked before, each is met and not worse than lexical-only or than
  `rrf-group@2`; nine tie `rrf-group@2` and one has a thread one rank
  higher → evidence: `search-fusion-clean3.test.ts`,
  `search-fusion-scores.test.ts`.
- H88: given the 112 hand-labelled candidates (16 queries of five types),
  the AUC of relevant against irrelevant is 0.736 by similarity, 0.762 by
  distance to the best, and 0.871 by margin over the 20th thread; a floor
  of 0.50 keeps 17 of 19 relevant and 58 of 73 irrelevant candidates; a
  margin of 0.03, 0.04, 0.05 keeps 17, 17, 15 relevant and 37, 19, 3
  irrelevant; 77 of the 148 expected threads with a similarity are 0.04
  above their background; Chinese queries' best and 20th similarities are
  within 0.02 of other queries' at the median; the committed report is what
  the capture computes → evidence: `search-similarity-labels.test.ts`,
  `search-fusion-scores.test.ts`.
- H90: given the scored capture (82 queries) and the clean one (10), each
  is dated, names the release and revisions, is under 330,000 and 50,000
  bytes with no title or excerpt, holds a similarity in (0, 1] exactly for
  the threads with a semantic rank, never rising with the rank;
  `rrf-group@1` replays every live rank; the 20th semantic thread was shown
  for at least 80 of the 86 fused queries → evidence:
  `search-fusion-scores.test.ts`.

### Budget (fusion `rrf-group@3`)
- H91: [measure] one fusion of a captured query at `rrf-group@3` → `bun run
  eval:search-fusion --time` (Results: 34 to 35 µs against 24 at the other
  revisions); a switch makes no model call and no index query (H87).

### Behavior (later slices)
- H33: [pending] given the labelled queries and the real model,
  `measure:search-hybrid` reports lexical `@3` against hybrid on Dev, the
  report is committed, and the rerank decision (decision 5) is recorded
  with the numbers. Measured once at `rrf-group@1` (Results, 2026-10-13,
  report committed: "no case for rerank", 9 of 43 fused queries); the
  decision is taken from the run at the fusion Dev keeps (rollout step 7).

### Budget
- H27: [measure] Vectorize stored dimensions (chunks × 1,024), model calls,
  estimated input tokens, neurons and dollars for a full backfill, and the
  runs it takes under the bounds of Behavior 19 →
  `bun run measure:search-embedding` (Results, slice 2b); on Dev,
  `/health` `searchEmbedding.lastRun` and a dry run (H52).
- H40: [measure] growth of `terms.json` and lexical shard bytes from `@1` to
  `@2` for the same Feed → `bun run measure:search-revisions` (Results,
  slice 2a); on Dev, `/health` `lastRun.search` before and after the switch.
- H31: [deploy] added median latency of hybrid search on Dev against the
  `semantic=off` response of the same query, cold and cached, the share of
  uncached queries that time out, and the model calls and index queries the
  run cost from `/health` `searchQuery.today` → `bun run
  measure:search-hybrid -- --out <file>` after enable step 3 (rollout
  step 3 lists what it asks and costs; Results, slice 3, gives the estimate
  it is compared with).
- H68: [measure] the query budget: neurons charged per query against the
  calibrated estimate and the upper bound, the three daily neuron caps
  against the included 10,000, index queries and stored vectors against
  Vectorize's included dimensions → `bun run measure:search-query-budget`
  (Results, slice 3).

### Observability
- H30: given a query, the gate embeds it with `@cf/baai/bge-m3` through
  `SEARCH_GATEWAY_ID` (`osskb-search-dev` on Dev) with the gateway cache
  skipped and an abort signal, and asks the bound index; given no flag it
  is `disabled`, and given an unsupported profile, no gateway id, the
  digest's gateway, no AI binding, or no index it is `failed`, names it in
  `/health`, and calls nothing → evidence: `search-query-gate.test.ts`.
- H32: [deploy] on Dev after enable step 2 (the Worker), `/health`
  `searchQuery.enabled` is `true` with no `configError`, after the next
  publication `lastRun.search.shardRoots` is `true`, `/api/search` still has
  no hybrid field, and the embedding job's `lastRun` stays `ok` (the
  deployed E2E asserts the first and the third on every run); after enable
  step 3 (Pages), `/api/search` `retrieval.semantic.status` is `ok` for a
  Chinese query and `cached` on its repeat, `/health` `searchQuery.today`
  counts the call, and the gateway `osskb-search-dev` shows it while
  `osskb-digest-dev` does not; the deployed E2E asserts on every run that
  an identifier query is `skipped`, `semantic=off` is `disabled`, and a
  text query carries a legitimate status, failing only on a hard signal →
  the post-merge checks of each enable PR (rollout steps 2 and 3).
- H69: given the gate object, `/health` `searchQuery` is the object's own
  answer when bound, `null` when it does not answer, and a disabled block
  with the caps when not bound; the object answers `POST /query` and `GET
  /status` from its own storage and 404 otherwise; the Worker has no public
  route to it; the Worker's entry module exports only functions, classes,
  and the default handler → evidence: `search-query-gate.test.ts`,
  `query-gate.test.ts`.
- H41: given a successful run at `@1` or `@2`, `/health` `lastRun.search`
  holds the release's `lexicalRevision`, the manifest's `chunkCount`, the
  shard count, the summed and largest shard bytes, and the `terms.json` bytes
  as written → evidence: `pipeline.test.ts`.
- H51: given the embedding object, `/health` `searchEmbedding` reports
  `enabled`, `configError`, `model`, `revision`, `semanticRevision`,
  `running`, `scheduled`, `interrupted`, `today { date, estimatedNeurons,
  cap, calls, callCap }`, `lastMutation`, `lastError`, and `lastRun` (release, chunks,
  embedded, pending, deleted, stored vectors and dimensions, calls, tokens,
  neurons, `limited`, error, the index's state, and the estimate of what is
  left), and `{ enabled: false }` without the object; `POST
  /search-embedding/run` needs the bearer token, answers 403 when off, 409
  while a run is pending, 202 when scheduled, and with `dryRun=1` returns the
  estimate (chunks, calls, tokens, neurons, dollars, runs) having called no
  model, mutated no vector, and written no state; `reset=1` forgets the
  state so that the next run embeds every chunk again; while the flag is off
  only a reset and a dry run with `profile=bge-m3@1` are served → evidence:
  `search-embedding-runner.test.ts`, `search-embedding-run.test.ts`.
- H52: [deploy] given slice 2b live on Dev, the Dev deploy with the new
  binding and migration succeeds, `/health` `searchEmbedding.enabled` is
  `false`, and a dry run with `profile=bge-m3@1` returns an estimate
  (observed 2026-10-10: Results, "Dev dry run"); given
  `SEARCH_EMBEDDING=bge-m3@1` then set for Dev (2026-10-12), the backfill
  reaches `pending: 0` within the estimated runs,
  `lastRun.index.mutationsProcessed` becomes true, the search gateway shows
  the calls while `osskb-digest-dev` shows none of them, and the ratio of
  the gateway's reported tokens to the estimate is recorded in Results. The
  deployed E2E (`development.spec.ts`) asserts on every run that `/health`
  `searchEmbedding.enabled` is `true` with no `configError`; it cannot
  assert progress, which depends on later hourly runs. To observe after the
  enable deploy, from the first run after the next publication (minute 7)
  on, and to record in Results:
  - `/health` `searchEmbedding.lastRun`: `ok`, `embeddedThisRun`,
    `modelCalls`, `modelErrors`, `limited`; `searchEmbedding.lastError`;
  - `lastRun.index.mutationsProcessed` and the index's dimensions (1,024);
  - `searchEmbedding.today.calls` and `today.estimatedNeurons` against the
    caps (400 and 2,500);
  - whether `@cf/baai/bge-m3` accepted batches of 50 texts within the
    30-second call timeout;
  - the tokens and cost the gateway `osskb-search-dev` reports against the
    estimate, as a ratio, and no such call on `osskb-digest-dev`;
  - `pending` reaching 0 in about 3 runs.
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

## Results (slice 2b, 2026-10-10)

`bun run measure:search-embedding`, on the recorded Feed snapshot (353 chunks,
real GitHub records of both projects), with the real run, a fake model, and an
in-memory index under the default bounds:

| | Snapshot (measured) | Dev corpus (scaled to 8,586 chunks) |
| --- | --- | --- |
| Estimated tokens per chunk | mean 88.8, median 102, p95 123, max 137 | same averages |
| Estimated input tokens | 31,360 | 762,768 |
| Model calls (50 texts each) | 8 | 172 |
| Estimated neurons | 35 | 832 |
| Cost at $0.011 per 1,000 neurons | $0.0004 | $0.0092 |
| Stored dimensions (× 1,024) | 361,472 | 8,792,064 (10 M included) |
| Runs under the bounds | 1 | 3 (3,000 + 3,000 + 2,586 chunks; 60 + 60 + 52 calls) |
| UTC days under the daily bounds | 1 | 1 (172 of 400 calls, 832 of 2,500 neurons; 1,664 if the estimate is half the truth) |
| A run on an unchanged release | 0 model calls, 1 index call (`describe`) | same |

The three-run backfill is also a test: 8,586 synthetic chunks finish in runs
of 3,000, 3,000, and 2,586 chunks with 60, 60, and 52 calls
(`search-embedding-run.test.ts`).

With bad texts (test `H56`, default bounds, hourly runs from 00:00 UTC):
8,586 chunks with one failing text in every batch of 50 (172 bad) have all
8,414 healthy chunks embedded after 124 runs, 5 days and 4 hours. The day's
400 calls set the pace: each such batch costs about 12 calls instead of 1,
about 2,060 in all. No retry is made until the healthy work is done; after
that retries take at most 100 calls a day.

Limits of these numbers:

- Tokens are the digest's estimate (4 characters per token, 1 per CJK
  character), not the model's tokenizer; an embedding response reports no
  usage. The estimate may undercount by up to about 2× on CJK and identifier
  text; the daily cap of 2,500 allows for it. The gateway's analytics on Dev
  are the check (H52). Ratio of reported to estimated tokens: to be recorded
  after the first real run.
- The snapshot holds no dev@ or Jira record. Excerpts are clipped the same
  way for every source, so the per-chunk mean should be close.
- Nothing here measures Workers AI or Vectorize: latency, the real batch
  limit of `@cf/baai/bge-m3`, error shapes, and how long a mutation takes to
  become queryable are read on Dev (H52).

Worker bundle (`wrangler deploy --dry-run`, both configurations): 278.51 KiB
(gzip 69.92) before, 321.07 KiB (gzip 80.08) after.

### Dev dry run (2026-10-10, H52)

`POST /search-embedding/run?dryRun=1&profile=bge-m3@1` on the Dev Worker
with slice 2b deployed and the flag off, against the current Dev release. It
called no model and no index and wrote no state.

| | Dev dry run | Scaled from the snapshot (above) |
| --- | --- | --- |
| Chunks | 8,586 | 8,586 |
| Pending | 8,586 | — |
| Model calls | 172 | 172 |
| Estimated input tokens | 727,738 | 762,768 |
| Estimated neurons | 794 | 832 |
| Cost | $0.008734 | $0.0092 |
| Runs | 3 | 3 |
| UTC days | 1 | 1 |

`/health` `searchEmbedding` at the same time: `enabled: false`, caps of
2,500 neurons and 400 calls a day, no `configError`. The Dev deploy of slice
2b had succeeded, so the CI token can deploy the Vectorize binding and the
`v3` migration. The estimated tokens are 4.6% under the scaled figure
(84.8 a chunk against 88.8).

The owner approved enabling embeddings on Dev on 2026-10-12 on these
numbers. Still to record after the first real runs (H52): the run results,
the batch size and latency the model accepted, the time for a mutation to
be processed, and the ratio of the gateway's reported tokens to the
estimate.

Mutation evidence (one mutant or more per behavior, each seen failing) is
listed in the PR.

## Results (slice 3, 2026-10-12)

Nothing here was measured against Workers AI or Vectorize: no model or
index call was made from a developer machine or a test. Latencies are
estimates until H31.

### Embedding backfill on Dev and the calibration

The backfill of 2026-10-12 (H52): 8,780 chunks embedded, 0 pending, 176
model calls of up to 50 texts, 0.48 s a call on average (1.7 s at most).
The estimate was 803 neurons ($0.0088); the gateway `osskb-search-dev`
reported $0.0157. The ratio is 1.78: `estimateTokens` (4 characters a
token, 1 per CJK character) undercounts `bge-m3`'s tokenizer on these
English titles and excerpts. `EMBEDDING_TOKEN_CALIBRATION` is 1.8, and the
embedding job multiplies its token estimate by it wherever tokens become
neurons or dollars; token counts and batch sizes are unchanged.

| | Before | After |
| --- | --- | --- |
| Neurons for the backfill's tokens | 803 | 1,445 |
| Embedding job, daily cap | 2,500 estimated (4,500 at the measured ratio; "twice it" was allowed for) | 2,500 calibrated |
| What the cap admits in a day | 3.1 backfills | 1.7 backfills (15,000 chunks) |
| Steady state (about 60 new chunks an hour) | about 135 a day | about 240 a day |

### Query budget

`bun run measure:search-query-budget` (H68):

| Workers AI, neurons per UTC day | Cap as counted | What the cap can cost |
| --- | --- | --- |
| Digest (Spec 014; its ledger is unchanged) | 4,500 in its own estimate | 5,760 (× 1.28) |
| Embedding job | 2,500, calibrated (× 1.8 inside) | 2,500 |
| Query gate | 1,000, an upper bound | 1,000 |
| Total | 8,000 | 9,260 of the 10,000 included |
| Headroom | | 740 |

The digest's row was wrong in the first version of this table, which added
its 4,500 as if its estimate were exact and reported 2,000 of headroom (the
verifier of PR #54: at the embedding ratio of 1.8 the three caps would be
11,600). The digest's estimate was measured on 2026-10-08: three Dev dry
runs estimated at 4,507 neurons were 109 calls costing $0.06306 on the
gateway `osskb-digest-dev`, 5,733 neurons at $0.011 per 1,000, a ratio of
1.272. `DIGEST_NEURON_CALIBRATION` is 1.28. It is applied to the budget
arithmetic only: the digest's own ledger, cap, and `/health` numbers still
count its estimate, so its behaviour is unchanged.

| | Before | After |
| --- | --- | --- |
| Digest cap, as its ledger counts | 4,500 | 4,500 |
| Digest cap, what it can cost | taken as 4,500 | 5,760 |
| Sum of the three caps | 8,000 | 9,260 |
| Headroom under 10,000 | 2,000 (overstated) | 740 |

740 is 7% and rests on one measurement each of two ratios. What makes it
enough today: the digest has no cron on Dev and one run is about 1,500
estimated neurons (1,920 calibrated); the embedding job's steady state is
about 240 a day; a day of ordinary queries is about 20 real neurons. If the
digest gets a daily cron, measure both ratios again first.

| One query embedding | Calibrated estimate | Upper bound | Charged |
| --- | --- | --- | --- |
| `consumer network thread request manager` (39 characters) | 0.020 neurons | 0.046 | 1 |
| `消費者重新平衡很慢` (9 characters) | 0.018 | 0.013 | 1 |
| 500 ASCII characters, the longest accepted | 0.25 | 0.55 | 1 |
| 500 CJK characters | 0.98 | 0.55 | 1 |

The upper bound is characters + 3 tokens: the model's tokenizer
(SentencePiece) cuts the normalized text into pieces of at least one
character each and adds a word-start marker and two sentence markers. On the
last row the calibrated estimate (0.98) is above that bound (0.55), which
shows the estimate's limit, not the bound's: `estimateTokens` already counts
one token per CJK character, and the factor 1.8 was measured on English
titles and excerpts, where a token is taken as four characters. For CJK text
the factor overcounts. Whichever is right, 1 neuron is charged, which is
above both; a text of 500 characters cannot be billed more than 503 tokens,
0.55 neurons. That the gateway bills by the tokenizer's count is assumed
from the backfill, not measured for single queries (open question 18).
So the 1,000-neuron
cap is at most 1,000 model calls a day and at most 550 real neurons; a day
of ordinary queries is about 20. At $0.011 per 1,000 neurons the whole cap
would be $0.011 a day if it were billed; inside the included 10,000 it is
$0.

| Vectorize, per month of 31 days | |
| --- | --- |
| Billed as | (stored vectors + queries) × 1,024 dimensions |
| Stored, 8,780 chunks | 8,990,720 of 10,000,000 included |
| Index queries at the cap, 31 × 1,000 | 31,744,000 dimensions |
| Queried total | 40,734,720 of 50,000,000 included |
| Passes the included 50 M at | 17,829 chunks |

One uncached search on Dev is 1 model call and 2 index queries (two
projects), so the index cap admits 500 uncached searches a day. The hourly
cap (100 model calls) means the day cannot be spent in under 10 hours, and
with two embedding runs (80 calls each) stays under the gateway's 600
requests an hour.

What a visitor, or an attacker, can and cannot cost:

- **Workers AI and Vectorize: $0.** The caps are counted in one object
  before any call; cached, skipped, and refused queries call nothing. When
  a cap is spent, search answers lexically and says `over-budget` until the
  next UTC day (or hour).
- **Denial of the feature, not money.** 500 distinct queries spread over 10
  hours turn semantic search off for everyone for the rest of the UTC day.
  There is no per-visitor limit, because Dev has no visitor identity.
- **Durable Object requests.** Each search that is not skipped, not
  `uncovered`, and not already known to be over budget is one request to
  the gate, cached or not. Workers Paid includes 1 M a month, then $0.15 a
  million; the publisher's objects use a few thousand. After the cap is
  spent each Pages isolate stops asking, so a flood is bounded by the
  day's cap plus one request per isolate per reset. Before the cap is
  spent, a flood of repeats of one query is answered from the cache at one
  request each.
- **Pages Functions invocations and R2 reads** are as before this slice
  (outside it). A semantic search reads no shard twice; a query with no
  lexical match now reads the shards its matches are in (up to all 10).
- **Durable Object storage:** at most 7 days × 1,000 entries of about 22 KB
  (a 4 KB embedding and two projects' matches): about 150 MB, inside the
  included 5 GB.

### Design in numbers

| | Lexical (today) | Hybrid, uncached | Hybrid, cached |
| --- | --- | --- | --- |
| R2 reads | 3 + shards holding a term (13 at most on Dev) | 3 + shards holding a term or a match (13 at most) | the same |
| Extra reads for the shard lookup | — | 0 (about 60 bytes a shard in the manifest) | 0 |
| Bytes at most | 18.0 MB of shards, 0.56 MB of terms | the same | the same |
| Gate requests | 0 | 1 | 1 |
| Model calls | 0 | 1 | 0 |
| Index queries | 0 | 1 per project (2 on Dev) | 0 within the hour |
| Semantic passages into fusion | — | at most 50 per project | the same |

Latency, estimated (H31 measures it):

- The gate, uncached: the round trip to the object (a few ms in its
  region; an estimated 50–250 ms from another continent), one single-text
  embedding (batches of 50 took 0.48 s on average; a single short text is
  assumed to take 0.1–0.5 s), and two index queries in parallel (not
  measured; assumed 0.05–0.3 s): 0.2–1.0 s. Cached: the round trip only.
- The reader asks the gate after the manifest and reads the terms object
  and the first four shards meanwhile, which takes 0.3–1.5 s on Dev today.
  So a query whose words are in most shards (1.0–2.3 s today) is expected
  to gain 0–0.3 s uncached and about nothing cached.
- A query with no lexical match (0.7 s today) waits for the gate and then
  reads the shards its matches are in: an expected 1.2–2.5 s uncached, the
  cost of any all-shards query, in exchange for results instead of none.
- The worst case of a gate that does not answer is the 1,000 ms timeout,
  added only to a response that would otherwise have been ready earlier.

### Tests

Worker bundle (`wrangler deploy --dry-run`, both configurations): 321.07
KiB (gzip 80.08) before, 342.11 KiB (gzip 84.89) after. The Pages Functions
bundle compiles (`wrangler pages functions build`), also with the enable
configuration of rollout step 3.

Local run without any cloud resource (2026-10-12): the data Worker under
`wrangler dev` with the gate class bound and no AI or index binding, and
`wrangler pages dev` with the Durable Object binding to it and
`SEARCH_SEMANTIC=rrf-group@1`, over a golden release with shard roots.
`/api/search?q=txn` answered the lexical result with `semantic: { status:
"disabled" }` and the gate counted the request; `KIP770` and `semantic=off`
did not reach it. This run found that the Worker would not start with a
string constant exported from its entry module (Decision 34).

Mutation pass: 79 mutants, one or more per behavior, 78 caught (one of
them by the retriever's own H44 test). The one left, ranking lexical threads
to depth 50 with the flag off, changes memory and no response. Two mutants
survived a first pass and each got a test: a ledger without its lock
(storage that interleaves) and an unknown flag value honoured (a gate that
would answer).

## Results (hybrid search on Dev and fusion `rrf-group@2`, 2026-10-13)

### The live measurement at `rrf-group@1`

`bun run measure:search-hybrid` against `https://oss-knowledge-base-dev.pages.dev`,
finished 2026-10-13 01:26 UTC, release `feed-2026-10-13T01-07-01-000Z`,
lexical `bm25-reference@3`, fusion `rrf-group@1` (k = 60). The report is
committed as `measurements/hybrid-report.2026-10-13.json`. 48 queries:
statuses `ok` 43, `timed-out` 1, `skipped` 4; rows met lexically 26, hybrid
23; `timedOutShare` 0.03 (1 of 40 cold requests); median latency lexical
1,547 ms, hybrid 1,923 ms, hybrid cached 1,799 ms, median added 313 ms;
rerank rule "no case for rerank" (9 candidates among 43 fused queries).

| kind | lexical met | hybrid met |
| --- | --- | --- |
| Spec 017 rows, implementer-labelled (20) | 20 | 13 |
| the owner's query (1) | 0 | 0 |
| guard rows (6) | 3 | 3 |
| Chinese rows (8) | 1 | 3 |
| vocabulary-gap rows (8) | 2 | 4 |

| kind | query | within | lexical ranks | hybrid ranks | semantic | lexical ms | hybrid ms | cached ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| real-corpus | consumer network thread request manager | 3 | 2, 21, 9 | 3, 39, 24 | ok (cached) | 1903 | 2067 | 1739 |
| real-corpus | request manager | 9 | 1, 5, 2, 3, 4 | 1, 2, 3, 4, 8 | ok (cached) | 1728 | 1794 | 1718 |
| real-corpus | RequestManager | 9 | 1, 5, 2, 3, 4 | 1, 5, 2, 3, 4 | timed-out | 1657 | 2325 | 1791 |
| real-corpus | OffsetsRequestManager | 2 | 1, 2 | 1, 2 | ok | 1830 | 2035 | 2125 |
| real-corpus | CommitRequestManager | 3 | 3, 2, 1 | 5, 16, 1 | ok | 1624 | 1882 | 1798 |
| real-corpus | AsyncKafkaConsumer | 7 | 6, 2, 1, 5, 4, 7, 3 | 5, 2, 1, 7, 4, 12, 3 | ok | 1802 | 1797 | 2123 |
| real-corpus | heartbeat request manager | 3 | 1, 2, 3 | 2, 1, 3 | ok | 1596 | 1739 | 1663 |
| real-corpus | release manager | 1 | 1 | 1 | ok | 1574 | 1923 | 1667 |
| real-corpus | log manager | 7 | 1, 4, 3, 5 | 3, 2, 1, 6 | ok | 1775 | 2606 | 1685 |
| real-corpus | KIP770 | 1 | 1 | 1 | skipped | 1020 | 1137 | 1099 |
| real-corpus | KIP-770 | 1 | 1 | 1 | skipped | 1206 | 1097 | 1105 |
| real-corpus | 770 | 1 | 1 | 1 | skipped | 1104 | 1299 | 1232 |
| real-corpus | txn | 5 | 1, 2, 3, 4, 5 | 3, 8, 2, 4, 1 | ok | 1036 | 2080 | 1866 |
| real-corpus | KAFKA-19804 | 2 | 1, 2 | 1, 2 | skipped | 1190 | 1293 | 1215 |
| real-corpus | disk manager | 3 | 1, 2, 3 | 4, 2, 1 | ok | 1675 | 2193 | 1818 |
| real-corpus | transaction manager | 3 | 1, 2 | 20, 21 | ok | 1316 | 1958 | 1957 |
| real-corpus | remote log manager | 3 | 1, 2, 3 | 1, 2, 3 | ok | 1497 | 1871 | 1572 |
| real-corpus | SortMergeJoinExec | 6 | 4, 6, 3, 5, 1, 2 | 2, 15, 1, 4, 3, 5 | ok | 1595 | 1794 | 1520 |
| real-corpus | GroupMetadataManager | 2 | 1 | 2 | ok | 1515 | 2085 | 1754 |
| real-corpus | tiered storage | 5 | 1, 2, 4, 3, 5 | 2, 3, 1, 4, 6 | ok | 1784 | 1658 | 1743 |
| real-corpus | KRaft controller | 4 | 4, 1, 2, 3 | 3, 1, 2, 4 | ok | 995 | 1996 | 1703 |
| guard | manager release | 1 | 1 | 1 | ok | 1547 | 1860 | 1563 |
| guard | kafka release | 3 | 1, 2, 3 | 2, 1, 16 | ok | 5507 | 1999 | 1965 |
| guard | manager log | 7 | 1, 5, 3, 6 | 6, 5, 3, 7 | ok | 1883 | 1992 | 1824 |
| guard | storage tiered | 5 | 3, 5, 18, 7, 20 | 3, 2, 5, 4, 8 | ok | 1858 | 1897 | 1822 |
| guard | controller kraft | 4 | 9, 1, 2, 6 | 27, 2, 3, 6 | ok | 1015 | 1811 | 1906 |
| guard | manager request | 9 | 7, 21, 11, 18, 19 | 1, 4, 8, 6, 9 | ok | 1944 | 2073 | 1787 |
| chinese | 交易逾時 | 10 | >50, >50 | >50, >50 | ok (cached) | 741 | 1973 | 1799 |
| chinese | 消費者重新平衡很慢 | 10 | >50, >50 | >50, >50 | ok (cached) | 753 | 1703 | 1728 |
| chinese | 分層儲存的配額沒有生效 | 5 | >50, >50 | 8, >50 | ok | 717 | 2238 | 1904 |
| chinese | 重新認證失敗後 CPU 使用率過高 | 5 | >50 | 13 | ok | 1744 | 2123 | 2005 |
| chinese | 反向 DNS 查詢阻塞網路執行緒 | 5 | 7, 3 | 5, 2 | ok | 1041 | 1717 | 2017 |
| chinese | 心跳請求的初始間隔 | 5 | >50, >50 | 2, 1 | ok | 673 | 2041 | 1573 |
| chinese | 排序合併連接溢出到磁碟時遺失資料列 | 5 | >50 | >50 | ok | 678 | 2300 | 1871 |
| chinese | 發布流程移除 MD5 校驗檔 | 5 | 3 | 4 | ok | 1437 | 2292 | 2264 |
| vocabulary-gap | controller sign-up retried after timing out | 5 | 24 | 3 | ok | 1690 | 1862 | 1765 |
| vocabulary-gap | SMJ spill | 10 | 50, >50, 30 | 16, 35, 14 | ok | 1430 | 1870 | 2030 |
| vocabulary-gap | two-phase commit | 5 | >50 | >50 | ok | 1724 | 1790 | 1863 |
| vocabulary-gap | client spins at 100% cpu | 10 | 3, >50, >50, >50 | 1, >50, >50, >50 | ok | 1950 | 2163 | 1939 |
| vocabulary-gap | remote storage file handle not closed | 5 | 7, 2 | 3, 5 | ok | 1850 | 1915 | 1748 |
| vocabulary-gap | hash join that fits in limited RAM | 5 | 2 | 1 | ok | 1796 | 1800 | 1828 |
| vocabulary-gap | mark directory as failed on disk error | 5 | 1, >50 | 4, 41 | ok | 1920 | 1800 | 1747 |
| vocabulary-gap | HB interval | 5 | 1, 2 | 1, 2 | ok | 1621 | 2219 | 1917 |
| probe | RM | 0 |  |  | ok | 1156 | 1950 | 1775 |
| probe | ISR | 0 |  |  | ok | 1070 | 1884 | 1835 |
| probe | HW | 0 |  |  | ok | 673 | 2105 | 1544 |
| probe | EOS | 0 |  |  | ok | 1100 | 1685 | 1843 |
| probe | LSO | 0 |  |  | ok | 665 | 2072 | 1589 |

Read: hybrid search helps where lexical search could not answer
(`心跳請求的初始間隔` from nothing to 2 and 1, `controller sign-up retried
after timing out` from 24 to 3, the reversed `manager request` from 7, 21,
11, 18, 19 to 1, 4, 8, 6, 9) and breaks seven Spec 017 rows and one guard
row it already answered (`transaction manager` from 1, 2 to 20, 21). The
owner's query goes from 2, 21, 9 to 3, 39, 24, and its first result is
"KAFKA-21034: Wipe the global state directory when the store is corrupted"
(lexical 8, semantic 8). `交易逾時`, `消費者重新平衡很慢`,
`排序合併連接溢出到磁碟時遺失資料列`, and `two-phase commit` find none of
their expected threads either way; for the first two the expected threads
were the implementer's guesses, and hybrid search does return plausible
ones (`消費者重新平衡很慢`: "KAFKA-20385: Extend ConsumerRebalanceListener…"
first).

### The mechanism, in the captured numbers

Over the 31 fused queries whose lexical ranking is full (50 threads):

- 17.4 threads a query are in both lists, 35% of the lexical threads. The
  semantic list is always 100 passages, so it reaches deep into the lexical
  one whatever the similarity.
- In 6 of the 31 the first lexical thread is not a semantic candidate; it
  is then fused to rank 7, 7, 14, 15, 15, 20. Of the 93 lexical top-three
  threads, 20 are not candidates and fall to rank 15 in the median, 21 at
  worst.
- 152 threads that are at lexical rank 20 or lower and semantic rank 20 or
  lower score above 1/61, the most a thread in one list can score. A thread
  at 30 and 30 scores 2/90 = 0.0222.

### The replay

Captured with `bun run capture:search-replay` at 01:34 UTC, on the same
release and inside the hour of the measurement: the 48 queries cost no
model call and no index query. `RequestManager`, which timed out at 01:26,
answered `ok` from the cache, and it is a ninth regression the report
could not show (1, 5, 2, 3, 4 becomes 15, 4, 1, 2, 6): on the replay
`rrf-group@1` meets 22 of the 43 rows, not 23. The 14 new queries were
captured at 01:37 (14 model calls, 28 index queries). Replayed through
`fuseRankings`, `rrf-group@1` reproduces all 3,052 fused ranks of the 62
responses.

Rows met, by set (H75, H76):

| set | kind | lexical only | `rrf-group@1` | `rrf-group@2` |
| --- | --- | --- | --- | --- |
| tuning (31) | real-corpus | 14/14 | 8/14 | 14/14 |
| | owner | 0/1 | 0/1 | 0/1 |
| | guard | 2/4 | 1/4 | 2/4 |
| | chinese | 1/6 | 2/6 | 2/6 |
| | vocabulary-gap | 1/6 | 3/6 | 3/6 |
| held-out (12) | real-corpus | 6/6 | 4/6 | 6/6 |
| | guard | 1/2 | 2/2 | 1/2 |
| | chinese | 0/2 | 1/2 | 1/2 |
| | vocabulary-gap | 1/2 | 1/2 | 1/2 |
| new (14) | lexical-right | 7/7 | 6/7 | 7/7 |
| | gap | 1/7 | 2/7 | 2/7 |
| the 43 measured rows | | 26 | 22 | 30 |
| all 57 | | 34 | 30 | 39 |
| rows worse than lexical-only, of 57 | | 0 | 10 | 0 |
| expected threads below their lexical-only rank | | 0 | 41 | 7 |

The ablation (`bun run eval:search-fusion`, committed as
`apps/web/test/fixtures/hybrid-fusion-ablation.txt` and compared in CI):

```text
Replayed over the capture of feed-2026-10-13T01-07-01-000Z (apps/web/test/fixtures/hybrid-replay*.json). met: rows whose expected threads all rank within the bound,
by kind (rc real-corpus, ow owner, gd guard, zh chinese, vg vocabulary-gap, lr lexical-right, gp gap). worse: rows with an expected thread that
lexical-only ranks within the bound and this does not. lowered: expected threads ranked below their lexical-only rank. lost: wins of @1 not kept.
Candidate 3 (a similarity threshold) is not in the table: the response did not serve the similarity when this was captured.

tuning (31 rows)
variant                                     met                                       worse  lowered  lost  nDCG@10  MRR
lexical only (semantic=off)                 rc 14/14 ow 0/1 gd 2/4 zh 1/6 vg 1/6      0      0        6     0.6719   0.6906
rrf-group@1 (k 60)                          rc 8/14 ow 0/1 gd 1/4 zh 2/6 vg 3/6       7      31       0     0.6521   0.6822
1 weighted: semantic x 0.5                  rc 9/14 ow 0/1 gd 1/4 zh 1/6 vg 3/6       6      22       2     0.6696   0.7032
1 weighted: semantic x 0.25                 rc 10/14 ow 0/1 gd 1/4 zh 1/6 vg 2/6      5      13       3     0.6992   0.7434
k 10 for both rankings                      rc 10/14 ow 0/1 gd 1/4 zh 3/6 vg 3/6      5      30       0     0.6930   0.7099
2 lexical first, semantic appended          rc 14/14 ow 0/1 gd 2/4 zh 1/6 vg 1/6      0      0        6     0.6766   0.6906
2 first 3 lexical threads kept              rc 11/14 ow 0/1 gd 2/4 zh 1/6 vg 3/6      3      11       2     0.6793   0.6991
5 first 20 semantic threads only            rc 9/14 ow 0/1 gd 1/4 zh 3/6 vg 3/6       7      32       0     0.6662   0.6790
5 first 10 semantic threads only            rc 9/14 ow 0/1 gd 1/4 zh 3/6 vg 2/6       8      35       2     0.6763   0.6995
4 every full match first                    rc 14/14 ow 0/1 gd 2/4 zh 2/6 vg 3/6      0      6        0     0.6840   0.6930
4 leading full matches kept = rrf-group@2   rc 14/14 ow 0/1 gd 2/4 zh 2/6 vg 3/6      0      6        0     0.6840   0.6930
rrf-group@2 with k 10                       rc 14/14 ow 0/1 gd 2/4 zh 3/6 vg 3/6      0      6        0     0.7063   0.7207
rrf-group@2 with semantic x 0.75            rc 14/14 ow 0/1 gd 2/4 zh 2/6 vg 3/6      0      5        0     0.6869   0.6994

held-out (12 rows)
variant                                     met                                       worse  lowered  lost  nDCG@10  MRR
lexical only (semantic=off)                 rc 6/6 gd 1/2 zh 0/2 vg 1/2               0      0        3     0.6256   0.6369
rrf-group@1 (k 60)                          rc 4/6 gd 2/2 zh 1/2 vg 1/2               2      8        0     0.6839   0.6674
1 weighted: semantic x 0.5                  rc 4/6 gd 2/2 zh 1/2 vg 1/2               2      7        0     0.6760   0.6267
1 weighted: semantic x 0.25                 rc 4/6 gd 1/2 zh 1/2 vg 1/2               2      6        0     0.7067   0.6715
k 10 for both rankings                      rc 4/6 gd 1/2 zh 1/2 vg 1/2               2      12       0     0.6643   0.6229
2 lexical first, semantic appended          rc 6/6 gd 1/2 zh 1/2 vg 1/2               0      0        1     0.7256   0.7307
2 first 3 lexical threads kept              rc 6/6 gd 1/2 zh 1/2 vg 1/2               0      3        1     0.7574   0.7396
5 first 20 semantic threads only            rc 4/6 gd 1/2 zh 1/2 vg 1/2               2      12       0     0.6567   0.6701
5 first 10 semantic threads only            rc 4/6 gd 0/2 zh 1/2 vg 1/2               3      12       0     0.6713   0.6725
4 every full match first                    rc 6/6 gd 1/2 zh 1/2 vg 1/2               0      0        0     0.7643   0.7723
4 leading full matches kept = rrf-group@2   rc 6/6 gd 1/2 zh 1/2 vg 1/2               0      1        0     0.7728   0.7723
rrf-group@2 with k 10                       rc 6/6 gd 1/2 zh 1/2 vg 1/2               0      1        0     0.7643   0.7723
rrf-group@2 with semantic x 0.75            rc 6/6 gd 1/2 zh 1/2 vg 1/2               0      1        0     0.7731   0.7723

new (14 rows)
variant                                     met                                       worse  lowered  lost  nDCG@10  MRR
lexical only (semantic=off)                 lr 7/7 gp 1/7                             0      0        0     0.5722   0.5536
rrf-group@1 (k 60)                          lr 6/7 gp 2/7                             1      2        0     0.6446   0.6621
1 weighted: semantic x 0.5                  lr 6/7 gp 2/7                             1      2        0     0.6233   0.6264
1 weighted: semantic x 0.25                 lr 7/7 gp 2/7                             0      1        0     0.6113   0.6145
k 10 for both rankings                      lr 6/7 gp 2/7                             1      2        0     0.6440   0.6621
2 lexical first, semantic appended          lr 7/7 gp 1/7                             0      0        0     0.5878   0.5728
2 first 3 lexical threads kept              lr 7/7 gp 2/7                             0      0        0     0.5929   0.5728
5 first 20 semantic threads only            lr 6/7 gp 2/7                             1      2        0     0.6440   0.6603
5 first 10 semantic threads only            lr 6/7 gp 1/7                             1      3        0     0.6178   0.6548
4 every full match first                    lr 7/7 gp 2/7                             0      0        0     0.6585   0.6621
4 leading full matches kept = rrf-group@2   lr 7/7 gp 2/7                             0      0        0     0.6585   0.6621
rrf-group@2 with k 10                       lr 7/7 gp 2/7                             0      0        0     0.6527   0.6621
rrf-group@2 with semantic x 0.75            lr 7/7 gp 2/7                             0      0        0     0.6321   0.6264
```

Each row's expected threads, in their listed order (`bun run
eval:search-fusion --rows`):

| set | kind | query | within | lexical only | rrf-group@1 | rrf-group@2 |
| --- | --- | --- | --- | --- | --- | --- |
| tuning | owner | consumer network thread request manager | 3 | 2, 21, 9 | 3, 39, 24 | 3, 39, 24 |
| tuning | real-corpus | request manager | 9 | 1, 5, 2, 3, 4 | 1, 2, 3, 4, 8 | 1, 5, 2, 3, 4 |
| tuning | real-corpus | RequestManager | 9 | 1, 5, 2, 3, 4 | 15, 4, 1, 2, 6 | 1, 5, 2, 3, 4 |
| held-out | real-corpus | OffsetsRequestManager | 2 | 1, 2 | 1, 2 | 1, 2 |
| tuning | real-corpus | CommitRequestManager | 3 | 3, 2, 1 | 5, 16, 1 | 3, 2, 1 |
| tuning | real-corpus | AsyncKafkaConsumer | 7 | 6, 2, 1, 5, 4, 7, 3 | 5, 2, 1, 7, 4, 12, 3 | 6, 2, 1, 5, 4, 7, 3 |
| held-out | real-corpus | heartbeat request manager | 3 | 1, 2, 3 | 2, 1, 3 | 1, 2, 3 |
| tuning | real-corpus | release manager | 1 | 1 | 1 | 1 |
| tuning | real-corpus | log manager | 7 | 1, 4, 3, 5 | 3, 2, 1, 6 | 1, 4, 3, 5 |
| held-out | real-corpus | KIP770 | 1 | 1 | 1 | 1 |
| tuning | real-corpus | KIP-770 | 1 | 1 | 1 | 1 |
| tuning | real-corpus | 770 | 1 | 1 | 1 | 1 |
| held-out | real-corpus | txn | 5 | 1, 2, 3, 4, 5 | 3, 8, 2, 4, 1 | 1, 2, 3, 4, 5 |
| tuning | real-corpus | KAFKA-19804 | 2 | 1, 2 | 1, 2 | 1, 2 |
| tuning | real-corpus | disk manager | 3 | 1, 2, 3 | 4, 2, 1 | 1, 2, 3 |
| held-out | real-corpus | transaction manager | 3 | 1, 2 | 20, 21 | 1, 2 |
| tuning | real-corpus | remote log manager | 3 | 1, 2, 3 | 1, 2, 3 | 1, 2, 3 |
| tuning | real-corpus | SortMergeJoinExec | 6 | 4, 6, 3, 5, 1, 2 | 2, 15, 1, 4, 3, 5 | 4, 6, 3, 5, 1, 2 |
| held-out | real-corpus | GroupMetadataManager | 2 | 1 | 2 | 1 |
| tuning | real-corpus | tiered storage | 5 | 1, 2, 4, 3, 5 | 2, 3, 1, 4, 6 | 1, 2, 4, 3, 5 |
| tuning | real-corpus | KRaft controller | 4 | 4, 1, 2, 3 | 3, 1, 2, 4 | 4, 1, 2, 3 |
| tuning | guard | manager release | 1 | 1 | 1 | 1 |
| tuning | guard | kafka release | 3 | 1, 2, 3 | 2, 1, 16 | 1, 2, 3 |
| held-out | guard | manager log | 7 | 1, 5, 3, 6 | 6, 5, 3, 7 | 1, 5, 3, 6 |
| tuning | guard | storage tiered | 5 | 3, 5, 18, 7, 20 | 3, 2, 5, 4, 8 | 3, 5, 18, 7, 20 |
| tuning | guard | controller kraft | 4 | 9, 1, 2, 6 | 27, 2, 3, 6 | 9, 1, 2, 6 |
| held-out | guard | manager request | 9 | 7, 21, 11, 18, 19 | 1, 4, 8, 6, 9 | 7, 9, 12, 10, 13 |
| tuning | chinese | 交易逾時 | 10 | >50, >50 | >50, >50 | >50, >50 |
| tuning | chinese | 消費者重新平衡很慢 | 10 | >50, >50 | >50, >50 | >50, >50 |
| held-out | chinese | 分層儲存的配額沒有生效 | 5 | >50, >50 | 8, >50 | 8, >50 |
| tuning | chinese | 重新認證失敗後 CPU 使用率過高 | 5 | >50 | 13 | 13 |
| tuning | chinese | 反向 DNS 查詢阻塞網路執行緒 | 5 | 7, 3 | 5, 2 | 5, 2 |
| held-out | chinese | 心跳請求的初始間隔 | 5 | >50, >50 | 2, 1 | 2, 1 |
| tuning | chinese | 排序合併連接溢出到磁碟時遺失資料列 | 5 | >50 | >50 | >50 |
| tuning | chinese | 發布流程移除 MD5 校驗檔 | 5 | 3 | 4 | 4 |
| tuning | vocabulary-gap | controller sign-up retried after timing out | 5 | 24 | 3 | 3 |
| tuning | vocabulary-gap | SMJ spill | 10 | 50, >50, 30 | 16, 35, 14 | 16, 35, 14 |
| held-out | vocabulary-gap | two-phase commit | 5 | >50 | >50 | >50 |
| tuning | vocabulary-gap | client spins at 100% cpu | 10 | 3, >50, >50, >50 | 1, >50, >50, >50 | 1, >50, >50, >50 |
| tuning | vocabulary-gap | remote storage file handle not closed | 5 | 7, 2 | 3, 5 | 3, 5 |
| held-out | vocabulary-gap | hash join that fits in limited RAM | 5 | 2 | 1 | 1 |
| tuning | vocabulary-gap | mark directory as failed on disk error | 5 | 1, >50 | 4, 41 | 4, 41 |
| tuning | vocabulary-gap | HB interval | 5 | 1, 2 | 1, 2 | 1, 2 |
| new | lexical-right | ClientQuotaMetadataManager | 2 | 1, 2 | 1, 2 | 1, 2 |
| new | lexical-right | LogManagerBuilder | 2 | 2, 1 | 2, 1 | 2, 1 |
| new | lexical-right | stale transaction coordinator cache | 3 | 1, 2 | 1, 2 | 1, 2 |
| new | lexical-right | record collector offsets | 3 | 1, 2 | 1, 8 | 1, 2 |
| new | lexical-right | push down topk through join | 3 | 1, 2 | 2, 1 | 1, 2 |
| new | lexical-right | windowed restore optimisation | 3 | 1 | 1 | 1 |
| new | lexical-right | PartitionsWithLateTransactionsCount | 1 | 1 | 1 | 1 |
| new | gap | 交易協調器回傳過期的快取結果 | 5 | >50, >50 | 6, 29 | 6, 29 |
| new | gap | 長時間重新平衡造成記憶體不足 | 5 | >50 | 39 | 39 |
| new | gap | out of memory during a long rebalance | 5 | >50 | >50 | >50 |
| new | gap | abandon a hanging transaction from the command line | 5 | 8, 2 | 2, 1 | 2, 1 |
| new | gap | commit markers lost when a partition is unavailable | 5 | 4 | 1 | 1 |
| new | gap | how to report a vulnerability | 5 | >50 | >50 | >50 |
| new | gap | 用戶端配額數值檢查 | 5 | >50 | 13 | 13 |

### What `rrf-group@2` does not fix, and what it gives up

- **The owner's query**: 2, 21, 9 lexically; 3, 39, 24 at both revisions.
  No passage holds its five words, so no thread is kept. Its first thread
  stays within the bound of 3; the other two were outside it and are
  lower (open question 28).
- **Expected threads below their lexical-only rank, all still within their
  bound or outside it either way** (7; `rrf-group@1`: 41): the owner's
  three; `發布流程移除 MD5 校驗檔` 3 → 4 (bound 5); `remote storage file handle
  not closed` 2 → 5 beside 7 → 3 (bound 5, the row becomes met); `mark
  directory as failed on disk error` 1 → 4 beside nothing → 41 (bound 5);
  `manager request` 11 → 12 beside 21 → 9.
- **Given up against `rrf-group@1`**: the two reversed guard queries.
  `manager request` 1, 4, 8, 6, 9 (met) becomes 7, 9, 12, 10, 13 (lexical
  7, 21, 11, 18, 19); `storage tiered` 3, 2, 5, 4, 8 becomes the lexical 3,
  5, 18, 7, 20. The guard rows met stay 3 of 6 because `kafka release`
  comes back (open question 26).
- **Not retrieved by either retriever**: `交易逾時`, `消費者重新平衡很慢`,
  `排序合併連接溢出到磁碟時遺失資料列`, `two-phase commit`, and of the new
  queries `how to report a vulnerability` and `out of memory during a long
  rebalance` (open question 25). No fusion can fix these.
- **Not measured**: a similarity threshold (open question 15), and
  `rrf-group@2` live (H79). The replay is exact for its first 50 results
  given the same lexical ranking and candidates.

### The verifier's clean set (PR #57, 2026-10-13)

The independent verifier wrote 20 queries of its own before running
`rrf-group@2` (9 where lexical search is right, 8 gap, 3 Chinese; labelled
by the verifier) and compared the revisions on live candidates. Its finding
narrows what this revision is: `rrf-group@2` is never worse than
`rrf-group@1` on any measured row, and on those 20 queries it changed
almost nothing: 19 ties with `rrf-group@1`, and threads were kept in only 2
queries. Three of the 9 lexical-right queries stay worse than lexical-only
under both revisions, because their first lexical thread does not hold
every query word in one passage (expected threads' ranks, lexical-only →
fused):

| query | lexical only | `rrf-group@1` and `rrf-group@2` |
| --- | --- | --- |
| `LogManager cleanup` | 1, 3, 2, 4 | 23, 3, 1, 6 |
| `StreamsPartitionAssignor` | 2, 8, 1 | 26, 7, 6 |
| `deduplicate strings when spilling` | 4, 1 | 1, 21 |

So `rrf-group@2` fixes the case it was fitted to see (a complete lexical
match at the head) and not the mechanism in general. These three rows are
known limitations of `rrf-group@2`; the next lever is the similarity of a
candidate, measurable now that `signals.semanticScore` is served (open
question 15).

### Cost

Fusion takes 24 to 25 µs at either revision over the captured rankings
(`bun run eval:search-fusion --time`, 53 queries × 200, a developer
laptop); the rule adds a scan of at most 50 threads × 5 passages. No read,
gate request, model call, or index query is added, and the response grows
by one number a semantic thread. Latency is therefore the 2026-10-13
measurement's.

Spent on Dev for this change (`/health` `searchQuery.today`, 2026-10-13):
before 46 neurons, 46 model calls, 92 index queries; after 60, 60, 120.
The 48 measured queries were re-asked twice each for the capture at no
gate cost; the 14 new queries cost 14 model calls and 28 index queries.

### Tests

Fail first: each of the ten regressed rows is asserted to fail at
`rrf-group@1` and pass at `rrf-group@2` on the same captured candidates
(H75), and the reader test reproduces the failure through `/api/search`
before showing the fix (H77). Mutation pass: 24 mutants over the rule, the
reader, the flag, the similarity field, the words, and the replay; 23
caught. The one left drops the rule from the fallback path, where it
cannot change the order (no semantic candidate): equivalent, and the
reason the duplicate check in `hybridSearch` was deleted. One mutant
survived a first pass and got a test: words not deduplicated without
identifier profiles.

## Results (similarity and fusion `rrf-group@3`, 2026-10-13)

### The scored capture

`bun run capture:search-replay` against Dev at 02:41 UTC, after PR #57 was
deployed (the response serves `signals.semanticScore`), release
`feed-2026-10-13T02-07-01-000Z`, fusion `rrf-group@1`: the 48 measured
queries, the 14 new ones, and the verifier's 20, each already embedded, so
0 model calls and 98 index queries. 76 are fused (6 are identifier
queries). The ten clean queries followed at 02:52 (10 model calls, 20
index queries). Committed: `apps/web/test/fixtures/hybrid-replay.scored.2026-10-13.json`
(322 KB) and `hybrid-replay.clean-3.2026-10-13.json`. The similarity of a
semantic thread the response did not show (below its 50 results) is not
recorded; the 20th semantic thread was shown for at least 80 of the 86
fused queries, and where it was not the background is an upper bound.

### What the similarity says

`bun run eval:search-similarity`, committed as
`apps/web/test/fixtures/hybrid-similarity-report.txt` and compared in CI.
The labels are the implementer's, from titles (Test plan):

```text
Similarity of semantic candidates, capture of feed-2026-10-13T02-07-01-000Z (2026-10-13T02:41:14.143Z).
Hand labels: the first 7 semantic threads of 16 queries, 112 candidates: R relevant 19, P partly 20, I irrelevant 73.
margin: similarity minus the similarity of the query's 20th semantic thread. below best: the best similarity of the query minus this one.

similarity
  R  n  19  min 0.466  p25 0.541  median 0.582  p75 0.594  max 0.658
  P  n  20  min 0.506  p25 0.544  median 0.558  p75 0.580  max 0.611
  I  n  73  min 0.383  p25 0.503  median 0.538  p75 0.562  max 0.620
  AUC, R against I: 0.736
below best
  R  n  19  min 0.000  p25 0.000  median 0.016  p75 0.020  max 0.052
  P  n  20  min 0.000  p25 0.000  median 0.024  p75 0.032  max 0.064
  I  n  73  min 0.000  p25 0.017  median 0.032  p75 0.064  max 0.123
  AUC, R against I: 0.762
margin
  R  n  19  min 0.012  p25 0.052  median 0.081  p75 0.090  max 0.122
  P  n  20  min 0.017  p25 0.027  median 0.033  p75 0.057  max 0.141
  I  n  73  min 0.012  p25 0.021  median 0.032  p75 0.041  max 0.061
  AUC, R against I: 0.871

kept by an absolute floor
  similarity >= 0.45  R 19/19  P 20/20  I 69/73
  similarity >= 0.50  R 17/19  P 20/20  I 58/73
  similarity >= 0.52  R 16/19  P 19/20  I 50/73
  similarity >= 0.54  R 15/19  P 17/20  I 36/73
  similarity >= 0.56  R 13/19  P 9/20  I 21/73
  similarity >= 0.58  R 10/19  P 6/20  I 8/73
  similarity >= 0.60  R 4/19  P 1/20  I 1/73
kept by a margin over the query's 20th semantic thread
  margin >= 0.02  R 17/19  P 18/20  I 58/73
  margin >= 0.03  R 17/19  P 14/20  I 37/73
  margin >= 0.04  R 17/19  P 8/20  I 19/73
  margin >= 0.05  R 15/19  P 8/20  I 3/73
  margin >= 0.06  R 14/19  P 5/20  I 2/73
  margin >= 0.08  R 10/19  P 4/20  I 0/73

by query type: similarity of R | of I
  english phrase  R n   5  min 0.541  p25 0.573  median 0.577  p75 0.579  max 0.588 | I n   8  min 0.553  p25 0.573  median 0.575  p75 0.580  max 0.598
  class name      R n   2  min 0.525  p25 0.525  median 0.525  p75 0.525  max 0.584 | I n  12  min 0.528  p25 0.530  median 0.537  p75 0.556  max 0.562
  chinese         R n   5  min 0.501  p25 0.582  median 0.594  p75 0.640  max 0.658 | I n  20  min 0.493  p25 0.500  median 0.505  p75 0.583  max 0.620
  paraphrase      R n   5  min 0.550  p25 0.588  median 0.599  p75 0.606  max 0.618 | I n  22  min 0.527  p25 0.535  median 0.548  p75 0.555  max 0.571
  one word        R n   2  min 0.466  p25 0.466  median 0.466  p75 0.466  max 0.483 | I n  11  min 0.383  p25 0.399  median 0.472  p75 0.474  max 0.491

every fused query: similarity of its best and of its 20th semantic thread
  queries with Han characters  best n  14  min 0.516  p25 0.573  median 0.582  p75 0.594  max 0.691 | 20th n  14  min 0.461  p25 0.483  median 0.524  p75 0.538  max 0.559
  other queries                best n  62  min 0.432  p25 0.567  median 0.592  p75 0.633  max 0.722 | 20th n  62  min 0.365  p25 0.499  median 0.512  p75 0.525  max 0.586

expected threads of the labelled rows: 189; with a similarity 148; lexical only (no semantic rank) 22; in neither response 19
  similarity n 148  min 0.428  p25 0.524  median 0.560  p75 0.619  max 0.722
  margin     n 148  min -0.031  p25 0.012  median 0.041  p75 0.083  max 0.243
  margin >= 0.04: 77 of 148

Score-aware alternatives on top of rrf-group@2. Per set: rows met / rows, w = rows worse than lexical-only at the bound,
b = rows worse than rrf-group@2 at the bound, and nDCG@10.

variant                             tuning                  held-out                new                     verifier                clean-3                 
lexical only (semantic=off)         18/31 w0 b3 0.672       8/12 w0 b2 0.626        8/14 w0 b1 0.572        7/19 w0 b6 0.513        8/10 w0 b2 0.840        
rrf-group@1                         14/31 w7 b7 0.652       8/12 w2 b2 0.684        8/14 w1 b1 0.645        7/19 w4 b0 0.610        10/10 w0 b0 0.964       
rrf-group@2                         21/31 w0 b0 0.684       9/12 w0 b0 0.773        9/14 w0 b0 0.658        7/19 w4 b0 0.610        10/10 w0 b0 0.964       
floor: similarity >= 0.45           21/31 w0 b0 0.688       9/12 w0 b0 0.773        9/14 w0 b0 0.658        7/19 w4 b0 0.610        10/10 w0 b0 0.964       
floor: similarity >= 0.50           21/31 w0 b0 0.682       9/12 w0 b0 0.766        9/14 w0 b0 0.658        7/19 w4 b0 0.606        10/10 w0 b0 0.964       
floor: similarity >= 0.54           20/31 w1 b1 0.693       9/12 w0 b0 0.765        8/14 w0 b1 0.631        6/19 w5 b3 0.561        10/10 w0 b0 0.956       
within 0.08 of the best             22/31 w2 b2 0.690       9/12 w0 b0 0.766        9/14 w0 b0 0.658        7/19 w4 b0 0.623        9/10 w1 b1 0.957        
within 0.06 of the best             22/31 w1 b1 0.705       9/12 w0 b0 0.773        9/14 w0 b0 0.658        8/19 w3 b1 0.638        10/10 w0 b0 0.964       
within 0.04 of the best             20/31 w1 b2 0.721       9/12 w0 b0 0.765        8/14 w0 b1 0.631        3/19 w5 b5 0.605        8/10 w1 b2 0.922        
weight by margin / 0.05             21/31 w2 b2 0.706       9/12 w0 b1 0.764        8/14 w0 b1 0.645        7/19 w4 b1 0.632        9/10 w1 b1 0.960        
counted only at margin >= 0.04      22/31 w0 b0 0.710       9/12 w0 b0 0.741        8/14 w0 b1 0.628        6/19 w4 b3 0.620        9/10 w1 b1 0.963        
absent lexical thread = rank 50     21/31 w1 b1 0.681       9/12 w0 b0 0.773        9/14 w0 b0 0.658        7/19 w4 b0 0.616        10/10 w0 b0 0.964       
absent lexical thread = rank 30     21/31 w2 b2 0.676       9/12 w0 b0 0.766        9/14 w0 b0 0.658        7/19 w4 b0 0.634        10/10 w0 b0 0.964       
head 1, margin 0.04                 21/31 w1 b1 0.688       9/12 w0 b0 0.773        9/14 w0 b0 0.653        8/19 w3 b0 0.634        10/10 w0 b0 0.964       
head 2, margin 0.04                 21/31 w0 b0 0.688       9/12 w0 b0 0.773        9/14 w0 b0 0.653        8/19 w2 b0 0.644        10/10 w0 b0 0.966       
head 3, margin 0.03                 21/31 w0 b0 0.688       9/12 w0 b0 0.773        9/14 w0 b0 0.650        8/19 w2 b0 0.649        10/10 w0 b0 0.964       
head 3, margin 0.04 = rrf-group@3   21/31 w0 b0 0.688       9/12 w0 b0 0.773        9/14 w0 b0 0.650        8/19 w2 b0 0.643        10/10 w0 b0 0.966       
head 3, margin 0.05                 20/31 w0 b1 0.689       9/12 w0 b0 0.773        9/14 w0 b0 0.634        8/19 w2 b0 0.645        10/10 w0 b0 0.966       
head 5, margin 0.04                 20/31 w0 b1 0.687       9/12 w0 b0 0.773        8/14 w0 b1 0.646        8/19 w2 b1 0.642        10/10 w0 b0 0.966       
head 10, margin 0.04                20/31 w0 b1 0.692       9/12 w0 b0 0.765        8/14 w0 b1 0.645        8/19 w2 b1 0.642        10/10 w0 b0 0.966       
```

Read (Decision 43): the similarity has no floor that separates relevant
from irrelevant candidates and is not lower for Chinese queries; what
separates is how far a candidate stands above its own query's background,
and that marks about half of the right threads.

### `rrf-group@3` on the scored replay

Rows met (H86), lexical-only / `rrf-group@1` / `rrf-group@2` / `rrf-group@3`:

| set | rows | lexical only | `rrf-group@1` | `rrf-group@2` | `rrf-group@3` |
| --- | --- | --- | --- | --- | --- |
| tuning | 31 | 18 | 14 | 21 | 21 |
| held-out | 12 | 8 | 8 | 9 | 9 |
| new (H76) | 14 | 8 | 8 | 9 | 9 |
| verifier (H83) | 19 | 7 | 7 | 7 | 8 |
| clean-3 (H84) | 10 | 8 | 10 | 10 | 10 |
| all | 86 | 49 | 47 | 56 | 57 |
| rows worse than lexical-only | | 0 | 14 | 4 | 2 |
| rows worse than `rrf-group@2` at the bound | | 14 | 10 | 0 | 0 |

Each row's expected threads, in their listed order (`bun run
eval:search-similarity --rows`):

| set | kind | query | within | lexical only | rrf-group@1 | rrf-group@2 | rrf-group@3 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tuning | owner | consumer network thread request manager | 3 | 2, 21, 9 | 3, 39, 24 | 3, 39, 24 | 2, 39, 24 |
| tuning | real-corpus | request manager | 9 | 1, 5, 2, 3, 4 | 1, 2, 3, 4, 8 | 1, 5, 2, 3, 4 | 1, 5, 2, 3, 4 |
| tuning | real-corpus | RequestManager | 9 | 1, 5, 2, 3, 4 | 15, 4, 1, 2, 6 | 1, 5, 2, 3, 4 | 1, 5, 2, 3, 4 |
| held-out | real-corpus | OffsetsRequestManager | 2 | 1, 2 | 1, 2 | 1, 2 | 1, 2 |
| tuning | real-corpus | CommitRequestManager | 3 | 3, 2, 1 | 5, 16, 1 | 3, 2, 1 | 3, 2, 1 |
| tuning | real-corpus | AsyncKafkaConsumer | 7 | 6, 2, 1, 5, 4, 7, 3 | 5, 2, 1, 7, 4, 12, 3 | 6, 2, 1, 5, 4, 7, 3 | 6, 2, 1, 5, 4, 7, 3 |
| held-out | real-corpus | heartbeat request manager | 3 | 1, 2, 3 | 2, 1, 3 | 1, 2, 3 | 1, 2, 3 |
| tuning | real-corpus | release manager | 1 | 1 | 1 | 1 | 1 |
| tuning | real-corpus | log manager | 7 | 1, 4, 3, 5 | 3, 2, 1, 6 | 1, 4, 3, 5 | 1, 4, 3, 5 |
| held-out | real-corpus | KIP770 | 1 | 1 | 1 | 1 | 1 |
| tuning | real-corpus | KIP-770 | 1 | 1 | 1 | 1 | 1 |
| tuning | real-corpus | 770 | 1 | 1 | 1 | 1 | 1 |
| held-out | real-corpus | txn | 5 | 1, 2, 3, 4, 5 | 3, 8, 2, 4, 1 | 1, 2, 3, 4, 5 | 1, 2, 3, 4, 5 |
| tuning | real-corpus | KAFKA-19804 | 2 | 1, 2 | 1, 2 | 1, 2 | 1, 2 |
| tuning | real-corpus | disk manager | 3 | 1, 2, 3 | 4, 2, 1 | 1, 2, 3 | 1, 2, 3 |
| held-out | real-corpus | transaction manager | 3 | 1, 2 | 20, 21 | 1, 2 | 1, 2 |
| tuning | real-corpus | remote log manager | 3 | 1, 2, 3 | 1, 2, 3 | 1, 2, 3 | 1, 2, 3 |
| tuning | real-corpus | SortMergeJoinExec | 6 | 4, 6, 3, 5, 1, 2 | 2, 15, 1, 4, 3, 5 | 4, 6, 3, 5, 1, 2 | 4, 6, 3, 5, 1, 2 |
| held-out | real-corpus | GroupMetadataManager | 2 | 1 | 2 | 1 | 1 |
| tuning | real-corpus | tiered storage | 5 | 1, 2, 4, 3, 5 | 2, 3, 1, 4, 6 | 1, 2, 4, 3, 5 | 1, 2, 4, 3, 5 |
| tuning | real-corpus | KRaft controller | 4 | 4, 1, 2, 3 | 3, 1, 2, 4 | 4, 1, 2, 3 | 4, 1, 2, 3 |
| tuning | guard | manager release | 1 | 1 | 1 | 1 | 1 |
| tuning | guard | kafka release | 3 | 1, 2, 3 | 2, 1, 16 | 1, 2, 3 | 1, 2, 3 |
| held-out | guard | manager log | 7 | 1, 5, 3, 6 | 6, 5, 3, 7 | 1, 5, 3, 6 | 1, 5, 3, 6 |
| tuning | guard | storage tiered | 5 | 3, 5, 18, 7, 20 | 3, 2, 5, 4, 8 | 3, 5, 18, 7, 20 | 3, 5, 18, 7, 20 |
| tuning | guard | controller kraft | 4 | 9, 1, 2, 6 | 27, 2, 3, 6 | 9, 1, 2, 6 | 9, 1, 2, 6 |
| held-out | guard | manager request | 9 | 7, 21, 11, 18, 19 | 1, 4, 8, 6, 9 | 7, 9, 12, 10, 13 | 7, 9, 12, 10, 13 |
| tuning | chinese | 交易逾時 | 10 | >50, >50 | >50, >50 | >50, >50 | >50, >50 |
| tuning | chinese | 消費者重新平衡很慢 | 10 | >50, >50 | >50, >50 | >50, >50 | >50, >50 |
| held-out | chinese | 分層儲存的配額沒有生效 | 5 | >50, >50 | 8, >50 | 8, >50 | 8, >50 |
| tuning | chinese | 重新認證失敗後 CPU 使用率過高 | 5 | >50 | 13 | 13 | 15 |
| tuning | chinese | 反向 DNS 查詢阻塞網路執行緒 | 5 | 7, 3 | 5, 2 | 5, 2 | 5, 2 |
| held-out | chinese | 心跳請求的初始間隔 | 5 | >50, >50 | 2, 1 | 2, 1 | 2, 1 |
| tuning | chinese | 排序合併連接溢出到磁碟時遺失資料列 | 5 | >50 | >50 | >50 | >50 |
| tuning | chinese | 發布流程移除 MD5 校驗檔 | 5 | 3 | 4 | 4 | 4 |
| tuning | vocabulary-gap | controller sign-up retried after timing out | 5 | 24 | 3 | 3 | 5 |
| tuning | vocabulary-gap | SMJ spill | 10 | 50, >50, 30 | 16, 35, 14 | 16, 35, 14 | 16, 35, 14 |
| held-out | vocabulary-gap | two-phase commit | 5 | >50 | >50 | >50 | >50 |
| tuning | vocabulary-gap | client spins at 100% cpu | 10 | 3, >50, >50, >50 | 1, >50, >50, >50 | 1, >50, >50, >50 | 3, >50, >50, >50 |
| tuning | vocabulary-gap | remote storage file handle not closed | 5 | 7, 2 | 3, 5 | 3, 5 | 3, 4 |
| held-out | vocabulary-gap | hash join that fits in limited RAM | 5 | 2 | 1 | 1 | 1 |
| tuning | vocabulary-gap | mark directory as failed on disk error | 5 | 1, >50 | 4, 41 | 4, 41 | 1, 41 |
| tuning | vocabulary-gap | HB interval | 5 | 1, 2 | 1, 2 | 1, 2 | 1, 2 |
| new | lexical-right | ClientQuotaMetadataManager | 2 | 1, 2 | 1, 2 | 1, 2 | 1, 2 |
| new | lexical-right | LogManagerBuilder | 2 | 2, 1 | 2, 1 | 2, 1 | 2, 1 |
| new | lexical-right | stale transaction coordinator cache | 3 | 1, 2 | 1, 2 | 1, 2 | 1, 2 |
| new | lexical-right | record collector offsets | 3 | 1, 2 | 1, 8 | 1, 2 | 1, 2 |
| new | lexical-right | push down topk through join | 3 | 1, 2 | 2, 1 | 1, 2 | 1, 2 |
| new | lexical-right | windowed restore optimisation | 3 | 1 | 1 | 1 | 1 |
| new | lexical-right | PartitionsWithLateTransactionsCount | 1 | 1 | 1 | 1 | 1 |
| new | gap | 交易協調器回傳過期的快取結果 | 5 | >50, >50 | 6, 29 | 6, 29 | 6, 29 |
| new | gap | 長時間重新平衡造成記憶體不足 | 5 | >50 | 39 | 39 | 39 |
| new | gap | out of memory during a long rebalance | 5 | >50 | >50 | >50 | >50 |
| new | gap | abandon a hanging transaction from the command line | 5 | 8, 2 | 2, 1 | 2, 1 | 4, 1 |
| new | gap | commit markers lost when a partition is unavailable | 5 | 4 | 1 | 1 | 1 |
| new | gap | how to report a vulnerability | 5 | >50 | >50 | >50 | >50 |
| new | gap | 用戶端配額數值檢查 | 5 | >50 | 13 | 13 | 13 |
| verifier | lexical-right | LogManager cleanup | 5 | 1, 3, 2, 4 | 23, 3, 1, 6 | 23, 3, 1, 6 | 3, 4, 1, 7 |
| verifier | lexical-right | StreamsPartitionAssignor | 5 | 2, 8, 1 | 26, 7, 6 | 26, 7, 6 | 3, 8, 2 |
| verifier | lexical-right | max.poll.interval.ms | 5 | 6, 8 | 6, 8 | 6, 8 | 6, 8 |
| verifier | lexical-right | remote.log.storage.enable | 5 | 1, 6, 8 | 1, 6, 8 | 1, 6, 8 | 1, 6, 8 |
| verifier | lexical-right | SortMergeJoinExec spill | 5 | 8, 4 | 4, 1 | 4, 1 | 4, 1 |
| verifier | lexical-right | ListingTable partition pruning | 5 | 1, 2, 3, 6, 7 | 7, 1, 3, 2, 5 | 7, 1, 3, 2, 5 | 6, 1, 3, 2, 5 |
| verifier | lexical-right | unclean leader election | 5 | 5, 2 | 4, 1 | 4, 1 | 5, 1 |
| verifier | lexical-right | offset commit callback | 5 | 1, 2, 4 | 1, 2, 3 | 1, 2, 3 | 1, 2, 3 |
| verifier | gap | consumer stuck after network timeout | 5 | 3, 2, 4 | 5, 1, 3 | 5, 1, 3 | 5, 1, 3 |
| verifier | gap | broker runs out of file descriptors | 5 | >50, >50, >50 | >50, >50, >50 | >50, >50, >50 | >50, >50, >50 |
| verifier | gap | slow group rebalance memory | 5 | >50 | >50 | >50 | >50 |
| verifier | gap | producer blocked on metadata | 5 | 3, 1, 4 | 3, 2, 1 | 3, 2, 1 | 4, 2, 1 |
| verifier | gap | deduplicate strings when spilling | 5 | 4, 1 | 1, 21 | 1, 21 | 1, 2 |
| verifier | gap | config value validation for client quotas | 5 | 7, 8 | 2, 4 | 2, 4 | 2, 4 |
| verifier | gap | merge join loses rows | 5 | 2, 3, 5 | 1, 4, 2 | 1, 4, 2 | 2, 4, 3 |
| verifier | gap | vulnerability disclosure process | 5 | >50 | 14 | 14 | 14 |
| verifier | chinese | 日誌管理器 | 5 | >50, >50, >50, >50 | 3, 8, >50, >50 | 3, 8, >50, >50 | 3, 8, >50, >50 |
| verifier | chinese | 分區領導者選舉 | 5 | >50, >50 | 1, >50 | 1, >50 | 1, >50 |
| verifier | chinese | 遠端儲存指標 | 5 | >50, >50 | 2, 8 | 2, 8 | 2, 8 |
| clean-3 | lexical-right | AsyncKafkaConsumer bug | 5 | 1, 2, 3 | 1, 2, 3 | 1, 2, 3 | 1, 2, 3 |
| clean-3 | lexical-right | ClientQuotaMetadataManager migration | 5 | 1, 2 | 1, 2 | 1, 2 | 1, 2 |
| clean-3 | lexical-right | LogManagerBuilder removal | 5 | 1, 2 | 1, 2 | 1, 2 | 1, 2 |
| clean-3 | lexical-right | stale coordinator cache fix | 5 | 1, 2 | 1, 2 | 1, 2 | 1, 2 |
| clean-3 | lexical-right | windowed restore optimisation backport | 5 | 3, 1, 2 | 2, 1, 5 | 2, 1, 5 | 2, 1, 4 |
| clean-3 | lexical-right | push down topk join benchmark | 5 | 1, 2, 3 | 1, 2, 3 | 1, 2, 3 | 1, 2, 3 |
| clean-3 | lexical-right | heartbeat request manager performance | 5 | 1, 2, 3 | 1, 2, 3 | 1, 2, 3 | 1, 2, 3 |
| clean-3 | gap | why does the controller not retry registering | 5 | 1, 2 | 1, 2 | 1, 2 | 1, 2 |
| clean-3 | gap | 安全性政策 | 5 | >50, >50 | 2, 1 | 2, 1 | 2, 1 |
| clean-3 | gap | CPU busy loop after login failure | 5 | 7, 8 | 3, 2 | 3, 2 | 3, 2 |

### The verifier's clean set for `rrf-group@3` (PR #59): the deciding evidence

Recorded as the verifier reported it. 15 new queries (14 labelled),
written for the class `rrf-group@2` cannot fix; the reconstruction is
exact (the replayed `rrf-group@2` order equals the live `rrf-group@2`
top 50 on 15 of 15).

| | lexical only | `rrf-group@1` | `rrf-group@2` | `rrf-group@3` |
| --- | --- | --- | --- | --- |
| rows met, of 14 | 6 | 4 | 4 | 5 |
| rows worse than lexical-only at the bound | | | 2 | 1 |

`rrf-group@3` against `rrf-group@2`: better 1, worse 2, same 11.

- Better: `log cleaner threads tuning`, 4 → 2.
- Worse: `GroupMetadataManager cleanup`, pull request 23530 from 3 to 4.
- Worse: `consumer close hangs forever`, 7, 4, 3, 2 → 9, 6, 5, 2:
  `rrf-group@3` lifts two irrelevant lexical head threads above the
  relevant ones.

Conclusions (Decision 50): `rrf-group@3` protects lexical ranks 1 to 3
regardless of relevance, so its gain over `rrf-group@2` is small and
two-sided. Its constants sit on a plateau (head 2 to 3 × reference 20 to
30 × margin 0.02 to 0.04 equivalent; a margin of 0.05 or more or a head of
4 or more worse on some set), and the benefit is about zero on genuinely
new queries. It stays off; Dev remains on `rrf-group@2`; fusion tuning
stops here; the next lever is the embedding text, after which
`rrf-group@3` may be re-evaluated. These 15 queries are the verifier's
evidence and are not in this repository's fixtures.

The verifier also corrected three hand labels of `LogManager cleanup`
(semantic ranks 2 to 4, partly → irrelevant: `LogCleaner` and the log
directory are not `LogManager`). Applied: partly 23 → 20, irrelevant 70 →
73; AUC by similarity 0.737 → 0.736, by distance to the best 0.759 →
0.762, by margin 0.876 → 0.871; irrelevant candidates kept by a margin of
0.03, 0.04, 0.05: 34, 16, 1 of 70 → 37, 19, 3 of 73. No conclusion
changes; the margin of 0.05 is less clean than first reported.

### What `rrf-group@3` does not fix, and what it costs

- **Two of the verifier's nine lexical-right queries are still worse than
  lexical-only at the bound of 5** (the owner's criterion asked for none):
  `LogManager cleanup` is 3, 4, 1, 7 (lexical 1, 3, 2, 4; 23, 3, 1, 6
  under `rrf-group@2`): its fourth thread is lexical 4, outside the head
  of three. `ListingTable partition pruning` is 6, 1, 3, 2, 5 (lexical 1,
  2, 3, 6, 7): five semantic standouts precede its first lexical thread,
  and four of them are expected threads, so the row holds four expected
  threads in its first five where lexical search holds three.
- **The owner's query**: 2, 39, 24 (lexical 2, 21, 9). Its first thread is
  back at its lexical rank; the other two are not semantic candidates and
  are outside the head.
- **Threads `rrf-group@2` ranked higher**, each within its bound either
  way: `controller sign-up retried after timing out` 3 → 5; `重新認證失敗後
  CPU 使用率過高` 13 → 15; `client spins at 100% cpu` 1 → 3; `abandon a
  hanging transaction from the command line` 2 → 4; `producer blocked on
  metadata` 3 → 4; `unclean leader election` 4 → 5; `merge join loses
  rows` 1, 4, 2 → 2, 4, 3. In each a thread of the pack had passed a head
  thread and no longer does.
- **It rarely acts on new queries**: 9 of the 10 clean queries are the
  `rrf-group@2` order.
- **Three constants fitted on 76 rows** (Decision 45).
- **Not measured live**: `rrf-group@3` has not answered a request on Dev.
  The replay through `fuseRankings` is exact for threads the response
  showed; the background is an upper bound in at most 6 of 86 queries.

### The owner's query and the embedding text

`consumer network thread request manager` (the owner's labels: KAFKA-19804,
pull request 22747 of KAFKA-20765, KAFKA-19738). What the release stores
for those records, read from the public `/api/search-detail` on
2026-10-13: a record's text is its title and one `excerpt`, cut at about
280 characters.

| record | title | excerpt (the whole stored text) |
| --- | --- | --- |
| KAFKA-19804 | Improve heartbeat request manager initial HB interval | 280 characters: "With KIP-848, consumer HB interval config moved to the broker, so currently, the consumer HB request manager starts with a 0ms interval…" |
| pull 22747 | KAFKA-20765: Fix OffsetFetch stale-epoch retry spinning in dedup loop | 358 characters: "Fixes KAFKA 20765. The issue In the async consumer (AsyncKafkaConsumer), when an in flight OffsetFetch fails with STALE MEMBER EPOCH… CommitRequestManager correctly classifies the error as retriable…", and a comment "backport to 4.3" |
| KAFKA-19738 | Improve testing of OffsetsRequestManager to better match OffsetFetcher | 273 characters: "OffsetsRequestManager lacks the same level of testing compared to the code it eventually intends to replace, OffsetFetcher…" |

None of the three says `network thread`; two say `request manager` only
inside a class name. Their similarities: KAFKA-19804 is the 28th semantic
thread (0.507, 0.002 below the 20th); the other two are not among the 100
candidates. The first five semantic threads, with the implementer's
judgement:

| semantic | similarity | thread | judgement |
| --- | --- | --- | --- |
| 1 | 0.588 | KAFKA-20995: KIP-1371: Explicit Wait Conditions for Consumer Request Managers | relevant by its title: the consumer's request managers as a design |
| 2 | 0.550 | [DISCUSS] KIP-1371: Explicit Wait Conditions for Consumer Request Managers | relevant: the same proposal's discussion |
| 3 | 0.548 | pull 21041, KAFKA-10549: Add topic ID support to ListOffsets - client | not relevant |
| 4 | 0.538 | pull 23463, KAFKA-20047: Add per-client-id remote fetch metrics | not relevant |
| 5 | 0.531 | pull 23664, MINOR: Resilience improvements on leadership change | not relevant |

Questions for the owner:

- **Is the label too narrow?** KIP-1371 is the one thread whose title is
  about the consumer's request managers as a design, and semantic
  retrieval ranks it and its discussion first and second, 0.079 above the
  background. Spec 017 lists KIP-1371 as acceptable for `request manager`
  and not for this query. If it is an answer here, hybrid search already
  finds something lexical search ranks 33rd.
- **Would richer text help?** Plausibly, and unproven. All three excerpts
  are cut mid-sentence, so whatever the source says after the first 280
  characters is neither indexed nor embedded; the paths a pull request
  touches and its component labels would name the consumer's internals
  where a title does not. Whether any of that says `network thread` for
  these records is not known: the full bodies are not in the release, and
  nothing was embedded to try it.
- **What re-embedding costs**, at the measured prices: the backfill of
  8,780 chunks was billed $0.0157 (about 1,430 neurons), and they are 8.99
  M of the 10 M stored dimensions the plan includes. Text five times
  longer is about five times the chunks: about $0.08 once and three days
  of the job's 2,500-neuron daily cap, 45 M stored dimensions ($0.02 a
  month above the included 10 M), larger shards for the reader (18 MB
  today, the real constraint), and a new text-assembly revision, which
  invalidates every vector (Behavior 6). Query cost does not change.

Recommendation: a follow-up spec for the embedding text
(`title-text@2`), measured the way this change was: capture, labels,
replay, before any switch. It should decide what is embedded per record
(full first part, touched paths, component labels) separately from what
the lexical index stores, since the reader's shard budget limits the
second and not the first.

### Cost

`bun run eval:search-fusion --time`: 34 to 35 µs a fusion at
`rrf-group@3`, 24 at the other two (53 captured queries × 200). No read,
gate request, model call, or index query is added.

Spent on Dev for this change and the switch PR (`/health`
`searchQuery.today`, 2026-10-13): before 78 neurons, 78 model calls, 172
index queries; after 88, 88, 294. The 10 clean queries are the 10 model
calls; the scored capture of 82 known queries cost 98 index queries and
none of the others' 24 a model call.

### Tests

Fail first: the three rows the verifier named are asserted worse than
lexical-only at `rrf-group@2` before their `rrf-group@3` ranks (H86), and
the reader test shows four threads found twice passing the lexical head at
`rrf-group@2` before the fix (H87). Mutation pass: 20 mutants over the
rule, its constants, the flag, and the report; all caught. Two survived a
first pass and each got a test: an exact match preceded by a head thread,
and a thread judged by its worst passage.

## Open questions

Not decided here:

1. **Workers Paid plan.** Decided: the account is Workers Paid (10 M stored
   dimensions included). At 8,586 chunks the index holds about 8.8 M; at 9,766
   chunks it passes 10 M and storage is billed.
2. **AI Gateway.** Decided: `osskb-search-dev` (600 requests an hour, a
   spend limit, authentication). The publisher uses at most 80 requests a run
   through it; query-time abuse protection is slice 3 (H30).
3. **Query embedding in the browser or on the server.** Spec 005 leaves it to
   a measured spike.
4. **Actual chunk count.** Answered: 8,586 on Dev on 2026-10-10
   (`/health` `lastRun.search.chunkCount`, H41); the 8,577 above was inferred
   from the Feed index.
5. **One source for identifiers.** Slice 2a keeps `proposal.keyPattern` and
   `issueKeyPattern` (Spec 014) separate from the search profile (see
   "Community profile fit"); to confirm.
6. **Thread-title repetition** (Results). Answered by
   [Spec 017](../017-lexical-ranking/spec.md): `bm25-reference@3` bounds a
   thread's score and adds a phrase bonus, measured on a snapshot of the Dev
   release. Dev writes `@3` since Spec 017 N17.
7. **Labels.** Should `RequestManager` and `request manager` carry the
   Release Manager negative, and is "top 3" the right bound for the three
   expected threads? Still open; Spec 017 (open questions 1 and 2) adds the
   real-corpus ranks.

Raised by slice 2b:

8. **H21's wording** (Decision 9): one vector per passage, not per chunk id.
   Decided: confirmed by the owner on 2026-10-12 (owner's answer a).
9. **Finding a release's chunk at query time.** Decided in slice 3
   (Decision 25, Behavior 27): the first group root of each shard in the
   manifest, behind `SEARCH_SHARD_ROOTS`. To confirm, as a contract
   decision.
10. **Depth.** Vectorize returns at most 50 matches with metadata per
    namespace, and stale or other-revision matches are dropped after that.
    Whether 50 is enough is measured in slice 4; `returnMetadata: "indexed"`
    with a metadata index allows 100.
11. **Should the retriever tell Pages its coverage?** Still no: a release
    with shard roots is answered with whatever vectors match it, and
    `retrieval.semantic.candidates` says how many did. Whether the release
    is fully embedded is in `/health` `searchEmbedding.lastRun` only.
12. **Query embedding and the gateway cache.** Decided: skipped. The gate
    has its own cache and ledger, and the gateway's numbers should count
    exactly the calls the ledger counts.
13. **Unverified against Cloudflare:** the batch size `@cf/baai/bge-m3`
    accepts (50 assumed), its response shape (`data: number[][]` per the
    binding types), the exception text of 3036, 429, and spend-limit refusals
    for an embedding call (matched as the digest matches them), the type of
    `describe().processedUpToMutation`, and whether the CI token may deploy a
    Worker with a Vectorize binding.
14. **An empty release.** Answered: guarded (Behavior 23, owner's answer
    f).
15. **A minimum similarity** (answered 2026-10-13, Decision 43: there is
    no usable floor, for any query type; a margin over the query's own
    background marks standouts only, and `rrf-group@3` uses it for that).
    Earlier text: still open, now measurable.
    `signals.semanticScore` is served from this change on (Behavior 40), so
    the next capture records the similarity of every shown candidate and a
    floor, a gap to the best match, or a knee can be compared on the replay
    as the other alternatives were. The first capture could not: the
    response did not hold the value. Before: only non-positive scores are dropped; a real
    threshold needs slice 4's numbers.
16. **Prod.** When Prod goes live it needs its own index, gateway, binding,
    migration, and the same enable sequence; none of it exists, and nothing
    is added before the Prod launch (owner's answer e).

Raised by slice 3:

17. **The contract decisions of slice 3**, to confirm: the manifest field
    (Decision 25); the gate as a Durable Object class of the data Worker
    reached by a Pages binding (Decision 27), which is one new class and
    one new binding at the enable; the statuses and `lexicalRank` becoming
    optional (Decision 32); the caps (Decision 30).
18. **Unverified against Cloudflare**, to observe at the enable: that a
    Pages Function can call a Durable Object of another script through a
    binding on this account (the configuration builds, and it works under
    local `wrangler`); the time one single-text embedding and one index
    query take; whether the object finishes an embedding after the reader
    stopped waiting (the charge is counted either way; the cache may not be
    filled); that Vectorize bills (stored + queried) × dimensions as its
    pricing page says (read 2026-10-12); where the gate object is placed
    relative to visitors.
19. **One index query instead of one per project.** A query without a
    namespace might search the whole index and halve the index queries; the
    documentation read does not say, and a match would have to carry its
    project. Measure in slice 4.
20. **The rerank rule** (`RERANK_SHARE`): consider rerank when at least 30%
    of the fused queries have every expected thread in the hybrid top 20
    and one outside its bound. The spec's Decision 5 gives no number; this
    one is the implementer's. Status 2026-10-13: at `rrf-group@1` the rule
    says "no case for rerank" (9 of 43 fused queries, 21%), and seven of the
    nine are the regressions `rrf-group@2` removes, so the share to judge is
    the one measured after rollout step 7. Eleven queries miss an expected
    thread in the top 20: retrieval, not ranking, limits those.
21. **Labels of the 16 new queries**, all implementer-labelled from titles
    in a snapshot of 343 of 4,093 threads. For the owner's two Chinese
    examples no title says "timeout" or "slow"; the expected threads are
    the closest found.
22. **Stored dimensions are at 8.99 M of the included 10 M.** About 990
    more chunks pass it (open question 1); the charge is $0.05 per 100 M a
    month.
23. **A per-visitor limit.** Not possible without an identity; a WAF rate
    rule on `/api/search` would bound Durable Object requests as well. Not
    part of this slice.
24. **The digest's neuron estimate.** Answered: measured at 1.272 on
    2026-10-08 and applied to the budget as `DIGEST_NEURON_CALIBRATION`
    (Results, "Query budget"). The headroom is 740 neurons; both ratios are
    one measurement each.

25. **Labels of the 14 new queries** (H76), all implementer-labelled from
    titles; for `out of memory during a long rebalance` the first lexical
    thread is KAFKA-21230's pull request, which the label did not know, so
    the row understates both rankings.
26. **Queries with their words reversed** (`manager request`, `storage
    tiered`): `rrf-group@1` ranked their threads higher than lexical search
    does, and `rrf-group@2` gives that up, because the leading threads hold
    both words and the rule cannot tell an adjacent pair from a scattered
    one. Lexical search knows (the phrase bonus); the response does not say.
    A second level of trust needs that signal in the fixture first.
27. **The RRF constant.** `k = 10` under the rule is better on the tuning
    rows and not on the held-out or new rows (Decision 37). Revisit with
    more labelled rows, together with question 15.
28. **The owner's query** is not improved (Results, known limitations):
    its three threads are lexical 2, 21, 9 and semantic 28, absent, absent.
    Nothing short of ignoring semantic candidates keeps threads 21 and 9 in
    place, and no lexical signal in the response separates this query from
    the vocabulary-gap queries that need them.

29. **The embedding text** (Results, "The owner's query and the embedding
    text"). A record is embedded as its title and a 280-character excerpt.
    A follow-up spec should measure a richer text (`title-text@2`) before
    anything is re-embedded. Is the owner's label for `consumer network
    thread request manager` too narrow, given that KIP-1371 is found first?
30. **The three constants of `rrf-group@3`** (head 3, reference 20, margin
    0.04) come from 76 rows and 112 hand labels. Revisit with the next
    capture; a head of 2 and a margin of 0.03 are indistinguishable here.
31. **Should Dev switch to `rrf-group@3`?** Answered 2026-10-13: no
    (Decision 50). The implementer had recommended yes on the 86 rows
    captured for this change; the verifier's 15 fresh queries showed the
    gain is two-sided and about zero on new queries.

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
- Slice 2b sets no flag and embeds nothing on Dev or Prod until H52; since
  H52 (2026-10-12) Dev embeds and Prod does not.
- Slice 3 itself changed no deployed configuration; enable steps 2 and 3
  change Dev's only. Still not done: anything on Prod, any Cloudflare
  resource made by hand; a
  per-visitor rate limit; a redesign of the search UI; a minimum similarity
  (open question 15).
- Fusion (2026-10-13): no weight, similarity threshold, candidate depth, or
  RRF constant changes; no reranker; no change to lexical ranking, filters,
  facets, statuses, the gate, or its caches; and no change to what Dev
  serves, which stays at `rrf-group@1` until rollout step 7.
- Fusion `rrf-group@3` (2026-10-13): no floor, no weighting, no dropped
  candidate, no threshold per language, no new response field, no change
  to the embedding or its text, and no change to what Dev serves.
- A real Workers AI or Vectorize call from a test or a developer machine.
- Re-embedding to repair one vector: the unit of repair is `reset=1`.
- A ranking change for the repeated thread title (open question 6, G31):
  Spec 017.
- A different BM25 formula or field weights.
- Estimating production recall from the golden fixture.
