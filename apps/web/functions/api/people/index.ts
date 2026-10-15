import { peopleConfigResponse, type PeopleEnv } from "../../_shared/people";

/** `GET /api/people` (Spec 019 slice 2a, W25): 200 where profiles are served, 404 elsewhere. */
export const onRequestGet: PagesFunction<PeopleEnv> = async ({ env }) => peopleConfigResponse(env, Date.now());
