/** Spec 029, dry-run slice: the retained-set rules and one dry run over an in-memory bucket. */
import { describe, expect, test } from "bun:test";

import { assertFloor, classifyReleases, idTime, resolveRetentionMode, retainedEvidence } from "../src/retention/plan";
import { RETENTION_LIST_CONCURRENCY, RETENTION_MAX_GETS, RETENTION_MAX_LISTS, runRetentionDryRun, type RetentionRunDeps } from "../src/retention/run";
import { poolFixtures, releaseFixtures, releaseIdAt, RUN_AT, testPlanRows, type RetentionCase } from "./retention.cases";
import { devShapedBucket, feedPoolKey, hexName, point, publish, RetentionMemoryBucket, searchPoolKey } from "./support/retention-bucket";

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

    // During the pool listing: 2,500 hex-named Feed pool objects in 16 key ranges listed six at a
    // time; the clock runs out at the first pool list, so no other list starts.
    const pools = new RetentionMemoryBucket();
    pools.slowLists = true;
    publish(pools, day("10-20"));
    publish(pools, day("10-21"));
    point(pools, day("10-21"));
    for (let index = 0; index < 2_500; index += 1) pools.set(feedPoolKey(hexName(index)), 1, Date.parse("2026-09-01T00:00:00Z"));
    let poolClock = RUN_AT;
    pools.onCall = (op) => { if (op === "list" && pools.calls.at(-1)!.key === "public/v2/objects/details/") poolClock = RUN_AT + 10 * 60_000; };
    const stopped = await dryRun(pools, { now: () => poolClock });
    expect(stopped.lastRun.status).toBe("overrun");
    expect(pools.calls.filter((call) => call.key === "public/v2/objects/details/")).toHaveLength(1);
    // The one list was the first range: hex names up to "…/details/1", i.e. first digit 0.
    const firstRange = [...Array(2_500).keys()].filter((index) => hexName(index).startsWith("0")).length;
    expect(firstRange).toBeGreaterThan(0);
    expect(stopped.lastRun.candidates.poolObjects).toBe(firstRange);
    expect(stopped.lastRun.complete.pool).toBe(false);

    // Control: with time left the same bucket lists all three pages.
    const full = await dryRun(pools);
    expect(full.lastRun.status).toBe("ok");
    expect(full.lastRun.candidates.poolObjects).toBe(2_500);
  });

  test("RT26: a list cap stops the run as overrun before the cap is passed, exactly, with lists in flight together", async () => {
    const bucket = new RetentionMemoryBucket();
    publish(bucket, day("10-20"));
    publish(bucket, day("10-21"));
    point(bucket, day("10-21"));
    for (let index = 0; index < 5_000; index += 1) bucket.set(feedPoolKey(hexName(index)), 1, 0);
    // Lists overlap (six in flight), and the cap is still exact.
    bucket.slowLists = true;
    const { lastRun } = await dryRun(bucket, { limits: { lists: 6 } });
    expect(lastRun.status).toBe("overrun");
    expect(lastRun.r2.classA).toBe(6);
    expect(bucket.lists).toBe(6);
    expect(bucket.maxInFlight).toBeGreaterThan(1);
    // Control: one more list is allowed with a cap of 7.
    const more = new RetentionMemoryBucket();
    for (const [key, object] of bucket.objects) more.set(key, object.body, object.uploaded);
    more.slowLists = true;
    const seven = await dryRun(more, { limits: { lists: 7 } });
    expect(seven.lastRun.r2.classA).toBe(7);
    expect(more.lists).toBe(7);
  });

  test("RT5: key ranges list every object exactly once, at most RETENTION_LIST_CONCURRENCY at a time, and report what one list at a time reports", async () => {
    const bucket = new RetentionMemoryBucket();
    bucket.slowLists = true;
    // 200 daily releases: four release ranges per projection; every hex digit in the pools.
    const times: number[] = [];
    for (let at = day("10-21") - 199 * DAY; at <= day("10-21"); at += DAY) { publish(bucket, at); times.push(at); }
    point(bucket, day("10-21"));
    for (let index = 0; index < 3_000; index += 1) bucket.set(index % 2 === 0 ? feedPoolKey(hexName(index)) : searchPoolKey(hexName(index)), 7, 0);
    // Keys exactly on a range bound belong to the range they end.
    bucket.set("public/v2/objects/details/8", 7, 0);
    bucket.set(`public/v2/releases/${releaseIdAt(times[64]!)}`, 7, 0);
    const { lastRun, report } = await dryRun(bucket);
    expect(lastRun.status).toBe("ok");
    expect(lastRun.complete).toEqual({ releases: true, evidence: true, pool: true });
    expect(bucket.maxInFlight).toBe(RETENTION_LIST_CONCURRENCY);
    // Independent count: releases before the 30-day window; 3,001 old fill objects.
    const window = times.filter((at) => at > RUN_AT - 30 * DAY).length;
    expect(lastRun.candidates.releases).toEqual({ feed: times.length - window, search: times.length - window });
    // Each candidate release also leaves its own two unmarked pool objects.
    expect(lastRun.candidates.poolObjects).toBe(3_001 + 2 * (times.length - window));
    const listed = (projection: string) => report!.candidates.releases.filter((release) => release.projection === projection);
    expect(listed("feed").reduce((sum, release) => sum + release.objects, 0)).toBe(2 * (times.length - window) + 1);
    expect(new Set(listed("feed").map((release) => release.id)).size).toBe(listed("feed").length);
    // Control: one list at a time gives the same report.
    const serial = await dryRun(bucket, { limits: { concurrency: 1 } });
    expect(serial.lastRun.candidates).toEqual(lastRun.candidates);
  });
});

