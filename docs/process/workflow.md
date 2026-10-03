# Idea-to-production workflow

Status: Pilot (see `pilot-001.md`)

Every idea becomes something a machine can judge before AI writes code for it.
AI produces drafts, code, and first reviews; tests, measurements, and runtime
checks decide; a human owns intent, tradeoffs, and the definition of done.

Grounded in the `andrew-arch-skill` methodology (intent → assertion,
documents as control plane) and in this repository's 2026-09 Dev incidents,
where every outage came from an unstated platform budget or an unasserted
failure path.

## Stages

| Stage | Owner | Artifact | Exit check |
| --- | --- | --- | --- |
| 1. Intent | Human | Spec: problem, user, observable outcome, non-goals | Outcome is observable |
| 2. Assertions | Human; AI expands, human reviews the expansion | Numbered acceptance items in the spec | Every item names precondition, action, observable result, evidence |
| 3. Decision | Human; AI lists alternatives | ADR when the choice crosses features | Alternatives, consequences, revisit trigger |
| 4. Slice | AI | Smallest end-to-end change; tests first | Each new test was seen failing before the fix |
| 5. Gates | Machine | Local checks → CI → Dev → Prod | `bun run check:traceability` and CI green; deployed E2E green |
| 6. Runtime | Machine; alerts to human | Health fields, freshness, run evidence | A violated assertion is visible without manual tailing |

When runtime behavior contradicts an assertion, change the spec first, then
the code.

## Simplification review (stage 2, before any design is accepted)

Apply these in order; a later step never compensates for skipping an earlier
one. Adapted from Elon Musk's five-step engineering process.

1. **Question every requirement.** Each field, component, and acceptance item
   names who needs it and why. "The AI added it" is not an owner.
2. **Delete.** Remove every field, component, or step that cannot justify
   itself, including ones that already exist upstream (reuse a value already
   in the response instead of adding a new one). If nothing deleted ever has
   to be added back, the review was not aggressive enough.
3. **Simplify.** Only what survived deletion is simplified or optimized.
4. **Shorten the cycle.** Make the remaining loop faster to verify (smaller
   tests, faster feedback), not just faster to run.
5. **Automate last.** Add scripts, gates, or AI automation only for steps that
   survived 1–4.

Ground every review in a worked example on real data (the spec's `Example`
section); abstract descriptions hide which values actually exist.

## Required assertion classes

A spec is incomplete until it states, or explicitly marks not applicable:

- **Behavior** — the happy path.
- **Failure and retry** — at least as many items as the happy path: partial
  failure, retries, repeated input, and what a crash leaves behind.
- **Budget** — the platform limits the change runs under (memory, wall time,
  request count, payload size, cost), each with a measured value and a
  committed command that measures it.
- **Observability** — how a violation shows up after deployment.

## Traceability

Acceptance IDs (`M4`, `F2`, …) are the join key:

```text
spec acceptance ID → test name containing the ID → PR description → runtime check
```

`bun run check:traceability` fails when an acceptance ID in a spec marked
`Traceability: enforced` has no test whose name contains it. Items verified
only by deployment or measurement are tagged `[deploy]` or `[measure]` and are
listed in the PR instead.

## Evidence rules

- A test proves an assertion only after it was observed failing without the
  change (record the failing command or a mutation result).
- An AI "done" or "LGTM" is not evidence. Line-by-line human review of the
  diff is required before merge.
- Deployment evidence names the environment, the commit, and the observed
  values.
