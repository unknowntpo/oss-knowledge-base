import { projectActivityResponse, type ActivityEnv } from "../_shared/activity";

/** `GET /api/activity?projectId=` (Spec 030 Behavior 1): 200 where `PROJECT_TREND` is "true", 404 elsewhere. */
export const onRequestGet: PagesFunction<ActivityEnv> = async ({ env, request }) =>
  projectActivityResponse(env, new URL(request.url).searchParams.get("projectId"), Date.now());