describe("Spec 029 budget on the measured Dev shape (first Dev dry run, 2026-10-23)", () => {
  let built: ReturnType<typeof devShapedBucket> | undefined;
  const dev = () => (built ??= devShapedBucket());

  test("Budget: the fixture reproduces the first Dev run: 400 lists one at a time end in the Feed releases after about 465 of them", async () => {
    const { bucket, releases } = dev();
    expect(releases).toBe(1_015);
    bucket.calls.length = 0;
    const { lastRun } = await dryRun(bucket, { limits: { lists: 400, concurrency: 1 } });
    expect(lastRun.status).toBe("overrun");
    expect(lastRun.complete).toEqual({ releases: false, evidence: true, pool: false });
    expect(lastRun.r2.classA).toBe(400);
    // Measured: 465 candidate releases, all Feed; none of Search or the pools was reached.
    expect(lastRun.candidates.releases.search).toBe(0);
    expect(lastRun.candidates.releases.feed).toBeGreaterThanOrEqual(445);
    expect(lastRun.candidates.releases.feed).toBeLessThanOrEqual(485);
  }, 120_000);

  test("Budget: with the 2,000-list cap and six lists in flight the Dev-shaped run finishes", async () => {
    const { bucket, objects } = dev();
    bucket.calls.length = 0;
    const { lastRun } = await dryRun(bucket);
    expect(objects).toBeGreaterThan(1_400_000);
    expect(lastRun.status).toBe("ok");
    expect(lastRun.complete).toEqual({ releases: true, evidence: true, pool: true });
    expect(lastRun.r2.classA).toBe(bucket.lists);
    expect(lastRun.r2.classB).toBe(bucket.gets);
    // Every key listed once: at least one list per 1,000 keys, at most one extra per key range (65).
    const keys = (prefix: string) => [...bucket.objects.keys()].filter((key) => key.startsWith(prefix)).length;
    const floor = ["publication-sets/v1/", "public/v2/releases/", "public/search/v1/releases/", "public/v2/objects/details/", "public/search/v1/objects/details/"]
      .reduce((sum, prefix) => sum + Math.ceil(keys(prefix) / 1_000), 0);
    expect(lastRun.r2.classA).toBeGreaterThanOrEqual(floor);
    expect(lastRun.r2.classA).toBeLessThanOrEqual(floor + 65);
    expect(lastRun.r2.classA).toBeLessThanOrEqual(RETENTION_MAX_LISTS);
    expect(lastRun.r2.classB).toBeLessThanOrEqual(RETENTION_MAX_GETS);
    // Sequential time: one list after another at the measured ≈ 1.4 s is more than the 10 minutes;
    // in parallel rounds of six it is about a sixth of that.
    expect(lastRun.r2.classA * 1.4).toBeGreaterThan(600);
  }, 120_000);
});

