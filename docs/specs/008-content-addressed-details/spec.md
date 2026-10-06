# Spec 008: Content-addressed Feed and Search details

Status: Implemented (PR #21, merged 2026-09-30)
Date: 2026-09-30
Amends: ADR-0004, ADR-0007, ADR-0010 (via ADR-0013); Spec 003 key layout; Spec 006 P3

## Intent

Stop rewriting every detail object on every publication. A release keeps its
own index, shards, manifest, and pointer, but it references detail objects
that are stored once by content digest and shared by later releases.

## Evidence

Hourly development releases write one Feed detail and one Search detail per
FeedEntry under the release prefix, about 2N + 6 immutable objects. On
2026-09-30 N reached 1,494, and one run spent about 5 of its 15 minutes
promoting 2,992 objects. Comparing development publication-set evidence:

| Releases | Details present in both | Byte-identical |
| --- | --- | --- |
| 00:07 → 00:15 (8 min) | 1,302 | 1,296 (99.5%) |
| 11:07 → 00:07 (13 h) | 962 | 947 (98.4%) |

Nearly all writes are therefore copies of unchanged bytes. ADR-0007 and
ADR-0010 name this measurement as their revisit trigger.

## Target layout

```text
public/v2/current.json                         feed-manifest.v3 pointer
public/v2/releases/<releaseId>/feed/index.json
public/v2/releases/<releaseId>/feed/details.json    entry id -> sha256
public/v2/objects/details/<hex>.json           shared Feed details

public/search/v1/current.json
public/search/v1/releases/<rev>/manifest.json  search-release.v2
public/search/v1/releases/<rev>/lexical/<project>.json   group -> detailSha256
public/search/v1/objects/details/<hex>.json    shared Search details
```

`<hex>` is the lowercase SHA-256 of the exact object bytes. Feed and Search
keep separate pools, so neither projection ever reads the other's objects.

## Contract

1. A detail object key is `<pool>/<hex>.json`, where `<hex>` equals the
   declared `sha256`. Any other immutable key must stay under its release
   prefix. Validation rejects a pool key whose name differs from its digest.
2. A release declares every detail it references:
   - Feed: `feed/details.json` maps each FeedEntry id to a digest, and its
     entry count equals `entryCount`.
   - Search: each shard group carries `detailSha256`, and `objectDigests`
     lists every pool key the release references.
3. Promotion writes a pool object only when absent. An existing pool key is
   reused without reading it back, because its name is its digest and R2
   rejected any write whose bytes did not match that digest.
4. Readers resolve a detail only through the selected release's map or shard,
   never from a client-supplied digest, and reject a key outside that
   release's pool.
5. Readers accept `feed-manifest.v2` and `search-release.v1` releases
   unchanged, so rollback to an older release keeps working.

## Acceptance

- C1: publishing the same logical content twice writes no new detail objects;
  only the release index, map, shards, manifest, and pointers are new.
- C2: a changed thread writes exactly one new Feed detail and one new Search
  detail.
- C3: a pool key whose name differs from its bytes' digest fails validation
  before any pointer switches.
- C4: `/api/detail/:id` and `/api/search-detail/:ref` return the same bodies
  as before for a v3/v2 release, and still serve an older v2/v1 release.
- C5: an id absent from the release map returns 404, even if a matching pool
  object exists.
- C6: a detailRef from an older Search release still resolves after a newer
  release switches.
- C7: on development, a steady-state hourly run writes fewer than 100 detail
  objects and finishes well inside the 15-minute alarm limit.

## Non-goals

- Sharing Feed index, Search shards, or manifests; they change every release.
- Deleting unreferenced releases or pool objects. Retention needs its own
  spec; publication-set evidence already records reachability.
- Verifying detail digests at read time.
