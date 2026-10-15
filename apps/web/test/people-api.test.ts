/**
 * Spec 019 slice 2a: `/api/people` and `/api/people/:project/:id` as Pages Functions — the
 * Dev-only gate (W25), `noindex` on every answer (W24), cache headers (W29), status codes (W11).
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

import { onRequestGet as configHandler } from "../functions/api/people/index";
import { onRequestGet as profileHandler } from "../functions/api/people/[project]/[id]";
import { PEOPLE_CACHE_CONTROL } from "../functions/_shared/people";

const webRoot = join(import.meta.dir, "..");
const month = new Date().toISOString().slice(0, 7);
const row = { reviewId: 7, pr: 1, prAuthor: "author-one", reviewer: "reviewer-one", isBot: false, state: "APPROVED", submittedAt: `${month}-01T00:00:00Z`, commit: null, inlineComments: 0 } as const;

function bucket(objects: Readonly<Record<string, string>>): R2Bucket {
  return {
    async get(key: string) {
      if (key.includes("explode")) throw new Error("R2 is down");
      const body = objects[key];
      return body === undefined ? null : { text: async () => body };
    },
  } as unknown as R2Bucket;
}

const store = (projectId: string) => bucket({
  [githubReviewsStateKey(projectId)]: JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: new Date().toISOString(), coverageFrom: "2025-10-14T00:00:00.000Z" }),
  [githubReviewsMonthKey(projectId, month)]: encodeReviewMonth(projectId, month, [row]),
});

const call = (handler: unknown, env: Record<string, unknown>, params: Record<string, string> = {}) =>
  (handler as (context: unknown) => Promise<Response>)({ env, params, request: new Request("https://dev.example/api/people") });

/** Wrangler configs carry no comments, so JSON.parse reads them. */
const config = (name: string) => JSON.parse(readFileSync(join(webRoot, name), "utf8")) as { vars?: Record<string, string> };

describe("Spec 019 slice 2a: /api/people", () => {
  const dev = { OSS_KB_BUCKET: store("apache-kafka"), PEOPLE_PROFILES: "true" };
  const datafusion = { OSS_KB_BUCKET: store("apache-datafusion"), PEOPLE_PROFILES: "true" };
  const outcomes = [
    { outcome: "a profile", env: dev, params: { project: "kafka", id: "github%3Areviewer-one" }, status: 200 },
    { outcome: "a profile of another community", env: datafusion, params: { project: "datafusion", id: "github:author-one" }, status: 200 },
    { outcome: "an unknown identity", env: dev, params: { project: "kafka", id: "github:nobody" }, status: 404 },
    { outcome: "an unknown project", env: dev, params: { project: "flink", id: "github:reviewer-one" }, status: 400 },
    { outcome: "a malformed id", env: dev, params: { project: "kafka", id: "%E0%A4%A" }, status: 400 },
    { outcome: "R2 failing", env: { OSS_KB_BUCKET: bucket({ [githubReviewsStateKey("apache-kafka")]: "{" }), PEOPLE_PROFILES: "true" }, params: { project: "kafka", id: "github:reviewer-one" }, status: 503 },
    { outcome: "profiles off (Prod)", env: { OSS_KB_BUCKET: store("apache-kafka") }, params: { project: "kafka", id: "github:reviewer-one" }, status: 404 },
  ] as const;

  test.each([...outcomes])("W24: $outcome → $status with X-Robots-Tag: noindex", async (item) => {
    const response = await call(profileHandler, item.env, item.params);
    expect(response.status).toBe(item.status);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    // W29 / Spec 003 R7: a profile may be kept 5 minutes; an error never.
    expect(response.headers.get("cache-control")).toBe(item.status === 200 ? PEOPLE_CACHE_CONTROL : "no-store");
    expect(Object.hasOwn(await response.json() as object, "error")).toBe(item.status !== 200);
  });

  test("W24: the configuration route carries noindex in both states", async () => {
    for (const env of [{ PEOPLE_PROFILES: "true" }, {}]) {
      expect((await call(configHandler, env)).headers.get("x-robots-tag")).toBe("noindex");
    }
  });

  test("W25: Dev and local serve profiles; Prod does not, and its /api/people answers 404", async () => {
    expect(config("wrangler.development.jsonc").vars?.PEOPLE_PROFILES).toBe("true");
    expect(config("wrangler.jsonc").vars?.PEOPLE_PROFILES).toBe("true");
    const prod = config("wrangler.production.jsonc");
    expect(prod.vars?.PEOPLE_PROFILES).toBeUndefined();

    const off = await call(configHandler, prod.vars ?? {});
    expect(off.status).toBe(404);
    const offProfile = await call(profileHandler, { ...(prod.vars ?? {}), OSS_KB_BUCKET: store("apache-kafka") }, { project: "kafka", id: "github:reviewer-one" });
    expect(offProfile.status).toBe(404);
    // Positive control: the Dev configuration serves both.
    const on = await call(configHandler, config("wrangler.development.jsonc").vars ?? {});
    // Slice 2b adds `recorded`; without a bucket nothing is recorded.
    expect([on.status, await on.json()]).toEqual([200, { enabled: true, projects: ["kafka", "datafusion"], recorded: {} }]);
    const onProfile = await call(profileHandler, { ...config("wrangler.development.jsonc").vars, OSS_KB_BUCKET: store("apache-kafka") }, { project: "kafka", id: "github:reviewer-one" });
    expect(onProfile.status).toBe(200);
  });

  test("W25: only the exact value true turns profiles on", async () => {
    for (const value of ["", "false", "1", "on", "TRUE"]) {
      expect((await call(configHandler, { PEOPLE_PROFILES: value })).status).toBe(404);
    }
    expect((await call(configHandler, { PEOPLE_PROFILES: " true " })).status).toBe(200);
  });
});