describe("Spec 029 plan helpers", () => {
  test("RT2: a pinned release without evidence (pointer, digest, embedding) is still retained, and the pool is not counted", async () => {
    const bucket = new RetentionMemoryBucket();
    // A crash between the pointer switch and the evidence write: the live release has no evidence.
    publish(bucket, day("08-01"), { evidence: false });
    publish(bucket, day("08-02"), { evidence: false });
    publish(bucket, day("08-03"), { evidence: false });
    publish(bucket, day("08-04"));
    publish(bucket, day("10-20"));
    publish(bucket, day("10-21"));
    point(bucket, day("08-01"));
    bucket.set("public/digest/v1/apache-kafka/current.json", JSON.stringify({ schema: "osskb.digest-pointer.v1", sourceReleaseId: releaseIdAt(day("08-02")) }));
    const { lastRun, report } = await dryRun(bucket, { embeddingReleaseId: async () => `feed-${releaseIdAt(day("08-03"))}` });
    const retained = report!.retained.map((release) => `${release.projection}:${release.id}:${release.reasons.join("+")}`);
    expect(retained).toContain(`feed:${releaseIdAt(day("08-01"))}:pointer`);
    expect(retained).toContain(`search:feed-${releaseIdAt(day("08-01"))}:pointer`);
    expect(retained).toContain(`feed:${releaseIdAt(day("08-02"))}:digest`);
    expect(retained).toContain(`search:feed-${releaseIdAt(day("08-03"))}:embedding`);
    // Only the unpinned halves of 08-02 and 08-03, and 08-04, are candidates.
    expect(report!.candidates.releases.map((release) => `${release.projection}:${release.id}`).sort()).toEqual([
      `feed:${releaseIdAt(day("08-03"))}`, `feed:${releaseIdAt(day("08-04"))}`,
      `search:feed-${releaseIdAt(day("08-02"))}`, `search:feed-${releaseIdAt(day("08-04"))}`,
    ].sort());
    expect(lastRun.reason).toBe("evidence-missing");
    expect(lastRun.candidates.poolObjects).toBe(0);
  });

  test("RT2: a release id without a time is never a candidate", () => {
    const pins = { feed: releaseIdAt(day("10-21")), search: `feed-${releaseIdAt(day("10-21"))}`, digest: [], embedding: null };
    const { candidates, retained } = classifyReleases([{ projection: "feed", id: "legacy-release" }, { projection: "feed", id: releaseIdAt(day("08-01")) }], pins, [], RUN_AT);
    expect(retained.get("feed:legacy-release")).toEqual(["unparsable"]);
    expect(candidates.map((release) => release.id)).toEqual([releaseIdAt(day("08-01"))]);
    expect(idTime(releaseIdAt(day("08-01")))).toBe(day("08-01"));
  });
});

