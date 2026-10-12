import { describe, expect, test } from "bun:test";

import {
  buildLexicalIndex,
  codeTextLexicalSearchConfig,
  searchLexicalIndex,
  threadPhraseLexicalSearchConfig,
  type LexicalSearchConfigV1,
  type SourceRecordChunkV1,
} from "../src";
import { fillerChunks, testChunk } from "./support/chunks";
import { testPlanRows } from "./thread-score.cases";

const AT2 = codeTextLexicalSearchConfig;
const AT3 = threadPhraseLexicalSearchConfig;

/** A mail thread: every message repeats the thread title, as dev@ replies do. */
function thread(key: string, title: string, messages: number, text = "+1, thanks for volunteering."): readonly SourceRecordChunkV1[] {
  return Array.from({ length: messages }, (_, index) =>
    testChunk(index === 0 ? key : `${key}-reply-${String(index).padStart(3, "0")}`, title, text, { root: key }));
}

function search(chunks: readonly SourceRecordChunkV1[], config: LexicalSearchConfigV1, query: string) {
  return searchLexicalIndex(buildLexicalIndex({ indexRevision: "test", chunks, config }), { query, limit: 20 });
}

const root = (key: string) => `test:record:${key}`;

/** Enough unrelated records that a word of a 19-message thread is still a rare word. */
const corpus = Array.from({ length: 300 }, (_, index) =>
  testChunk(`corpus-${String(index).padStart(3, "0")}`, `Topic ${index}`, `Discussion number ${index}.`));

describe("Spec 017 thread score (bm25-reference@3)", () => {
  test.each([...testPlanRows])("$id: $case scores $at3 times its best chunk at @3 and $at2 times at @2", (row) => {
    const chunks = [...fillerChunks, ...thread("release", "Re: Release Manager", row.chunks)];
    for (const [config, factor] of [[AT2, row.at2], [AT3, row.at3]] as const) {
      const [result] = search(chunks, config, "manager");
      expect(result!.groupRootRecordId).toBe(root("release"));
      expect(result!.score / result!.matches[0]!.score).toBeCloseTo(factor, 12);
    }
    // The limit 1 / (1 - 0.25) is never reached or passed.
    expect(row.at3).toBeLessThan(4 / 3 + 1e-15);
  });

  test("N1: chunks count best first, each further one a quarter of the one before", () => {
    // Four messages with different texts, so four different scores.
    const chunks = [
      ...fillerChunks,
      testChunk("mixed", "Release Manager", "Volunteering as release manager for the manager rotation."),
      testChunk("mixed-2", "Re: Release Manager", "+1", { root: "mixed" }),
      testChunk("mixed-3", "Re: Release Manager", "The manager of the previous release wrote a long checklist that everyone follows closely.", { root: "mixed" }),
      testChunk("mixed-4", "Unrelated subject", "Thanks to the manager.", { root: "mixed" }),
    ];
    const [at3] = search(chunks, AT3, "manager");
    const [at2] = search(chunks, AT2, "manager");
    const scores = at3!.matches.map((match) => match.score);
    expect(scores).toHaveLength(4);
    expect(new Set(scores).size).toBe(4);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
    expect(at3!.score).toBeCloseTo(scores[0]! + scores[1]! / 4 + scores[2]! / 16 + scores[3]! / 64, 12);
    // Positive control: the same chunks at @2 add a flat quarter of every further chunk.
    expect(at2!.matches.map((match) => match.score)).toEqual(scores);
    expect(at2!.score).toBeCloseTo(scores[0]! + (scores[1]! + scores[2]! + scores[3]!) / 4, 12);
    expect(at3!.score).toBeLessThan(at2!.score);
  });

  test("N1: a 19-message thread holding one query word no longer outranks a record holding both", () => {
    const chunks = [
      ...corpus,
      ...thread("release", "Re: 4.4.0 Release Manager", 19),
      testChunk("both-apart", "Request a new manager", "For the next cycle."),
    ];
    const order = (config: LexicalSearchConfigV1) => search(chunks, config, "request manager").map((result) => result.groupRootRecordId);
    expect(order(AT2)).toEqual([root("release"), root("both-apart")]);
    expect(order(AT3)).toEqual([root("both-apart"), root("release")]);
  });

  test("N1: a long thread still leads the query its title answers", () => {
    const chunks = [
      ...corpus,
      ...thread("release", "Re: 4.4.0 Release Manager", 19),
      testChunk("words-apart", "Manager of the next release", "The release needs a manager."),
      testChunk("one-word", "LogManager cleanup", "Remove the builder."),
    ];
    for (const config of [AT2, AT3]) {
      expect(search(chunks, config, "release manager")[0]!.groupRootRecordId).toBe(root("release"));
    }
    expect(search(chunks, AT3, "release manager").map((result) => result.groupRootRecordId))
      .toEqual([root("release"), root("words-apart"), root("one-word")]);
  });

  test("N1: the evidence shown for a thread is unchanged: its best five chunks, best first", () => {
    const chunks = [...fillerChunks, ...thread("release", "Re: Release Manager", 19)];
    const [at2] = search(chunks, AT2, "manager");
    const [at3] = search(chunks, AT3, "manager");
    expect(at3!.matches).toEqual(at2!.matches);
    expect(at3!.matches).toHaveLength(5);
  });
});
