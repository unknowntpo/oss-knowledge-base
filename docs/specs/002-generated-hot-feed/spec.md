# Spec 002: Generated Hot Feed

Status: Implemented POC; behavior review continues

- Owner: Project maintainers
- Created: 2026-08-19
- Revised: 2026-08-20

## Intent

Present a shared, non-personalized feed of currently active community work
without introducing a permanent `Subject` entity. The pipeline groups related
source records into discardable internal `FeedRecordGroup` projections, ranks
them with deterministic activity signals, and maps each result to a
`FeedEntry`. Opening an entry loads a `FeedDetail` whose optional key points
must cite its source records.

## User outcome

A reader sees one feed card for one active body of work even when discussion is
spread across an issue, pull request, proposal page, mailing-list thread, and
their replies. The reader can open every contributing source record and can
still use the feed when clustering or summarization models are unavailable.

## Source of truth

The canonical inputs are:

- `SourceRecord` observations and their source-native parent hierarchy;
- provenance-bearing cross-record relationships;
- immutable activity events.

`FeedRecordGroup`, `FeedEntry`, and `FeedDetail` are generated read models. They
may be discarded and rebuilt. They do not create, edit, or delete source
records or accepted relationships.

## Processing boundary

The feed pipeline has separate responsibilities:

1. candidate selection chooses records active in a fixed time window;
2. clustering groups root records using exact relationships and validated
   model suggestions;
3. deterministic activity scoring ranks the resulting groups;
4. the application maps each group to a `FeedEntry`, adding its source-backed
   summary and explicit reason for appearing;
5. opening the entry hydrates a `FeedDetail` and deterministically orders its
   records as a timeline;
6. an optional key-point generator uses an explicit evidence set;
7. citation validation rejects unsupported generated claims.

Model-generated grouping is feed-only provenance. It must not silently become
an accepted domain relationship. When no model is available, every ungrouped
root record still produces a singleton group and therefore a usable entry.

## Initial scope

- one project per record group and entry;
- source-native children inherit their root record's group;
- `discusses`, `implements`, `fixes`, and `duplicates` may group roots;
- `references`, `related-to`, and unreviewed inferred relationships do not
  deterministically group roots;
- model suggestions are accepted only through an explicit clustering policy;
- activity ranking does not use an LLM;
- key points are optional and must cite records in the opened detail;
- Timeline is derived from `FeedDetail.records`, not separately stored.

## Non-goals

- personalized ranking;
- durable subject following or bookmarking;
- automatically persisting model suggestions as relationships;
- production Flink or Spark implementation;
- choosing a permanent cluster identity or merge/split history;
- replacing source-native titles or source links.

## Executable intent

The authoritative behavior scenarios are in [`acceptance.md`](acceptance.md).
The public boundary is exercised by
`packages/domain/test/feed-grouping.behavior.test.ts`,
`packages/domain/test/feed-grouping.community-cases.test.ts`, and
`packages/domain/test/feed-detail.test.ts`. No legacy FeedStory compatibility
adapter remains.
