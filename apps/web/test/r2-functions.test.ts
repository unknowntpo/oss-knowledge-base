import { describe, expect, test } from "bun:test";

import {
  buildR2Projection,
  MANIFEST_KEY,
  readDetailProjection,
  readFeedProjection,
} from "../functions/_shared/r2-projection";
import {
  buildR2SearchProjection,
  detailPoolKey,
  FEED_DETAIL_POOL,
  feedEntryObjectName,
  SEARCH_CURRENT_KEY,
  SEARCH_DETAIL_POOL,
  sha256Digest,
  type FeedPublication,
  type ProjectionObject,
  type SearchLexicalShardV1,
} from "@oss-knowledge-base/serving-contract";
import { onRequestGet as detailHandler } from "../functions/api/detail/[id]";
import {
  readSearchDetailProjection,
  searchR2Projection,
} from "../functions/_shared/search-projection";
import { buildGoldenSearchPublication } from "../scripts/build-search-fixture";
import { legacyV2SearchObjects } from "./legacy-search-release";

const searchFixturePath = new URL(
  "../../../packages/search/test/fixtures/golden-queries.v1.json",
  import.meta.url,
).pathname;

function fixture(): FeedPublication {
  const record = {
    id: "kafka:github:issue:1",
    projectId: "apache-kafka",
    sourceInstanceId: "kafka:github",
    source: "github",
    sourceType: "code-host",
    kind: "GitHub Issue",
    title: "Issue #1: Durable feed",
    excerpt: "Evidence",
    author: "contributor",
    role: "Contributor",
    occurredAt: "2026-08-21T00:00:00Z",
    canonicalUrl: "https://github.com/apache/kafka/issues/1",
    sourceVersion: "2026-08-21T00:00:00Z",
  } as const;
  const entry = {
    id: "feed-entry:kafka:1",
    projectId: "apache-kafka",
    title: "Durable feed",
    summary: "Evidence",
    sourceTitleRecordId: record.id,
    recordIds: [record.id],
    highlightedRecordIds: [record.id],
    reason: { kind: "trending", label: "1 event", evidenceEventIds: ["event:1"] },
    activity: { score: 1, evidenceEventIds: ["event:1"] },
    grouping: { relationshipIds: [], clusteringRevision: "fixture@1" },
  } as const;
  const detail = {
    entry,
    records: [record],
    connections: [],
    keyPoints: { status: "unavailable", reason: "generator-not-configured" },
  } as const;
  return {
    index: {
      schema: "osskb.feed-index.v2",
      generatedAt: "2026-08-21T01:00:00Z",
      sourceTypes: { github: { key: "github", label: "GitHub", full: "GitHub" } },
      projects: [{
        key: "kafka", label: "Apache Kafka", profileVersion: "kafka@1",
        statusPolicyRef: "github@1", statusFacetKey: "filter.status.github",
        sources: ["github"], statuses: [{ key: "open", label: "Open" }],
      }],
      entries: [{
        displayId: "KAFKA-ISSUE-1",
        projectKey: "kafka",
        status: "open",
        releaseLabel: "Issue #1",
        authors: ["contributor"],
        tags: ["Issue"],
        links: { github: record.canonicalUrl },
        sourceCounts: { github: 1 },
        lastActivityAt: record.occurredAt,
        searchText: "Durable feed Evidence contributor",
        entry,
      }],
      metadata: { source: "fixture" },
    },
    details: [detail],
  };
}

function memoryBucket(objects: readonly { readonly key: string; readonly body: string }[]): R2Bucket {
  const values = new Map(objects.map((object) => [object.key, object.body]));
  return {
    get: async (key: string) => {
      const body = values.get(key);
      return body === undefined ? null : { json: async <T>() => JSON.parse(body) as T };
    },
  } as unknown as R2Bucket;
}

