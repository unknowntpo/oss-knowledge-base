# Development Tasks

This file tracks the next bounded work derived from active specs. It is not a
substitute for acceptance scenarios or issue history.

## Spec 001: Kafka Decision Thread

- [x] Establish project constitution.
- [x] Define project-neutral community domain model.
- [x] Record Fluss/Flink/Spark/Iceberg architecture decisions.
- [x] Define Spec 001 and acceptance scenarios.
- [x] Confirm greenfield boundary: preserve frontend visual language only.
- [x] Separate source connectors and `KafkaCommunityProfile` from Fluss Kafka
      wire-protocol compatibility.
- [ ] Review and accept the documentation control plane.
- [ ] Phase 1: implement versioned generic TypeScript schemas, including
      project-scoped `SourceInstance`, `CommunityProfile`, and versioned status
      policies.
  - [x] Establish the dependency-free v1 TypeScript contract, runtime profile
        invariants, normalized event parser, and GitHub PR status-policy test.
  - [x] Preserve source artifact titles and define cited summaries, canonical
        source links, and deterministic activity scoring for the Feed boundary.
  - [ ] Add persisted serialization compatibility fixtures and schema-evolution
        tests before declaring Phase 1 complete.
- [ ] Phase 1: implement source-connector interfaces and
      `KafkaCommunityProfile` against the generic Event contract.
- [ ] Phase 2: build deterministic reference materializer and tests.
- [x] Phase 3: pin the first Fluss/Flink compatibility baseline and add the
      cluster-free connector discovery plus semantic parity gates.
- [x] Phase 3: run the cluster-backed Fluss/Flink compatibility slice against
      the accepted Spec 004 fixture.
- [x] Phase 3: implement the first bounded Fluss/Flink vertical slice.
- [ ] Phase 4: capture legacy visual tokens and reference screenshots.
- [ ] Phase 4: add project-neutral Decision Thread API and hierarchical
      Project → Source/Status facets without legacy data or route coupling.
- [ ] Phase 5: add cited, optional LLM overview.
- [ ] Phase 6: validate Iceberg export and replay boundary.

## Deferred

- Spark clustering and recommendation candidate generation.
- Contributor reputation or ranking.
- Flink and Spark upstream adapters.
- Automatic acceptance of semantic relationship suggestions.

## Spec 002: Generated Hot Feed

- [x] Capture F1-F11 Intent-to-Assertion behavior scenarios.
- [x] Add a reusable behavior contract and deterministic in-memory test oracle.
- [x] Accept `FeedEntry → FeedDetail → SourceRecord` as the product boundary;
      keep discardable `FeedRecordGroup` as an internal projector result.
- [x] Remove `FeedStory` from the v1 package index and run focused public
      boundary tests against grouping and detail construction.
- [x] Move all behavior scenarios to Feed grouping tests and remove the internal
      legacy `feed-story` compatibility adapter.

## Spec 003: Versioned R2 Feed Projection

- [x] Migrate the active POC presentation layer to Vue 3, Vite, TypeScript, and
      Vue Router while preserving the accepted visual language.
- [x] Define manifest-last immutable Feed/FeedDetail R2 projection objects.
- [x] Add same-origin Cloudflare Pages Functions backed by a private R2 binding.
- [x] Verify real Kafka and DataFusion GitHub projections with local Wrangler
      and R2.
- [x] Capture desktop, FeedDetail, and mobile interaction browser evidence.
- [x] Provision isolated `oss-knowledge-base-poc` Pages/R2 resources and verify
      the deployed Feed and lazy FeedDetail endpoints.
- [x] Replace duplicate frontend `FeedTopic/items` types with the shared
      `FeedIndex → FeedDetail` v2 serving contract.
- [x] Split active code into `apps/web`, `apps/github-publisher`,
      `packages/domain`, and `packages/serving-contract` ownership boundaries.
- [ ] Replace the GitHub-direct publisher input with the first Fluss/Flink
      materialized projection.

## Spec 004: Replayable GitHub-to-Feed Reference Pipeline

- [x] Draft the POC-to-production evolution and Intent-to-Assertion scenarios.
- [x] Review and accept Spec 004 before implementation.
- [x] Emit versioned `DomainEventV1` batches and connector checkpoint candidates
      from Kafka/DataFusion GitHub polling.
- [x] Add persisted serialization fixtures and the deterministic TypeScript
      reference materializer.
- [x] Pass duplicate, restart, out-of-order, conflict, partial-fetch, stale, and
      provenance acceptance scenarios.
- [x] Replace the direct `loadLiveFeed()` transformation while preserving the
      existing R2 and Vue contracts.
- [x] Expose the accepted fixture as a fail-closed semantic parity gate for the
      Fluss/Flink compatibility spike.
- [x] Produce an independent Flink candidate and pass the accepted digest.

## Spec 007: Fluss/Flink Compatibility Spike

