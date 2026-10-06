# Workflow pilot 001: Feed freshness (Spec 010)

Goal: run one small feature through `workflow.md` and record where the process
held, where it failed, and what changed. The feature is the specimen; the
workflow is the subject.

## Hypotheses

| # | Hypothesis | Evidence | Result |
| --- | --- | --- | --- |
| H1 | Every assertion traces to a test | `bun run check:traceability` | held (6 items; F6 by deployment) |
| H2 | Tests catch a broken implementation | mutation run per acceptance item | held after adding one case (finding 6) |
| H3 | Each test is seen failing before the fix | recorded failing run | held, after fixing two vacuous tests (finding 3) |
| H4 | A deployed deviation is visible | F6 on development | pending deployment |

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

### 3. Two tests passed against an empty implementation (stage 4)

Run against a stub that returns `undefined`, the unit test and the E2E test
for F4 ("no age when `generatedAt` is unparsable") both passed: absence of a
label is also what "feature not built" looks like. Each now first asserts the
positive case on the same input path (a valid time shows an age), so it fails
until the feature exists. Final pre-implementation run: unit F1, F2, F4, F5
fail (4/4); E2E F3, F4 fail (2/2, desktop; mobile skipped because the pill is
hidden below 420 px).

Change: a test of an absence ("does not show", "is undefined") must include a
positive control on the same path. Seeing every test fail before the fix is
what exposed this, so the rule stays mandatory.

### 4. The reviewed table and the tests could drift (stage 2–4)

The human asked how a test-plan table in the spec stays aligned with the test
code. A hand-copied table can silently disagree with what the tests run.

Change: the case file is the single source. Unit tests iterate it with
`test.each`, `bun run docs:test-plan` renders the spec table, and CI runs
`check:test-plan`. Verified by editing one case without re-rendering: the
check failed, and passed again after the edit was reverted.

### 5. The new gate broke the old one (stage 5)

Switching the unit tests to `test.each` made their names templates
(`"$id: …"`), so `check:traceability`, which reads test titles from source,
reported F1, F2, and F5 as untested although they ran.

Change: the traceability check reads the case file named by a spec's
test-plan marker and counts its row IDs, but only for that spec and only when
some test imports the case file and runs it with `test.each`. Each gate is
exercised by its own tests (`scripts/test/`).

### 6. A boundary the spec named had no case (stage 4)

Seven mutations, one per acceptance behavior: six were caught. Changing
"minutes below one hour" from `< 60` to `<= 60` passed every test, because no
case sat exactly at one hour although Behavior 1 names that boundary. Adding
the row `23:07:13 → 00:07:13 = "Updated 1 h ago"` made the mutation fail.

| Mutation | Failing tests |
| --- | --- |
| stale at `>=` instead of `>` 3 h (F2) | 1 |
| minutes up to and including 60 (F1) | 0 → 1 after the new case |
| no clamp for a future `generatedAt` (F5) | 1 |
| no guard for an unparsable `generatedAt` (F4) | 1 |
| stale text not used (F2) | 1 |
| refresh every 5 min instead of 1 (F3, E2E) | 1 |
| stale styling not applied (F3, E2E) | 1 |

Change: every boundary named in a spec's Behavior gets a case on each side,
and mutation runs stay part of stage 4.

### 7. The independent verifier found a spec/behavior mismatch (stage 5)

Codex could not run (its default model is not available to this account), so
a different Claude model verified commit 4d10c4e with only the spec and the
code. It drove the running app in both locales with a controlled clock and
passed F1–F5, and it reported that Behavior 4 said an unparsable
`generatedAt` "hides the label" while the app keeps the previous "Published
snapshot" label. The tests only asserted the absence of an age, so they could
not tell. The spec was corrected to the observed, preferable behavior and the
F4 E2E now asserts the exact label.

Change: none to the process; this is the verifier doing its job. Independence
was weaker than intended (same vendor), which is recorded as a limit of this
pilot.

### 8. The re-verification found two surviving mutants (stage 5)

The user asked that verification run on a Fable agent that may delegate to
Opus. Fable re-verified commit 7f572a9 (gates, 30 screenshots across both
locales with a frozen clock, production diff) and passed F1–F5. Its delegated
Opus mutation run found two mutants the tests did not kill: rounding hours
instead of flooring (every hour case was a whole hour) and accepting a
non-string `generatedAt` (the only F4 case was a string). Two case rows
(1 h 45 min → "1 h ago"; `generatedAt: 0` → no age) now kill both.

Change: the verifier owns an independent mutation pass; the implementer's own
mutation run (finding 6) had missed these.

## Process cost so far

- Two review rounds before any code; both changes came from the human.
- The traceability check caught its own template and the untested Spec 010
  draft on first run.
