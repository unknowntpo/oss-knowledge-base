/**
 * Spec 027 SRE59/SRE60: eval-only playbooks for the firing rules of eval rows 2–5, which have no
 * `docs/runbooks/sre/<id>.md` yet. Without them only `unknown` could pass for those rows (B35), and the
 * eval could not tell models apart. Each lists the row's expected cause next to plausible distractors;
 * a cause with no runbook link is a runbook gap (`runbook: null`). They are fixtures, not production
 * playbooks: the Worker never sees them, and `check:playbooks` does not scan them.
 */
import type { MarkdownFile } from "../../src/playbook";

const SECTIONS = (statement: string, evidence: string) => `## Statement

${statement}

## Why

Eval fixture (Spec 027 SRE59): a provisional cause list until this rule's playbook lands in docs/runbooks/sre/.

## Evidence

${evidence}

## Hard check

The rule fired; the harness put its entry first in the bundle.

## Judgment guidance

- Quote only the bundle: every evidence quote is copied verbatim from the item it cites.
- Pick the first cause whose distinguishing evidence is in the bundle (verdict \`explained\`); otherwise answer \`unknown\`.
- With \`unknown\`, answer verdict \`inconclusive\` when the bundle lacks the evidence that would decide the cause (name the missing fields in \`ownerAction\`), and \`unexplained\` when the cited evidence rules out every listed cause.
- A cause without a runbook link is a runbook gap: answer \`runbook: null\` and say so in \`ownerAction\`.
`;

const R2 = "[R2 operations and cost](../cloudflare-data-publisher.md#r2-operations-and-cost)";

export const EVAL_PLAYBOOKS: readonly MarkdownFile[] = [
  {
    path: "docs/runbooks/sre/job.failures.md",
    text: `# Invariant playbook: \`job.failures\`

${SECTIONS("A job's consecutive runs ended `ok: false`.", "The job's `/health` `lastRun` (`ok`, `status`, `error`, `durationMs`), Q-run, Q-history and Q-window.")}
## Causes, in order

| # | Cause id | Cause | Distinguishing evidence | Runbook |
| --- | --- | --- | --- | --- |
| 1 | \`cost-guard-paused\` | The cost guard paused the job | \`costGuard.mode: "enforce"\` and \`breaker.tripped: true\` | [Reset the breaker](../cloudflare-data-publisher.md#reset-the-breaker) |
| 2 | \`upstream-unavailable\` | An upstream (GitHub or Jira) answered 5xx or a rate limit | \`lastRun.error\` names an upstream status (for example "jira 503"), runs end early, and other jobs in Q-window are ok | none: a runbook gap |
| 3 | \`deploy-broke-job\` | A deploy broke the job | the errors are code exceptions, and they start right after a deploy | [Roll back](../cloudflare-data-publisher.md#roll-back) |
| 4 | \`platform-limit\` | The Worker hit a platform limit | \`exceededMemory\`, \`exceededCpu\` or a subrequest limit in the error, other jobs failing in Q-window too | [Failure and rollback](../cloudflare-data-publisher.md#failure-and-rollback) |
| 5 | \`unknown\` | Unknown | none of the above is supported by the bundle | Say so and list the missing evidence |
`,
  },
  {
    path: "docs/runbooks/sre/r2.classAInvariant.md",
    text: `# Invariant playbook: \`r2.classAInvariant\`

${SECTIONS("A publication run's R2 Class A operations stay at `copiedObjectCount + 3`.", "The publication's `lastRun.r2.classA`, `copiedObjectCount`, `reusedObjectCount`, Q-run and Q-history.")}
## Causes, in order

| # | Cause id | Cause | Distinguishing evidence | Runbook |
| --- | --- | --- | --- | --- |
| 1 | \`conditional-put-on-existing\` | Conditional puts on objects that already exist still bill a Class A each | \`r2.classA\` ≈ \`copiedObjectCount + reusedObjectCount\`, far above \`copiedObjectCount + 3\`, on every run | ${R2} |
| 2 | \`large-publication\` | A legitimately large publication | \`copiedObjectCount\` itself is large and \`r2.classA\` = \`copiedObjectCount + 3\` | ${R2} |
| 3 | \`retry-loop\` | Retries or follow-ups ran the publication many times | Q-history shows several runs for one scheduled run | [Follow-up runs](../cloudflare-data-publisher.md#follow-up-runs-spec-018) |
| 4 | \`unknown\` | Unknown | none of the above is supported by the bundle | Say so and list the missing evidence |
`,
  },
  {
    path: "docs/runbooks/sre/tripped.md",
    text: `# Invariant playbook: \`tripped\` (cost guard)

${SECTIONS("The cost guard's breaker is not tripped.", "`costGuard` (`mode`, `metrics`, `breaker`), Q-history and Q-window of the jobs around `trippedAt`.")}
## Causes, in order

| # | Cause id | Cause | Distinguishing evidence | Runbook |
| --- | --- | --- | --- | --- |
| 1 | \`current-spike\` | A job is spending R2 Class A now | the runs around \`trippedAt\` have \`r2.classA\` far above \`copiedObjectCount + 3\` | ${R2} |
| 2 | \`month-to-date-past-incident\` | The month-to-date metric still holds an earlier incident; current runs are normal | \`breaker.value\` far above the threshold while the latest runs have \`r2.classA\` = \`copiedObjectCount + 3\` | ${R2}, [Reset the breaker](../cloudflare-data-publisher.md#reset-the-breaker) |
| 3 | \`threshold-misconfigured\` | The threshold is below normal monthly use | normal runs every day add up past the threshold with no incident in the month | [Read \`/health\`](../cloudflare-data-publisher.md#read-health) |
| 4 | \`unknown\` | Unknown | none of the above is supported by the bundle | Say so and list the missing evidence |
`,
  },
  {
    path: "docs/runbooks/sre/ci.release.md",
    text: `# Invariant playbook: \`ci.release\`

${SECTIONS("The newest release tag's CI run succeeded.", "The CI run (`conclusion`, failed job, log tail) and, through `get_ci_run`, any run by id.")}
## Causes, in order

| # | Cause id | Cause | Distinguishing evidence | Runbook |
| --- | --- | --- | --- | --- |
| 1 | \`non-hermetic-test\` | A test depends on the environment (local git tags, clock, network), so the tag build differs from \`main\` | a test failure in "Unit tests" whose test reads environment state such as the newest local tag | none: a runbook gap |
| 2 | \`real-regression\` | A code change broke a test | a failing assertion on behavior the release changed | [Roll back](../cloudflare-data-publisher.md#roll-back) |
| 3 | \`infra-flake\` | The runner or the network failed | the job was cancelled or timed out, with no failing test | none: a runbook gap |
| 4 | \`unknown\` | Unknown | none of the above is supported by the bundle | Say so and list the missing evidence |
`,
  },
];