describe("versioned R2 feed projection", () => {
  test("publishes immutable release objects before the mutable manifest", async () => {
    const objects = await buildR2Projection(fixture(), "release-1");
    expect(objects.at(-1)?.key).toBe(MANIFEST_KEY);
    expect(objects.filter((object) => object.key.includes("/details/"))).toHaveLength(1);
  });

  test("hydrates FeedIndex and FeedDetail through the current manifest", async () => {
    const objects = await buildR2Projection(fixture(), "release-1");
    const bucket = memoryBucket(objects);
    const feed = await readFeedProjection(bucket);
    const detail = await readDetailProjection(bucket, "feed-entry:kafka:1");

    expect(feed.entries[0]?.entry.id).toBe("feed-entry:kafka:1");
    expect(feed.metadata.servingMode).toBe("cloudflare-pages-function-r2");
    expect(detail?.records[0]?.id).toBe("kafka:github:issue:1");
  });

  test("rejects a publication whose index and details disagree", async () => {
    const publication = fixture();
    await expect(buildR2Projection({ ...publication, details: [] }, "release-1"))
      .rejects.toThrow("membership mismatch");
  });

  test("C4: serves the same FeedDetail body from a v3 release and an older v2 release", async () => {
    const current = await readDetailProjection(
      memoryBucket(await buildR2Projection(fixture(), "release-1")),
      "feed-entry:kafka:1",
    );
    const legacy = await readDetailProjection(
      memoryBucket(legacyFeedObjects(fixture(), "release-0")),
      "feed-entry:kafka:1",
    );

    expect(current).toEqual(fixture().details[0]!);
    expect(legacy).toEqual(current);
  });

  test("C5: an id absent from the release map is 404 even when its pool object exists", async () => {
    const publication = fixture();
    const older = await buildR2Projection(publication, "release-1");
    const newer = await buildR2Projection({
      index: { ...publication.index, entries: [] },
      details: [],
    }, "release-2");
    const pooled = older.filter((object) => object.key.startsWith(FEED_DETAIL_POOL));
    const bucket = memoryBucket([...older.filter((object) => object.key !== MANIFEST_KEY), ...newer]);

    expect(pooled).toHaveLength(1);
    expect(await readDetailProjection(bucket, "feed-entry:kafka:1")).toBeUndefined();
    const response = await detailHandler({
      env: { OSS_KB_BUCKET: bucket },
      params: { id: "feed-entry:kafka:1" },
    } as unknown as Parameters<typeof detailHandler>[0]);
    expect(response.status).toBe(404);
  });

  test("rejects a v3 detail map outside its release", async () => {
    const objects = (await buildR2Projection(fixture(), "release-1")).map((object) => {
      if (object.key !== MANIFEST_KEY) return object;
      const manifest = JSON.parse(object.body);
      return { ...object, body: JSON.stringify({ ...manifest, detailMapKey: "public/v2/releases/other/feed/details.json" }) };
    });

    await expect(readDetailProjection(memoryBucket(objects), "feed-entry:kafka:1"))
      .rejects.toThrow("detail map escaped its release");
  });

  test("fails closed when current manifest is missing", async () => {
    await expect(readFeedProjection(memoryBucket([]))).rejects.toThrow("manifest is missing or invalid");
  });
});

