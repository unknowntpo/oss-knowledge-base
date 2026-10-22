/**
 * Spec 027 scenario evals, [pending] until slice 2 runs them. Each row is one real incident,
 * replayed from recorded tool outputs (no network). Since Amendment (1) a diagnosis starts only when a
 * deterministic rule fires (`trigger`): a Spec 028 rule, a Spec 026 cost-guard trip, or the harness's
 * `ci.release` rule. With a trigger the agent must name the root cause and cite the runbook section (or
 * report that none exists); without one it makes no model call. Recorded outputs of past incidents are
 * reconstructed from the specs' evidence; slice 2 saves them as fixture files. Sources: Spec 008
 * "R2 operations", Spec 011 Evidence, PR #98, PR #100, Dev and Prod /health (2026-10-20, 2026-10-22).
 */
export const testPlanRows = [
  { id: "SRE20", scenario: "r2-class-a-spike", trigger: "dev publication: Class A above baseline (Spec 028)", recorded: "Dev /health lastRun.r2.classA 8190, copiedObjectCount 35, reusedObjectCount 8150 (hourly run, 2026-10-13)", rootCause: "conditional puts sent for objects that already exist (Class A per reused object)", runbook: "cloudflare-data-publisher.md#r2-operations-and-cost", diagnosis: "yes" },
  { id: "SRE20", scenario: "dev-silent-stall", trigger: "dev publication: missed schedule (Spec 028)", recorded: "Dev /health lastRun.completedAt 2026-09-30T01:07Z, now 2026-10-02T02:00Z, running false, followUp null", rootCause: "stall: newest publication 49 h old, past the 27 h boundary (Specs 010, 011, 018)", runbook: "cloudflare-data-publisher.md#health-and-manual-run", diagnosis: "yes" },
  { id: "SRE20", scenario: "tag-ci-failure-b27", trigger: "ci.release (harness rule)", recorded: "gh run 39231615488 on v0.3.0: conclusion failure, job \"Unit tests\" failed, B27 stale-claim test; Prod lastRun older than the tag", rootCause: "non-hermetic test read the newest local v* tag, so the tag build failed and Prod deploy was skipped", runbook: "none (reports a runbook gap)", diagnosis: "yes" },
  { id: "SRE20", scenario: "dev-cost-guard-trip-2026-10-21", trigger: "dev costGuard tripped (Spec 026, monitor)", recorded: "Dev /health 2026-10-22: costGuard.breaker r2ClassA 2064777 vs threshold 800000, trippedAt 2026-10-21T22:07:14.115Z; lastRun classA 1092 = copiedObjectCount 1089 + 3", rootCause: "month-to-date Class A is the 2026-10-02..13 incident; today's run holds the invariant; nothing paused under monitor (ownerAction: Spec 026 open Decision 1, no reset by the agent)", runbook: "cloudflare-data-publisher.md#r2-operations-and-cost", diagnosis: "yes" },
  { id: "SRE21", scenario: "healthy-day (control)", trigger: "none", recorded: "Dev /health 2026-10-20T09:33Z: lastRun ok, classA 794 = copiedObjectCount 791 + 3; Prod ok, classA 381 = 378 + 3; main CI success", rootCause: "none", runbook: "none", diagnosis: "no" },
  { id: "SRE26", scenario: "digest-en-zh-cache-pollution (no rule fires)", trigger: "none", recorded: "Dev /health digest.lastRun ok true; en digest object holds Han-script card sentences", rootCause: "not diagnosed: no deterministic rule covers served text (a gap; a content rule is a follow-up spec)", runbook: "cloudflare-data-publisher.md#reading-health-digest", diagnosis: "no" },
];
