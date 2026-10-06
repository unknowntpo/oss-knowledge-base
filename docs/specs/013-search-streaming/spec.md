# Spec 013: Streamed Search publication with bounded lexical shards

Status: Accepted 2026-10-06 — direction approved by the human; detailed design delegated
Date: 2026-10-06
Traceability: enforced
Builds on: Spec 005, Spec 008 (ADR-0013), Spec 009

## Intent

Two problems, one cause: each project's Search data is one JSON shard.

- The data publisher (Durable Object, 128 MB isolate) builds every project's
  chunks and serializes each project shard whole, so its memory peak grows with
  Search volume. Spec 012 (Kafka mailing list and JIRA) adds volume to the
  Kafka project and is blocked until twice the current-plus-new volume fits.
- Every `/api/search` request reads every shard and re-tokenizes every chunk to
  rebuild a BM25 index, so latency grows with the corpus.

Outcome: the publisher's Search working set is bounded by the largest shard
plus bookkeeping that grows only with vocabulary and group count (term → shard
lists, one digest per group), instead of by the corpus; and a query scores
precomputed postings of only the shards that contain its terms. Ranking stays
`bm25-reference@1`, result for result.

## Evidence

Publisher memory, `bun run --cwd apps/data-publisher-worker measure:memory
--events 8600,17200,19600` on origin/main 6cfbfc6 (Node 22, seeded events,
peak of `heapUsed + arrayBuffers` after forced GC):

| Events | Peak | Peak phase | Largest object |
| --- | --- | --- | --- |
| 8,600 (1x) | 63.1 MB | write search | DataFusion shard 9.8 MB |
| 17,200 (2x) | 120.8–121.6 MB | write search | DataFusion shard 19.5 MB |
| 19,600 | 136.6 MB | write search | DataFusion shard 22.2 MB |

At 2x the phase markers read 94 MB when Search writing starts and 76 MB when
Feed writing starts, so about 18 MB is the materialized Search publication
(a second copy of every excerpt as chunk text, plus canonical detail copies)
and the rest of the spike is serializing one 19.5 MB shard (its string and
its bytes are both live).

Query latency:

- Dev, `curl -w %{time_total} 'https://oss-knowledge-base-dev.pages.dev/api/search?q=transactions'`
  at 2026-10-06 ~09:40 UTC, three runs: 5.09 s, 3.66 s, 3.54 s (14 results,
  release `feed-2026-10-06T09-07-06-000Z`).
- Local, `bun run --cwd apps/data-publisher-worker measure:search-latency`
  (committed with this spec; Bun, in-memory R2 stand-in, the Pages reader
  itself). Before, with the v2 reader:

| Events | p50 per query | R2 reads | Bytes read |
| --- | --- | --- | --- |
| 8,600 | 728–745 ms | 4 | 12.5 MB |
| 17,200 | 1,484–1,511 ms | 4 | 24.9 MB |

  Profiling one 1x query: parsing 12 MB of shards 18 ms, building the index
  (tokenizing 8,600 chunks) 695 ms, ranking 15 ms. Tokenization is 94% of a
  query; it is identical for every query and can be done once at publish time.

## Example

Dev, captured 2026-10-06 ~09:40 UTC from `/api/feed` and the Worker `/health`:
release `2026-10-06T09-07-06-000Z`, 7,449 input events (7,440 logical),
3,547 groups (DataFusion 2,860, Kafka 687) holding 7,449 records, Feed index
9.99 MB. Tokenizing every entry's `searchText` gives 22,445 distinct terms,
12,728 of them in one entry only; as `term → [df, shard…]` JSON that is
0.44 MB. Shard objects are not publicly readable; the seeded 8,600-event
release has the same shape (two-byte text, 72% comments), but its generated
vocabulary is only 3,676 terms, so every seeded query touches every shard —
the worst case.

Before (search-release.v2, seeded 1x):

```text
public/search/v1/current.json                          search-current.v1 (unchanged)
public/search/v1/releases/<rev>/manifest.json          search-release.v2
public/search/v1/releases/<rev>/lexical/apache-datafusion.json   9.78 MB
public/search/v1/releases/<rev>/lexical/apache-kafka.json        2.28 MB
public/search/v1/objects/details/<sha256>.json         unchanged
```

After (search-release.v3, same input, measured):

