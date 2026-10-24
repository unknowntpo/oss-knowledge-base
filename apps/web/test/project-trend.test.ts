/**
 * Spec 030 slice 1: `GET /api/activity` over the stores of `project-trend.store.ts`, row by row
 * from `project-trend.cases.ts`, plus the flag gate (PT3) and the per-isolate cache (PT12).
 */
import { describe, expect, test } from "bun:test";

import { readProjectActivity, type ProjectActivityV1 } from "@oss-knowledge-base/reference-pipeline/project-activity";
import { readDigest } from "../functions/_shared/digest";
import { digestHeaders, projectActivityResponse, PROJECT_TREND_HEADER } from "../functions/_shared/activity";
import { trendVisible } from "../src/project-trend";
import { testPlanRows } from "./project-trend.cases";
import { CountingBucket, NOW, PROJECT_ID, store, VIEW_MONTHS, type StoreName } from "./project-trend.store";

function coverageText(body: ProjectActivityV1): string {
  const recorded = new Map<string, string[]>();
  const missing: string[] = [];
  for (const item of body.coverage) {
    if (item.status === "recorded") recorded.set(item.from.slice(0, 10), [...(recorded.get(item.from.slice(0, 10)) ?? []), item.source]);
    else missing.push(item.source);
  }
  return [...[...recorded].map(([from, sources]) => `${sources.join(", ")} from ${from}`), ...(missing.length === 0 ? [] : [`${missing.join(", ")} not recorded`])].join("; ");
}

async function read(name: StoreName, bucket = new CountingBucket(store(name))) {
  const result = await readProjectActivity({ bucket, projectId: PROJECT_ID, nowMs: NOW });
  if (result.status !== 200) throw new Error(`${name}: ${result.status}`);
  return result.body;
}

