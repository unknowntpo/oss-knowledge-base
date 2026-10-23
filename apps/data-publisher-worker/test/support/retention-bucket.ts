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

  async list(options: { readonly prefix: string; readonly cursor?: string; readonly limit?: number }) {
    this.calls.push({ op: "list", key: options.prefix });
    this.onCall("list");
    const failure = this.failLists.findIndex((prefix) => options.prefix.startsWith(prefix));
    if (failure >= 0) throw new Error(`list ${this.failLists.splice(failure, 1)[0]} failed`);
    const { keys, first } = this.keysFrom(options.prefix);
    const start = options.cursor === undefined ? first : Number(options.cursor);
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

/** Points the Feed and Search `current.json` at the releases published at `feedAt` and `searchAt`. */
export function point(bucket: RetentionMemoryBucket, feedAt: number, searchAt = feedAt): void {
  bucket.set("public/v2/current.json", JSON.stringify({ schema: "osskb.feed-manifest.v3", releaseId: releaseIdAt(feedAt) }));
  bucket.set("public/search/v1/current.json", JSON.stringify({ schema: "osskb.search-current.v1", indexRevision: `feed-${releaseIdAt(searchAt)}` }));
}
