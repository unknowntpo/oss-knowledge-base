import {
  buildFeedDetail,
  type FeedEntry,
  type RecordConnection,
  type SourceRecordView,
} from "@oss-knowledge-base/domain";
import {
  DEFAULT_LEXICAL_REVISION,
  parseSearchGoldenFixture,
  parseSearchGoldenFixtureV2,
  type SourceRecordChunkV1,
} from "@oss-knowledge-base/search";
import {
  SEARCH_LEXICAL_SHARD_SCHEMA,
  type SearchLexicalShardV1,
  type SearchPublicationV1,
} from "@oss-knowledge-base/serving-contract";

export async function buildGoldenSearchPublication(
  fixturePath: string,
  indexRevision?: string,
): Promise<SearchPublicationV1> {
  return goldenPublication(parseSearchGoldenFixture(await Bun.file(fixturePath).json()), indexRevision, DEFAULT_LEXICAL_REVISION);
}

/** Golden v2 (Spec 016) as a publication of `lexicalRevision`; its chunks include golden v1's. */
export async function buildGoldenV2SearchPublication(
  fixturePath: string,
  indexRevision: string | undefined,
  lexicalRevision: string,
): Promise<SearchPublicationV1> {
  return goldenPublication(parseSearchGoldenFixtureV2(await Bun.file(fixturePath).json()), indexRevision, lexicalRevision);
}

function goldenPublication(
  golden: { readonly revision: string; readonly indexRevision: string; readonly chunks: readonly SourceRecordChunkV1[] },
  indexRevision: string | undefined,
  lexicalRevision: string,
): SearchPublicationV1 {
  const revision = indexRevision ?? golden.indexRevision;
  const chunksByProject = groupBy(golden.chunks, (chunk) => chunk.projectId);
  const details: SearchPublicationV1["details"][number][] = [];
  const shards: SearchLexicalShardV1[] = [];

  for (const [projectId, chunks] of [...chunksByProject.entries()].sort()) {
    const chunksByGroup = groupBy(chunks, (chunk) => chunk.groupRootRecordId);
    const groups: SearchLexicalShardV1["groups"][number][] = [];
    for (const [groupRootRecordId, groupChunks] of [...chunksByGroup.entries()].sort()) {
      const root = groupChunks.find((chunk) => chunk.recordId === groupRootRecordId);
      if (root === undefined) throw new Error(`Golden Search group ${groupRootRecordId} has no root chunk`);
      const recordChunks = [...new Map(groupChunks.map((chunk) => [chunk.recordId, chunk])).values()]
        .sort((left, right) => left.recordId.localeCompare(right.recordId));
      const records = recordChunks.map(sourceRecord);
      const connections: RecordConnection[] = records
        .filter((record) => record.id !== groupRootRecordId)
        .map((record) => ({
          id: `connection:${record.id}:discusses:${groupRootRecordId}`,
          fromRecordId: record.id,
          toRecordId: groupRootRecordId,
          kind: "discusses",
          derivation: { kind: "deterministic-rule", revision: "golden-search-grouping@1" },
        }));
      const entry: FeedEntry = {
        id: `feed-entry:search:${groupRootRecordId}`,
        projectId,
        title: root.title,
        summary: root.text,
        sourceTitleRecordId: root.recordId,
        recordIds: records.map((record) => record.id),
        highlightedRecordIds: [root.recordId],
        reason: { kind: "trending", label: "Search fixture base entry", evidenceEventIds: [] },
        activity: { score: 0, evidenceEventIds: [] },
        grouping: {
          relationshipIds: connections.map((connection) => connection.id),
          clusteringRevision: "golden-search-grouping@1",
        },
      };
      groups.push({ groupRootRecordId, entry });
      details.push({
        groupRootRecordId,
        detail: buildFeedDetail({
          entry,
          records,
          connections,
          keyPoints: { status: "unavailable", reason: "generator-not-configured" },
        }),
      });
    }
    shards.push({
      schema: SEARCH_LEXICAL_SHARD_SCHEMA,
      indexRevision: revision,
      projectId,
      chunks: chunks.map((chunk) => ({ ...chunk })),
      groups,
    });
  }

  return {
    indexRevision: revision,
    corpusRevision: golden.revision,
    lexicalRevision,
    generatedAt: "2026-08-25T12:00:00Z",
    shards,
    details,
  };
}

function sourceRecord(chunk: SourceRecordChunkV1): SourceRecordView {
  const source = sourceKey(chunk.sourceInstanceId);
  const artifactStatus = chunk.recordId === chunk.groupRootRecordId
    ? fixtureProjectStatus(chunk)
    : undefined;
  return {
    id: chunk.recordId,
    projectId: chunk.projectId,
    sourceInstanceId: chunk.sourceInstanceId,
    source,
    sourceType: source === "github" ? "code-host" : source === "mail" ? "mailing-list" : source,
    kind: source === "github" ? "GitHub record" : source === "mail" ? "Mailing-list message" : "Wiki page",
    title: chunk.title,
    excerpt: chunk.text,
    author: chunk.author,
    role: "Community contributor",
    occurredAt: chunk.occurredAt,
    canonicalUrl: chunk.canonicalUrl,
    sourceVersion: chunk.sourceVersion,
    ...(artifactStatus === undefined ? {} : { artifactStatus }),
  };
}

function fixtureProjectStatus(chunk: SourceRecordChunkV1): string | undefined {
  if (chunk.sourceInstanceId.includes("github") && chunk.sourceVersion.includes("merged")) {
    return "merged";
  }
  if (chunk.sourceInstanceId.includes("github") && chunk.recordId.includes(":issue:")) {
    return "open";
  }
  return undefined;
}

function sourceKey(sourceInstanceId: string): string {
  if (sourceInstanceId.includes("github")) return "github";
  if (sourceInstanceId.includes("mail")) return "mail";
  if (sourceInstanceId.includes("jira")) return "jira";
  if (sourceInstanceId.includes("wiki")) return "wiki";
  return "source";
}

function groupBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}
