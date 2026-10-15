/**
 * Spec 019 slice 2a: `/api/people` (whether profiles are served) and `/api/people/:project/:id`.
 * Served only where `PEOPLE_PROFILES` is "true" (Dev; W25). Every answer carries
 * `X-Robots-Tag: noindex` (W24). A profile is cached 5 minutes by clients; the review store changes
 * once a day, and the reader keeps parsed months for 10 minutes per isolate (W29).
 */
import { PEOPLE_PROJECTS, readPersonProfile, type PeopleBucket } from "@oss-knowledge-base/reference-pipeline/people";

import { jsonResponse } from "./r2-projection";

export interface PeopleEnv {
  readonly OSS_KB_BUCKET: R2Bucket;
  /** "true" serves profiles; anything else, or unset (Prod), answers 404 and no author links. */
  readonly PEOPLE_PROFILES?: string;
}

export const PEOPLE_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=600";

export function peopleEnabled(env: Pick<PeopleEnv, "PEOPLE_PROFILES">): boolean {
  return env.PEOPLE_PROFILES?.trim() === "true";
}

export function peopleResponse(body: unknown, status: number): Response {
  return jsonResponse(body, {
    status,
    headers: { "cache-control": status === 200 ? PEOPLE_CACHE_CONTROL : "no-store", "x-robots-tag": "noindex" },
  });
}

/** `GET /api/people`: the page asks once whether author names link to profiles. */
export function peopleConfigResponse(env: Pick<PeopleEnv, "PEOPLE_PROFILES">): Response {
  if (!peopleEnabled(env)) return peopleResponse({ error: "Not found" }, 404);
  return peopleResponse({ enabled: true, projects: PEOPLE_PROJECTS.map((project) => project.projectKey) }, 200);
}

export async function personProfileResponse(env: PeopleEnv, project: unknown, id: unknown, nowMs: number): Promise<Response> {
  if (!peopleEnabled(env)) return peopleResponse({ error: "Not found" }, 404);
  const single = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  let personId: string | undefined;
  try {
    const raw = single(id);
    personId = typeof raw === "string" ? decodeURIComponent(raw) : undefined;
  } catch {
    return peopleResponse({ error: "Invalid person id" }, 400);
  }
  const projectKey = single(project);
  try {
    const result = await readPersonProfile({
      bucket: env.OSS_KB_BUCKET as unknown as PeopleBucket,
      projectKey: typeof projectKey === "string" ? projectKey : undefined,
      personId,
      nowMs,
    });
    return peopleResponse(result.body, result.status);
  } catch (error) {
    return peopleResponse({ error: error instanceof Error ? error.message : "Unable to read the profile" }, 503);
  }
}
