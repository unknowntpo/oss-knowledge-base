/**
 * Spec 016 slice 3 reader test plan: the single source for `search-hybrid.test.ts` and for the
 * table in docs/specs/016-semantic-search/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * Each row publishes golden-queries.v2.json as a search-release.v3 at `bm25-reference@3` (2 chunks
 * per shard, 12 shards) and searches it through the Pages reader with hybrid search on.
 * `release`: `roots` declares shard roots, `no roots` does not, `v2` is the whole-release layout.
 * `gate`: `answers` is the real query gate over a fake concept embedder and a fake vector index;
 * the other values are a gate that `throws`, `never answers` (the timeout is 20 ms), is `over
 * budget`, is `disabled`, or `must not be asked` (it fails the test when called).
 * `status` and `reason` are `retrieval.semantic`; `results` are the threads in rank order;
 * `semanticOnly` are those no lexical match returned. A row whose status is not `ok` must also
 * return exactly the lexical response.
 *
 * The fake embedder knows four concepts (transaction/txn/交易, timeout/逾時, tiered storage/cold
 * data, broker disk); it shows that the path works, not how good `@cf/baai/bge-m3` is.
 */
const KAFKA_20785 = "kafka:jira:issue:KAFKA-20785";
const KAFKA_20734 = "kafka:jira:issue:KAFKA-20734";
const KIP_405 = "kafka:wiki:kip-405";
const COLD_DATA_LEXICAL = "kafka:jira:issue:KAFKA-20397 datafusion:github:issue:19877 datafusion:github:pull:770";
const REQUEST_MANAGER = "kafka:jira:issue:KAFKA-19804 kafka:jira:issue:KAFKA-19738 kafka:jira:issue:KAFKA-19919 kafka:github:pull:22747 kafka:mail:dev:release-manager-4-4-0 kafka:wiki:kip-405 kafka:jira:issue:KAFKA-20397 kafka:github:issue:20983 datafusion:github:pull:770 kafka:github:pull:22458 kafka:jira:issue:KAFKA-20785 kafka:github:issue:20970";
const KIP_770 = "kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss datafusion:github:pull:770 kafka:wiki:kip-405 kafka:jira:issue:KAFKA-770 kafka:wiki:kip-1150 kafka:jira:issue:KAFKA-19804";

