import { describe, expect, test } from "bun:test";

import { feedFreshness, freshnessText, PUBLICATION_CADENCE_MS, STALE_AFTER_MS, STALE_GRACE_MS } from "../src/freshness";
import { testPlanRows } from "./freshness.cases";
import { loadTranslations } from "./i18n-harness";

const translations = await loadTranslations();

describe("Spec 010 feed freshness", () => {
  test.each(testPlanRows)("$id: generated $generatedAt, now $now → $en", (row) => {
    const freshness = feedFreshness(row.generatedAt, Date.parse(row.now));
    expect(freshness === undefined ? null : freshness.state === "stale").toBe(row.stale);
    expect(freshness === undefined ? null : freshnessText(freshness, translations("en"))).toBe(row.en);
    expect(freshness === undefined ? null : freshnessText(freshness, translations("zh-Hant"))).toBe(row.zh);
  });

  test("F2: the stale threshold is the publication cadence plus the grace, 27 h, not a number of its own", () => {
    expect(PUBLICATION_CADENCE_MS).toBe(24 * 60 * 60_000);
    expect(STALE_GRACE_MS).toBe(3 * 60 * 60_000);
    expect(STALE_AFTER_MS).toBe(PUBLICATION_CADENCE_MS + STALE_GRACE_MS);
    const published = Date.parse("2026-10-13T22:07:00Z");
    expect(feedFreshness("2026-10-13T22:07:00Z", published + STALE_AFTER_MS)?.state).toBe("overdue");
    expect(feedFreshness("2026-10-13T22:07:00Z", published + STALE_AFTER_MS + 1)?.state).toBe("stale");
  });

  test("F4: control — the same timestamp path reports an age when it parses", () => {
    // Without this, an implementation that never reports freshness would pass the F4 row.
    expect(feedFreshness("2026-10-13T22:07:00Z", Date.parse("2026-10-14T00:07:00Z"))).toBeDefined();
  });
});
