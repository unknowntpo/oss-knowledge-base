/**
 * Spec 019 slice 3: `/api/people/:project?q=` as a Pages Function — the Dev-only gate and headers
 * (W42), and that it needs nothing but the bucket and the flag (W43).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  encodeReviewMonth,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsMonthKey,
  githubReviewsStateKey,
} from "@oss-knowledge-base/reference-pipeline";

import { onRequestGet as searchHandler } from "../functions/api/people/[project]/index";
import { PEOPLE_CACHE_CONTROL } from "../functions/_shared/people";

const webRoot = join(import.meta.dir, "..");
const month = new Date().toISOString().slice(0, 7);
const row = { reviewId: 7, pr: 1, prAuthor: "author-one", reviewer: "reviewer-one", isBot: false, state: "APPROVED", submittedAt: `${month}-01T00:00:00Z`, commit: null, inlineComments: 0 } as const;

function bucket(objects: Readonly<Record<string, string>>, reads: string[] = []): R2Bucket {
  return {
    async get(key: string) {
      reads.push(key);
      const body = objects[key];
      return body === undefined ? null : { text: async () => body };
    },
  } as unknown as R2Bucket;
}

const store = (projectId: string, reads?: string[]) => bucket({
  [githubReviewsStateKey(projectId)]: JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: new Date().toISOString(), coverageFrom: "2025-10-14T00:00:00.000Z" }),
  [githubReviewsMonthKey(projectId, month)]: encodeReviewMonth(projectId, month, [row]),
}, reads);

const call = (env: Record<string, unknown>, project: string, query: string | undefined) =>
  (searchHandler as unknown as (context: unknown) => Promise<Response>)({
    env,
    params: { project },
    request: new Request(`https://dev.example/api/people/${project}${query === undefined ? "" : `?q=${encodeURIComponent(query)}`}`),
  });

const config = (name: string) => JSON.parse(readFileSync(join(webRoot, name), "utf8")) as { vars?: Record<string, string> };

describe("Spec 019 slice 3: /api/people/:project?q=", () => {
  const dev = () => ({ ...config("wrangler.development.jsonc").vars, OSS_KB_BUCKET: store("apache-kafka") });
  const outcomes = [
    { outcome: "an exact login on Dev", env: dev, project: "kafka", query: "Reviewer-One", status: 200, people: ["github:reviewer-one exact"] },
    { outcome: "a prefix on Dev", env: dev, project: "kafka", query: "re", status: 200, people: ["github:reviewer-one prefix"] },
    { outcome: "no query on Dev", env: dev, project: "kafka", query: undefined, status: 200, people: [] },
    { outcome: "an unknown project", env: dev, project: "flink", query: "reviewer-one", status: 400, people: undefined },
    { outcome: "an unreadable review cursor", env: () => ({ PEOPLE_PROFILES: "true", OSS_KB_BUCKET: bucket({ [githubReviewsStateKey("apache-kafka")]: "{" }) }), project: "kafka", query: "reviewer-one", status: 503, people: undefined },
    { outcome: "the Prod configuration", env: () => ({ ...config("wrangler.production.jsonc").vars, OSS_KB_BUCKET: store("apache-kafka") }), project: "kafka", query: "reviewer-one", status: 404, people: undefined },
  ] as const;

  test.each([...outcomes])("W42: $outcome → $status, noindex", async (item) => {
    const response = await call(item.env(), item.project, item.query);
    expect(response.status).toBe(item.status);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("cache-control")).toBe(item.status === 200 ? PEOPLE_CACHE_CONTROL : "no-store");
    const body = await response.json() as { people?: { id: string; match: string }[]; error?: string };
    if (item.people === undefined) expect(typeof body.error).toBe("string");
    else expect(body.people?.map((person) => `${person.id} ${person.match}`)).toEqual([...item.people]);
  });

  test("W42: Prod has no PEOPLE_PROFILES and reads nothing from R2", async () => {
    expect(config("wrangler.production.jsonc").vars?.PEOPLE_PROFILES).toBeUndefined();
    const reads: string[] = [];
    expect((await call({ OSS_KB_BUCKET: store("apache-kafka", reads) }, "kafka", "reviewer-one")).status).toBe(404);
    expect(reads).toEqual([]);
  });

  test("W43: the handler needs only the bucket and the flag; a cold call reads 13 objects, a warm one none", async () => {
    const reads: string[] = [];
    const env = { PEOPLE_PROFILES: "true", OSS_KB_BUCKET: store("apache-datafusion", reads) };
    expect((await call(env, "datafusion", "author")).status).toBe(200);
    expect(reads.length).toBe(13);
    expect((await call(env, "datafusion", "reviewer-one")).status).toBe(200);
    expect(reads.length).toBe(13);
  });
});
