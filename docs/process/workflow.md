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
    PR. Any new commit invalidates the verdict and requires a rerun. The one
    exception is a branch update that only merges `main` into a verified head
    without conflicts: it keeps the verdict once CI is green on the new head.
    A merge that resolved conflicts needs the resolved delta re-verified,
    because the resolution is new code nobody verified.
  - **Machines** run CI, traceability, test-plan consistency, and measurements.
  - **Runtime** (health fields, deployed checks) is the final judge.

Keep one intent per PR so a verdict, a revert, or a rollback stays small.

Merge authority: the human aligns on core decisions only — new intent or
product behavior, ADRs, data formats or contracts read by others, production
deploys and release tags, credentials, permissions, cost, public surfaces (a
new public URL or site, making data public, a new external integration), and
irreversible operations (when unsure, treat it as core). Other changes merge
without a human once gates are green and the verifier passed the final commit;
each is reported afterwards in one line. A PR that changes only Markdown
documentation (`docs/**`, `*.md`) needs green gates but no independent
verifier.

A public surface needs the human's explicit approval of that specific
publication even after the PR passed verification, because a passing verdict
says the change works, not that it should be public (#66; the agent harness
also blocks it).

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

Items for a planned later slice are tagged `[pending]`, and their case-file
markers end with ` [pending]`. The gate lists them without failing. It fails
when a pending item already has a test (a stale tag), or when the spec's
Status starts with "Implemented" (ai-sdd-workflow: each slice removes its own
`[pending]` tags). A malformed marker or tag, more than one tag on an item, or an
acceptance bullet the parser cannot read also fails the gate.

## Trust layers

Agents copy what they see, so trust comes from the environment, not from
reviewing more output (Lauren Tan, "Run a Michelin kitchen, not a code
factory",
https://agile3uncles.com/2026/10/05/run-a-michelin-kitchen-not-a-code-factory/). Layers, strongest first: structure (types, schemas) → static
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
  against `/api/feed`), for `--target local`, `dev` or `prod`. Read-only; they never
  call the publisher's `/run`.
  Dev Pages is public today; if Cloudflare Access is turned on for it, set
  `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` first (see
  [Dev access](../feature-map.md#dev-access-cloudflare-access)).

The verifier uses the kit first. When it needs a missing capability, it adds
the command or map entry and lists it in its report.

- **Test external assumptions directly.** The verifier may make read-only
  calls to public external APIs to check an assumption the code depends on,
  and lists every call it made; fixtures only repeat what the implementer
  believed (#72: GitHub returned 422 at page 15, which exposed a permanent
  stall in the daily paging).
- **Cost-bearing changes get a worst-case number.** For paid APIs, Workers AI
  neurons, R2 or other storage operations, or anything with a free tier, the
  verifier enumerates every path that can overshoot and states a concrete
  worst case per day and per month against the free allowance; "cap
  enforced" is not a verdict (#68: a mid-run crash lost unrecorded spend,
  fixed by reserving before each call).

## Merging, enabling, operating

- **Merge one PR at a time.** With several open, order them by dependency and
  conflict surface (#67 → #69 → #70). When a PR is BEHIND, merge `main` into
  its branch (no rebase, no force-push), wait for CI on the new head, then
  merge with `gh pr merge --match-head-commit <full sha>`, so a head pushed
  after the check cannot slip in. Re-verification follows the exception in
  [Roles and loops](#roles-and-loops).
- **Reserve sequential numbers up front.** Gardening `G` numbers, spec
  numbers, and acceptance prefixes collide across concurrent PRs (#66 and #68
  both took G67). When briefing parallel agents, assign each its numbers;
  otherwise the later-merging PR renumbers.
- **Stacked PRs say so.** When PR B contains PR A's commits, both bodies state
  it; merge A first, then merge `main` into B, so B's diff shows only its own
  change (#71 → #72).
- **Separate merge from enable.** New behavior ships behind a flag that is
  off in every environment, so the merge PR changes nothing at runtime; a
  second small PR per environment turns it on with its own operator sequence
  (#70 merged off, #71 enabled on Dev only). Otherwise a rollback needs a
  revert of the whole feature.
- **Write the operator sequence before merging.** Every PR that changes
  runtime behavior on deploy includes a post-merge sequence: ordered steps,
  the exact `/health` values expected after each step, stop and rollback
  conditions, and timing windows to avoid (#68: a dry run before the daily
  cron; #71: two real runs before the #72 backfill). Without it the operator
  learns the expected state from the incident.

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