- [x] Pin Fluss 0.9.1-incubating, Flink 1.20.3, and Java 17 bytecode in
      ADR-0011.
- [x] Add an isolated Maven classpath smoke test for Fluss catalog discovery.
- [x] Add a canonical projection parity command and mismatch regression test.
- [x] Run the classpath smoke test in pull-request CI.
- [x] Add run-owned Fluss Log and Primary Key tables with explicit readiness
      and cleanup.
- [x] Implement the smallest bounded Flink materializer for the Spec 004 fixture.
- [x] Prove duplicate, out-of-order, restart, retry, provenance, and accepted
      digest parity before any serving cutover.

## Spec 005: Evidence-first Hybrid Search

- [x] Draft the Search/Feed boundary, phased retrieval architecture, proposed
      TypeScript contracts, LLM boundary, and Intent-to-Assertion scenarios.
- [x] Review and accept the Phase 1 contracts and deterministic acceptance
      scenarios; keep operational measurements observable without inventing a
      numerical pre-release gate before real pressure exists.
- [x] Establish PR CI gates for typecheck/build, unit, integration, and
      deterministic local-R2 browser E2E before Search implementation.
- [x] Define the first Kafka/DataFusion golden-query fixture and relevance
      rubric.
- [x] Decide the bounded historical evidence included in the first index.
- [x] Record the R2 search release/manifest protocol in an ADR or ADR-0004
      amendment.
- [x] Implement Phase 1 deterministic chunks, exact/BM25 retrieval,
      `/api/search`, evidence excerpts, and FeedDetail hydration.
  - [x] Implement deterministic structural/window chunking, exact recognition,
        BM25 reference ranking, evidence excerpts, stable tie-breaking, and the
        Kafka/DataFusion golden-query regression gate.
  - [x] Implement the executable R2 Search release contract, `/api/search`, and
        immutable `detailRef` → `FeedDetail` hydration.
  - [x] Implement project-scoped status filters and strict evidence-time bounds
        across the shared contract, API, Vue UI, and desktop/mobile E2E.
  - [x] Keep shard size, latency, errors, CPU, and Cloudflare usage observable;
        defer numerical performance gates until real operational pressure
        justifies them.
- [x] Publish the accepted Search release to the isolated Cloudflare POC and
      run a minimal functional Search → FeedDetail smoke check without load or
      latency benchmarking.
- [x] Materialize and publish all 184 accepted Feed groups and 353 current
      SourceRecords into the independent Search release without refetching
      GitHub; verify real Kafka and DataFusion queries through the public API
      and the Search → FeedDetail UI path through desktop/mobile E2E.
- [ ] Run a Phase 2 query-embedding placement and replaceable ANN spike only
      after Phase 1 passes.
- [ ] Add hybrid RRF and graph expansion only after lexical and semantic
      retrievers have independent golden-query evidence.
- [ ] Keep learned reranking, BYO LLM answers, and personalized Feed ranking
      outside Phase 1.

## Release pipeline

- [x] Define PR → CI, `main` → development, and release tag → production in
      ADR-0008 with executable workflow conditions.
- [x] Replace the legacy `viewer/` deployment workflow locally and retain the
      exact CI-built `apps/web/dist` artifact for Pages deployment.
- [x] Create `oss-knowledge-base-dev` and `oss-knowledge-base` Pages projects
      plus GitHub `development` and `production` environments.
- [x] Store `CLOUDFLARE_ACCOUNT_ID` as a repository secret.
- [x] Add a scoped `CLOUDFLARE_API_TOKEN` repository secret and verify the
      first deployment applies the shared read-only `OSS_KB_BUCKET` binding.
- [x] Commit and push the target architecture, observe the first CI run, then
      protect `main` with the exact passing check names.
- [x] Verify `main` deploys only development and release tags deploy only
      production; record both deployment URLs and SHAs.
- [ ] Release `v0.3.0` only after creating an independent production GitHub
      read-only PAT, provisioning `GITHUB_SOURCE_TOKEN` and
      `MANUAL_TRIGGER_TOKEN` on `oss-knowledge-base-data-prod`, and completing
      the first production Feed/Search publication check. This release is
      deliberately deferred while the Fluss/Flink homelab slice is completed.

## Fluss/Flink homelab deployment

- [x] Deploy the pinned Fluss 0.9.1-incubating and Flink 1.20.3 standalone
      session cluster on the disposable `bench-swarm-01a` homelab VM.
- [x] Submit the accepted bounded materializer through the standalone Flink
      REST endpoint and retain parity/readiness evidence outside container
      filesystems.
- [x] Verify rerun safety, service health, and explicit shutdown without
      changing the Cloudflare serving path.

## Frontend polish

- [ ] Align Feed card footers across unequal summaries by making the card body
      consume remaining row height and pinning `.card-foot` to the bottom.
- [ ] Add a desktop visual assertion that same-row card footer baselines differ
      by at most one pixel; confirm mobile cards remain content-height.
