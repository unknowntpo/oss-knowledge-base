/**
 * Spec 016 fusion (H83): the independent verifier's clean set for PR #57. Twenty queries the
 * verifier wrote before running `rrf-group@2`, with the threads it expected (labelled by the
 * verifier from titles, copied unchanged from its evidence; owner to confirm). The single source
 * for `search-fusion-scores.test.ts`, for `bun run eval:search-fusion`, and for the table in
 * docs/specs/016-semantic-search/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * `lexical-right`: the verifier's `L` rows, where hybrid search must not be worse than lexical
 * search; `gap` and `chinese`: its `G` and `C` rows. The verifier gave no rank bound: `within` is
 * 5 on every row, the bound this spec uses for a short expected list (implementer's choice). A row
 * without expected threads (`ReplicaManager fetch`) is replayed and never counted.
 */
export const testPlanRows = [
  { id: "H83", kind: "lexical-right", labels: "verifier", query: "LogManager cleanup", expected: "kafka:jira:issue:KAFKA-20390 kafka:github:pull:23772 kafka:github:pull:23385 kafka:jira:issue:KAFKA-21038", within: 5 },
  { id: "H83", kind: "lexical-right", labels: "verifier", query: "ReplicaManager fetch", expected: null, within: 5 },
  { id: "H83", kind: "lexical-right", labels: "verifier", query: "StreamsPartitionAssignor", expected: "kafka:jira:issue:KAFKA-20790 kafka:github:pull:23597 kafka:github:pull:23706", within: 5 },
  { id: "H83", kind: "lexical-right", labels: "verifier", query: "max.poll.interval.ms", expected: "kafka:jira:issue:KAFKA-19804 kafka:github:pull:23348", within: 5 },
  { id: "H83", kind: "lexical-right", labels: "verifier", query: "remote.log.storage.enable", expected: "kafka:github:pull:23626 kafka:github:pull:23569 kafka:jira:issue:KAFKA-17249", within: 5 },
  { id: "H83", kind: "lexical-right", labels: "verifier", query: "SortMergeJoinExec spill", expected: "datafusion:github:pull:23988 datafusion:github:issue:25205", within: 5 },
  { id: "H83", kind: "lexical-right", labels: "verifier", query: "ListingTable partition pruning", expected: "datafusion:github:pull:25212 datafusion:github:issue:26130 datafusion:github:pull:25819 datafusion:github:issue:23341 datafusion:github:pull:23402", within: 5 },
  { id: "H83", kind: "lexical-right", labels: "verifier", query: "unclean leader election", expected: "kafka:github:pull:23680 kafka:github:pull:20610", within: 5 },
  { id: "H83", kind: "lexical-right", labels: "verifier", query: "offset commit callback", expected: "kafka:github:pull:21359 kafka:jira:issue:KAFKA-21229 kafka:github:pull:23725", within: 5 },
  { id: "H83", kind: "gap", labels: "verifier", query: "consumer stuck after network timeout", expected: "kafka:jira:issue:KAFKA-17734 kafka:jira:issue:KAFKA-21220 kafka:github:pull:23714", within: 5 },
  { id: "H83", kind: "gap", labels: "verifier", query: "broker runs out of file descriptors", expected: "kafka:jira:issue:KAFKA-20967 kafka:github:pull:23211 kafka:github:pull:23604", within: 5 },
  { id: "H83", kind: "gap", labels: "verifier", query: "slow group rebalance memory", expected: "kafka:jira:issue:KAFKA-21230", within: 5 },
  { id: "H83", kind: "gap", labels: "verifier", query: "producer blocked on metadata", expected: "kafka:github:pull:23474 kafka:github:pull:23753 kafka:jira:issue:KAFKA-21243", within: 5 },
  { id: "H83", kind: "gap", labels: "verifier", query: "deduplicate strings when spilling", expected: "datafusion:github:pull:23565 datafusion:github:pull:25716", within: 5 },
  { id: "H83", kind: "gap", labels: "verifier", query: "config value validation for client quotas", expected: "kafka:github:pull:23640 kafka:github:pull:23641", within: 5 },
  { id: "H83", kind: "gap", labels: "verifier", query: "merge join loses rows", expected: "datafusion:github:issue:26115 datafusion:github:pull:24336 datafusion:github:issue:25957", within: 5 },
  { id: "H83", kind: "gap", labels: "verifier", query: "vulnerability disclosure process", expected: "datafusion:github:pull:25917", within: 5 },
  { id: "H83", kind: "chinese", labels: "verifier", query: "日誌管理器", expected: "kafka:jira:issue:KAFKA-20390 kafka:github:pull:23772 kafka:github:pull:23385 kafka:jira:issue:KAFKA-21038", within: 5 },
  { id: "H83", kind: "chinese", labels: "verifier", query: "分區領導者選舉", expected: "kafka:github:pull:20610 kafka:github:pull:23680", within: 5 },
  { id: "H83", kind: "chinese", labels: "verifier", query: "遠端儲存指標", expected: "kafka:github:pull:23463 kafka:github:pull:23508", within: 5 },
] as const;
