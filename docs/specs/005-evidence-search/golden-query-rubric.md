# Spec 005 Golden-query Relevance Rubric

Status: Accepted for Phase 1 implementation

Fixture:
`packages/search/test/fixtures/golden-queries.v1.json`

## Purpose

This fixture is the human-reviewed oracle for search relevance. It records what
the product considers a correct result before a tokenizer, BM25 library, field
weight, or later semantic retriever is selected.

It is intentionally small. Its job is to prevent silent contract regressions,
not to estimate production recall from a statistically representative corpus.

## Grading unit

Search ranks accepted **record groups**, while the UI cites individual source
records as evidence. The fixture therefore grades both levels explicitly:

- `requiredGroupRootRecordIds`: every listed group must occur within `topK`;
- `acceptableGroupRootRecordIds`: related results are allowed but do not make a
  query pass;
- `forbiddenGroupRootRecordIds`: plausible distractors that must not occur
  within `topK`;
- `requiredEvidenceRecordIds`: source records that must appear in the visible
  evidence matches for the returned group.

These sets must not overlap. All IDs must resolve to chunks in the same fixture,
and every child chunk must name a present group root.

Fixture `contentHash` values are SHA-256 digests of the indexed `text`; CI
recomputes them so evidence cannot change without an intentional fixture diff.

## Phase 1 gate

Only queries with `minimumPhase: 1` block the lexical release.

A query passes when:

1. all required group roots are present in the first `topK` results;
2. no forbidden group root is present in the first `topK` results;
3. every required evidence record is exposed by a result in that window;
4. project filters are applied before a result can pass;
5. exact project identifiers and exact code symbols pass at `topK: 1`.

The release fails on any exact-identifier, project-isolation, or hard-negative
regression. An average metric cannot hide those failures.

## Fixture coverage

The first revision covers:

- Kafka and DataFusion records with the same numeric issue ID;
- exact Kafka `KAFKA-*` and `KIP-*` identifiers;
- a punctuation-bearing code symbol;
- terms found only in source-record body text;
- accepted grouping across Kafka Wiki, mailing-list, and GitHub records;
- a plausible prose distractor for a code-symbol query;
- strict project filtering;
- one Phase 2 vocabulary-gap query that does not block Phase 1.

## Evolution rule

- Never rewrite grades automatically from current search output.
- A fixture change requires a human explanation of why product relevance
  changed, plus a new `revision`.
- Adding records must not silently change accepted grouping relationships.
- Chunker or index changes update `indexRevision`; relevance-policy changes
  update the fixture `revision`.
- Phase 2 may improve vocabulary-gap Recall@K, but it must continue to pass all
  Phase 1 exact and isolation queries.

## Golden v2 (Spec 016)

`packages/search/test/fixtures/golden-queries.v2.json` keeps this fixture's
chunks and queries unchanged and adds graded judgments (2 expected,
1 acceptable), hard negatives, and `requires: lexical | semantic` for the
Phase 2 and 3 work. Its grading and its hand-written records are described in
[Spec 016](../016-semantic-search/spec.md). The v1 fixture and its Phase 1 gate
stay as they are.

## CI evidence

`packages/search/test/golden-fixture.test.ts` validates the fixture structure,
referential integrity, mutually exclusive grades, required coverage, and phase
separation without network, GitHub, embedding, or LLM access.

The BM25 evaluator in `packages/search/test/lexical-search.test.ts` consumes
this same parsed fixture and gates every Phase 1 query. It adds ranking
assertions without introducing a second relevance oracle.
