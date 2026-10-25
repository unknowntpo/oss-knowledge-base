/**
 * Spec 027 SRE59/SRE60: the rows of `test/eval.cases.ts` as fixed inputs. Each case is what the
 * harness would read on its tick (`/health`, the CI rule, the SQL templates' answers), the expected
 * cause, the evidence a diagnosis must quote, and a golden answer for the L2 grader self-test.
 * Values come from the row's sources; a field no source records is left out, and reconstructed or
 * constructed values say so in `note`.
 */
import type { CiRelease, Env, Health, RuleEntry, SqlTemplate } from "../../src";

/** A required evidence item: some quote that passes the evidence check matches `pattern` (and cites `label`, if given). */
export interface RequiredEvidence {
  readonly name: string;
  readonly pattern: RegExp;
  readonly label?: string;
}

export interface GoldenAnswer {
  readonly verdict: "explained" | "unexplained" | "inconclusive";
  readonly cause: string;
  readonly confidence: "low" | "medium" | "high";
  /** Evidence by bundle item label; the id is resolved against the bundle at answer time. */
  readonly evidence: readonly { readonly label: string; readonly quote: string }[];
  readonly runbook: string | null;
  readonly ownerAction: string;
}

export interface EvalCase {
  readonly scenario: string;
  readonly env: Env;
  readonly health: Health;
  readonly ci: CiRelease;
  readonly sql: Partial<Record<SqlTemplate, unknown>>;
  /** `get_ci_run` answers by run id (the public API's fields). */
  readonly ciRuns?: Readonly<Record<string, Record<string, unknown>>>;
  readonly logTail?: string;
  readonly note: string;
  /** `null`: no rule fires, so no model call. */
  readonly expected: null | {
    readonly cause: string;
    readonly evidence: readonly RequiredEvidence[];
    /** The row's anchor (or `null`, a runbook gap); the anchors the expected cause lists are also accepted. */
    readonly runbook: string | null;
  };
  readonly golden: GoldenAnswer | null;
}

const firing = (id: string, job: string, value: unknown, threshold: unknown, since: string, runId: string | null): RuleEntry =>
  ({ id, job, status: "firing", value, threshold, since, runId });

const CI_OK: CiRelease = {
  status: "ok",
  run: { id: 39231615500, conclusion: "success", headBranch: "main", createdAt: "2026-10-20T10:00:00Z", htmlUrl: "https://github.com/unknowntpo/oss-knowledge-base/actions/runs/39231615500" },
};

const TAG_RUN = { id: 39231615488, conclusion: "failure", headBranch: "v0.3.0", createdAt: "2026-10-19T09:32:08Z", htmlUrl: "https://github.com/unknowntpo/oss-knowledge-base/actions/runs/39231615488" } as const;

