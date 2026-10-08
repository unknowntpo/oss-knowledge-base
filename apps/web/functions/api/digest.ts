import { readDigest } from "../_shared/digest";
import { jsonResponse } from "../_shared/r2-projection";

interface Env { readonly OSS_KB_BUCKET: R2Bucket }

/** `GET /api/digest?projectId=&locale=` (Spec 014 Behavior 13, 29). */
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const result = await readDigest(env.OSS_KB_BUCKET, url.searchParams.get("projectId"), url.searchParams.get("locale"));
  return jsonResponse(result.body, { status: result.status });
};
