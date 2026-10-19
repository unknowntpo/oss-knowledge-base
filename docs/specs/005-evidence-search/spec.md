# Spec 005: Evidence-first Hybrid Search

Status: Implemented for Phases 0–1 (baseline `f57f96b`; on Prod since `v0.2.0`); Phases 2–3 continue in Specs 013, 016 and 017; Phases 4–5 not built

Owner: Project maintainers

Created: 2026-08-25

Accepted: 2026-08-25

## Intent

Let a reader search the complete retained community evidence without already
knowing a project-specific identifier or which source contains the answer.
Search results must expose the source excerpts that caused each match and open
the existing `FeedDetail` timeline rather than introducing a parallel detail
model.

The target is a hybrid retrieval pipeline inspired by the candidate-generation
and ranking separation used by X and LinkedIn. It is optimized for evidence
relevance, not click-through rate or time spent.

The human-reviewed relevance boundary is defined by the
[golden-query rubric](./golden-query-rubric.md) and its versioned
Kafka/DataFusion fixture. Retrieval implementations consume that oracle; they
do not generate it from their own output.

## User outcome

A user can enter an exact identifier, code symbol, error message, or natural
language question and receive cross-source results from Kafka, DataFusion, and
later communities. Each result shows why it matched, preserves project/source
boundaries, links to original evidence, and remains usable when every semantic
or LLM service is disabled.

## Current behavior

The deployed POC calls `/api/search`, which reads the independent immutable
Search release from R2 and ranks retained `SourceRecord` chunks with exact
identifier recognition plus deterministic BM25. Results include matched source
excerpts and an immutable `detailRef` that opens the existing `FeedDetail`.

Release `feed-2026-08-25T08-29-41-122Z` materializes all 184 accepted groups and
353 current `SourceRecord` views from the recorded Kafka/DataFusion Feed
snapshot. It does not refetch GitHub. This is complete snapshot membership, not
a claim that the retained excerpts contain full upstream bodies or complete
project history. Semantic vocabulary-gap recall remains a future phase.

## Phase 1 corpus scope

The first live lexical index is a deliberately bounded backfill, not a claim of
complete project history.

- Projects: Apache Kafka and Apache DataFusion.
- Sources: their configured GitHub issue, pull-request, and issue-comment
  records. Kafka Wiki, Jira, and mailing-list records enter the same contract
  when their connectors retain them; the index does not synthesize missing
  sources.
- Initial root selection: records updated during the 30 days preceding the
  recorded build cutoff. Retained child comments observed for those roots are
  included in the same group.
- Incremental behavior: after the initial checkpoint, every accepted new source
  version is eligible; canonical event retention is not truncated to 30 days.
- Indexed state: one latest accepted `SourceRecord` version per logical record,
  plus its accepted group root. Raw duplicate observations and superseded
  versions remain replay evidence but are not separate lexical documents.
- Exclusions: bot-only activity used solely as an activity signal, binary
  assets, image bytes, generated summaries, hidden/deleted content unavailable
  from the public source, and records rejected by domain validation.
- Failure behavior: exceeding an acquisition or release budget fails the build
  and preserves the previous manifest. It never silently drops a page or
  publishes a partial group.

The build records project/source coverage, cutoff, connector checkpoints,
event-state digest, chunker revision, and excluded-record counts. A later
backfill widens acquisition coverage and creates a new corpus/index revision;
it does not change the Search API.

The versioned golden fixture remains broader than the first live connector
coverage on purpose: it protects the source-neutral contract before Kafka Wiki,
mailing-list, and other project connectors arrive.

## Product and domain boundaries

- Canonical inputs remain `SourceRecord` evidence and accepted relationships.
- A searchable chunk is a derived index record, not canonical content.
- Search may produce a transient `FeedEntry` whose reason is `search-match`.
- Opening a search result returns the existing `FeedDetail`; there is no
  `SearchDetail`, `TopicPage`, or permanent `Subject` entity.
- Search ranking and hot Feed ranking are separate policies. Search is driven by
  query relevance; the shared Feed remains driven by deterministic community
  activity until a later personalization spec is accepted.
- An inferred semantic relationship used for retrieval does not become an
  accepted domain `Relationship`.

## Completed-snapshot materialization boundary

The first real Kafka/DataFusion Search release consumes the same completed,
validated `FeedPublication` output that already contains 184 accepted groups
and 353 current SourceRecord views. A deterministic TypeScript materializer
turns that handoff into chunks, project shards, and Search-owned FeedDetail
objects without calling GitHub again.

