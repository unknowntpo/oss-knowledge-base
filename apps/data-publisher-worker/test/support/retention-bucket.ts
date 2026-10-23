/**
 * Spec 029: an in-memory bucket for the retention dry run. It records every call by billing class
 * (`list` is Class A, `get` Class B) and also exposes `put` and `delete`, which record and throw,
 * so a test proves the dry run never calls them.
 */
import { releaseIdAt } from "../retention.cases";

export interface StoredObject { readonly body: string; readonly uploaded: number }

export class RetentionMemoryBucket {
  readonly objects = new Map<string, StoredObject>();
  readonly calls: { readonly op: "get" | "list" | "put" | "delete"; readonly key: string }[] = [];
  /** Throws from the next list of a prefix starting with this value. */
  readonly failLists: string[] = [];
  /** Called before every request, e.g. to advance a fake clock. */
  onCall: (op: "get" | "list") => void = () => undefined;

  get lists(): number { return this.calls.filter((call) => call.op === "list").length; }
  get gets(): number { return this.calls.filter((call) => call.op === "get").length; }
  get writes(): number { return this.calls.filter((call) => call.op === "put" || call.op === "delete").length; }

  private sorted: string[] | null = null;

  set(key: string, body: string | number, uploaded = 0): void {
    this.objects.set(key, { body: typeof body === "number" ? "x".repeat(body) : body, uploaded });
    this.sorted = null;
  }

  private keysFrom(prefix: string): { readonly keys: readonly string[]; readonly first: number } {
    this.sorted ??= [...this.objects.keys()].sort();
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.sorted[mid]! < prefix) low = mid + 1;
      else high = mid;
    }
    return { keys: this.sorted, first: low };
  }

  /** Throws from every get of a key starting with one of these values. */
  readonly failGets: string[] = [];

  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    this.calls.push({ op: "get", key });
    this.onCall("get");
    if (this.failGets.some((prefix) => key.startsWith(prefix))) throw new Error(`get ${key} failed`);
    const object = this.objects.get(key);
    return object === undefined ? null : { text: async () => object.body };
  }

  /** When true, every list resolves on a later macrotask, so concurrent lists overlap. */
  slowLists = false;
  /** Lists started and not yet answered, and the most seen at once. */
  inFlight = 0;
  maxInFlight = 0;

  async list(options: { readonly prefix: string; readonly cursor?: string; readonly startAfter?: string; readonly limit?: number }) {
    this.calls.push({ op: "list", key: options.prefix });
    this.onCall("list");
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.slowLists) await new Promise((resolve) => setTimeout(resolve, 0));
      return this.page(options);
    } finally {
      this.inFlight -= 1;
    }
  }

  private page(options: { readonly prefix: string; readonly cursor?: string; readonly startAfter?: string; readonly limit?: number }) {
    const failure = this.failLists.findIndex((prefix) => options.prefix.startsWith(prefix));
    if (failure >= 0) throw new Error(`list ${this.failLists.splice(failure, 1)[0]} failed`);
    const { keys, first } = this.keysFrom(options.prefix);
    // R2: `startAfter` is exclusive; a cursor continues where the previous page stopped.
    let after = first;
    if (options.startAfter !== undefined) {
      let index = this.keysFrom(options.startAfter).first;
      if (keys[index] === options.startAfter) index += 1;
      after = Math.max(first, index);
    }
    const start = options.cursor === undefined ? after : Number(options.cursor);
    const limit = Math.min(options.limit ?? 1_000, 1_000);
    const page: string[] = [];
    let index = start;
    while (index < keys.length && page.length < limit && keys[index]!.startsWith(options.prefix)) page.push(keys[index++]!);
    const truncated = index < keys.length && keys[index]!.startsWith(options.prefix);
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.body.length, uploaded: new Date(this.objects.get(key)!.uploaded) })),
      truncated,
      ...(truncated ? { cursor: String(index) } : {}),
    };
  }

  async put(key: string): Promise<never> {
    this.calls.push({ op: "put", key });
    throw new Error("the retention dry run must not write");
  }

  async delete(key: string | string[]): Promise<never> {
    this.calls.push({ op: "delete", key: String(key) });
    throw new Error("the retention dry run must not delete");
  }
}

export const feedPoolKey = (name: string) => `public/v2/objects/details/${name}.json`;
export const searchPoolKey = (name: string) => `public/search/v1/objects/details/${name}.json`;

/**
 * Writes one publication at `at`: Feed and Search release objects, the evidence (listing
 * `poolKeys` plus one pool key of its own per projection), and those pool objects. Returns ids.
 */
