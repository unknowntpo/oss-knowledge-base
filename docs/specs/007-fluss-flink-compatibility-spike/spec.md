# Spec 007: Fluss/Flink Compatibility Spike

Status: Spike completed (#13, #14, #16): the bounded cluster-backed compatibility slice runs on a homelab VM; nothing of it is deployed

Owner: Project maintainers

Created: 2026-09-01

## Intent

Establish a reproducible Fluss/Flink baseline and an executable parity boundary
before implementing the first durable processing slice.

## Scope

This work contains three independent gates:

1. a JVM classpath gate proving Flink can discover the Fluss catalog connector
   from the pinned released artifacts;
2. a semantic gate comparing a future independently generated Flink projection
   with the accepted Spec 004 oracle;
3. a run-owned Fluss cluster and bounded Flink replay that produces that
   independent candidate.

The selected baseline is governed by
[ADR-0011](../../architecture/decisions/0011-pin-fluss-flink-compatibility-baseline.md):
Fluss 0.9.1-incubating, Flink 1.20.3, and Java 17 bytecode.

## Target vertical slice

```text
recorded DomainEventV1 fixture
        |
        v
Fluss Log Table (append-only canonical observations)
        |
        v
Flink deterministic materializer
        |
        +--> Fluss Primary Key Table (current entity state)
        |
        v
osskb.reference-projection.v1 candidate
        |
        v
canonical digest + byte-equivalent semantic parity gate
```

The Log Table must retain replayable observations. The Primary Key Table is a
rebuildable current view. The serving publication remains downstream and out
of scope until parity, restart, and retry evidence pass.

## Isolation and rerun contract

- The classpath smoke test has no cluster, port, filesystem, Cloudflare, or
  GitHub dependency.
- The cluster-backed runner allocates a unique database/table prefix
  per run, waits on observable readiness, and cleans up only its own resources.
- The fixture, materialization time, profiles, and revisions remain fixed.
- Every candidate is written to a run-owned path and never overwrites the
  accepted oracle.
- Failed runs preserve logs and the candidate only when explicitly requested;
  normal CI cleanup remains automatic.

## Parity contract

The candidate envelope must use `osskb.reference-projection.v1`. Its declared
digest must equal the canonical SHA-256 digest of its publication. The same
check is applied to the oracle before comparing both canonical JSON payloads
and digests.

The accepted oracle digest is:

`sha256:cecea8b974520ab3185e0f3ea944642890d24429601595028fd7bc02eb618c36`

Passing the oracle itself as the candidate proves only the gate mechanics. It
is not Flink parity evidence.

## Non-goals

- production cutover or R2 publication;
- a claim that connector discovery proves a working Fluss cluster;
- source acquisition, checkpoint commitment, or continuous-job recovery;
- Flink 2.2 adoption;
- Spark, Iceberg, semantic search, LLM, or load testing.

## Next implementation slice

Run the materializer on a standalone Flink cluster, add a fixture with multiple
versions of the same entity, and prove checkpoint recovery plus deterministic
latest-version ordering. Production remains on the TypeScript materializer
until that evidence is reviewed.