describe("Spec 029 dry run: verifier gaps (PR #134)", () => {
  const releasesOf = (report: Awaited<ReturnType<typeof dryRun>>["report"]) =>
    report!.candidates.releases.map((release) => `${release.projection}:${release.id}`);

  test("RT9: a non-pinned window release whose evidence cannot be parsed is kept as window, and no pool object is counted", async () => {
    const bucket = new RetentionMemoryBucket();
    publish(bucket, day("08-01"));
    const unreadable = publish(bucket, day("10-10"), { evidence: "invalid" });
    publish(bucket, day("10-20"));
    publish(bucket, day("10-21"));
    point(bucket, day("10-21"));
    const { lastRun, report } = await dryRun(bucket);
    const reasons = (projection: string, id: string) => report!.retained.find((release) => release.projection === projection && release.id === id)?.reasons;
    expect(reasons("feed", unreadable.feed)).toEqual(["window"]);
    expect(reasons("search", unreadable.search)).toEqual(["window"]);
    expect(releasesOf(report)).not.toContain(`feed:${unreadable.feed}`);
    expect(releasesOf(report)).not.toContain(`search:${unreadable.search}`);
    expect(lastRun.reason).toBe("evidence-missing");
    expect(lastRun.candidates.poolObjects).toBe(0);
    // Control: the old release is still a candidate.
    expect(releasesOf(report)).toContain(`feed:${releaseIdAt(day("08-01"))}`);
  });

  test("RT9: evidence with valid projections but the wrong schema is evidence-missing", async () => {
    const build = (schema: string) => {
      const bucket = new RetentionMemoryBucket();
      publish(bucket, day("08-01"));
      publish(bucket, day("10-20"));
      const live = publish(bucket, day("10-21"));
      point(bucket, day("10-21"));
      const key = `publication-sets/v1/github-${live.feed}.json`;
      const body = JSON.parse(bucket.objects.get(key)!.body) as Record<string, unknown>;
      bucket.set(key, JSON.stringify({ ...body, schema }), day("10-21"));
      return bucket;
    };
    const wrong = await dryRun(build("osskb.publication-set.v0"));
    expect(wrong.lastRun.reason).toBe("evidence-missing");
    expect(wrong.lastRun.candidates.poolObjects).toBe(0);
    // Control: the same body with the right schema is read.
    const right = await dryRun(build("osskb.publication-set.v1"));
    expect(right.lastRun.reason).toBeNull();
    expect(right.lastRun.candidates.poolObjects).toBe(2);
  });

  test("RT26: the get cap allows exactly its number of gets and refuses the next one", async () => {
    const build = () => {
      const bucket = new RetentionMemoryBucket();
      for (let at = day("10-15"); at <= day("10-21"); at += DAY) publish(bucket, at);
      point(bucket, day("10-21"));
      return bucket;
    };
    // 2 pointers + 1 digest pointer + 7 evidence objects.
    const needed = 10;
    const exact = build();
    const ok = await dryRun(exact, { limits: { gets: needed } });
    expect(ok.lastRun.status).toBe("ok");
    expect(exact.gets).toBe(needed);
    expect(ok.lastRun.r2.classB).toBe(needed);
    const short = build();
    const over = await dryRun(short, { limits: { gets: needed - 1 } });
    expect(over.lastRun.status).toBe("overrun");
    expect(short.gets).toBe(needed - 1);
    expect(over.lastRun.r2.classB).toBe(needed - 1);
    expect(over.lastRun.candidates.objects).toBe(0);
  });

  test("RT2: a publication set without a time token is never a candidate", async () => {
    const bucket = new RetentionMemoryBucket();
    publish(bucket, day("08-01"));
    publish(bucket, day("10-20"));
    publish(bucket, day("10-21"));
    point(bucket, day("10-21"));
    bucket.set("publication-sets/v1/legacy-set.json", 300, 0);
    const { lastRun, report } = await dryRun(bucket);
    const keys = report!.candidates.evidence.map((item) => item.key);
    expect(keys).not.toContain("publication-sets/v1/legacy-set.json");
    // Control: the old timed set is a candidate, and the untimed one counts as retained.
    expect(keys).toEqual([`publication-sets/v1/github-${releaseIdAt(day("08-01"))}.json`]);
    expect(lastRun.retained.evidence).toBe(3);
  });

  test("RT16: a failed evidence list, or a retained evidence read that throws, reports no release, evidence or pool candidate", async () => {
    const build = () => {
      const bucket = new RetentionMemoryBucket();
      publish(bucket, day("08-01"));
      publish(bucket, day("10-20"));
      publish(bucket, day("10-21"));
      point(bucket, day("10-21"));
      return bucket;
    };
    const listFails = build();
    listFails.failLists.push("publication-sets/v1/");
    const readThrows = build();
    readThrows.failGets.push(`publication-sets/v1/github-${releaseIdAt(day("10-20"))}`);
    for (const bucket of [listFails, readThrows]) {
      const { lastRun, report } = await dryRun(bucket);
      expect(lastRun.status).toBe("failed");
      expect(lastRun.complete.releases).toBe(false);
      expect(lastRun.candidates).toEqual({ releases: { feed: 0, search: 0 }, evidence: 0, poolObjects: 0, objects: 0, bytes: 0 });
      expect(report!.candidates.releases).toEqual([]);
      expect(bucket.calls.some((call) => call.op === "list" && call.key.includes("/releases/"))).toBe(false);
    }
    // Control: the same bucket without the failure reports the old release.
    expect((await dryRun(build())).lastRun.candidates.releases).toEqual({ feed: 1, search: 1 });
  });
});
