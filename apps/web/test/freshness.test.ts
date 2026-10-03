import { describe, expect, test } from "bun:test";

import { feedFreshness } from "../src/freshness";

const generatedAt = "2026-10-03T23:07:13.000Z";
const at = (offsetMs: number) => Date.parse(generatedAt) + offsetMs;
const minute = 60_000;
const hour = 60 * minute;

describe("Spec 010 feed freshness", () => {
  test("F1: reports whole hours from one hour and whole minutes below it", () => {
    expect(feedFreshness(generatedAt, at(2 * hour))).toEqual({ labelKey: "freshness.hours", value: 2, stale: false });
    expect(feedFreshness(generatedAt, at(28 * minute + 24_000))).toEqual({ labelKey: "freshness.minutes", value: 28, stale: false });
    expect(feedFreshness(generatedAt, at(45 * minute))).toEqual({ labelKey: "freshness.minutes", value: 45, stale: false });
  });

  test("F2: is stale only after three hours", () => {
    expect(feedFreshness(generatedAt, at(3 * hour))?.stale).toBe(false);
    expect(feedFreshness(generatedAt, at(3 * hour + 1_000))).toEqual({ labelKey: "freshness.hours", value: 3, stale: true });
  });

  test("F4: an unparsable or missing generatedAt has no freshness", () => {
    // Control: without it, an implementation that never reports freshness would pass.
    expect(feedFreshness(generatedAt, at(0))).toBeDefined();
    expect(feedFreshness("abc", at(0))).toBeUndefined();
    expect(feedFreshness(undefined, at(0))).toBeUndefined();
  });

  test("F5: a generatedAt in the future reads as just now", () => {
    expect(feedFreshness(generatedAt, at(-60_000))).toEqual({ labelKey: "freshness.justNow", value: 0, stale: false });
  });
});
