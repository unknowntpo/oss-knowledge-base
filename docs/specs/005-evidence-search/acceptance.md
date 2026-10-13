# Spec 005 Acceptance Scenarios

Status: Accepted for implementation

Accepted: 2026-08-25

These scenarios are the release gate for Phase 1 evidence lexical
search. All fixtures use fixed records, relationships, timestamps, index
revisions, and queries. Semantic retrieval and LLM behavior are not required to
pass Phase 1.

## S1 — Exact project identifier wins

**Given** Kafka and DataFusion records with overlapping numeric IDs  
**When** the query is `KAFKA-20983` or `KIP-405`  
**Then** the exact project-scoped record ranks first  
**And** no record from another project is treated as the identifier match.

## S2 — Code symbols and error text remain lexical

**Given** a source record containing `RecordAccumulator.ready()` and another
containing similar prose without the symbol  
**When** the exact symbol is searched  
**Then** the symbol-bearing record ranks first  
**And** the returned excerpt contains the matched symbol.

## S3 — Source-body evidence is searchable outside the hot summary

**Given** a term appears only in a source comment and not in the Feed title or
summary  
**When** the term is searched  
**Then** its source-record group is returned  
**And** the matching comment excerpt, author, time, and canonical URL are
visible.

## S4 — Results reuse FeedEntry and FeedDetail

**Given** matching chunks from one accepted record group  
**When** search results are assembled  
**Then** one transient `FeedEntry` has `reason.kind = search-match`  
**And** its `matchedRecordIds` and `highlightedRecordIds` cite the matches  
**And** opening `detailRef` returns a `FeedDetail` whose membership exactly
matches the entry  
**And** reloading that URL preserves the query and index revision needed to
explain why the result matched.

## S5 — Search does not merge unrelated evidence

**Given** two roots share terms but have no accepted grouping relationship  
**When** both match a query  
**Then** they remain separate results  
**And** textual similarity alone creates no accepted domain relationship.

## S6 — Filters are project-profile aware

**Given** Kafka and DataFusion use different project/source/status definitions  
**When** project, source, status, tag, or time filters are supplied  
**Then** only applicable values are evaluated  
**And** unavailable capabilities contribute no synthetic match  
**And** a project-status filter is valid only with exactly one project scope  
**And** `occurredAfter` and `occurredBefore` strictly bound the matching
evidence record timestamps, not a synthetic group timestamp.

## S7 — Ranking is deterministic and replayable

**Given** identical chunks, request, index revision, and lexical configuration
in different input orders  
**When** search is executed  
**Then** result IDs, ranks, excerpts, and next cursor are logically identical  
**And** stable IDs break otherwise equal scores.

## S8 — Duplicate observations do not duplicate results

**Given** the same source version is observed more than once  
**When** chunks are generated and searched  
**Then** one logical chunk and one evidence match remain  
**And** result rank is not increased by the duplicate.

## S9 — Index publication is atomic

**Given** a previously published search release  
**When** a new index build or upload fails before completion  
**Then** the previous search manifest remains current  
**And** Pages Functions never combine index shards from two releases.

## S10 — Search degrades without semantic or LLM services

**Given** no embedding model, ANN service, or LLM credential is configured  
**When** `/api/search` is called  
**Then** exact and BM25 lexical results remain available  
**And** the response does not fabricate semantic matches, answers, or citations.

## S11 — Invalid or empty queries are bounded

**Given** an empty, oversized, or structurally invalid request  
**When** the API validates it  
**Then** it returns a deterministic client error or bounded empty response  
**And** it performs no unbounded corpus scan.

## S12 — Every visible match is verifiable

**Given** any returned `SearchResultV1`  
**When** its matches are inspected  
**Then** each match refers to a contained record and immutable index revision  
**And** its source URL, author, time, source version, and excerpt are available
without invoking an LLM.

## S13 — Golden-query regression gate

**Given** the versioned Kafka/DataFusion golden-query fixture  
**When** a lexical algorithm, tokenizer, chunker, or field-weight revision
changes  
**Then** expected direct-answer records remain within the agreed Top-K  
**And** exact-identifier, project-isolation, and hard-negative cases have zero
unapproved regressions.

## S14 — Public interaction remains self-explanatory

**Given** Traditional Chinese and English desktop/mobile views  
**When** a user searches and opens a result  
**Then** matched excerpts and sources communicate why it appeared without
instructional onboarding prose  
**And** browser evidence contains no console errors, page errors, or failed
requests.

## S15 — A completed Feed snapshot materializes completely

**Given** one validated, completed `FeedPublication` with its FeedEntry and
FeedDetail membership  
**When** the Phase 1 Search publication is materialized with explicit corpus,
index, lexical, and generation revisions  
**Then** every FeedEntry becomes exactly one Search group and immutable detail  
**And** every contained SourceRecord produces at least one deterministic chunk  
**And** project, source instance, author, timestamp, source version, canonical
URL, group tags, group root, and root project status remain traceable  
**And** missing details, cross-group record reuse, empty evidence, or partial
membership fail the build before the Search current pointer changes  
**And** shuffled input produces the same logical shards, chunks, groups, and
details  
**And** the materializer makes no GitHub, LLM, embedding, or other network call.

