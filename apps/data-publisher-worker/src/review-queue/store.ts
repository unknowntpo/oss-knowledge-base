/** Spec 015 Behavior 14–17: the review queue's R2 objects, pointer, run record, and roster cache. */

export const reviewQueuePrefix = (projectId: string) => `public/review-queue/v1/${projectId}/`;
export const reviewQueuePointerKey = (projectId: string) => `${reviewQueuePrefix(projectId)}current.json`;
export const reviewQueueLastRunKey = (projectId: string) => `${reviewQueuePrefix(projectId)}last-run.json`;
export const rosterKey = (adapter: string, project: string) => `internal/rosters/v1/${adapter}/${project}.json`;

export interface ReviewQueueBucket {
  getJson(key: string): Promise<unknown>;
  /** The object and its ETag, or undefined when absent. */
  getWithEtag(key: string): Promise<{ readonly value: unknown; readonly etag: string } | undefined>;
  /** Writes an immutable object unless the key exists. */
  putIfAbsent(key: string, body: string): Promise<boolean>;
  /** Replaces the pointer only if its ETag is still `etag` (absent when null); returns whether it wrote. */
  putPointerIfMatch(key: string, body: string, etag: string | null): Promise<boolean>;
  /** Unconditional write of a small mutable object (run record, roster cache). */
  put(key: string, body: string): Promise<void>;
}

const JSON_TYPE = "application/json";

export class R2ReviewQueueBucket implements ReviewQueueBucket {
  constructor(private readonly bucket: R2Bucket) {}

  async getJson(key: string): Promise<unknown> {
    const object = await this.bucket.get(key);
    return object === null ? undefined : object.json();
  }

  async getWithEtag(key: string): Promise<{ readonly value: unknown; readonly etag: string } | undefined> {
    const object = await this.bucket.get(key);
    return object === null ? undefined : { value: await object.json(), etag: object.etag };
  }

  async putIfAbsent(key: string, body: string): Promise<boolean> {
    const written = await this.bucket.put(key, body, {
      onlyIf: new Headers({ "if-none-match": "*" }),
      httpMetadata: { contentType: JSON_TYPE, cacheControl: "public, max-age=31536000, immutable" },
    });
    return written !== null;
  }

  async putPointerIfMatch(key: string, body: string, etag: string | null): Promise<boolean> {
    const written = await this.bucket.put(key, body, {
      onlyIf: etag === null ? new Headers({ "if-none-match": "*" }) : { etagMatches: etag },
      httpMetadata: { contentType: JSON_TYPE, cacheControl: "public, max-age=30, must-revalidate" },
    });
    return written !== null;
  }

  async put(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body, { httpMetadata: { contentType: JSON_TYPE, cacheControl: "no-store" } });
  }
}
