/**
 * Spec 019 slice 3: `/api/people/:project?q=`, person results for Search. Same gate and headers
 * as the profile (W42): served only where `PEOPLE_PROFILES` is "true", always `noindex`. Reads
 * only the review store, through the profile's per-isolate cache (W43).
 */
import { searchPeople } from "@oss-knowledge-base/reference-pipeline/people/search";
import type { PeopleBucket } from "@oss-knowledge-base/reference-pipeline/people";

import { peopleEnabled, peopleResponse, type PeopleEnv } from "./people";

export async function personSearchResponse(env: PeopleEnv, project: unknown, query: string | null, nowMs: number): Promise<Response> {
  if (!peopleEnabled(env)) return peopleResponse({ error: "Not found" }, 404);
  const projectKey = Array.isArray(project) ? project[0] : project;
  const result = await searchPeople({
    bucket: env.OSS_KB_BUCKET as unknown as PeopleBucket,
    projectKey: typeof projectKey === "string" ? projectKey : undefined,
    query,
    nowMs,
  });
  return peopleResponse(result.body, result.status);
}