The local R2 Feed snapshot loader is a POC adapter for a completed recorded
publication. It is not a claim that deployed Feed R2 becomes canonical Search
input; the target processing pipeline invokes the same materializer before the
independent Feed and Search publishers.

## Result list presentation (owner decision, 2026-10-13)

After searching `KIP770` on Dev (20 cards, each badged "Evidence search";
header "20 related entries · 63 matching source records" beside a project
facet of 152), the owner decided: readers do not care how a result was
found. Show the exact matches first, then whatever else matched. This is
presentation only; `SearchResponseV1` and the ranking are unchanged.

## S16 — A result card names no search method

**Given** results found by words alone, by meaning alone, or by both  
**When** they are shown in English or Traditional Chinese  
**Then** no card carries a method badge ("Evidence search" / 「證據搜尋」,
"Similar meaning" / 「意思相近」), and a search detail's header names none  
**And** an exact identifier match keeps its "Exact match" / 「精確命中」
marker as text.

## S17 — Exact matches first, then the rest

**Given** a response whose first results are exact identifier matches and
whose later results are not  
**When** the list is shown at 375 px or on desktop  
**Then** the cards keep the response's order  
**And** one heading, "Other related results" / 「其他相關結果」, sits between
the last exact card and the first other card  
**And** there is no heading when every result or no result is exact  
**And** non-exact results of an identifier query are not hidden.

## S18 — The count line says what is shown

**Given** a response with `results` and `facets.projects[]`  
**When** the list is shown  
**Then** the line counts the cards shown and, when more threads match than
are shown, the total: "Showing 20 of 152 matching threads"  
**And** the total is the selected project's facet count, or the sum of the
facet counts when no project is selected (a facet counts a project's
matching threads before the project filter and the limit)  
**And** exact matches are counted first when some but not all shown results
are exact: "1 exact match · showing 20 of 152 matching threads"  
**And** zero results read "No matching threads"  
**And** a total the response does not give, or one below the shown count, is
not shown: "Showing 20 matching threads"  
**And** the line is empty while a search is loading or has failed.

The rows are the test plan in [`spec.md`](spec.md#result-list-test-plan).

## Future phase gates, not required for Phase 1

Before Phase 2 semantic retrieval can replace lexical-only production ranking:

- vocabulary-gap golden queries must improve Recall@K without regressing exact
  identifiers;
- a missing or stale semantic index must fall back to the same lexical results;
- query and document embedding revisions must be compatible and observable;
- the selected query-embedding runtime must pass explicit latency, bundle-size,
  cost, and provider-replacement assertions.

Before Phase 4 learned reranking or LLM answers can ship:

- reranking depth must be capped and observable;
- every generated claim must cite returned evidence;
- timeout, quota, missing credentials, and invalid citations must degrade to
  ranked evidence;
- model, prompt, and relevance-policy revisions must be retained;
- human-authored golden grades must exist before an LLM judge becomes a gate.

## Review checklist

- Confirm that search operates over retained `SourceRecord` evidence, not only
  the current hot Feed.
- Confirm that `SearchResultV1` wraps a search-match `FeedEntry` and opens the
  existing `FeedDetail`.
- Confirm that Phase 1 is lexical and independently useful.
- Confirm that semantic and LLM paths cannot block evidence search.
- Confirm that ANN and AI providers are replaceable implementation details.
- Confirm that query length and Top-K remain bounded by the API contract.
- Record shard size, latency, errors, and Cloudflare usage as operational
  telemetry, not Phase 1 release gates. Add a measured gate only after observed
  scale, latency, CPU, or cost pressure creates a real decision.

## CI evidence layers

- **Unit:** deterministic tokenization, chunk IDs, exact recognition, BM25
  ordering, filtering, deduplication, stable tie-breaking, request bounds, and
  golden-query membership (`S1`, `S2`, `S5`-`S8`, `S11`-`S13`); the result
  card, the divider position and the count line rendered in Bun
  (`S16`-`S18`, `apps/web/test/search-results-view.test.ts`).
- **Integration:** fixed records through index publication, Pages Functions,
  `SearchResultV1`, and `FeedDetail` hydration; no network or real GitHub token
  (`S3`, `S4`, `S9`, `S10`, `S15`).
- **E2E:** a recorded Kafka/DataFusion fixture served from a recreated local R2
  namespace through Wrangler, then exercised in desktop and mobile Chromium
  (`S14`, plus the visible path of `S3` and `S4`); the result list in both
  locales at 375 px and 1280 px (`S16`-`S18`,
  `apps/web/e2e/search-semantic.spec.ts`, `apps/web/e2e-lexical2/search.spec.ts`).
- **Public smoke:** after an explicit deployment, run only the minimum requests
  needed to verify Search and immutable FeedDetail hydration. This is a
  functional check, not a load or latency benchmark, and is never scheduled.

CI must not call live GitHub, an embedding provider, or an LLM. Live-source
smoke checks remain explicit, non-blocking operations outside pull-request CI.
