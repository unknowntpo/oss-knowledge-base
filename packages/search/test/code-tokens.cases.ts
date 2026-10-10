/**
 * Spec 016 code-text token test plan: the single source for `code-tokens.test.ts` and for the
 * table in docs/specs/016-semantic-search/spec.md (`bun run docs:test-plan` regenerates it).
 * `tokens` is what `bm25-reference@2` indexes and queries for `input`, in order.
 */
export const testPlanRows = [
  { id: "H1", case: "PascalCase class name", input: "HeartbeatRequestManager", tokens: "heartbeatrequestmanager heartbeat request manager" },
  { id: "H1", case: "camelCase method name", input: "checkInflightPoll", tokens: "checkinflightpoll check inflight poll" },
  { id: "H1", case: "two-word fragment", input: "RequestManager", tokens: "requestmanager request manager" },
  { id: "H1", case: "acronym before a word", input: "HTTPServer", tokens: "httpserver http server" },
  { id: "H1", case: "one leading capital stays with its word", input: "KRaftMetadataCache", tokens: "kraftmetadatacache kraft metadata cache" },
  { id: "H1", case: "one trailing capital stays with its word", input: "getX", tokens: "getx" },
  { id: "H1", case: "plural acronym is one word", input: "IDs", tokens: "ids" },
  { id: "H1", case: "shortest split: two letters each side", input: "abCd", tokens: "abcd ab cd" },
  { id: "H1", case: "one letter each side is not split", input: "aB", tokens: "ab" },
  { id: "H1", case: "digits stay with the word before them", input: "Log4jAppender", tokens: "log4jappender log4j appender" },
  { id: "H1", case: "upper-case constant is not split", input: "STALE_MEMBER_EPOCH", tokens: "stale_member_epoch" },
  { id: "H1", case: "capitalized word is not split", input: "Manager", tokens: "manager" },
  { id: "H1", case: "dotted symbol keeps its @1 tokens first", input: "RecordAccumulator.ready()", tokens: "recordaccumulator.ready() recordaccumulator ready record accumulator" },
  { id: "H1", case: "hyphenated identifier is unchanged", input: "KAFKA-20983", tokens: "kafka-20983 kafka 20983" },
  { id: "H1", case: "letters followed by digits are not split", input: "KIP770", tokens: "kip770" },
  { id: "H1", case: "text without case is unchanged", input: "交易逾時", tokens: "交易逾時" },
] as const;
