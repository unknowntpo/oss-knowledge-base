# Spec 017: Lexical ranking of threads and phrases (`bm25-reference@3`)

Status: Draft for human review — implemented behind `SEARCH_LEXICAL_REVISION`; no deployed configuration sets `bm25-reference@3` (the switch, N17, is a follow-up PR)
Date: 2026-10-12
Traceability: enforced
Builds on: Spec 005 (lexical search, exact identifiers first), Spec 013 (streaming reader, stored statistics), Spec 016 (`bm25-reference@2`, the revision flag, golden v2, open questions 6 and 7)

## Intent

A reader types two or three words of what they remember: `request manager`,
`RequestManager`, `tiered storage`. Since Spec 016 the right threads are
found, but on the real Dev corpus they are ranked below a long mail thread
that holds one of the words.

Outcome: for a query of several words, a thread that holds the words together
ranks above a thread that repeats one of them in many messages; exact
identifiers, one-word queries, filters, and facets behave as before; the
change is a new lexical revision, `bm25-reference@3`, written only when the
publisher is told to, with the `@2` rollout and rollback.

This spec changes deterministic lexical ranking only. It calls no model.

## Evidence

Dev, release `feed-2026-10-12T02-07-12-000Z` (`bm25-reference@2`, 8,700
chunks, 4,093 threads, 10 shards), read on 2026-10-12.
`GET https://oss-knowledge-base-dev.pages.dev/api/search?q=…&limit=50`:

| Query | Rank 1 | Wanted threads |
| --- | --- | --- |
| `request manager` | dev@ "4.4.0 Release Manager" | KAFKA-19804 8th, KAFKA-19738 12th, their pull requests 22nd and 20th |
| `consumer network thread request manager` | dev@ "4.4.0 Release Manager" | KAFKA-19804 12th; pull request 22667 (KAFKA-19738) 27th; pull request 22747 (KAFKA-20765) 33rd |

The same ranks come out of the release's stored shards scored offline
(`bun run --cwd packages/search real-corpus -- --release <dir>`), so the
numbers below are measured on those shards, not on the 25-chunk golden v2.

Causes, each checked on that release:

1. **Thread score.** A thread scores its best chunk plus 0.25 of every
   further matching chunk. "4.4.0 Release Manager" has 19 messages; each
   repeats the title at title weight 4 (gardening G31). For the single word
   `manager` its best chunk scores about 7.5 and the thread 41.5, while no
   other thread exceeds 8.5. So it is first for every query that holds
   `manager`. The DataFusion pull request "playground" (130 benchmark
   comments) does the same for `sort`, `merge`, `join`.
2. **No credit for adjacency.** `request` is in 6,962 of the 8,700 chunks
   (the tag `Pull Request` is indexed, G44) and `manager` in 125, so
   `manager` carries nearly all of the score: a chunk that says `LogManager`
   scores like one that says `request manager`.
3. **Coverage** (a chunk matching one term outranks one matching all) was
   believed to be a cause. Measured, it is not a separate one: see Decisions.

## Example

The evaluation corpus is a snapshot of that Dev release
(`packages/search/test/fixtures/real-corpus-snapshot.v1.json`): 1,134 chunks
of 343 threads, as the release stores them, with the release's own corpus
statistics (8,700 chunks, total length 843,737, and the document frequency of
every query term). A thread's score depends only on its chunks and those
statistics, so the snapshot ranks each query's first 20 threads exactly as the
whole release does, at `@2` and at `@3` (N16).

21 queries: one labelled by the owner (Spec 016), 20 by the implementer from
thread titles (to confirm; the table under Test plan gives the reason for
each). Ranks in the whole release, `@2` → `@3`:

| Query | Expected threads, `@2` | Expected threads, `@3` | Long thread, `@2` → `@3` |
| --- | --- | --- | --- |
| `consumer network thread request manager` (owner) | 12, 33, 79 | 2, 21, 9 | 1 → 10 |
| `request manager` | 8, 22, 12, 20, 19 | 1, 5, 2, 3, 4 | 1 → 6 |
| `RequestManager` | 8, 22, 12, 20, 19 | 1, 5, 2, 3, 4 | 1 → 6 |
| `OffsetsRequestManager` | 2, 3 | 1, 2 | 1 → 8 |
| `CommitRequestManager` | 4, 3, 2 | 3, 2, 1 | 1 → 10 |
| `AsyncKafkaConsumer` | 6, 1, 2, 5, 4, 7, 3 | 6, 2, 1, 5, 4, 7, 3 | 23 → beyond 100 |
| `heartbeat request manager` | 3, 2, 4 | 2, 1, 3 | 1 → 12 |
| `release manager` (the long thread is the answer) | 1 | 1 | — |
| `log manager` | 2, 6, 4, 7 | 1, 4, 3, 5 | 1 → 16 |
| `KIP770`, `KIP-770`, `770` | 1 | 1 | — |
| `txn` | 1, 2, 3, 4, 5 | 1, 2, 3, 4, 5 | — |
| `KAFKA-19804` | 1, 2 | 1, 2 | 5 → beyond 100 |
| `disk manager` | 2, 3, 4 | 1, 2, 3 | 1 → 8 |
| `transaction manager` | 2, 3 | 1, 2 | 1 → 11 |
| `remote log manager` | 2, 3, 5 | 1, 2, 3 | 1 → 29 |
| `SortMergeJoinExec` | 7, 9, 4, 8, 2, 3 | 4, 6, 3, 5, 1, 2 | 1 → beyond 100 ("playground") |
| `GroupMetadataManager` | 2 | 1 | 1 → 14 |
| `tiered storage` (held out) | 3, 8, 19, 11, 21 | 1, 2, 4, 3, 5 | — |
| `KRaft controller` (held out) | 10, 4, 5, 8 | 4, 1, 2, 3 | — |

