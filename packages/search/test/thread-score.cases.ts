/**
 * Spec 017 thread-score test plan: the single source for `thread-score.test.ts` and for the table
 * in docs/specs/017-lexical-ranking/spec.md (`bun run docs:test-plan` regenerates it).
 * A thread of `chunks` identical matching chunks scores `at2` times its best chunk at
 * `bm25-reference@2` and `at3` times at `bm25-reference@3` (ratio 0.25, limit 4/3).
 */
export const testPlanRows = [
  { id: "N1", case: "one chunk", chunks: 1, at2: 1, at3: 1 },
  { id: "N1", case: "two chunks: the same at both revisions", chunks: 2, at2: 1.25, at3: 1.25 },
  { id: "N1", case: "three chunks: the first difference", chunks: 3, at2: 1.5, at3: 1.3125 },
  { id: "N1", case: "five chunks", chunks: 5, at2: 2, at3: 1.33203125 },
  { id: "N1", case: "19 chunks, as in the 4.4.0 Release Manager thread", chunks: 19, at2: 5.5, at3: 1.3333333333284827 },
  { id: "N1", case: "130 chunks, as in the playground pull request", chunks: 130, at2: 33.25, at3: 1.3333333333333333 },
] as const;
