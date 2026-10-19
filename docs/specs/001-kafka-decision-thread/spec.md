# Spec 001: Kafka Decision Thread

Status: Implemented (baseline `f57f96b`, 2026-08-26; A13 in #49); on Prod since `v0.1.0`

- Owner: Project maintainers
- Created: 2026-08-17

## Intent

Given one KIP identifier, present the related proposal, Jira work, discussion
thread, vote thread, and GitHub development activity as one evidence-backed,
chronological Decision Thread.

This is the first end-to-end slice of the project-neutral community model. It
must prove traceability and replayability before personalization or broad
multi-project ingestion is added.

## User stories

1. As a contributor, I can enter a KIP ID and follow the decision across source
   systems without manually finding each archive.
2. As a skeptical reader, I can open the canonical source for every timeline
   item and every generated claim.
3. As an operator, I can replay the same normalized events and reproduce the
   deterministic timeline.
4. As a user avoiding AI, I can browse all source evidence with generated
   summaries disabled.

## Functional requirements

### FR-1: Source coverage

For a followed KIP, ingest available evidence from:

- Kafka Confluence KIP page;
- Apache Jira issue and comments linked explicitly to the KIP;
- `dev@kafka.apache.org` discussion and vote threads;
- `apache/kafka` GitHub issues, pull requests, reviews, and commits that
  explicitly mention the KIP or a linked Jira key.

A missing or unavailable source is shown as missing; it does not block other
sources.

### FR-2: Generic event envelope

Source connectors emit observations that are normalized through the
`KafkaCommunityProfile` into the Event contract in
`docs/domain/community-model.md`. Output is append-only and contains enough
provenance to inspect the original payload and canonical human URL.

### FR-3: Deterministic linking

The initial accepted graph contains only explicit upstream links and versioned,
boundary-safe identifier rules. Ambiguous semantic matches are suggestions and
do not enter the accepted deterministic timeline automatically.

### FR-4: Deterministic timeline

The view groups related artifacts, threads, and messages and orders entries by
source timestamp, then stable event ID as the tie-breaker. Late events are
inserted at their correct logical position without duplicating prior entries.

### FR-5: Source-first presentation

Every timeline entry shows source, author identity as observed, timestamp,
artifact/thread context, and canonical link. The interface exposes freshness
and unresolved-source status.

### FR-6: Optional generated overview

An LLM may produce an overview of the motivation, major disagreements,
alternatives, vote outcome, and implementation result. Every claim cites its
supporting message or artifact IDs. The overview records model, prompt version,
input set, generation time, and review state.

The raw Decision Thread remains fully usable when this feature is unavailable.

## Non-functional requirements

- Duplicate delivery and retries are safe.
- Out-of-order events converge to the same logical timeline.
- Deterministic output is stable for the same event set and software version.
- Source-specific access stays in reusable connectors; Kafka naming and linking
  rules stay in `KafkaCommunityProfile`.
- Unsupported or ambiguous input is observable rather than guessed.
- Logs and metrics expose adapter lag, rejected events, unresolved links, and
  materialization/replay version.

## Initial delivery boundary

The first demonstration uses one representative KIP with at least one Jira
link, one discussion or vote thread, and one GitHub link. It exercises real
schemas and deterministic replay; a full Kafka backfill is not required.

## Non-goals

- personalized feed ranking;
- contributor reputation scores;
- production-scale Flink or Spark community ingestion;
- automatic merging of contributor identities;
- automatically accepting LLM-inferred links;
- replacing upstream archives or serving as their authoritative copy;
- building Spark recommendation jobs in this slice.

## Dependencies

- `docs/constitution.md`
- `docs/domain/community-model.md`
- ADR-0001, ADR-0002, and ADR-0003

Legacy Kafka fixtures may be reused as test input, but legacy schemas, parser
behavior, routes, and vault output are not dependencies.

## Open implementation choice

The exact Fluss connector and table DDL versions are intentionally deferred to
the implementation plan. Pinning them requires a runnable compatibility spike;
the product assertions do not depend on a guessed version.