```text
public/search/v1/current.json                          search-current.v1 (unchanged)
public/search/v1/releases/<rev>/manifest.json          search-release.v3, 0.41 MB
public/search/v1/releases/<rev>/terms.json             search-terms.v1, 0.07 MB
public/search/v1/releases/<rev>/lexical/apache-datafusion/0.json … /7.json   1.51–1.78 MB (7.json 0.21 MB)
public/search/v1/releases/<rev>/lexical/apache-kafka/8.json, /9.json        1.70, 0.99 MB
public/search/v1/objects/details/<sha256>.json         unchanged bytes
```

```jsonc
// manifest.json (search-release.v3)
{ "schema": "osskb.search-release.v3", "indexRevision": "feed-…", "corpusRevision": "…",
  "lexicalRevision": "bm25-reference@1", "generatedAt": "…",
  "shards": [{ "projectId": "apache-datafusion", "key": "…/lexical/apache-datafusion/0.json" }, …],
  "chunkCount": 8600, "totalChunkLength": 629113, "groupCount": 2369,
  "objectDigests": { "<every shard, terms.json, and pool detail key>": "sha256:…" } }
// terms.json: global document frequency and the shards that contain each term
{ "schema": "osskb.search-terms.v1", "indexRevision": "feed-…",
  "terms": { "transaction": [2856, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9], … } }
// lexical/apache-kafka/8.json (search-lexical-shard.v2)
{ "schema": "osskb.search-lexical-shard.v2", "indexRevision": "feed-…",
  "projectId": "apache-kafka", "shard": 8,
  "chunks": [SourceRecordChunkV1, …], "lengths": [73, …],
  "postings": { "transaction": [0, 2, 5, 1], … },   // chunk index, term frequency, …
  "groups": [{ "groupRootRecordId": "…", "entry": FeedEntry, "projectStatus": "open", "detailSha256": "sha256:…" }] }
```

Query `transaction`: read `current.json`, `manifest.json`, `terms.json`;
`terms.transaction` names the shards to read; score their postings with
N = `chunkCount`, avgdl = `totalChunkLength / chunkCount` (0 when there are no
chunks), and df from `terms.json`. A query whose terms no shard contains reads
three objects and no shard.

## Simplification review

1. **Question every requirement.**
   - Global statistics (N, avgdl, df): owned by the ranking contract.
     `bm25-reference@1` scores with corpus-wide IDF; per-shard IDF changes
     results (a mutant doing so fails 12 tests), so shards cannot score alone.
   - df stored in `terms.json` (reviewer suggested deriving it from postings):
     kept, because it lets each shard be scored and released on its own; without
     it every selected shard must be held, or read twice, before any scoring.
   - Postings and chunk lengths in each shard: owned by query latency — they
     replace the 695 ms tokenization. Chunk text stays because excerpts,
     filters, and exact-identifier checks read it.
   - Term → shard lists: owned by query latency and the Pages Function's own
     memory; without them every query reads every shard.
   - `shard` in a v3 `detailRef`: owned by detail hydration, so opening a
     result reads one shard instead of searching all of a project's shards.
2. **Delete.**
   - The materialized Search publication in the publisher: no all-chunk array,
     no up-front canonical copy of every detail; groups are produced one at a
     time from the Feed publication already in memory.
   - The full group projections kept for pre-switch verification: only
     `{groupRootRecordId, detailSha256}` per group is kept.
   - Per-query index building for v3 releases (kept only for v1/v2 releases,
     which rollback and old `detailRef`s still need).
   - The second ranking pass for project facets: one pass per shard yields
     both, because a shard holds one project.
   - The `lexicalRevision` input of the writer: postings are only valid for
     `bm25-reference@1`, so the writer always declares it.
   - Precomputed `titleTerms` per chunk: computed only for candidate chunks of
     identifier-shaped queries.
   - Rejected before writing: hash-bucketed term objects (one 0.44 MB object at
     real vocabulary; one read), Bloom filters (exact shard lists are smaller at
     this vocabulary), separate postings and text objects, per-shard counts in
     the manifest, a `termsKey` field (derived from the release prefix), a
     terms cache in the Pages isolate, shard counts in `/health` (publication-set
     evidence already records every object and its byte length).
3. **Simplify.** Shards are bounded by chunk count (chunks are bounded by the
   180-word chunking window), never split a group, and never mix projects. A
   group larger than the limit gets a shard of its own.
4. **Shorten the cycle.** The shard limit is a parameter, so tests force many
   shards from the golden fixture; the whole-release v2 reader over the same
   publication is the ranking oracle the new path is diffed against.
5. **Automate last.** One committed latency command next to the memory
   command, which now also checks the Search working set; no new CI gate.

## Behavior

