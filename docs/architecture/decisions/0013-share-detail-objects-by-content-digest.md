# ADR-0013: Share detail objects by content digest

- Status: Proposed
- Date: 2026-09-30
- Amends: ADR-0004, ADR-0007, ADR-0010 (release-scoped detail keys)

## Context

ADR-0004, ADR-0007, and ADR-0010 place every immutable object, including each
Feed and Search detail, under its release prefix, and accept the duplication
as a Phase 1 cost until it becomes material. Hourly development publication
now rewrites about 3,000 detail objects per run, of which about 99% are
byte-identical to the previous release (Spec 008). The copies dominate run
time and R2 requests and push runs toward the 15-minute alarm limit.

## Decision

- Store Feed and Search details once in per-projection pools keyed by the
  SHA-256 of their bytes: `public/v2/objects/details/<hex>.json` and
  `public/search/v1/objects/details/<hex>.json`.
- Keep indexes, shards, manifests, and pointers release-scoped. A release
  lists the digests it references; readers resolve a detail only through that
  list.
- Promotion writes a pool object only when absent and reuses an existing key
  without reading it back.
- Bump the Feed manifest to `feed-manifest.v3` and the Search release to
  `search-release.v2`; readers keep serving older releases.

The invariants that matter are unchanged: objects are never rewritten, each
pointer is written last, and each projection resolves only its own objects.

## Alternatives considered

- Reuse release-scoped keys by carrying unchanged objects forward: impossible,
  because the key embeds the release id.
- Share one pool between Feed and Search: their detail bytes differ in order,
  and a shared pool would break Spec 006 P10 projection isolation.
- Let clients request details by digest: skips the release membership check
  and would serve any object that ever existed.

## Consequences

- Steady-state runs write only new or changed details.
- A pool object is referenced by many releases, so deleting it needs a
  reachability pass; retention is deferred to its own spec.

## Revisit when

- Search shards or the Feed index grow large enough that they need splitting
  or sharing as well.
