import {
  buildFeedDetail,
  type FeedEntry,
  type SourceRecordView,
} from "@oss-knowledge-base/domain";

import type { FeedIndexEntry, FeedPublication } from "../src";

export const fixtureGeneratedAt = "2026-08-25T08:29:41.122Z";

/** Two-project Feed snapshot shared by the materializer and content-addressing tests. */
export function feedFixture(): FeedPublication {
  const kafkaRoot = record({
    id: "kafka:github:issue:1",
    projectId: "apache-kafka",
    title: "KAFKA-1: Consumer coordination",
    excerpt: "Consumer group coordination and rebalance behavior.",
    author: "author",
    occurredAt: "2026-08-24T10:00:00Z",
    artifactStatus: "open",
  });
  const kafkaComment = record({
    id: "kafka:github:issue:1:comment:10",
    projectId: "apache-kafka",
    title: "Comment on KAFKA-1",
    excerpt: "The reviewer asks how static membership affects the coordinator.",
    author: "reviewer",
    occurredAt: "2026-08-25T10:00:00Z",
  });
  const datafusionRoot = record({
    id: "datafusion:github:pull:2",
    projectId: "apache-datafusion",
    title: "Improve parquet pruning",
    excerpt: "Adds statistics-aware pruning to the physical optimizer.",
    author: "datafusion-author",
    occurredAt: "2026-08-25T11:00:00Z",
    artifactStatus: "merged",
  });
  const kafkaEntry = entry(
    "feed-entry:kafka:1",
    "apache-kafka",
    kafkaRoot,
    [kafkaRoot.id, kafkaComment.id],
  );
  const datafusionEntry = entry(
    "feed-entry:datafusion:2",
    "apache-datafusion",
    datafusionRoot,
    [datafusionRoot.id],
  );
  const details = [
    buildFeedDetail({ entry: kafkaEntry, records: [kafkaRoot, kafkaComment] }),
    buildFeedDetail({ entry: datafusionEntry, records: [datafusionRoot] }),
  ];

  return {
    index: {
      schema: "osskb.feed-index.v2",
      generatedAt: fixtureGeneratedAt,
      sourceTypes: { github: { key: "github", label: "GitHub", full: "GitHub" } },
      projects: [],
      entries: [
        indexEntry("kafka", kafkaEntry, ["consumer", "coordination"]),
        indexEntry("datafusion", datafusionEntry, ["optimizer", "parquet"]),
      ],
      metadata: {},
    },
    details,
  };
}

function record(input: {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly excerpt: string;
  readonly author: string;
  readonly occurredAt: string;
  readonly artifactStatus?: string;
}): SourceRecordView {
  return {
    ...input,
    sourceInstanceId: `${input.projectId}:github`,
    source: "github",
    sourceType: "code-host",
    kind: "GitHub record",
    role: "Community contributor",
    canonicalUrl: `https://github.com/apache/example/${encodeURIComponent(input.id)}`,
    sourceVersion: `github:${input.id}:v1`,
  };
}

function entry(
  id: string,
  projectId: string,
  root: SourceRecordView,
  recordIds: readonly string[],
): FeedEntry {
  return {
    id,
    projectId,
    title: root.title,
    summary: root.excerpt,
    sourceTitleRecordId: root.id,
    recordIds,
    highlightedRecordIds: [root.id],
    reason: { kind: "trending", label: "fixture", evidenceEventIds: [] },
    activity: { score: recordIds.length, evidenceEventIds: [] },
    grouping: { relationshipIds: [], clusteringRevision: "fixture@1" },
  };
}

function indexEntry(
  projectKey: string,
  value: FeedEntry,
  tags: readonly string[],
): FeedIndexEntry {
  return {
    displayId: value.sourceTitleRecordId,
    projectKey,
    status: "open",
    releaseLabel: "GitHub",
    authors: [],
    tags,
    links: { github: "https://github.com/apache/example" },
    sourceCounts: { github: value.recordIds.length },
    lastActivityAt: fixtureGeneratedAt,
    searchText: "",
    entry: value,
  };
}
