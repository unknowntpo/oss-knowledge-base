import {
  lexicalShardPostings,
  rankLexicalShard,
  selectLexicalResults,
  type LexicalSearchConfigV1,
  type LexicalSearchFacetRequestV1,
  type SourceRecordChunkV1,
} from "../../src";

/**
 * Ranks through stored shard postings, as the Spec 013 reader does: whole threads per shard, at
 * most `maxShardChunks` chunks each, round-tripped through JSON, scored with corpus-wide statistics.
 */
export function rankSharded(
  chunks: readonly SourceRecordChunkV1[],
  config: LexicalSearchConfigV1,
  request: LexicalSearchFacetRequestV1 | string,
  maxShardChunks: number,
  limit = 20,
) {
  const byGroup = new Map<string, SourceRecordChunkV1[]>();
  for (const chunk of [...chunks].sort((left, right) =>
    left.projectId.localeCompare(right.projectId) || left.groupRootRecordId.localeCompare(right.groupRootRecordId) ||
    left.id.localeCompare(right.id))) {
    byGroup.set(chunk.groupRootRecordId, [...byGroup.get(chunk.groupRootRecordId) ?? [], chunk]);
  }
  const shards: SourceRecordChunkV1[][] = [];
  for (const group of byGroup.values()) {
    const open = shards.at(-1);
    if (open !== undefined && open[0]!.projectId === group[0]!.projectId && open.length + group.length <= maxShardChunks) {
      open.push(...group);
    } else {
      shards.push([...group]);
    }
  }
  const stored = shards.map((shardChunks) => JSON.parse(JSON.stringify({
    chunks: shardChunks,
    ...lexicalShardPostings(shardChunks, config),
  })) as { chunks: SourceRecordChunkV1[]; lengths: number[]; postings: Record<string, number[]> });
  const documentFrequency = new Map<string, number>();
  for (const shard of stored) {
    for (const [term, postings] of Object.entries(shard.postings)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + postings.length / 2);
    }
  }
  const corpus = {
    chunkCount: chunks.length,
    totalChunkLength: stored.flatMap((shard) => shard.lengths).reduce((total, length) => total + length, 0),
    documentFrequency: (term: string) => documentFrequency.get(term) ?? 0,
  };
  const facetRequest = typeof request === "string" ? { query: request } : request;
  return selectLexicalResults(stored.flatMap((shard) => rankLexicalShard(shard, corpus, facetRequest, config)), {
    ...(facetRequest.filters === undefined ? {} : { filters: facetRequest.filters }),
    limit,
  });
}
