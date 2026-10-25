/**
 * Spec 027 Amendment (2) L3 eval fixtures. Each row is a fixed case in `scripts/eval/cases.ts` (the
 * `/health`, CI rule and SQL answers the harness would read) with the expected cause, the evidence the
 * diagnosis must quote, and the runbook anchor; rows 2–5 read the eval-only playbooks of
 * `scripts/eval/playbooks.ts`. eval.test.ts runs every row through the graders with a golden answer and
 * with a broken one (SRE60, mock model, $0); `bun run --cwd packages/sre-agent eval` runs the same rows
 * against real Workers AI models, 5 runs each, locally (SRE59, not in CI). Rows with trigger "none" must
 * make no model call. The runbook grader also accepts the anchors the expected cause lists in its playbook
 * (row 1: `alarm-stuck` → `#follow-up-runs-spec-018`).
 *
 * `source`: "real" rows quote recorded values; "reconstructed" rows rebuild fields of a real incident
 * from the specs named; "constructed" rows have no recorded incident behind them. Cause ids of rows 2–5
 * are provisional until each rule's playbook (docs/runbooks/sre/<id>.md) lists them.
 * Sources: Spec 008 "R2 operations", Specs 009, 010, 011 Evidence, commit a303636, PR #98, PR #100,
 * Dev and Prod /health (2026-10-20, 2026-10-22).
 */
export const testPlanRows = [
  { id: "SRE60", type: "1 missed", scenario: "dev-stall-2026-10-02", source: "reconstructed", trigger: "dev publication: job.missed + publication.freshness", bundle: "lastRun.completedAt 2026-09-30T01:07Z, now 2026-10-02T02:00Z, running false, scheduled alarm overdue; no publication point after 01:07Z", cause: "alarm-stuck", evidence: "lastRun.completedAt; scheduled", runbook: "cloudflare-data-publisher.md#health-and-manual-run" },
  { id: "SRE60", type: "2 repeated failures", scenario: "kip-pages-two-failures", source: "constructed", trigger: "dev kip-pages: job.failures", bundle: "kipPages.lastRun ok false, status failed, error \"jira 503\" on two consecutive runs; Q-window: other jobs ok", cause: "upstream-unavailable", evidence: "kipPages.lastRun.error; Q-window", runbook: "none (reports a runbook gap)" },
  { id: "SRE60", type: "3 cost/R2", scenario: "r2-class-a-spike-2026-10-13", source: "real", trigger: "dev publication: r2.classAInvariant", bundle: "lastRun.r2.classA 8190, copiedObjectCount 35, reusedObjectCount 8150 (hourly run, 2026-10-13)", cause: "conditional-put-on-existing", evidence: "lastRun.r2.classA; copiedObjectCount", runbook: "cloudflare-data-publisher.md#r2-operations-and-cost" },
  { id: "SRE60", type: "3 cost/R2", scenario: "dev-cost-guard-trip-2026-10-21", source: "real", trigger: "dev costGuard tripped (Spec 026, monitor)", bundle: "costGuard.breaker r2ClassA 2064777 vs threshold 800000, trippedAt 2026-10-21T22:07:14.115Z; lastRun classA 1092 = copiedObjectCount 1089 + 3", cause: "month-to-date-past-incident", evidence: "costGuard.breaker.value; lastRun.r2.classA", runbook: "cloudflare-data-publisher.md#r2-operations-and-cost" },
  { id: "SRE60", type: "4 release/CI", scenario: "tag-ci-failure-v0.3.0", source: "real", trigger: "prod ci.release (newest v* tag run)", bundle: "run 39231615488 on v0.3.0: conclusion failure, job \"Unit tests\", B27 stale-claim test; Prod lastRun older than the tag", cause: "non-hermetic-test", evidence: "conclusion failure; Unit tests", runbook: "none (reports a runbook gap)" },
  { id: "SRE60", type: "control", scenario: "healthy-day-2026-10-20", source: "real", trigger: "none", bundle: "Dev lastRun ok, classA 794 = copiedObjectCount 791 + 3; main CI success", cause: "none (no model call)", evidence: "none", runbook: "none" },
  { id: "SRE60", type: "5 ok-but-wrong (v2)", scenario: "digest-en-zh-cache-pollution", source: "real", trigger: "none", bundle: "digest.lastRun ok true; en digest object holds Han-script sentences", cause: "none (no hard rule covers served text; a v2 soft invariant)", evidence: "none", runbook: "cloudflare-data-publisher.md#reading-health-digest" },
];
