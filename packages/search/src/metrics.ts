/**
 * Ranking metrics over graded relevance (Spec 016 Behavior 10). Grades: 2 = expected,
 * 1 = acceptable, 0 or unjudged = not relevant. `ranked` is a list of ids, best first.
 */
export type RelevanceGrades = ReadonlyMap<string, number>;

/** The grade from which a result counts as a correct answer for Recall and MRR. */
export const EXPECTED_GRADE = 2;

/** Share of the expected (grade 2) items that appear in the first `k` results. */
export function recallAtK(ranked: readonly string[], grades: RelevanceGrades, k: number): number {
  requireCutoff(k);
  const expected = [...grades].filter(([, grade]) => grade >= EXPECTED_GRADE).map(([id]) => id);
  if (expected.length === 0) throw new Error("Recall needs at least one expected item");
  const window = new Set(ranked.slice(0, k));
  return expected.filter((id) => window.has(id)).length / expected.length;
}

/** 1 / rank of the first expected (grade 2) item in the first `k` results, or 0. */
export function reciprocalRankAtK(ranked: readonly string[], grades: RelevanceGrades, k: number): number {
  requireCutoff(k);
  const index = ranked.slice(0, k).findIndex((id) => (grades.get(id) ?? 0) >= EXPECTED_GRADE);
  return index < 0 ? 0 : 1 / (index + 1);
}

/**
 * Normalized discounted cumulative gain over the first `k` results, with gain 2^grade - 1 and
 * discount log2(rank + 1). 0 when nothing is relevant.
 */
export function ndcgAtK(ranked: readonly string[], grades: RelevanceGrades, k: number): number {
  requireCutoff(k);
  if (new Set(ranked).size !== ranked.length) throw new Error("A ranking must not repeat an id");
  const dcg = (values: readonly number[]) =>
    values.slice(0, k).reduce((total, grade, index) => total + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const ideal = dcg([...grades.values()].filter((grade) => grade > 0).sort((left, right) => right - left));
  return ideal === 0 ? 0 : dcg(ranked.map((id) => Math.max(0, grades.get(id) ?? 0))) / ideal;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function requireCutoff(k: number): void {
  if (!Number.isInteger(k) || k <= 0) throw new Error("A metric cutoff must be a positive integer");
}
