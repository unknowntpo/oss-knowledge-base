/**
 * Spec 028 slice 1: the rule thresholds of `/health.signals`. The single source for
 * `signals.test.ts` and for the test-plan table in docs/specs/028-observability-signals/spec.md
 * (`bun run docs:test-plan`). Each row's `input` is built into a record and a history by the test
 * (a row without a builder fails the test); `status` is the expected entry status, or `no entry`.
 */
export const testPlanRows = [
  { id: "OB5", rule: "publication.freshness", input: "24 h 30 min", status: "ok" },
  { id: "OB5", rule: "publication.freshness", input: "24 h 30 min 1 s", status: "warn" },
  { id: "OB5", rule: "publication.freshness", input: "27 h", status: "warn" },
  { id: "OB5", rule: "publication.freshness", input: "27 h 0 min 1 s", status: "firing" },
  { id: "OB6", rule: "source.success", input: "jira failed on 10-19 only", status: "warn" },
  { id: "OB6", rule: "source.success", input: "jira failed on 10-19 and 10-20", status: "firing" },
  { id: "OB6", rule: "source.success", input: "jira failed twice on 10-20 (one day)", status: "warn" },
  { id: "OB7", rule: "publication.pollTruncated", input: "true since 47 h 59 min", status: "warn" },
  { id: "OB7", rule: "publication.pollTruncated", input: "true since 48 h 0 min 1 s", status: "firing" },
  { id: "OB8", rule: "r2.classAInvariant", input: "824 / 821 (Example)", status: "ok" },
  { id: "OB8", rule: "r2.classAInvariant", input: "825 / 821", status: "firing" },
  { id: "OB8", rule: "r2.classAInvariant", input: "8,190 / 35 (2026-10-13 shape)", status: "firing" },
  { id: "OB9", rule: "digest.freshness", input: "48 h", status: "ok" },
  { id: "OB9", rule: "digest.freshness", input: "48 h 0 min 1 s", status: "firing" },
  { id: "OB9", rule: "digest.freshness", input: "digest disabled", status: "no entry" },
  { id: "OB10", rule: "digest.rejections", input: "9, median 2", status: "ok" },
  { id: "OB10", rule: "digest.rejections", input: "10, median 3", status: "firing" },
  { id: "OB10", rule: "digest.rejections", input: "10, median 4", status: "ok" },
  { id: "OB10", rule: "digest.rejections", input: "40, 2 previous points", status: "unknown" },
  { id: "OB24", rule: "job.missed (kip-pages, daily)", input: "last run 24 h 30 min ago", status: "ok" },
  { id: "OB24", rule: "job.missed (kip-pages, daily)", input: "24 h 30 min 1 s", status: "warn" },
  { id: "OB24", rule: "job.missed (kip-pages, daily)", input: "27 h 0 min 1 s", status: "firing" },
  { id: "OB24", rule: "job.missed (embedding)", input: "pending 120, last run 3 h 0 min 1 s ago", status: "firing" },
  { id: "OB24", rule: "job.missed (embedding)", input: "pending 0, last run 30 h ago", status: "ok" },
  { id: "OB24", rule: "job.missed (identity-links)", input: "flag unset", status: "no entry" },
  { id: "OB24", rule: "job.missed (identity-links)", input: "flag set, no run yet", status: "unknown" },
  { id: "OB25", rule: "job.failures", input: "current failed, previous ok", status: "warn" },
  { id: "OB25", rule: "job.failures", input: "current and previous failed", status: "firing" },
  { id: "OB25", rule: "job.failures", input: "current failed, no previous point", status: "warn" },
  { id: "OB25", rule: "job.failures (identity-links)", input: "current no-input (ok)", status: "ok" },
  { id: "OB26", rule: "job.duration", input: "2 × median exactly", status: "ok" },
  { id: "OB26", rule: "job.duration", input: "2 × median + 1 ms", status: "warn" },
  { id: "OB26", rule: "job.duration", input: "2 previous points only", status: "unknown" },
  { id: "OB26", rule: "job.duration (retention)", input: "8 min (80 % of 10 min)", status: "firing" },
  { id: "OB26", rule: "job.duration (digest, no wall budget)", input: "60 × median", status: "warn" },
  { id: "OB27", rule: "job.r2ClassA", input: "3,000, median 1,000", status: "ok" },
  { id: "OB27", rule: "job.r2ClassA", input: "3,001, median 1,000", status: "warn" },
  { id: "OB27", rule: "job.r2ClassA", input: "900, median 100", status: "ok" },
  { id: "OB27", rule: "job.r2ClassA (publication 2026-10-13 shape)", input: "8,190, median 800", status: "firing" },
  { id: "OB27", rule: "job.r2ClassA (cost-guard, r2Counted 0)", input: "any", status: "no entry" },
] as const;

export type SignalCase = (typeof testPlanRows)[number];
