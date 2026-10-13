# ADR-0012: Run independent Cloudflare data publishers per environment

- Status: Accepted
- Date: 2026-09-02
- Supersedes: ADR-0010's production-promotion-only rule

## Context

Development and production already use separate Pages projects and R2 buckets.
ADR-0010 kept production data manual by copying verified development bytes, but
that couples production liveness to development publication and promotion. The
operational requirement is now that both environments refresh automatically,
while a development publisher change must not alter production behavior.

The serving invariants remain unchanged: Feed and Search releases are
immutable, each pointer is written last, a failed acquisition serves stale
data, and R2 is not the canonical event store.

## Decision

- Deploy two Cloudflare Workers: `oss-knowledge-base-data-dev` and
  `oss-knowledge-base-data-prod`.
- Give each Worker its own Cron Trigger, Durable Object state, GitHub secret,
  manual-trigger secret, and R2 bucket binding.
- Development runs at minute 7 of every UTC hour and writes only
  `oss-knowledge-base-dev`.
- Production runs at minute 37 of every UTC hour and writes only
  `oss-knowledge-base-prod`.
- **Amended 2026-10-13 (owner; Spec 018):** both run once a day instead,
  development at 22:07 UTC (`7 22 * * *`) and production at 22:37 UTC
  (`37 22 * * *`), because the upstream sources change too little for 24
  publications a day. A truncated or failed run schedules its own follow-up.
  The rest of this decision is unchanged.
- A push to `main` may deploy the development Worker. Only a version tag whose
  commit is reachable from `main` may deploy the production Worker. Therefore
  development code changes do not reach the production Cron until an explicit
  tagged code release.
- Each environment polls GitHub and materializes its own complete Feed and
  Search releases. Their release IDs, bytes, and source checkpoints are
  intentionally independent.
- One environment-local Durable Object serializes runs and stores the temporary
  TypeScript reference state and GitHub checkpoint. R2 continues to store only
  serving projections and publication evidence.
- Source, validation, materialization, or upload failure does not advance the
  affected projection pointer or checkpoint. The last complete release remains
  readable.
- Pull-request CI uses recorded fixtures and performs no live GitHub or
  Cloudflare writes.

## Alternatives considered

### Keep production promotion-only

Rejected for the current operating requirement. It prevents bad development
data from reaching production, but production liveness depends on a human
promotion and on development having completed first.

### Use one Worker with two bucket bindings

Rejected. A code or configuration error would have authority over both
environments, weakening the existing bucket-level isolation.

### Store the checkpoint in serving R2

Rejected. Processing state and serving projections have different recovery and
access boundaries. The Durable Object owns temporary reference-pipeline state;
the future Fluss/Flink plane may replace it.

## Consequences

- Development and production can refresh independently and may legitimately
  show different fresh revisions.
- Production data changes automatically even when production code is unchanged.
- Production code behavior remains pinned to its last tagged Worker deployment.
- Two separately scoped runtime secret sets must be provisioned and rotated.
- This reference materializer requires Workers Paid limits; the REST connector
  can exceed the Free plan's 50-subrequest and 10 ms CPU boundaries.
- Rollback must first pause the affected Cron, then select a previously verified
  pointer; otherwise the next scheduled run may advance it again.

## Revisit when

- Fluss/Flink becomes the durable production processing plane;
- GitHub webhooks or Queues replace polling;
- a GraphQL acquisition path proves the workload fits Workers Free limits;
- production requires a human approval for every data revision again.
