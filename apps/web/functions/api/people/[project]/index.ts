import { personSearchResponse } from "../../../_shared/person-search";
import type { PeopleEnv } from "../../../_shared/people";

/** `GET /api/people/:project?q=` (Spec 019 slice 3): person results for Search. */
export const onRequestGet: PagesFunction<PeopleEnv> = async ({ env, params, request }) =>
  personSearchResponse(env, params.project, new URL(request.url).searchParams.get("q"), Date.now());
