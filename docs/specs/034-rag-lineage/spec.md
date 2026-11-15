# Spec 034: RAG lineage

Status: Draft (owner intent 2026-11-16: every digest claim and every search hit traces back to its source; OD1–OD4 open; LN1–LN20 [pending]/[deploy]/[measure])
Date: 2026-11-16
Traceability: enforced
Builds on: Spec 008 (content-addressed details, `search-release.v2`, `detailSha256`), Spec 013 (search v3 shards), Spec 014 (digest object, `Sentence.cites`, `Provenance`, Behavior 9), Spec 016 (chunks, `semanticRevision`, Behavior 22 release consistency), Spec 017 (`bm25-reference@3`), Spec 032 (path URLs)

## Intent

The topic digest and hybrid search are generated from source records by
models. A reader who doubts a digest sentence or a search hit cannot see,
from the page or the API answer alone, which source record it came from,
which publication it was built from, and which model and version produced
it. The data to answer that mostly exists already, but it is split across the
release manifest, the digest object, Vectorize metadata, R2 key names and
`/health`, and the UI shows almost none of it.

Observable outcome: for any digest claim and any search hit, the API answer
and the page give four lineage items, called the **lineage record** in this
spec:

1. **Source** — the source thread or issue: its display id (`KAFKA-21486`,
   `KAFKA-MAIL-23b962b1`) and its root record id (`kafka:jira:issue:KAFKA-21486`).
2. **URL** — the original upstream URL (GitHub, Jira, `lists.apache.org`).
3. **Release** — the publication the answer was built from: the Search
   `indexRevision` (`feed-<releaseId>`) and, for the digest, its own
   digest revision (`<releaseId>/<revisionHash>`).
4. **Model** — the model and version that produced the text or the ranking:
   for semantic search the embedding revision
   `@cf/baai/bge-m3@1:1024:title-text@1`; for the digest the summarizer,
   classifier and translator `{model, prompt}`. The digest uses no
   embeddings, so its embedding item is "not applicable" by design, not a gap.

The lineage record reuses values the system already computes. It adds no
new R2 object, no new route, and no new model call.

## Evidence

Inventory on `main` at `18a4624` (2026-11-16). "Artifact" is what R2 stores;
"API" is what `/api/search`, `/api/search-detail/:ref` or `/api/digest`
returns; "UI" is what the page shows.

### Search hit

| Item | Artifact | API | UI |
| --- | --- | --- | --- |
| Source | `SourceRecordChunkV1.recordId`, `groupRootRecordId`, `ordinal`, content-addressed `id` (`packages/search/src/golden-fixture.ts:21`); Vectorize metadata `record`, `root` (`packages/semantic-vectorize/src/vector.ts:68-74`) | per match `chunkId`, `recordId` (`packages/serving-contract/src/search-r2.ts:176-178`); `entry.id`, `entry.sourceTitleRecordId` | **absent** on `.search-card` (`apps/web/src/components/SearchResultCard.vue`; `chunkId` is only the `v-for` key); the search detail shows the display id |
| URL | chunk `canonicalUrl` | per match `canonicalUrl` (`search-r2.ts:180`) | **absent** on the card; only in Detail after a click (`apps/web/src/views/FeedDetailView.vue:195`) |
| Release | manifest `indexRevision`, `corpusRevision`, `lexicalRevision`; shard group `detailSha256` (Spec 008); chunk `sourceVersion`, `contentHash` | response `retrieval.indexRevision`, `lexicalRevision`, `fusionRevision`, `generatedAt`; per match `sourceVersion`; the `detailRef` encodes `indexRevision`, but `/api/search-detail/:ref` returns no release field | **absent** |
| Model | Vectorize metadata `r` (`vector.ts:68`); not in the manifest by Spec 016 Behavior 22 (a release is written before its vectors exist) | response `retrieval.semanticRevision`, only when `retrieval.semantic.status` is `ok`; per match `signals.semanticRank` and `signals.semanticScore` mark a hit semantic retrieval found | **absent**; only the experimental label (`apps/web/src/views/FeedView.vue:310`) |

### Digest claim

A claim is one generated `Sentence {text, cites[]}` of a topic card, a
proposal line, a highlight body or the headline
(`packages/reference-pipeline/src/digest/types.ts:121`).

