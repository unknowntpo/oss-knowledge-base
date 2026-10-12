import { describe, expect, test } from "bun:test";

import { formatEvaluationTable, lexicalSearchConfigFor, lexicalShardPostings, type GoldenEvaluationReportV1 } from "../src";
import { RELEASE_MANAGER_THREAD, testPlanRows } from "./real-corpus.cases";
import {
  SNAPSHOT_DEPTH,
  evaluateRealCorpus,
  loadRealCorpus,
  parseRealCorpus,
  realCorpusConfigurationId,
  realCorpusQueryTerms,
  realCorpusReportPath,
  realCorpusSnapshotPath,
  releaseEvaluationConfiguration,
  releaseStatistics,
} from "./support/real-corpus";

const AT2 = realCorpusConfigurationId("bm25-reference@2");
const AT3 = realCorpusConfigurationId("bm25-reference@3");
let cached: Promise<GoldenEvaluationReportV1> | undefined;
const evaluate = () => cached ??= loadRealCorpus().then(evaluateRealCorpus);

function configuration(report: GoldenEvaluationReportV1, id: string) {
  const found = report.configurations.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No configuration ${id}`);
  return found;
}

function clone(value: unknown): Record<string, any> {
  return structuredClone(value) as Record<string, any>;
}

describe("Spec 017 real-corpus evaluation", () => {
  test.each([...testPlanRows])("$id: $case — `$query` is $at2 at @2 and $at3 at @3", async (row) => {
    const report = await evaluate();
    const before = configuration(report, AT2).queries.find((query) => query.queryId === row.query)!;
    const after = configuration(report, AT3).queries.find((query) => query.queryId === row.query)!;
    expect([before.status, after.status]).toEqual([row.at2, row.at3]);
    // No query is worse at @3 on any metric.
    expect(after.recallAt20).toBeGreaterThanOrEqual(before.recallAt20);
    expect(after.mrr).toBeGreaterThanOrEqual(before.mrr);
    expect(after.ndcgAt10).toBeGreaterThanOrEqual(before.ndcgAt10);
    if (row.notInTop3 !== null) {
      expect(after.top.slice(0, 3)).not.toContain(row.notInTop3);
      // Positive control: the long thread did rank in the top 3 at @2.
      expect(before.top.slice(0, 3)).toContain(row.notInTop3);
    }
    expect<number>(row.within).toBe(row.labels === "owner" ? 3 : row.expected.split(" ").length + (row.acceptable?.split(" ").length ?? 0));
  });

  test("N3: the committed report is what the runner produces, and it names its release", async () => {
    const report = await evaluate();
    expect(report).toEqual(await Bun.file(realCorpusReportPath).json());
    expect(report.fixtureRevision).toBe("real-corpus-feed-2026-10-12T02-07-12-000Z");
    expect(report.configurations.map((item) => item.id)).toEqual([AT2, AT3]);
    expect(report.configurations.every((item) => item.queries.length === testPlanRows.length)).toBeTrue();
    const again = await evaluateRealCorpus(await loadRealCorpus());
    expect(again).toEqual(report);
    expect(formatEvaluationTable(again)).toBe(formatEvaluationTable(report));
  });

  test("N3: @3 raises every aggregate on the Dev release and fails only the owner's query", async () => {
    const report = await evaluate();
    const before = configuration(report, AT2).all;
    const after = configuration(report, AT3).all;
    expect(before).toEqual({ queries: 21, pass: 7, semanticRequired: 0, fail: 14, recallAt20: 0.9397, mrr: 0.5913, ndcgAt10: 0.6832 });
    expect(after).toEqual({ queries: 21, pass: 20, semanticRequired: 0, fail: 1, recallAt20: 0.9841, mrr: 0.9762, ndcgAt10: 0.9531 });
    const owner = configuration(report, AT3).queries.find((query) => query.queryId === "consumer network thread request manager")!;
    expect(owner.failures).toEqual([
      "kafka:github:pull:22747 is not in the top 3",
      "kafka:jira:issue:KAFKA-19738 is not in the top 3",
    ]);
    // Its Release Manager bound holds; at @2 that thread was first.
    expect(owner.top).not.toContain(RELEASE_MANAGER_THREAD);
    expect(configuration(report, AT2).queries.find((query) => query.queryId === owner.queryId)!.top[0]).toBe(RELEASE_MANAGER_THREAD);
    expect([owner.recallAt20, owner.mrr, owner.orderCorrect]).toEqual([0.6667, 0.5, false]);
  });

  test("N3: the owner's labels are the ones recorded in Spec 016, and only that row is the owner's", () => {
    const owner = testPlanRows.filter((row) => row.labels === "owner");
    expect(owner).toHaveLength(1);
    expect(owner[0]!.query).toBe("consumer network thread request manager");
    expect(owner[0]!.expected).toBe("kafka:jira:issue:KAFKA-19804 kafka:github:pull:22747 kafka:jira:issue:KAFKA-19738");
    expect(owner[0]!.acceptable.split(" ")).toContain("kafka:jira:issue:KAFKA-20397");
    expect([owner[0]!.notInTop3, owner[0]!.within]).toEqual([RELEASE_MANAGER_THREAD, 3]);
    expect(testPlanRows.filter((row) => row.labels === "implementer")).toHaveLength(testPlanRows.length - 1);
  });

  test("N3: the snapshot states where it comes from and holds whole threads as the release stores them", async () => {
    const { snapshot, fixture } = await loadRealCorpus();
    expect(snapshot.provenance).toMatchObject({
      indexRevision: "feed-2026-10-12T02-07-12-000Z",
      generatedAt: "2026-10-12T02:07:12.000Z",
      capturedAt: "2026-10-12",
      lexicalRevision: "bm25-reference@2",
      groupCount: 4093,
      depth: SNAPSHOT_DEPTH,
    });
    expect(snapshot.provenance.source).toContain("oss-knowledge-base-dev");
    expect([snapshot.corpus.chunkCount, snapshot.corpus.totalChunkLength]).toEqual([8700, 843737]);
    expect(fixture.chunks).toHaveLength(1134);
    expect(new Set(fixture.chunks.map((chunk) => chunk.groupRootRecordId)).size).toBe(343);
    expect((await Bun.file(realCorpusSnapshotPath).arrayBuffer()).byteLength).toBeLessThan(1_500_000);
    expect(fixture.syntheticRecordIds).toEqual([]);
    for (const chunk of fixture.chunks) {
      expect(chunk.contentHash).toBe(`sha256:${new Bun.CryptoHasher("sha256").update(chunk.text).digest("hex")}`);
      expect(chunk.canonicalUrl).toMatch(/^https:\/\/(github\.com\/apache\/|issues\.apache\.org\/jira\/|lists\.apache\.org\/)/u);
    }
    expect(fixture.chunks.filter((chunk) => chunk.groupRootRecordId === RELEASE_MANAGER_THREAD)).toHaveLength(19);
    expect(fixture.chunks.map((chunk) => chunk.id)).toEqual(fixture.chunks.map((chunk) => chunk.id).sort());
  });
});

describe("Spec 017 real-corpus snapshot: failure", () => {
  const rejected: readonly (readonly [string, (input: Record<string, any>) => void, string])[] = [
    ["another schema", (input) => { input.schema = "osskb.search-golden-fixture.v2"; }, "expected osskb.search-corpus-snapshot.v1"],
    ["a query term without a recorded document frequency", (input) => { delete input.corpus.documentFrequency.manager; }, "no document frequency for query term manager"],
    ["a document frequency below what the snapshot itself holds", (input) => { input.corpus.documentFrequency.manager = 3; }, "document frequency 3 of manager is outside"],
    ["a document frequency above the release's chunk count", (input) => { input.corpus.documentFrequency.txn = 8701; }, "document frequency 8701 of txn is outside"],
    ["a release smaller than the snapshot", (input) => { input.corpus.chunkCount = 1133; }, "corpus.chunkCount is below the snapshot's own chunk count"],
    ["no total chunk length", (input) => { input.corpus.totalChunkLength = 0; }, "corpus.totalChunkLength must be a positive integer"],
    ["statistics of bm25-reference@1", (input) => { input.provenance.lexicalRevision = "bm25-reference@1"; }, "statistics of bm25-reference@1 do not fit"],
    ["a judged thread that is not in the snapshot", (input) => { input.chunks = input.chunks.filter((chunk: { groupRootRecordId: string }) => chunk.groupRootRecordId !== RELEASE_MANAGER_THREAD); }, "is not a group root record"],
    ["a chunk whose thread root is missing", (input) => { input.chunks = input.chunks.filter((chunk: { recordId: string }) => chunk.recordId !== RELEASE_MANAGER_THREAD); }, "references missing record"],
  ];

  test.each(rejected)("N13: the snapshot parser rejects %s", async (_case, edit, message) => {
    const input = clone(await Bun.file(realCorpusSnapshotPath).json());
    await expect(parseRealCorpus(clone(input))).resolves.toBeDefined();
    edit(input);
    await expect(parseRealCorpus(input)).rejects.toThrow(message);
  });

  test("N13: scoring a term the snapshot has no release statistic for throws instead of counting it absent", async () => {
    const { snapshot, fixture, identifierProfiles } = await loadRealCorpus();
    const config = lexicalSearchConfigFor("bm25-reference@3", identifierProfiles);
    const configuration = releaseEvaluationConfiguration("test", fixture.chunks, config, releaseStatistics(snapshot));
    const query = fixture.queries[0]!;
    await expect(configuration.search(query, 20)).resolves.toHaveLength(20);
    await expect(configuration.search({ ...query, request: { query: "request manager heartbeat" } }, 20)).resolves.toHaveLength(20);
    await expect(configuration.search({ ...query, request: { query: "partition" } }, 20))
      .rejects.toThrow("The real-corpus snapshot has no document frequency for partition");
    // Every recorded statistic belongs to a case query; nothing else is stored.
    expect(Object.keys(snapshot.corpus.documentFrequency).sort()).toEqual([...realCorpusQueryTerms(config)]);
    expect(Object.keys(lexicalShardPostings(fixture.chunks, config).postings)).toContain("partition");
  });
});