describe("Spec 030: project activity series", () => {
  test.each(testPlanRows)("$id: $case", async (row) => {
    const body = await read(row.store as StoreName);
    expect(body.months.map((month) => month.month)).toEqual([...VIEW_MONTHS]);
    const month = body.months.find((item) => item.month === row.month)!;
    expect({
      reviews: month.reviews, github: month.github, jira: month.jira, mail: month.mail,
      unavailable: body.unavailableMonths.length === 0 ? "—" : body.unavailableMonths.join(", "),
      coverage: coverageText(body),
      card: trendVisible(body) ? "shown" : "hidden",
    }).toEqual({ reviews: row.reviews, github: row.github, jira: row.jira, mail: row.mail, unavailable: row.unavailable, coverage: row.coverage, card: row.card });
  });

  test("PT1: the response is the v1 shape: 12 months, `until` the newest store update, counts of events", async () => {
    const body = await read("full");
    expect(body.schema).toBe("osskb.project-activity.v1");
    expect(body.projectId).toBe(PROJECT_ID);
    expect(body.until).toBe("2026-10-24T02:45:16.847Z");
    expect(body.months.map((month) => month.reviews)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
    expect(Object.keys(body.months[0]!).sort()).toEqual(["github", "jira", "mail", "month", "reviews"]);
  });

  test("PT2: no month before the activity log's coverage carries 0 for an activity series (positive control: recorded months do)", async () => {
    const body = await read("full");
    for (const month of body.months.slice(0, 10)) expect([month.github, month.jira, month.mail]).toEqual([null, null, null]);
    for (const month of body.months.slice(10)) for (const value of [month.github, month.jira, month.mail]) expect(typeof value).toBe("number");
  });

  test("PT1: unknown projects are refused and DataFusion has no trend in v1 (decision 5)", async () => {
    const bucket = new CountingBucket(store("full"));
    expect((await readProjectActivity({ bucket, projectId: "flink", nowMs: NOW })).status).toBe(400);
    expect((await readProjectActivity({ bucket, projectId: null, nowMs: NOW })).status).toBe(400);
    expect((await readProjectActivity({ bucket, projectId: "apache-datafusion", nowMs: NOW })).status).toBe(404);
    expect(bucket.reads).toEqual([]);
  });

  test("PT9: a malformed review store state is a 503, not a series of zeros", async () => {
    const objects = store("full");
    objects.set("internal/github-reviews/v1/apache-kafka/state.json", "{}");
    expect((await readProjectActivity({ bucket: new CountingBucket(objects), projectId: PROJECT_ID, nowMs: NOW })).status).toBe(503);
  });
});

describe("Spec 030: the flag and the Pages Function", () => {
  const env = (flag?: string) => ({ OSS_KB_BUCKET: new CountingBucket(store("full")) as unknown as R2Bucket, ...(flag === undefined ? {} : { PROJECT_TREND: flag }) });

  test("PT3: with PROJECT_TREND unset (or not \"true\") /api/activity is a 404 that reads nothing", async () => {
    for (const flag of [undefined, "", "false", "1"]) {
      const current = env(flag);
      const response = await projectActivityResponse(current, PROJECT_ID, NOW);
      expect(response.status).toBe(404);
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
      expect((current.OSS_KB_BUCKET as unknown as CountingBucket).reads).toEqual([]);
    }
  });

  test("PT3: with PROJECT_TREND unset the digest answer carries no trend header (positive control: \"true\" adds it)", async () => {
    const digest = await readDigest({ get: async () => null }, PROJECT_ID, "en");
    expect(digestHeaders({}, digest.status).has(PROJECT_TREND_HEADER)).toBe(false);
    expect(digestHeaders({ PROJECT_TREND: "true" }, 404).has(PROJECT_TREND_HEADER)).toBe(false);
    expect(digestHeaders({ PROJECT_TREND: "true" }, 200).get(PROJECT_TREND_HEADER)).toBe("on");
  });

  test("PT3: Dev Pages sets PROJECT_TREND=true (the Dev enable PR, 2026-10-24); local E2E and Prod leave it unset", async () => {
    const vars = async (name: string) => (JSON.parse(await Bun.file(new URL(`../${name}`, import.meta.url)).text()) as { vars?: Record<string, string> }).vars ?? {};
    expect((await vars("wrangler.development.jsonc")).PROJECT_TREND).toBe("true");
    for (const name of ["wrangler.jsonc", "wrangler.production.jsonc"]) expect("PROJECT_TREND" in await vars(name)).toBe(false);
  });

  test("PT13: with the flag on, a 200 is noindex, cached 5 minutes, and under 4 KB", async () => {
    const response = await projectActivityResponse(env("true"), PROJECT_ID, NOW);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=600");
    expect(new TextEncoder().encode(await response.text()).length).toBeLessThanOrEqual(4096);
    expect((await projectActivityResponse(env("true"), "flink", NOW)).status).toBe(400);
  });
});

describe("Spec 030: per-isolate cache (W29)", () => {
  test("PT12: a second request within 10 minutes makes 0 R2 reads; a cold one makes at most 26", async () => {
    const bucket = new CountingBucket(store("full"));
    await read("full", bucket);
    const cold = bucket.reads.length;
    expect(cold).toBeGreaterThan(0);
    expect(cold).toBeLessThanOrEqual(26);
    await readProjectActivity({ bucket, projectId: PROJECT_ID, nowMs: NOW + 9 * 60_000 });
    expect(bucket.reads.length).toBe(cold);
    // Positive control: past the TTL every key is read again.
    await readProjectActivity({ bucket, projectId: PROJECT_ID, nowMs: NOW + 11 * 60_000 });
    expect(bucket.reads.length).toBe(2 * cold);
  });

  test("PT12: a failed read is not cached: the next request reads that key again and counts the month", async () => {
    const key = "internal/github-reviews/v1/apache-kafka/2026-03.json";
    const bucket = new CountingBucket(store("full"), new Set([key]));
    const first = await read("full", bucket);
    expect(first.unavailableMonths).toEqual(["2026-03"]);
    bucket.broken.clear();
    const second = await readProjectActivity({ bucket, projectId: PROJECT_ID, nowMs: NOW + 60_000 });
    expect(bucket.reads.filter((read) => read === key)).toHaveLength(2);
    expect(second.status === 200 && second.body.months.find((month) => month.month === "2026-03")!.reviews).toBe(24);
  });

  test("PT12: the profile reader and the trend share one cache: a profile read first leaves the trend nothing to read for reviews", async () => {
    const { readPersonProfile } = await import("@oss-knowledge-base/reference-pipeline/people");
    const bucket = new CountingBucket(store("full"));
    await readPersonProfile({ bucket, projectKey: "kafka", personId: "github:reviewer1", nowMs: NOW });
    const before = bucket.reads.length;
    await read("full", bucket);
    expect(bucket.reads.slice(before).filter((key) => key.startsWith("internal/github-reviews/"))).toEqual([]);
  });
});
