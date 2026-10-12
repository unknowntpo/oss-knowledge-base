/**
 * Spec 017 reader test plan: the single source for `search-lexical-revision-3.test.ts` and for the
 * table in docs/specs/017-lexical-ranking/spec.md (`bun run docs:test-plan` regenerates it).
 * Each row publishes golden-queries.v2.json as a search-release.v3 at `bm25-reference@3` (with the
 * community search profiles, 2 chunks per shard) and searches it through the Pages reader.
 * `first` are the first threads in rank order; `firstAt2` is the first thread of the same release
 * written at `@2`; `exact` counts the exact matches, which rank first; `results` counts the threads.
 */
export const testPlanRows = [
  { id: "N5", case: "two words of a class name", query: "request manager", projects: null, first: "kafka:jira:issue:KAFKA-19804 kafka:jira:issue:KAFKA-19738 kafka:mail:dev:release-manager-4-4-0", firstAt2: "kafka:mail:dev:release-manager-4-4-0", exact: 0, results: 8 },
  { id: "N5", case: "the same words as a camelCase fragment", query: "RequestManager", projects: null, first: "kafka:jira:issue:KAFKA-19804 kafka:jira:issue:KAFKA-19738 kafka:mail:dev:release-manager-4-4-0", firstAt2: "kafka:mail:dev:release-manager-4-4-0", exact: 0, results: 8 },
  { id: "N5", case: "the owner's query", query: "consumer network thread request manager", projects: null, first: "kafka:jira:issue:KAFKA-19804 kafka:jira:issue:KAFKA-19738 kafka:jira:issue:KAFKA-19919 kafka:github:pull:22747", firstAt2: "kafka:jira:issue:KAFKA-19919", exact: 0, results: 12 },
  { id: "N5", case: "the thread's own title still leads", query: "release manager", projects: null, first: "kafka:mail:dev:release-manager-4-4-0", firstAt2: "kafka:mail:dev:release-manager-4-4-0", exact: 0, results: 5 },
  { id: "N5", case: "identifier without its hyphen", query: "KIP770", projects: null, first: "kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss", firstAt2: "kafka:github:pull:22458", exact: 2, results: 7 },
  { id: "N5", case: "bare number lists every kind", query: "770", projects: null, first: "datafusion:github:pull:770 kafka:jira:issue:KAFKA-770 kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss", firstAt2: "datafusion:github:pull:770", exact: 4, results: 4 },
  { id: "N5", case: "bare number within one project", query: "770", projects: "apache-datafusion", first: "datafusion:github:pull:770", firstAt2: "datafusion:github:pull:770", exact: 1, results: 1 },
  { id: "N5", case: "a golden v1 identifier", query: "KIP-405", projects: null, first: "kafka:wiki:kip-405", firstAt2: "kafka:wiki:kip-405", exact: 1, results: 5 },
  { id: "N5", case: "one word", query: "txn", projects: null, first: "kafka:jira:issue:KAFKA-20785", firstAt2: "kafka:jira:issue:KAFKA-20785", exact: 0, results: 1 },
] as const;