export const testPlanRows = [
  { id: "H28", case: "a Chinese query finds English threads", query: "交易逾時", projects: null, release: "roots", gate: "answers", status: "ok", reason: null, results: `${KAFKA_20785} ${KAFKA_20734}`, semanticOnly: `${KAFKA_20785} ${KAFKA_20734}` },
  { id: "H28", case: "an abbreviation: the lexical thread stays first, a second one is added", query: "txn", projects: null, release: "roots", gate: "answers", status: "ok", reason: null, results: `${KAFKA_20785} ${KAFKA_20734}`, semanticOnly: KAFKA_20734 },
  { id: "H28", case: "a thread both retrievers return rises from 4th to 1st", query: "cold data", projects: null, release: "roots", gate: "answers", status: "ok", reason: null, results: `${KIP_405} ${COLD_DATA_LEXICAL} datafusion:github:issue:20983`, semanticOnly: null },
  { id: "H28", case: "both retrievers agree: the order is the lexical one", query: "transaction timeout", projects: null, release: "roots", gate: "answers", status: "ok", reason: null, results: `${KAFKA_20785} ${KAFKA_20734}`, semanticOnly: null },
  { id: "H28", case: "no semantic candidate: the lexical order", query: "consumer network thread request manager", projects: null, release: "roots", gate: "answers", status: "ok", reason: null, results: REQUEST_MANAGER, semanticOnly: null },
  { id: "H59", case: "the project filter keeps semantic threads of that project", query: "交易逾時", projects: "apache-kafka", release: "roots", gate: "answers", status: "ok", reason: null, results: `${KAFKA_20785} ${KAFKA_20734}`, semanticOnly: `${KAFKA_20785} ${KAFKA_20734}` },
  { id: "H59", case: "the project filter drops semantic threads of another project", query: "交易逾時", projects: "apache-datafusion", release: "roots", gate: "answers", status: "ok", reason: null, results: null, semanticOnly: null },
  { id: "H61", case: "two letters are enough to ask", query: "交易", projects: null, release: "roots", gate: "answers", status: "ok", reason: null, results: `${KAFKA_20734} ${KAFKA_20785}`, semanticOnly: `${KAFKA_20734} ${KAFKA_20785}` },
  { id: "H61", case: "one letter is not", query: "交", projects: null, release: "roots", gate: "must not be asked", status: "skipped", reason: "short-query", results: null, semanticOnly: null },
  { id: "H61", case: "one letter among punctuation is not", query: "?? a !!", projects: null, release: "roots", gate: "must not be asked", status: "skipped", reason: "short-query", results: "kafka:jira:issue:KAFKA-19804 kafka:jira:issue:KAFKA-20734 kafka:mail:dev:kip-770-discuss kafka:mail:dev:release-manager-4-4-0 kafka:github:issue:20970 kafka:wiki:kip-405 datafusion:github:issue:20983 datafusion:github:issue:19877 kafka:github:issue:20983 kafka:jira:issue:KAFKA-20397 kafka:jira:issue:KAFKA-20785", semanticOnly: null },
  { id: "H61", case: "an identifier without its hyphen", query: "KIP770", projects: null, release: "roots", gate: "must not be asked", status: "skipped", reason: "identifier-query", results: KIP_770, semanticOnly: null },
  { id: "H61", case: "a bare number", query: "770", projects: null, release: "roots", gate: "must not be asked", status: "skipped", reason: "identifier-query", results: "datafusion:github:pull:770 kafka:jira:issue:KAFKA-770 kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss", semanticOnly: null },
  { id: "H61", case: "a code symbol", query: "RecordAccumulator.ready()", projects: null, release: "roots", gate: "must not be asked", status: "skipped", reason: "identifier-query", results: "kafka:github:pr:23203 kafka:mail:dev:kip-770-discuss", semanticOnly: null },
  { id: "H61", case: "an identifier inside a longer query is asked", query: "KIP770 transaction", projects: null, release: "roots", gate: "answers", status: "ok", reason: null, results: `${KAFKA_20734} ${KAFKA_20785} kafka:github:pull:22458 kafka:mail:dev:kip-770-discuss datafusion:github:pull:770 kafka:wiki:kip-405 kafka:jira:issue:KAFKA-770 kafka:wiki:kip-1150 kafka:jira:issue:KAFKA-19804`, semanticOnly: null },
  { id: "H29", case: "the gate throws", query: "txn", projects: null, release: "roots", gate: "throws", status: "failed", reason: null, results: KAFKA_20785, semanticOnly: null },
  { id: "H29", case: "the gate throws and lexical search finds nothing", query: "交易逾時", projects: null, release: "roots", gate: "throws", status: "failed", reason: null, results: null, semanticOnly: null },
  { id: "H29", case: "the gate never answers", query: "txn", projects: null, release: "roots", gate: "never answers", status: "timed-out", reason: null, results: KAFKA_20785, semanticOnly: null },
  { id: "H29", case: "the day's budget is spent", query: "txn", projects: null, release: "roots", gate: "over budget", status: "over-budget", reason: null, results: KAFKA_20785, semanticOnly: null },
  { id: "H29", case: "the gate is disabled", query: "txn", projects: null, release: "roots", gate: "disabled", status: "disabled", reason: null, results: KAFKA_20785, semanticOnly: null },
  { id: "H65", case: "a release without shard roots", query: "txn", projects: null, release: "no roots", gate: "must not be asked", status: "uncovered", reason: null, results: KAFKA_20785, semanticOnly: null },
  { id: "H65", case: "a whole-release (search-release.v2) layout", query: "txn", projects: null, release: "v2", gate: "must not be asked", status: "uncovered", reason: null, results: KAFKA_20785, semanticOnly: null },
] as const;
