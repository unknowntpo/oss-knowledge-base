import { describe, expect, test } from "bun:test";

import { leadingFullMatchFusionConfig, lexicalHeadFusionConfig } from "@oss-knowledge-base/search";

import { fuseReplay, isMet, isWorseThanLexical, lexicalOrder, ranksIn } from "../scripts/eval-search-fusion";
import { scoredRows } from "../scripts/eval-search-similarity";
import { evalQueries } from "../scripts/measure-search-hybrid";
import { testPlanRows } from "./search-fusion-clean3.cases";
import { testPlanRows as newRows } from "./search-fusion-new.cases";
import { testPlanRows as verifierRows } from "./search-fusion-verifier.cases";

const rows = await scoredRows();
const asked = new Set([...evalQueries().map((query) => query.query), ...newRows.map((row) => row.query), ...verifierRows.map((row) => row.query)]);

describe("Spec 016 fusion: queries written for rrf-group@3", () => {
  test.each([...testPlanRows])("H84: clean $kind query $query is met, and not worse than lexical-only or than rrf-group@2, under rrf-group@3", (item) => {
    const replayed = rows.find((row) => row.query === item.query)!;
    expect(replayed.set).toBe("clean-3");
    expect(item.labels).toBe("implementer");
    expect(asked.has(item.query)).toBe(false);
    const at = (config: typeof lexicalHeadFusionConfig) => ranksIn(fuseReplay(replayed.replay, replayed.projects, config), replayed.expected);
    expect(isWorseThanLexical(ranksIn(lexicalOrder(replayed.replay), replayed.expected), at(lexicalHeadFusionConfig), replayed.within)).toBe(false);
    expect(isWorseThanLexical(at(leadingFullMatchFusionConfig), at(lexicalHeadFusionConfig), replayed.within)).toBe(false);
    expect(isMet(at(lexicalHeadFusionConfig), replayed.within)).toBe(true);
  });
});