export const EVAL_CASES: readonly EvalCase[] = [
  {
    scenario: "dev-stall-2026-10-02",
    env: "dev",
    note: "reconstructed: Spec 027 Example (2) bundle (Specs 010, 011 Evidence, commit a303636); scheduled is the overdue alarm left registered",
    health: {
      ok: true,
      running: false,
      scheduled: "2026-09-30T02:07:00Z (overdue, reconstructed)",
      lastRun: { ok: true, completedAt: "2026-09-30T01:07:00Z" },
      costGuard: null,
      signals: {
        status: "firing",
        rules: [
          firing("job.missed", "publication", "48.9 h", "27 h", "2026-10-01T04:07:00Z", null),
          firing("publication.freshness", "publication", "48.9 h", "27 h", "2026-10-01T04:07:00Z", null),
        ],
      },
    },
    ci: CI_OK,
    sql: { "Q-history": "no publication point after 2026-09-30T01:07Z" },
    expected: {
      cause: "alarm-stuck",
      evidence: [
        { name: "lastRun.completedAt", pattern: /2026-09-30T01:07/u },
        { name: "scheduled", pattern: /overdue/u },
      ],
      runbook: "cloudflare-data-publisher.md#health-and-manual-run",
    },
    golden: {
      verdict: "explained", cause: "alarm-stuck", confidence: "medium",
      evidence: [
        { label: "publication /health fields", quote: "\"completedAt\": \"2026-09-30T01:07:00Z\"" },
        { label: "publication /health fields", quote: "\"scheduled\": \"2026-09-30T02:07:00Z (overdue, reconstructed)\"" },
      ],
      runbook: "cloudflare-data-publisher.md#health-and-manual-run",
      ownerAction: "A manual run answers 409 while the alarm is registered; read Workers Logs for exceededMemory.",
    },
  },
  {
    scenario: "kip-pages-two-failures",
    env: "dev",
    note: "constructed: no recorded incident; two consecutive kip-pages runs fail on Jira 503 while other jobs are ok",
    health: {
      ok: true,
      kipPages: {
        revision: 7,
        lastRun: { ok: false, status: "failed", at: "2026-10-22T03:43:00.000Z", durationMs: 1210, requests: 2, jiraRequests: 2, r2: { classA: 0, classB: 1 }, error: "jira 503" },
        lastGoodAt: "2026-10-20T03:43:00.000Z",
      },
      costGuard: { mode: "monitor", status: "ok", breaker: { tripped: false } },
      signals: { status: "firing", rules: [firing("job.failures", "kip-pages", 2, 2, "2026-10-21T03:43:00.000Z", "kip-pages-2026-10-22T03-43-00-000Z")] },
    },
    ci: CI_OK,
    sql: {
      "Q-run": [{ job: "kip-pages", runId: "kip-pages-2026-10-22T03-43-00-000Z", status: "failed", durationMs: 1210, error: "jira 503" }],
      "Q-history": [
        { job: "kip-pages", runId: "kip-pages-2026-10-22T03-43-00-000Z", status: "failed", error: "jira 503" },
        { job: "kip-pages", runId: "kip-pages-2026-10-21T03-43-00-000Z", status: "failed", error: "jira 503" },
        { job: "kip-pages", runId: "kip-pages-2026-10-20T03-43-00-000Z", status: "ok", error: null },
      ],
      "Q-window": [
        { job: "publication", at: "2026-10-20T22:07:00Z", status: "ok" },
        { job: "identity-links", at: "2026-10-21T02:17:00Z", status: "ok" },
        { job: "kip-pages", at: "2026-10-21T03:43:00Z", status: "failed" },
        { job: "retention", at: "2026-10-21T10:17:00Z", status: "ok" },
      ],
    },
    expected: {
      cause: "upstream-unavailable",
      evidence: [
        { name: "kipPages.lastRun.error", pattern: /jira 503/u },
        { name: "Q-window", pattern: /ok/u, label: "Q-window" },
      ],
      runbook: null,
    },
    golden: {
      verdict: "explained", cause: "upstream-unavailable", confidence: "high",
      evidence: [
        { label: "kip-pages /health fields", quote: "\"error\": \"jira 503\"" },
        { label: "Q-window", quote: "\"job\": \"publication\", \"at\": \"2026-10-20T22:07:00Z\", \"status\": \"ok\"" },
      ],
      runbook: null,
      ownerAction: "Jira answered 503 on two runs; no runbook covers this yet (runbook gap). Wait for Jira or check its status page.",
    },
  },
  {
    scenario: "r2-class-a-spike-2026-10-13",
    env: "dev",
    note: "real: Spec 008 \"R2 operations\" (8,150 failed conditional puts an hour); hourly runs of 2026-10-13, Q-history reconstructed as the same every run",
    health: {
      ok: true,
      running: false,
      scheduled: false,
      lastRun: { ok: true, runId: "publication-2026-10-13T11-07-00-000Z", completedAt: "2026-10-13T11:08:40.000Z", copiedObjectCount: 35, reusedObjectCount: 8150, r2: { classA: 8190 } },
      costGuard: null,
      signals: { status: "firing", rules: [firing("r2.classAInvariant", "publication", 8190, "copiedObjectCount + 3 = 38", "2026-10-13T11:08:40.000Z", "publication-2026-10-13T11-07-00-000Z")] },
    },
    ci: CI_OK,
    sql: {
      "Q-run": [{ job: "publication", runId: "publication-2026-10-13T11-07-00-000Z", status: "ok", r2ClassA: 8190, copiedObjectCount: 35 }],
      "Q-history": [
        { runId: "publication-2026-10-13T11-07-00-000Z", r2ClassA: 8190, copiedObjectCount: 35 },
        { runId: "publication-2026-10-13T10-07-00-000Z", r2ClassA: 8190, copiedObjectCount: 35 },
        { runId: "publication-2026-10-13T09-07-00-000Z", r2ClassA: 8190, copiedObjectCount: 35 },
      ],
    },
    expected: {
      cause: "conditional-put-on-existing",
      evidence: [
        { name: "lastRun.r2.classA", pattern: /8190/u },
        { name: "copiedObjectCount", pattern: /copiedObjectCount/u },
      ],
      runbook: "cloudflare-data-publisher.md#r2-operations-and-cost",
    },
    golden: {
      verdict: "explained", cause: "conditional-put-on-existing", confidence: "high",
      evidence: [
        { label: "publication /health fields", quote: "\"classA\": 8190" },
        { label: "publication /health fields", quote: "\"copiedObjectCount\": 35" },
      ],
      runbook: "cloudflare-data-publisher.md#r2-operations-and-cost",
      ownerAction: "Class A is 8,190 for 35 copied objects: conditional puts on existing objects still bill; skip puts for reused objects.",
    },
  },
  {
    scenario: "dev-cost-guard-trip-2026-10-21",
    env: "dev",
    note: "real: Dev /health of 2026-10-22 (costGuard breaker, lastRun classA 1092 = copiedObjectCount 1089 + 3); Q-window rows reconstructed from that lastRun",
    health: {
      ok: true,
      running: false,
      lastRun: { ok: true, completedAt: "2026-10-21T22:07:13.057Z", copiedObjectCount: 1089, reusedObjectCount: 8150, r2: { classA: 1092, classB: 8828 } },
      costGuard: {
        mode: "monitor", status: "tripped", reason: "r2ClassA at 206.47% of 1000000 (trips at 80%)",
        checkedAt: "2026-10-21T22:07:14.115Z", metrics: { r2ClassA: 2064777 },
        breaker: { tripped: true, metric: "r2ClassA", value: 2064777, threshold: 800000, reason: "r2ClassA at 206.47% of 1000000 (trips at 80%)", trippedAt: "2026-10-21T22:07:14.115Z" },
      },
      signals: { status: "ok", rules: [] },
    },
    ci: CI_OK,
    sql: {
      "Q-history": [{ job: "cost-guard", at: "2026-10-21T22:07:14Z", status: "tripped", r2ClassA: 2064777 }],
      "Q-window": [
        { job: "publication", at: "2026-10-21T22:07:13Z", status: "ok", r2ClassA: 1092, copiedObjectCount: 1089 },
        { job: "digest", at: "2026-10-21T22:49:00Z", status: "ok", r2ClassA: 4 },
      ],
    },
    expected: {
      cause: "month-to-date-past-incident",
      evidence: [
        { name: "costGuard.breaker.value", pattern: /2064777/u },
        { name: "lastRun.r2.classA", pattern: /\b1092\b/u },
      ],
      runbook: "cloudflare-data-publisher.md#r2-operations-and-cost",
    },
    golden: {
      verdict: "explained", cause: "month-to-date-past-incident", confidence: "medium",
      evidence: [
        { label: "costGuard", quote: "\"value\": 2064777" },
        { label: "Q-window", quote: "\"r2ClassA\": 1092" },
      ],
      runbook: "cloudflare-data-publisher.md#r2-operations-and-cost",
      ownerAction: "The latest publication is normal (1092 = 1089 + 3); the month-to-date total still holds the 2026-10 spike. Consider resetting the breaker.",
    },
  },
  {
    scenario: "tag-ci-failure-v0.3.0",
    env: "prod",
    note: "real: run 39231615488 on v0.3.0, failed job \"Unit tests\" (PR #98); the log tail is reconstructed from the B27 test of commit 71b8f99^ (the run's log was not recorded); createdAt is the tag commit's time",
    health: { ok: true, running: false, lastRun: { ok: true, completedAt: "2026-10-12T01:07:00.000Z" } },
    ci: { status: "firing", run: TAG_RUN, failedJob: "Unit tests" },
    logTail: [
      "scripts/test/feature-map-site.test.ts:",
      "(fail) B27: in this repository, a stale but valid-looking Runs on fails the default page naming the spec, the value and the evidence",
      "  const production = repositoryProduction(); // the newest local v* tag",
      "1 fail",
    ].join("\n"),
    ciRuns: {
      "39231615488": { id: 39231615488, head_branch: "v0.3.0", head_sha: "unknown", status: "completed", conclusion: "failure", created_at: TAG_RUN.createdAt, html_url: TAG_RUN.htmlUrl },
      "39231615500": { id: 39231615500, head_branch: "main", head_sha: "unknown", status: "completed", conclusion: "success", created_at: "2026-10-20T10:00:00Z", html_url: CI_OK.run!.htmlUrl },
    },
    sql: {},
    expected: {
      cause: "non-hermetic-test",
      evidence: [
        { name: "conclusion failure", pattern: /failure/u },
        { name: "Unit tests", pattern: /Unit tests/u },
      ],
      runbook: null,
    },
    golden: {
      verdict: "explained", cause: "non-hermetic-test", confidence: "medium",
      evidence: [
        { label: "failed job", quote: "conclusion: failure" },
        { label: "failed job", quote: "failed job: Unit tests" },
      ],
      runbook: null,
      ownerAction: "The B27 test reads the newest local tag; make it hermetic, then re-tag. No runbook covers this (runbook gap).",
    },
  },
  {
    scenario: "healthy-day-2026-10-20",
    env: "dev",
    note: "real: Dev /health of 2026-10-20 (lastRun ok, classA 794 = copiedObjectCount 791 + 3), main CI success",
    health: {
      ok: true,
      running: false,
      lastRun: { ok: true, completedAt: "2026-10-19T22:07:12.000Z", copiedObjectCount: 791, r2: { classA: 794 } },
      costGuard: { mode: "monitor", status: "ok", breaker: { tripped: false } },
      signals: { status: "ok", rules: [{ id: "job.missed", job: "publication", status: "ok" }] },
    },
    ci: CI_OK,
    sql: {},
    expected: null,
    golden: null,
  },
  {
    scenario: "digest-en-zh-cache-pollution",
    env: "dev",
    note: "real: PR #100, Spec 014 D96; no hard rule covers served text (a v2 soft invariant)",
    health: {
      ok: true,
      digest: { enabled: true, lastRun: { ok: true, completedAt: "2026-10-19T22:49:00.000Z" } },
      costGuard: { mode: "monitor", status: "ok", breaker: { tripped: false } },
      signals: { status: "ok", rules: [{ id: "digest.freshness", job: "digest", status: "ok" }] },
    },
    ci: CI_OK,
    sql: {},
    expected: null,
    golden: null,
  },
];
