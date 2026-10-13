# Spec 008: Content-addressed Feed and Search details

Status: Implemented (PR #21, merged 2026-09-30); C8–C10 added 2026-10-13 (R2 Class A incident)
Date: 2026-09-30
Amends: ADR-0004, ADR-0007, ADR-0010 (via ADR-0013); Spec 003 key layout; Spec 006 P3

> **Note 2026-10-13 ([Spec 018](../018-daily-publication/spec.md)).**
> Publication is daily, not hourly: "a steady-state hourly run" below is a
> daily run, which carries a day's changes, so its `copiedObjectCount` (and
> with it Class A) is about a day's worth of new objects rather than an
> hour's. C10's rule, Class A = new objects + 3, does not depend on the
> cadence.

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
   rejected any write whose bytes did not match that digest. Whether a key
   exists is asked with a `head` (R2 Class B), never with a conditional put
   that is expected to fail (R2 Class A); see "R2 operations" below.
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
- C8: a publication spends R2 Class A operations only on what it writes: at
  most one put per object it creates, plus the two pointers and the evidence
  object. An object that already exists costs one `head` and no put; a new
  object is put once with `if-none-match: *` and its SHA-256; an existing
  release key with different bytes still fails the run as
  `destination-conflict` with both pointers unchanged; a transient `head`
  failure is retried like any other request (three attempts); at most 16
  requests are in flight.
- C9: `/health` `lastRun.r2 { classA, classB }` is the number of R2 requests
  the run's publication sent, by billing class, retries and failed
  preconditions included, for a successful and for a failed run.
- C10: [deploy] on development, a steady-state hourly run reports
  `lastRun.r2.classA` at most `copiedObjectCount + 3` and `classB` at most
  `copiedObjectCount + reusedObjectCount + 3`.

## R2 operations (incident of 2026-10-13)

R2 bills by request class:

| Class | Requests | Price | Included a month |
| --- | --- | --- | --- |
| A | `put`, `list`, copy, multipart | $4.50 per million | 1 million |
| B | `get`, `head` | $0.36 per million | 10 million |

A conditional put whose precondition fails is still a Class A operation.

PR #20 (2026-09-30) replaced four requests per new object (`get`, `head`,
`put`, `get`) with one put conditional on `if-none-match: *` and checked by
R2 against the SHA-256, because a run exceeded the per-invocation request
limit. That put was also sent for every object that already existed, so each
hourly run on development spent one Class A operation per reused object:
about 8,150 an hour (`reusedObjectCount` 8,100–8,220, `copiedObjectCount`
24–42), 195 thousand a day, 5.9 million a month. The billing cycle that
started 2026-10-07 showed 1.2 million Class A operations by 2026-10-13
($4.50 so far, $19.93 projected) against 6.23 thousand Class B.

Since this change the publisher asks with `head` first and sends the same
conditional, checksummed put only for an absent key (C8). Per hourly run on
development, at about 8,150 reused and 35 new objects:

| | Class A | Class B | Requests |
| --- | --- | --- | --- |
| Before | about 8,190 (5.98 million a month) | 3 | about 8,190 |
| After | about 38 (28 thousand a month) | about 8,190 (5.98 million a month) | about 8,225 |

- Class B: 5.98 of the 10 million included. One environment stays inside it
  up to about 13,700 objects a run (1.7 times today). Each million beyond
  costs $0.36, so two environments at today's size would cost about $0.71 a
  month.
- Requests per run: one per reused object as before, two per new object;
  about 8,225 of the Worker's 20,000 (`limits.subrequests`), reached at
  about 19,900 objects. Concurrency is unchanged (16).
- Not done here: skipping keys the previous release already lists, which
  needs no request at all for a reused object ([G59](../../gardening.md)).

## Non-goals

- Sharing Feed index, Search shards, or manifests; they change every release.
- Deleting unreferenced releases or pool objects. Retention needs its own
  spec; publication-set evidence already records reachability.
- Verifying detail digests at read time.
