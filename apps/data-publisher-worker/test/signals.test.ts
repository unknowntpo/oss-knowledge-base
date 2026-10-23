/**
 * Spec 028 slice 1: the pure parts of the observability signals — the flag, `runId`, the data point,
 * the trend rules, the state rules and `/health.signals` — and the recorder over fake `SIGNALS` and
 * `ANALYTICS_SQL` bindings. Worker wiring is in `signals-worker.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import { testPlanRows, type SignalCase } from "./signals.cases";
import {
  costGuardSignalRun,
  digestSignalRun,
  embeddingSignalRun,
  identityLinksSignalRun,
  kipPagesSignalRun,
  metricPoint,
  publicationSignalRun,
  retentionSignalRun,
  runIdFor,
  type SignalRun,
} from "../src/signals/point";
import { resolveSignalsMode, SIGNAL_THRESHOLDS, WALL_BUDGET_MS } from "../src/signals/profile";
import { KIP_PAGES_CRON_WALL_MS } from "../src/kip-pages/run";
import { signalsHealth, trendRules, type History, type HistoryPoint, type RuleEntry } from "../src/signals/rules";
import { historyQuery, SignalRecorder, type AnalyticsSql } from "../src/signals/recorder";

const H = 3_600_000;
const M = 60_000;
const S = 1_000;
const NOW = Date.parse("2026-10-20T23:45:00.000Z");

/** The Example's Dev `lastRun` (2026-10-20, Spec 028 Example). */
const EXAMPLE_LAST_RUN = {
  ok: true as const, environment: "development" as const, completedAt: "2026-10-20T22:07:19.086Z",
  publicationSetId: "github-2026-10-20T22-07-00-000Z", feedReleaseId: "2026-10-20T22-07-00-000Z", searchRevision: "feed-2026-10-20T22-07-00-000Z",
  inputEventCount: 10, logicalEventCount: 10, pageCount: 1,
  pollTruncated: false, copiedObjectCount: 821, reusedObjectCount: 7854,
  search: { lexicalRevision: "bm25-reference@1", chunkCount: 1, shardCount: 1, shardBytes: 1, largestShardBytes: 1, termsBytes: 1 },
  r2: { classA: 824, classB: 8678 },
  sources: {
    github: source(true, "2026-10-20T22:07:19.086Z"),
    mail: source(true, "2026-10-20T22:07:19.086Z"),
    jira: source(true, "2026-10-20T22:07:19.086Z"),
  },
};

function source(ok: boolean, lastSuccessAt: string | null) {
  return { ok, lastSuccessAt, cursor: null, durationMs: 1, read: 0, skipped: 0, filtered: 0, conflicts: 0, published: 0, gapCapped: false };
}