For the POC, an adapter reconstructs this handoff from the recorded local R2
Feed snapshot. This is a replay fixture boundary, not a new source of truth:
production processing will pass the completed publication to independent Feed
and Search publishers before either writes R2. Feed and Search keep separate
release identities and current pointers under ADR-0007.

## Public contract progression

`SourceRecordChunkV1`, deterministic chunking, and the Phase 1 lexical index are
implemented in `packages/search`. The executable R2 publication, request,
response, and immutable `detailRef` contracts live in
`packages/serving-contract/src/search-r2.ts`; Pages Functions implement
`/api/search` and `/api/search-detail/:ref` against those contracts.

```ts
type SearchChunkId = string;

interface SourceRecordChunkV1 {
  readonly schema: "osskb.source-record-chunk.v1";
  readonly id: SearchChunkId;
  readonly projectId: string;
  readonly sourceInstanceId: string;
  readonly recordId: string;
  readonly groupRootRecordId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly text: string;
  readonly canonicalUrl: string;
  readonly author: string;
  readonly occurredAt: string;
  readonly sourceVersion: string;
  readonly tags: readonly string[];
  readonly contentHash: string;
}

interface SearchRequestV1 {
  readonly schema: "osskb.search-request.v1";
  readonly query: string;
  readonly filters?: {
    readonly projectIds?: readonly string[];
    readonly sourceInstanceIds?: readonly string[];
    readonly projectStatuses?: readonly string[];
    readonly tags?: readonly string[];
    readonly occurredAfter?: string;
    readonly occurredBefore?: string;
  };
  readonly limit?: number;
  readonly cursor?: string;
}

interface SearchEvidenceMatchV1 {
  readonly chunkId: SearchChunkId;
  readonly recordId: string;
  readonly excerpt: string;
  readonly canonicalUrl: string;
  readonly occurredAt: string;
  readonly matchedTerms: readonly string[];
  readonly signals: {
    readonly exactIdentifier: boolean;
    readonly lexicalRank?: number;
    readonly semanticRank?: number;
    readonly graphDistance?: number;
    readonly fusedRank: number;
  };
}

interface SearchResultV1 {
  readonly entry: FeedEntry; // reason.kind === "search-match"
  readonly projectStatus?: string; // project-local root status; absent when unsupported
  readonly matches: readonly [SearchEvidenceMatchV1, ...SearchEvidenceMatchV1[]];
  readonly detailRef: string; // opaque SearchDetailRef, not a domain identity
}

interface SearchResponseV1 {
  readonly schema: "osskb.search-response.v1";
  readonly query: string;
  readonly results: readonly SearchResultV1[];
  readonly nextCursor?: string;
  readonly retrieval: {
    readonly indexRevision: string;
    readonly lexicalRevision: string;
    readonly semanticRevision?: string;
    readonly graphRevision?: string;
    readonly fusionRevision: string;
    readonly generatedAt: string;
    readonly stale: boolean;
  };
}
```

`SourceRecordChunkV1` is an internal/index contract. `SearchRequestV1` and
`SearchResponseV1` are serving contracts. `FeedEntry` and `FeedDetail` remain
owned by the existing domain package and ADR-0005.

## Target retrieval pipeline

```text
SearchRequestV1
      |
      +--> exact identifier / code-symbol recognition
      +--> lexical retrieval (BM25)
      +--> semantic retrieval (embedding similarity / ANN)
      +--> accepted graph-neighbor expansion
                       |
                       v
        reciprocal-rank fusion (RRF)
                       |
                       v
       project/source/status/time filters
                       |
                       v
      deterministic dedupe and group assembly
                       |
                       v
        optional Top-N cross-encoder rerank
                       |
                       v
 SearchResultV1 with matched excerpts and evidence links
                       |
                       v
         optional cited LLM answer
```

### Chunking and indexing

- Chunk source records by stable structural boundaries when the source exposes
  them; otherwise use deterministic bounded text windows with overlap.
- Chunk IDs derive from record ID, source version, ordinal, and content hash.
- Preserve source text and language. Translation never replaces indexed
  evidence.
- Build lexical fields for exact identifiers, titles, body text, authors, tags,
  and project/source metadata.
- Embeddings are derived from chunk text and record the model and text-assembly
  revision. Vectors from different model revisions are never mixed.