| Item | Artifact | API | UI |
| --- | --- | --- | --- |
| Source | `Sentence.cites[]` are display ids (`types.ts:123`); `threads[<display id>]` (`DigestThread`, `types.ts:174`) has no record id; record ids exist only per card or call in `Provenance.inputRecordIds` (`types.ts:134`) | the same (`apps/web/functions/_shared/digest.ts:48` strips only `features`, `translations`) | chip text (`apps/web/src/components/digest/CiteChips.vue`); record ids **absent** |
| URL | `DigestThread.url` (`types.ts:178`), per cited thread | the same | partial: `citeTarget` (`apps/web/src/digest-view.ts:161`) links the upstream URL only when the thread is not in the current Feed, else `/feed/<id>` |
| Release | `sourceRelease.releaseId` (`types.ts:198`) is the Feed release; the digest's own revision exists only in its R2 key `public/digest/v1/<projectId>/<releaseId>/<revisionHash>/` (`apps/data-publisher-worker/src/digest/run.ts:249-250`) | `sourceRelease` only; the key is read by the API (`digest.ts:39-46`) but not returned | **absent**; only `generatedAt` freshness (`DigestWeek.vue:28`) |
| Model | `revisions.{classifier, summarizer, translator}.{model, prompt}` (`types.ts:202-204`); per card `Provenance.model`, `prompt`, `inputHash` | the same | summarizer and translator short model names only (`aiLabel`, `digest-view.ts:194`) |

### Gaps

- **G1** — `.search-card` shows none of the four items.
- **G2** — `/api/search-detail/:ref` and the search detail view show no
  release, although the ref carries `indexRevision`.
- **G3** — A digest claim names display ids only. A `KAFKA-MAIL-<8 hex>` id
  is a hash and cannot be turned back into a record id, so a claim cannot be
  joined to a Feed record or a search chunk.
- **G4** — The digest answer has no digest revision of its own; two digest
  objects of the same Feed release but other prompts or models are told
  apart only by an R2 key the API does not return.
- **G5** — The digest page shows neither the source release nor the
  digest revision, and shows no prompt revision.

Not a gap (kept as is): the Search–digest release link. Both come from the
same publication: `indexRevision` is `` `feed-${releaseId}` ``
(`apps/data-publisher-worker/src/pipeline.ts:284`), so the digest's
`sourceRelease.releaseId` already names the Search release it pairs with.

## Example

Captured 2026-11-15 23:34 UTC from Prod (`https://oss-knowledge-base.pages.dev`,
`v0.3.9`), public GETs only.

**Search.** `GET /api/search?q=consumer%20lag%20too%20high&limit=3` answers:

```json
"retrieval": {
  "indexRevision": "feed-2026-11-15T22-37-00-155Z",
  "lexicalRevision": "bm25-reference@3",
  "fusionRevision": "rrf-group@2",
  "semanticRevision": "@cf/baai/bge-m3@1:1024:title-text@1",
  "semantic": { "status": "ok", "candidates": 100, "cached": false }
}
```

and its first match:

```json
{ "chunkId": "chunk:sha256:40a53f8608e812cd130cf4ad133b74816a39968b46a683541b2415807854838f",
  "recordId": "kafka:github:pull:21714",
  "canonicalUrl": "https://github.com/apache/kafka/pull/21714",
  "signals": { "lexicalRank": 2, "semanticRank": 13, "semanticScore": 0.43323904, "fusedRank": 1 } }
```

All four items are in the answer. The card for this hit shows only the
title, summary, excerpt, author and date (G1). Expected after this spec, on
the card (text, no nested link, because the whole card is one link):
`github.com/apache/kafka/pull/21714 · lexical #2 · semantic #13`; once above
the list: `Index feed-2026-11-15T22-37-00-155Z · bm25-reference@3 ·
bge-m3@1 (1024, title-text@1)`.

The query `share group rebalance`, asked a minute earlier, answered with
`semantic.status: "timed-out"` and no `semanticRevision`: that answer is
lexical, and the list line says `lexical only (semantic: timed out)`
instead of a model.

**Digest.** `GET /api/digest?projectId=apache-kafka&locale=en` (264,402
bytes, 417 threads) has `sourceRelease.releaseId`
`2026-11-15T22-37-00-155Z`, the same publication as the Search
`indexRevision` above, and

