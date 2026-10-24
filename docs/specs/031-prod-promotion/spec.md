# Spec 031: Prod promotion as a checked pipeline stage

Status: Draft (owner intent 2026-10-24: encode Prod promotion and the workflow itself as checked artifacts; OD1–OD6 open)
Date: 2026-10-24
Traceability: enforced
Builds on: `docs/process/workflow.md` (merge authority, "Separate merge from enable", operator sequences), `docs/operations/release.md` (R1–R6, `v*` tags), ADR-0008, Specs 014 (D34, D102), 020 (B27 status board), 026 (cost guard), 028 (OB20)

## Intent

The owner wants to program the whole project, including the workflow and
agent interactions, not only the product. Today Prod promotion is the one
stage still run from prose: an agent or the owner reads several specs,
runbooks and `/health` by hand to decide whether a flag may go on in Prod and
when a `v*` tag may be pushed.

Observable outcome: for any feature and any candidate tag, one read-only
command prints "ready for Prod" or the exact gates that block it, computed
from evidence (CI, Dev `/health`, committed eval results, the cost guard,
deploy windows, recorded owner decisions). The merge-authority rules become
a policy file that CI evaluates on every PR. Owner decisions stay owner
decisions; the machine only proves that the other gates hold.

## Evidence

- Prod enable gates are scattered across specs as prose: Spec 014 D34 and
  D102 (eval thresholds), the runbook's "no `osskb-digest-prod` gateway",
  Spec 028 OB20 ("after 7 days on Dev"), Spec 026 "Dev monitor → Dev
  enforce → Prod". No command collects them.
- PR #110 (open) lists its own pre-tag conditions by hand: Spec 019
  decision 8 (terms check) not recorded, and "tag no earlier than
  2026-10-24 10:20 UTC". Nothing stops a tag that violates either.
- `v0.3.0` (`987162a`) was tagged on a commit whose CI then failed (Spec 020
  B27 test): the tag was pushed before the evidence existed.
