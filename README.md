# OSS Knowledge Base

A reader for open-source community activity: Apache Kafka and Apache
DataFusion pull requests, issues, the Kafka dev@ mailing list and Jira,
published once a day to Cloudflare R2 and served by a Vue app on Cloudflare
Pages.

**What is built, in progress and planned:** see the generated status board at
https://unknowntpo.github.io/oss-knowledge-base/ (rebuilt from this
repository on every push; Spec 020). What each environment runs is in
[`docs/feature-map.md`](docs/feature-map.md); known gaps are in
[`docs/gardening.md`](docs/gardening.md).

| Environment | URL |
| --- | --- |
| Dev (deployed on every push to `main`) | https://oss-knowledge-base-dev.pages.dev |
| Prod (deployed on a `v*` tag; last tag `v0.2.0`, 2026-08-31) | https://oss-knowledge-base.pages.dev |

## Features

Each links to its spec; where it runs (Prod, Dev only, or behind a flag) is on
the status board.

- Feed and thread detail with timeline and key points ([001](docs/specs/001-kafka-decision-thread/spec.md), [002](docs/specs/002-generated-hot-feed/spec.md)), served from versioned R2 objects ([003](docs/specs/003-r2-feed-projection/spec.md), [008](docs/specs/008-content-addressed-details/spec.md)).
- Ingestion: GitHub ([004](docs/specs/004-replayable-github-feed/spec.md)), Kafka dev@ and Jira ([012](docs/specs/012-kafka-mailing-list-jira/spec.md)), GitHub pull-request reviews ([022](docs/specs/022-github-reviews/spec.md)); a data Worker per environment publishes once a day ([006](docs/specs/006-environment-isolated-r2-publication/spec.md), [009](docs/specs/009-bounded-memory-publication/spec.md), [018](docs/specs/018-daily-publication/spec.md)).
- Search: evidence-first lexical search ([005](docs/specs/005-evidence-search/spec.md), [013](docs/specs/013-search-streaming/spec.md), [017](docs/specs/017-lexical-ranking/spec.md)) and hybrid semantic search on Workers AI and Vectorize ([016](docs/specs/016-semantic-search/spec.md)).
- Freshness and stall visibility in the UI ([010](docs/specs/010-feed-freshness/spec.md), [011](docs/specs/011-stall-visibility/spec.md), [021](docs/specs/021-publication-overdue/spec.md)).
- Weekly topic digest written by a model ([014](docs/specs/014-topic-digest/spec.md)); contributor profiles ([019](docs/specs/019-contributor-profile/spec.md)); a review queue for PRs and KIPs, core only, no scheduled run and no UI yet ([015](docs/specs/015-review-queue/spec.md)).
- Design system and dark theme ([023](docs/specs/023-design-system/spec.md), [024](docs/specs/024-dark-theme/spec.md)); the generated feature-map site ([020](docs/specs/020-feature-map-site/spec.md)); a Fluss/Flink compatibility spike ([007](docs/specs/007-fluss-flink-compatibility-spike/spec.md)).

## How work is done

Specification-driven: intent → numbered acceptance items → tests that name
those items → an independent verifier → Dev, then Prod. See
[`docs/process/workflow.md`](docs/process/workflow.md), the
[constitution](docs/constitution.md), [architecture](docs/architecture/context.md)
and its [decision records](docs/architecture/decisions/).

```bash
bun install
bun run dev                  # local app
bun run typecheck
bun run test:unit
bun run test:integration
bun run build && bun run test:e2e   # fixture → local R2 → Pages Functions → Vue
bun run check:traceability   # every acceptance ID has a test
```

CI (`.github/workflows/ci.yml`) runs typecheck, unit, integration and
Playwright gates on recorded fixtures, then deploys Dev on `main` and Prod on
a `v*` tag.

## Repository layout

```
apps/web/                    Vue app, Pages Functions (/api/*), E2E
apps/data-publisher-worker/  Cloudflare Worker: daily publication, digest, embeddings, review ingestion
apps/github-publisher/       local GitHub polling and replay
packages/domain/             source-neutral domain and Feed behavior
packages/serving-contract/   Feed and Search publication contracts
packages/reference-pipeline/ ingestion connectors, digest and review-queue cores
packages/search/             lexical ranking and fusion
packages/semantic-vectorize/ Vectorize adapter and query gate
scripts/                     gates, verification kit, feature-map site
docs/                        specs, ADRs, feature map, gardening list, runbooks
```

The rest of this file describes the legacy KIP vault and viewer, kept as a
migration reference.

## Legacy implementation (migration reference)

