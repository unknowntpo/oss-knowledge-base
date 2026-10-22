# Search

Search is lexical first: a BM25 ranker tuned for community records, where identifiers such as `KIP-770` must match exactly and multi-message threads must not drown out focused ones. On Dev a semantic retriever is fused in for vocabulary gaps. Every number below links to the measurement that produced it.

## How a query is answered {#flow}

{{flow:search}}

Select a step for its numbers and sources. Each stage is explained in the sections below.

## Two stages {#shape}

Cheap retrieval over the whole corpus comes first; a costlier reranking stage is planned only if relevant results still rank too low. Today Prod runs BM25 only; Dev adds semantic retrieval and rank fusion; no reranker is built ([docs/architecture/search-algorithm.md](docs/architecture/search-algorithm.md), [Spec 005](docs/specs/005-evidence-search/spec.md)).

**BM25** is the standard keyword-ranking formula: a term scores higher when it is rare in the corpus (inverse document frequency, IDF) and frequent in a short passage, with diminishing returns.

## The lexical ranker, bm25-reference@3 {#bm25}

| Parameter | Value | Source |
| --- | --- | --- |
| Chunk size | at most 180 words, 30-word overlap | [chunking.ts](packages/search/src/chunking.ts) |
| `k1`, `b` | 1.2, 0.75 | [lexical-search.ts](packages/search/src/lexical-search.ts) |
| Field weights | title 4, tags 2, body and author 1 | [lexical-search.ts](packages/search/src/lexical-search.ts) |
| Exact identifier boost | +1000 (always ranks first) | [lexical-search.ts](packages/search/src/lexical-search.ts) |
| Thread score | Σ chunk score × 0.25^i, best chunk first | [Spec 017](docs/specs/017-lexical-ranking/spec.md) |
| Phrase bonus | adjacent query word pairs, in order | [Spec 017](docs/specs/017-lexical-ranking/spec.md) |

### Tokenization and identifiers {#tokens}

- A word with a case boundary is indexed as itself and as its lower-case parts: `HTTPServer` also matches `http` and `server`. Index and query use the same tokenizer.
- Community identifiers are normalised before tokenizing by a per-community profile, not by core search: `KIP770`, `kip770` and `KIP-770` are the same query, and a bare `770` matches every identifier with that number in the project (KIP, Jira issue, pull request). A space is not accepted, so `Kafka 4.2.0` is not read as `KAFKA-4` ([identifiers.ts](packages/search/src/identifiers.ts), [profiles.ts](packages/reference-pipeline/src/search/profiles.ts)).

### Thread score and adjacency {#adjacency}

Earlier revisions added 0.25 × every further matching chunk, so a 19-message release thread scored 5.5× its best chunk and outranked focused threads. Revision 3 uses a geometric sum, so a thread can never score more than 4/3 of its best chunk. It also adds a bonus when two query words appear next to each other and in order: in the title it is weighted by the title weight, in the text by the mean IDF of the pair ([Spec 017](docs/specs/017-lexical-ranking/spec.md)).

### Shards and terms.json {#shards}

The publisher computes corpus statistics once (chunk count, average length, document frequency) and writes shards of at most 1,000 chunks, never splitting a thread or mixing projects. `terms.json` maps each term to its document frequency and the shards that hold it. A query reads three small files plus only the shards its terms name, at most four at a time. Before this design every query read every shard and re-tokenized about 8,600 chunks, which took 695 ms of CPU ([Spec 013](docs/specs/013-search-streaming/spec.md), [ADR-0007](docs/architecture/decisions/0007-publish-independent-versioned-search-releases.md)).

## Evaluation on the real corpus {#eval}

Spec 017 measured revisions 2 and 3 on a snapshot of 1,134 chunks from 343 threads of a Dev release (2026-10-12) with 21 labelled queries; on that snapshot the top 20 equals the full release's. Command: `bun run eval:search`, depth 20.

| Revision | Queries passing | Recall@20 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- |
| @2 | 7 / 21 | 0.9397 | 0.5913 | 0.6832 |
| @3 | 20 / 21 | 0.9841 | 0.9762 | 0.9531 |

No query got worse. Ablation: the geometric sum alone passes 15, the phrase bonus alone 10, both together 20. Phrase weights from 0.5 to 2 give nearly the same result, so the weight was not tuned. Rejected: a query-term coverage factor (lowered every metric) and BM25F (would change the stored format). Known limits: reversed word order gets no bonus, and there is no stemming. **MRR** is the mean of 1 / rank of the first relevant hit; **nDCG@10** rewards relevant hits near the top of the first ten.

## Semantic hybrid on Dev {#hybrid}

| Part | Choice | Why |
| --- | --- | --- |
| Embeddings | `@cf/baai/bge-m3`, 1,024 dimensions, `bge-m3@1` | multilingual (Chinese queries), same model at publish and query time |
| Unit | the same chunks BM25 indexes | one chunking policy, one fingerprint per chunk |
| Store | Cloudflare Vectorize, cosine, one namespace per project, behind a replaceable interface | a managed vector database must not become the public contract ([Spec 005](docs/specs/005-evidence-search/spec.md)) |
| Fusion | `rrf-group@2`: reciprocal rank fusion, k = 60, grouped by thread | see below |
| Fallback | any failure, timeout (1,000 ms), budget refusal or uncovered release returns the lexical result with HTTP 200 | search never breaks because of the semantic part |

**Reciprocal rank fusion (RRF)** adds 1 / (k + rank) from each ranked list. Plain RRF (`rrf-group@1`) hurt exact lexical hits: a thread found by only one list scores at most 1/61 ≈ 0.0164, while one found by both scores at least 0.0153, so weak semantic matches displaced correct lexical ones (on Dev, "transaction manager" moved from ranks 1–2 to 20–21). Revision 2 keeps leading lexical threads whose passage holds every query word in their lexical places; order is exact matches, then those threads, then the rest by RRF ([Spec 016](docs/specs/016-semantic-search/spec.md)).

Replay of 57 labelled rows (`bun run eval:search-fusion`): lexical meets 34, `rrf-group@1` 30 with 10 rows worse than lexical, `rrf-group@2` 39 with none worse. Identifier, number and symbol queries skip the embedding entirely. Tuning stopped after `rrf-group@3` tied @2 on 15 fresh queries; the next lever is the text that is embedded, not the fusion.

### Query budget {#budget}

A public search box must not be able to overspend. Every semantic query passes a Durable Object ledger, chosen because a hard cap needs one strongly consistent counter (eventually consistent storage could overshoot). Limits per UTC day: 1,000 neurons and 1,000 index queries; per hour: 100 model calls; queries up to 500 characters; results cached for one hour ([query-gate.ts](packages/semantic-vectorize/src/query-gate.ts)). A **neuron** is Workers AI's billing unit; the account includes 10,000 a day, shared with the digest and embedding jobs (see [Process & cost](process.html#budgets)). Over budget, search answers lexically.

> Prod search is lexical only (`bm25-reference@3` since `v0.3.1`, 2026-10-19). Several Spec 016 and 017 labels were made by the implementer and await the owner's confirmation; the design notes are still marked "under discussion".