```json
"revisions": {
  "classifier": { "model": "@cf/cloudflare/clef-flash", "prompt": "digest-clef@2" },
  "summarizer": { "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "prompt": "digest-prompts@5" },
  "translator": { "model": "@cf/qwen/qwen3-30b-a3b-fp8", "prompt": "digest-prompts@5|kafka-glossary@2" } }
```

The `streams` topic card's first claim:

```json
{ "text": "Kafka streams group heartbeat would fail with UNKNOWN_SERVER_ERROR when a member sets application.server and the group's source topics are missing (KAFKA-21486, open).",
  "cites": ["KAFKA-21486"] }
```

`threads["KAFKA-21486"]` gives the title, status and URL, but no record id.
Proposal `KIP-1388` cites `KAFKA-MAIL-d4acb13f`; its record id cannot be
derived from that hash (G3). After this spec, `threads["KAFKA-21486"]`
also has `rootRecordId: "kafka:jira:issue:KAFKA-21486"` (OD1), and the
answer has `lineage.digestRevision: "2026-11-15T22-37-00-155Z/<revisionHash>"`
taken from the pointer key it read (G4). The page's lineage disclosure
reads: `Built from publication 2026-11-15T22-37-00-155Z · digest revision
…/<revisionHash> · summary llama-3.3-70b-instruct-fp8-fast (digest-prompts@5)
· topics clef-flash (digest-clef@2)`.

## Behavior

1. **One lineage record, four items.** Source, URL, Release and Model as
   defined in the Intent. Each value is copied from a field the system
   already writes; this spec computes no new lineage value except the
   digest revision (rule 5), which is read from an existing key.
   Owner: the owner's AI-ready-data intent; reader: a person or a RAG
   consumer auditing an answer.
2. **Search answer unchanged.** `SearchResponseV1` gains no field: every
   item for a hit is already in the response (Evidence table). The
   embedding revision stays response-level, because Spec 016 Behavior 22
   drops every vector whose `r` differs from the profile's revision, so all
   semantic hits of one answer share `retrieval.semanticRevision`.
3. **Search detail release.** `/api/search-detail/:ref` adds
   `lineage { indexRevision }`, taken from the ref it already validated
   (G2). An older ref (v1, v2) answers with the revision its ref carries.
4. **Digest thread record id.** `DigestThread` gains `rootRecordId`, the
   root record id of the Feed group the display id names (G3; OD1). It is
   written by the digest run from the record it already reads for `url`.
   An object written before this spec lacks the field; readers treat it as
   unknown.
5. **Digest revision.** `/api/digest` adds `lineage { digestRevision }`, the
   `<releaseId>/<revisionHash>` part of the object key it read from the
   pointer (G4). No artifact change.
6. **Search UI.** Above the result list, one line gives the answer's
   Release and Model: `indexRevision`, `lexicalRevision`, and either the
   embedding revision (status `ok`) or "lexical only" with the status. Each
   `.search-card` gives the URL host and path of its first match as text and
   the hit's lexical and semantic ranks (G1). The search detail view gives
   all four items, the URL as a link (G2).
7. **Digest UI.** A collapsed lineage disclosure on This week and on a Topic
   page gives the source release, the digest revision, and each model with
   its prompt revision (G5). A citation chip's `title` gives the upstream URL
   when the thread has one; where the chip itself links to `/feed/<id>`
   (`citeTarget`) the URL is still reachable from Detail.
8. **No new public data.** Every value shown is already in a public API
   answer today, except `rootRecordId` (a record id, already public in
   `/api/search` `recordId`) and the digest revision hash. The owner still
   confirms the UI copy (OD3).
