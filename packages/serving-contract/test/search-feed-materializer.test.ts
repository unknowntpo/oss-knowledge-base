import { describe, expect, test } from "bun:test";

import type { FeedDetail } from "@oss-knowledge-base/domain";

import {
  buildR2SearchProjection,
  materializeSearchPublicationFromFeed,
  type FeedPublication,
} from "../src";
import { feedFixture as fixture, fixtureGeneratedAt } from "./feed-fixture";

const revisions = {
  indexRevision: "feed-release-1",
  corpusRevision: "feed:release-1",
  generatedAt: fixtureGeneratedAt,
} as const;

describe("completed Feed snapshot Search materializer", () => {
  test("materializes every group and SourceRecord with traceable metadata", async () => {
    const result = await materializeSearchPublicationFromFeed({ feed: fixture(), ...revisions });

    expect(result.shards.map((shard) => shard.projectId)).toEqual([
      "apache-datafusion",
      "apache-kafka",
    ]);
    expect(result.shards.reduce((total, shard) => total + shard.groups.length, 0)).toBe(2);
    expect(result.shards.reduce((total, shard) => total + shard.chunks.length, 0)).toBe(3);
    expect(result.details).toHaveLength(2);

    const kafka = result.shards.find((shard) => shard.projectId === "apache-kafka")!;
    expect(kafka.chunks.every((chunk) => chunk.groupRootRecordId === "kafka:github:issue:1"))
      .toBe(true);
    expect(kafka.chunks.every((chunk) => chunk.tags.includes("consumer"))).toBe(true);
    expect(kafka.chunks.find((chunk) => chunk.recordId.endsWith("comment:10"))?.author)
      .toBe("reviewer");

    const objects = await buildR2SearchProjection(result);
    const kafkaShard = JSON.parse(objects.find((object) =>
      object.key.endsWith("lexical/apache-kafka/1.json"))!.body) as {
      readonly groups: readonly { readonly projectStatus?: string }[];
    };
    expect(kafkaShard.groups[0]?.projectStatus).toBe("open");
  });

  test("produces byte-identical R2 objects after harmless input shuffling", async () => {
    const original = fixture();
    const shuffled: FeedPublication = {
      index: {
        ...original.index,
        entries: [...original.index.entries].reverse().map((item) => ({
          ...item,
          tags: [...item.tags].reverse(),
        })),
      },
      details: [...original.details].reverse().map((detail) => ({
        ...detail,
        records: [...detail.records].reverse(),
        connections: [...detail.connections].reverse(),
      })),
    };
    const left = await buildR2SearchProjection(
      await materializeSearchPublicationFromFeed({ feed: original, ...revisions }),
    );
    const right = await buildR2SearchProjection(
      await materializeSearchPublicationFromFeed({ feed: shuffled, ...revisions }),
    );

    expect(left).toEqual(right);
  });

  test("rejects one SourceRecord reused by two accepted groups", async () => {
    const feed = fixture();
    const [kafka, datafusion] = feed.details;
    const reused = {
      ...kafka!.records[1]!,
      projectId: datafusion!.entry.projectId,
    };
    const invalidDetail: FeedDetail = {
      ...datafusion!,
      entry: {
        ...datafusion!.entry,
        recordIds: [...datafusion!.entry.recordIds, reused.id],
      },
      records: [...datafusion!.records, reused],
    };
    const invalidIndexEntry = {
      ...feed.index.entries[1]!,
      entry: invalidDetail.entry,
    };

    await expect(materializeSearchPublicationFromFeed({
      feed: {
        index: { ...feed.index, entries: [feed.index.entries[0]!, invalidIndexEntry] },
        details: [kafka!, invalidDetail],
      },
      ...revisions,
    })).rejects.toThrow("belongs to both");
  });
});
