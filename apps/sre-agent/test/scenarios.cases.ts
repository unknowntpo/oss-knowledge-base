/**
 * Spec 027 scenario evals, [pending] until slice 2 runs them. Each row is one real incident,
 * replayed from recorded tool outputs (no network): the agent must name the root cause, cite the
 * runbook section (or report that none exists), and either propose one issue or stay quiet.
 * Recorded outputs of past incidents are reconstructed from the specs' evidence; slice 2 saves them
 * as fixture files. Sources: Spec 008 "R2 operations", Spec 011 Evidence, PR #98, PR #100, Dev and Prod /health.
 */
export const testPlanRows = [
  { id: "SRE20", scenario: "r2-class-a-spike", recorded: "Dev /health lastRun.r2.classA 8190, copiedObjectCount 35, reusedObjectCount 8150 (hourly run, 2026-10-13)", rootCause: "conditional puts sent for objects that already exist (Class A per reused object)", runbook: "cloudflare-data-publisher.md#r2-operations-and-cost", issue: "yes" },
  { id: "SRE20", scenario: "dev-silent-stall", recorded: "Dev /health lastRun.completedAt 2026-09-30T01:07Z, now 2026-10-02T02:00Z, running false, followUp null", rootCause: "stall: newest publication 49 h old, past the 27 h boundary (Specs 010, 011, 018)", runbook: "cloudflare-data-publisher.md#health-and-manual-run", issue: "yes" },
  { id: "SRE20", scenario: "tag-ci-failure-b27", recorded: "gh run 39231615488 on v0.3.0: conclusion failure, job \"Unit tests\" failed, B27 stale-claim test; Prod lastRun older than the tag", rootCause: "non-hermetic test read the newest local v* tag, so the tag build failed and Prod deploy was skipped", runbook: "none (reports a runbook gap)", issue: "yes" },
  { id: "SRE20", scenario: "digest-en-zh-cache-pollution", recorded: "Dev /health digest.lastRun ok true; en digest object holds Han-script card sentences", rootCause: "the en sentence cache was seeded from zh-Hant objects with the same inputHash", runbook: "cloudflare-data-publisher.md#reading-health-digest", issue: "yes" },
  { id: "SRE21", scenario: "healthy-day (control)", recorded: "Dev /health 2026-10-20T09:33Z: lastRun ok, classA 794 = copiedObjectCount 791 + 3; Prod ok, classA 381 = 378 + 3; main CI success", rootCause: "none", runbook: "none", issue: "no" },
];