1. The publisher produces Search groups one at a time from the completed Feed
   publication, ordered by project and then group root (`localeCompare`); it
   never holds every chunk or every Search detail at once. Out-of-order or
   repeated groups fail the run.
2. Each project's groups fill lexical shards of at most `maxShardChunks`
   chunks (production: 1,000). A group is never split; a group with more chunks
   than the limit occupies one shard alone; a shard holds one project. Shards
   are numbered globally in write order.
3. Each shard stores its chunks, each chunk's BM25 length (the weighted token
   count `bm25-reference@1` already uses), postings `term → [chunk index,
   term frequency, …]`, and its groups with `detailSha256`. Chunk ids are unique
   in a release: within a group an identical repeat counts once and a
   conflicting one fails the run; across groups uniqueness follows from each
   SourceRecord belonging to one group, which the materializer enforces.
4. After the last shard, the release writes `terms.json` (`term → [df,
   shard…]`) and then the manifest, which lists every shard and declares the
   digest of every shard, the terms object, and every pool detail.
5. A query for a v3 release reads the pointer, manifest, and terms object;
   reads only shards named by at least one query term (project filters never
   prune shards, because facets ignore them); scores each candidate chunk as
   the sum over query terms in query order with the `bm25-reference@1` formula,
   global N, avgdl, and df; and returns the same results, order, matches,
   excerpts, and project facets as the whole-release reader. At most four
   shards are read at once; each shard keeps only its facet counts and its best
   `limit` groups, then is released.
6. A v3 `detailRef` names its shard. Hydration reads the manifest, that shard,
   and the pool detail; a shard index outside the manifest, of another project,
   or not holding the group is not found.
7. Readers still serve `search-release.v1` and `v2` releases and their
   `detailRef`s unchanged (rollback, Spec 008 rule 5). Pages that read v3 deploy
   before the Worker that writes it (CI already orders Pages first). Rolling
   back: pause the Cron (ADR-0012), then either redeploy a pre-013 Worker (its
   next run writes v2, which current Pages serve) or, to roll Pages back below
   this spec, first restore a v2 Search `current.json`. `detailRef`s issued for
   v3 releases do not resolve on pre-013 Pages.
8. Pointers still switch last, Search before Feed, only after the descriptors
   pass verification (Spec 009). Feed objects and Search pool details are byte
   for byte what the previous writer produced.

## Test plan

Shard layout, generated from `packages/serving-contract/test/search-shards.cases.ts`
by `bun run docs:test-plan`. `groups` lists `project/groupRoot:chunks` in the
order the publisher receives them; `shards` lists `index project [groupRoots]`
in write order.

<!-- test-plan:start packages/serving-contract/test/search-shards.cases.ts -->
| id | case | maxShardChunks | groups | shards |
| --- | --- | --- | --- | --- |
| L1 | groups fill a shard exactly | 4 | kafka/a:2 kafka/b:2 | 0 kafka [a b] |
| L1 | one chunk over the limit starts a shard | 4 | kafka/a:2 kafka/b:3 | 0 kafka [a]; 1 kafka [b] |
| L1 | one chunk under the limit stays | 4 | kafka/a:1 kafka/b:2 | 0 kafka [a b] |
| L1 | a group larger than the limit is alone | 4 | kafka/a:1 kafka/b:5 kafka/c:1 | 0 kafka [a]; 1 kafka [b]; 2 kafka [c] |
| L1 | a group of exactly the limit fills one shard | 4 | kafka/a:4 kafka/b:1 | 0 kafka [a]; 1 kafka [b] |
| L1 | a project boundary starts a shard | 4 | datafusion/b:1 kafka/a:1 | 0 datafusion [b]; 1 kafka [a] |
| L1 | a group without chunks joins the open shard | 4 | kafka/a:4 kafka/b:0 | 0 kafka [a b] |
| L1 | a project whose groups have no chunks still gets a shard | 4 | datafusion/a:0 kafka/b:1 | 0 datafusion [a]; 1 kafka [b] |
| L11 | no groups | 4 |  |  |
<!-- test-plan:end -->

Ranking parity, generated from `apps/web/test/search-parity.cases.ts`: each
row runs against the golden fixture published as v3 with `maxShardChunks: 2`
(5 shards) and with the production limit, and must equal the whole-release v2
response except `detailRef`. `shardsRead` is checked against an independent
scan of the shards' postings and against the exact list of R2 reads.