9. **Interface boundary with the stream "Semantic search and the weekly
   digest on Prod (experimental label)".** That stream owns the ranking,
   fusion revision, query gate, `SEARCH_SEMANTIC`, the experimental label and
   their Prod rollout. This spec does not change them, and the files below
   are shared:
   - It reads `retrieval.*` and `signals.*` as they are; it does not rename,
     remove or reorder any field, and it adds none to `SearchResponseV1`.
   - Its UI is new components (`SearchLineageLine.vue`, `LineageDisclosure.vue`)
     placed by one line each in `FeedView.vue`, `SearchResultCard.vue`,
     `FeedDetailView.vue` and `DigestWeek.vue`/`TopicPage.vue`; it does not
     edit the experimental label or its placement.
   - Its implementation slices start after that stream's open PRs on those
     files have merged, or rebase onto them by merging `main` (no
     force-push).
   - If that stream changes a field this spec reads, that stream's spec
     names it and this spec's case file is updated in the same PR.
10. **Data contract.** The `rootRecordId` and `lineage` fields are additive;
    the digest schema stays `osskb.digest.v1` (OD2).

## Simplification review

1. **Question every requirement.** Each item names its reader: Source and URL
   — a person checking a claim, and a RAG consumer joining a claim to a
   chunk; Release — anyone reproducing an answer from immutable releases
   (Spec 008); Model — anyone telling two answers of different model
   revisions apart.
2. **Delete.**
   - Deleted: a `semanticRevision` in the search release manifest. The
     response already carries it whenever embeddings were used, and Spec 016
     Behavior 22 records why the manifest cannot know it.
   - Deleted: a per-match `semanticRevision` or `indexRevision`. Both are
     equal for every match of one answer (rule 2).
   - Deleted: a new `/api/lineage` route. Every value is in the answers the
     pages already fetch.
   - Deleted: an explicit digest→Search release field. `indexRevision` is
     `feed-<releaseId>` by construction.
   - Deleted: an embedding item for the digest. The digest uses no
     embeddings.
   - Deleted: a per-sentence `inputRecordIds`. `cites` plus `rootRecordId`
     reaches the same records; the per-card list stays as Spec 014 wrote it.
3. **Simplify.** The digest revision is read from the key the API already
   reads, instead of a new field in the object.
4. **Shorten the cycle.** One case file drives the unit tests of the
   lineage builders (pure functions over a response and a digest fixture),
   so the table is checked without a browser; E2E checks only placement.
5. **Automate last.** A deployed E2E assertion (LN18) is the only new gate.

## Acceptance

### Behavior

- LN1: [pending] given the Prod search fixture of the Example with `semantic.status: ok` → the search lineage builder → returns, per hit, Source (`recordId`, root), URL (`canonicalUrl`), Release (`indexRevision`, `lexicalRevision`) and Model (`semanticRevision`) → unit test on the case file.
- LN2: [pending] given a lexical answer (`semantic.status` `timed-out`, no `semanticRevision`) → the builder → Model is `lexical-only` with the status, never a model id → unit test.
- LN3: [pending] given a valid v3 `sdr1.` ref → `GET /api/search-detail/:ref` → body has `lineage.indexRevision` equal to the ref's `indexRevision`, other fields byte-identical to before → `r2-functions.test.ts`.
- LN4: [pending] given a digest run over a fixture with a Jira, a GitHub and a dev@ thread → the run → each `threads[<id>]` has `rootRecordId` equal to the Feed group's root record id → digest unit test.
- LN5: [pending] given a pointer `objectKeys.en = public/digest/v1/apache-kafka/2026-11-15T22-37-00-155Z/<hash>/en.json` → `GET /api/digest` → `lineage.digestRevision` is `2026-11-15T22-37-00-155Z/<hash>` → `r2-functions.test.ts`.
- LN6: [pending] given a search answer → Search view → one `.search-lineage` line above the list with the index and model (or "lexical only"), and each `.search-card` shows its first match's URL host and path as text, not as a nested link → E2E.
- LN7: [pending] given a search detail → the detail view → a lineage block with the display id, record id, URL link, `indexRevision` → E2E.
- LN8: [pending] given a digest → This week and a Topic page → `details.digest-lineage`, collapsed, gives the source release, digest revision, and three `{model, prompt}` pairs; a citation chip's `title` holds the thread URL → E2E.
- LN9: [pending] given the shared files of Behavior 9 → the slice's diff → no field of `SearchResponseV1` is added, renamed or removed and the experimental label's tests are unchanged → contract test on the type and a check in the PR.

### Failure and retry

