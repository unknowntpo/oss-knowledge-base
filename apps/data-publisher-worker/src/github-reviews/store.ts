/** Spec 022 Behavior 7–10: where review rows, the cursor and the run record live. Nothing here is under `public/`. */

import { githubReviewsPrefix } from "@oss-knowledge-base/reference-pipeline";

export { githubReviewsMonthKey, githubReviewsPrefix, githubReviewsStateKey } from "@oss-knowledge-base/reference-pipeline";
export const GITHUB_REVIEWS_LAST_RUN_KEY = "internal/github-reviews/v1/last-run.json";
/** Behavior 13: the backfill's own progress, apart from the daily cursor, and its last run record. */
export const githubReviewsBackfillKey = (projectId: string) => `${githubReviewsPrefix(projectId)}backfill.json`;
export const GITHUB_REVIEWS_BACKFILL_LAST_RUN_KEY = "internal/github-reviews/v1/backfill-last-run.json";
/** Behavior 15 (areas amendment): the last manual metadata refresh's record. It keeps no progress object. */
export const GITHUB_REVIEWS_REFRESH_LAST_RUN_KEY = "internal/github-reviews/v1/refresh-last-run.json";

export interface GithubReviewsBucket {
  /** The object's text and ETag, or undefined when absent. */
  get(key: string): Promise<{ readonly body: string; readonly etag: string } | undefined>;
  /** Writes only if the object's ETag is still `etag` (absent when null); returns whether it wrote. */
  putIfMatch(key: string, body: string, etag: string | null): Promise<boolean>;
  put(key: string, body: string): Promise<void>;
}

const metadata = { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } };

export class R2GithubReviewsBucket implements GithubReviewsBucket {
  constructor(private readonly bucket: R2Bucket) {}

  async get(key: string): Promise<{ readonly body: string; readonly etag: string } | undefined> {
    const object = await this.bucket.get(key);
    return object === null ? undefined : { body: await object.text(), etag: object.etag };
  }

  async putIfMatch(key: string, body: string, etag: string | null): Promise<boolean> {
    const written = await this.bucket.put(key, body, {
      onlyIf: etag === null ? new Headers({ "if-none-match": "*" }) : { etagMatches: etag },
      ...metadata,
    });
    return written !== null;
  }

  async put(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body, metadata);
  }
}
