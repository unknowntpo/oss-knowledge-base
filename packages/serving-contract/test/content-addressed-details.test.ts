import { describe, expect, test } from "bun:test";

import {
  buildPublicationSetV1,
  buildR2Projection,
  buildR2SearchProjection,
  FEED_DETAIL_POOL,
  MANIFEST_KEY,
  materializeSearchPublicationFromFeed,
  promotePublicationSet,
  publicationSetValidationIssues,
  SEARCH_CURRENT_KEY,
  SEARCH_DETAIL_POOL,
  sha256Digest,
  type FeedPublication,
  type ImmutableProjectionObjectV1,
  type ProjectionObject,
  type PublicationObjectStore,
  type PublicationSetV1,
} from "../src";
import { feedFixture, fixtureGeneratedAt } from "./feed-fixture";

// Spec 008 acceptance C1-C3 at the contract and promotion boundary.
describe("content-addressed detail objects", () => {
  test("writes feed-manifest.v3 and search-release.v3 whose details are named by their digest", async () => {
    const { feedObjects, searchObjects } = await release(feedFixture(), "r1");
    const manifest = JSON.parse(feedObjects.find((object) => object.key === MANIFEST_KEY)!.body);
    const map = JSON.parse(feedObjects.find((object) => object.key === manifest.detailMapKey)!.body);

    expect(manifest).toMatchObject({ schema: "osskb.feed-manifest.v3", entryCount: 2 });
    expect(manifest.detailMapKey).toBe("public/v2/releases/r1/feed/details.json");
    expect(manifest.detailPrefix).toBeUndefined();
    expect(Object.keys(map.details).sort()).toEqual(["feed-entry:datafusion:2", "feed-entry:kafka:1"]);
    for (const object of poolObjects(feedObjects, FEED_DETAIL_POOL)) {
      expect(object.key).toBe(`${FEED_DETAIL_POOL}${(await sha256Digest(object.body)).slice(7)}.json`);
    }
    const searchManifest = JSON.parse(searchObjects.find((object) => object.key.endsWith("/manifest.json"))!.body);
    expect(searchManifest.schema).toBe("osskb.search-release.v3");
    expect(searchManifest.detailPrefix).toBeUndefined();
    for (const object of poolObjects(searchObjects, SEARCH_DETAIL_POOL)) {
      expect(searchManifest.objectDigests[object.key]).toBe(await sha256Digest(object.body));
    }
  });

  test("C1: republishing the same content writes no new detail objects", async () => {
    const destination = new MemoryStore();
    const first = await release(feedFixture(), "r1");
    const second = await release(feedFixture(), "r2");
    expect(poolKeys(second)).toEqual(poolKeys(first));

    expect((await promotePublicationSet(first.publicationSet, first.source, destination)).ok).toBe(true);
    destination.created.length = 0;
    const result = await promotePublicationSet(second.publicationSet, second.source, destination);

    expect(result).toMatchObject({ ok: true, copiedObjectCount: 6, reusedObjectCount: 4 });
    expect(destination.created.filter(isPoolKey)).toEqual([]);
    expect(destination.created.sort()).toEqual([
      "public/search/v1/releases/search-r2/lexical/apache-datafusion/0.json",
      "public/search/v1/releases/search-r2/lexical/apache-kafka/1.json",
      "public/search/v1/releases/search-r2/manifest.json",
      "public/search/v1/releases/search-r2/terms.json",
      "public/v2/releases/r2/feed/details.json",
      "public/v2/releases/r2/feed/index.json",
    ]);
    const searchPointer = destination.events.lastIndexOf(`current:${SEARCH_CURRENT_KEY}`);
    const feedPointer = destination.events.lastIndexOf(`current:${MANIFEST_KEY}`);
    expect(destination.events.at(-1)).toBe(`current:${MANIFEST_KEY}`);
    expect(searchPointer).toBeGreaterThan(destination.events.lastIndexOf(
      "immutable:public/search/v1/releases/search-r2/manifest.json"));
    expect(feedPointer).toBeGreaterThan(searchPointer);
  });

  test("C2: one changed thread writes exactly one new Feed and one new Search detail", async () => {
    const destination = new MemoryStore();
    const first = await release(feedFixture(), "r1");
    const second = await release(changeOneThread(feedFixture()), "r2");
    await promotePublicationSet(first.publicationSet, first.source, destination);
    destination.created.length = 0;

    const result = await promotePublicationSet(second.publicationSet, second.source, destination);

    expect(result.ok).toBe(true);
    expect(destination.created.filter((key) => key.startsWith(FEED_DETAIL_POOL))).toHaveLength(1);
    expect(destination.created.filter((key) => key.startsWith(SEARCH_DETAIL_POOL))).toHaveLength(1);
  });

  test("a verified store reuses existing pool keys without reading them back", async () => {
    const destination = new MemoryStore({ verified: true });
    const first = await release(feedFixture(), "r1");
    const second = await release(feedFixture(), "r2");
    await promotePublicationSet(first.publicationSet, first.source, destination);
    destination.reads.length = 0;

    const result = await promotePublicationSet(second.publicationSet, second.source, destination);

    expect(result).toMatchObject({ ok: true, copiedObjectCount: 6, reusedObjectCount: 4 });
    expect(destination.reads.filter(isPoolKey)).toEqual([]);
  });

  test("C3: a pool key whose name differs from its digest fails validation before any pointer", async () => {
    const { publicationSet, source } = await release(feedFixture(), "r1");
    const renamed = structuredClone(publicationSet) as Mutable;
    const pooled = renamed.projections[0].immutableObjects.find((object) => isPoolKey(object.key))!;
    pooled.key = `${FEED_DETAIL_POOL}${"0".repeat(64)}.json`;
    const destination = new MemoryStore();

    expect(publicationSetValidationIssues(renamed)).toContain(
      `${pooled.key} is a feed detail pool key whose name differs from its sha256`,
    );
    expect(await promotePublicationSet(renamed as PublicationSetV1, source, destination))
      .toMatchObject({ ok: false, kind: "invalid-publication-set" });
    expect(destination.events).toEqual([]);
  });

  test("C3: pool bytes that differ from their name fail before any pointer", async () => {
    const { publicationSet, source, feedObjects, searchObjects } = await release(feedFixture(), "r1");
    const pooled = poolObjects(searchObjects, SEARCH_DETAIL_POOL)[0]!;
    source.seed(pooled.key, `${pooled.body} `);
    const destination = new MemoryStore();

    expect(await promotePublicationSet(publicationSet, source, destination))
      .toMatchObject({ ok: false, kind: "source-object-mismatch", objectKey: pooled.key });
    expect(destination.events).toEqual([]);

    const forged = feedObjects.map((object) => object.key.startsWith(FEED_DETAIL_POOL)
      ? { ...object, body: `${object.body} ` }
      : object);
    await expect(buildSet(forged, searchObjects)).rejects.toThrow("name differs from its sha256");
  });

  test("rejects a Search group whose detail digest is malformed instead of throwing", async () => {
    const { feedObjects, searchObjects } = await release(feedFixture(), "r1");
    const manifestObject = searchObjects.find((object) => object.key.endsWith("/manifest.json"))!;
    const manifest = JSON.parse(manifestObject.body);
    const shardKey = (manifest.shards as { key: string }[])[0]!.key;
    const shard = JSON.parse(searchObjects.find((object) => object.key === shardKey)!.body);
    shard.groups[0].detailSha256 = "not-a-digest";
    const shardBody = JSON.stringify(shard);
    manifest.objectDigests[shardKey] = await sha256Digest(shardBody);
    const edited = searchObjects.map((object) => object.key === shardKey
      ? { ...object, body: shardBody }
      : object.key === manifestObject.key ? { ...object, body: JSON.stringify(manifest) } : object);

    await expect(buildSet(feedObjects, edited)).rejects.toThrow("names an undeclared detail");
  });

  test("rejects a Feed detail map whose count or members disagree with the release", async () => {
    const { feedObjects, searchObjects } = await release(feedFixture(), "r1");
    const mapKey = "public/v2/releases/r1/feed/details.json";
    const withMap = (edit: (details: Record<string, string>) => void) => feedObjects.map((object) => {
      if (object.key !== mapKey) return object;
      const map = JSON.parse(object.body);
      edit(map.details);
      return { ...object, body: JSON.stringify(map) };
    });

    await expect(buildSet(withMap((details) => { delete details["feed-entry:kafka:1"]; }), searchObjects))
      .rejects.toThrow("count does not match entryCount");
    await expect(buildSet(withMap((details) => {
      details["feed-entry:kafka:1"] = `sha256:${"a".repeat(64)}`;
    }), searchObjects)).rejects.toThrow("undeclared detail");
  });

  test("Feed and Search pools never cross", async () => {
    const { publicationSet } = await release(feedFixture(), "r1");
    const crossed = structuredClone(publicationSet) as Mutable;
    const pooled = crossed.projections[0].immutableObjects.find((object) => isPoolKey(object.key))!;
    pooled.key = pooled.key.replace(FEED_DETAIL_POOL, SEARCH_DETAIL_POOL);

    expect(publicationSetValidationIssues(crossed)).toContain(
      "feed immutable object key must belong to public/v2/releases/r1/ or public/v2/objects/details/",
    );
  });

  test("identical details share one pool key; a conflicting digest for one key is rejected", async () => {
    const { publicationSet } = await release(feedFixture(), "r1");
    const repeated = structuredClone(publicationSet) as Mutable;
    const feed = repeated.projections[0];
    const pooled = feed.immutableObjects.find((object) => isPoolKey(object.key))!;
    feed.immutableObjects.push({ ...pooled });
    expect(publicationSetValidationIssues(repeated)).toEqual([]);

    feed.immutableObjects.push({ ...pooled, sha256: `sha256:${"b".repeat(64)}` });
    expect(publicationSetValidationIssues(repeated)).toContain("feed immutable object keys must be unique");
  });
});

