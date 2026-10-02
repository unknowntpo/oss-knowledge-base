import { detailPoolKey, isSha256Digest, sha256Digest, type Sha256Digest } from "./digest";
import type { FeedDetailMapV1, FeedManifest, FeedManifestV3, FeedPublication } from "./index";
import { encodeJson } from "./json-bytes";
import type { FeedReleaseDescriptorV1, ImmutableProjectionObjectV1 } from "./publication-set";

export const MANIFEST_KEY = "public/v2/current.json";
/** Shared Feed detail objects, keyed by the SHA-256 of their bytes (ADR-0013). */
export const FEED_DETAIL_POOL = "public/v2/objects/details/";
export const FEED_DETAIL_MAP_SCHEMA = "osskb.feed-detail-map.v1" as const;

export interface ProjectionObject {
  readonly key: string;
  readonly body: string;
  readonly cacheControl: string;
}

/** Safe for R2 object paths and Wrangler CLI; `_3A` is not URL-decoded in transit. */
export function feedEntryObjectName(feedEntryId: string): string {
  return encodeURIComponent(feedEntryId).replaceAll("%", "_");
}

/** An immutable object with the exact bytes its digest and byte length describe. */
export interface EncodedProjectionObject extends ImmutableProjectionObjectV1 {
  readonly body: Uint8Array;
}

/** What a streamed Feed release declares once every object has been produced. */
export interface StreamedFeedRelease {
  readonly descriptor: FeedReleaseDescriptorV1;
  readonly detailMap: FeedDetailMapV1;
}

export async function buildR2Projection(
  publication: FeedPublication,
  releaseId: string,
): Promise<readonly ProjectionObject[]> {
  const objects: ProjectionObject[] = [];
  const stream = feedProjectionObjects(publication, releaseId);
  let next = await stream.next();
  for (; !next.done; next = await stream.next()) {
    objects.push({ key: next.value.key, body: decodeBody(next.value.body), cacheControl: IMMUTABLE });
  }
  objects.push({
    key: MANIFEST_KEY,
    body: JSON.stringify(next.value.descriptor.current),
    cacheControl: "public, max-age=30, must-revalidate",
  });
  return objects;
}

/**
 * Produces a Feed release one immutable object at a time, so a caller can write and release
 * each body before the next is serialized (Spec 009). Byte-identical details share one pool
 * object; the detail map still names every entry. The return value declares the release.
 */
export async function* feedProjectionObjects(
  publication: FeedPublication,
  releaseId: string,
): AsyncGenerator<EncodedProjectionObject, StreamedFeedRelease> {
  const indexIds = new Set(publication.index.entries.map((item) => item.entry.id));
  const detailIds = new Set(publication.details.map((item) => item.entry.id));
  const missingDetails = [...indexIds].filter((id) => !detailIds.has(id));
  const orphanDetails = [...detailIds].filter((id) => !indexIds.has(id));
  if (missingDetails.length > 0 || orphanDetails.length > 0) {
    throw new Error(
      `Feed publication membership mismatch: missing details [${missingDetails.join(", ")}], orphan details [${orphanDetails.join(", ")}]`,
    );
  }

  const prefix = `public/v2/releases/${releaseId}`;
  const feedIndexKey = `${prefix}/feed/index.json`;
  const detailMapKey = `${prefix}/feed/details.json`;
  const immutableObjects: ImmutableProjectionObjectV1[] = [];
  const produce = async (key: string | undefined, value: unknown): Promise<EncodedProjectionObject> => {
    const object = await encodeProjectionObject(key, value, FEED_DETAIL_POOL);
    immutableObjects.push({ key: object.key, sha256: object.sha256, byteLength: object.byteLength });
    return object;
  };

  yield await produce(feedIndexKey, publication.index);
  const digests = new Map<string, Sha256Digest>();
  const poolKeys = new Set<string>();
  for (const detail of publication.details) {
    const object = await encodeProjectionObject(undefined, detail, FEED_DETAIL_POOL);
    digests.set(detail.entry.id, object.sha256);
    if (poolKeys.has(object.key)) continue;
    poolKeys.add(object.key);
    immutableObjects.push({ key: object.key, sha256: object.sha256, byteLength: object.byteLength });
    yield object;
  }
  const detailMap: FeedDetailMapV1 = {
    schema: FEED_DETAIL_MAP_SCHEMA,
    releaseId,
    details: Object.fromEntries([...digests].sort(([left], [right]) => left.localeCompare(right))),
  };
  yield await produce(detailMapKey, detailMap);
  const current: FeedManifestV3 = {
    schema: "osskb.feed-manifest.v3",
    releaseId,
    generatedAt: publication.index.generatedAt,
    feedIndexKey,
    detailMapKey,
    entryCount: publication.index.entries.length,
  };
  return {
    descriptor: { kind: "feed", releaseId, currentKey: MANIFEST_KEY, current, immutableObjects },
    detailMap,
  };
}

/** Serializes, digests, and names one object; a pool object is named by its digest. */
export async function encodeProjectionObject(
  key: string | undefined,
  value: unknown,
  pool: string,
): Promise<EncodedProjectionObject> {
  const body = encodeJson(value);
  const sha256 = await sha256Digest(body);
  return { key: key ?? detailPoolKey(pool, sha256), sha256, byteLength: body.byteLength, body };
}

export function decodeBody(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

export function isFeedManifest(value: unknown): value is FeedManifest {
  if (value === null || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  const common = typeof manifest.releaseId === "string"
    && typeof manifest.generatedAt === "string"
    && typeof manifest.feedIndexKey === "string"
    && typeof manifest.entryCount === "number";
  if (manifest.schema === "osskb.feed-manifest.v3") return common && typeof manifest.detailMapKey === "string";
  return manifest.schema === "osskb.feed-manifest.v2" && common && typeof manifest.detailPrefix === "string";
}

export function isFeedDetailMap(value: unknown): value is FeedDetailMapV1 {
  if (value === null || typeof value !== "object") return false;
  const map = value as Record<string, unknown>;
  return map.schema === FEED_DETAIL_MAP_SCHEMA
    && typeof map.releaseId === "string"
    && map.details !== null
    && typeof map.details === "object"
    && !Array.isArray(map.details)
    && Object.values(map.details).every(isSha256Digest);
}

const IMMUTABLE = "public, max-age=31536000, immutable";
