# Spec NNN: Title

Status: Draft
Date: YYYY-MM-DD
Traceability: enforced
Builds on: (specs / ADRs)

## Intent

Who has which problem, and what observable outcome solves it.

## Evidence

Measurements or incidents that motivate the change.

## Example

A worked example on real data: actual values from the running system
(captured at a stated time), the input, and the expected output.

## Forces (約束)

Pressures the design must answer (see Forces in docs/process/workflow.md).
Kind = hard limit, quality, taste, or assumption (mark hypotheses). Source =
owner quote with date, measurement, incident, or platform limit.

| ID | Force | Kind | Source | Conflicts with |
| --- | --- | --- | --- | --- |
| FC1 | | | | |

Problem: one sentence a design can pass or fail against these Forces.

Solution Space: the null design and at least one alternative, each with the
Forces it satisfies, trades, or worsens, and why the chosen one wins.

## Behavior

Numbered rules the implementation must follow. Each rule cites the Force IDs
it answers; each new field or component names who needs it (see the
simplification review in docs/process/workflow.md).

## Acceptance

Each item: precondition → action → observable result → evidence.
Tag items proven only after deployment `[deploy]`, by a measurement command
`[measure]`; untagged items must have a test whose name contains the ID.

### Behavior
- X1:

### Failure and retry
- X2:

### Budget
- X3: [measure] (limit, measured value, command)

### Observability
- X4: [deploy]

## Non-goals

Include each deferred Force, with its ID.