interface Release {
  readonly feedObjects: readonly ProjectionObject[];
  readonly searchObjects: readonly ProjectionObject[];
  readonly publicationSet: PublicationSetV1;
  readonly source: MemoryStore;
}

async function release(feed: FeedPublication, id: string): Promise<Release> {
  const feedObjects = await buildR2Projection(feed, id);
  const searchObjects = await buildR2SearchProjection(await materializeSearchPublicationFromFeed({
    feed,
    indexRevision: `search-${id}`,
    corpusRevision: `feed:${id}`,
    generatedAt: fixtureGeneratedAt,
  }));
  const source = new MemoryStore();
  for (const object of [...feedObjects, ...searchObjects]) {
    if (object.key !== MANIFEST_KEY && object.key !== SEARCH_CURRENT_KEY) source.seed(object.key, object.body);
  }
  return { feedObjects, searchObjects, publicationSet: await buildSet(feedObjects, searchObjects), source };
}

async function buildSet(
  feedObjects: readonly ProjectionObject[],
  searchObjects: readonly ProjectionObject[],
): Promise<PublicationSetV1> {
  return buildPublicationSetV1({
    id: "content-addressed-fixture",
    generatedAt: fixtureGeneratedAt,
    inputDigest: await sha256Digest("fixture input"),
    materializerRevision: "fixture@1",
    feedObjects,
    searchObjects,
  });
}

