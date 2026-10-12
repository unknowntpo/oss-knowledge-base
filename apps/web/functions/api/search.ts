import { jsonResponse } from "../_shared/r2-projection";
import { SearchClientError, searchR2Projection } from "../_shared/search-projection";
import { semanticSearchOptions, type SemanticSearchEnv } from "../_shared/semantic-gate";

interface Env extends SemanticSearchEnv { readonly OSS_KB_BUCKET: R2Bucket }

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const projectIds = url.searchParams.getAll("projectId").filter(Boolean);
  const sourceInstanceIds = url.searchParams.getAll("sourceInstanceId").filter(Boolean);
  const projectStatuses = url.searchParams.getAll("projectStatus").filter(Boolean);
  const tags = url.searchParams.getAll("tag").filter(Boolean);
  const occurredAfter = url.searchParams.get("occurredAfter") || undefined;
  const occurredBefore = url.searchParams.get("occurredBefore") || undefined;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  try {
    return jsonResponse(await searchR2Projection(env.OSS_KB_BUCKET, {
      query,
      limit,
      ...(
        projectIds.length === 0 && sourceInstanceIds.length === 0 &&
          projectStatuses.length === 0 && tags.length === 0 &&
          occurredAfter === undefined && occurredBefore === undefined
          ? {}
          : {
              filters: {
                ...(projectIds.length === 0 ? {} : { projectIds }),
                ...(sourceInstanceIds.length === 0 ? {} : { sourceInstanceIds }),
                ...(projectStatuses.length === 0 ? {} : { projectStatuses }),
                ...(tags.length === 0 ? {} : { tags }),
                ...(occurredAfter === undefined ? {} : { occurredAfter }),
                ...(occurredBefore === undefined ? {} : { occurredBefore }),
              },
            }
      ),
    }, semanticSearchOptions(env, url)));
  } catch (error) {
    const clientError = error instanceof SearchClientError;
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unable to search evidence" },
      { status: clientError ? 400 : 503, headers: { "cache-control": "no-store" } },
    );
  }
};