- Phase 1 uses the deterministic reference BM25 implementation in
  `packages/search`. It is a correctness oracle, not a commitment to a specific
  production search library.

### Candidate retrieval

1. Exact recognition boosts project-scoped identifiers and code symbols.
2. BM25 retrieves literal and partial vocabulary matches.
3. Semantic retrieval finds paraphrases through normalized embeddings and
   cosine similarity or a compatible ANN index.
4. Graph expansion adds records connected by explicit, deterministic, or
   curated relationships. Unreviewed inferred links may be a separately labeled
   candidate source but cannot mutate domain truth.

Each retriever returns a ranked list rather than a supposedly comparable raw
score.

### Fusion and ranking

The first hybrid implementation uses reciprocal-rank fusion:

```text
RRF(candidate) = sum(1 / (60 + rank_in_retriever))
```

This avoids pretending BM25, cosine, and graph scores share one scale. Exact
identifier matches remain an explicit deterministic boost. Filters, project
isolation, deduplication, bot policy, and evidence containment are deterministic
post-retrieval rules.

A later cross-encoder may rerank only the bounded Top-N candidates. It does not
scan the corpus, create canonical links, or hide the retrieval evidence.

### Result assembly

- Group matched chunks by the same accepted grouping policy used to build
  `FeedDetail`.
- Create one transient `FeedEntry(reason: search-match)` per group.
- `matchedRecordIds` and `highlightedRecordIds` identify the visible matches.
- Return the best bounded excerpts in `SearchResultV1.matches`.
- Opening `detailRef` hydrates a `FeedDetail` containing exactly the entry's
  records and accepted connections.
- Search release publication and historical detail hydration follow
  [ADR-0007](../../architecture/decisions/0007-publish-independent-versioned-search-releases.md).
- A search match alone does not merge otherwise separate groups.

`detailRef` is an opaque navigation reference, not another domain entity. It
must carry or resolve the index revision, normalized query, and group root
needed to reconstruct the same search-match `FeedEntry`. The browser must not
parse it. This preserves the explanation of why a result matched after a page
reload while keeping `FeedDetail` as the only detail model.

## Search versus Feed ranking

| Concern | Search | Shared Feed |
| --- | --- | --- |
| Trigger | Explicit user query | Scheduled/current activity view |
| Candidate corpus | Retained searchable records | Active groups in a fixed window |
| Primary objective | Evidence relevance | Community activity and freshness |
| Initial ranking | Exact + BM25; later hybrid RRF | Versioned deterministic activity |
| Personalization | None in this spec | None in this spec |
| LLM requirement | None | None |

User-specific sequential ranking, watch tags, or recommendation learning require
a later spec and interaction-consent policy. Search clicks are not silently
treated as training consent.

## LLM boundary

No LLM is required through the hybrid retrieval stage. Optional LLM capabilities
may be introduced only after deterministic retrieval is accepted:

- query rewrite or terminology expansion;
- bounded Top-N cross-encoder reranking;
- an answer or overview generated only from returned evidence;
- offline relevance judging and training-label generation.

Every generative result records evidence IDs, provider/model, prompt revision,
generation time, and failure status. BYO providers and local/OpenAI-compatible
endpoints may be supported behind one interface. Timeout, quota exhaustion, or
missing credentials must fall back to ranked evidence without blocking search.

## Serving and storage evolution

### Small-corpus serving

Phase 1 publishes a versioned, immutable lexical search projection to R2 and
serves `/api/search` through Pages Functions. The function operates on a bounded
index; R2 remains an object store rather than a query engine. Search publication
uses a manifest-last release protocol independent from the Feed manifest.

### Scaled serving

When observed shard size, latency, CPU, or cost shows that bounded R2 reads no
longer fit, a `SearchRetriever` interface owns the serving dependency. ANN
implementations remain replaceable; Cloudflare Vectorize, a self-hosted engine,
or another service may be evaluated without changing `SearchRequestV1` or
`SearchResponseV1`.

The target processing ownership remains:

- Fluss: normalized events and current source state;
- Flink: nearline chunk/index deltas, accepted links, and current projections;
- Iceberg: versioned evidence/chunk history and rebuild boundary;
- Spark: full-corpus chunking, embeddings, clustering experiments, golden-query
  evaluation, and periodic rebuilds;
- R2/Pages Functions: bounded public-safe search projections and API routing.

