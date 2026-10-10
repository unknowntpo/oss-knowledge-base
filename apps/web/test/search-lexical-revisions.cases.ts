/**
 * Spec 016 reader test plan: the single source for `search-lexical-revisions.test.ts`, the
 * `@2` local E2E, and the table in docs/specs/016-semantic-search/spec.md (`bun run
 * docs:test-plan` regenerates it). Each row publishes golden-queries.v2.json as a
 * search-release.v3 at `revision` (`@2` with the community search profiles, 2 chunks per shard)
 * and searches it through the Pages reader. `exact` lists the exact matches in rank order, which
 * rank first; `includes` lists threads that must be among the results; `results` counts them.
 */
export const testPlanRows = [
  { id: "H34", case: "identifier without its hyphen", revision: "bm25-reference@2", query: "KIP770", projects: null, exact: "kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss", includes: null, results: 7 },
  { id: "H34", case: "canonical identifier", revision: "bm25-reference@2", query: "KIP-770", projects: null, exact: "kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss", includes: null, results: 7 },
  { id: "H34", case: "bare number lists every kind", revision: "bm25-reference@2", query: "770", projects: null, exact: "datafusion:github:pull:770 kafka:jira:issue:KAFKA-770 kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss", includes: null, results: 4 },
  { id: "H34", case: "bare number within one project", revision: "bm25-reference@2", query: "770", projects: "apache-datafusion", exact: "datafusion:github:pull:770", includes: null, results: 1 },
  { id: "H34", case: "number sign names a GitHub record", revision: "bm25-reference@2", query: "#770", projects: null, exact: "datafusion:github:pull:770", includes: null, results: 4 },
  { id: "H34", case: "class-name fragment", revision: "bm25-reference@2", query: "RequestManager", projects: null, exact: null, includes: "kafka:jira:issue:KAFKA-19804 kafka:github:pull:22747 kafka:jira:issue:KAFKA-19738", results: 8 },
  { id: "H34", case: "the fragment as two words", revision: "bm25-reference@2", query: "request manager", projects: null, exact: null, includes: "kafka:jira:issue:KAFKA-19804 kafka:github:pull:22747 kafka:jira:issue:KAFKA-19738", results: 8 },
  { id: "H34", case: "a golden v1 identifier is unchanged", revision: "bm25-reference@2", query: "KIP-405", projects: null, exact: "kafka:wiki:kip-405", includes: null, results: 5 },
  { id: "H25", case: "no hyphen finds nothing at @1", revision: "bm25-reference@1", query: "KIP770", projects: null, exact: null, includes: null, results: 0 },
  { id: "H25", case: "canonical identifier at @1", revision: "bm25-reference@1", query: "KIP-770", projects: null, exact: "kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss", includes: null, results: 6 },
  { id: "H25", case: "bare number is an ordinary term at @1", revision: "bm25-reference@1", query: "770", projects: null, exact: null, includes: "kafka:jira:issue:KAFKA-770", results: 3 },
  { id: "H25", case: "class-name fragment finds nothing at @1", revision: "bm25-reference@1", query: "RequestManager", projects: null, exact: null, includes: null, results: 0 },
  { id: "H25", case: "two words at @1 miss the class names", revision: "bm25-reference@1", query: "request manager", projects: null, exact: null, includes: "kafka:jira:issue:KAFKA-19804 kafka:github:pull:22747", results: 7 },
] as const;