function changeOneThread(feed: FeedPublication): FeedPublication {
  const [kafka, datafusion] = feed.details;
  return {
    ...feed,
    details: [kafka!, {
      ...datafusion!,
      records: datafusion!.records.map((record) => ({ ...record, excerpt: `${record.excerpt} Edited.` })),
    }],
  };
}

function poolObjects(objects: readonly ProjectionObject[], pool: string): readonly ProjectionObject[] {
  return objects.filter((object) => object.key.startsWith(pool));
}

function poolKeys(value: Release): readonly string[] {
  return [...value.feedObjects, ...value.searchObjects].map((object) => object.key).filter(isPoolKey).sort();
}

function isPoolKey(key: string): boolean {
  return key.startsWith(FEED_DETAIL_POOL) || key.startsWith(SEARCH_DETAIL_POOL);
}

type Mutable = {
  projections: [
    { immutableObjects: { key: string; sha256: `sha256:${string}`; byteLength: number }[] },
    { immutableObjects: { key: string; sha256: `sha256:${string}`; byteLength: number }[] },
  ];
};

class MemoryStore implements PublicationObjectStore {
  readonly events: string[] = [];
  readonly created: string[] = [];
  readonly reads: string[] = [];
  readonly putVerifiedImmutableIfAbsent?: PublicationObjectStore["putVerifiedImmutableIfAbsent"];
  private readonly objects = new Map<string, Uint8Array>();

  constructor(options: { readonly verified?: boolean } = {}) {
    if (options.verified === true) {
      this.putVerifiedImmutableIfAbsent = async (object: ImmutableProjectionObjectV1, body: Uint8Array) => {
        if (await sha256Digest(body) !== object.sha256) throw new Error(`checksum mismatch: ${object.key}`);
        return this.putImmutableIfAbsent(object.key, body);
      };
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.reads.push(key);
    return this.objects.get(key)?.slice();
  }

  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, body.slice());
    this.events.push(`immutable:${key}`);
    this.created.push(key);
    return "created";
  }

  async putCurrent(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body.slice());
    this.events.push(`current:${key}`);
  }

  seed(key: string, body: string): void {
    this.objects.set(key, new TextEncoder().encode(body));
  }
}