Full rebuild plus change-data-capture deltas follows the same recoverable shape
used by LinkedIn MUSE, but the project does not require LinkedIn-scale tooling in
the initial slice.

## Delivery phases

### Phase 0 — Browser substring baseline (complete)

The original client-side substring matcher is retained only as historical
baseline behavior. The active Vue search path calls `/api/search`.

### Phase 1 — Evidence lexical search (first executable slice complete)

- deterministic `SourceRecordChunkV1` generation;
- exact ID/symbol recognition and BM25 retrieval;
- project/source/status/tag/time filters;
- matched excerpts and original links;
- transient search-match `FeedEntry` opening the existing `FeedDetail`;
- versioned R2 search projection and `/api/search`;
- golden-query regression tests.
- complete deterministic materialization of the recorded Kafka/DataFusion Feed
  snapshot without a second source fetch.

No embedding model, vector service, LLM, Fluss, Flink, or Spark is required.

### Phase 2 — Semantic candidate retrieval

- versioned passage embeddings;
- query embeddings through a replaceable `SemanticRetriever` boundary;
- exact cosine for the small POC or ANN after a measured scale gate;
- multilingual and vocabulary-gap golden queries;
- lexical search remains available when semantic retrieval fails.

Query embedding placement (browser/local model versus a service endpoint) must
be decided by a measured Phase 2 spike; it is deliberately not fixed here.

### Phase 3 — Hybrid fusion and graph expansion

- parallel lexical, semantic, and graph retrievers;
- versioned RRF fusion;
- explicit relationship-distance evidence;
- diversity and duplicate controls;
- per-retriever and fused quality metrics.

### Phase 4 — Bounded learned reranking and cited answers

- cross-encoder reranking over a capped candidate depth;
- optional BYO/local LLM query rewrite and synthesis;
- structured citations and graceful unavailable-service behavior;
- LLM-judge evaluation only after human-authored golden relevance grades exist.

### Phase 5 — Incremental and offline scale plane

- Flink nearline index updates from durable events;
- Spark/Iceberg full rebuild, embedding, and evaluation jobs;
- parity and recovery tests between full and incremental projections;
- replaceable ANN serving selected through a separate ADR and measured SLOs.

Personalized Feed ranking remains outside all five phases.

## Quality and evaluation

The search release gate uses versioned golden queries containing:

- query text and optional filters;
- expected direct-answer records;
- acceptable one-hop mechanism/dependency records;
- clearly irrelevant hard negatives;
- query category such as identifier, symbol, error text, terminology gap, or
  cross-source question.

Phase 1 measures deterministic Top-K membership and excerpt provenance. Later
phases add Recall@K, MRR, NDCG@K, per-project coverage, zero-result rate, latency,
and lexical-only fallback parity. A new model cannot ship merely because average
quality improves; exact identifiers and project-isolation cases may not regress.

## Alternatives considered

### Keep browser substring search

Retained as fallback, rejected as the target because it searches only the
downloaded Feed index, cannot expose precise source matches, and scales with
browser payload size.

### Semantic-only retrieval

Rejected. Open-source evidence contains identifiers, code symbols, configuration
keys, and error text where lexical matching is more reliable than embeddings.

### Send the full corpus to an LLM per query

Rejected because of cost, latency, context limits, provider dependence, and weak
replay/provenance behavior.

### Adopt one managed vector database as the public contract

Deferred. The public contract describes retrieval behavior, not one vendor API.
An ANN backend is selected only after the small-corpus path fails measured gates.

### Add a separate SearchDetail model

Rejected. A search result can use `FeedEntry(reason: search-match)` and open the
existing `FeedDetail`; a second detail model would duplicate membership,
timeline, citations, and source links.

## Non-goals

- personalized recommendations or contributor ranking;
- training a custom foundation model in the initial slices;
- allowing a model to create accepted relationships automatically;
- placing Fluss, Flink, Iceberg, or Spark on the synchronous browser path;
- translating canonical upstream evidence silently;
- committing to one ANN or LLM provider;
- replacing the shared hot Feed algorithm.

## Scale revisit conditions

The first Kafka/DataFusion golden fixture, bounded corpus, immutable
`detailRef`, independent Search manifest, and project/source/status/tag/time
filters are implemented. Phase 1 deliberately has no shard-size or latency
release gate: current Cloudflare limits are not the product bottleneck, and an
invented threshold would not change the initial architecture. Keep shard bytes,
request latency, errors, CPU, and usage observable. Revisit the serving design
through a separate ADR or spec only after production evidence shows pressure or
before a materially larger corpus is published.

