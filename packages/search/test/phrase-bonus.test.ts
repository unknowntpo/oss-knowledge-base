import { describe, expect, test } from "bun:test";

import {
  buildLexicalIndex,
  lexicalWords,
  searchLexicalIndex,
  threadPhraseLexicalSearchConfig,
  type LexicalSearchConfigV1,
} from "../src";
import { testPlanRows } from "./phrase-bonus.cases";
import { fillerChunks, testChunk } from "./support/chunks";
import { loadGoldenV2 } from "./support/golden-v2";
import { loadRealCorpus } from "./support/real-corpus";

/** `@3` with and without the phrase bonus; the difference of a chunk's two scores is its bonus. */
async function configs(): Promise<readonly [LexicalSearchConfigV1, LexicalSearchConfigV1]> {
  const { identifierProfiles } = await loadGoldenV2();
  const withBonus = { ...threadPhraseLexicalSearchConfig, identifiers: identifierProfiles };
  const { phraseWeight: _phraseWeight, ...withoutBonus } = withBonus;
  return [withBonus, withoutBonus];
}

const pairs = (cell: string | null) => cell === null ? [] : cell.split(" ").map((pair) => pair.split("+") as [string, string]);

describe("Spec 017 phrase bonus (bm25-reference@3)", () => {
  test.each([...testPlanRows])("$id: $case ($query)", async (row) => {
    const [withBonus, withoutBonus] = await configs();
    const chunks = [...fillerChunks, testChunk("subject", row.title, row.text)];
    const index = buildLexicalIndex({ indexRevision: "test", chunks, config: withBonus });
    const plain = buildLexicalIndex({ indexRevision: "test", chunks, config: withoutBonus });
    const score = (target: typeof index) => searchLexicalIndex(target, { query: row.query, limit: 20 })
      .find((result) => result.groupRootRecordId === "test:record:subject")!.matches[0]!.score;

    const idf = (term: string) => {
      const frequency = index.documentFrequency.get(term) ?? 0;
      expect(frequency, `${term} is a term of the chunk`).toBeGreaterThan(0);
      return Math.log(1 + (index.chunks.length - frequency + 0.5) / (frequency + 0.5));
    };
    const credit = (cell: string | null, weight: number) =>
      pairs(cell).reduce((total, [first, second]) => total + weight * (idf(first) + idf(second)) / 2, 0);
    const expected = credit(row.titlePairs, withBonus.titleWeight) + credit(row.textPairs, 1);

    expect(score(index) - score(plain)).toBeCloseTo(expected, 9);
    if (row.titlePairs === null && row.textPairs === null) expect(score(index)).toBe(score(plain));
    else expect(score(index)).toBeGreaterThan(score(plain));
  });

  test("N2: a query and a chunk are read as the same words", () => {
    expect(lexicalWords("HeartbeatRequestManager")).toEqual(["heartbeat", "request", "manager"]);
    expect(lexicalWords("heartbeat request-manager")).toEqual(["heartbeat", "request", "manager"]);
    expect(lexicalWords("RecordAccumulator.ready()")).toEqual(["record", "accumulator", "ready"]);
    expect(lexicalWords("4.4.0 Release Manager")).toEqual(["4", "4", "0", "release", "manager"]);
    expect(lexicalWords("KRaft IDs STALE_MEMBER_EPOCH")).toEqual(["kraft", "ids", "stale_member_epoch"]);
    expect(lexicalWords("  …  ")).toEqual([]);
  });

  test("N2: on the 1,134 real chunks every chunk's bonus is what its words give, for every case query", async () => {
    const { fixture, identifierProfiles } = await loadRealCorpus();
    const withBonus = { ...threadPhraseLexicalSearchConfig, identifiers: identifierProfiles };
    const { phraseWeight: _phraseWeight, ...withoutBonus } = withBonus;
    const index = buildLexicalIndex({ indexRevision: "test", chunks: fixture.chunks, config: withBonus });
    const plain = buildLexicalIndex({ indexRevision: "test", chunks: fixture.chunks, config: withoutBonus });
    const idf = (term: string) => {
      const frequency = index.documentFrequency.get(term) ?? 0;
      return Math.log(1 + (index.chunks.length - frequency + 0.5) / (frequency + 0.5));
    };
    const holds = (words: readonly string[], first: string, second: string) =>
      words.some((word, at) => word === first && words[at + 1] === second);
    const chunkById = new Map(fixture.chunks.map((chunk) => [chunk.id, chunk]));
    const scores = (target: typeof index, query: string) =>
      new Map(searchLexicalIndex(target, { query, limit: 100 }).flatMap((result) => result.matches.map((match) => [match.chunkId, match.score - (match.exactMatch ? withBonus.exactBoost : 0)] as const)));
    let credited = 0;
    let compared = 0;
    for (const { request } of fixture.queries) {
      const words = lexicalWords(request.query.replace(/^KIP770$/u, "KIP-770"));
      const queryPairs = [...new Map(words.slice(0, -1).map((word, at) => [`${word} ${words[at + 1]}`, [word, words[at + 1]!] as const])).values()];
      const before = scores(plain, request.query);
      for (const [chunkId, score] of scores(index, request.query)) {
        if (!before.has(chunkId)) continue;
        const chunk = chunkById.get(chunkId)!;
        const [title, text] = [lexicalWords(chunk.title), lexicalWords(chunk.text)];
        const expected = queryPairs.reduce((total, [first, second]) =>
          total + (holds(title, first, second) ? 4 : holds(text, first, second) ? 1 : 0) * (idf(first) + idf(second)) / 2, 0);
        expect(score - before.get(chunkId)!, `${request.query} ${chunk.recordId}`).toBeCloseTo(expected, 9);
        compared += 1;
        if (expected > 0) credited += 1;
      }
    }
    expect(compared).toBeGreaterThan(1_000);
    expect(credited).toBeGreaterThan(200);
  });

  test("N2: the bonus is the weight times the mean IDF of the pair, four times that in a title", async () => {
    const [withBonus, withoutBonus] = await configs();
    const chunks = [
      ...fillerChunks,
      testChunk("in-title", "Request manager cleanup", "Nothing else."),
      testChunk("in-text", "Cleanup", "The request manager leaks."),
    ];
    const bonus = (config: LexicalSearchConfigV1, key: string) => {
      const scoreWith = (target: LexicalSearchConfigV1) =>
        searchLexicalIndex(buildLexicalIndex({ indexRevision: "test", chunks, config: target }), { query: "request manager", limit: 20 })
          .find((result) => result.groupRootRecordId === `test:record:${key}`)!.matches[0]!.score;
      return scoreWith(config) - scoreWith(withoutBonus);
    };
    // Both words are in 2 of 7 chunks.
    const meanIdf = Math.log(1 + (7 - 2 + 0.5) / (2 + 0.5));
    expect(bonus(withBonus, "in-text")).toBeCloseTo(meanIdf, 12);
    expect(bonus(withBonus, "in-title")).toBeCloseTo(4 * meanIdf, 12);
    expect(bonus({ ...withBonus, phraseWeight: 0.5 }, "in-title")).toBeCloseTo(2 * meanIdf, 12);
  });
});
