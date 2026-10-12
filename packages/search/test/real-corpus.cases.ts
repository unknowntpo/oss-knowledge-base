/**
 * Spec 017 real-corpus test plan: the single source for `real-corpus.test.ts`, for the queries of
 * `bun run eval:search`, for `scripts/real-corpus.ts`, and for the table in
 * docs/specs/017-lexical-ranking/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * Each row is one query over `fixtures/real-corpus-snapshot.v1.json` (records of the Dev release
 * `feed-2026-10-12T02-07-12-000Z`, scored with that release's corpus statistics). `expected` are
 * the grade 2 threads, in the expected order; `acceptable` are grade 1; `notInTop3` must not rank
 * in the first 3. A row passes when every expected thread ranks within `within` and `notInTop3`
 * does not rank in the top 3. `within` is the number of expected plus acceptable threads, except
 * on the owner's row, where the owner said 3. `at2` and `at3` are the status at each revision.
 *
 * `labels`: `owner` was labelled by the repository owner on 2026-10-09 (Spec 016); every
 * `implementer` row is labelled by the implementer from titles, owner to confirm. Dev keeps a
 * Jira issue and its pull request as two threads, so both are listed.
 */
const jira = (key: number) => `kafka:jira:issue:KAFKA-${key}`;
const pull = (number: number) => `kafka:github:pull:${number}`;
const datafusion = (kind: "pull" | "issue", number: number) => `datafusion:github:${kind}:${number}`;
const all = (...ids: readonly string[]) => ids.join(" ");

/** dev@ "4.4.0 Release Manager": 19 messages, each repeating the title. */
export const RELEASE_MANAGER_THREAD = "kafka:mail:dev:message:gt2zkzgfdx9n0yocy7x2zxcr61z1zto2";
/** DataFusion pull request "playground": 130 benchmark-bot comments. */
export const PLAYGROUND_THREAD = datafusion("pull", 25487);
const KIP_1371_DISCUSS = "kafka:mail:dev:message:g239gn2xpz13m2hzl90sgw885js7hxop";

const REQUEST_MANAGER_TITLES = all(jira(19804), pull(23687), jira(19738), pull(22667), pull(20964));
const REQUEST_MANAGER_RELATED = all(jira(20995), KIP_1371_DISCUSS, jira(20765), pull(22747));

