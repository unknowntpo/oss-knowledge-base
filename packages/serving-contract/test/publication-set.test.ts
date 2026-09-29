import { describe, expect, test } from "bun:test";

import {
  buildPublicationSetV1,
  MANIFEST_KEY,
  promotePublicationSet,
  publicationSetValidationIssues,
  SEARCH_CURRENT_KEY,
  sha256Digest,
  verifyPublicationSetSource,
  type ProjectionObject,
  type PublicationObjectStore,
  type PublicationSetV1,
} from "../src";

const generatedAt = "2026-08-26T04:00:00.000Z";

describe("PublicationSetV1", () => {
  test("builds one release-scoped Feed and Search descriptor and verifies every source byte", async () => {
    const fixture = await publicationFixture();

    expect(publicationSetValidationIssues(fixture.publicationSet)).toEqual([]);
    expect(fixture.publicationSet.projections.map((item) => item.kind)).toEqual(["feed", "search"]);
    expect(await verifyPublicationSetSource(fixture.publicationSet, fixture.source)).toEqual({
      ok: true,
      verifiedObjectCount: 5,
    });
  });

  test("rejects a cross-release immutable key before publication", async () => {
    const fixture = await publicationFixture();
    const invalid = structuredClone(fixture.publicationSet) as MutablePublicationSet;
    invalid.projections[0].immutableObjects[0]!.key = "public/v2/releases/other/feed/index.json";

    expect(publicationSetValidationIssues(invalid)).toContain(
      "feed immutable object key must belong to public/v2/releases/feed-r1/",
    );
  });

  test("rejects a set without exactly one Feed and one Search projection", async () => {
    const fixture = await publicationFixture();
    const invalid = structuredClone(fixture.publicationSet) as MutablePublicationSet;
    invalid.projections[1] = structuredClone(invalid.projections[0]!);

    expect(publicationSetValidationIssues(invalid)).toContain(
      "Publication set must contain exactly one Feed and one Search projection",
    );
  });

  test("reports a missing source object before promotion writes anything", async () => {
    const fixture = await publicationFixture();
    fixture.source.remove(fixture.keys.searchDetail);
    const destination = new MemoryPublicationStore();

    const result = await promotePublicationSet(fixture.publicationSet, fixture.source, destination);

    expect(result).toMatchObject({
      ok: false,
      kind: "source-object-missing",
      objectKey: fixture.keys.searchDetail,
    });
    expect(destination.events).toEqual([]);
  });

  test("rejects a Search manifest that omits a declared immutable object", async () => {
    const fixture = await publicationFixture();
    const invalid = structuredClone(fixture.publicationSet) as MutablePublicationSet;
    const search = invalid.projections.find((item) => item.kind === "search")!;
    const manifest = search.immutableObjects.find((item) => item.key.endsWith("/manifest.json"))!;
    const body = JSON.stringify({
      schema: "osskb.search-release.v1",
      indexRevision: "search-r1",
      corpusRevision: "fixture:v1",
      lexicalRevision: "bm25:v1",
      generatedAt,
      shardKeys: { "apache-kafka": fixture.keys.searchShard },
      detailPrefix: "public/search/v1/releases/search-r1/details/",
      chunkCount: 1,
      groupCount: 1,
      objectDigests: {
        [fixture.keys.searchShard]: await sha256Digest(fixture.bodies.searchShard),
      },
    });
    fixture.source.seed(manifest.key, body);
    manifest.byteLength = encode(body).byteLength;
    manifest.sha256 = await sha256Digest(body);

    const result = await verifyPublicationSetSource(invalid as PublicationSetV1, fixture.source);
    expect(result).toMatchObject({ ok: false, kind: "source-manifest-invalid" });
  });
});

