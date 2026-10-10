/**
 * Spec 016 identifier test plan: the single source for `identifiers.test.ts` and for the table in
 * docs/specs/016-semantic-search/spec.md (`bun run docs:test-plan` regenerates it). Each row
 * searches golden-queries.v2.json with `bm25-reference@2` and the fixture's identifier profiles.
 * `exact` lists the groups returned as exact matches, in rank order; they rank before every
 * other result. `projects` is the project filter, `—` for none.
 */
export const testPlanRows = [
  { id: "H3", case: "canonical spelling", query: "KIP-770", projects: null, exact: "kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss" },
  { id: "H3", case: "no hyphen", query: "KIP770", projects: null, exact: "kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss" },
  { id: "H3", case: "lower case, no hyphen", query: "kip770", projects: null, exact: "kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss" },
  { id: "H3", case: "lower case with hyphen", query: "kip-770", projects: null, exact: "kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss" },
  { id: "H3", case: "second family, no hyphen", query: "KAFKA13152", projects: null, exact: "kafka:github:pull:22458" },
  { id: "H3", case: "same number, other family", query: "KAFKA-770", projects: null, exact: "kafka:jira:issue:KAFKA-770" },
  { id: "H3", case: "a shorter number is another identifier", query: "KIP-77", projects: null, exact: "" },
  { id: "H3", case: "a longer number is another identifier", query: "KIP-7700", projects: null, exact: "" },
  { id: "H3", case: "number sign names a GitHub record", query: "#770", projects: null, exact: "datafusion:github:pull:770" },
  { id: "H4", case: "bare number lists every family", query: "770", projects: null, exact: "datafusion:github:pull:770 kafka:jira:issue:KAFKA-770 kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss" },
  { id: "H4", case: "bare number across projects", query: "20983", projects: "apache-datafusion apache-kafka", exact: "datafusion:github:issue:20983 kafka:github:issue:20983" },
  { id: "H4", case: "bare number within one project", query: "770", projects: "apache-datafusion", exact: "datafusion:github:pull:770" },
  { id: "H4", case: "a shorter bare number matches nothing", query: "77", projects: null, exact: "" },
  { id: "H4", case: "a number that is no identifier", query: "405000", projects: null, exact: "" },
] as const;
