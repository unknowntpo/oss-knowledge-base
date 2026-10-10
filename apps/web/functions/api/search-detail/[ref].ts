import { jsonResponse } from "../../_shared/r2-projection";
import { readSearchDetailProjection } from "../../_shared/search-projection";

interface Env { readonly OSS_KB_BUCKET: R2Bucket }

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const value = Array.isArray(params.ref) ? params.ref[0] : params.ref;
  if (typeof value !== "string" || value.length === 0) {
    return jsonResponse({ error: "Search detailRef is required" }, { status: 400 });
  }
  try {
    const detail = await readSearchDetailProjection(env.OSS_KB_BUCKET, decodeURIComponent(value));
    return detail === undefined
      ? jsonResponse({ error: "FeedDetail not found for this Search result" }, { status: 404 })
      : jsonResponse(detail);
  } catch (error) {
    const invalid = error instanceof Error && error.message.includes("detailRef is invalid");
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unable to read Search FeedDetail" },
      { status: invalid ? 400 : 503, headers: { "cache-control": "no-store" } },
    );
  }
};
