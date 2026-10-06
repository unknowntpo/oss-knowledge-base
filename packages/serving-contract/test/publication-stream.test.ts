import { describe, expect, test } from "bun:test";

import {
  encodeJson,
  FEED_DETAIL_POOL,
  feedProjectionObjects,
  MANIFEST_KEY,
  materializeSearchPublicationFromFeed,
  publishProjectionStreams,
  SEARCH_CURRENT_KEY,
  searchGroupsFromPublication,
  searchProjectionObjects,
  sha256Digest,
  type EncodedProjectionObject,
  type FeedPublication,
  type ProjectionStreams,
  type PublicationObjectStore,
  type StreamedSearchRelease,
} from "../src";
import { feedFixture, fixtureGeneratedAt } from "./feed-fixture";

describe("encodeJson", () => {
  test("produces exactly the UTF-8 bytes of JSON.stringify", () => {
    const sparse: unknown[] = [1];
    sparse[3] = "after a hole";
    const values: unknown[] = [
      feedFixture(),
      { text: "two-byte … text — with 測試 and 😀", lone: "\ud800", quote: "\"\\\n\t" },
      { skipped: undefined, fn: () => 1, nested: { deeper: { deepest: [undefined, () => 1, Symbol("s")] } } },
      { numbers: [0, -0, 1.5e-7, Number.NaN, Number.POSITIVE_INFINITY], date: new Date(0), boxed: [new String("s"), new Number(2)] },
      { withToJson: { toJSON: () => ({ replaced: true }) }, sparse, empty: [[], {}] },
      "top-level string",
      [{ entries: [{ id: 1 }, { id: 2 }] }],
    ];
    for (const value of values) {
      expect(encodeJson(value)).toEqual(new TextEncoder().encode(JSON.stringify(value)));
    }
  });
});

describe("Spec 009 streamed publication", () => {
  test("writes every object once, then switches Search before Feed", async () => {
    const destination = new MemoryStore();

    const result = await publishProjectionStreams(setInput(), await streams(feedFixture()), destination, { concurrency: 3 });

    expect(result).toMatchObject({ ok: true, switchedProjections: ["search", "feed"] });
    const pointers = destination.events.filter((event) => event.startsWith("current:"));
    expect(pointers).toEqual([`current:${SEARCH_CURRENT_KEY}`, `current:${MANIFEST_KEY}`]);
    expect(destination.events.indexOf(pointers[0]!)).toBe(destination.events.length - 2);
    if (!result.ok) return;
    for (const projection of result.publicationSet.projections) {
      for (const object of projection.immutableObjects) {
        const body = destination.body(object.key)!;
        expect(body.byteLength).toBe(object.byteLength);
        expect(await sha256Digest(body)).toBe(object.sha256);
      }
    }
  });

  test("a rerun reuses existing pool keys without reading them back", async () => {
    const destination = new MemoryStore({ verified: true });
    expect((await publishProjectionStreams(setInput(), await streams(feedFixture()), destination)).ok).toBe(true);
    destination.reads.length = 0;

    const result = await publishProjectionStreams(setInput(), await streams(feedFixture()), destination);

    expect(result).toMatchObject({ ok: true, copiedObjectCount: 0, unchangedProjections: ["search", "feed"] });
    expect(destination.reads.filter((key) => key.includes("/objects/details/"))).toEqual([]);
  });

  test("M5: a pool key whose name differs from its digest switches no pointer and is never written", async () => {
    const destination = new MemoryStore();
    destination.seedPointers();
    const input = await streams(feedFixture());
    const misnamed = `${FEED_DETAIL_POOL}${"0".repeat(64)}.json`;
    input.feed = rename(input.feed!, (object) => object.key.startsWith(FEED_DETAIL_POOL), misnamed);

    const result = await publishProjectionStreams(setInput(), input, destination);

    expect(result).toMatchObject({ ok: false, kind: "invalid-publication-set", objectKey: misnamed });
    expect(destination.events.filter((event) => event.startsWith("current:"))).toEqual([]);
    expect(destination.body(misnamed)).toBeUndefined();
    expect(destination.pointers()).toEqual(["old-search", "old-feed"]);
  });

  test("cross-object invariants are checked on the descriptors before any pointer", async () => {
    const destination = new MemoryStore();
    destination.seedPointers();
    const input = await streams(feedFixture());
    input.search = withRelease(input.search!, (release) => ({
      ...release,
      manifest: { ...release.manifest, groupCount: release.manifest.groupCount + 1 },
    }));

    const result = await publishProjectionStreams(setInput(), input, destination);

    expect(result).toMatchObject({ ok: false, kind: "source-manifest-invalid" });
    expect(destination.events.filter((event) => event.startsWith("current:"))).toEqual([]);
    expect(destination.pointers()).toEqual(["old-search", "old-feed"]);
  });

  test("stops writing after a failed write and releases the consumed stream", async () => {
    const destination = new MemoryStore({ failOnWrite: 2 });
    destination.seedPointers();
    const input = await streams(feedFixture());

    const result = await publishProjectionStreams(setInput(), input, destination, { concurrency: 1 });

    expect(result).toMatchObject({ ok: false, kind: "store-error" });
    expect(destination.events.filter((event) => event.startsWith("immutable:"))).toHaveLength(1);
    expect(destination.pointers()).toEqual(["old-search", "old-feed"]);
    // Search failed first, so the Feed stream was never started.
    expect(input.search).toBeUndefined();
    expect(input.feed).toBeDefined();
  });
});

