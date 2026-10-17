# Project Constitution

Status: Active
Effective: 2026-08-17

This document defines the non-negotiable engineering principles for evolving
the KIP Knowledge Base into a multi-project open-source community knowledge
base. Feature specs, plans, ADRs, code, and generated content must conform to
these principles.

## 1. Evidence before interpretation

Raw upstream observations and their provenance are canonical evidence. They
must be retained as immutable, append-only events with a stable identifier,
source URL, source cursor, observation time, and payload reference.

Summaries, Feed entries/details, clusters, recommendations, and links inferred
by a model are derived views. They must never silently replace source evidence.

## 2. Replayability is a product requirement

Every deterministic view must be rebuildable from the event log. Reprocessing
the same events with the same code and configuration must produce the same
logical result. Consumers must tolerate duplicates, retries, and out-of-order
delivery.

## 3. Deterministic and generative paths stay separate

Parsing explicit identifiers, deduplication, ordering, vote tallying, and
state transitions belong to deterministic code. LLMs may help with semantic
tasks such as summarization, topic labeling, ambiguous link suggestions, and
recommendation explanations.

Every generative result must record:

- the exact source messages or events used;
- model and prompt/template versions;
- generation time and review status;
- whether the result is a suggestion or an approved publication.

Disabling the LLM must not prevent ingestion, replay, source browsing, or
deterministic linking.

## 4. Prefer stale over wrong

When a source cannot be parsed or linked confidently, preserve the last known
correct deterministic value and expose the uncertainty. Ambiguous identity or
entity matches remain suggestions until reviewed; they are not silently merged.

## 5. Project-neutral core, reusable connectors, project profiles

The core domain uses Project, Contributor, Artifact, Thread, Message, Event,
and Relationship. FeedEntry and FeedDetail are discardable read models. Source
connectors own communication with
systems such as GitHub, Jira, Confluence, and mailing lists. Community profiles
own conventions such as KIP/KAFKA, FLIP/FLINK, and SPIP/SPARK identifiers.
Adding a project must not require redefining the event envelope or duplicating
source access and processing code.

## 6. Open formats and a tested exit path

Canonical data must be exportable through documented, open formats. Fluss is
the target event and current-state layer; Iceberg is the open historical and
analytical layer. A periodic replay/export test must demonstrate that the
system can be rebuilt without a paid hosted product.

The Git/Obsidian vault, current KIP types, parsers, ingestion jobs, routes, and
build pipeline are legacy implementation details. New work is not required to
preserve their contracts or output. Existing code may be used as a fixture or
reference when useful, but it must not constrain the target architecture.

The only legacy preservation requirement is the frontend visual language. New
screens should retain its recognizable typography, palette, spacing rhythm,
and content-focused character while allowing components, interaction patterns,
routes, and accessibility behavior to improve.

[Design system](product/design-system.md) states that visual language as
tokens, roles and rules, with the contrast and colour-vision checks that keep
it readable (ADR-0017).

## 7. Specifications and assertions lead implementation

Each feature starts with a bounded intent, observable acceptance scenarios,
and explicit non-goals. Architecture decisions that affect multiple features
are recorded as ADRs. Implementation is complete only when tests or other
repeatable evidence demonstrate the assertions.

Specs are living control documents, not large up-front contracts. A feature
should be small enough to deliver as an end-to-end vertical slice.

## 8. Operability and provenance are visible

Ingestion lag, rejected events, unresolved links, replay version, and model
version are observable system state. Failures must be diagnosable without
reading model reasoning or manually inspecting every upstream system.

## Changing the constitution

A change requires a dedicated ADR explaining the motivation, compatibility
impact, migration plan, and amendments to affected specs and tests. A feature
implementation may not override this document implicitly.

ADR-0005 amended the core/read-model boundary on 2026-08-25.
ADR-0017 linked §6 to the design system on 2026-10-17 (no principle changed).
