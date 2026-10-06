import {
  buildFeedDetail,
  type FeedDetail,
  type FeedDetailKeyPoints,
  type FeedEntry,
} from "@oss-knowledge-base/domain";
import {
  chunkSourceRecord,
  DEFAULT_LEXICAL_REVISION,
  type SourceRecordChunkV1,
} from "@oss-knowledge-base/search";

import type { FeedIndexEntry, FeedPublication } from "./index";
import {
  SEARCH_LEXICAL_SHARD_SCHEMA,
  type SearchGroupSource,
  type SearchLexicalShardV1,
  type SearchPublicationV1,
} from "./search-r2";

export interface MaterializeSearchFromFeedInputV1 {
  readonly feed: FeedPublication;
  readonly indexRevision: string;
  readonly corpusRevision: string;
  readonly generatedAt: string;
}

/**
 * Deterministic POC reference materializer. The input is a completed domain
 * publication, never a GitHub/R2 client, so the same behavior can move behind
 * Flink without changing the Search publication contract.
 *
 * Collects `searchGroupsFromFeed`; the publisher streams that generator instead (Spec 013).
 */
export async function materializeSearchPublicationFromFeed(
  input: MaterializeSearchFromFeedInputV1,
): Promise<SearchPublicationV1> {
  requireText(input.indexRevision, "indexRevision");
  requireText(input.corpusRevision, "corpusRevision");
  requireTimestamp(input.generatedAt, "generatedAt");

  const shards: SearchLexicalShardV1[] = [];
  const details: SearchPublicationV1["details"][number][] = [];
  for await (const group of searchGroupsFromFeed(input.feed)) {
    let shard = shards.at(-1);
    if (shard?.projectId !== group.projectId) {
      shard = {
        schema: SEARCH_LEXICAL_SHARD_SCHEMA,
        indexRevision: input.indexRevision,
        projectId: group.projectId,
        chunks: [],
        groups: [],
      };
      shards.push(shard);
    }
    (shard.chunks as SourceRecordChunkV1[]).push(...group.chunks);
    (shard.groups as SearchLexicalShardV1["groups"][number][]).push({ groupRootRecordId: group.groupRootRecordId, entry: group.entry });
    details.push({ groupRootRecordId: group.groupRootRecordId, detail: group.detail });
  }
  for (const shard of shards) (shard.chunks as SourceRecordChunkV1[]).sort((left, right) => left.id.localeCompare(right.id));

  return {
    indexRevision: input.indexRevision,
    corpusRevision: input.corpusRevision,
    lexicalRevision: DEFAULT_LEXICAL_REVISION,
    generatedAt: input.generatedAt,
    shards,
    details,
  };
}

/**
 * Yields one Search group per Feed entry, ordered by project and then group root, building
 * each group's canonical detail and chunks only when it is consumed (Spec 013). Membership is
 * checked up front from ids; record ownership is checked as groups are produced.
 */
export async function* searchGroupsFromFeed(feed: FeedPublication): AsyncGenerator<SearchGroupSource> {
  const entries = uniqueBy(feed.index.entries, (item) => item.entry.id, "Feed index entry");
  const details = uniqueBy(feed.details, (detail) => detail.entry.id, "Feed detail");
  const detailsByEntryId = new Map(details.map((detail) => [detail.entry.id, detail]));
  const entryIds = new Set(entries.map((item) => item.entry.id));
  const missing = entries.filter((item) => !detailsByEntryId.has(item.entry.id));
  const orphan = details.filter((detail) => !entryIds.has(detail.entry.id));
  if (missing.length > 0 || orphan.length > 0) {
    throw new Error(
      `Feed snapshot membership mismatch: missing=[${missing.map((item) => item.entry.id).join(", ")}], orphan=[${orphan.map((detail) => detail.entry.id).join(", ")}]`,
    );
  }
  entries.sort((left, right) =>
    left.entry.projectId.localeCompare(right.entry.projectId) ||
    left.entry.sourceTitleRecordId.localeCompare(right.entry.sourceTitleRecordId) ||
    left.entry.id.localeCompare(right.entry.id));

  const recordOwners = new Map<string, string>();
  const groupRoots = new Set<string>();
  for (const indexEntry of entries) {
    const rawDetail = detailsByEntryId.get(indexEntry.entry.id)!;
    assertIndexDetailAgreement(indexEntry, rawDetail);
    const detail = canonicalDetail(rawDetail);
    const groupRootRecordId = detail.entry.sourceTitleRecordId;
    if (groupRoots.has(groupRootRecordId)) {
      throw new Error(`Search group root ${groupRootRecordId} is duplicated`);
    }
    groupRoots.add(groupRootRecordId);
    const tags = uniqueSorted(indexEntry.tags);
    const chunks: SourceRecordChunkV1[] = [];
    for (const record of detail.records) {
      const previousOwner = recordOwners.get(record.id);
      if (previousOwner !== undefined && previousOwner !== groupRootRecordId) {
        throw new Error(
          `SourceRecord ${record.id} belongs to both ${previousOwner} and ${groupRootRecordId}`,
        );
      }
      recordOwners.set(record.id, groupRootRecordId);
      chunks.push(...await chunkSourceRecord({
        projectId: record.projectId,
        sourceInstanceId: record.sourceInstanceId,
        recordId: record.id,
        groupRootRecordId,
        title: record.title,
        canonicalUrl: record.canonicalUrl,
        author: record.author,
        occurredAt: record.occurredAt,
        sourceVersion: record.sourceVersion,
        tags,
        parts: [{ key: "excerpt", text: record.excerpt }],
      }));
    }
    yield { projectId: detail.entry.projectId, groupRootRecordId, entry: detail.entry, detail, chunks };
  }
}

