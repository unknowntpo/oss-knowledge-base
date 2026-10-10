import { describe, expect, test } from "bun:test";

import {
  evaluateGoldenFixture,
  evaluateQuery,
  formatEvaluationTable,
  parseSearchGoldenFixture,
  parseSearchGoldenFixtureV2,
  type EvaluationConfigurationV1,
  type GoldenEvaluationReportV1,
} from "../src";
import {
  HYBRID_FAKE,
  LEXICAL_AFTER,
  LEXICAL_BEFORE,
  evaluateGoldenV2,
  goldenV2Path,
  goldenV2ReportPath,
  loadGoldenV2,
} from "./support/golden-v2";

const goldenV1Path = new URL("./fixtures/golden-queries.v1.json", import.meta.url);

function clone(value: unknown): Record<string, any> {
  return structuredClone(value) as Record<string, any>;
}

function configuration(report: GoldenEvaluationReportV1, id: string) {
  const found = report.configurations.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No configuration ${id}`);
  return found;
}

describe("Spec 016 golden v2 fixture", () => {
  test("H9: the fixture carries every v1 chunk and query and marks its hand-written records", async () => {
    const raw = await Bun.file(goldenV2Path).json();
    const fixture = parseSearchGoldenFixtureV2(raw);
    const v1 = parseSearchGoldenFixture(await Bun.file(goldenV1Path).json());

    expect(fixture.chunks.slice(0, v1.chunks.length)).toEqual([...v1.chunks]);
    expect(fixture.queries.slice(0, v1.queries.length).map((query) => [query.id, query.request, query.requires]))
      .toEqual(v1.queries.map((query) => [query.id, query.request, query.minimumPhase === 1 ? "lexical" : "semantic"]));
    for (const [index, query] of v1.queries.entries()) {
      const carried = fixture.queries[index]!;
      expect(carried.judgments).toEqual([
        ...query.expectation.requiredGroupRootRecordIds.map((groupRootRecordId) => ({ groupRootRecordId, grade: 2 as const })),
        ...query.expectation.acceptableGroupRootRecordIds.map((groupRootRecordId) => ({ groupRootRecordId, grade: 1 as const })),
      ]);
      expect(carried.negativeGroupRootRecordIds).toEqual(query.expectation.forbiddenGroupRootRecordIds);
      expect([carried.requiredWithin, carried.negativeWithin]).toEqual([query.expectation.topK, query.expectation.topK]);
    }
    // Every record that is not a v1 copy is declared synthetic, and nothing else is.
    const v1Records = new Set(v1.chunks.map((chunk) => chunk.recordId));
    expect([...fixture.syntheticRecordIds].sort())
      .toEqual(fixture.chunks.map((chunk) => chunk.recordId).filter((recordId) => !v1Records.has(recordId)).sort());
    expect(fixture.syntheticRecordIds.length).toBe(15);
    for (const chunk of fixture.chunks) {
      expect(chunk.contentHash).toBe(`sha256:${new Bun.CryptoHasher("sha256").update(chunk.text).digest("hex")}`);
    }
    expect(fixture.queries.filter((query) => query.requires === "semantic").map((query) => query.id))
      .toEqual(["vocabulary-gap-cold-data", "abbreviation-txn", "multilingual-transaction-timeout"]);
    const labelled = fixture.queries.find((query) => query.id === "term-consumer-request-manager")!;
    expect(labelled.request.query).toBe("consumer network thread request manager");
    expect(labelled.judgments).toEqual([
      { groupRootRecordId: "kafka:jira:issue:KAFKA-19804", grade: 2 },
      { groupRootRecordId: "kafka:github:pull:22747", grade: 2 },
      { groupRootRecordId: "kafka:jira:issue:KAFKA-19738", grade: 2 },
      { groupRootRecordId: "kafka:jira:issue:KAFKA-20397", grade: 1 },
    ]);
    expect(labelled.negativeGroupRootRecordIds).toEqual(["kafka:mail:dev:release-manager-4-4-0"]);
    expect([labelled.negativeWithin, labelled.ordered]).toEqual([3, true]);
  });

  const rejectedFixtures: readonly (readonly [string, (input: Record<string, any>) => void, string])[] = [
    ["a judgment on a missing record", (input) => { input.queries[8].judgments[0].groupRootRecordId = "missing:record"; }, "missing:record is not a group root record"],
    ["a judgment on a reply instead of the thread root", (input) => { input.queries[8].judgments[0].groupRootRecordId = "kafka:mail:dev:release-manager-4-4-0:reply-1"; }, "is not a group root record"],
    ["a group graded twice", (input) => { input.queries[8].negativeGroupRootRecordIds = ["kafka:jira:issue:KAFKA-19804"]; }, "duplicate value kafka:jira:issue:KAFKA-19804"],
    ["a grade outside 1 and 2", (input) => { input.queries[8].judgments[0].grade = 0; }, "must be 1 or 2"],
    ["no expected group", (input) => { input.queries[8].judgments = [{ groupRootRecordId: "kafka:jira:issue:KAFKA-20397", grade: 1 }]; }, "needs at least one grade 2 group"],
    ["more expected groups than requiredWithin", (input) => { input.queries[8].requiredWithin = 2; }, "cannot hold every grade 2 group"],
    ["an unknown retrieval requirement", (input) => { input.queries[8].requires = "rerank"; }, "must be lexical or semantic"],
    ["an undeclared synthetic record", (input) => { input.provenance.syntheticRecordIds.push("kafka:missing"); }, "references missing record kafka:missing"],
    ["evidence outside an expected group", (input) => { input.queries[8].requiredEvidenceRecordIds = ["kafka:jira:issue:KAFKA-20397"]; }, "does not belong to a grade 2 group"],
    ["an identifier profile for an unknown project", (input) => { input.identifierProfiles["apache-flink"] = []; }, "unknown project apache-flink"],
    ["an identifier pattern without a capture group", (input) => { input.identifierProfiles["apache-kafka"][0].textPattern = "KIP-\\d+"; }, "exactly one capture group"],
    ["the v1 schema", (input) => { input.schema = "osskb.search-golden-fixture.v1"; }, "expected osskb.search-golden-fixture.v2"],
  ];

  test.each(rejectedFixtures)("H16: the parser rejects %s", async (_case, edit, message) => {
    const input = clone(await Bun.file(goldenV2Path).json());
    expect(() => parseSearchGoldenFixtureV2(input)).not.toThrow();
    edit(input);
    expect(() => parseSearchGoldenFixtureV2(input)).toThrow(message);
  });
});

describe("Spec 016 golden v2 evaluation", () => {
  test("H9: the committed report is what the runner produces", async () => {
    const report = await evaluateGoldenV2(await loadGoldenV2());
    expect(report).toEqual(await Bun.file(goldenV2ReportPath).json());
    expect(report.configurations.map((item) => item.id)).toEqual([LEXICAL_BEFORE, LEXICAL_AFTER, HYBRID_FAKE]);
    expect(report.configurations.every((item) => item.queries.length === 16)).toBeTrue();
    // Deterministic: a second run is identical, and so is its table.
    const again = await evaluateGoldenV2(await loadGoldenV2());
    expect(again).toEqual(report);
    expect(formatEvaluationTable(again)).toBe(formatEvaluationTable(report));
  });

  test("H9: the table lists aggregates per configuration and every query that did not pass", async () => {
    const report = await evaluateGoldenV2(await loadGoldenV2());
    const lines = formatEvaluationTable(report).split("\n");
    expect(lines[0]).toBe("Golden evaluation golden-kafka-datafusion-2026-10-10.v2 (depth 20)");
    expect(lines[2]).toMatch(/^configuration\s+queries\s+n\s+pass\s+semantic-required\s+fail\s+Recall@20\s+MRR\s+nDCG@10$/u);
    const before = configuration(report, LEXICAL_BEFORE).lexicalQueries;
    expect(lines.some((line) => line.startsWith(LEXICAL_BEFORE) && line.includes(" lexical ") &&
      line.endsWith(`${before.recallAt20.toFixed(4)}     ${before.mrr.toFixed(4)}  ${before.ndcgAt10.toFixed(4)}`))).toBeTrue();
    expect(lines.filter((line) => line.includes("abbreviation-txn")).map((line) => line.split(/\s{2,}/u)[2]))
      .toEqual(["semantic-required", "semantic-required"]);
  });

  test("H2: at @2 lexical recall reaches every expected answer of the lexical queries, and nothing that passed at @1 fails", async () => {
    const report = await evaluateGoldenV2(await loadGoldenV2());
    const before = configuration(report, LEXICAL_BEFORE);
    const after = configuration(report, LEXICAL_AFTER);
    expect(before.lexicalQueries.recallAt20).toBeLessThan(1);
    expect(after.lexicalQueries.recallAt20).toBe(1);
    expect(after.lexicalQueries.pass).toBeGreaterThan(before.lexicalQueries.pass);
    const passedBefore = before.queries.filter((query) => query.status === "pass").map((query) => query.queryId);
    expect(passedBefore.length).toBeGreaterThan(5);
    for (const queryId of passedBefore) {
      expect(after.queries.find((query) => query.queryId === queryId)!.status, queryId).toBe("pass");
    }
    for (const queryId of ["identifier-kip-hyphenated", "identifier-kip-no-hyphen", "identifier-bare-number"]) {
      expect(after.queries.find((query) => query.queryId === queryId)!.status, queryId).toBe("pass");
    }
    expect(before.queries.find((query) => query.queryId === "identifier-kip-no-hyphen")!.status).toBe("fail");
    expect(before.queries.find((query) => query.queryId === "identifier-bare-number")!.status).toBe("fail");
  });

  test("H17: a semantic query that fails on lexical-only search is semantic-required, not a failure", async () => {
    const report = await evaluateGoldenV2(await loadGoldenV2());
    for (const id of [LEXICAL_BEFORE, LEXICAL_AFTER]) {
      const lexicalOnly = configuration(report, id);
      const statuses = Object.fromEntries(lexicalOnly.queries.filter((query) => query.requires === "semantic")
        .map((query) => [query.queryId, query.status]));
      expect(statuses).toEqual({
        "vocabulary-gap-cold-data": "pass",
        "abbreviation-txn": "semantic-required",
        "multilingual-transaction-timeout": "semantic-required",
      });
      expect(lexicalOnly.semanticQueries.fail).toBe(0);
      expect(lexicalOnly.semanticQueries.semanticRequired).toBe(2);
      // Positive control: a lexical query that fails on the same configuration is a failure.
      expect(lexicalOnly.lexicalQueries.fail).toBeGreaterThan(0);
      expect(lexicalOnly.lexicalQueries.semanticRequired).toBe(0);
    }
    const hybrid = configuration(report, HYBRID_FAKE);
    expect(hybrid.semanticQueries).toMatchObject({ queries: 3, pass: 3, semanticRequired: 0, fail: 0 });
  });

  test("H17: a semantic query that fails with a semantic retriever is a failure", async () => {
    const fixture = await loadGoldenV2();
    const empty: EvaluationConfigurationV1 = { id: "empty hybrid", semantic: true, search: async () => [] };
    const emptyLexical: EvaluationConfigurationV1 = { id: "empty lexical", semantic: false, search: async () => [] };
    const report = await evaluateGoldenFixture(fixture, [empty, emptyLexical]);
    expect(configuration(report, "empty hybrid").all).toMatchObject({ pass: 0, semanticRequired: 0, fail: 16, recallAt20: 0, mrr: 0, ndcgAt10: 0 });
    expect(configuration(report, "empty lexical").all).toMatchObject({ pass: 0, semanticRequired: 3, fail: 13 });
  });

  test("H9: one query is graded on required rank, negatives, evidence and order", async () => {
    const fixture = await loadGoldenV2();
    const query = fixture.queries.find((candidate) => candidate.id === "term-consumer-request-manager")!;
    const group = (groupRootRecordId: string) => ({ groupRootRecordId, evidenceRecordIds: [groupRootRecordId] });
    const [a, b, c, acceptable, negative] = [
      "kafka:jira:issue:KAFKA-19804", "kafka:github:pull:22747", "kafka:jira:issue:KAFKA-19738",
      "kafka:jira:issue:KAFKA-20397", "kafka:mail:dev:release-manager-4-4-0",
    ].map(group) as [ReturnType<typeof group>, ReturnType<typeof group>, ReturnType<typeof group>, ReturnType<typeof group>, ReturnType<typeof group>];

    expect(evaluateQuery(query, false, [a, b, c, acceptable, negative])).toEqual({
      queryId: "term-consumer-request-manager", requires: "lexical", status: "pass",
      recallAt20: 1, mrr: 1, ndcgAt10: 1, orderCorrect: true, failures: [],
      top: [a, b, c, acceptable, negative].map((item) => item.groupRootRecordId),
    });
    const swapped = evaluateQuery(query, false, [a, c, b, acceptable]);
    expect([swapped.status, swapped.orderCorrect]).toEqual(["pass", false]);
    const negativeThird = evaluateQuery(query, false, [a, b, negative, c]);
    expect(negativeThird.status).toBe("fail");
    expect(negativeThird.failures).toEqual([
      "kafka:jira:issue:KAFKA-19738 is not in the top 3",
      "negative kafka:mail:dev:release-manager-4-4-0 ranks 3",
    ]);
    // The boundary: rank 4 is outside negativeWithin 3, but it pushes an expected group out of the top 3.
    expect(evaluateQuery(query, false, [a, b, c, negative]).status).toBe("pass");

    const withEvidence = fixture.queries.find((candidate) => candidate.id === "identifier-kip-no-hyphen")!;
    const kip = "kafka:mail:dev:kip-770-discuss";
    expect(evaluateQuery(withEvidence, false, [{ groupRootRecordId: kip, evidenceRecordIds: [] }]).failures)
      .toEqual([`evidence ${kip} is not shown`]);
    expect(evaluateQuery(withEvidence, false, [group(kip)]).status).toBe("pass");
    expect(evaluateQuery(withEvidence, false, [group(kip)]).orderCorrect).toBeUndefined();
  });
});
