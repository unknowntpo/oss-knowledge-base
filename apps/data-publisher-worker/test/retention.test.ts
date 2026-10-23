/** Spec 029, dry-run slice: the retained-set rules and one dry run over an in-memory bucket. */
import { describe, expect, test } from "bun:test";

import { assertFloor, classifyReleases, idTime, resolveRetentionMode, retainedEvidence } from "../src/retention/plan";
import { RETENTION_MAX_GETS, RETENTION_MAX_LISTS, runRetentionDryRun, type RetentionRunDeps } from "../src/retention/run";
import { poolFixtures, releaseFixtures, releaseIdAt, RUN_AT, testPlanRows, type RetentionCase } from "./retention.cases";
import { feedPoolKey, point, publish, RetentionMemoryBucket, searchPoolKey } from "./support/retention-bucket";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const day = (date: string) => Date.parse(`2026-${date}T22:07:00Z`);

function dryRun(bucket: RetentionMemoryBucket, options: Partial<Omit<RetentionRunDeps, "bucket">> = {}) {
  return runRetentionDryRun({
    bucket,
    now: () => RUN_AT,
    digestProjectIds: ["apache-kafka"],
    embeddingReleaseId: async () => null,
    ...options,
  });
}

const ids = (list: readonly { readonly projection: string; readonly id: string }[], projection: string) =>
  list.filter((item) => item.projection === projection).map((item) => item.id).sort();

async function checkReleaseRow(row: RetentionCase): Promise<void> {
  const fixture = releaseFixtures[row.case]!;
  if (fixture === "floor-rejected") {
    expect(() => assertFloor(1)).toThrow("retention floor must be ≥ 2");
    expect(() => retainedEvidence([], { feed: "a", search: "b", digest: [], embedding: null }, RUN_AT, 1)).toThrow("≥ 2");
    // Control: the floor the run uses is accepted.
    expect(assertFloor(2)).toBe(2);
    return;
  }
  const bucket = new RetentionMemoryBucket();
  for (const at of fixture.verified) publish(bucket, at);
  for (const at of fixture.crashed ?? []) publish(bucket, at, { evidence: false });
  point(bucket, fixture.feed, fixture.search);
  if (fixture.digest !== undefined) {
    bucket.set("public/digest/v1/apache-kafka/current.json", JSON.stringify({ schema: "osskb.digest-pointer.v1", sourceReleaseId: releaseIdAt(fixture.digest) }));
  }
  const embedding = fixture.embedding === undefined ? null : `feed-${releaseIdAt(fixture.embedding)}`;
  const { lastRun, report } = await dryRun(bucket, { embeddingReleaseId: async () => embedding });
  expect(lastRun.status).toBe("ok");
  const listed = [...fixture.verified, ...(fixture.crashed ?? [])];
  const retained = new Set(fixture.retained);
  const expectFeed = (times: readonly number[]) => times.map(releaseIdAt).sort();
  const expectSearch = (times: readonly number[]) => times.map((at) => `feed-${releaseIdAt(at)}`).sort();
  expect(ids(report!.retained, "feed")).toEqual(expectFeed(fixture.retained));
  expect(ids(report!.retained, "search")).toEqual(expectSearch(fixture.retained));
  const candidates = listed.filter((at) => !retained.has(at));
  expect(ids(report!.candidates.releases, "feed")).toEqual(expectFeed(candidates));
  expect(ids(report!.candidates.releases, "search")).toEqual(expectSearch(candidates));
  // The live releases are never candidates (Rollout step 2's stop condition).
  expect(ids(report!.candidates.releases, "feed")).not.toContain(releaseIdAt(fixture.feed));
  expect(ids(report!.candidates.releases, "search")).not.toContain(`feed-${releaseIdAt(fixture.search)}`);
  expect(bucket.writes).toBe(0);
}

async function checkPoolRow(row: RetentionCase): Promise<void> {
  const fixture = poolFixtures[row.case]!;
  const bucket = new RetentionMemoryBucket();
  const pool = feedPoolKey("under-test");
  // The oldest release in the window lists the object when it is marked; the newest is live.
  publish(bucket, day("09-22"), fixture.marked ? { poolKeys: [pool] } : {});
  publish(bucket, day("10-21"));
  point(bucket, day("10-21"));
  bucket.set(pool, 40, fixture.uploaded);
  const { lastRun, report } = await dryRun(bucket);
  expect(lastRun.status).toBe("ok");
  expect(lastRun.candidates.poolObjects).toBe(fixture.candidate ? 1 : 0);
  expect(report!.candidates.pool.sample.includes(pool)).toBe(fixture.candidate);
}

