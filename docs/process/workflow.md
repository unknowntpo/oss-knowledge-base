# Idea-to-production workflow

Status: Pilot (see `pilot-001.md`)

Every idea becomes something a machine can judge before AI writes code for it.
AI produces drafts, code, and first reviews; tests, measurements, and runtime
checks decide; a human owns intent, tradeoffs, and the definition of done.

Grounded in the `andrew-arch-skill` methodology (intent → assertion,
documents as control plane) and in this repository's 2026-09 Dev incidents,
where every outage came from an unstated platform budget or an unasserted
failure path.

## Roles and loops

Two loops, after Lauren Tan's published agent workflow
(https://aiidelist.com/blog/lauren-tan-grok-bot-pstack-workflow):

- **Outer loop — what deserves work (human).** The human owns intent,
  tradeoffs, and the decision to merge and deploy. The human reviews intent
  artifacts — the spec's Example, the simplification review, the generated
  test plan — and the independent verifier's verdict, not diffs line by line.
- **Inner loop — a scoped task becomes a verified change (agents).**
  - The **implementer** turns an accepted spec into the smallest change that
    satisfies it, writes tests first, and reviews its own diff line by line.
  - The **independent verifier** is a different agent — by default a Fable
    agent that may delegate parts of the work to Opus sub-agents and must check
    their evidence — given only the spec and the commit. It reruns every acceptance item
    against the running system, attaches evidence (test output, screenshots,
    captured responses), and records pass, fail, or unverifiable per ID in the
    PR. Any new commit invalidates the verdict and requires a rerun.
  - **Machines** run CI, traceability, test-plan consistency, and measurements.
  - **Runtime** (health fields, deployed checks) is the final judge.

Keep one intent per PR so a verdict, a revert, or a rollback stays small.

Merge authority: the human aligns on core decisions only — new intent or
product behavior, ADRs, data formats or contracts read by others, production
deploys and release tags, credentials, permissions, cost, and irreversible
operations (when unsure, treat it as core). Other changes merge without a
human once gates are green and the verifier passed the final commit; each is
reported afterwards in one line. A PR that changes only Markdown documentation
(`docs/**`, `*.md`) needs green gates but no independent verifier.

## Stages

| Stage | Owner | Artifact | Exit check |
| --- | --- | --- | --- |
| 1. Intent | Human | Spec: problem, user, observable outcome, non-goals | Outcome is observable |
| 2. Assertions | Human; AI expands, human reviews the expansion | Numbered acceptance items in the spec | Every item names precondition, action, observable result, evidence |
| 3. Decision | Human; AI lists alternatives | ADR when the choice crosses features | Alternatives, consequences, revisit trigger |
| 4. Slice | AI | Smallest end-to-end change; tests first | Each new test was seen failing before the fix |
| 5. Gates | Machine; verifier with the verification kit | Local checks → CI → Dev → Prod | `bun run check:traceability` and CI green; deployed E2E green |
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

A spec's test plan is generated, not hand-written: rows live in a case file
that the unit tests iterate with `test.each`, and `bun run docs:test-plan`
renders them between `<!-- test-plan:start <case file> -->` and
`<!-- test-plan:end -->` in the spec. `bun run check:test-plan` fails when the
table and the case file disagree, so the table a human reviews is always the
data the tests run. Step-based scenarios stay as named E2E tests and take
their expected texts from the same case file.

`bun run check:traceability` fails when an acceptance ID in a spec marked
`Traceability: enforced` has no test whose name contains it. Items verified
only by deployment or measurement are tagged `[deploy]` or `[measure]` and are
listed in the PR instead.

## Trust layers

Agents copy what they see, so trust comes from the environment, not from
reviewing more output (Lauren Tan, "Run a Michelin kitchen, not a code
factory"). Layers, strongest first: structure (types, schemas) → static
checks (CI gates) → tests and measurements → rules (this file) → automated
review (the verifier) → skills → human review.

**Move each lesson to the strongest layer that can hold it.** When a
verifier, an incident, or a human finds a defect, fix the instance, then add
the type, gate, or test row that stops it recurring, and name that layer in
the PR. A note in a rule file is the last resort.

## Verification kit

Verifiers do not rebuild a harness per PR. The repository keeps:

- [`docs/feature-map.md`](../feature-map.md): routes, APIs, stable selectors,
  data sources, environment URLs, and the acceptance IDs covering each.
  Update it in the PR that changes behavior.
- `bun run verify:ui` (viewport, locale, controlled clock → screenshots and
  element states as JSON) and `bun run verify:health` (publisher `/health`
  against `/api/feed`), for `--target local` or `dev`. Read-only; they never
  call the publisher's `/run`.

The verifier uses the kit first. When it needs a missing capability, it adds
the command or map entry and lists it in its report.

## Gardening

Agents replicate existing workarounds, so debt spreads.
[`docs/gardening.md`](../gardening.md) lists known workarounds, stale copy,
follow-ups recorded as non-goals, and test gaps, each with its source and the
trust layer its fix belongs in. No new workaround or follow-up lands without
an entry. A gardener pass (human or agent) fixes or deletes items and removes
them from the list; prefer deleting a workaround to explaining it.

## Evidence rules

- A test proves an assertion only after it was observed failing without the
  change (record the failing command or a mutation result).
- An AI "done" or "LGTM" is not evidence. A merge needs the implementer's
  line-by-line self-review, green gates, and the independent verifier's
  per-ID verdict with evidence on the final commit.
- Deployment evidence names the environment, the commit, and the observed
  values.