describe("verified publication promotion", () => {
  test("copies exact immutable bytes and writes each current pointer last", async () => {
    const fixture = await publicationFixture();
    const destination = new MemoryPublicationStore();

    const result = await promotePublicationSet(fixture.publicationSet, fixture.source, destination);

    expect(result).toEqual({
      ok: true,
      copiedObjectCount: 5,
      reusedObjectCount: 0,
      switchedProjections: ["search", "feed"],
      unchangedProjections: [],
    });
    for (const projection of fixture.publicationSet.projections) {
      for (const object of projection.immutableObjects) {
        expect(destination.bytes(object.key)).toEqual(fixture.source.bytes(object.key));
      }
    }
    expect(destination.events.indexOf(`current:${SEARCH_CURRENT_KEY}`)).toBeGreaterThan(
      destination.events.lastIndexOf("immutable:public/search/v1/releases/search-r1/manifest.json"),
    );
    expect(destination.events.indexOf(`current:${MANIFEST_KEY}`)).toBeGreaterThan(
      destination.events.lastIndexOf("immutable:public/v2/releases/feed-r1/details/entry-1.json"),
    );
  });

  test("copies immutable objects concurrently but still switches each pointer after its objects", async () => {
    const fixture = await publicationFixture();
    const destination = new SlowPublicationStore();

    const result = await promotePublicationSet(fixture.publicationSet, fixture.source, destination, { concurrency: 4 });

    expect(result.ok && result.copiedObjectCount).toBe(5);
    expect(destination.maxInFlight).toBeGreaterThan(1);
    for (const projection of fixture.publicationSet.projections) {
      const pointer = destination.events.indexOf(`current:${projection.currentKey}`);
      for (const object of projection.immutableObjects) {
        expect(destination.events.indexOf(`immutable:${object.key}`)).toBeLessThan(pointer);
      }
    }
  });

  test("a verified single-request store needs no destination reads for new objects", async () => {
    const fixture = await publicationFixture();
    const destination = new VerifiedPublicationStore();

    const result = await promotePublicationSet(fixture.publicationSet, fixture.source, destination);

    expect(result.ok && result.copiedObjectCount).toBe(5);
    expect(destination.reads.filter((key) => !key.endsWith("current.json"))).toEqual([]);
    const repeated = await promotePublicationSet(fixture.publicationSet, fixture.source, destination);
    expect(repeated.ok && repeated.reusedObjectCount).toBe(5);
  });

  test("a verified store still fails closed when an existing object differs", async () => {
    const fixture = await publicationFixture();
    const conflicting = fixture.publicationSet.projections[0]!.immutableObjects[0]!.key;
    const destination = new VerifiedPublicationStore();
    destination.seed(conflicting, "different bytes");

    const result = await promotePublicationSet(fixture.publicationSet, fixture.source, destination);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("destination-conflict");
  });

  test("fails closed on an immutable-key conflict without overwriting or switching that projection", async () => {
    const fixture = await publicationFixture();
    const destination = new MemoryPublicationStore();
    destination.seed(fixture.keys.feedIndex, "different immutable bytes");

    const result = await promotePublicationSet(fixture.publicationSet, fixture.source, destination);

    expect(result).toMatchObject({
      ok: false,
      kind: "destination-conflict",
      projectionKind: "feed",
      objectKey: fixture.keys.feedIndex,
    });
    expect(decode(destination.bytes(fixture.keys.feedIndex)!)).toBe("different immutable bytes");
    expect(destination.bytes(SEARCH_CURRENT_KEY)).toBeDefined();
    expect(destination.bytes(MANIFEST_KEY)).toBeUndefined();
  });

  test("re-promoting the current set validates but performs no duplicate writes", async () => {
    const fixture = await publicationFixture();
    const destination = new MemoryPublicationStore();
    expect((await promotePublicationSet(fixture.publicationSet, fixture.source, destination)).ok).toBe(true);
    const eventCount = destination.events.length;

    const repeated = await promotePublicationSet(fixture.publicationSet, fixture.source, destination);

    expect(repeated).toEqual({
      ok: true,
      copiedObjectCount: 0,
      reusedObjectCount: 5,
      switchedProjections: [],
      unchangedProjections: ["search", "feed"],
    });
    expect(destination.events).toHaveLength(eventCount);
  });

  test("a destination write failure leaves switched and unswitched projections independently complete", async () => {
    const fixture = await publicationFixture();
    const destination = new MemoryPublicationStore();
    destination.failImmutableKey = fixture.keys.feedDetail;

    const result = await promotePublicationSet(fixture.publicationSet, fixture.source, destination);

    expect(result).toMatchObject({ ok: false, kind: "store-error", projectionKind: "feed" });
    expect(destination.bytes(SEARCH_CURRENT_KEY)).toBeDefined();
    expect(destination.bytes(MANIFEST_KEY)).toBeUndefined();
    expect(destination.bytes(fixture.keys.searchManifest)).toBeDefined();
  });
});

interface Fixture {
  readonly publicationSet: PublicationSetV1;
  readonly source: MemoryPublicationStore;
  readonly keys: {
    readonly feedIndex: string;
    readonly feedDetail: string;
    readonly searchShard: string;
    readonly searchDetail: string;
    readonly searchManifest: string;
  };
  readonly bodies: {
    readonly searchShard: string;
    readonly searchDetail: string;
  };
}