describe("versioned R2 Search projection", () => {
  test("publishes immutable shards and details before the mutable pointer", async () => {
    const objects = await buildR2SearchProjection(
      await buildGoldenSearchPublication(searchFixturePath),
    );

    expect(objects.at(-1)?.key).toBe(SEARCH_CURRENT_KEY);
    expect(objects.filter((object) => object.key.includes("/lexical/"))).toHaveLength(2);
    expect(objects.filter((object) => object.key.startsWith(SEARCH_DETAIL_POOL))).not.toHaveLength(0);
  });

  test("C4: serves the same Search bodies from a v2 release and an older v1 release", async () => {
    const objects = await legacyV2SearchObjects(await buildR2SearchProjection(await buildGoldenSearchPublication(searchFixturePath)));
    const current = memoryBucket(objects);
    const legacy = memoryBucket(await legacySearchObjects(objects));
    const response = await searchR2Projection(current, { query: "KIP-405", limit: 3 });

    expect(await searchR2Projection(legacy, { query: "KIP-405", limit: 3 })).toEqual(response);
    for (const result of response.results) {
      const detail = await readSearchDetailProjection(current, result.detailRef);
      expect(detail).toBeDefined();
      expect(await readSearchDetailProjection(legacy, result.detailRef)).toEqual(detail);
    }
  });

  test("rejects a Search group digest that its release does not declare", async () => {
    const objects = await buildR2SearchProjection(await buildGoldenSearchPublication(searchFixturePath));
    const response = await searchR2Projection(memoryBucket(objects), { query: "KIP-405", limit: 1 });
    const tampered = objects.map((object) => {
      if (!object.key.includes("/lexical/")) return object;
      const shard = JSON.parse(object.body) as SearchLexicalShardV1;
      return {
        ...object,
        body: JSON.stringify({
          ...shard,
          groups: shard.groups.map((group) => ({ ...group, detailSha256: `sha256:${"c".repeat(64)}` })),
        }),
      };
    });

    await expect(readSearchDetailProjection(memoryBucket(tampered), response.results[0]!.detailRef))
      .rejects.toThrow("not declared by its release");
  });

  test("searches evidence and hydrates the same FeedDetail contract", async () => {
    const objects = await buildR2SearchProjection(
      await buildGoldenSearchPublication(searchFixturePath),
    );
    const bucket = memoryBucket(objects);
    const response = await searchR2Projection(bucket, { query: "KIP-405", limit: 3 });

    expect(response.results[0]?.entry.sourceTitleRecordId).toBe("kafka:wiki:kip-405");
    expect(response.results[0]?.matches[0]?.canonicalUrl).toStartWith("https://");
    const detail = await readSearchDetailProjection(bucket, response.results[0]!.detailRef);
    expect(detail?.entry.reason.kind).toBe("search-match");
    expect(detail?.records.map((record) => record.id)).toContain("kafka:mail:kip-405-compaction");
  });

  test("applies project-scoped status and evidence-time filters", async () => {
    const objects = await buildR2SearchProjection(
      await buildGoldenSearchPublication(searchFixturePath),
    );
    const bucket = memoryBucket(objects);
    const merged = await searchR2Projection(bucket, {
      query: "producer",
      filters: {
        projectIds: ["apache-kafka"],
        projectStatuses: ["merged"],
      },
      limit: 10,
    });
    const historical = await searchR2Projection(bucket, {
      query: "tiered storage",
      filters: {
        projectIds: ["apache-kafka"],
        occurredBefore: "2022-01-01T00:00:00Z",
      },
      limit: 10,
    });

    expect(merged.results.map((result) => result.entry.sourceTitleRecordId))
      .toEqual(["kafka:github:pr:23203"]);
    expect(merged.results[0]?.projectStatus).toBe("merged");
    expect(historical.results[0]?.matches.every((match) =>
      match.occurredAt < "2022-01-01T00:00:00Z"))
      .toBeTrue();
  });

  test("returns project facets before the project filter and limit", async () => {
    const objects = await buildR2SearchProjection(
      await buildGoldenSearchPublication(searchFixturePath),
    );
    const bucket = memoryBucket(objects);
    const response = await searchR2Projection(bucket, {
      query: "issue 20983",
      filters: {
        projectIds: ["apache-datafusion"],
        occurredAfter: "2026-08-22T00:00:00Z",
      },
      limit: 10,
    });

    expect(response.facets.projects).toEqual([
      { projectId: "apache-datafusion", count: 1 },
      { projectId: "apache-kafka", count: 1 },
    ]);
    expect(response.results).toHaveLength(1);
    expect(response.results.every((result) => result.entry.projectId === "apache-datafusion"))
      .toBeTrue();
    expect(response.results).toHaveLength(
      response.facets.projects.find((facet) => facet.projectId === "apache-datafusion")?.count ?? -1,
    );
  });

  test("C6: an immutable detailRef survives a later current release", async () => {
    const firstObjects = await buildR2SearchProjection(
      await buildGoldenSearchPublication(searchFixturePath, "search-release-1"),
    );
    const firstResponse = await searchR2Projection(memoryBucket(firstObjects), {
      query: "RecordAccumulator.ready()",
      limit: 1,
    });
    const secondObjects = await buildR2SearchProjection(
      await buildGoldenSearchPublication(searchFixturePath, "search-release-2"),
    );
    const combined = [
      ...firstObjects.filter((object) => object.key !== SEARCH_CURRENT_KEY),
      ...secondObjects,
    ];

    const detail = await readSearchDetailProjection(
      memoryBucket(combined),
      firstResponse.results[0]!.detailRef,
    );
    expect(detail?.entry.title).toContain("RecordAccumulator.ready()");
    expect(detail?.entry.reason.kind).toBe("search-match");
  });

  test("C6: a detailRef from an older search-release.v1 resolves after a newer release switches", async () => {
    const firstObjects = await legacySearchObjects(await legacyV2SearchObjects(await buildR2SearchProjection(
      await buildGoldenSearchPublication(searchFixturePath, "search-release-1"),
    )));
    const firstResponse = await searchR2Projection(memoryBucket(firstObjects), {
      query: "RecordAccumulator.ready()",
      limit: 1,
    });
    const secondObjects = await buildR2SearchProjection(
      await buildGoldenSearchPublication(searchFixturePath, "search-release-2"),
    );
    const bucket = memoryBucket([
      ...firstObjects.filter((object) => object.key !== SEARCH_CURRENT_KEY),
      ...secondObjects,
    ]);

    const detail = await readSearchDetailProjection(bucket, firstResponse.results[0]!.detailRef);
    expect(detail?.entry.title).toContain("RecordAccumulator.ready()");
  });

  test("rejects a partial Search publication before the current pointer exists", async () => {
    const publication = await buildGoldenSearchPublication(searchFixturePath);
    await expect(buildR2SearchProjection({ ...publication, details: [] }))
      .rejects.toThrow("membership mismatch");
  });
});

