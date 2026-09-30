import { detailPoolKey, isSha256Digest, sha256Digest, type Sha256Digest } from "./digest";
import type { FeedDetailMapV1, FeedManifest, FeedManifestV3, FeedPublication } from "./index";

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

export async function buildR2Projection(
  publication: FeedPublication,
  releaseId: string,
): Promise<readonly ProjectionObject[]> {
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
  const digests = new Map<string, Sha256Digest>();
  // Byte-identical details share one pool object; the map still names every entry.
  const details = new Map<string, ProjectionObject>();
  for (const detail of publication.details) {
    const body = JSON.stringify(detail);
    const digest = await sha256Digest(body);
    const key = detailPoolKey(FEED_DETAIL_POOL, digest);
    digests.set(detail.entry.id, digest);
    details.set(key, { key, body, cacheControl: IMMUTABLE });
  }
  const detailMap: FeedDetailMapV1 = {
    schema: FEED_DETAIL_MAP_SCHEMA,
    releaseId,
    details: Object.fromEntries([...digests].sort(([left], [right]) => left.localeCompare(right))),
  };
  const manifest: FeedManifestV3 = {
    schema: "osskb.feed-manifest.v3",
    releaseId,
    generatedAt: publication.index.generatedAt,
    feedIndexKey,
    detailMapKey,
    entryCount: publication.index.entries.length,
  };

  return [
    { key: feedIndexKey, body: JSON.stringify(publication.index), cacheControl: IMMUTABLE },
    ...details.values(),
    { key: detailMapKey, body: JSON.stringify(detailMap), cacheControl: IMMUTABLE },
    {
      key: MANIFEST_KEY,
      body: JSON.stringify(manifest),
      cacheControl: "public, max-age=30, must-revalidate",
    },
  ];
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
