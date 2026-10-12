import { describe, expect, test } from "bun:test";

import { lexicalSearchConfigFor, lexicalShardPostings, rankLexicalShard, selectLexicalResults } from "../src";
import { RELEASE_MANAGER_THREAD, testPlanRows as caseRows } from "./real-corpus.cases";
import { testPlanRows } from "./real-corpus-guards.cases";
import { loadRealCorpus, releaseStatistics } from "./support/real-corpus";

const loaded = loadRealCorpus();

async function ranked(revision: string, query: string): Promise<readonly string[]> {
  const { snapshot, fixture, identifierProfiles } = await loaded;
  const config = lexicalSearchConfigFor(revision, identifierProfiles);
  const shard = { chunks: fixture.chunks, ...lexicalShardPostings(fixture.chunks, config) };
  return selectLexicalResults(rankLexicalShard(shard, releaseStatistics(snapshot), { query }, config), { limit: 100 })
    .results.map((result) => result.groupRootRecordId);
}

describe("Spec 017 real-corpus guard rows", () => {
  test.each([...testPlanRows])("$id: $case — `$query` is $at2 at @2 and $at3 at @3", async (row) => {
    const expected = row.expected.split(" ");
    const before = await ranked("bm25-reference@2", row.query);
    const after = await ranked("bm25-reference@3", row.query);
    const ranks = (order: readonly string[]) => expected.map((id) => order.indexOf(id) + 1);
    expect(ranks(before).join(" ")).toBe(row.ranksAt2);
    expect(ranks(after).join(" ")).toBe(row.ranksAt3);
    const status = (order: readonly string[]) => ranks(order).every((rank) => rank >= 1 && rank <= row.within) ? "pass" : "fail";
    expect([status(before), status(after)]).toEqual([row.at2, row.at3]);
    // The guard itself: no expected thread ranks lower at @3 than at @2.
    for (const [index, rank] of ranks(after).entries()) expect(rank, expected[index]).toBeLessThanOrEqual(ranks(before)[index]!);
    if (row.longThread !== null) {
      expect(`${before.indexOf(RELEASE_MANAGER_THREAD) + 1} ${after.indexOf(RELEASE_MANAGER_THREAD) + 1}`).toBe(row.longThread);
    }
  });

  test("N18: the guard rows are new queries built from the case queries' words, and say which fail", async () => {
    const { snapshot } = await loaded;
    const known = new Set(caseRows.map((row) => row.query as string));
    for (const row of testPlanRows) {
      expect(known.has(row.query), row.query).toBeFalse();
      // Every statistic the row needs is recorded: ranking it did not throw, and its words are case words.
      for (const word of row.query.split(" ")) expect(Object.keys(snapshot.corpus.documentFrequency), row.query).toContain(word);
      expect(row.case.startsWith("known limitation")).toBe(row.at3 === "fail");
    }
    expect(testPlanRows.filter((row) => row.at3 === "fail").map((row) => row.query)).toEqual(["storage tiered", "controller kraft", "manager request"]);
    expect(testPlanRows.filter((row) => row.case.startsWith("long thread")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("Spec 017 ablation table", () => {
  test("N19: `real-corpus -- --ablation` runs from the committed snapshot and prints the committed table", async () => {
    const script = new URL("../scripts/real-corpus.ts", import.meta.url).pathname;
    const run = Bun.spawn(["bun", script, "--ablation"], { stdout: "pipe", stderr: "pipe" });
    const [output, exit] = [await new Response(run.stdout).text(), await run.exited];
    expect(exit).toBe(0);
    const table = await Bun.file(new URL("./fixtures/real-corpus-ablation.txt", import.meta.url)).text();
    expect(output).toBe(table);
    const row = (name: string) => table.split("\n").find((line) => line.startsWith(name))!.split(/\s{2,}/u);
    expect(table.split("\n")[0]).toBe("Measured on the committed snapshot of feed-2026-10-12T02-07-12-000Z (1134 of 8700 chunks).");
    expect(row("@2  ").slice(2, 4)).toEqual(["21", "7"]);
    expect(row("@3 = geometric + phrase 1").slice(2, 4)).toEqual(["21", "20"]);
    // The coverage variant exists only in the script; it does not beat @3 on any aggregate.
    const [at3, covered] = [row("@3 = geometric + phrase 1"), row("@3 x coverage (evaluation only)")];
    for (const column of [6, 7, 8]) expect(Number(covered[column])).toBeLessThan(Number(at3[column]));
  });

  test("N19: --write and --check refuse to run without a release on disk", async () => {
    const script = new URL("../scripts/real-corpus.ts", import.meta.url).pathname;
    for (const flag of ["--write", "--check"]) {
      const run = Bun.spawn(["bun", script, flag], { stdout: "pipe", stderr: "pipe" });
      const [error, exit] = [await new Response(run.stderr).text(), await run.exited];
      expect(exit).not.toBe(0);
      expect(error).toContain("--write and --check need --release");
    }
  });
});
