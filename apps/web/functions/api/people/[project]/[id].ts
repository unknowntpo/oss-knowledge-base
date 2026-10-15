import { personProfileResponse, type PeopleEnv } from "../../../_shared/people";

/** `GET /api/people/:project/:id` (Spec 019 slice 2a). */
export const onRequestGet: PagesFunction<PeopleEnv> = async ({ env, params }) =>
  personProfileResponse(env, params.project, params.id, Date.now());
