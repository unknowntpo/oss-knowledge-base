# Workflow pilot 001: Feed freshness (Spec 010)

Goal: run one small feature through `workflow.md` and record where the process
held, where it failed, and what changed. The feature is the specimen; the
workflow is the subject.

## Hypotheses

| # | Hypothesis | Evidence | Result |
| --- | --- | --- | --- |
| H1 | Every assertion traces to a test | `bun run check:traceability` | pending |
| H2 | Tests catch a broken implementation | mutation run per acceptance item | pending |
| H3 | Each test is seen failing before the fix | recorded failing run | pending |
| H4 | A deployed deviation is visible | F6 on development | pending |

## Findings

### 1. Abstract assertions hid the real data (stage 2)

The first draft described fields in prose. The human reviewer could not judge
it without real values. Capturing `/api/feed` from development showed that
`generatedAt` is the run's scheduled start, not its finish, so the proposed
name `publishedAt` was misleading.

Change: specs carry an `Example` section built from captured real data
(template and workflow updated).

### 2. The AI over-designed the API (stage 2)

The first draft added `freshness { publishedAt, ageSeconds, staleAfterSeconds,
stale }` to `/api/feed`. The human asked why one timestamp was not enough.
Review showed the timestamp already existed in the response, and that a
server-computed age would be stale by up to 150 s because of response caching.
Three of four fields were deleted, the API change was dropped, and two
acceptance items (503 path, R2 read budget) disappeared with it.

Change: a five-step simplification review (question requirements, delete,
simplify, shorten the cycle, automate last) runs before a design is accepted.

## Process cost so far

- Two review rounds before any code; both changes came from the human.
- The traceability check caught its own template and the untested Spec 010
  draft on first run.
