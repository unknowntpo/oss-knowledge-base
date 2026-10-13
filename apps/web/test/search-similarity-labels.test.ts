import { describe, expect, test } from "bun:test";

import type { ReplayFixture } from "../scripts/capture-search-replay";
import { judgedCandidates, SCORED_FIXTURE, semanticThreads } from "../scripts/eval-search-similarity";
import { testPlanRows } from "./search-similarity-labels.cases";

const scored = await Bun.file(SCORED_FIXTURE).json() as ReplayFixture;
const judged = await judgedCandidates();

describe("Spec 016 fusion: hand labels of semantic candidates", () => {
  test.each([...testPlanRows])("H88: $type query $query carries a judgement for each of its first seven semantic threads", (item) => {
    expect(item.judgements).toMatch(/^[RPI]{7}$/u);
    expect(["english phrase", "class name", "chinese", "paraphrase", "one word"]).toContain(item.type);
    const replay = scored.queries.find((query) => query.query === item.query)!;
    expect(replay.semantic).toBe("ok");
    const shown = semanticThreads(replay);
    // The seven judged threads were shown with their similarity, and so was the 20th.
    for (const rank of [1, 2, 3, 4, 5, 6, 7, 20]) expect(shown.some((thread) => thread[3] === rank)).toBe(true);
    const mine = judged.filter((candidate) => candidate.query === item.query);
    expect(mine.map((candidate) => candidate.judgement).join("")).toBe(item.judgements);
    expect(mine.every((candidate) => candidate.belowBest >= 0 && candidate.similarity > 0)).toBe(true);
  });
});
