# OSS Knowledge Base

A daily, evidence-first reader for open-source communities: what happened in Apache Kafka and Apache DataFusion this week, searchable down to the original pull request, Jira issue or mailing-list message. These pages explain how it is built, why, and what it costs.

## What it is {#what}

The product collects public community activity once a day, turns it into threads, publishes an immutable snapshot to object storage, and serves a small web app on top of it. Every summary and search hit links back to the source record, so a reader can check the claim (see [README.md](README.md) and [docs/feature-map.md](docs/feature-map.md)).

| Fact | Value |
| --- | --- |
| Communities | Apache Kafka (GitHub, Jira, the dev@ mailing list) and Apache DataFusion (GitHub) |
| Live sites | Prod [oss-knowledge-base.pages.dev](https://oss-knowledge-base.pages.dev/) (release `v0.3.1`, 2026-10-19) and Dev [oss-knowledge-base-dev.pages.dev](https://oss-knowledge-base-dev.pages.dev/) (every push to `main`) |
| Runs on | Cloudflare: one scheduled Worker per environment writes to R2 object storage; Pages serves the Vue app and its read-only API |
| Built with | {{value:specs}} written specifications, {{value:enforcedSpecs}} of them with machine-checked acceptance items; independent AI verification of every change |

Jargon used throughout: **R2** is Cloudflare's object storage (billed per request class, see [Process & cost](process.html#incident)); a **Worker** is a serverless function; a **Durable Object** is a Worker with its own strongly consistent state; **Pages** hosts the static site and its API functions.

## Read next {#pages}

| Page | What you will learn |
| --- | --- |
| [System & data flow](overview.html) | The four stages (collection → processing → storage → application) as a clickable diagram, and what differs between Dev and Prod |
| [Search](search.html) | BM25 ranking with identifier normalisation (`KIP770` = `KIP-770`), the real-corpus evaluation, and the semantic hybrid running on Dev |
| [Weekly digest](digest.html) | How a week of activity becomes a bilingual summary: classify, summarise, validate, translate, and the quality gate before Prod |
| [Process & cost](process.html) | Spec-driven development, fail-first tests, CI/CD and releases, the R2 cost incident, budgets and observability |

## Status at a glance {#status}

As of 2026-10-20 (sources: [docs/feature-map.md](docs/feature-map.md#environments), [docs/operations/release.md](docs/operations/release.md)):

- **On Prod and Dev:** daily publication from GitHub, Jira and dev@; lexical search `bm25-reference@3`; thread list and detail; the data-freshness indicator.
- **Dev only:** the weekly topic digest, semantic hybrid search, contributor profiles and review ingestion. Each sits behind its own flag and is off on Prod.
- **Next for Prod:** the digest goes to Prod only after its quality gate passes on a human-labelled week ([digest](digest.html#gate)).

> Numbers on these pages come from the repository at the commit in the footer, or from the public `/health` endpoint at a stated time. Each one links to where it comes from.