function assertIndexDetailAgreement(indexEntry: FeedIndexEntry, detail: FeedDetail): void {
  const index = indexEntry.entry;
  const actual = detail.entry;
  if (
    index.id !== actual.id ||
    index.projectId !== actual.projectId ||
    index.title !== actual.title ||
    index.summary !== actual.summary ||
    index.sourceTitleRecordId !== actual.sourceTitleRecordId
  ) {
    throw new Error(`Feed index and detail disagree for ${index.id}`);
  }
  assertSameSet(index.recordIds, actual.recordIds, `FeedEntry ${index.id} records`);
  const detailRecordIds = detail.records.map((record) => record.id);
  assertSameSet(actual.recordIds, detailRecordIds, `FeedDetail ${actual.id} records`);
  if (!detailRecordIds.includes(actual.sourceTitleRecordId)) {
    throw new Error(`FeedDetail ${actual.id} has no group root record`);
  }
}

function canonicalDetail(detail: FeedDetail): FeedDetail {
  const recordIds = uniqueSorted(detail.records.map((record) => record.id));
  const entry: FeedEntry = {
    ...detail.entry,
    recordIds,
    highlightedRecordIds: uniqueSorted(detail.entry.highlightedRecordIds),
    activity: {
      ...detail.entry.activity,
      evidenceEventIds: uniqueSorted(detail.entry.activity.evidenceEventIds),
    },
    grouping: {
      ...detail.entry.grouping,
      relationshipIds: uniqueSorted(detail.entry.grouping.relationshipIds),
    },
  };
  return buildFeedDetail({
    entry,
    records: [...detail.records].sort((left, right) => left.id.localeCompare(right.id)),
    connections: [...detail.connections].sort((left, right) => left.id.localeCompare(right.id)),
    keyPoints: canonicalKeyPoints(detail.keyPoints),
  });
}

function canonicalKeyPoints(value: FeedDetailKeyPoints): FeedDetailKeyPoints {
  if (value.status !== "generated") return value;
  return {
    ...value,
    points: [...value.points]
      .map((point) => ({
        ...point,
        evidenceRecordIds: uniqueSorted(point.evidenceRecordIds) as [string, ...string[]],
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string, label: string): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = requireText(keyOf(value), label);
    if (result.has(key)) throw new Error(`${label} ${key} is duplicated`);
    result.set(key, value);
  }
  return [...result.values()];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertSameSet(left: readonly string[], right: readonly string[], label: string): void {
  const expected = uniqueSorted(left);
  const actual = uniqueSorted(right);
  if (expected.length !== left.length || actual.length !== right.length) {
    throw new Error(`${label} contain duplicate IDs`);
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${label} do not match`);
  }
}

function requireTimestamp(value: string, label: string): string {
  const result = requireText(value, label);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label} must be a timestamp`);
  return result;
}

function requireText(value: string, label: string): string {
  const result = value.trim();
  if (result.length === 0) throw new Error(`${label} must not be empty`);
  return result;
}