function run(job: SignalRun["job"], overrides: Partial<SignalRun> = {}): SignalRun {
  return {
    job, runId: runIdFor(job, NOW - H), status: "ok", ok: true, sourceRunId: "", durationMs: 1_000,
    completedAtMs: NOW, r2: job === "cost-guard" ? null : { classA: 10, classB: 10 }, counters: [0, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

function point(daysAgo: number, overrides: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    runId: `run-${daysAgo}`, status: "ok", ok: true, durationMs: 1_000, r2ClassA: 10,
    completedAtMs: NOW - daysAgo * 24 * H, counters: [1, 1, 1, 0, 0, 0], sampleInterval: 1, ...overrides,
  };
}

const history = (...points: HistoryPoint[]): History => ({ ok: true, points });
const ruleOf = (rules: readonly RuleEntry[], id: string, job?: string, subject?: string) =>
  rules.find((rule) => rule.id === id && (job === undefined || rule.job === job) && (subject === undefined || rule.subject === subject));

/** A `/health` body with the publication's sources last successful `age` ago. */
function healthWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { environment: "development", running: false, lastRun: { ...EXAMPLE_LAST_RUN }, digest: { enabled: false, lastRun: null }, searchEmbedding: { enabled: false, lastRun: null }, ...overrides };
}

const iso = (ms: number) => new Date(ms).toISOString();
const succeededAgo = (age: number) => {
  const at = iso(NOW - age);
  return healthWith({ lastRun: { ...EXAMPLE_LAST_RUN, completedAt: at, sources: { github: source(true, at), mail: source(true, at), jira: source(true, at) } } });
};
const medianHistory = (field: "durationMs" | "r2ClassA", median: number, count = 7) =>
  history(...Array.from({ length: count }, (_, index) => point(index + 1, { [field]: median })));

/** The publication's last run with `classA` and `copiedObjectCount`, and the retry counters when given. */
const invariant = (classA: number, copied: number, counters: { readonly putRetries: number; readonly conditionalMisses: number } | Record<string, never> = {}) =>
  state(healthWith({ lastRun: { ...EXAMPLE_LAST_RUN, copiedObjectCount: copied, r2: { classA, classB: 9_000, ...counters } } }), "r2.classAInvariant");

/** Builds each test-plan row into the entries it is judged on; the key is `rule|input`. */
const builders: Record<string, () => { readonly rules: readonly RuleEntry[]; readonly find: (rules: readonly RuleEntry[]) => RuleEntry | undefined }> = {
  "publication.freshness|24 h 30 min": () => state(succeededAgo(24 * H + 30 * M), "publication.freshness"),
  "publication.freshness|24 h 30 min 1 s": () => state(succeededAgo(24 * H + 30 * M + S), "publication.freshness"),
  "publication.freshness|27 h": () => state(succeededAgo(27 * H), "publication.freshness"),
  "publication.freshness|27 h 0 min 1 s": () => state(succeededAgo(27 * H + S), "publication.freshness"),
  "source.success|jira failed on 10-19 only": () => trend(
    run("publication", { ok: true, completedAtMs: Date.parse("2026-10-19T22:07:00Z"), counters: [1, 1, 0, 0, 0, 0] }),
    history(point(0, { completedAtMs: Date.parse("2026-10-18T22:07:00Z") })), "source.success", "publication", "jira"),
  "source.success|jira failed on 10-19 and 10-20": () => trend(
    run("publication", { completedAtMs: Date.parse("2026-10-20T22:07:00Z"), counters: [1, 1, 0, 0, 0, 0] }),
    history(point(0, { completedAtMs: Date.parse("2026-10-19T22:07:00Z"), counters: [1, 1, 0, 0, 0, 0] }), point(0, { runId: "older", completedAtMs: Date.parse("2026-10-18T22:07:00Z") })),
    "source.success", "publication", "jira"),
  "source.success|jira failed twice on 10-20 (one day)": () => trend(
    run("publication", { completedAtMs: Date.parse("2026-10-20T23:07:00Z"), counters: [1, 1, 0, 0, 0, 0] }),
    history(point(0, { completedAtMs: Date.parse("2026-10-20T22:07:00Z"), counters: [1, 1, 0, 0, 0, 0] }), point(0, { runId: "older", completedAtMs: Date.parse("2026-10-19T22:07:00Z") })),
    "source.success", "publication", "jira"),
  // Per UTC day the newest run counts: 10-19 ended ok, so only one failed day (Verifier M37).
  "source.success|jira failed early 10-19, ok later 10-19, failed 10-20": () => trend(
    run("publication", { completedAtMs: Date.parse("2026-10-20T22:07:00Z"), counters: [1, 1, 0, 0, 0, 0] }),
    history(
      point(0, { runId: "late", completedAtMs: Date.parse("2026-10-19T23:30:00Z"), counters: [1, 1, 1, 0, 0, 0] }),
      point(0, { runId: "early", completedAtMs: Date.parse("2026-10-19T01:00:00Z"), counters: [1, 1, 0, 0, 0, 0] }),
    ),
    "source.success", "publication", "jira"),
  // Through the record-to-point mapping, so c4 is the record's `pollTruncated` (Verifier M43).
  "publication.pollTruncated (from the run record)|lastRun pollTruncated true, previous not": () => trend(
    publicationSignalRun({ ...EXAMPLE_LAST_RUN, pollTruncated: true } as unknown as Parameters<typeof publicationSignalRun>[0], { runId: runIdFor("publication", NOW - H), startedAtMs: NOW - H, finishedAtMs: NOW }),
    history(point(1)), "publication.pollTruncated", "publication"),
  "publication.pollTruncated|true since 47 h 59 min": () => trend(
    run("publication", { counters: [1, 1, 1, 1, 0, 0] }),
    history(point(0, { runId: "a", completedAtMs: NOW - 24 * H, counters: [1, 1, 1, 1, 0, 0] }), point(0, { runId: "b", completedAtMs: NOW - (47 * H + 59 * M), counters: [1, 1, 1, 1, 0, 0] }), point(3)),
    "publication.pollTruncated", "publication"),
  "publication.pollTruncated|true since 48 h 0 min 1 s": () => trend(
    run("publication", { counters: [1, 1, 1, 1, 0, 0] }),
    history(point(0, { runId: "a", completedAtMs: NOW - 24 * H, counters: [1, 1, 1, 1, 0, 0] }), point(0, { runId: "b", completedAtMs: NOW - (48 * H + S), counters: [1, 1, 1, 1, 0, 0] }), point(3)),
    "publication.pollTruncated", "publication"),
  "r2.classAInvariant|824 / 821 (Example)": () => state(healthWith(), "r2.classAInvariant"),
  "r2.classAInvariant|827 / 821 (excess 3)": () => invariant(827, 821, { putRetries: 0, conditionalMisses: 0 }),
  "r2.classAInvariant|828 / 821 (excess 4)": () => invariant(828, 821, { putRetries: 0, conditionalMisses: 0 }),
  "r2.classAInvariant|1,234 / 821 (excess 410, firing above 410.5)": () => invariant(1_234, 821, { putRetries: 0, conditionalMisses: 0 }),
  "r2.classAInvariant|1,235 / 821 (excess 411)": () => invariant(1_235, 821, { putRetries: 0, conditionalMisses: 0 }),
  "r2.classAInvariant|88 / 35 (excess 50, firing floor 50)": () => invariant(88, 35, { putRetries: 0, conditionalMisses: 0 }),
  "r2.classAInvariant|89 / 35 (excess 51)": () => invariant(89, 35, { putRetries: 0, conditionalMisses: 0 }),
  "r2.classAInvariant|323 / 316, putRetries 4 (2026-10-23 manual run)": () => invariant(323, 316, { putRetries: 4, conditionalMisses: 0 }),
  "r2.classAInvariant|323 / 316, conditionalMisses 4": () => invariant(323, 316, { putRetries: 0, conditionalMisses: 4 }),
  "r2.classAInvariant|323 / 316, no counters (older record)": () => invariant(323, 316),
  "r2.classAInvariant|8,190 / 35 (2026-10-13 shape)": () => invariant(8_190, 35),
  "r2.classAInvariant|8,190 / 35, putRetries 0, conditionalMisses 0": () => invariant(8_190, 35, { putRetries: 0, conditionalMisses: 0 }),
  "digest.freshness|48 h": () => state(healthWith({ digest: { enabled: true, lastRun: { ok: true, completedAt: iso(NOW - 48 * H) } } }), "digest.freshness"),
  "digest.freshness|48 h 0 min 1 s": () => state(healthWith({ digest: { enabled: true, lastRun: { ok: true, completedAt: iso(NOW - 48 * H - S) } } }), "digest.freshness"),
  "digest.freshness|digest disabled": () => state(healthWith({ digest: { enabled: false, lastRun: { ok: true, completedAt: iso(NOW - 100 * H) } } }), "digest.freshness"),
  "digest.rejections|9, median 2": () => trend(run("digest", { counters: [449, 9, 0, 0, 0, 0] }), rejections(2, 7), "digest.rejections", "digest"),
  "digest.rejections|10, median 3": () => trend(run("digest", { counters: [449, 10, 0, 0, 0, 0] }), rejections(3, 7), "digest.rejections", "digest"),
  "digest.rejections|10, median 4": () => trend(run("digest", { counters: [449, 10, 0, 0, 0, 0] }), rejections(4, 7), "digest.rejections", "digest"),
  "digest.rejections|40, 2 previous points": () => trend(run("digest", { counters: [449, 40, 0, 0, 0, 0] }), rejections(1, 2), "digest.rejections", "digest"),
  "job.missed (kip-pages, daily)|last run 24 h 30 min ago": () => state(kipPagesRanAgo(24 * H + 30 * M), "job.missed", "kip-pages"),
  "job.missed (kip-pages, daily)|24 h 30 min 1 s": () => state(kipPagesRanAgo(24 * H + 30 * M + S), "job.missed", "kip-pages"),
  "job.missed (kip-pages, daily)|27 h 0 min 1 s": () => state(kipPagesRanAgo(27 * H + S), "job.missed", "kip-pages"),
  "job.missed (embedding)|pending 120, last run 2 h ago": () => state(healthWith({ searchEmbedding: { enabled: true, lastRun: { ok: true, pending: 120, completedAt: iso(NOW - 2 * H) } } }), "job.missed", "embedding"),
  "job.missed (embedding)|pending 120, last run 2 h 0 min 1 s ago": () => state(healthWith({ searchEmbedding: { enabled: true, lastRun: { ok: true, pending: 120, completedAt: iso(NOW - 2 * H - S) } } }), "job.missed", "embedding"),
  "job.missed (embedding)|pending 120, last run 3 h 0 min 1 s ago": () => state(healthWith({ searchEmbedding: { enabled: true, lastRun: { ok: true, pending: 120, completedAt: iso(NOW - 3 * H - S) } } }), "job.missed", "embedding"),
  "job.missed (embedding)|pending 0, last run 30 h ago": () => state(healthWith({ searchEmbedding: { enabled: true, lastRun: { ok: true, pending: 0, completedAt: iso(NOW - 30 * H) } } }), "job.missed", "embedding"),
  "job.missed (identity-links)|flag unset": () => state(healthWith(), "job.missed", "identity-links"),
  "job.missed (identity-links)|flag set, no run yet": () => state(healthWith({ identityLinks: null }), "job.missed", "identity-links"),
  "job.failures|current failed, previous ok": () => trend(run("kip-pages", { ok: false, status: "failed" }), history(point(1)), "job.failures", "kip-pages"),
  "job.failures|current and previous failed": () => trend(run("kip-pages", { ok: false, status: "failed" }), history(point(1, { ok: false, status: "failed" }), point(2)), "job.failures", "kip-pages"),
  "job.failures|current failed, no previous point": () => trend(run("kip-pages", { ok: false, status: "failed" }), history(), "job.failures", "kip-pages"),
  "job.failures (identity-links)|current no-input (ok)": () => trend(run("identity-links", { ok: true, status: "no-input" }), history(point(1, { ok: true, status: "no-input" })), "job.failures", "identity-links"),
  "job.duration|2 × median exactly": () => trend(run("digest", { durationMs: 2_000 }), medianHistory("durationMs", 1_000), "job.duration", "digest"),
  "job.duration|2 × median + 1 ms": () => trend(run("digest", { durationMs: 2_001 }), medianHistory("durationMs", 1_000), "job.duration", "digest"),
  "job.duration|2 previous points only": () => trend(run("digest", { durationMs: 9_000 }), medianHistory("durationMs", 1_000, 2), "job.duration", "digest"),
  "job.duration (retention)|8 min (80 % of 10 min)": () => trend(run("retention", { durationMs: 8 * M }), medianHistory("durationMs", 8 * M), "job.duration", "retention"),
  "job.duration (digest, no wall budget)|60 × median": () => trend(run("digest", { durationMs: 60 * M }), medianHistory("durationMs", M), "job.duration", "digest"),
  "job.r2ClassA|3,000, median 1,000": () => trend(run("kip-pages", { r2: { classA: 3_000, classB: 0 } }), medianHistory("r2ClassA", 1_000), "job.r2ClassA", "kip-pages"),
  "job.r2ClassA|3,001, median 1,000": () => trend(run("kip-pages", { r2: { classA: 3_001, classB: 0 } }), medianHistory("r2ClassA", 1_000), "job.r2ClassA", "kip-pages"),
  "job.r2ClassA|900, median 100": () => trend(run("kip-pages", { r2: { classA: 900, classB: 0 } }), medianHistory("r2ClassA", 100), "job.r2ClassA", "kip-pages"),
  "job.r2ClassA|1,000, median 100": () => trend(run("kip-pages", { r2: { classA: 1_000, classB: 0 } }), medianHistory("r2ClassA", 100), "job.r2ClassA", "kip-pages"),
  "job.r2ClassA|1,001, median 100": () => trend(run("kip-pages", { r2: { classA: 1_001, classB: 0 } }), medianHistory("r2ClassA", 100), "job.r2ClassA", "kip-pages"),
  "job.r2ClassA|5,000, median 100": () => trend(run("kip-pages", { r2: { classA: 5_000, classB: 0 } }), medianHistory("r2ClassA", 100), "job.r2ClassA", "kip-pages"),
  "job.r2ClassA|5,001, median 100": () => trend(run("kip-pages", { r2: { classA: 5_001, classB: 0 } }), medianHistory("r2ClassA", 100), "job.r2ClassA", "kip-pages"),
  "job.r2ClassA (publication 2026-10-13 shape)|8,190, median 800": () => trend(run("publication", { r2: { classA: 8_190, classB: 9_000 } }), medianHistory("r2ClassA", 800), "job.r2ClassA", "publication"),
  "job.r2ClassA (cost-guard, r2Counted 0)|any": () => trend(run("cost-guard", { r2: null }), medianHistory("r2ClassA", 0), "job.r2ClassA", "cost-guard"),
};

function rejections(median: number, count: number): History {
  return history(...Array.from({ length: count }, (_, index) => point(index + 1, { counters: [400, median, 0, 0, 0, 0] })));
}

function kipPagesRanAgo(age: number): Record<string, unknown> {
  return healthWith({ kipPages: { revision: "authors@1", lastRun: { ok: true, status: "ok", at: iso(NOW - age - 5 * S), durationMs: 5 * S }, lastGoodAt: null, coverageFrom: null } });
}

function state(health: Record<string, unknown>, id: string, job?: string) {
  const rules = signalsHealth(health, NOW).rules.filter((rule) => rule.source === "state");
  return { rules, find: (list: readonly RuleEntry[]) => ruleOf(list, id, job) };
}

function trend(current: SignalRun, input: History, id: string, job: string, subject?: string) {
  const rules = trendRules(current, input);
  return { rules, find: (list: readonly RuleEntry[]) => ruleOf(list, id, job, subject) };
}

describe("Spec 028 slice 1: rule thresholds (test plan)", () => {
  test.each([...testPlanRows])("$id: $rule, $input → $status", (row: SignalCase) => {
    const build = builders[`${row.rule}|${row.input}`];
    expect(build).toBeDefined();
    const { rules, find } = build!();
    const entry = find(rules);
    if (row.status === "no entry") {
      expect(entry).toBeUndefined();
      // Positive control: the same evaluation produced entries, so absence is the rule's, not an empty result.
      expect(rules.length).toBeGreaterThan(0);
    } else {
      expect(entry?.status).toBe(row.status);
    }
  });

  test("OB8: a record without putRetries and conditionalMisses counts them as 0 and says so; a record with them gives no reason", () => {
    const find = (built: ReturnType<typeof invariant>) => built.find(built.rules)!;
    const older = find(invariant(323, 316));
    expect(older).toMatchObject({ status: "warn", value: 323, since: EXAMPLE_LAST_RUN.completedAt });
    expect(older.reason).toContain("putRetries and conditionalMisses missing from the record, counted as 0");
    expect(older.threshold).toBe("excess = classA − (copiedObjectCount + 3 + putRetries + conditionalMisses); warn: excess > 3; firing: excess > max(50, 0.5 × copiedObjectCount)");
    // Positive control: the same run with its counters is ok, carries no reason and no since.
    const counted = find(invariant(323, 316, { putRetries: 4, conditionalMisses: 0 }));
    expect(counted).toMatchObject({ status: "ok", value: 323, since: null });
    expect(counted.reason).toBeUndefined();
  });

  test("OB26: the kip-pages wall budget is the cron path's own limit", () => {
    expect(WALL_BUDGET_MS["kip-pages"]).toBe(KIP_PAGES_CRON_WALL_MS);
    expect(WALL_BUDGET_MS.retention).toBe(10 * 60_000);
  });

  test("OB5: a firing entry names when the condition first held and the run that shows it", () => {
    const at = NOW - (30 * H);
    const health = succeededAgo(30 * H);
    (health.lastRun as Record<string, unknown>).runId = "publication-2026-10-19T17-45-00-000Z";
    const entry = ruleOf(signalsHealth(health, NOW).rules, "publication.freshness")!;
    expect(entry).toMatchObject({ status: "firing", source: "state", job: "publication", since: iso(at + 27 * H), runId: "publication-2026-10-19T17-45-00-000Z" });
  });
});

describe("Spec 028 slice 1: flag, runId and data point", () => {
  test("OB1: OBSERVABILITY_SIGNALS unset, blank, off, on and yes resolve to off, off, off, on, invalid", () => {
    expect([undefined, "", "  ", "off", "on", " on ", "yes", "true"].map(resolveSignalsMode))
      .toEqual(["off", "off", "off", "off", "on", "on", "invalid", "invalid"]);
  });

  test("OB2: a run started at 2026-10-20T22:07:00.000Z is publication-2026-10-20T22-07-00-000Z", () => {
    expect(runIdFor("publication", "2026-10-20T22:07:00.000Z")).toBe("publication-2026-10-20T22-07-00-000Z");
    expect(runIdFor("cost-guard", Date.parse("2026-10-20T22:07:00.000Z"))).toBe("cost-guard-2026-10-20T22-07-00-000Z");
  });

  test("OB3: the Example's lastRun gives exactly the Example's indexes, blobs and doubles", () => {
    const signal = publicationSignalRun(EXAMPLE_LAST_RUN, {
      runId: "publication-2026-10-20T22-07-00-000Z",
      startedAtMs: Date.parse("2026-10-20T22:07:00.000Z"),
      finishedAtMs: Date.parse("2026-10-20T22:07:19.086Z"),
    });
    expect(metricPoint(signal, "development")).toEqual({
      indexes: ["publication-2026-10-20T22-07-00-000Z"],
      blobs: ["publication", "development", "ok", ""],
      doubles: [1, 19086, 824, 8678, 1, 1792534039086, 1, 1, 1, 0, 821, 7854],
    });
  });

  test("OB22: one recorded run of each of the seven jobs gives the common schema with its own c1–c6 and r2Counted", () => {
    const at = "2026-10-21T02:17:00.000Z";
    const atMs = Date.parse(at);
    const points = {
      publication: metricPoint(publicationSignalRun({ ...EXAMPLE_LAST_RUN, ok: false, failureKind: "pipeline", error: "x", retryAfterSeconds: 300, r2: { classA: 3, classB: 4 }, sources: { github: source(false, null), mail: source(true, at), jira: source(false, null) } } as never, { runId: "publication-a", startedAtMs: atMs - 5_000, finishedAtMs: atMs }), "production"),
      digest: metricPoint(digestSignalRun({ ok: true, completedAt: at, durationMs: 9_000, candidates: 449, rejections: { unparsable: 4, empty: 1 }, r2: { classA: 2, classB: 300 } } as never, { runId: "digest-a", sourceRunId: "publication-a" }), "development"),
      embedding: metricPoint(embeddingSignalRun({ ok: true, completedAt: at, durationMs: 4_000, embeddedThisRun: 64, pending: 120, quarantined: 2, deletedThisRun: 5, r2: { classA: 0, classB: 3 } } as never, { runId: "embedding-a", sourceRunId: "publication-a" }), "development"),
      "cost-guard": metricPoint(costGuardSignalRun({ ok: true, status: "warn", breaker: { tripped: true } }, { runId: "cost-guard-a", startedAtMs: atMs - 700, finishedAtMs: atMs }), "development"),
      retention: metricPoint(retentionSignalRun({ ok: true, status: "ok", at, elapsedMs: 60_000, dryRun: true, deleted: { objects: 10, bytes: 2_048 }, remaining: 5, candidates: { objects: 15 }, r2: { classA: 11, classB: 40 } }, { runId: "retention-a" }), "development"),
      "identity-links": metricPoint(identityLinksSignalRun({ ok: true, status: "no-input", at, durationMs: 300, links: { roster: 1, declared: 2, corroborated: 3 }, rejected: { dominance: 1, competitor: 1, minimum: 1, conflict: 1, contradiction: 1, removed: 1 }, people: 40, bytesWritten: 900, r2: { classA: 1, classB: 15 } } as never, { runId: "identity-links-a" }), "development"),
      "kip-pages": metricPoint(kipPagesSignalRun({ ok: false, status: "over-budget", at, durationMs: 1_000, pagesRead: 7, pagesChanged: 2, issuesRead: 3, requests: 13, bytesWritten: 512, r2: { classA: 2, classB: 1 } } as never, { runId: "kip-pages-a" }), "development"),
    };
    const done = atMs;
    expect(points).toEqual({
      publication: { indexes: ["publication-a"], blobs: ["publication", "production", "failed", ""], doubles: [0, 5_000, 3, 4, 1, done, 0, 1, 0, 0, 0, 0] },
      digest: { indexes: ["digest-a"], blobs: ["digest", "development", "ok", "publication-a"], doubles: [1, 9_000, 2, 300, 1, done, 449, 5, 0, 0, 0, 0] },
      embedding: { indexes: ["embedding-a"], blobs: ["embedding", "development", "ok", "publication-a"], doubles: [1, 4_000, 0, 3, 1, done, 64, 120, 2, 5, 0, 0] },
      "cost-guard": { indexes: ["cost-guard-a"], blobs: ["cost-guard", "development", "warn", ""], doubles: [1, 700, 0, 0, 0, done, 1, 0, 0, 0, 0, 0] },
      retention: { indexes: ["retention-a"], blobs: ["retention", "development", "ok", ""], doubles: [1, 60_000, 11, 40, 1, done + 60_000, 10, 2_048, 5, 15, 1, 0] },
      "identity-links": { indexes: ["identity-links-a"], blobs: ["identity-links", "development", "no-input", ""], doubles: [1, 300, 1, 15, 1, done + 300, 3, 6, 40, 900, 0, 0] },
      "kip-pages": { indexes: ["kip-pages-a"], blobs: ["kip-pages", "development", "over-budget", ""], doubles: [0, 1_000, 2, 1, 1, done + 1_000, 7, 2, 3, 13, 512, 0] },
    });
    for (const value of Object.values(points)) {
      expect(value.indexes).toHaveLength(1);
      expect(value.blobs).toHaveLength(4);
      expect(value.doubles).toHaveLength(12);
    }
  });
});

describe("Spec 028 slice 1: /health.signals and the stored trend results", () => {
  test("OB11: the Example is all ok with one entry per state rule and its source; one firing rule makes the status firing", () => {
    const stored = { evaluatedAt: "2026-10-20T22:07:20.000Z", rules: trendRules(run("publication", { counters: [1, 1, 1, 0, 821, 7854] }), history(point(1), point(2), point(3))), lastError: null };
    const body = healthWith({ lastRun: { ...EXAMPLE_LAST_RUN, runId: "publication-2026-10-20T22-07-00-000Z", trends: stored }, digest: { enabled: true, lastRun: { ok: true, completedAt: "2026-10-20T22:49:08.123Z", durationMs: 1, candidates: 449, rejections: {} } } });
    const signals = signalsHealth(body, Date.parse("2026-10-20T23:45:03.000Z"));
    expect(Object.keys(signals)).toEqual(["status", "evaluatedAt", "analyticsEvaluatedAt", "rules", "lastError"]);
    expect(signals).toMatchObject({ status: "ok", evaluatedAt: "2026-10-20T23:45:03.000Z", analyticsEvaluatedAt: "2026-10-20T22:07:20.000Z", lastError: null });
    const ids = signals.rules.map((rule) => `${rule.source}:${rule.id}:${rule.job}${rule.subject === undefined ? "" : `:${rule.subject}`}`);
    for (const expected of [
      "state:publication.freshness:publication", "state:r2.classAInvariant:publication", "state:digest.freshness:digest",
      "state:job.missed:publication", "state:job.missed:digest",
      "analytics:source.success:publication:github", "analytics:source.success:publication:mail", "analytics:source.success:publication:jira",
      "analytics:publication.pollTruncated:publication", "analytics:job.failures:publication", "analytics:job.duration:publication", "analytics:job.r2ClassA:publication",
      // The digest has no evaluated run in this body: its analytics rules are listed as unknown, never firing.
      "analytics:job.failures:digest", "analytics:digest.rejections:digest",
    ]) expect(ids).toContain(expected);
    expect(signals.rules.filter((rule) => rule.status !== "ok" && rule.status !== "unknown")).toEqual([]);
    expect(ruleOf(signals.rules, "digest.rejections", "digest")!.status).toBe("unknown");

    const firing = signalsHealth({ ...body, lastRun: { ...(body.lastRun as object), r2: { classA: 8_190, classB: 1 } } }, Date.parse("2026-10-20T23:45:03.000Z"));
    expect(firing.status).toBe("firing");
    expect(ruleOf(firing.rules, "r2.classAInvariant")!.status).toBe("firing");
  });

  test("OB13: with no history every analytics rule is unknown and the status ok; 30 h without a run fires freshness at read time", () => {
    const first = signalsHealth(healthWith({ lastRun: null }), NOW);
    const analytics = first.rules.filter((rule) => rule.source === "analytics");
    expect(analytics.length).toBeGreaterThan(0);
    expect(analytics.every((rule) => rule.status === "unknown")).toBe(true);
    expect(first.status).toBe("ok");
    expect(first.analyticsEvaluatedAt).toBeNull();
    const stale = signalsHealth(succeededAgo(30 * H), NOW);
    expect(ruleOf(stale.rules, "publication.freshness")!.status).toBe("firing");
    expect(stale.status).toBe("firing");
  });
});

/** A fake `ANALYTICS_SQL` binding: records every call and answers from a queue. */
class FakeSql implements AnalyticsSql {
  readonly calls: { readonly query: string; readonly params: Record<string, unknown> }[] = [];
  constructor(private readonly answers: (() => unknown)[] = []) {}
  async query(input: { readonly query: string; readonly params?: Record<string, string | number | boolean | null> }) {
    this.calls.push({ query: input.query, params: { ...input.params } });
    const answer = this.answers.shift()?.() ?? { data: [] };
    return answer as { data: unknown[] };
  }
}

class FakeSink {
  readonly points: unknown[] = [];
  writeDataPoint(point: unknown) { this.points.push(point); }
}

const row = (runId: string, overrides: Record<string, unknown> = {}) => ({
  runId, status: "ok", ok: 1, durationMs: 1_000, r2ClassA: 10, completedAtMs: NOW - H,
  c1: 1, c2: 1, c3: 1, c4: 0, c5: 0, c6: 0, weight: 1, ...overrides,
});

function recorder(sql: AnalyticsSql | undefined, sink: FakeSink | null = new FakeSink(), delays: number[] = []) {
  return new SignalRecorder({ environment: "development", ...(sink === null ? {} : { sink }), ...(sql === undefined ? {} : { sql }), now: () => NOW, delay: async (ms) => { delays.push(ms); } });
}

describe("Spec 028 slice 1: the recorder", () => {
  test("OB4: one parameterized SELECT on the env's dataset, bounded by timestamp ≤ 8 days and blob1, the runId excluded, no accountTag, no FORMAT", async () => {
    const sql = new FakeSql();
    const sink = new FakeSink();
    const current = run("publication");
    await recorder(sql, sink).finish(current);
    expect(sql.calls).toHaveLength(1);
    const [call] = sql.calls;
    expect(call!.query).toContain('FROM events.analyticsEngine."osskb_signals_dev"');
    expect(call!.query.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    expect(call!.query).toContain("blob1 = $job");
    expect(call!.query).toContain("index1 != $runId");
    expect(call!.query).toContain("timestamp >= $start");
    expect(call!.query).not.toMatch(/accountTag|FORMAT/iu);
    expect(call!.params).toEqual({ job: "publication", runId: current.runId, start: iso(NOW - SIGNAL_THRESHOLDS.historyDays * 24 * H) });
    expect(NOW - Date.parse(call!.params.start as string)).toBeLessThanOrEqual(8 * 24 * H);
    expect(historyQuery("publication", current.runId, "production", NOW).query).toContain('"osskb_signals_prod"');
    // The point is written before the query, exactly once.
    expect(sink.points).toHaveLength(1);
  });

  test("OB4: the history SELECT names only columns the ANALYTICS_SQL binding exposes for a WAE dataset, and takes the row weight from COUNT(*)", () => {
    // The Analytics SQL API dialect (not the WAE SQL API): WAE columns are timestamp, index1,
    // blob1–20, double1–20; `_sample_interval` does not exist there (Dev 2026-10-23: "Schema error:
    // No field named _sample_interval"), and sample weights are applied to COUNT/SUM/AVG instead.
    // Exact MIN/MAX are rejected on adaptively sampled datasets.
    const binding = new Set(["timestamp", "index1", ...Array.from({ length: 20 }, (_, i) => `blob${i + 1}`), ...Array.from({ length: 20 }, (_, i) => `double${i + 1}`)]);
    const keywords = new Set(["SELECT", "AS", "FROM", "WHERE", "AND", "GROUP", "BY", "ORDER", "DESC", "LIMIT", "COUNT"]);
    const { query } = historyQuery("digest", "digest-1", "development", NOW);
    const body = query
      .replace(/events\.analyticsEngine\."[^"]+"/u, "")
      .replace(/\$\w+/gu, "")
      .replace(/\bAS\s+\w+/gu, "AS");
    const columns = (body.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? []).filter((word) => !keywords.has(word.toUpperCase()));
    expect(columns.filter((column) => !binding.has(column))).toEqual([]);
    expect(query).not.toContain("_sample_interval");
    expect(query).not.toMatch(/\b(MIN|MAX)\s*\(/iu);
    expect(query).toContain("COUNT(*) AS weight");
    // Every non-aggregated column is grouped, so one row per stored point and COUNT(*) is its weight.
    const selected = query.slice("SELECT ".length, query.indexOf(" FROM ")).split(",").map((part) => part.trim().split(/\s+/u)[0]!).filter((part) => !part.startsWith("COUNT("));
    const grouped = query.slice(query.indexOf("GROUP BY ") + "GROUP BY ".length, query.indexOf(" ORDER BY ")).split(",").map((part) => part.trim());
    expect(new Set(grouped)).toEqual(new Set([...selected, "timestamp"]));
  });

  test("OB15: the weight column (not _sample_interval) is what the sampled check reads; a missing weight is sampled", async () => {
    const weighted = await recorder(new FakeSql([() => ({ data: [row("a", { weight: 10 }), row("b"), row("c")] })])).finish(run("digest", { ok: false, status: "failed" }));
    expect(ruleOf(weighted.rules, "job.failures", "digest")).toMatchObject({ status: "unknown", reason: "sampled" });
    // A row without the weight column is treated as sampled, never as exact.
    const missing = await recorder(new FakeSql([() => ({ data: [row("a", { weight: undefined }), row("b"), row("c")] })])).finish(run("digest", { ok: false, status: "failed" }));
    expect(ruleOf(missing.rules, "job.failures", "digest")).toMatchObject({ status: "unknown", reason: "sampled" });
  });

  test("OB29: every job's run makes at most one SELECT, filtered by its own blob1", async () => {
    for (const job of ["publication", "digest", "embedding", "cost-guard", "retention", "identity-links", "kip-pages"] as const) {
      const sql = new FakeSql();
      await recorder(sql).finish(run(job));
      expect(sql.calls.length).toBeLessThanOrEqual(job === "publication" ? 2 : 1);
      expect(sql.calls.every((call) => call.params.job === job)).toBe(true);
    }
  });

  test("OB15: a retryable SQL error is retried once after a bounded backoff, a non-retryable one never; then the analytics rules are unknown and lastError is set", async () => {
    const retryable = () => { throw Object.assign(new Error("busy"), { retryable: true }); };
    const fatal = () => { throw Object.assign(new Error("bad query"), { retryable: false }); };
    const delays: number[] = [];
    const twice = new FakeSql([retryable, retryable]);
    const failed = await recorder(twice, new FakeSink(), delays).finish(run("digest"));
    expect(twice.calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
    expect(delays[0]!).toBeGreaterThan(0);
    expect(delays[0]!).toBeLessThanOrEqual(2_000);
    expect(failed.lastError).toContain("busy");
    expect(failed.rules.every((rule) => rule.status === "unknown")).toBe(true);

    const once = new FakeSql([fatal]);
    const fatalResult = await recorder(once).finish(run("digest"));
    expect(once.calls).toHaveLength(1);
    expect(fatalResult.lastError).toContain("bad query");

    // Positive control: a retryable error followed by an answer evaluates the rules.
    const recovered = new FakeSql([retryable, () => ({ data: [row("a"), row("b"), row("c")] })]);
    const result = await recorder(recovered).finish(run("digest", { ok: false, status: "failed" }));
    expect(result.lastError).toBeNull();
    expect(ruleOf(result.rules, "job.failures", "digest")!.status).toBe("warn");
  });

  test("OB15: a history row with weight (weighted COUNT(*)) 10 makes the rules reading it unknown (sampled); two rows of one runId count once", async () => {
    const sampled = await recorder(new FakeSql([() => ({ data: [row("a", { weight: 10 }), row("b"), row("c")] })])).finish(run("digest", { ok: false, status: "failed" }));
    const failures = ruleOf(sampled.rules, "job.failures", "digest")!;
    expect(failures).toMatchObject({ status: "unknown", reason: "sampled" });
    // Positive control: the same rows unsampled are judged.
    const exact = await recorder(new FakeSql([() => ({ data: [row("a"), row("b"), row("c")] })])).finish(run("digest", { ok: false, status: "failed" }));
    expect(ruleOf(exact.rules, "job.failures", "digest")!.status).toBe("warn");

    // A retried run wrote its point twice: one failed run, so the previous run is ok and the rule warns, not fires.
    const duplicated = await recorder(new FakeSql([() => ({ data: [
      row("a", { ok: 0, status: "failed", completedAtMs: NOW - 2 * H }),
      row("a", { ok: 0, status: "failed", completedAtMs: NOW - 2 * H }),
      row("b", { ok: 1, completedAtMs: NOW - 26 * H }),
      row("c", { ok: 1, completedAtMs: NOW - 50 * H }),
      row("d", { ok: 1, completedAtMs: NOW - 74 * H }),
    ] })])).finish(run("kip-pages", { ok: true }));
    expect(ruleOf(duplicated.rules, "job.failures", "kip-pages")!.status).toBe("ok");
    const durations = await recorder(new FakeSql([() => ({ data: [row("a", { durationMs: 100 }), row("a", { durationMs: 100 }), row("b", { durationMs: 100 })] })])).finish(run("kip-pages", { durationMs: 1_000 }));
    // Two distinct previous runs only: the duration baseline needs 3, so a duplicate must not make it 3.
    expect(ruleOf(durations.rules, "job.duration", "kip-pages")!.status).toBe("unknown");
  });

  test("OB14: writeDataPoint throwing is caught and logged with the runId; a missing binding marks the analytics rules unknown and queries nothing", async () => {
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (value: unknown) => { errors.push(value); };
    try {
      const sql = new FakeSql();
      const throwing = { writeDataPoint() { throw new Error("dataset not bound"); } };
      const current = run("publication");
      const result = await new SignalRecorder({ environment: "development", sink: throwing as never, sql, now: () => NOW, delay: async () => {} }).finish(current);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ runId: current.runId, job: "publication" });
      expect(String((errors[0] as { message: string }).message)).toContain("dataset not bound");
      expect(result.lastError).toContain("dataset not bound");

      for (const [sink, query, missing] of [[null, new FakeSql(), "SIGNALS"], [new FakeSink(), undefined, "ANALYTICS_SQL"]] as const) {
        const unbound = await recorder(query, sink).finish(current);
        expect(unbound.rules.length).toBeGreaterThan(0);
        expect(unbound.rules.every((rule) => rule.status === "unknown" && rule.reason!.includes(missing))).toBe(true);
        expect(query?.calls ?? []).toEqual([]);
        expect(sink?.points ?? []).toEqual([]);
      }
    } finally {
      console.error = realError;
    }
  });

  test("OB16: given a token in an error text, no data point, query parameter, trend result or log object contains it", async () => {
    const token = ["ghp", "_", "A".repeat(36)].join("");
    const logs: unknown[] = [];
    const realError = console.error;
    console.error = (value: unknown) => { logs.push(value); };
    try {
      const sink = { points: [] as unknown[], writeDataPoint(point: unknown) { this.points.push(point); throw new Error(`write failed with ${token}`); } };
      const sql = new FakeSql([() => { throw Object.assign(new Error(`denied for Bearer ${token}`), { retryable: false }); }]);
      const current = run("kip-pages", { ok: false, status: "failed" });
      const result = await new SignalRecorder({ environment: "development", sink: sink as never, sql, now: () => NOW, delay: async () => {} }).finish(current);
      const everything = JSON.stringify({ points: sink.points, params: sql.calls, result, logs });
      expect(everything).not.toContain(token);
      // Positive control: both errors were recorded (in redacted form).
      expect(result.lastError).not.toBeNull();
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      console.error = realError;
    }
  });

  test("OB17: per run 1 writeDataPoint and ≤ 3 SQL queries (1 retry at most); a /health evaluation stays under 5 ms CPU", async () => {
    const retryable = () => { throw Object.assign(new Error("busy"), { retryable: true }); };
    for (const job of ["publication", "digest", "embedding", "cost-guard", "retention", "identity-links", "kip-pages"] as const) {
      const sql = new FakeSql([retryable, retryable]);
      const sink = new FakeSink();
      await recorder(sql, sink).finish(run(job));
      expect(sink.points).toHaveLength(1);
      expect(sql.calls.length).toBeLessThanOrEqual(2);
    }
    const body = healthWith({ lastRun: { ...EXAMPLE_LAST_RUN, trends: { evaluatedAt: iso(NOW), rules: trendRules(run("publication"), history(point(1), point(2), point(3))), lastError: null } }, digest: { enabled: true, lastRun: { ok: true, completedAt: iso(NOW) } }, identityLinks: null, kipPages: null, costGuard: { checkedAt: iso(NOW) } });
    signalsHealth(body, NOW);
    const started = performance.now();
    for (let index = 0; index < 100; index += 1) signalsHealth(body, NOW);
    const perCall = (performance.now() - started) / 100;
    console.log(`OB17 measured: /health signals evaluation ${perCall.toFixed(3)} ms per call`);
    expect(perCall).toBeLessThan(5);
  });
});
