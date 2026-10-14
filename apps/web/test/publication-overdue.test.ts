import { describe, expect, test } from "bun:test";

import {
  feedFreshness,
  freshnessText,
  OVERDUE_AFTER_MS,
  PUBLICATION_ALLOWANCE_MS,
  PUBLICATION_CADENCE_MS,
  STALE_AFTER_MS,
} from "../src/freshness";
import { loadTranslations } from "./i18n-harness";
import { testPlanRows } from "./publication-overdue.cases";

const translations = await loadTranslations();

describe("Spec 021 overdue daily publication", () => {
  test.each(testPlanRows)("$id: $case → $en", (row) => {
    const freshness = feedFreshness(row.generatedAt, Date.parse(row.now))!;
    expect(freshness.state).toBe(row.state);
    expect(freshnessText(freshness, translations("en"))).toBe(row.en);
    expect(freshnessText(freshness, translations("zh-Hant"))).toBe(row.zh);
  });

  test("O4: the overdue mark is the cadence plus the allowance, with no time of day in it, and comes before the stale mark", () => {
    expect(PUBLICATION_ALLOWANCE_MS).toBe(30 * 60_000);
    expect(OVERDUE_AFTER_MS).toBe(PUBLICATION_CADENCE_MS + PUBLICATION_ALLOWANCE_MS);
    expect(OVERDUE_AFTER_MS).toBeLessThan(STALE_AFTER_MS);
    // Any release time gives the same three states at the same ages.
    for (const generatedAt of ["2026-10-13T22:07:09Z", "2026-10-13T22:37:00Z", "2026-03-01T03:14:15Z"]) {
      const published = Date.parse(generatedAt);
      expect(feedFreshness(generatedAt, published + OVERDUE_AFTER_MS)?.state).toBe("fresh");
      expect(feedFreshness(generatedAt, published + OVERDUE_AFTER_MS + 1)?.state).toBe("overdue");
      expect(feedFreshness(generatedAt, published + STALE_AFTER_MS)?.state).toBe("overdue");
      expect(feedFreshness(generatedAt, published + STALE_AFTER_MS + 1)?.state).toBe("stale");
    }
  });
});