export const testPlanRows = [
  {
    id: "N3", case: "the owner's query", labels: "owner", query: "consumer network thread request manager",
    expected: all(jira(19804), pull(22747), jira(19738)),
    acceptable: all(pull(23687), jira(20765), pull(22667), jira(20397), pull(21991)),
    notInTop3: RELEASE_MANAGER_THREAD, within: 3, at2: "fail", at3: "fail",
    why: "Owner: KAFKA-19804, KAFKA-20765 (its pull request 22747), KAFKA-19738 in this order, KAFKA-20397 acceptable, Release Manager not in the top 3. Implementer: the other thread of each key is acceptable.",
  },
  {
    id: "N3", case: "two words of a class name", labels: "implementer", query: "request manager",
    expected: REQUEST_MANAGER_TITLES, acceptable: REQUEST_MANAGER_RELATED,
    notInTop3: RELEASE_MANAGER_THREAD, within: 9, at2: "fail", at3: "pass",
    why: "Expected: the five threads whose title holds `request manager` or a `…RequestManager` class. Acceptable: KIP-1371 (title says `Request Managers`, plural) and KAFKA-20765 (`CommitRequestManager` in the body).",
  },
  {
    id: "N3", case: "the same words as one camelCase fragment", labels: "implementer", query: "RequestManager",
    expected: REQUEST_MANAGER_TITLES, acceptable: REQUEST_MANAGER_RELATED,
    notInTop3: RELEASE_MANAGER_THREAD, within: 9, at2: "fail", at3: "pass",
    why: "The same question as `request manager`, so the same labels.",
  },
  {
    id: "N3", case: "a class name in two titles", labels: "implementer", query: "OffsetsRequestManager",
    expected: all(jira(19738), pull(22667)), acceptable: null,
    notInTop3: RELEASE_MANAGER_THREAD, within: 2, at2: "fail", at3: "pass",
    why: "The only two titles naming the class.",
  },
  {
    id: "N3", case: "a class name only in bodies", labels: "implementer", query: "CommitRequestManager",
    expected: all(jira(20765), pull(22747), jira(21249)), acceptable: null,
    notInTop3: RELEASE_MANAGER_THREAD, within: 3, at2: "fail", at3: "pass",
    why: "No title names the class; these are the only three threads whose text does.",
  },
  {
    id: "N3", case: "a class name in seven titles", labels: "implementer", query: "AsyncKafkaConsumer",
    expected: all(pull(23423), pull(23123), pull(23756), jira(20187), jira(21248), jira(20765), jira(21229)), acceptable: null,
    notInTop3: null, within: 7, at2: "pass", at3: "pass",
    why: "The seven titles naming the class. Passes at `@2`; guards against a regression.",
  },
  {
    id: "N3", case: "three words of a class name", labels: "implementer", query: "heartbeat request manager",
    expected: all(jira(19804), pull(23687), pull(20964)), acceptable: null,
    notInTop3: RELEASE_MANAGER_THREAD, within: 3, at2: "fail", at3: "pass",
    why: "KAFKA-19804 (issue and pull request) says `heartbeat request manager`; pull request 20964 names `AbstractHeartbeatRequestManager`.",
  },
  {
    id: "N3", case: "the long thread is the answer", labels: "implementer", query: "release manager",
    expected: RELEASE_MANAGER_THREAD, acceptable: null,
    notInTop3: null, within: 1, at2: "pass", at3: "pass",
    why: "Guard against over-correcting: for this query the dev@ thread titled `4.4.0 Release Manager` must stay first.",
  },
  {
    id: "N3", case: "two common words of several class names", labels: "implementer", query: "log manager",
    expected: all(jira(20390), pull(23772), pull(23385), jira(21038)),
    acceptable: all(pull(23604), jira(20967), pull(23211)),
    notInTop3: RELEASE_MANAGER_THREAD, within: 7, at2: "fail", at3: "pass",
    why: "Expected: titles naming `LogManager` or `LogManagerBuilder`. Acceptable: titles naming `RemoteLogManager`, which holds the two words.",
  },
  {
    id: "N3", case: "identifier without its hyphen", labels: "implementer", query: "KIP770",
    expected: pull(22458), acceptable: null,
    notInTop3: null, within: 1, at2: "pass", at3: "pass",
    why: "The only thread whose title names KIP-770 (Spec 016 R1).",
  },
  {
    id: "N3", case: "canonical identifier", labels: "implementer", query: "KIP-770",
    expected: pull(22458), acceptable: null,
    notInTop3: null, within: 1, at2: "pass", at3: "pass",
    why: "The same thread as `KIP770`.",
  },
  {
    id: "N3", case: "bare number", labels: "implementer", query: "770",
    expected: pull(22458), acceptable: null,
    notInTop3: null, within: 1, at2: "pass", at3: "pass",
    why: "The only identifier with this number on Dev is KIP-770; one word, so its order is the `@2` order.",
  },
  {
    id: "N3", case: "an abbreviation, one word", labels: "implementer", query: "txn",
    expected: all(jira(20785), pull(23204), pull(23539), jira(21137), pull(23538)), acceptable: null,
    notInTop3: null, within: 5, at2: "pass", at3: "pass",
    why: "The five titles holding the token `txn` (`EndTxn`, `testSendTxnOffsets…`, `txn-offset-commit`). One word: guards the `@2` order.",
  },
  {
    id: "N3", case: "exact Jira key", labels: "implementer", query: "KAFKA-19804",
    expected: all(jira(19804), pull(23687)), acceptable: null,
    notInTop3: null, within: 2, at2: "pass", at3: "pass",
    why: "The issue and its pull request are the exact matches.",
  },
  {
    id: "N3", case: "another project", labels: "implementer", query: "disk manager",
    expected: all(datafusion("pull", 26110), datafusion("pull", 23139), datafusion("pull", 22246)), acceptable: null,
    notInTop3: RELEASE_MANAGER_THREAD, within: 3, at2: "fail", at3: "pass",
    why: "The three DataFusion titles naming `DiskManager` or `disk manager`; a Kafka mail thread must not lead a DataFusion question.",
  },
  {
    id: "N3", case: "class name and its words in two titles", labels: "implementer", query: "transaction manager",
    expected: all(pull(23547), jira(20237)), acceptable: pull(21715),
    notInTop3: RELEASE_MANAGER_THREAD, within: 3, at2: "fail", at3: "pass",
    why: "KAFKA-20237: the issue says `TransactionManager`, its pull request `transaction manager`. Acceptable: the earlier pull request of the same key.",
  },
  {
    id: "N3", case: "three words of one class name", labels: "implementer", query: "remote log manager",
    expected: all(pull(23604), jira(20967), pull(23211)), acceptable: null,
    notInTop3: RELEASE_MANAGER_THREAD, within: 3, at2: "fail", at3: "pass",
    why: "The three titles naming `RemoteLogManager`.",
  },
  {
    id: "N3", case: "a class name against a 130-comment thread", labels: "implementer", query: "SortMergeJoinExec",
    expected: all(datafusion("issue", 25205), datafusion("issue", 25546), datafusion("pull", 24517), datafusion("pull", 24593), datafusion("pull", 25490), datafusion("pull", 26090)),
    acceptable: null,
    notInTop3: PLAYGROUND_THREAD, within: 6, at2: "fail", at3: "pass",
    why: "The six DataFusion titles naming the class. `playground` is a benchmark pull request whose bot comments repeat `sort`, `merge`, `join`.",
  },
  {
    id: "N3", case: "a dotted class name in one title", labels: "implementer", query: "GroupMetadataManager",
    expected: jira(21176), acceptable: pull(23530),
    notInTop3: RELEASE_MANAGER_THREAD, within: 2, at2: "fail", at3: "pass",
    why: "KAFKA-21176 is the only title naming the class; pull request 23530 fixes it and names the key.",
  },
  {
    id: "N3", case: "held out: a two-word topic", labels: "implementer", query: "tiered storage",
    expected: all(pull(21108), pull(23456), jira(20047), jira(17665), jira(19968)), acceptable: null,
    notInTop3: null, within: 5, at2: "fail", at3: "pass",
    why: "The five titles holding `tiered storage`. Added after the ranking was chosen, to check it on a query without `manager`.",
  },
  {
    id: "N3", case: "held out: a product word and a role", labels: "implementer", query: "KRaft controller",
    expected: all(pull(19321), jira(18874), jira(20839), jira(21129)), acceptable: null,
    notInTop3: null, within: 4, at2: "fail", at3: "pass",
    why: "The four titles holding `KRaft controller`. Added after the ranking was chosen.",
  },
] as const;
