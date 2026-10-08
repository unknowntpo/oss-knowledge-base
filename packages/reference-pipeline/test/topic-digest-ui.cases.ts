/**
 * Spec 014 test plan, slice 3 (web): rows checked in the browser. Rendered into
 * docs/specs/014-topic-digest/spec.md by `bun run docs:test-plan`; run by the slice 3 E2E tests.
 */
export const testPlanRows = [
  { id: "D24", rule: "injection", input: "constructed: sentence text contains \"<img src=x onerror=alert(1)>\"", expected: "kept as text; rendered escaped" },
  { id: "D18", rule: "freshness", input: "digest generatedAt 2026-10-07T01:37:00Z, now 2026-10-08T13:37:00Z (36 h)", expected: "Digest updated 36 h ago; not stale" },
  { id: "D18", rule: "freshness", input: "digest generatedAt 2026-10-07T01:37:00Z, now 2026-10-08T13:37:01Z", expected: "Digest may be out of date · 36 h ago; stale" },
  { id: "D18", rule: "freshness", input: "constructed: cited KAFKA-PR-23426 absent from the current feed", expected: "title from the digest, link to https://github.com/apache/kafka/pull/23426" },
  { id: "D39", rule: "window label", input: "zh-Hant, same window", expected: "過去 7 天 · Intl.DateTimeFormat(\"zh-Hant\", …).formatRange output; no 週/week number" },
  { id: "D36", rule: "proposals tab", input: "/#/datafusion/proposals", expected: "redirects to /#/datafusion/" },
  { id: "D36", rule: "proposals tab", input: "/#/kafka/proposals, en", expected: "every row grouped by stage; quorum note \"3 binding +1 votes\"" },
  { id: "D17", rule: "empty", input: "constructed: digest with empty true", expected: "This week shows \"No activity in the past 7 days\"" },
  { id: "D77", rule: "uncategorized", input: "constructed: digest with uncategorized threads KAFKA-PR-23426 and KAFKA-MAIL-85a6bd91", expected: "collapsed section after the topic cards: \"Uncategorized\", \"Show list · 2 items\"" },
  { id: "D77", rule: "uncategorized", input: "constructed: digest object without the uncategorized field", expected: "no Uncategorized section" },
] as const;
