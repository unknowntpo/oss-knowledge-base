/**
 * Spec 016 fusion (H76): fourteen queries added on 2026-10-13 to check that `rrf-group@2` was not
 * fitted to the 43 labelled rows it was chosen on. The single source for
 * `search-fusion-replay.test.ts`, for `bun run eval:search-fusion`, and for the table in
 * docs/specs/016-semantic-search/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * The queries, their expected threads, and their bounds were written BEFORE any `rrf-group@2`
 * output existed and before the rule was chosen, from thread titles the public Dev API had shown
 * for `transaction manager`. They were then asked once (`bun run capture:search-replay --queries`,
 * 14 model calls) and never edited: `fixtures/hybrid-replay.new-queries.2026-10-13.json`.
 *
 * `lexical-right`: the title holds the query's words, so lexical search is already right and
 * hybrid search must not make it worse. `gap`: the title says it in other words or in another
 * language, so hybrid search should help. A row is met when every `expected` thread ranks within
 * `within`. Dev keeps a Jira issue and its pull request as two threads; only threads whose title
 * the implementer had read are listed, so a pull request may be missing. Every row is
 * implementer-labelled, owner to confirm.
 */
const jira = (key: number) => `kafka:jira:issue:KAFKA-${key}`;
const pull = (number: number) => `kafka:github:pull:${number}`;
const datafusion = (kind: "pull" | "issue", number: number) => `datafusion:github:${kind}:${number}`;
const all = (...ids: readonly string[]) => ids.join(" ");

export const testPlanRows = [
  {
    id: "H76", kind: "lexical-right", labels: "implementer", query: "ClientQuotaMetadataManager",
    expected: all(jira(19818), pull(23555)), within: 2,
    why: "KAFKA-19818: Move ClientQuotaMetadataManager to metadata module, and its pull request: the only two titles naming the class.",
  },
  {
    id: "H76", kind: "lexical-right", labels: "implementer", query: "LogManagerBuilder",
    expected: all(jira(21038), pull(23385)), within: 2,
    why: "KAFKA-21038: Move LogManagerBuilder to jmh module, and its pull request.",
  },
  {
    id: "H76", kind: "lexical-right", labels: "implementer", query: "stale transaction coordinator cache",
    expected: all(pull(23630), jira(21181)), within: 3,
    why: "KAFKA-21181: Return NOT_COORDINATOR from a stale transaction coordinator cache: the title holds the four words.",
  },
  {
    id: "H76", kind: "lexical-right", labels: "implementer", query: "record collector offsets",
    expected: all(pull(23791), jira(21253)), within: 3,
    why: "KAFKA-21253: Always clear record collector offsets in closeDirty, and its issue.",
  },
  {
    id: "H76", kind: "lexical-right", labels: "implementer", query: "push down topk through join",
    expected: all(datafusion("pull", 21621), datafusion("pull", 25093)), within: 3,
    why: "DataFusion: Push down topk through join, and its benchmark-only rebase.",
  },
  {
    id: "H76", kind: "lexical-right", labels: "implementer", query: "windowed restore optimisation",
    expected: jira(20876), within: 3,
    why: "KAFKA-20876: Windowed restore optimisation gives up when endOffset-1 is a transaction marker.",
  },
  {
    id: "H76", kind: "lexical-right", labels: "implementer", query: "PartitionsWithLateTransactionsCount",
    expected: pull(23625), within: 1,
    why: "MINOR: Add PartitionsWithLateTransactionsCount description to monitoring.md: the only title naming the metric.",
  },
  {
    id: "H76", kind: "gap", labels: "implementer", query: "交易協調器回傳過期的快取結果",
    expected: all(pull(23630), jira(21181)), within: 5,
    why: "Chinese for: the transaction coordinator returns a stale cached result (KAFKA-21181).",
  },
  {
    id: "H76", kind: "gap", labels: "implementer", query: "長時間重新平衡造成記憶體不足",
    expected: jira(21230), within: 5,
    why: "Chinese for: a long rebalance causes out of memory (KAFKA-21230: Long rebalances can cause OOM errors).",
  },
  {
    id: "H76", kind: "gap", labels: "implementer", query: "out of memory during a long rebalance",
    expected: jira(21230), within: 5,
    why: "KAFKA-21230; the title says OOM.",
  },
  {
    id: "H76", kind: "gap", labels: "implementer", query: "abandon a hanging transaction from the command line",
    expected: all(jira(19003), pull(19276)), within: 5,
    why: "KAFKA-19003: Add force-terminate feature to kafka-transactions CLI; the titles say force-terminate and CLI.",
  },
  {
    id: "H76", kind: "gap", labels: "implementer", query: "commit markers lost when a partition is unavailable",
    expected: jira(20734), within: 5,
    why: "KAFKA-20734: Offline partition can cause loss of transaction markers.",
  },
  {
    id: "H76", kind: "gap", labels: "implementer", query: "how to report a vulnerability",
    expected: datafusion("pull", 25917), within: 5,
    why: "DataFusion: Add SECURITY.md for DataFusion; no title says vulnerability.",
  },
  {
    id: "H76", kind: "gap", labels: "implementer", query: "用戶端配額數值檢查",
    expected: pull(23646), within: 5,
    why: "Chinese for: client quota value validation (MINOR: Validate client quota values and cap throttle time to int range).",
  },
] as const;
