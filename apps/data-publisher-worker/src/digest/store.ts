/**
 * Spec 014 Behavior 1 and 12: what the digest reads from a published Feed release and how it
 * writes digest objects and the pointer to R2.
 */
import {
  detailPoolKey,
  FEED_DETAIL_POOL,
  isFeedDetailMap,
  isFeedManifest,
  MANIFEST_KEY,
} from "@oss-knowledge-base/serving-contract";
import { digestWindowStart, type DigestDetail, type DigestEntry, type DigestRecord } from "@oss-knowledge-base/reference-pipeline";

export interface DigestBucket {
  getJson(key: string): Promise<unknown>;
  list(prefix: string): Promise<string[]>;
  /** Writes an immutable object unless the key exists; returns whether it wrote. */
  putIfAbsent(key: string, body: string): Promise<boolean>;
  /** Writes the mutable pointer. */
  putPointer(key: string, body: string): Promise<void>;
}

export class R2DigestBucket implements DigestBucket {
  constructor(private readonly bucket: R2Bucket) {}

  async getJson(key: string): Promise<unknown> {
    const object = await this.bucket.get(key);
    return object === null ? undefined : object.json();
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
      keys.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    return keys;
  }

  async putIfAbsent(key: string, body: string): Promise<boolean> {
    const written = await this.bucket.put(key, body, {
      onlyIf: new Headers({ "if-none-match": "*" }),
      httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=31536000, immutable" },
    });
    return written !== null;
  }

  async putPointer(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=30, must-revalidate" },
    });
  }
}

export class DigestSourceError extends Error {}

export interface PinnedRelease {
  readonly release: { readonly releaseId: string; readonly generatedAt: string };
  readonly entries: readonly DigestEntry[];
  readonly details: Readonly<Record<string, DigestDetail>>;
  readonly reads: number;
}

interface IndexEntry {
  readonly displayId?: string;
  readonly projectKey?: string;
  readonly status?: string | null;
  readonly lastActivityAt?: string;
  readonly sourceCounts?: Record<string, number>;
  readonly links?: Record<string, string> | null;
  readonly entry?: { readonly id?: string; readonly title?: string };
}

/**
 * Pins the current Feed release (Behavior 1) and reads the Details of the project's entries
 * active in the window; nothing from a later release is read.
 */
export async function readPinnedRelease(bucket: DigestBucket, projectKey: string, concurrency = 8): Promise<PinnedRelease> {
  const manifest = await bucket.getJson(MANIFEST_KEY);
  if (!isFeedManifest(manifest) || manifest.schema !== "osskb.feed-manifest.v3") throw new DigestSourceError("Feed manifest v3 is missing");
  const index = await bucket.getJson(manifest.feedIndexKey) as { entries?: IndexEntry[] } | undefined;
  const map = await bucket.getJson(manifest.detailMapKey);
  if (!Array.isArray(index?.entries) || !isFeedDetailMap(map) || map.releaseId !== manifest.releaseId) {
    throw new DigestSourceError(`Feed release ${manifest.releaseId} is incomplete`);
  }
  const entries: DigestEntry[] = index.entries
    .filter((entry) => entry.projectKey === projectKey && typeof entry.entry?.id === "string" && typeof entry.displayId === "string")
    .map((entry) => ({
      id: entry.entry!.id!,
      displayId: entry.displayId!,
      projectKey,
      status: entry.status ?? null,
      title: entry.entry!.title ?? "",
      lastActivityAt: entry.lastActivityAt ?? "",
      sourceCounts: entry.sourceCounts ?? {},
      links: entry.links ?? null,
    }));
  const start = digestWindowStart(manifest.generatedAt);
  const wanted = entries.filter((entry) => Date.parse(entry.lastActivityAt) >= Date.parse(start));
  const details: Record<string, DigestDetail> = {};
  let reads = 4;
  for (let index = 0; index < wanted.length; index += concurrency) {
    await Promise.all(wanted.slice(index, index + concurrency).map(async (entry) => {
      const digest = Object.hasOwn(map.details, entry.id) ? map.details[entry.id] : undefined;
      if (digest === undefined) return;
      reads += 1;
      const detail = await bucket.getJson(detailPoolKey(FEED_DETAIL_POOL, digest)) as { records?: DigestRecord[]; entry?: { title?: string } } | undefined;
      if (!Array.isArray(detail?.records)) throw new DigestSourceError(`Detail of ${entry.displayId} is missing`);
      details[entry.displayId] = { displayId: entry.displayId, title: detail.entry?.title ?? entry.title, records: detail.records };
    }));
  }
  return { release: { releaseId: manifest.releaseId, generatedAt: manifest.generatedAt }, entries, details, reads };
}