A searchable knowledge base for Kafka Improvement Proposals, stored as an
Obsidian vault ([`vault/`](vault)) and browsed in a React viewer
([`viewer/`](viewer)).

```
vault/                  Obsidian vault (source of truth)
  KIPs/KIP-*.md         one note per KIP — frontmatter metadata + body sections
  KIPs.md               index / map of content
  .obsidian/            shared vault config
viewer/                 "our own viewer" — React + TS + Vite SPA
  scripts/parse-vault.ts    vault markdown -> structured KIP model (typed)
  scripts/build-kips.ts     writes public/data/** (pre dev/build) — see "Viewer data loading"
  src/                      TopBar, Browse, Detail, Ask views (routes /, /kip/:id, /ask)
  test/parse.test.ts        round-trips the vault losslessly against the seed
  test/build-data.test.ts   the generated index/detail payload contract
tools/kips.seed.json    canonical import snapshot (provenance + parser fixture)
```

## KIP note format

Each `vault/KIPs/KIP-*.md` is a normal Obsidian note:

```markdown
---
id: "KIP-500"
title: "Replace ZooKeeper with a Self-Managed Metadata Quorum"
status: "Adopted"
category: "Cluster Architecture"
release: "2.8 (EA) → 3.3 (prod)"
authors: ["Colin McCabe", "Jason Gustafson"]
tags: ["KRaft", "Metadata", "Controller", "Scalability"]
related: ["[[KIP-405]]", "[[KIP-848]]"]
---

## Summary
…
## Motivation
…
## Proposed Changes / Design
…
## Trade-offs
> [!success]+ Benefits
## Rejected Alternatives
## Discussion Thread
## Voting Thread
```

The parser reconstructs the structured model (motivation, design, pros/cons,
rejected alternatives, discussion messages, votes) from these conventions. The
`test/parse.test.ts` round-trip guarantees the markdown is a lossless encoding.

## Running the viewer

Tooling is **Bun** (package manager + TS runtime); the `.ts` scripts run without a
build step. Install Bun once: `curl -fsSL https://bun.sh/install | bash`.

```bash
cd viewer
bun install
bun run dev        # http://localhost:5173  (predev regenerates data from ../vault)
bun run test       # parser round-trip + ingest + semantic suites (vitest)
bun run build      # production build (served at the domain root on Cloudflare Pages)
bun run typecheck  # typechecks the viewer app AND the tools/ + scripts/ TS
bun run deploy     # build + wrangler pages deploy   (run `bunx wrangler login` once first)
```

`npm install` still works for the viewer's runtime deps (React/Vite), but the
build/embeddings/ingest scripts shell out to `bun`, so Bun must be on `PATH`.

## Viewer data loading

The corpus is **fetched at runtime, not bundled**. At 1144 KIPs, inlining
`kips.generated.json` into the JS bundle pushed it to ~472KB gzip, past the
~300KB gate in [`docs/sync-strategy.md`](docs/sync-strategy.md) §6. `bun
scripts/build-kips.ts` (run by `predev`/`prebuild`) now writes git-ignored
static JSON into `viewer/public/data/`, which Vite copies verbatim into `dist/`:

```
public/data/index.json       one compact entry per KIP: id, title, status,
                             category, release, tags, ~180-char blurb, stub
                             (~386KB raw / ~97KB gzip) — one fetch on first paint
public/data/kips/<id>.json   the full Kip object, one file per KIP — fetched
                             only when that detail page opens, cached per session
public/data/related.json     semantic neighbor map ("Similar KIPs")
```

Shipped JS is back to **~74KB gzip**, and the CDN caches every detail file
independently so a visitor downloads only what they open.

**Tradeoff:** the Browse index carries a truncated blurb, so client-side search
matches `id + title + blurb + tags + category` only. Full summary/motivation text
is no longer searchable in the browser — deep full-text search is the Ask AI
(semantic) path's job. See `viewer/src/lib/kips.ts`.

## Deploy — Cloudflare Pages

Hosted on **Cloudflare Pages** (`kip-knowledge-base.pages.dev`). Two ways to ship:

- **Local:** `cd viewer && bunx wrangler login` once, then `bun run deploy`.
- **CI:** no workflow deploys the legacy viewer any more
  (`deploy-cf-pages.yml` was removed); project config lives in
  `viewer/wrangler.toml`.

## Ingestion

Upstream Apache Kafka sources (Confluence, Jira, GitHub, mailing list) are polled
by a GitHub Actions cron and applied back into the vault. The full contract lives
in [`docs/ingestion-spec.md`](docs/ingestion-spec.md); **M1** (Confluence
two-tier polling + deterministic `cwiki` frontmatter + drift flagging) is
implemented under [`tools/ingest/`](tools/ingest):

