/**
 * Spec 030: `GET /api/activity?projectId=` (the project activity trend) and the digest header that
 * tells This week to show the card. Served only where `PROJECT_TREND` is "true" (Dev only since its
 * enable PR, decision 6; unset on Prod and in the local E2E configuration); elsewhere a 404 that reads nothing, and no header.
 * Every answer is `noindex`; a 200 is cached 5 minutes by clients, the reader keeps parsed months
 * 10 minutes per isolate (W29).
 */
import { readProjectActivity } from "@oss-knowledge-base/reference-pipeline/project-activity";
import type { PeopleBucket } from "@oss-knowledge-base/reference-pipeline/people";

import { PEOPLE_CACHE_CONTROL } from "./people";
import { jsonResponse } from "./r2-projection";

export interface ActivityEnv {
  readonly OSS_KB_BUCKET: R2Bucket;
  /** "true" serves the trend; anything else, or unset, answers 404 and This week shows no card. */
  readonly PROJECT_TREND?: string;
}

/** On a 200 from `/api/digest`: the page may ask `/api/activity` (Behavior 3); absent, it asks nothing. */
export const PROJECT_TREND_HEADER = "x-project-trend";

export function projectTrendEnabled(env: Pick<ActivityEnv, "PROJECT_TREND">): boolean {
  return env.PROJECT_TREND?.trim() === "true";
}

export function digestHeaders(env: Pick<ActivityEnv, "PROJECT_TREND">, status: number): Headers {
  const headers = new Headers();
  if (status === 200 && projectTrendEnabled(env)) headers.set(PROJECT_TREND_HEADER, "on");
  return headers;
}

function activityResponse(body: unknown, status: number): Response {
  return jsonResponse(body, {
    status,
    headers: { "cache-control": status === 200 ? PEOPLE_CACHE_CONTROL : "no-store", "x-robots-tag": "noindex" },
  });
}

export async function projectActivityResponse(env: ActivityEnv, projectId: string | null, nowMs: number): Promise<Response> {
  if (!projectTrendEnabled(env)) return activityResponse({ error: "Not found" }, 404);
  try {
    const result = await readProjectActivity({ bucket: env.OSS_KB_BUCKET as unknown as PeopleBucket, projectId, nowMs });
    return activityResponse(result.body, result.status);
  } catch (error) {
    return activityResponse({ error: error instanceof Error ? error.message : "Unable to read the activity trend" }, 503);
  }
}