"Long thread" is "4.4.0 Release Manager" unless named. The two held-out
queries were added after the ranking was chosen.

`bun run eval:search` on the snapshot (depth 20):

| Configuration | Pass | Fail | Recall@20 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- | --- |
| `bm25-reference@2` | 7 | 14 | 0.9397 | 0.5913 | 0.6832 |
| `bm25-reference@3` | 20 | 1 | 0.9841 | 0.9762 | 0.9531 |

No query is worse at `@3` on any of the three metrics. The one failure is the
owner's query, on its "top 3" bound:

| | `@2` | `@3` |
| --- | --- | --- |
| KAFKA-19804 (issue) | 12 | 2 |
| KAFKA-20765 (pull request 22747) | 33 | 21 |
| KAFKA-19738 (issue) | 79 | 9 |
| "4.4.0 Release Manager" (must not be in the top 3) | 1 | 10 |
| Recall@20 / MRR / nDCG@10 | 0.3333 / 0.0833 / 0.0000 | 0.6667 / 0.5000 / 0.4308 |

At `@3` rank 1 is KAFKA-17734 ("…can block indefinitely in
ConsumerNetworkClient.poll", unjudged), which holds `consumer network`
adjacent in its title. Pull request 22747 holds `consumer`, `request`, and
`manager` but neither `network` nor `thread`: no lexical ranking puts it in
the top 3 for this query. That is a vocabulary gap, the case Spec 016's
semantic slices exist for.

## Decisions (implementer, 2026-10-12; to confirm)

Each candidate was measured alone and combined on the whole Dev release, 21
queries (`bun run --cwd packages/search real-corpus -- --release <dir>
--ablation`):

| Variant | Pass | Recall@20 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- |
| `@2` | 7 | 0.9397 | 0.5913 | 0.6832 |
| best chunk only (further-chunk weight 0) | 16 | 0.9492 | 0.8639 | 0.8619 |
| geometric thread score only | 15 | 0.9397 | 0.8443 | 0.8259 |
| geometric, ratio 0.5 | 10 | 0.9397 | 0.7596 | 0.7660 |
| phrase bonus only | 10 | 0.9841 | 0.7778 | 0.8606 |
| best chunk only + phrase bonus | 20 | 0.9841 | 0.9524 | 0.9497 |
| geometric + phrase bonus, weight 0.5 | 20 | 0.9841 | 0.9683 | 0.9446 |
| **`@3`: geometric + phrase bonus, weight 1** | **20** | **0.9841** | **0.9762** | **0.9531** |
| geometric + phrase bonus, weight 2 | 19 | 1.0000 | 0.9762 | 0.9443 |

1. **Shipped: a bounded thread score and a phrase bonus.** Neither alone is
   enough (15 and 10 of 21); together 20. Weights 0.5 to 2 give nearly the
   same result, so the weight is not tuned to these queries.
2. **Geometric rather than "best chunk only".** Both bound a thread. Geometric
   keeps some credit for a thread with several matching messages (at most
   one third more than its best chunk) and reuses the existing 0.25 as its
   ratio, so no constant is added. Combined with the phrase bonus it scores
   slightly higher (MRR 0.9762 against 0.9524). It also answers G31 without
   detecting which chunks repeat a title.
3. **The phrase bonus reads the title and text the shard already stores.**
   No positions are indexed, so the stored release does not grow (N4). It is
   computed only for chunks whose postings hold both words of a pair, and the
   words are tokenized only when a cheap string test says the pair may be
   adjacent (Budget, N15).
4. **Dropped: query-term coverage.** Measured with a throwaway prototype of
   the scorer (it reproduced the `@2` and `@3` rows above exactly; 19
   queries, before the held-out ones): multiplying a chunk's score by the
   IDF-weighted share of query terms it matches gave 9 of 19 alone (`@2`: 7),
   and added to the shipped pair it lowered Recall@20 (0.9825 → 0.9649) and
   nDCG@10 (0.9481 → 0.9358). Once a thread is bounded and adjacent words are
   credited, BM25's own sum already favours chunks matching more terms.
   Coverage is not shipped and its prototype is not in the repository.
5. **Dropped: BM25F-style field combination.** Not needed for these queries,
   and it changes postings and lengths, which a stored-format change would
   have to justify.
6. **The title weight of the bonus is the existing `titleWeight` (4).** A
   separate constant of 2 scored lower (nDCG@10 0.9378 against 0.9481 on the
   19 queries).
7. **`@3` is a release revision, not a reader option**, although its stored
   objects equal `@2`'s. One mechanism then covers rollout and rollback, the
   response's `retrieval.lexicalRevision` names the ranking that produced it,
   and a release is replayable from its own objects.
8. **The evaluation corpus is a committed snapshot** (1.07 MB; the recorded
   Feed fixture next to it is 1.2 MB). It needs no network in CI and is exact
   for the first 20 results. An evaluation against the live API would not be
   deterministic and could not be run at `@3` before the switch.
9. **No third local Pages server.** Spec 016 added one for `@2` (G35). The
   reader's code path for `@3` is the `@2` path with another config, and it is
   tested through the Pages handler with an in-memory bucket (N5, N9, N11).

## Simplification review

1. Question every requirement.
   - A new revision: needed, because Dev's ranking must not change at merge
     and a rollback must not need a deploy of Pages.
   - Two config fields (`furtherChunkWeighting`, `phraseWeight`): the reader
     and the publisher both rank from one config; `@1` and `@2` configs carry
     neither.
   - The snapshot's document frequencies: needed to score the snapshot as
     the release does; only the query terms' values are stored (37).
   - Owner/implementer labels per row: the owner must be able to tell which
     labels are theirs.
2. Delete.
   - Coverage and BM25F (Decisions 4, 5).
   - Stored positions and any shard or manifest field: none added.
   - A "why this ranked" field in `SearchResponseV1`: not added.
   - A third Pages server and E2E bucket (Decision 9).
   - A golden v3 schema: the snapshot's queries are golden v2 queries built
     from the case rows; a copy of the identifier patterns: golden v2's is
     reused.
   - Recording the ablation prototype in the repository.
3. Simplify. The thread score is one expression; the bonus is one function;
   the rollout reuses Spec 016's flag, checks, and failure paths unchanged.
4. Shorten the cycle. `bun run eval:search` reports both corpora offline in
   seconds; `real-corpus.test.ts` fails when the committed report drifts.
5. Automate last. Refreshing the snapshot is one command against a release
   directory; nothing schedules it.

## Behavior

1. **Revision.** `bm25-reference@3` tokenizes, indexes, and queries exactly
   as `bm25-reference@2` (Spec 016 Behavior 2 and 3, including identifier
   profiles) and scores chunks with the same BM25. It differs in rules 2 and
   3 only. `@1` and `@2` rank as before, byte for byte; neither rule can be
   enabled for them. `DEFAULT_LEXICAL_REVISION` stays `bm25-reference@1`.
2. **Thread score.** A thread's chunks are ordered as before: exact matches,
   then score, then chunk id. Its score is `Σ score_i × 0.25^i` with `i = 0`
   for the first chunk (`additionalGroupMatchWeight` is the ratio). A thread
   therefore scores less than 4/3 of its best chunk. The evidence shown (the
   first five chunks) is unchanged.
3. **Phrase bonus.**
   - Words. A text is read as words: every token cut at dots, hyphens, and
     camelCase boundaries (Spec 016 Behavior 2), lower-cased, in reading
     order. `HeartbeatRequestManager` and `heartbeat request-manager` are the
     same three words. An upper-case constant with underscores is one word.
   - Pairs. The query's pairs are its distinct adjacent word pairs, in order,
     after identifier canonicalization (`KIP770` → `kip`, `770`). A one-word
     query has none.
   - Bonus. For each pair that a chunk holds adjacent and in order in its
     title, the chunk gains `phraseWeight × titleWeight × (idf(a) + idf(b)) /
     2`; otherwise, if its text holds it, `phraseWeight × (idf(a) + idf(b)) /
     2`. `phraseWeight` is 1, `titleWeight` 4; IDF is the BM25 IDF from the
     release's statistics. A pair counts once per chunk. Tags and author are
     not read.
   - The bonus is part of the chunk's score, so rule 2 applies to it.
4. **Unchanged.** Exact identifier matches rank first (the comparator orders
   exact matches before score, and the exact boost is unchanged). The set of
   matching threads, project facets, filters, the limit, and tie-breaks (score,
   then thread id) are those of `@2`. Core search holds no community constant.
5. **Stored format.** A release written at `@3` holds the same shard, term,
   and detail objects as at `@2`; only `manifest.json` differs, in
   `lexicalRevision`. The reader needs no object beyond those Spec 013 names.
6. **Reader.** `/api/search` answers releases of `@1`, `@2`, and `@3`, each
   with its own config; any other revision is HTTP 503 with `no-store`, and
   nothing after the manifest is read (Spec 016 Behavior 12).
   `SearchResponseV1` is unchanged; `retrieval.lexicalRevision` names the
   revision.
7. **Publisher.** `SEARCH_LEXICAL_REVISION=bm25-reference@3` writes an `@3`
   release. Unset, blank, `@1`, and `@2` behave as before; any other value
   fails the run before a source is polled or an object written (Spec 016
   Behavior 13). This spec changes neither deployed configuration: Dev stays
   at `@2`, Prod unset.
8. **Evaluation.** The real-corpus snapshot holds, for every case query, the
   threads ranking in the first 30 of the release at `@2` or `@3` and every
   judged thread, with all their chunks, and the release's chunk count, total
   chunk length, and the document frequency of every query term. A snapshot
   that lacks one of those frequencies, or records one below what it itself
   holds, is rejected. `bun run eval:search` writes
   `real-corpus-evaluation.v1.json` next to the unchanged
   `golden-evaluation.v2.json`.

## Contract changes and rollout

All additive:

- `packages/search`: `THREAD_PHRASE_LEXICAL_REVISION`,
  `threadPhraseLexicalSearchConfig`, `lexicalWords`,
  `LexicalSearchConfigV1.furtherChunkWeighting` and `.phraseWeight`;
  `SUPPORTED_LEXICAL_REVISIONS` gains `bm25-reference@3`.
- `SearchReleaseManifestV3.lexicalRevision` may be `bm25-reference@3`. Shard,
  terms, and manifest schemas are unchanged.
- `SearchResponseV1`, release objects, and both Worker configurations:
  unchanged.
- Spec 016 tests that used `bm25-reference@3` as their example of an unknown
  revision now use `bm25-reference@4`.

Rollout, the Spec 016 pattern (Pages deploy before the Worker in one CI job;
the Cron can run at any time, so order is enforced by the flag):

1. **This PR merges.** Pages read `@1`, `@2`, `@3`. The Worker can write `@3`
   but Dev's variable is `bm25-reference@2`, so nothing a reader sees changes.
2. **Switch (N17), a separate PR**, once this PR's deploy and deployed E2E
   are green on `main`: `apps/data-publisher-worker/wrangler.development.jsonc`
   sets `"SEARCH_LEXICAL_REVISION": "bm25-reference@3"`; the `H39` test pins
   Dev to `@3`; the feature map, Spec 016's status line, and G34 are updated.
   Dev serves `@2` until the next hourly run moves `current.json`. Every run
   writes a complete release; no backfill.
3. **Turning `@3` off.** Set the variable back to `bm25-reference@2` (revert
   the switch PR). The next run writes an `@2` release. Releases are
   immutable, so nothing is deleted. `POST /run` shortens the wait.
4. **Rolling Pages back below this PR** while the current release is `@3`:
   that reader answers `/api/search` with HTTP 503. Do step 3 first and wait
   for `/health` `lastRun.search.lexicalRevision` to read `bm25-reference@2`.
5. **A wrong value** publishes nothing; both pointers stay; `/health` names
   the value.
6. Production: unchanged by this spec and by the switch.

## Test plan

Generated by `bun run docs:test-plan`. Edit the case files, not these tables.

Thread score (`packages/search/test/thread-score.test.ts`):

<!-- test-plan:start packages/search/test/thread-score.cases.ts -->
| id | case | chunks | at2 | at3 |
| --- | --- | --- | --- | --- |
| N1 | one chunk | 1 | 1 | 1 |
| N1 | two chunks: the same at both revisions | 2 | 1.25 | 1.25 |
| N1 | three chunks: the first difference | 3 | 1.5 | 1.3125 |
| N1 | five chunks | 5 | 2 | 1.33203125 |
| N1 | 19 chunks, as in the 4.4.0 Release Manager thread | 19 | 5.5 | 1.3333333333284827 |
| N1 | 130 chunks, as in the playground pull request | 130 | 33.25 | 1.3333333333333333 |
<!-- test-plan:end -->

Phrase bonus (`packages/search/test/phrase-bonus.test.ts`):

<!-- test-plan:start packages/search/test/phrase-bonus.cases.ts -->
| id | case | query | title | text | titlePairs | textPairs |
| --- | --- | --- | --- | --- | --- | --- |
| N2 | the words, adjacent in the title | request manager | Improve heartbeat request manager interval | It starts at zero. | request+manager | — |
| N2 | a class name holds its words adjacent | request manager | Test the OffsetsRequestManager | More unit tests. | request+manager | — |
| N2 | a camelCase query is its words | RequestManager | Improve heartbeat request manager interval | It starts at zero. | request+manager | — |
| N2 | the pair only in the text | request manager | Fix a retry loop | CommitRequestManager retries the request. | — | request+manager |
| N2 | a pair in both is credited once, to the title | request manager | Request manager cleanup | The request manager leaks. | request+manager | — |
| N2 | a hyphen between the words | request manager | The request-manager | None. | request+manager | — |
| N2 | a dot between the words | request manager | Call Request.manager | None. | request+manager | — |
| N2 | several punctuation marks between the words | request manager | Request: (Manager) | None. | request+manager | — |
| N2 | a line break between the words | request manager | Notes | A request

manager. | — | request+manager |
| N2 | full-width letters are normalized | request manager | ＲｅｑｕｅｓｔＭａｎａｇｅｒ | None. | request+manager | — |
| N2 | the words apart | request manager | Request a new manager | For the next cycle. | — | — |
| N2 | the words reversed | request manager | Manager request queue grows | It is unbounded. | — | — |
| N2 | one word in the title, the other in the text | request manager | A new request | Manager approval is pending. | — | — |
| N2 | a longer word is another word | request manager | Request managers wait and prerequest manager | A request managerial note. | — | — |
| N2 | three words: both pairs | heartbeat request manager | AbstractHeartbeatRequestManager JavaDoc | None. | heartbeat+request request+manager | — |
| N2 | three words: one pair in the title, one in the text | heartbeat request manager | The request manager | A heartbeat request is sent. | request+manager | heartbeat+request |
| N2 | a repeated pair counts once | request manager request manager | RequestManager RequestManager | None. | request+manager manager+request | — |
| N2 | a dotted symbol with a call | RecordAccumulator.ready() | Fix RecordAccumulator.ready() wakeups | None. | record+accumulator accumulator+ready | — |
| N2 | an identifier written without its hyphen | KIP770 | Add a config based on KIP-770 | None. | kip+770 | — |
| N2 | an upper-case constant is one word | member epoch | Handle STALE_MEMBER_EPOCH | The member has an epoch. | — | — |
| N2 | a capital sigma: the shortcut is skipped, the pair is found | ΟΔΟΣ xy | ΟΔΟΣXy | None. | οδος+xy | — |
| N2 | one word: no pair | manager | Request manager | None. | — | — |
<!-- test-plan:end -->

Real corpus (`packages/search/test/real-corpus.test.ts`; record ids are
thread roots on Dev):

<!-- test-plan:start packages/search/test/real-corpus.cases.ts -->
| id | case | labels | query | expected | acceptable | notInTop3 | within | at2 | at3 | why |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N3 | the owner's query | owner | consumer network thread request manager | kafka:jira:issue:KAFKA-19804 kafka:github:pull:22747 kafka:jira:issue:KAFKA-19738 | kafka:github:pull:23687 kafka:jira:issue:KAFKA-20765 kafka:github:pull:22667 kafka:jira:issue:KAFKA-20397 kafka:github:pull:21991 | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | 3 | fail | fail | Owner: KAFKA-19804, KAFKA-20765 (its pull request 22747), KAFKA-19738 in this order, KAFKA-20397 acceptable, Release Manager not in the top 3. Implementer: the other thread of each key is acceptable. |
| N3 | two words of a class name | implementer | request manager | kafka:jira:issue:KAFKA-19804 kafka:github:pull:23687 kafka:jira:issue:KAFKA-19738 kafka:github:pull:22667 kafka:github:pull:20964 | kafka:jira:issue:KAFKA-20995 kafka:mail:dev:message:g239gn2xpz13m2hzl90sgw885js7hxop kafka:jira:issue:KAFKA-20765 kafka:github:pull:22747 | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | 9 | fail | pass | Expected: the five threads whose title holds `request manager` or a `…RequestManager` class. Acceptable: KIP-1371 (title says `Request Managers`, plural) and KAFKA-20765 (`CommitRequestManager` in the body). |
| N3 | the same words as one camelCase fragment | implementer | RequestManager | kafka:jira:issue:KAFKA-19804 kafka:github:pull:23687 kafka:jira:issue:KAFKA-19738 kafka:github:pull:22667 kafka:github:pull:20964 | kafka:jira:issue:KAFKA-20995 kafka:mail:dev:message:g239gn2xpz13m2hzl90sgw885js7hxop kafka:jira:issue:KAFKA-20765 kafka:github:pull:22747 | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | 9 | fail | pass | The same question as `request manager`, so the same labels. |
| N3 | a class name in two titles | implementer | OffsetsRequestManager | kafka:jira:issue:KAFKA-19738 kafka:github:pull:22667 | — | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | 2 | fail | pass | The only two titles naming the class. |
| N3 | a class name only in bodies | implementer | CommitRequestManager | kafka:jira:issue:KAFKA-20765 kafka:github:pull:22747 kafka:jira:issue:KAFKA-21249 | — | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | 3 | fail | pass | No title names the class; these are the only three threads whose text does. |
| N3 | a class name in seven titles | implementer | AsyncKafkaConsumer | kafka:github:pull:23423 kafka:github:pull:23123 kafka:github:pull:23756 kafka:jira:issue:KAFKA-20187 kafka:jira:issue:KAFKA-21248 kafka:jira:issue:KAFKA-20765 kafka:jira:issue:KAFKA-21229 | — | — | 7 | pass | pass | The seven titles naming the class. Passes at `@2`; guards against a regression. |
| N3 | three words of a class name | implementer | heartbeat request manager | kafka:jira:issue:KAFKA-19804 kafka:github:pull:23687 kafka:github:pull:20964 | — | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | 3 | fail | pass | KAFKA-19804 (issue and pull request) says `heartbeat request manager`; pull request 20964 names `AbstractHeartbeatRequestManager`. |
| N3 | the long thread is the answer | implementer | release manager | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | — | — | 1 | pass | pass | Guard against over-correcting: for this query the dev@ thread titled `4.4.0 Release Manager` must stay first. |
| N3 | two common words of several class names | implementer | log manager | kafka:jira:issue:KAFKA-20390 kafka:github:pull:23772 kafka:github:pull:23385 kafka:jira:issue:KAFKA-21038 | kafka:github:pull:23604 kafka:jira:issue:KAFKA-20967 kafka:github:pull:23211 | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | 7 | fail | pass | Expected: titles naming `LogManager` or `LogManagerBuilder`. Acceptable: titles naming `RemoteLogManager`, which holds the two words. |
| N3 | identifier without its hyphen | implementer | KIP770 | kafka:github:pull:22458 | — | — | 1 | pass | pass | The only thread whose title names KIP-770 (Spec 016 R1). |
| N3 | canonical identifier | implementer | KIP-770 | kafka:github:pull:22458 | — | — | 1 | pass | pass | The same thread as `KIP770`. |
| N3 | bare number | implementer | 770 | kafka:github:pull:22458 | — | — | 1 | pass | pass | The only identifier with this number on Dev is KIP-770; one word, so its order is the `@2` order. |
| N3 | an abbreviation, one word | implementer | txn | kafka:jira:issue:KAFKA-20785 kafka:github:pull:23204 kafka:github:pull:23539 kafka:jira:issue:KAFKA-21137 kafka:github:pull:23538 | — | — | 5 | pass | pass | The five titles holding the token `txn` (`EndTxn`, `testSendTxnOffsets…`, `txn-offset-commit`). One word: guards the `@2` order. |
| N3 | exact Jira key | implementer | KAFKA-19804 | kafka:jira:issue:KAFKA-19804 kafka:github:pull:23687 | — | — | 2 | pass | pass | The issue and its pull request are the exact matches. |
| N3 | another project | implementer | disk manager | datafusion:github:pull:26110 datafusion:github:pull:23139 datafusion:github:pull:22246 | — | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | 3 | fail | pass | The three DataFusion titles naming `DiskManager` or `disk manager`; a Kafka mail thread must not lead a DataFusion question. |
| N3 | class name and its words in two titles | implementer | transaction manager | kafka:github:pull:23547 kafka:jira:issue:KAFKA-20237 | kafka:github:pull:21715 | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | 3 | fail | pass | KAFKA-20237: the issue says `TransactionManager`, its pull request `transaction manager`. Acceptable: the earlier pull request of the same key. |
| N3 | three words of one class name | implementer | remote log manager | kafka:github:pull:23604 kafka:jira:issue:KAFKA-20967 kafka:github:pull:23211 | — | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | 3 | fail | pass | The three titles naming `RemoteLogManager`. |
| N3 | a class name against a 130-comment thread | implementer | SortMergeJoinExec | datafusion:github:issue:25205 datafusion:github:issue:25546 datafusion:github:pull:24517 datafusion:github:pull:24593 datafusion:github:pull:25490 datafusion:github:pull:26090 | — | datafusion:github:pull:25487 | 6 | fail | pass | The six DataFusion titles naming the class. `playground` is a benchmark pull request whose bot comments repeat `sort`, `merge`, `join`. |
| N3 | a dotted class name in one title | implementer | GroupMetadataManager | kafka:jira:issue:KAFKA-21176 | kafka:github:pull:23530 | kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2 | 2 | fail | pass | KAFKA-21176 is the only title naming the class; pull request 23530 fixes it and names the key. |
| N3 | held out: a two-word topic | implementer | tiered storage | kafka:github:pull:21108 kafka:github:pull:23456 kafka:jira:issue:KAFKA-20047 kafka:jira:issue:KAFKA-17665 kafka:jira:issue:KAFKA-19968 | — | — | 5 | fail | pass | The five titles holding `tiered storage`. Added after the ranking was chosen, to check it on a query without `manager`. |
| N3 | held out: a product word and a role | implementer | KRaft controller | kafka:github:pull:19321 kafka:jira:issue:KAFKA-18874 kafka:jira:issue:KAFKA-20839 kafka:jira:issue:KAFKA-21129 | — | — | 4 | fail | pass | The four titles holding `KRaft controller`. Added after the ranking was chosen. |
<!-- test-plan:end -->

Pages reader over golden v2 at `@3`
(`apps/web/test/search-lexical-revision-3.test.ts`):

<!-- test-plan:start apps/web/test/search-lexical-revision-3.cases.ts -->
| id | case | query | projects | first | firstAt2 | exact | results |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N5 | two words of a class name | request manager | — | kafka:jira:issue:KAFKA-19804 kafka:jira:issue:KAFKA-19738 kafka:mail:dev:release-manager-4-4-0 | kafka:mail:dev:release-manager-4-4-0 | 0 | 8 |
| N5 | the same words as a camelCase fragment | RequestManager | — | kafka:jira:issue:KAFKA-19804 kafka:jira:issue:KAFKA-19738 kafka:mail:dev:release-manager-4-4-0 | kafka:mail:dev:release-manager-4-4-0 | 0 | 8 |
| N5 | the owner's query | consumer network thread request manager | — | kafka:jira:issue:KAFKA-19804 kafka:jira:issue:KAFKA-19738 kafka:jira:issue:KAFKA-19919 kafka:github:pull:22747 | kafka:jira:issue:KAFKA-19919 | 0 | 12 |
| N5 | the thread's own title still leads | release manager | — | kafka:mail:dev:release-manager-4-4-0 | kafka:mail:dev:release-manager-4-4-0 | 0 | 5 |
| N5 | identifier without its hyphen | KIP770 | — | kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss | kafka:github:pull:22458 | 2 | 7 |
| N5 | bare number lists every kind | 770 | — | datafusion:github:pull:770 kafka:jira:issue:KAFKA-770 kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss | datafusion:github:pull:770 | 4 | 4 |
| N5 | bare number within one project | 770 | apache-datafusion | datafusion:github:pull:770 | datafusion:github:pull:770 | 1 | 1 |
| N5 | a golden v1 identifier | KIP-405 | — | kafka:wiki:kip-405 | kafka:wiki:kip-405 | 1 | 5 |
| N5 | one word | txn | — | kafka:jira:issue:KAFKA-20785 | kafka:jira:issue:KAFKA-20785 | 0 | 1 |
<!-- test-plan:end -->

## Acceptance

Each item: precondition → action → observable result → evidence.

### Behavior
- N1: given a thread of n matching chunks, when it is ranked at `@3`, its
  score is its chunks' scores best first, each a quarter of the weight of the
  one before (every `N1` row); at `@2` the same thread scores the flat sum; a
  19-message thread holding one query word ranks below a record holding
  both, and still first for the phrase in its own title; the evidence shown
  is unchanged → evidence: `thread-score.test.ts`.
- N2: given one chunk and a query, the chunk's score at `@3` exceeds its
  score without the bonus by exactly the credited pairs of every `N2` row
  (title pairs at weight 4, text pairs at weight 1, once per pair, none for
  words apart, reversed, in different fields, or part of longer words) →
  evidence: `phrase-bonus.test.ts`.
- N3: given the Dev snapshot, every `N3` row has the listed status at `@2`
  and at `@3`, no query is worse at `@3` on Recall@20, MRR, or nDCG@10, the
  long thread leaves the top 3 wherever a row forbids it, the aggregates are
  those of the Example, and the committed report equals a fresh run →
  evidence: `real-corpus.test.ts`,
  `packages/search/test/fixtures/real-corpus-evaluation.v1.json`.
- N4: given the same chunks, `@3` postings, lengths, and query terms equal
  `@2`'s; a release written at `@3` equals the `@2` release object for
  object except the manifest's `lexicalRevision`; shards of 1, 2, 3, 50, and
  1,000 chunks rank like the in-memory `@3` index → evidence:
  `lexical-revision-3.test.ts`, `search-shards.test.ts`.
- N5: given golden v2 published at `@3`, `/api/search` returns every `N5`
  row's first threads, exact matches first, equal to the whole-corpus `@3`
  index, with the facets and thread set of the `@2` release, reading only
  the shards that hold a query term; the response keeps the
  `osskb.search-response.v1` fields; a whole-release layout answers like its
  shards → evidence: `search-lexical-revision-3.test.ts`.
- N6: given `SEARCH_LEXICAL_REVISION=bm25-reference@3`, a publisher run
  writes a release whose manifest names `@3` and whose shard, terms, and
  detail objects equal an `@2` run's, and `/health` `lastRun.search` names
  `@3` → evidence: `pipeline.test.ts`.

### Failure and retry
- N7: given golden v2 and the Dev snapshot, `@1` and `@2` postings and full
  rankings (scores, evidence, facets) hash to the digests computed at
  `origin/main` e9984d0; their configs carry neither new field →
  evidence: `lexical-revision-3.test.ts`; `golden-evaluation.v2.json` is
  byte-identical.
- N8: given golden v2 and golden v1, no query is worse at `@3` than at `@2`
  on any metric, none that passed fails, and every Phase 1 golden v1 query
  keeps its grade → evidence: `lexical-revision-3.test.ts`.
- N9: given a release whose manifest names `bm25-reference@4` or another
  unknown revision, `/api/search` answers HTTP 503 with `no-store` and reads
  nothing after the manifest, for sharded and whole-release layouts; the same
  objects naming `@3` answer 200 → evidence:
  `search-lexical-revision-3.test.ts`.
- N10: given an unsupported `SEARCH_LEXICAL_REVISION`, the run fails before
  a poll or a write and `/health` names the value; after an `@3` run, a run
  at `@2` or without the variable writes that revision and leaves the `@3`
  release in place → evidence: `pipeline.test.ts`.
- N11: given one bucket whose `current.json` moves `@2` → `@3` → `@2`, each
  answer is ranked by its release's revision and every earlier `detailRef`
  still resolves → evidence: `search-lexical-revision-3.test.ts`.
- N12: given a config that sets either new field with `@1` or `@2`, or a
  `phraseWeight` that is not a positive number, building an index, postings,
  or query terms throws → evidence: `lexical-revision-3.test.ts`.
- N13: given a snapshot with another schema, a missing or impossible
  document frequency, statistics of `@1`, or a missing judged thread, the
  parser rejects it; scoring a term without a recorded statistic throws →
  evidence: `real-corpus.test.ts`.
- N14: given `@3`, an exact identifier match ranks first even when another
  thread scores higher before the exact boost; matching threads, facets,
  the project filter, and the limit equal `@2`'s; equal scores order by
  thread id; a one-word query's chunk scores equal `@2`'s → evidence:
  `lexical-revision-3.test.ts`.

### Budget
- N15: [measure] ranking the whole Dev release (8,700 chunks) takes, for
  the worst query measured, about 18 ms more at `@3` than at `@2` at the
  median (Results); through the
  Pages reader on 17,200 seeded events the worst query's p50 rises from 149
  ms to 164 ms; stored bytes do not grow → `bun run --cwd packages/search
  real-corpus -- --release <dir> --latency`, `bun run --cwd
  apps/data-publisher-worker measure:search-latency -- --events 17200
  --revision bm25-reference@3`, `bun run measure:search-revisions`.
- N16: [measure] the committed snapshot is what the Dev release gives, and
  ranks and scores every query's first 20 threads like the whole release at
  `@2` and `@3` → `bun run --cwd packages/search real-corpus -- --release
  <dir> --check`.

### Observability
- N17: [deploy] after the switch PR, `/health` `lastRun.search.lexicalRevision`
  and `/api/search` `retrieval.lexicalRevision` read `bm25-reference@3`, and
  `request manager` on Dev no longer returns "4.4.0 Release Manager" first.
  The deployed E2E (`H42`) already accepts `@3` and checks that the served
  revision equals what the publisher wrote.

## Results (2026-10-12)

Evaluation: see Example and Decisions. Golden v2 (25 chunks) at `@3`: lexical
queries MRR 0.8077 → 0.9231, nDCG@10 0.9042 → 0.9587, Recall@20 1.0 → 1.0;
the same three queries fail, on pull request 22747 not reaching the top 3 and,
for two of them, the four-message Release Manager thread ranking 3rd instead
of 1st.

One-word queries on the Dev release. A one-word query has no pair, so only
rule 2 moves it:

| Query | First 10 at `@3` against `@2` |
| --- | --- |
| `txn`, `770`, `manager`, `rebalance`, `controller` | identical order |
| `heartbeat`, `spill` | same first thread; 9 of 10 shared |
| `consumer` | same first thread; 8 of 10 shared |
| `release` | "[DISCUSS] Apache Kafka 4.5.0 release" is first; "4.4.0 Release Manager" second; 8 of 10 shared |
| `parquet` | another first thread; 6 of 10 shared |

The order is unchanged where each thread has one matching chunk. Where
threads have several, `@2` ordered them largely by how many chunks matched;
`@3` orders them by their best chunk. This is the intended effect of rule 2
and cannot be avoided by a fix for G31.

Stored format and size: none. `bun run measure:search-revisions` reports 0.0%
growth of every value from `@2` to `@3`.

Latency (N15), whole Dev release, ranking only (no R2, no JSON parse), p50:

| Query | `@2` | `@3` |
| --- | --- | --- |
| `request manager` | 16.6 ms | 19.7 ms |
| `consumer network thread request manager` | 19.6 ms | 25.0 ms |
| `SortMergeJoinExec` | 4.3 ms | 7.3 ms |
| `issue pull request` (worst case: nearly every chunk holds both words of a pair) | 22.0 ms | 39.7 ms |
| `the` (one word) | 20.0 ms | 16.3 ms |

Through the Pages reader with an in-memory bucket (17,200 seeded events, 19
shards, 28.8 MB; parse dominates): `transaction` 109 → 101 ms, `consumer
rebalance timeout` 127 → 127 ms, `issue pull request` 149 → 164 ms.

A first implementation tokenized the title and text of every candidate chunk
and took 732 ms for `issue pull request`; the string test of Decision 3 and a
faster word reader brought it to 40 ms.

Mutation evidence (one mutant per behavior, each seen failing) is listed in
the PR.

## Open questions

1. **Labels.** 20 of 21 rows are implementer-labelled from titles. To
   confirm, in particular: the Release Manager negative on every `manager`
   query; grading the other thread of a key (issue or pull request) as
   acceptable on the owner's query; `within` as the number of judged
   threads.
2. **The owner's "top 3"** is not reachable lexically for pull request 22747
   (Example). Keep the bound and let the semantic slices answer it, or relax
   it for lexical-only configurations?
3. **Exact matches among themselves** are ordered by score, which includes
   the exact boost once per exactly matching chunk, so a thread with more
   exactly matching chunks leads. Unchanged from `@1`; `@3` bounds it. Not
   measured as a problem.
4. **Plural and inflected words** (`Request Managers`) earn no bonus for
   `request manager`: there is no stemming. KIP-1371 is graded acceptable,
   not expected, for that reason.
5. **`snake_case`** is one word at `@2` and `@3` (`sort_merge_join_stream`).
6. **Snapshot age.** The snapshot is one release of one day. Refresh it when
   labels are confirmed or the corpus changes shape; the `@2` digests of N7
   on the snapshot must then be recomputed at e9984d0.

## Non-goals

- Semantic retrieval, fusion, and reranking (Spec 016 slices 3–4).
- Synonyms, stemming, query rewriting.
- Any model call, cloud resource, binding, or deployed configuration change.
- Changing what Dev or Prod serve: the switch is a separate PR (N17).
- A change to `@1` or `@2`, to stored objects, or to `SearchResponseV1`.
- Explaining in the response why a thread ranked.
- Estimating production quality beyond these 21 queries.