function setInput() {
  return {
    id: "streamed-fixture",
    generatedAt: fixtureGeneratedAt,
    inputDigest: `sha256:${"1".repeat(64)}` as const,
    materializerRevision: "fixture@1",
  };
}

async function streams(feed: FeedPublication): Promise<ProjectionStreams> {
  const search = await materializeSearchPublicationFromFeed({
    feed,
    indexRevision: "search-r1",
    corpusRevision: "feed:r1",
    generatedAt: fixtureGeneratedAt,
  });
  return { search: searchProjectionObjects(search, searchGroupsFromPublication(search)), feed: feedProjectionObjects(feed, "r1") };
}

async function* rename<R>(
  stream: AsyncGenerator<EncodedProjectionObject, R>,
  match: (object: EncodedProjectionObject) => boolean,
  key: string,
): AsyncGenerator<EncodedProjectionObject, R> {
  let renamed = false;
  for (let next = await stream.next(); ; next = await stream.next()) {
    if (next.done) return next.value;
    const object = !renamed && match(next.value) ? { ...next.value, key } : next.value;
    renamed ||= object !== next.value;
    yield object;
  }
}

async function* withRelease(
  stream: AsyncGenerator<EncodedProjectionObject, StreamedSearchRelease>,
  edit: (release: StreamedSearchRelease) => StreamedSearchRelease,
): AsyncGenerator<EncodedProjectionObject, StreamedSearchRelease> {
  for (let next = await stream.next(); ; next = await stream.next()) {
    if (next.done) return edit(next.value);
    yield next.value;
  }
}

class MemoryStore implements PublicationObjectStore {
  readonly events: string[] = [];
  readonly reads: string[] = [];
  readonly putVerifiedImmutableIfAbsent?: PublicationObjectStore["putVerifiedImmutableIfAbsent"];
  private readonly objects = new Map<string, Uint8Array>();
  private writes = 0;

  constructor(private readonly options: { readonly failOnWrite?: number; readonly verified?: boolean } = {}) {
    if (options.verified === true) {
      this.putVerifiedImmutableIfAbsent = async (object, body) => {
        if (await sha256Digest(body) !== object.sha256) throw new Error(`checksum mismatch: ${object.key}`);
        return this.putImmutableIfAbsent(object.key, body);
      };
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.reads.push(key);
    return this.objects.get(key);
  }

  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    this.writes += 1;
    if (this.writes === this.options.failOnWrite) throw new Error(`injected failure at ${key}`);
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, body.slice());
    this.events.push(`immutable:${key}`);
    return "created";
  }

  async putCurrent(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body.slice());
    this.events.push(`current:${key}`);
  }

  body(key: string): Uint8Array | undefined {
    return this.objects.get(key);
  }

  seedPointers(): void {
    this.objects.set(SEARCH_CURRENT_KEY, new TextEncoder().encode("old-search"));
    this.objects.set(MANIFEST_KEY, new TextEncoder().encode("old-feed"));
  }

  pointers(): readonly string[] {
    return [SEARCH_CURRENT_KEY, MANIFEST_KEY].map((key) => new TextDecoder().decode(this.objects.get(key)));
  }
}
