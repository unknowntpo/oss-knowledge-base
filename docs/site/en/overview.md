# System & data flow

Once a day a scheduled Worker collects community activity, turns it into threads, and publishes an immutable snapshot to R2; a static web app reads that snapshot through a small read-only API. Click any step to see what it does, the numbers from the last run, and the files that implement it.

## The flow {#flow}

{{flow:system}}

## The five stages {#stages}

1. **Collection.** A cron trigger starts the publisher in each environment. It reads GitHub, Jira and the Kafka dev@ list from per-source cursors kept in a Durable Object, so one failing source never blocks the others and a crash resumes where it stopped ([ADR-0014](docs/architecture/decisions/0014-publish-per-source-with-independent-cursors.md)).
2. **Processing.** `runDataPublication` in [apps/data-publisher-worker/src/pipeline.ts](apps/data-publisher-worker/src/pipeline.ts) materializes threads with deterministic rules (no language model in the publication path), writes the Feed release, and builds the search index.
3. **Storage.** R2 holds immutable releases and content-addressed detail objects; only small `current.json` pointers change, and they are written last. A reader therefore sees one complete release, and rollback is a pointer change ([Spec 006](docs/specs/006-environment-isolated-r2-publication/spec.md), [Spec 008](docs/specs/008-content-addressed-details/spec.md)).
4. **Application.** Pages Functions read R2 and return JSON with a 30-second cache; the Vue app renders it. Code deploys never publish data: data comes only from the Worker ([docs/operations/release.md](docs/operations/release.md)).
5. **Observability.** Every job reports its last run in the public `/health`. On Dev each run also writes a Workers Analytics Engine data point, rules over those points mark a missed or failing job, the cost guard records the month-to-date cost, and twice a day the SRE agent diagnoses new firing rules with a Workers AI model and stores its reasoning in R2 for the owner ([Spec 027](docs/specs/027-sre-agent/spec.md), [Spec 028](docs/specs/028-observability-signals/spec.md)).

## Dev and Prod {#environments}

The two environments are fully isolated: separate Workers, Durable Objects, R2 buckets and Pages projects, and no shared write credential ([ADR-0012](docs/architecture/decisions/0012-run-independent-cloudflare-data-crons.md)).

| Aspect | Dev | Prod |
| --- | --- | --- |
| Web app | [oss-knowledge-base-dev.pages.dev](https://oss-knowledge-base-dev.pages.dev/) | [oss-knowledge-base.pages.dev](https://oss-knowledge-base.pages.dev/) |
| Deployed by | every push to `main`, after all CI jobs pass, then checked by deployed end-to-end tests | a `v*` tag reachable from `main` (current `v0.3.2`, 2026-10-24) |
| Publication cron | 22:07 UTC | 22:37 UTC |
| Lexical search `bm25-reference@3` | on | on |
| Weekly digest | on (22:47 UTC) | off |
| Semantic hybrid search | on (`SEARCH_SEMANTIC=rrf-group@2`) | off |
| Contributor profiles, review ingestion | on | off |

Every Dev-only feature is a flag that is unset on Prod, listed in [docs/feature-map.md](docs/feature-map.md#deployed-configuration). New behaviour is merged with its flag off, then enabled per environment in a separate small change, so a rollback is a configuration change rather than a revert ([docs/process/workflow.md](docs/process/workflow.md)).

## Why it is built this way {#why}

- **Snapshots, not a live database.** A daily immutable release is cheap to serve from object storage, easy to reproduce, and lets every summary cite a fixed record. The target streaming architecture (Fluss, Flink, Iceberg) is accepted in [ADR-0001](docs/architecture/decisions/0001-use-fluss-for-events-and-current-state.md) but not built; only a compatibility spike exists ([Spec 007](docs/specs/007-fluss-flink-compatibility-spike/spec.md)).
- **Rules before models.** Thread materialization and identifier extraction are deterministic TypeScript ([ADR-0006](docs/architecture/decisions/0006-use-typescript-reference-materializer-before-flink.md)); language models are used only after publication, for the digest and semantic search, each with its own daily budget.
- **Visible staleness.** Dev once published nothing for about 49 hours without anyone noticing ([Spec 011](docs/specs/011-stall-visibility/spec.md)). Every view now shows the data's age: late after 24 h 30 min, stale after 27 h ([apps/web/src/freshness.ts](apps/web/src/freshness.ts)).

> As of 2026-10-20. Live run numbers in the diagram come from the public `/health` endpoints; the configuration comes from the wrangler files linked in each step.
