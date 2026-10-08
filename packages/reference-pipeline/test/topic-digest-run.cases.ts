/**
 * Spec 014 test plan, slice 2 (DigestRun in the data Worker): rows that need the run loop, the
 * model clients, or the cache. Rendered into docs/specs/014-topic-digest/spec.md by
 * `bun run docs:test-plan`; run by apps/data-publisher-worker/test/digest-run.test.ts (slice 2).
 */
export const testPlanRows = [
  { id: "D10", rule: "cache", input: "constructed: previous digest has KAFKA-PR-23426 with the same model-input hash and classifier revision", expected: "features reused, 0 model calls for it" },
  { id: "D10", rule: "cache", input: "constructed: same model-input hash, classifier prompt revision changed", expected: "reclassified" },
  { id: "D10", rule: "cache", input: "constructed: no new records, but the window slid past the oldest excerpt (input text changed)", expected: "reclassified" },
  { id: "D10", rule: "cache", input: "constructed: card input set and summarizer revision unchanged", expected: "summary reused, 0 model calls" },
  { id: "D13", rule: "model down", input: "constructed: binding throws (network) twice for a classify batch", expected: "1 retry after 5 s; batch gets rules features; fallbacks +20" },
  { id: "D13", rule: "model down", input: "constructed: summary call returns 3040 (capacity) then succeeds", expected: "1 retry; generated" },
  { id: "D13", rule: "model down", input: "constructed: binding throws an error with no recognizable code, twice", expected: "1 retry; failureKind model-unknown on that call; fallback" },
  { id: "D13", rule: "model down", input: "constructed: every call fails", expected: "digest published; all cards fallback (keywords + threads); KIP block unchanged" },
  { id: "D14", rule: "rate limit", input: "constructed: error 3036 (daily free allocation used)", expected: "no retry; remaining calls skipped; limited true; fallback" },
  { id: "D14", rule: "rate limit", input: "constructed: AI Gateway 429 (gateway rate limit)", expected: "no retry; remaining calls skipped; limited true; fallback" },
  { id: "D17", rule: "empty", input: "constructed: 0 candidates", expected: "digest published, empty true, 0 model calls; UI \"No Kafka activity in the last 7 days\"" },
  { id: "D9", rule: "provenance", input: "constructed: a generated card, a proposal line, and a model feature", expected: "each records model, prompt revision, input record ids (cards and rows), generatedAt; cards and rows reviewStatus unreviewed" },
  { id: "D55", rule: "highlights call", input: "constructed: the headline-and-highlights call fails twice", expected: "fallback highlights, no headline; run continues" },
] as const;
