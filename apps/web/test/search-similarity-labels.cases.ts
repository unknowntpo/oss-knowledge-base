/**
 * Spec 016 fusion (H88): hand labels of the first seven semantic threads of sixteen queries in
 * `fixtures/hybrid-replay.scored.2026-10-13.json`, 112 candidates. The single source for the
 * separation report (`bun run eval:search-fusion`) and for the table in
 * docs/specs/016-semantic-search/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * `judgements` holds one letter a semantic rank, 1 to 7: `R` the thread answers the query, `P` it
 * is on the query's subject and does not answer it, `I` it is unrelated. Judged by the implementer
 * on 2026-10-13 from thread titles alone, after the capture and before any score-aware rule was
 * tried; owner to confirm. `type` is the shape of the query. The verifier of PR #59 corrected three
 * judgements of `LogManager cleanup` (ranks 2 to 4, partly to irrelevant: `LogCleaner` and the log
 * directory are not `LogManager`); they are applied here.
 */
export const testPlanRows = [
  { id: "H88", type: "english phrase", query: "transaction manager", judgements: "PIPPPPP" },
  { id: "H88", type: "english phrase", query: "kafka release", judgements: "IIIIIII" },
  { id: "H88", type: "english phrase", query: "tiered storage", judgements: "PPRRRRR" },
  { id: "H88", type: "class name", query: "CommitRequestManager", judgements: "IIIPIIR" },
  { id: "H88", type: "class name", query: "StreamsPartitionAssignor", judgements: "PPPPIPP" },
  { id: "H88", type: "class name", query: "LogManager cleanup", judgements: "RIIIIII" },
  { id: "H88", type: "chinese", query: "交易逾時", judgements: "RPIIPIP" },
  { id: "H88", type: "chinese", query: "重新認證失敗後 CPU 使用率過高", judgements: "RRIIIII" },
  { id: "H88", type: "chinese", query: "分區領導者選舉", judgements: "RIIIIII" },
  { id: "H88", type: "chinese", query: "日誌管理器", judgements: "IIRIIII" },
  { id: "H88", type: "paraphrase", query: "controller sign-up retried after timing out", judgements: "RRIIIII" },
  { id: "H88", type: "paraphrase", query: "broker runs out of file descriptors", judgements: "IIIIIII" },
  { id: "H88", type: "paraphrase", query: "how to report a vulnerability", judgements: "RIIPIII" },
  { id: "H88", type: "paraphrase", query: "consumer network thread request manager", judgements: "RRIIIII" },
  { id: "H88", type: "one word", query: "txn", judgements: "IIIIIII" },
  { id: "H88", type: "one word", query: "ISR", judgements: "PRRIIII" },
] as const;
