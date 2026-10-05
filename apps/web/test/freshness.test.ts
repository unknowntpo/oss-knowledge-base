import { describe, expect, test } from "bun:test";

import { feedFreshness, freshnessText } from "../src/freshness";
import { testPlanRows } from "./freshness.cases";
import { loadTranslations } from "./i18n-harness";

const translations = await loadTranslations();

describe("Spec 010 feed freshness", () => {
  test.each(testPlanRows)("$id: generated $generatedAt, now $now → $en", (row) => {
    const freshness = feedFreshness(row.generatedAt, Date.parse(row.now));
    expect(freshness === undefined ? null : freshness.stale).toBe(row.stale);
    expect(freshness === undefined ? null : freshnessText(freshness, translations("en"))).toBe(row.en);
    expect(freshness === undefined ? null : freshnessText(freshness, translations("zh-Hant"))).toBe(row.zh);
  });

  test("F4: control — the same timestamp path reports an age when it parses", () => {
    // Without this, an implementation that never reports freshness would pass the F4 row.
    expect(feedFreshness("2026-10-03T23:07:13Z", Date.parse("2026-10-04T01:07:13Z"))).toBeDefined();
  });
});