/** The pre-ADR-0013 Feed layout: feed-manifest.v2 with release-scoped details. */
function legacyFeedObjects(publication: FeedPublication, releaseId: string): readonly ProjectionObject[] {
  const prefix = `public/v2/releases/${releaseId}`;
  const immutable = "public, max-age=31536000, immutable";
  return [
    { key: `${prefix}/feed/index.json`, body: JSON.stringify(publication.index), cacheControl: immutable },
    ...publication.details.map((detail) => ({
      key: `${prefix}/details/${feedEntryObjectName(detail.entry.id)}.json`,
      body: JSON.stringify(detail),
      cacheControl: immutable,
    })),
    {
      key: MANIFEST_KEY,
      body: JSON.stringify({
        schema: "osskb.feed-manifest.v2",
        releaseId,
        generatedAt: publication.index.generatedAt,
        feedIndexKey: `${prefix}/feed/index.json`,
        detailPrefix: `${prefix}/details/`,
        entryCount: publication.index.entries.length,
      }),
      cacheControl: "public, max-age=30, must-revalidate",
    },
  ];
}

/** Rewrites a search-release.v2 projection into the pre-ADR-0013 search-release.v1 layout. */
async function legacySearchObjects(objects: readonly ProjectionObject[]): Promise<readonly ProjectionObject[]> {
  const bodies = new Map(objects.map((object) => [object.key, object.body]));
  const manifestObject = objects.find((object) => object.key.endsWith("/manifest.json"))!;
  const manifest = JSON.parse(manifestObject.body);
  const prefix = manifestObject.key.slice(0, -"manifest.json".length);
  const detailPrefix = `${prefix}details/`;
  const data: ProjectionObject[] = [];
  for (const key of Object.values(manifest.shardKeys) as string[]) {
    const shard = JSON.parse(bodies.get(key)!) as SearchLexicalShardV1;
    for (const group of shard.groups) {
      data.push({
        key: `${detailPrefix}${feedEntryObjectName(group.groupRootRecordId)}.json`,
        body: bodies.get(detailPoolKey(SEARCH_DETAIL_POOL, group.detailSha256!))!,
        cacheControl: manifestObject.cacheControl,
      });
    }
    const groups = shard.groups.map(({ detailSha256: _digest, ...group }) => group);
    data.push({ key, body: JSON.stringify({ ...shard, groups }), cacheControl: manifestObject.cacheControl });
  }
  const objectDigests = Object.fromEntries(await Promise.all(data.map(async (object) =>
    [object.key, await sha256Digest(object.body)] as const)));
  const { objectDigests: _current, ...rest } = manifest;
  return [
    ...data,
    {
      ...manifestObject,
      body: JSON.stringify({ ...rest, schema: "osskb.search-release.v1", detailPrefix, objectDigests }),
    },
    objects.find((object) => object.key === SEARCH_CURRENT_KEY)!,
  ];
}