## External architecture references

- [X Home Mixer](https://github.com/twitter/the-algorithm/blob/main/home-mixer/README.md?plain=1): candidate generation, feature hydration, ranking, filters, and mixing.
- [LinkedIn semantic search](https://www.linkedin.com/blog/engineering/search/reimagining-linkedins-search-stack): embedding retrieval, bounded cross-encoder ranking, offline Spark, and nearline Flink.
- [LinkedIn MUSE](https://www.linkedin.com/blog/engineering/ai/semantic-search-for-ai-agents-at-scale-retrieval-and-ranking-for-linkedins-hiring-assistant): dual-tower embeddings, ANN retrieval, ranking, full rebuild, and CDC deltas.
- [LinkedIn Feed](https://www.linkedin.com/blog/engineering/feed/engineering-the-next-generation-of-linkedins-feed): unified embedding retrieval and sequential ranking; personalization is deliberately deferred here.

## Executable intent

The accepted Phase 1 behavior gates are in [`acceptance.md`](acceptance.md).
The first executable slice runs behind the CI gates defined there. Query length
and Top-K remain bounded API inputs; shard size and latency are telemetry rather
than release gates until measured operational pressure justifies a new
decision. This does not authorize weakening the accepted deterministic
behavior.

### Result list test plan

S18's count line (acceptance S16–S18, owner decision 2026-10-13). Generated
from `apps/web/test/search-results-view.cases.ts` by `bun run docs:test-plan`;
the unit tests run exactly these rows. Edit the case file, not this table.
`exact` and `shown` are counted over the response's results; `total` is the
sum of `facets.projects[].count`, or the selected project's count; `—` means
the response does not give it.

<!-- test-plan:start apps/web/test/search-results-view.cases.ts -->
| id | case | exact | shown | total | en | zh |
| --- | --- | --- | --- | --- | --- | --- |
| S18 | exact and others, more than the page (Dev, KIP770) | 1 | 20 | 152 | 1 exact match · showing 20 of 152 matching threads | 1 個精確命中 · 顯示 152 個相符討論中的前 20 個 |
| S18 | several exact and others, more than the page | 2 | 20 | 152 | 2 exact matches · showing 20 of 152 matching threads | 2 個精確命中 · 顯示 152 個相符討論中的前 20 個 |
| S18 | no exact match, more than the page | 0 | 20 | 152 | Showing 20 of 152 matching threads | 顯示 152 個相符討論中的前 20 個 |
| S18 | one more thread than the page | 0 | 20 | 21 | Showing 20 of 21 matching threads | 顯示 21 個相符討論中的前 20 個 |
| S18 | exactly the page | 0 | 20 | 20 | 20 matching threads | 20 個相符的討論 |
| S18 | fewer than the page | 0 | 7 | 7 | 7 matching threads | 7 個相符的討論 |
| S18 | fewer than the page, exact and others (local fixture, KIP770) | 2 | 7 | 7 | 2 exact matches · 7 matching threads | 2 個精確命中 · 7 個相符的討論 |
| S18 | fewer than the page, exact and others (Dev, 770) | 1 | 2 | 2 | 1 exact match · 2 matching threads | 1 個精確命中 · 2 個相符的討論 |
| S18 | one thread | 0 | 1 | 1 | 1 matching thread | 1 個相符的討論 |
| S18 | every thread is exact | 3 | 3 | 3 | 3 exact matches | 3 個精確命中 |
| S18 | the one thread is exact | 1 | 1 | 1 | 1 exact match | 1 個精確命中 |
| S18 | a full page of exact matches: how many more are exact is unknown | 20 | 20 | 152 | Showing 20 of 152 matching threads | 顯示 152 個相符討論中的前 20 個 |
| S18 | zero results | 0 | 0 | 0 | No matching threads | 沒有相符的討論 |
| S18 | total not in the response | 0 | 20 | — | Showing 20 matching threads | 顯示 20 個相符的討論 |
| S18 | total not in the response, exact and others | 1 | 20 | — | 1 exact match · showing 20 matching threads | 1 個精確命中 · 顯示 20 個相符的討論 |
| S18 | a total below the shown count is not used | 0 | 20 | 5 | Showing 20 matching threads | 顯示 20 個相符的討論 |
<!-- test-plan:end -->