async function publicationFixture(): Promise<Fixture> {
  const keys = {
    feedIndex: "public/v2/releases/feed-r1/feed/index.json",
    feedDetail: "public/v2/releases/feed-r1/details/entry-1.json",
    searchShard: "public/search/v1/releases/search-r1/lexical/apache-kafka.json",
    searchDetail: "public/search/v1/releases/search-r1/details/record-1.json",
    searchManifest: "public/search/v1/releases/search-r1/manifest.json",
  } as const;
  const bodies = {
    searchShard: JSON.stringify({ schema: "fixture-search-shard", records: ["record-1"] }),
    searchDetail: JSON.stringify({ schema: "fixture-feed-detail", id: "record-1" }),
  } as const;
  const searchManifest = JSON.stringify({
    schema: "osskb.search-release.v1",
    indexRevision: "search-r1",
    corpusRevision: "fixture:v1",
    lexicalRevision: "bm25:v1",
    generatedAt,
    shardKeys: { "apache-kafka": keys.searchShard },
    detailPrefix: "public/search/v1/releases/search-r1/details/",
    chunkCount: 1,
    groupCount: 1,
    objectDigests: {
      [keys.searchShard]: await sha256Digest(bodies.searchShard),
      [keys.searchDetail]: await sha256Digest(bodies.searchDetail),
    },
  });
  const feedObjects: readonly ProjectionObject[] = [
    immutable(keys.feedIndex, JSON.stringify({ schema: "osskb.feed-index.v2", entries: ["entry-1"] })),
    immutable(keys.feedDetail, JSON.stringify({ schema: "fixture-feed-detail", id: "entry-1" })),
    current(MANIFEST_KEY, JSON.stringify({
      schema: "osskb.feed-manifest.v2",
      releaseId: "feed-r1",
      generatedAt,
      feedIndexKey: keys.feedIndex,
      detailPrefix: "public/v2/releases/feed-r1/details/",
      entryCount: 1,
    })),
  ];
  const searchObjects: readonly ProjectionObject[] = [
    immutable(keys.searchShard, bodies.searchShard),
    immutable(keys.searchDetail, bodies.searchDetail),
    immutable(keys.searchManifest, searchManifest),
    current(SEARCH_CURRENT_KEY, JSON.stringify({
      schema: "osskb.search-current.v1",
      indexRevision: "search-r1",
      releaseManifestKey: keys.searchManifest,
      generatedAt,
    })),
  ];
  const publicationSet = await buildPublicationSetV1({
    id: "publication-fixture-r1",
    generatedAt,
    inputDigest: await sha256Digest("completed Kafka/DataFusion input"),
    materializerRevision: "typescript-reference@1",
    feedObjects,
    searchObjects,
  });
  const source = new MemoryPublicationStore([...feedObjects, ...searchObjects]
    .filter((object) => object.key !== MANIFEST_KEY && object.key !== SEARCH_CURRENT_KEY)
    .map((object) => [object.key, encode(object.body)]));
  return { publicationSet, source, keys, bodies };
}

class MemoryPublicationStore implements PublicationObjectStore {
  readonly events: string[] = [];
  failImmutableKey?: string;
  private readonly objects = new Map<string, Uint8Array>();

  constructor(entries: readonly (readonly [string, Uint8Array])[] = []) {
    for (const [key, body] of entries) this.objects.set(key, body.slice());
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key)?.slice();
  }

  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    if (key === this.failImmutableKey) throw new Error(`Injected immutable write failure: ${key}`);
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, body.slice());
    this.events.push(`immutable:${key}`);
    return "created";
  }

  async putCurrent(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body.slice());
    this.events.push(`current:${key}`);
  }

  seed(key: string, body: string): void {
    this.objects.set(key, encode(body));
  }

  remove(key: string): void {
    this.objects.delete(key);
  }

  bytes(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.slice();
  }
}

class VerifiedPublicationStore extends MemoryPublicationStore {
  readonly reads: string[] = [];

  override async get(key: string): Promise<Uint8Array | undefined> {
    this.reads.push(key);
    return super.get(key);
  }

  async putVerifiedImmutableIfAbsent(
    object: { readonly key: string; readonly sha256: string },
    body: Uint8Array,
  ): Promise<"created" | "exists"> {
    if (await sha256Digest(body) !== object.sha256) throw new Error(`checksum mismatch: ${object.key}`);
    return super.putImmutableIfAbsent(object.key, body);
  }
}

class SlowPublicationStore extends MemoryPublicationStore {
  maxInFlight = 0;
  private inFlight = 0;

  override async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.inFlight -= 1;
    return super.putImmutableIfAbsent(key, body);
  }
}

type MutablePublicationSet = {
  -readonly [Key in keyof PublicationSetV1]: Key extends "projections"
    ? Array<{
        -readonly [DescriptorKey in keyof PublicationSetV1["projections"][number]]:
          DescriptorKey extends "immutableObjects"
            ? Array<{ -readonly [ObjectKey in keyof PublicationSetV1["projections"][number]["immutableObjects"][number]]:
              PublicationSetV1["projections"][number]["immutableObjects"][number][ObjectKey] }>
            : PublicationSetV1["projections"][number][DescriptorKey]
      }>
    : PublicationSetV1[Key]
};

function immutable(key: string, body: string): ProjectionObject {
  return { key, body, cacheControl: "public, max-age=31536000, immutable" };
}

function current(key: string, body: string): ProjectionObject {
  return { key, body, cacheControl: "public, max-age=30, must-revalidate" };
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}
