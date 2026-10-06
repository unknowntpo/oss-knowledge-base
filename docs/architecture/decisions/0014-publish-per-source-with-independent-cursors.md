# ADR-0014: Publish per source with independent cursors

- Status: Accepted
- Date: 2026-10-06
- Spec: Spec 012 (Kafka dev mailing list and Jira sources)
- Amends: ADR-0012 ("a failed acquisition serves stale data" now holds per source)

## Context

Until Spec 012 the hourly publication run read one source, GitHub, and a
failed poll ended the run without publishing. Spec 012 adds the Kafka dev@
list (Pony Mail) and KAFKA Jira. Each is a separate public service with its own
outages; if any one of three sources can stop publication, the Feed goes stale
three times as often, and a single unavailable Apache service would also hide
fresh GitHub data.

The new sources also link entries across sources (a PR titled
`KAFKA-20184: …` and the Jira issue KAFKA-20184), and Search opens a Detail
whose display id the web app currently guesses from the root record's title.

## Decision

- **One cursor per source instance.** The existing checkpoint's `sources` map
  is already keyed by source instance id (`kafka:github`, `kafka:mail:dev`,
  `kafka:jira`), so it keeps schema `osskb.github-checkpoint.v1`. A run
  replaces only the entries of sources that polled successfully.
- **Partial publication.** Every source is polled; a source that fails
  (`transport`, `rate-limit`, `schema`, `truncated`, `too-large`) contributes
  no events and keeps its cursor. The run publishes when at least one source
  succeeded and reports `ok: true`; it fails only when every source failed or
  publication itself failed. This applies to GitHub as well.
- **Per-source health.** The run status, and `/health`, carry each source's
  `ok`, `lastSuccessAt`, cursor, poll duration, counts, `gapCapped`, and last
  failure kind, so a failing source is visible while the run is `ok`.
- **Related entries, not merged entries.** Feed Detail gains an optional
  `related` list naming other published entries (display id, title, source,
  rule, rule revision) found by deterministic key rules. It is separate from
  record connections and grouping relationships, which would merge entries.
- **Display id in Detail.** Feed Detail gains an optional `displayId`, so a
  Search hit shows the entry's id without parsing a title.
- **Event identity conflicts do not fail the run.** An event whose dedupe
  identity is already stored with different content keeps the stored event
  and is counted as a conflict for its source.

## Alternatives considered

- Fail the run when any source fails (status quo): simplest, but an Apache
  outage would stop GitHub publication too.
- One publication run per source: three Durable Object alarms, three
  publication sets, and cross-source links computed from partial data.
- A checkpoint schema v2: not needed, because the v1 `sources` map already
  holds one watermark per source instance.
- Merging a KIP's thread, issue, and PRs into one Feed entry: changes the
  display ids and URLs of existing GitHub entries; left to the AI-topics spec.

## Consequences

- A run can be `ok` while one source is stale. Spec 011 alerts only on the run,
  so a source that keeps failing is visible in `/health` but not alerted.
- Adding `displayId` changes every Detail's bytes once; the first run after
  deployment writes every Detail object again.
- Readers of Feed Detail must tolerate the optional `related` and `displayId`
  fields (the web app is the only reader).

## Revisit when

- A source stays failed for more than 3 hours without anyone noticing: add a
  per-source alert to Spec 011's checker.
- A fourth source or a second project's list is added: reconsider one run per
  source.
