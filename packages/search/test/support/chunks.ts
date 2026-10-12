import type { SourceRecordChunkV1 } from "../../src";

/** A one-chunk record for ranking tests; `root` puts it in another record's thread. */
export function testChunk(
  key: string,
  title: string,
  text: string,
  options: { readonly root?: string; readonly projectId?: string } = {},
): SourceRecordChunkV1 {
  const projectId = options.projectId ?? "apache-kafka";
  const recordId = `test:record:${key}`;
  return {
    schema: "osskb.source-record-chunk.v1",
    id: `chunk:${key}`,
    projectId,
    sourceInstanceId: "test:source",
    recordId,
    groupRootRecordId: options.root === undefined ? recordId : `test:record:${options.root}`,
    ordinal: 0,
    title,
    text,
    canonicalUrl: `https://example.test/${key}`,
    author: "tester",
    occurredAt: "2026-10-12T00:00:00Z",
    sourceVersion: "1",
    contentHash: `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`,
    tags: [],
  };
}

/** Unrelated records, so that document frequencies and lengths are not degenerate. */
export const fillerChunks: readonly SourceRecordChunkV1[] = [
  testChunk("filler-1", "Compaction of the offsets topic", "Segments are cleaned in order."),
  testChunk("filler-2", "Partition reassignment throttles", "A quota applies to replication."),
  testChunk("filler-3", "Controller election timeout", "The quorum elects a leader."),
  testChunk("filler-4", "Parquet page index", "Row groups are pruned.", { projectId: "apache-datafusion" }),
  testChunk("filler-5", "Spill files for sorts", "External sorting writes batches.", { projectId: "apache-datafusion" }),
];