- The Dev deploy-avoid windows (21:50–23:05, 02:05–02:30, 03:30–03:55,
  10:10–10:30 UTC) live only in prose. Dev's `IDENTITY_BACKFILL_CRON`
  `23 1 * * *` (#140, 2026-10-23) falls in none of them: the list has
  already drifted from the crons.
- Merge authority is judged by reading `workflow.md`; the verifier's
  "passed the final commit" is checked by eye against the head SHA.

## Example

Captured 2026-10-24 00:40 UTC. `main` = `a68623c`, CI `success`; newest tag
`v0.3.1` (`71b8f99`).

**Release candidate `v0.3.2` = `main`.** `git diff v0.3.1 main --
apps/data-publisher-worker/wrangler.production.jsonc` shows two changes:

| Change | Manifest | Gates | Verdict |
| --- | --- | --- | --- |
| `observability {enabled: true, head_sampling_rate: 1}` (#99, Workers Logs) | `workers-logs` (no user-visible change; declared cost delta $0, to be measured in slice 1) | ci pass; budget: tripped, but delta $0 passes under OD6 (a) | ready |
| `SRE_AGENT: "off"` (#128) | `sre-agent` | value is in the manifest's `offValues` → no runtime change, not evaluated | n/a |

**Deploy windows vs crons.** The documented Dev windows (21:50–23:05,
02:05–02:30, 03:30–03:55, 10:10–10:30 UTC) miss Dev's
`IDENTITY_BACKFILL_CRON` `23 1 * * *` (01:23 UTC, enabled by #140). The
owner's own loop already avoids 01:20–01:30, so the real list exists only in
someone's head. With Behavior 6 the windows test fails on this cron until
`deploy-windows.json` gains `01:20–01:30`.

Release gates: window — 00:40 is outside every window → pass. Verdict:
**ready** (the tag itself still needs the owner under OD1).

**Same candidate after PR #110 merges** (`GITHUB_REVIEWS=metadata@2`,
`PEOPLE_ACTIVITY=log@1` on Prod): feature `contributor-data` adds an owner
gate (Spec 019 decision 8, no "Decided" line → fail) and a window gate with
`notBefore 2026-10-24T10:20Z` (→ fail at 00:40). Verdict: **not ready**,
blocked by `019-D8`, `notBefore`.

**Feature `topic-digest` (Spec 014), Prod enable** — proposed manifest
`docs/specs/014-topic-digest/promotion.json`:

```json
{
  "feature": "topic-digest",
  "spec": "014",
  "flags": {
    "development": {"DIGEST_ENABLED": "true", "DIGEST_CRON": "47 22 * * *"},
    "production": {"DIGEST_ENABLED": "true", "DIGEST_GATEWAY_ID": "osskb-digest-prod"}
  },
  "offValues": ["", "off"],
  "gates": [
    {"id": "ci", "kind": "ci"},
    {"id": "soak", "kind": "soak", "days": 7, "job": "digest"},
    {"id": "D34", "kind": "eval", "file": "docs/specs/014-topic-digest/eval/latest.json", "require": "golden.pass"},
    {"id": "D102", "kind": "eval", "file": "docs/specs/014-topic-digest/eval/latest.json", "require": "translation.pass"},
    {"id": "gateway", "kind": "attest", "evidence": "docs/runbooks/cloudflare-data-publisher.md#topic-digest-prod"},
    {"id": "budget", "kind": "budget"},
    {"id": "first-enable", "kind": "owner", "reason": "first Prod enable of a user-visible page"}
  ]
}
```

Evidence and result:

| Gate | Evidence (real) | Result |
| --- | --- | --- |
| ci | `a68623c` CI `success` | pass |
| soak | `DIGEST_ENABLED` on Dev since `c64b998` (2026-10-08), daily cron since `9789952` (2026-10-14) = 9 days; Dev `/health.digest.lastRun` ok, `completedAt` 2026-10-23T22:48:51Z | pass |
| D34 | `topic-digest-labels.v0.json`: 0 important, 5 negatives ("important threads pending human labels"); no eval file | fail (pending labels) |
| D102 | no sentence with `translationErrors` | fail (pending labels) |
| gateway | runbook: "no `osskb-digest-prod` gateway" | fail |
| budget | Dev `/health.costGuard`: `tripped`, `r2ClassA at 206.47% of 1000000`, since 2026-10-21T22:07Z (account-wide); Prod has no `costGuard` | fail |
| first-enable | no owner decision | fail |

Verdict: **not ready**, blocked by D34, D102, gateway, budget, first-enable.
The output names each blocker and its evidence; it does not need a human to
re-read Spec 014's 2,500 lines.

## Simplification review

1. **Question.** Who needs it: the owner (one answer instead of a tour of
   specs) and agents (a gate they cannot argue past). Rejected: a promotion
   dashboard (the Spec 020 status board and the PR body already show state),
   a release bot service, Prod deploy windows separate from Dev's.
2. **Delete.** No new runtime, store, or Worker route: evidence already
   exists in `/health`, CI, git and committed files. No per-environment
   manifest files: one per feature. No agent role files in this spec: roles
   are already defined by who may perform each policy action. The
   hand-written window list is replaced by one file checked against the
   crons. Gate kinds are a closed set of eight; a new kind needs a spec
   change.
3. **Simplify.** The checker is one pure function `evaluate(manifest,
   evidence, now)` plus a thin I/O adapter; tests drive the function with a
   case file of real snapshots. "Unknown" is never "pass".
4. **Shorten the cycle.** Slice 1 runs locally against live Dev/Prod
   `/health` in seconds and answers the v0.3.2 question on its own.
5. **Automate last.** Opening enable PRs, gating the tag in CI, and
   rollback come after the read-only checker has been right on real
   releases (slices 3–5), and only at the autonomy the owner picks (OD1).

## Behavior

1. **Manifest.** Each feature that has, or will have, a flag on Prod has
   `docs/specs/NNN-*/promotion.json`: `feature`, `spec`, `flags` per
   environment (the values that mean "on"), `offValues`, and `gates`. A
   Prod config change not covered by any manifest is itself a blocker
   ("unmanifested Prod change").
2. **Gate kinds** (closed set; each names its evidence source):
   - `ci`: the latest `ci.yml` run on the candidate SHA is `success`.
   - `soak`: days since the Dev flag value first landed on `main` (git) are
     at least `days`, and Dev `/health` shows the job's last run ok and no
     `firing` signal for it.
   - `eval`: a committed results file produced by the spec's eval command
     has `require` true and an eval revision equal to the current one.
   - `budget`: the cost guard (Dev's account-wide check until Prod has one)
     is not tripped, and the feature's declared monthly cost delta fits the
     remaining $5 overage budget (Spec 026).
   - `window`: the planned deploy instant is outside every window in
     `docs/process/deploy-windows.json` and not before `notBefore`.
   - `upstream`: the feature's measured Dev upstream requests per day
     (GitHub, dev@, Jira). Any increase over the current Prod rate
     requires an owner gate; the checker fails the manifest otherwise.
   - `owner`: a "Decided (owner, YYYY-MM-DD)" line at the referenced spec
     anchor. Agents never write such a line (see OD2 for its strength).
   - `attest`: an evidence link that must resolve (file anchor or run URL);
     the verdict labels it "attested, not measured".
3. **Verdict.** Ready only if every gate passes. A missing or unreadable
   source is `unknown` and blocks. Output: JSON (`ready`, per-gate status
   and evidence) and one summary line; exit 0 ready, 1 not ready, 2 checker
   error.
4. **Release readiness.** For a candidate tag, evaluate every manifest whose
   Prod flag values differ between the newest `v*` tag and the candidate
   (values in `offValues` equal unset), plus the release `ci` and `window`
   gates.
5. **Read-only.** The checker performs only GETs: `/health` of Dev and Prod,
   `gh` reads of this repository's runs and PRs, git, and local files. It
   never calls `POST /run` or any POST, never writes R2, never tags or
   deploys. Upstream sources are never contacted.
6. **Deploy windows.** `docs/process/deploy-windows.json` is the single
   list. A test fails when an enabled cron in either `wrangler.*.jsonc`
   falls outside every window, unless the file lists it as exempt with a
   reason.
7. **Merge-authority policy.** `docs/process/policy.json` encodes the core
   categories of `workflow.md` as rules over changed paths and diff content
   (`wrangler.production.jsonc`, migrations, secrets scripts,
   `.github/workflows/**`, new public URLs, cost caps, …) and the docs-only
   rule. `check:merge-authority` prints `core` (with the matching rule),
   `docs-only`, or `low-risk-candidate` (with the conditions the verifier
   must still attest). No match proven means `core`.
8. **Verifier verdict as data.** The verifier's PR comment carries a fenced
   JSON block: head SHA, per-ID verdicts. The policy check treats a verdict
   whose SHA is not the head (except the clean merge-of-`main` case) as
   absent.
9. **Prose follows policy.** The merge-authority table in `workflow.md` is
   rendered from `policy.json` between markers, like the test plan; a check
   fails when they disagree.

## Automation boundary

Default proposed (OD1 decides):

| Step | Who |
| --- | --- |
| Compute readiness, post it in the PR and on the release draft | agent / CI |
| Open the Prod-enable PR (flag diff, operator sequence, release-note line) from the manifest | agent |
| Pick a tag time outside windows and after `notBefore` | agent |
| Push the `v*` tag | owner (or agent, with deploy held by OD2) |
| Post-deploy smoke: `verify:health --target prod` + the feature's checks | CI |
| Rollback on a failed smoke | per OD3 |
| First Prod enable of a user-visible feature; budget-impacting change; privacy or terms; upstream traffic increase; new public surface | owner, always |

## Acceptance

Each item: precondition → action → observable result → evidence.

### Behavior
- PP1: [pending] given the Example's `topic-digest` manifest and evidence snapshot, `evaluate` returns not ready with blockers exactly D34, D102, gateway, budget, first-enable, each with its evidence string.
- PP2: [pending] given the `v0.3.1` and `a68623c` Prod configs, release readiness evaluates `workers-logs` only, skips `SRE_AGENT: "off"` as an off value, and returns ready at 2026-10-24T00:40Z.
- PP3: [pending] given the same candidate plus #110's flags, release readiness returns not ready with blockers `019-D8` and `notBefore`.
- PP4: [pending] a Prod config change with no manifest yields the blocker "unmanifested Prod change" naming the key.
- PP5: [pending] `check:merge-authority` on the recorded file lists of #110, #120, #66 and a docs-only PR returns `core` (production config), `low-risk-candidate`, `core` (public surface) and `docs-only`.
- PP6: [pending] the merge-authority table in `workflow.md` and `policy.json` agree; editing one without the other fails the check.

### Failure and retry
- PP7: [pending] a gate whose source is unreachable (Dev `/health` 5xx, `gh` error) is `unknown` and the verdict is not ready, exit 1.
- PP8: [pending] an eval file whose revision is older than the current eval revision fails its gate as stale.
- PP9: [pending] a soak gate fails when the job's last Dev run failed or its signal is `firing`, even if the day count is met.
- PP10: [pending] a manifest with an unknown gate kind, a missing field, or an `upstream` increase without an `owner` gate exits 2 and names the problem.
- PP11: [pending] a planned instant inside a window (e.g. 22:10Z) or before `notBefore` fails the window gate with the window's name.
- PP12: [pending] a verifier JSON block whose SHA differs from the head (not a clean `main` merge) counts as no verdict.
- PP13: [pending] an enabled cron outside every deploy window fails the windows test; Dev `23 1 * * *` is the recorded case.
- PP14: [pending] a run of the checker issues no POST and no request outside the Dev/Prod Worker hosts and the GitHub API for this repository (recorded with a fetch spy).

### Budget
- PP15: [measure] one release-readiness run makes at most 2 `/health` GETs and at most 10 GitHub API reads, and finishes in under 30 s (`bun run promotion:check --release v0.3.2 --trace`).

### Observability
- PP16: [deploy] after slice 4, a failed post-deploy smoke shows in the `deploy-production` job summary with the failing check and the rollback taken, and in the PR or release that triggered it.

## Rollout (slices)

1. **Read-only checker for one feature and one release.** `promotion.json`
   for `topic-digest`, `workers-logs`, `sre-agent`; pure `evaluate` with a
   case file from the Example; `bun run promotion:check` (feature and
   `--release`); `deploy-windows.json` with the cron test. Useful alone:
   answers "can v0.3.2 ship and what blocks the digest" from evidence. PP1–PP4,
   PP7–PP11, PP13–PP15.
2. **Merge-authority policy.** `policy.json`, `check:merge-authority`
   (advisory CI status first), verifier JSON block, rendered table in
   `workflow.md`. PP5, PP6, PP12.
3. **Agent-opened Prod-enable PRs.** The agent generates the enable PR from
   a ready manifest: flag diff, operator sequence, readiness verdict.
   Owner merges.
4. **Tag gate and smoke.** A `promotion-gate` job before `deploy-production`
   reruns release readiness and fails closed; post-deploy smoke; rollback
   per OD3. PP16.
5. **Autonomy level per OD1**, only after slices 1–4 judged at least two real
   releases correctly.

## Owner decisions

- **OD1 — Autonomy default.** (a) Agent computes readiness, opens PRs and
  prepares the tag; the owner approves each Prod deploy. (b) As (a), but
  features whose manifest has no `owner` gate deploy without the owner.
  (c) Checker advisory only; the owner tags as today.
  **Recommend (a)** now, (b) after two releases judged correctly.
- **OD2 — Where the owner's approval lives.** (a) Required reviewer on the
  GitHub `production` environment: anyone may push the tag, the deploy waits
  for the owner's click, and the approval is recorded. (b) The owner pushes
  every tag (today). (c) Approval of a release PR. **Recommend (a)**; it is a
  permission change the owner makes. Caveat found in the Example: agents act
  through the owner's GitHub account (#99 shows `mergedBy: unknowntpo`, no
  review), so neither a merge nor a "Decided" line proves an owner act. (a)
  is the only option the agent harness can be told never to perform.
- **OD3 — Rollback.** (a) Automatic: on a failed smoke, redeploy the
  previous accepted tag's artifact (no `/run`, no R2 write), then notify.
  (b) Agent opens the rollback; owner approves. (c) Manual.
  **Recommend (a)** for Pages and Worker code: it restores a state the owner
  already accepted. Data rollbacks stay manual (ADR-0010 pointers).
- **OD4 — Always-owner gates.** Proposed: first Prod enable of a
  user-visible feature, any cost-delta above $0, privacy or terms, any
  upstream request increase, new public surface. Alternative: only privacy,
  public surface and upstream. **Recommend the proposed list**; upstream
  protection is a hard owner value.
- **OD5 — Default soak** for features whose spec sets none. (a) 7 days on
  Dev with no `firing` signal (from Spec 028 OB20). (b) 3 days. (c) None.
  **Recommend (a).**
- **OD6 — Budget gate while the cost guard is tripped** (Dev is tripped
  today: Class A 206 % since 2026-10-21). (a) Block only enables with a
  cost delta above $0. (b) Block every Prod promotion. **Recommend (a)**;
  (b) would block a code-only fix.

## Non-goals

- Implementing Prod enables of any feature (each stays its own PR).
- Changing CI deploy triggers in slices 1–3.
- Agent role prompt files; deciding who may self-merge beyond `workflow.md`.
- Data rollback or R2 pointer changes.