<!-- test-plan:start apps/web/test/search-parity.cases.ts -->
| id | query | filters | limit | shardsRead |
| --- | --- | --- | --- | --- |
| L2 | KAFKA-20983 | — | 5 | 4 |
| L2 | KIP-405 | — | 5 | 2 |
| L2 | RecordAccumulator.ready() | — | 5 | 1 |
| L2 | cleaner rewrite segment in place | — | 3 | 4 |
| L2 | issue 20983 | projectIds=apache-datafusion | 1 | 3 |
| L2 | issue 20983 | projectIds=apache-datafusion occurredAfter=2026-08-22T00:00:00Z | 10 | 3 |
| L2 | remote storage fetch latency compacted topics | — | 3 | 2 |
| L2 | RecordAccumulator ready batches Sender | — | 1 | 1 |
| L2 | move cold data off broker disks | — | 3 | 2 |
| L2 | producer | projectIds=apache-kafka projectStatuses=merged | 10 | 2 |
| L2 | tiered storage | projectIds=apache-kafka occurredBefore=2022-01-01T00:00:00Z | 10 | 2 |
| L2 | optimizer aggregate | sourceInstanceIds=apache-datafusion-github tags=schema | 10 | 2 |
| L2 | the | — | 2 | 5 |
| L3 | zzzzqqq | — | 5 | 0 |
<!-- test-plan:end -->

## Acceptance

### Behavior
- L1: given each row of the shard test plan, publishing its groups yields
  exactly the listed shards (exactly `maxShardChunks`, one over, one under, an
  oversized group, an exact-limit group, a project boundary, a group or project
  without chunks) and manifest counts equal to the inputs; out-of-order groups
  fail → evidence: `search-shards.test.ts` rows.
- L2: given the golden fixture as v3 (5 shards and production limit), every
  parity row returns the v2 reader's results, order, matches, and facets, and
  the eight golden queries keep their Phase 1 grades → evidence: parity rows,
  `precomputed-lexical.test.ts` (shard limits 1, 2, 3, 1,000).
- L3: given a v3 release, a query reads only the pointer, manifest, terms
  object, and the shards its terms name; a query whose terms no shard contains
  reads three objects and returns no results and zero facet counts → evidence:
  `shardsRead` column and recorded reads.
- L4: given a v3 result, its `detailRef` hydrates the same `FeedDetail` as the
  v2 release with three reads (manifest, its shard, one pool detail) →
  evidence: `search-streaming.test.ts`.
- L5: given the Spec 009 parity events, every Feed object, the Feed pointer,
  and every Search pool detail is byte-identical to the recorded pre-013
  publication → evidence: `publication-parity.test.ts` against
  `publication-parity.v1.json`.

### Failure and retry
- L6: given an injected failure while writing a shard or `terms.json`, both
  pointers stay unchanged; a rerun with the same input completes and reuses
  every object written before the failure → evidence: `search-shards.test.ts`.
- L7: given v2, then v3, then v2 again (Worker rollback) switching the same
  bucket's pointer, each release answers identically and every earlier
  `detailRef` still resolves → evidence: `search-streaming.test.ts`.
- L8: given a selected shard missing, of another number or project, or a terms
  object missing, of another revision, or naming an undeclared shard, the query
  fails (HTTP 503) instead of returning partial results; the intact release
  answers → evidence: `search-streaming.test.ts`.
- L9: given a v3 `detailRef` whose shard is out of range, of another project,
  not holding the group, or absent, hydration returns not found (HTTP 404) →
  evidence: `search-streaming.test.ts`.
- L10: given a streamed release whose manifest omits the terms object or
  names an undeclared shard, whose group names an undeclared detail, or whose
  group count disagrees, publication fails before any pointer switch; the
  unedited release switches → evidence: `search-shards.test.ts`.
- L11: given a Feed with no entries, the Search release is valid (no shards,
  empty terms, no results, no facets); given a project with no groups, it has no
  shard and no facet → evidence: both test files.
- L12: given terms named like `Object.prototype` members (`constructor`,
  `__proto__`, `hasOwnProperty`), they are written and read as ordinary terms;
  absent, they match nothing without error → evidence: both test files.
- L13: given a repeated chunk id in a group, it counts once; a conflicting
  repeat, or one record in two groups, fails the run → evidence:
  `search-shards.test.ts`.

### Budget
- L14: [measure] publisher memory, `bun run --cwd apps/data-publisher-worker
  measure:memory` (exits non-zero on a violation): the Search working set (peak
  while Search objects are written minus the sample when Search writing starts)
  is at most 16 MB at 8,600 and 17,200 events and grows by at most 4 MB between
  them; Search is not the peak phase; the run peak is at most 96 MB at 8,600 and
  112 MB at 17,200 events. Measured: see Results.