describe("Spec 029 retained-set rules (test plan)", () => {
  test.each(testPlanRows)("$id: $case", async (row) => {
    if (row.id === "RT2") await checkReleaseRow(row);
    else await checkPoolRow(row);
  });
});

describe("Spec 029 dry run", () => {
  test("RT1: R2_RETENTION resolves unset, blank, off, dry-run, enforce, on to off, off, off, dry-run, unconfigured, unconfigured", () => {
    const modes = [undefined, " ", "off", "dry-run", "enforce", "on"].map((flag) => resolveRetentionMode(flag).mode);
    expect(modes).toEqual(["off", "off", "off", "dry-run", "unconfigured", "unconfigured"]);
    expect(resolveRetentionMode("enforce").reason).toContain("only the dry run");
    expect(resolveRetentionMode("on").reason).toContain("is not off or dry-run");
  });

  test("RT3: the Example's evidence (4,330 pool keys per projection) is marked; candidates are exactly the unmarked objects older than 48 h", async () => {
    const bucket = new RetentionMemoryBucket();
    const listedFeed = Array.from({ length: 4_330 }, (_, index) => feedPoolKey(`example-${index}`));
    const listedSearch = Array.from({ length: 4_330 }, (_, index) => searchPoolKey(`example-${index}`));
    publish(bucket, day("10-20"), { poolKeys: [...listedFeed, ...listedSearch] });
    publish(bucket, day("10-21"));
    point(bucket, day("10-21"));
    // Every listed object is old: only the mark keeps it.
    for (const key of [...listedFeed, ...listedSearch]) bucket.set(key, 5, Date.parse("2026-09-02T00:00:00Z"));
    bucket.set(feedPoolKey("unmarked-47h"), 7, RUN_AT - 47 * HOUR);
    bucket.set(searchPoolKey("unmarked-49h"), 9, RUN_AT - 49 * HOUR);
    bucket.set(feedPoolKey("unmarked-49h"), 11, RUN_AT - 49 * HOUR);
    const { lastRun, report } = await dryRun(bucket);
    // 8,660 listed + each release's own two pool objects.
    expect(lastRun.retained.poolKeys).toBe(8_660 + 4);
    expect(lastRun.candidates.poolObjects).toBe(2);
    expect([...report!.candidates.pool.sample].sort()).toEqual([feedPoolKey("unmarked-49h"), searchPoolKey("unmarked-49h")].sort());
    expect(report!.candidates.pool.bytes).toBe(20);
  });

  test("RT5: a dry run reports the candidates' counts and bytes, never a key outside the swept prefixes, and makes no delete or put call", async () => {
    const bucket = new RetentionMemoryBucket();
    const old = [publish(bucket, day("08-01")), publish(bucket, day("08-02"))];
    publish(bucket, day("10-20"));
    publish(bucket, day("10-21"));
    point(bucket, day("10-21"));
    bucket.set("public/digest/v1/apache-kafka/current.json", JSON.stringify({ schema: "osskb.digest-pointer.v1", sourceReleaseId: releaseIdAt(day("10-21")) }));
    bucket.set(`public/digest/v1/apache-kafka/${releaseIdAt(day("08-01"))}/en.json`, 500);
    bucket.set("public/review-queue/v1/apache-kafka/last-run.json", 500);
    bucket.set("internal/people/v1/log.json", 500);
    const { lastRun, report } = await dryRun(bucket);
    const evidenceBytes = old.reduce((sum, release) => sum + bucket.objects.get(`publication-sets/v1/github-${release.feed}.json`)!.body.length, 0);
    expect(lastRun).toMatchObject({
      mode: "dry-run",
      status: "ok",
      runId: "retention-2026-10-22",
      complete: { releases: true, evidence: true, pool: true },
      candidates: { releases: { feed: 2, search: 2 }, evidence: 2, poolObjects: 4, objects: 14 },
      deleted: { objects: 0, bytes: 0 },
      remaining: 14,
    });
    // Per old publication: Feed 100 + 50, Search 30 + 20, two own pool objects of 10.
    expect(lastRun.candidates.bytes).toBe(2 * (150 + 50 + 20) + evidenceBytes);
    const reported = [
      ...report!.candidates.releases.map((release) => release.id),
      ...report!.candidates.evidence.map((item) => item.key),
      ...report!.candidates.pool.sample,
    ];
    expect(reported.some((key) => /current\.json|public\/digest\/|review-queue|internal\//u.test(key))).toBe(false);
    expect(bucket.writes).toBe(0);
    expect(bucket.calls.some((call) => call.op === "list" && /digest|review-queue|internal/u.test(call.key))).toBe(false);
  });

  test("RT9: a retained release whose evidence is invalid counts no pool object, still reports the release candidates, and records evidence-missing", async () => {
    const build = (live: true | "invalid") => {
      const bucket = new RetentionMemoryBucket();
      publish(bucket, day("08-01"));
      publish(bucket, day("10-20"));
      publish(bucket, day("10-21"), { evidence: live });
      point(bucket, day("10-21"));
      return bucket;
    };
    const broken = build("invalid");
    const { lastRun } = await dryRun(broken);
    expect(lastRun.reason).toBe("evidence-missing");
    expect(lastRun.complete.pool).toBe(false);
    expect(lastRun.candidates.poolObjects).toBe(0);
    expect(lastRun.candidates.releases).toEqual({ feed: 1, search: 1 });
    expect(broken.calls.some((call) => call.op === "list" && call.key.includes("/objects/details/"))).toBe(false);
    // Control: with the evidence intact, the old release's two pool objects are counted.
    const intact = await dryRun(build(true));
    expect(intact.lastRun.reason).toBeNull();
    expect(intact.lastRun.candidates.poolObjects).toBe(2);
  });

  test("RT10: an invalid Feed or Search current.json fails the run as pointer-read before any list", async () => {
    for (const broken of ["public/v2/current.json", "public/search/v1/current.json"]) {
      const bucket = new RetentionMemoryBucket();
      publish(bucket, day("10-21"));
      point(bucket, day("10-21"));
      bucket.set(broken, "{ not json");
      const { lastRun, report } = await dryRun(bucket);
      expect(lastRun).toMatchObject({ status: "failed", failureKind: "pointer-read", candidates: { objects: 0 } });
      expect(report).toBeNull();
      expect(bucket.lists).toBe(0);
    }
    const control = new RetentionMemoryBucket();
    publish(control, day("10-21"));
    point(control, day("10-21"));
    expect((await dryRun(control)).lastRun.status).toBe("ok");
  });

  test("RT16: a failed pool list records the error and leaves the release and evidence results reported", async () => {
    const bucket = new RetentionMemoryBucket();
    publish(bucket, day("08-01"));
    publish(bucket, day("10-20"));
    publish(bucket, day("10-21"));
    point(bucket, day("10-21"));
    bucket.failLists.push("public/search/v1/objects/details/");
    const { lastRun } = await dryRun(bucket);
    expect(lastRun).toMatchObject({ status: "failed", failureKind: "list", complete: { releases: true, evidence: true, pool: false } });
    expect(lastRun.error).toContain("failed");
    expect(lastRun.candidates.releases).toEqual({ feed: 1, search: 1 });
    expect(lastRun.candidates.evidence).toBe(1);
  });

  test("RT26: the 10-minute budget spent during the mark stops every further R2 call and counts no pool object; spent during the pool listing it stops before the next list", async () => {
    const bucket = new RetentionMemoryBucket();
    for (let at = day("09-25"); at <= day("10-21"); at += DAY) publish(bucket, at);
    point(bucket, day("10-21"));
    let clock = RUN_AT;
    let calls = 0;
    bucket.onCall = () => { calls += 1; if (calls === 10) clock = RUN_AT + 10 * 60_000; };
    const { lastRun } = await dryRun(bucket, { now: () => clock });
    expect(lastRun.status).toBe("overrun");
    expect(bucket.calls).toHaveLength(10);
    expect(lastRun.candidates).toMatchObject({ poolObjects: 0, objects: 0 });
    expect(lastRun.complete).toEqual({ releases: false, evidence: true, pool: false });

    // During the pool listing: a page limit of 1,000 means three Feed pool pages; the clock runs out after the first.
    const pools = new RetentionMemoryBucket();
    publish(pools, day("10-20"));
    publish(pools, day("10-21"));
    point(pools, day("10-21"));
    for (let index = 0; index < 2_500; index += 1) pools.set(feedPoolKey(`old-${String(index).padStart(5, "0")}`), 1, Date.parse("2026-09-01T00:00:00Z"));
    let poolClock = RUN_AT;
    pools.onCall = (op) => { if (op === "list" && pools.calls.at(-1)!.key === "public/v2/objects/details/") poolClock = RUN_AT + 10 * 60_000; };
    const stopped = await dryRun(pools, { now: () => poolClock });
    expect(stopped.lastRun.status).toBe("overrun");
    expect(pools.calls.filter((call) => call.key === "public/v2/objects/details/")).toHaveLength(1);
    expect(stopped.lastRun.candidates.poolObjects).toBe(1_000);
    expect(stopped.lastRun.complete.pool).toBe(false);

    // Control: with time left the same bucket lists all three pages.
    const full = await dryRun(pools);
    expect(full.lastRun.status).toBe("ok");
    expect(full.lastRun.candidates.poolObjects).toBe(2_500);
  });

  test("Budget: a list cap stops the run as overrun before the cap is passed", async () => {
    const bucket = new RetentionMemoryBucket();
    publish(bucket, day("10-20"));
    publish(bucket, day("10-21"));
    point(bucket, day("10-21"));
    for (let index = 0; index < 5_000; index += 1) bucket.set(feedPoolKey(`old-${String(index).padStart(5, "0")}`), 1, 0);
    const { lastRun } = await dryRun(bucket, { limits: { lists: 6 } });
    expect(lastRun.status).toBe("overrun");
    expect(lastRun.r2.classA).toBe(6);
    expect(bucket.lists).toBe(6);
  });

  test("Budget: a Dev-shaped bucket (about 1,000 hourly releases, 302,468 objects) needs at most 400 lists and 600 gets", async () => {
    const bucket = new RetentionMemoryBucket();
    let releases = 0;
    for (let at = Date.parse("2026-09-02T00:07:00Z"); at <= Date.parse("2026-10-13T22:07:00Z"); at += HOUR) { publish(bucket, at); releases += 1; }
    for (let at = day("10-14"); at <= day("10-21"); at += DAY) { publish(bucket, at); releases += 1; }
    point(bucket, day("10-21"));
    // Fill the pools up to the measured object count with old, unmarked objects.
    for (let index = 0; bucket.objects.size < 302_468; index += 1) {
      bucket.set(index % 2 === 0 ? feedPoolKey(`fill-${index}`) : searchPoolKey(`fill-${index}`), 1, Date.parse("2026-09-01T00:00:00Z"));
    }
    const { lastRun } = await dryRun(bucket);
    expect(releases).toBeGreaterThan(1_000);
    expect(lastRun.status).toBe("ok");
    expect(lastRun.r2.classA).toBeLessThanOrEqual(RETENTION_MAX_LISTS);
    expect(lastRun.r2.classB).toBeLessThanOrEqual(RETENTION_MAX_GETS);
    // Every object is listed once: 302,468 / 1,000 per page, plus one partial page per prefix.
    expect(lastRun.r2.classA).toBeGreaterThanOrEqual(Math.ceil(302_468 / 1_000));
    expect(lastRun.r2.classA).toBe(bucket.lists);
    expect(lastRun.r2.classB).toBe(bucket.gets);
  });
});

describe("Spec 029 plan helpers", () => {
  test("RT2: a release id without a time is never a candidate", () => {
    const pins = { feed: releaseIdAt(day("10-21")), search: `feed-${releaseIdAt(day("10-21"))}`, digest: [], embedding: null };
    const { candidates, retained } = classifyReleases([{ projection: "feed", id: "legacy-release" }, { projection: "feed", id: releaseIdAt(day("08-01")) }], pins, [], RUN_AT);
    expect(retained.get("feed:legacy-release")).toEqual(["unparsable"]);
    expect(candidates.map((release) => release.id)).toEqual([releaseIdAt(day("08-01"))]);
    expect(idTime(releaseIdAt(day("08-01")))).toBe(day("08-01"));
  });
});
