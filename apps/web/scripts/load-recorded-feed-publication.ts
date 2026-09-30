import { join } from "node:path";

import {
  detailPoolKey,
  FEED_DETAIL_POOL,
  feedEntryObjectName,
  isFeedDetailMap,
  isFeedManifest,
  MANIFEST_KEY,
  type FeedDetail,
  type FeedIndex,
  type FeedPublication,
} from "@oss-knowledge-base/serving-contract";

export interface RecordedFeedPublication {
  readonly releaseId: string;
  readonly publication: FeedPublication;
}

const defaultFixturePath = join(
  import.meta.dir,
  "..",
  "test",
  "fixtures",
  "recorded-feed-publication.v1.json",
);

/**
 * POC adapter for a completed, already-recorded Feed release.
 * It intentionally performs no GitHub or other network access.
 */
export async function loadRecordedFeedPublication(
  seedRoot = join(import.meta.dir, "..", "r2-seed"),
): Promise<RecordedFeedPublication> {
  const manifest = await readJson(join(seedRoot, MANIFEST_KEY));
  if (!isFeedManifest(manifest)) {
    throw new Error(`Recorded Feed manifest is invalid: ${MANIFEST_KEY}`);
  }

  const index = await readJson(join(seedRoot, manifest.feedIndexKey));
  if (!isFeedIndex(index)) {
    throw new Error(`Recorded Feed index is invalid: ${manifest.feedIndexKey}`);
  }
  if (index.entries.length !== manifest.entryCount) {
    throw new Error(
      `Recorded Feed entry count mismatch: manifest=${manifest.entryCount}, index=${index.entries.length}`,
    );
  }

  const detailMap = manifest.schema === "osskb.feed-manifest.v3"
    ? await readJson(join(seedRoot, manifest.detailMapKey))
    : undefined;
  if (manifest.schema === "osskb.feed-manifest.v3" && !isFeedDetailMap(detailMap)) {
    throw new Error(`Recorded Feed detail map is invalid: ${manifest.detailMapKey}`);
  }
  const detailKey = (id: string): string => {
    if (manifest.schema === "osskb.feed-manifest.v2") return `${manifest.detailPrefix}${feedEntryObjectName(id)}.json`;
    const digest = isFeedDetailMap(detailMap) ? detailMap.details[id] : undefined;
    if (digest === undefined) throw new Error(`Recorded Feed detail map omits ${id}`);
    return detailPoolKey(FEED_DETAIL_POOL, digest);
  };

  const details = await Promise.all(index.entries.map(async ({ entry }) => {
    const key = detailKey(entry.id);
    const detail = await readJson(join(seedRoot, key));
    if (!isFeedDetail(detail) || detail.entry.id !== entry.id) {
      throw new Error(`Recorded Feed detail is invalid: ${key}`);
    }
    return detail;
  }));

  return {
    releaseId: manifest.releaseId,
    publication: { index, details },
  };
}

/**
 * Loads the compact, version-controlled snapshot used by clean-checkout CI.
 * Runtime publishing continues to read the manifest-first R2 seed above.
 */
export async function loadRecordedFeedFixture(
  fixturePath = defaultFixturePath,
): Promise<RecordedFeedPublication> {
  const fixture = await readJson(fixturePath);
  if (!isObject(fixture) || typeof fixture.releaseId !== "string" || !isObject(fixture.publication)) {
    throw new Error(`Recorded Feed fixture is invalid: ${fixturePath}`);
  }

  const { index, details } = fixture.publication;
  if (!isFeedIndex(index) || !Array.isArray(details) || !details.every(isFeedDetail)) {
    throw new Error(`Recorded Feed fixture has invalid publication data: ${fixturePath}`);
  }
  if (index.entries.length !== details.length) {
    throw new Error(
      `Recorded Feed fixture count mismatch: index=${index.entries.length}, details=${details.length}`,
    );
  }

  const indexedIds = new Set(index.entries.map(({ entry }) => entry.id));
  const detailIds = new Set(details.map(({ entry }) => entry.id));
  if (indexedIds.size !== index.entries.length || detailIds.size !== details.length) {
    throw new Error(`Recorded Feed fixture contains duplicate entry IDs: ${fixturePath}`);
  }
  if ([...indexedIds].some((id) => !detailIds.has(id))) {
    throw new Error(`Recorded Feed fixture index/detail membership differs: ${fixturePath}`);
  }

  return {
    releaseId: fixture.releaseId,
    publication: { index, details },
  };
}

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!await file.exists()) throw new Error(`Recorded Feed object is missing: ${path}`);
  return file.json();
}

function isFeedIndex(value: unknown): value is FeedIndex {
  if (!isObject(value)) return false;
  return value.schema === "osskb.feed-index.v2"
    && typeof value.generatedAt === "string"
    && Array.isArray(value.projects)
    && Array.isArray(value.entries)
    && value.entries.every((item) => isObject(item) && isObject(item.entry) && typeof item.entry.id === "string");
}

function isFeedDetail(value: unknown): value is FeedDetail {
  if (!isObject(value) || !isObject(value.entry)) return false;
  return typeof value.entry.id === "string" && Array.isArray(value.records);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