- L15: [measure] local query cost, `bun run --cwd apps/data-publisher-worker
  measure:search-latency`: p50 at most 150 ms at 8,600 and 300 ms at 17,200
  events for every query, including the all-shards worst case; R2 reads per
  query = 3 + selected shards; largest shard at most 3 MB.
- L16: [deploy] Dev, after the first v3 release: median of five
  `?q=transactions` requests at most 1.5 s (before: 3.5–5.1 s).
- L17: [measure] request counts, from the same two commands: a run writes
  (shards + 2) Search release objects plus new pool details, with at most 20
  shards at 17,200 events; a query reads at most 3 + shards (Pages Functions
  allow 1,000 subrequests per request on the paid plan, so the shard count has
  room for ~50x today's volume at 1,000 chunks per shard); a detail reads 3.

### Observability
- L18: [deploy] on Dev, for 24 hours after the Worker deploy, `/health`
  `lastRun.ok` stays true and `searchRevision` advances hourly, `/api/search`
  `retrieval.indexRevision` equals it, and a killed run shows phase
  `writing-search` (Spec 009 marker).

## Results (implementation, 2026-10-06)

Publisher memory (`measure:memory`, Node 22, seed 9):

| Events | Peak before → after | Peak phase after | Search working set | Shards (largest) |
| --- | --- | --- | --- | --- |
| 8,600 | 63.1 → 49.7 MB | write feed | 4.3 MB | 10 (1.8 MB) |
| 17,200 | 120.8 → 94.8 MB | write feed | 7.0 MB | 19 (2.0 MB) |
| 25,800 (supporting) | — → 138.3 MB | write feed | 8.0 MB | 27 (1.9 MB) |

Search is no longer the peak; the Feed index write is. The publisher now
fails 128 MB between 2x and 3x because of the Feed index (16.5 MB at 2x,
serialized whole), not Search — that is the next cut for Spec 012.

Query cost (`measure:search-latency`, every seeded query reads every shard):

| Events | p50 before → after | p95 after (worst query) | R2 reads | Bytes read |
| --- | --- | --- | --- | --- |
| 8,600 | 728–745 → 48–62 ms | 64 ms | 13 | 14.8 MB |
| 17,200 | 1,484–1,511 → 95–125 ms | 144 ms | 22 | 29.6 MB |

Bytes read per worst-case query grow by about 19% (postings and lengths); the
manifest (0.41 MB at 1x) grows with group count because it declares every pool
detail — accepted for now; revisit if it exceeds 2 MB.

## Review record

Independent review (Fable, spec and workflow only), 2026-10-06:

| Finding | Handling |
| --- | --- |
| Latency command not committed; S16 had no command | Applied: `measure:search-latency` committed; L17 names both commands |
| Items lacked evidence clauses | Applied |
| S1/S11 overlap; ID prefix `S` collides with Spec 005 | Applied: prefix `L`; empty release is L11 only |
| Dev latency clause compared result counts across releases | Applied: latency only; parity is L2 |
| Duplicate chunk ids unspecified | Applied: Behavior 3, L13 |
| Score summation order not pinned; avgdl with no chunks | Applied: Behavior 5, Example |
| Counters (`chunkCount`, `totalChunkLength`) not verified before switch | Rebutted: produced by the same loop that writes the shards; descriptors cannot recompute them without re-reading shards, which Spec 009 forbids; a wrong counter is caught by L2 mutants (N ±1 and length mutants fail 11 and 3 tests) |
| df in `terms.json` is redundant | Rebutted: see simplification step 1 |
| Prototype keys must use own-property reads | Applied (L12) |
| Missing row: project whose groups have no chunks | Applied |
| Rollback must pause the Cron; v3 refs fail on old Pages | Applied: Behavior 7 |
| Intent overstated the bound | Applied: Intent names the bookkeeping, L14 bounds its growth |
| Query retention unspecified; concurrency unnamed | Applied: four shards, best `limit` groups per shard |
| Worst case not budgeted; Pages limits unnamed | Applied: worst-case query in L15, limits in L17 |
| Manifest `objectDigests` on the query path | Rebutted for now with the measured 0.41 MB; revisit trigger in Results |
| Shard count and size in `/health` | Rebutted: publication-set evidence already records them |
| Project encoded twice in shard keys | Kept for readable keys |

## Non-goals

- Streaming the Feed index (the next peak after this change; see Results).
- A different ranking function, per-shard IDF, or semantic retrieval.
- Caching across Pages requests, or garbage-collecting old releases.
- Spec 012's sources; this spec only makes room for them.
