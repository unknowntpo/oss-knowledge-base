import { describe, expect, test } from "bun:test";

import { mean, ndcgAtK, recallAtK, reciprocalRankAtK } from "../src";

/** a and c are expected (2), b is acceptable (1); x and y are unjudged. */
const grades = new Map([["a", 2], ["b", 1], ["c", 2]]);

describe("Spec 016 ranking metrics", () => {
  test("H8: Recall@K is the share of expected items in the first K", () => {
    expect(recallAtK(["a", "x", "b", "c"], grades, 20)).toBe(1);
    expect(recallAtK(["a", "x", "b", "c"], grades, 3)).toBe(0.5);
    expect(recallAtK(["a", "x", "b", "c"], grades, 4)).toBe(1);
    expect(recallAtK(["x", "b"], grades, 20)).toBe(0);
    expect(recallAtK([], grades, 20)).toBe(0);
  });

  test("H8: MRR is 1 / rank of the first expected item; acceptable items do not count", () => {
    expect(reciprocalRankAtK(["a", "c"], grades, 20)).toBe(1);
    expect(reciprocalRankAtK(["b", "x", "c"], grades, 20)).toBe(1 / 3);
    expect(reciprocalRankAtK(["b", "x", "c"], grades, 2)).toBe(0);
    expect(reciprocalRankAtK(["b", "x"], grades, 20)).toBe(0);
  });

  test("H8: nDCG@K matches hand-computed values", () => {
    // Gains 2^grade - 1: a = 3, b = 1, c = 3. Ideal order a c b: 3/log2(2) + 3/log2(3) + 1/log2(4)
    // = 3 + 1.8927893 + 0.5 = 5.3927893.
    expect(ndcgAtK(["a", "c", "b"], grades, 10)).toBeCloseTo(1, 12);
    // a x b: 3/1 + 0 + 1/2 = 3.5; 3.5 / 5.3927893 = 0.6490148.
    expect(ndcgAtK(["a", "x", "b"], grades, 10)).toBeCloseTo(0.6490148, 6);
    // x a c b: 3/log2(3) + 3/log2(4) + 1/log2(5) = 1.8927893 + 1.5 + 0.4306766 = 3.8234659; / 5.3927893 = 0.7089960.
    expect(ndcgAtK(["x", "a", "c", "b"], grades, 10)).toBeCloseTo(0.7089960, 6);
    // Cutoff 1: only rank 1 counts on both sides: b gives 1 / 3.
    expect(ndcgAtK(["b", "a"], grades, 1)).toBeCloseTo(1 / 3, 12);
    expect(ndcgAtK(["x", "y"], grades, 10)).toBe(0);
    expect(ndcgAtK(["a"], new Map(), 10)).toBe(0);
  });

  test("H8: a negative or zero grade adds no gain", () => {
    expect(ndcgAtK(["n", "a"], new Map([["a", 2], ["n", -1]]), 10)).toBeCloseTo(1 / Math.log2(3), 12);
    expect(ndcgAtK(["z", "a"], new Map([["a", 2], ["z", 0]]), 10)).toBeCloseTo(1 / Math.log2(3), 12);
  });

  test("H20: invalid metric inputs are rejected", () => {
    expect(() => recallAtK(["a"], new Map([["b", 1]]), 20)).toThrow("at least one expected item");
    expect(() => recallAtK(["a"], grades, 0)).toThrow("positive integer");
    expect(() => reciprocalRankAtK(["a"], grades, 1.5)).toThrow("positive integer");
    expect(() => ndcgAtK(["a", "a"], grades, 10)).toThrow("must not repeat");
    expect(recallAtK(["a"], grades, 1)).toBe(0.5);
  });

  test("H8: the aggregate is the arithmetic mean", () => {
    expect(mean([1, 0, 0.5])).toBe(0.5);
    expect(mean([])).toBe(0);
  });
});
