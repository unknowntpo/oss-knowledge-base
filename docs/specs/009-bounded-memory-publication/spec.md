# Spec 009: Bounded-memory publication

Status: Draft
Date: 2026-10-02
Builds on: Spec 006, Spec 008, ADR-0012, ADR-0013

## Intent

An hourly publication run must fit the Durable Object's 128 MB isolate at the
steady-state event volume, with room to add sources, without changing what is
published.

## Evidence

Profiling the current pipeline on a real 35-day GitHub dataset (8,627 retained
events, 2,377 Feed entries, 4,761 projection objects) under Node/V8:

| Events | Minimum V8 heap that completes |
| --- | --- |
| 4,771 | 132 MB |
| 8,627 | 233 MB |
| 17,254 | 473 MB |

Peak memory grows about 30 MB per 1,000 events. Development succeeded at
4,612 events and failed with `exceededMemory` above 5,000. The largest retained
values are every serialized object body held at once (about 94 MB, mostly
two-byte strings), a byte copy of every body for promotion (48 MB), and an
unused canonical JSON of the whole publication (43 MB).

## Behavior

1. Projection objects are produced one at a time. Each body is serialized,
   digested, written, and released before the next is produced; no run holds
   all bodies at once.
2. The publication set descriptor (key, sha256, byteLength per object), the
   Feed detail map, and the Search manifest `objectDigests` are built from the
   streamed digests.
3. Each object's digest and byte length are computed from the exact bytes
   written, and R2 rejects a write whose bytes differ from that digest
   (Spec 008). Cross-object invariants (every Feed entry has a mapped detail,
   every Search group names a declared detail, counts match) are guaranteed
   while the objects are produced and checked on the descriptors before any
   pointer switches; large bodies are not re-read for verification.
   Immutable objects may be written before that check; a failed run leaves them
   unreferenced and switches no pointer, which satisfies Spec 006 P3/P4.
4. Pointers still switch last, Search before Feed, and only when their bytes
   change (Spec 006, Spec 008 unchanged).
5. The materializer does not retain a canonical JSON copy of the publication.
6. Committing state writes only added or changed events and deletes removed
   ones, without re-reading every stored event.
7. Before each phase, a run persists a phase marker (phase name, start time,
   counts so far). Workers expose no memory reading, so a run killed by the
   platform is attributed by the last persisted phase, which `/health` shows
   until a later run completes.
8. An alarm still registered 30 minutes after its scheduled time is treated as
   stale, so the next trigger schedules a new run instead of returning 409.

## Acceptance

M1 and M2 use a committed, seeded generator that produces GitHub-shaped events
with the measured shape of development data (about 28% roots, 72% comments,
two-byte text) and a committed command that runs the full publication under
Node/V8 against in-memory state and destination, reporting the peak of
`heapUsed + arrayBuffers` after forced GC at each phase. Measurements on real
GitHub data are supporting evidence only.

- M1: with 8,600 generated events, the reported peak is at most 96 MB.
- M2: with 17,200 generated events, the reported peak is at most 128 MB.
- M3: for the same events and `materializedAt`, the published R2 objects
  (keys and bytes), publication-set evidence, and pointers are identical to
  the current implementation's output.
- M4: an injected failure while writing the k-th immutable object leaves both
  pointers unchanged, and a rerun with the same `materializedAt` completes and
  reuses the objects already written.
- M5: an injected validation failure (pool key name differs from its digest)
  switches no pointer.
- M6: a development hourly run at the then-current event volume reports
  `ok: true` for 24 consecutive hours.
- M7: a run interrupted during promotion leaves `/health` showing that phase
  and its start time until the next run completes.
- M8: committing a state that adds one event and removes one event performs
  exactly one put and one delete of event keys and does not list the stored
  events.
- M9: with an alarm registered more than 30 minutes in the past, `POST /run`
  returns 202 and schedules a run; with one registered less than 30 minutes
  ago, it returns 409.

## Non-goals

- Changing the R2 layout, schemas, or readers.
- Splitting Feed and Search into separate runs.
- Shortening the 35-day retention window.
- Bounding the materializer's in-memory Feed and Search publications; at 2x
  they are expected to fit and are measured by M2.