- LN10: [pending] given a digest object written before this spec (no `rootRecordId`) → API and UI → the field is absent in the API and shown as "record id not recorded", the claim still links by URL → unit test.
- LN11: [pending] given a pointer key that does not match `<prefix><releaseId>/<hash>/<locale>.json` → `/api/digest` → `lineage.digestRevision` is `null`, the digest is still served (lineage never turns a 200 into an error) → unit test.
- LN12: [pending] given a cited id absent from `threads` → the lineage builder → Source is the display id alone, URL `null`, no exception → unit test.
- LN13: [pending] given a `DigestThread.url` that is not `https://` → the chip `title` and the disclosure → no URL is shown (same rule as `citeTarget`) → unit test.
- LN14: [pending] given an older v1/v2 search ref and an older Search release after rollback → `/api/search-detail/:ref` → `lineage.indexRevision` is the ref's revision, not the current pointer's → unit test.
- LN15: [pending] given the zh-Hant digest with `localeFallback: true` → the disclosure → the digest revision is the English object's, and the disclosure says so → unit test.
- LN16: [pending] given a digest re-run for the same release and revisions (Spec 014 Behavior 12, a reused pair) → the run → `rootRecordId` values are identical and no extra R2 object is written → digest unit test.

### Budget

- LN17: [measure] payload: `rootRecordId` adds at most 50 bytes a thread; on the Example digest (417 threads, 264,402 bytes) at most 21 kB (8%); `/api/search` unchanged; `/api/search-detail` at most 80 bytes more; no new R2 read, write or model call (command: `bun run measure:lineage -- --target prod`, to be added with slice 1).

### Observability

- LN18: [deploy] on Dev after slice 1: the deployed E2E checks that `/api/digest` `lineage.digestRevision` starts with `sourceRelease.releaseId`, that `feed-<sourceRelease.releaseId>` equals `/api/search` `retrieval.indexRevision` when both are of the same day's publication, and that a fused answer's `semanticRevision` equals `/health` `searchEmbedding.semanticRevision`.
- LN19: [deploy] a lineage mismatch (LN18 fails) fails `e2e-development` in CI, so it shows on the PR and on `main` without manual tailing.
- LN20: [deploy] on Prod after the owner's tag: the same checks as LN18 by `verify:health --target prod` reading the public answers.

## Test plan

Scope: `packages/reference-pipeline/test/digest/lineage.test.ts` (to be
added; calls the digest lineage builder and the digest run's thread
projection), `apps/web/test/lineage.test.ts` (to be added; calls the search
and digest lineage builders in `apps/web/src/lineage.ts`),
`apps/web/test/r2-functions.test.ts` (calls the `/api/digest` and
`/api/search-detail` handlers), `apps/web/e2e/lineage.spec.ts` (to be added;
opens Search, search detail, This week and a Topic page and checks
placement). The case file `apps/web/test/fixtures/lineage-cases.json` and
the generated table come with slice 1; until then every untagged item is
`[pending]`.

## Slices

1. API and data: LN3–LN5, LN9–LN17 (`rootRecordId`, `lineage` fields, the
   measure command). Merged off nothing: the fields are additive and no
   flag is needed (OD4).
2. UI: LN1, LN2, LN6–LN8 after the other stream's Search and digest UI PRs
   have merged (Behavior 9).
3. Deployed checks: LN18–LN20.

## Open decisions (owner)

- **OD1** — Add `rootRecordId` to `DigestThread` (recommended; the only way
  to join a dev@ claim to its record), or keep display ids only and accept
  that dev@ claims cannot be joined.
- **OD2** — Additive fields under `osskb.digest.v1` and an unchanged
  `SearchResponseV1` (recommended), or a new digest schema version.
- **OD3** — UI copy and placement: one line above the search list and a
  collapsed disclosure on digest pages (recommended), or lineage only in
  Detail.
- **OD4** — Ship without a flag (recommended; additive and read-only), or
  behind a Pages variable like `PROJECT_TREND`.

## Non-goals

- Per-sentence model input lists, or showing `inputHash`.
- Lineage for the Feed, profiles or KIP pages.
- Changing ranking, fusion, the query gate, the experimental label or any
  Prod flag (the other stream's scope, Behavior 9).
- Verifying source text against upstream at read time, or archiving
  upstream pages.
- Retention of old releases (Spec 029); lineage names a release, it does not
  keep it alive.