```bash
bun tools/ingest/run.ts --dry-run     # prints ChangeEvents + would-be frontmatter
                                       # diffs, writes nothing (hits the real cwiki
                                       # API through the polite-fetch wrapper)
bun tools/ingest/run.ts               # real run: patches the additive cwiki block,
                                       # tools/ingest-state.json, pending-changes.json
```

All network access is funneled through `tools/ingest/polite-fetch.ts` (spec §6:
≤1 req/s + jitter, concurrency ≤2, descriptive UA, robots.txt, 429/backoff,
follow-list-only). The follow list is derived from `vault/KIPs/*.md`, never
hardcoded. Deterministic metadata is machine-committed; body/prose changes are
recorded as drift in `tools/pending-changes.json` for human review — the KB
prefers **stale over wrong**. Raw payload snapshots land in the git-ignored
`tools/ingest-cache/`. The workflow is
[`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) (manual only since 2026-10-14).

## Corpus backfill

The full KIP corpus (~1150 pages, every status) is imported queue-style from the
cwiki index. `tools/backfill/queue.json` is the committed work queue — one entry
per KIP with a state machine (`pending → detail_done → threads_done | failed`),
checkpointed after every item, so any run resumes where the last one stopped and
git history doubles as the crawl audit log. Each import writes a **stub note**
(`stub: true` frontmatter: status, summary, cwiki link, mailing-list thread
links) alongside the 9 deep hand-authored notes; stubs are upgraded to full
structure later (M3). Statuses are normalized to
`Adopted / Early Access / Under Discussion / Discarded / Unknown` — see
`docs/ingestion-spec.md`.

```bash
bun tools/backfill/run.ts --dry-run           # discovery + would-crawl list
bun tools/backfill/run.ts --limit 50          # crawl 50, checkpoint, stop
bun tools/backfill/run.ts                     # drain all pending (~1150 × ~1s/req)
```

In CI: trigger `.github/workflows/backfill.yml` (workflow_dispatch; dry_run /
limit / no_threads inputs) — it tests first, crawls, regenerates embeddings,
checkpoints vault + vectors on `automation/corpus-backfill`, and opens a pull
request review issue only after the golden-query gate passes. A maintainer uses
its compare link to create the PR. The workflow never pushes generated data
directly to `main`. All crawling goes through the polite-fetch wrapper (1 req/s
+ jitter, cwiki + lists.apache.org only). The resolver is
space-scoped with a KIP-number boundary match and prefers **skipping over
importing a wrong page**. See [`docs/sync-strategy.md`](docs/sync-strategy.md)
for the steady-state freshness design (CQL delta, twice-daily cron, monthly
reconciliation).

## Semantic layer

A build-time semantic index over the vault, under [`tools/semantic/`](tools/semantic):

- `embeddings.json` — per-KIP document vectors (`Xenova/e5-small-v2`, 384-dim,
  mean-pooled + normalized) plus a `corpusHash` staleness guard.
- `related.json` — top-3 semantic neighbors per KIP; drives the **"Similar KIPs"**
  card in the detail view's right rail (neighbors already listed in a note's
  curated `related` frontmatter are filtered out, so the two cards don't repeat).
- `golden-queries.json` / `golden-embeddings.json` — a hand-authored regression
  set: each query should retrieve an expected KIP in its top-3 (deterministic
  cosine, checked in CI with no model download).

Regenerate after editing the vault:

```bash
cd viewer && bun run embeddings   # first run downloads the ~30MB model
```

All three JSON files are committed. `viewer/test/semantic.test.ts` fails (with the
exact regen command) if the vault drifts from the committed vectors. See
[`docs/ingestion-spec.md`](docs/ingestion-spec.md) §M4 for the rubric and the
`query:`/`passage:` (e5 asymmetric) convention.

## Ask AI (deferred)

The semantic-search "Ask AI" view is scaffolded but intentionally **not wired up
yet**. When enabled it will slot in behind a single `askKips(query)` call and
expose the same `search_kips(query)` contract described in the design spec
(keyword ranking first; embeddings + LLM synthesis / an MCP server later).

## Data

Seeded with 9 representative real KIPs — KIP-500 (KRaft), KIP-405 (Tiered
Storage), KIP-98 (Exactly-Once), KIP-848 (new rebalance protocol), KIP-679
(idempotence by default), KIP-101 (leader-epoch truncation), KIP-227 (incremental
fetch), KIP-392 (fetch from closest replica), KIP-932 (Queues / share groups).
Discussion and voting entries are representative summaries written to the real
structure; replace with authoritative content on ingestion.