export function publish(bucket: RetentionMemoryBucket, at: number, options: { readonly evidence?: boolean | "invalid"; readonly poolKeys?: readonly string[] } = {}) {
  const feed = releaseIdAt(at);
  const search = `feed-${feed}`;
  bucket.set(`public/v2/releases/${feed}/feed/index.json`, 100, at);
  bucket.set(`public/v2/releases/${feed}/feed/details.json`, 50, at);
  bucket.set(`public/search/v1/releases/${search}/manifest.json`, 30, at);
  bucket.set(`public/search/v1/releases/${search}/terms.json`, 20, at);
  const ownFeed = feedPoolKey(`own-${feed}`);
  const ownSearch = searchPoolKey(`own-${feed}`);
  bucket.set(ownFeed, 10, at);
  bucket.set(ownSearch, 10, at);
  const evidence = options.evidence ?? true;
  if (evidence !== false) {
    const body = evidence === "invalid" ? JSON.stringify({ schema: "something-else" }) : JSON.stringify({
      schema: "osskb.publication-set.v1",
      id: `github-${feed}`,
      projections: [
        { kind: "feed", releaseId: feed, immutableObjects: [{ key: `public/v2/releases/${feed}/feed/index.json` }, { key: ownFeed }, ...(options.poolKeys ?? []).filter((key) => key.startsWith("public/v2/")).map((key) => ({ key }))] },
        { kind: "search", releaseId: search, immutableObjects: [{ key: `public/search/v1/releases/${search}/manifest.json` }, { key: ownSearch }, ...(options.poolKeys ?? []).filter((key) => key.startsWith("public/search/")).map((key) => ({ key }))] },
      ],
    });
    bucket.set(`publication-sets/v1/github-${feed}.json`, body, at);
  }
  return { feed, search };
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Spec 008 (PR #21) merged 2026-09-30T00:48Z: releases before it hold every detail under their own prefix. */
export const SPEC_008_AT = Date.parse("2026-09-30T00:48:00Z");
const FIRST_HOURLY = Date.parse("2026-09-02T00:07:00Z");
/**
 * Details per pre-Spec-008 release (one Feed and one Search detail per FeedEntry). Fitted to two
 * measurements: N = 1,494 on 2026-09-30 (Spec 008 Evidence), and the first Dev dry run
 * (2026-10-23), whose 398 release lists ended after 465 hourly Feed releases: 856 objects each on
 * average, i.e. N = 519 + 34.8 a day.
 */
export const detailsAt = (at: number) => Math.round(519 + 34.8 * (at - FIRST_HOURLY) / DAY);
/** A content-addressed pool name: 64 hex digits spread over every first digit, like a SHA-256. */
export const hexName = (index: number) => (Math.imul(index + 1, 2_654_435_761) >>> 0).toString(16).padStart(8, "0") + index.toString(16).padStart(56, "0");

/**
 * The Dev bucket as the first dry run found it: hourly releases 2026-09-02 → 10-13 and daily ones
 * to 10-21 (1,015 publications, every one with evidence: an upper bound on evidence reads), the
 * pre-Spec-008 releases with N details per prefix, and `poolObjects` old content-addressed objects.
 */
export function devShapedBucket(poolObjects = 150_000): { readonly bucket: RetentionMemoryBucket; readonly releases: number; readonly objects: number } {
  const bucket = new RetentionMemoryBucket();
  const times: number[] = [];
  for (let at = FIRST_HOURLY; at <= Date.parse("2026-10-13T22:07:00Z"); at += HOUR) times.push(at);
  for (let at = Date.parse("2026-10-14T22:07:00Z"); at <= Date.parse("2026-10-21T22:07:00Z"); at += DAY) times.push(at);
  for (const at of times) {
    const { feed, search } = publish(bucket, at);
    if (at >= SPEC_008_AT) {
      // Today's Search release: manifest, terms and 11 shards.
      for (let shard = 0; shard < 11; shard += 1) bucket.set(`public/search/v1/releases/${search}/shards/${shard}.json`, 1, at);
      continue;
    }
    for (let index = 0; index < detailsAt(at); index += 1) {
      bucket.set(`public/v2/releases/${feed}/details/${index}.json`, 1, at);
      bucket.set(`public/search/v1/releases/${search}/details/${index}.json`, 1, at);
    }
  }
  point(bucket, times.at(-1)!);
  const old = Date.parse("2026-09-30T01:00:00Z");
  for (let index = 0; index < poolObjects; index += 1) bucket.set(index % 2 === 0 ? feedPoolKey(hexName(index)) : searchPoolKey(hexName(index)), 1, old);
  return { bucket, releases: times.length, objects: bucket.objects.size };
}

/** Points the Feed and Search `current.json` at the releases published at `feedAt` and `searchAt`. */
export function point(bucket: RetentionMemoryBucket, feedAt: number, searchAt = feedAt): void {
  bucket.set("public/v2/current.json", JSON.stringify({ schema: "osskb.feed-manifest.v3", releaseId: releaseIdAt(feedAt) }));
  bucket.set("public/search/v1/current.json", JSON.stringify({ schema: "osskb.search-current.v1", indexRevision: `feed-${releaseIdAt(searchAt)}` }));
}
