import { describe, expect, test } from "bun:test";

import { leadingFullMatchFusionConfig, lexicalHeadFusionConfig } from "@oss-knowledge-base/search";

import type { ReplayFixture } from "../scripts/capture-search-replay";
import { fuseReplay, isWorseThanLexical, ranksIn } from "../scripts/eval-search-fusion";
import { SCORED_FIXTURE, scoredRows } from "../scripts/eval-search-similarity";
import { testPlanRows } from "./search-fusion-verifier.cases";

const scored = await Bun.file(SCORED_FIXTURE).json() as ReplayFixture;
const rows = await scoredRows();

describe("Spec 016 fusion: the verifier's clean set", () => {
  test.each([...testPlanRows])("H83: the verifier's $kind query $query is replayed with the verifier's labels", (item) => {
    expect(item.labels).toBe("verifier");
    expect(item.within).toBe(5);
    const replay = scored.queries.find((query) => query.query === item.query)!;
    expect(["ok", "skipped"]).toContain(replay.semantic);
    const replayed = rows.find((row) => row.query === item.query);
    // The one query without a label is captured and never counted.
    expect(replayed === undefined).toBe(item.expected === null);
    if (replayed === undefined) return;
    expect(replayed.set).toBe("verifier");
    expect(replayed.expected).toEqual(item.expected!.split(" "));
    // No row of the verifier's set is worse under rrf-group@3 than under rrf-group@2 at the bound.
    const at = (config: typeof lexicalHeadFusionConfig) => ranksIn(fuseReplay(replayed.replay, replayed.projects, config), replayed.expected);
    expect(isWorseThanLexical(at(leadingFullMatchFusionConfig), at(lexicalHeadFusionConfig), replayed.within)).toBe(false);
  });
});
