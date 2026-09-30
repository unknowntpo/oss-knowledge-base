import type { FeedDetail, FeedEntry } from "@oss-knowledge-base/domain";

import type { Sha256Digest } from "./digest";

export interface FeedSourceType {
  readonly key: string;
  readonly label: string;
  readonly full: string;
}

export interface FeedProjectProfile {
  readonly key: string;
  readonly label: string;
  readonly profileVersion: string;
  readonly statusPolicyRef: string;
  readonly statusFacetKey: string;
  readonly sources: readonly string[];
  readonly statuses: readonly { readonly key: string; readonly label: string }[];
}

/** Compact public projection for one card. Full records belong to FeedDetail. */
export interface FeedIndexEntry {
  readonly displayId: string;
  readonly projectKey: string;
  readonly status: string;
  readonly releaseLabel: string;
  readonly authors: readonly string[];
  readonly tags: readonly string[];
  readonly links: Readonly<Record<string, string>>;
  readonly sourceCounts: Readonly<Record<string, number>>;
  readonly lastActivityAt: string;
  readonly searchText: string;
  readonly entry: FeedEntry;
}

export interface FeedIndex {
  readonly schema: "osskb.feed-index.v2";
  readonly generatedAt: string;
  readonly sourceTypes: Readonly<Record<string, FeedSourceType>>;
  readonly projects: readonly FeedProjectProfile[];
  readonly entries: readonly FeedIndexEntry[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Publisher input. Details are separated before anything is written to R2. */
export interface FeedPublication {
  readonly index: FeedIndex;
  readonly details: readonly FeedDetail[];
}

/** Release-scoped details (ADR-0004). Still read so rollback to an older release works. */
export interface FeedManifestV2 {
  readonly schema: "osskb.feed-manifest.v2";
  readonly releaseId: string;
  readonly generatedAt: string;
  readonly feedIndexKey: string;
  readonly detailPrefix: string;
  readonly entryCount: number;
}

/** Details live in the shared Feed pool and resolve only through `detailMapKey` (ADR-0013). */
export interface FeedManifestV3 {
  readonly schema: "osskb.feed-manifest.v3";
  readonly releaseId: string;
  readonly generatedAt: string;
  readonly feedIndexKey: string;
  readonly detailMapKey: string;
  readonly entryCount: number;
}

export type FeedManifest = FeedManifestV2 | FeedManifestV3;

/** Release membership of Feed details: FeedEntry id -> digest of its pool object. */
export interface FeedDetailMapV1 {
  readonly schema: "osskb.feed-detail-map.v1";
  readonly releaseId: string;
  readonly details: Readonly<Record<string, Sha256Digest>>;
}

export * from "./digest";
export * from "./r2";
export * from "./publication-set";
export * from "./search-feed-materializer";
export * from "./search-r2";
