# OSS Knowledge Base

A searchable knowledge base for **Apache Kafka Improvement Proposals (KIPs)**,
stored as an **Obsidian vault** and browsable two ways:

1. **In Obsidian** — open [`vault/`](vault) as a vault. Notes, tags, wikilinks,
   graph and backlinks all work natively.
2. **In the web viewer** — a React + TypeScript SPA in [`viewer/`](viewer) that
   parses the same vault and renders Browse, KIP detail, and (soon) Ask AI views.

The vault is the **single source of truth**; the viewer derives its data from it.

> This describes the legacy implementation. The new system is a greenfield
> rebuild: only the frontend visual language is a preservation requirement.
> Vault storage, data models, ingestion, routes, and build pipelines may be
> replaced; see [Project Constitution](docs/constitution.md) and
> [Architecture Context](docs/architecture/context.md).

## Development control plane

New work follows a specification-driven flow: intent → acceptance assertions →
architecture decisions → implementation plan → tested evidence.

- [Product vision](docs/product/vision.md)
- [Project constitution](docs/constitution.md)
- [Project-neutral community model](docs/domain/community-model.md)
- [Architecture context](docs/architecture/context.md)
- [Spec 001: Kafka Decision Thread](docs/specs/001-kafka-decision-thread/spec.md)
- [Spec 001 acceptance scenarios](docs/specs/001-kafka-decision-thread/acceptance.md)
- [Implementation tasks](docs/tasks.md)

## Live Kafka + DataFusion slice

The smallest end-to-end implementation is split by responsibility: Vue and
Cloudflare Pages Functions live in `apps/web/`; GitHub polling and R2 publishing
live in `apps/github-publisher/`; shared domain and serving contracts live in
`packages/`.

```bash
bun install
bun run dev        # Vue :4177 + GitHub publisher :4178
bun run test:unit  # deterministic domain behavior
bun run test:integration # replay pipeline + Pages Function/R2 contracts
bun run test:e2e   # fixture → local R2 → Pages Functions → Vue, desktop/mobile
bun run typecheck  # all active TypeScript packages
bun run --cwd apps/github-publisher test:live
```

This slice requires GitHub CLI authentication (`gh auth login`). In headless
environments, set `GH_TOKEN`; the application never reads or writes the token
itself and delegates authentication to `gh api`. The poller keeps one in-memory
snapshot and GitHub CLI caches endpoint responses for five minutes. No LLM is
used in this slice.

Pull requests run `.github/workflows/ci.yml` with separate typecheck/build,
unit, integration, and Playwright E2E gates. CI uses a recorded Kafka/DataFusion
fixture and recreated local Wrangler/R2 state; it never spends GitHub API quota
or requires an LLM/embedding credential.

## Repository layout

```
apps/web/               Vue app + Pages Functions + local R2 tooling
apps/github-publisher/  GitHub polling, Feed materialization, R2 publisher
packages/domain/        source-neutral domain and Feed behavior
packages/serving-contract/ FeedIndex/FeedDetail publication contract
docs/                   specs, ADRs, domain model, and task state

# Legacy implementation retained as migration reference
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
.github/workflows/      Cloudflare Pages deploy for the viewer
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
- **CI:** pushing to `main` runs `.github/workflows/deploy-cf-pages.yml`
  (`bun install → test → build → wrangler pages deploy`). Add two repo secrets:
  `CLOUDFLARE_API_TOKEN` (token with the *Cloudflare Pages: Edit* permission) and
  `CLOUDFLARE_ACCOUNT_ID`. Project config lives in `viewer/wrangler.toml`.

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
