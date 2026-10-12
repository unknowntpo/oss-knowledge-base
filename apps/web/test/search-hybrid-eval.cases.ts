/**
 * Spec 016 slice 4 preparation: the queries `bun run measure:search-hybrid` asks the public Dev
 * API, each once lexically (`semantic=off`) and once hybrid. The single source for that script,
 * for `search-hybrid-eval.test.ts`, and for the table in docs/specs/016-semantic-search/spec.md
 * (`bun run docs:test-plan` regenerates it). The Spec 017 real-corpus rows and guard rows are
 * measured too; the script reads them from their own case files.
 *
 * These rows were written on 2026-10-12 BEFORE any hybrid output existed, from the thread titles
 * in the Spec 017 snapshot of the Dev release. `expected` are grade 2, `acceptable` grade 1; a row
 * is met when every expected thread ranks within `within`. Dev keeps a Jira issue and its pull
 * request as two threads, so both are listed. The snapshot holds 343 of the release's 4,093
 * threads, so other threads may deserve a label: every row is implementer-labelled, owner to
 * confirm; the first two queries are the owner's examples, with the implementer's expected
 * threads. The owner's abbreviation `txn` is already a Spec 017 row and is measured from there.
 */
const jira = (key: number) => `kafka:jira:issue:KAFKA-${key}`;
const pull = (number: number) => `kafka:github:pull:${number}`;
const datafusion = (kind: "pull" | "issue", number: number) => `datafusion:github:${kind}:${number}`;
const all = (...ids: readonly string[]) => ids.join(" ");

export const testPlanRows = [
  {
    id: "H71", kind: "chinese", labels: "implementer", query: "交易逾時",
    expected: all(jira(20237), pull(23547)), acceptable: all(jira(20785), pull(23204), jira(21181), pull(23630), pull(19276)), within: 10,
    why: "The owner's example query (transaction timeout). No title says timeout; the stuck TransactionManager (KAFKA-20237) is the closest, other transaction threads are acceptable.",
  },
  {
    id: "H71", kind: "chinese", labels: "implementer", query: "消費者重新平衡很慢",
    expected: all(jira(21249), pull(23760)), acceptable: all(pull(23115), pull(20863)), within: 10,
    why: "The owner's example query (consumer rebalance is slow). No title says slow; pre-rebalance auto-commit retries (KAFKA-21249) is the closest.",
  },
  {
    id: "H71", kind: "chinese", labels: "implementer", query: "分層儲存的配額沒有生效",
    expected: all(jira(19968), pull(21108)), acceptable: pull(23456), within: 5,
    why: "Tiered storage quota not enforced: KAFKA-19968 and its pull request.",
  },
  {
    id: "H71", kind: "chinese", labels: "implementer", query: "重新認證失敗後 CPU 使用率過高",
    expected: pull(21714), acceptable: all(pull(23348), jira(21031), pull(23357)), within: 5,
    why: "KAFKA-20253: high CPU loop after failed re-authentication; the busy-loop threads are acceptable.",
  },
  {
    id: "H71", kind: "chinese", labels: "implementer", query: "反向 DNS 查詢阻塞網路執行緒",
    expected: all(jira(19919), pull(22569)), acceptable: null, within: 5,
    why: "KAFKA-19919: network threads blocked by synchronous reverse DNS lookups.",
  },
  {
    id: "H71", kind: "chinese", labels: "implementer", query: "心跳請求的初始間隔",
    expected: all(jira(19804), pull(23687)), acceptable: pull(20964), within: 5,
    why: "KAFKA-19804: heartbeat request manager initial HB interval.",
  },
  {
    id: "H71", kind: "chinese", labels: "implementer", query: "排序合併連接溢出到磁碟時遺失資料列",
    expected: datafusion("pull", 24056), acceptable: all(datafusion("pull", 23988), datafusion("pull", 24192), datafusion("pull", 25250), datafusion("pull", 22230)), within: 5,
    why: "DataFusion: keep every spilled slice of a sort-merge join inner key group; other sort-merge spill threads are acceptable.",
  },
  {
    id: "H71", kind: "chinese", labels: "implementer", query: "發布流程移除 MD5 校驗檔",
    expected: pull(23654), acceptable: null, within: 5,
    why: "KAFKA-21183: remove MD5 and SHA-1 checksum files from the release process.",
  },
  {
    id: "H71", kind: "vocabulary-gap", labels: "implementer", query: "controller sign-up retried after timing out",
    expected: pull(19321), acceptable: null, within: 5,
    why: "KAFKA-18874: Fix KRaft controller registration retry on timeout; the title says registration.",
  },
  {
    id: "H71", kind: "vocabulary-gap", labels: "implementer", query: "SMJ spill",
    expected: all(datafusion("pull", 24056), datafusion("pull", 23988), datafusion("pull", 22230)), acceptable: all(datafusion("pull", 24192), datafusion("pull", 25250)), within: 10,
    why: "SMJ abbreviates sort-merge join; the titles spell it out.",
  },
  {
    id: "H71", kind: "vocabulary-gap", labels: "implementer", query: "two-phase commit",
    expected: pull(21735), acceptable: null, within: 5,
    why: "KAFKA-15370: Support Participation in 2PC (KIP-939); the title says 2PC.",
  },
  {
    id: "H71", kind: "vocabulary-gap", labels: "implementer", query: "client spins at 100% cpu",
    expected: all(pull(21714), jira(21031), pull(23357), pull(23348)), acceptable: null, within: 10,
    why: "The titles say high CPU loop and busy loop.",
  },
  {
    id: "H71", kind: "vocabulary-gap", labels: "implementer", query: "remote storage file handle not closed",
    expected: all(jira(20967), pull(23211)), acceptable: pull(23604), within: 5,
    why: "KAFKA-20967: RemoteLogManager.read() leaks the remote segment InputStream.",
  },
  {
    id: "H71", kind: "vocabulary-gap", labels: "implementer", query: "hash join that fits in limited RAM",
    expected: datafusion("issue", 24768), acceptable: null, within: 5,
    why: "DataFusion: [EPIC] Spilling Hash Join, run any join in a bounded memory budget.",
  },
  {
    id: "H71", kind: "vocabulary-gap", labels: "implementer", query: "mark directory as failed on disk error",
    expected: all(jira(16304), pull(23697)), acceptable: null, within: 5,
    why: "KAFKA-16304 and KAFKA-13468: take the log dir offline on a disk I/O error.",
  },
  {
    id: "H71", kind: "vocabulary-gap", labels: "implementer", query: "HB interval",
    expected: all(jira(19804), pull(23687)), acceptable: null, within: 5,
    why: "HB abbreviates heartbeat; KAFKA-19804's title holds both spellings.",
  },
] as const;
