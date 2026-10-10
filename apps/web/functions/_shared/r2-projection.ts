import type { FeedDetail } from "@oss-knowledge-base/domain";
import {
  detailPoolKey,
  FEED_DETAIL_POOL,
  feedEntryObjectName,
  isFeedDetailMap,
  isFeedManifest,
  MANIFEST_KEY,
  type FeedDetailMapV1,
  type FeedIndex,
  type FeedManifest,
  type FeedManifestV3,
} from "@oss-knowledge-base/serving-contract";

export { buildR2Projection, feedEntryObjectName, MANIFEST_KEY } from "@oss-knowledge-base/serving-contract";

export async function readJsonObject<T>(bucket: R2Bucket, key: string): Promise<T | undefined> {
  const object = await bucket.get(key);
  if (object === null) return undefined;
  return object.json<T>();
}

export async function readManifest(bucket: R2Bucket): Promise<FeedManifest> {
  const value = await readJsonObject<unknown>(bucket, MANIFEST_KEY);
  if (!isFeedManifest(value)) throw new Error("R2 feed manifest is missing or invalid");
  return value;
}

export async function readFeedProjection(bucket: R2Bucket): Promise<FeedIndex> {
  const manifest = await readManifest(bucket);
  const feed = await readJsonObject<FeedIndex>(bucket, manifest.feedIndexKey);
  if (feed === undefined) throw new Error(`R2 feed index is missing for release ${manifest.releaseId}`);
  return {
    ...feed,
    metadata: { ...feed.metadata, servingMode: "cloudflare-pages-function-r2", manifest },
  };
}

export async function readDetailProjection(bucket: R2Bucket, feedEntryId: string): Promise<FeedDetail | undefined> {
  const manifest = await readManifest(bucket);
  if (manifest.schema === "osskb.feed-manifest.v2") {
    return readJsonObject<FeedDetail>(bucket, `${manifest.detailPrefix}${feedEntryObjectName(feedEntryId)}.json`);
  }
  // Only the selected release's map admits an id; a pool object alone is not membership.
  const map = await readDetailMap(bucket, manifest);
  const digest = Object.hasOwn(map.details, feedEntryId) ? map.details[feedEntryId] : undefined;
  return digest === undefined ? undefined : readJsonObject<FeedDetail>(bucket, detailPoolKey(FEED_DETAIL_POOL, digest));
}

// A detail map is immutable per release, so an isolate may keep the few recent ones it served.
const detailMapCache = new WeakMap<R2Bucket, Map<string, Promise<FeedDetailMapV1>>>();
const DETAIL_MAP_CACHE_SIZE = 2;

function readDetailMap(bucket: R2Bucket, manifest: FeedManifestV3): Promise<FeedDetailMapV1> {
  const prefix = `public/v2/releases/${manifest.releaseId}/`;
  if (!manifest.detailMapKey.startsWith(prefix) || manifest.detailMapKey.includes("..")) {
    return Promise.reject(new Error("R2 feed detail map escaped its release"));
  }
  const cache = detailMapCache.get(bucket) ?? new Map<string, Promise<FeedDetailMapV1>>();
  detailMapCache.set(bucket, cache);
  const cached = cache.get(manifest.detailMapKey);
  if (cached !== undefined) return cached;

  const pending = readJsonObject<unknown>(bucket, manifest.detailMapKey).then((value) => {
    if (!isFeedDetailMap(value) || value.releaseId !== manifest.releaseId) {
      throw new Error(`R2 feed detail map is missing or invalid for release ${manifest.releaseId}`);
    }
    return value;
  });
  cache.set(manifest.detailMapKey, pending);
  pending.catch(() => cache.delete(manifest.detailMapKey));
  for (const key of cache.keys()) {
    if (cache.size <= DETAIL_MAP_CACHE_SIZE) break;
    cache.delete(key);
  }
  return pending;
}

/**
 * Spec 003 R7: a `cache-control` the caller passes is kept. Without one, a success may be
 * revalidated after 30 s and an error (status ≥ 400) is never stored, so a transient failure
 * is not replayed from a cache after R2 recovers.
 */
export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) {
    headers.set("cache-control", (init.status ?? 200) >= 400 ? "no-store" : "public, max-age=30, stale-while-revalidate=120");
  }
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(value), { ...init, headers });
}
