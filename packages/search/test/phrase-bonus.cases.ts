/**
 * Spec 017 phrase-bonus test plan: the single source for `phrase-bonus.test.ts` and for the table
 * in docs/specs/017-lexical-ranking/spec.md (`bun run docs:test-plan` regenerates it).
 * One chunk with `title` and `text` is searched for `query` at `bm25-reference@3`. `titlePairs`
 * and `textPairs` list the adjacent query word pairs credited to the title (weight 4) and to the
 * text (weight 1); a pair in both is credited to the title only. `null` means none.
 */
export const testPlanRows = [
  { id: "N2", case: "the words, adjacent in the title", query: "request manager", title: "Improve heartbeat request manager interval", text: "It starts at zero.", titlePairs: "request+manager", textPairs: null },
  { id: "N2", case: "a class name holds its words adjacent", query: "request manager", title: "Test the OffsetsRequestManager", text: "More unit tests.", titlePairs: "request+manager", textPairs: null },
  { id: "N2", case: "a camelCase query is its words", query: "RequestManager", title: "Improve heartbeat request manager interval", text: "It starts at zero.", titlePairs: "request+manager", textPairs: null },
  { id: "N2", case: "the pair only in the text", query: "request manager", title: "Fix a retry loop", text: "CommitRequestManager retries the request.", titlePairs: null, textPairs: "request+manager" },
  { id: "N2", case: "a pair in both is credited once, to the title", query: "request manager", title: "Request manager cleanup", text: "The request manager leaks.", titlePairs: "request+manager", textPairs: null },
  { id: "N2", case: "a hyphen between the words", query: "request manager", title: "The request-manager", text: "None.", titlePairs: "request+manager", textPairs: null },
  { id: "N2", case: "a dot between the words", query: "request manager", title: "Call Request.manager", text: "None.", titlePairs: "request+manager", textPairs: null },
  { id: "N2", case: "several punctuation marks between the words", query: "request manager", title: "Request: (Manager)", text: "None.", titlePairs: "request+manager", textPairs: null },
  { id: "N2", case: "a line break between the words", query: "request manager", title: "Notes", text: "A request\n\nmanager.", titlePairs: null, textPairs: "request+manager" },
  { id: "N2", case: "full-width letters are normalized", query: "request manager", title: "ＲｅｑｕｅｓｔＭａｎａｇｅｒ", text: "None.", titlePairs: "request+manager", textPairs: null },
  { id: "N2", case: "the words apart", query: "request manager", title: "Request a new manager", text: "For the next cycle.", titlePairs: null, textPairs: null },
  { id: "N2", case: "the words reversed", query: "request manager", title: "Manager request queue grows", text: "It is unbounded.", titlePairs: null, textPairs: null },
  { id: "N2", case: "one word in the title, the other in the text", query: "request manager", title: "A new request", text: "Manager approval is pending.", titlePairs: null, textPairs: null },
  { id: "N2", case: "a longer word is another word", query: "request manager", title: "Request managers wait and prerequest manager", text: "A request managerial note.", titlePairs: null, textPairs: null },
  { id: "N2", case: "three words: both pairs", query: "heartbeat request manager", title: "AbstractHeartbeatRequestManager JavaDoc", text: "None.", titlePairs: "heartbeat+request request+manager", textPairs: null },
  { id: "N2", case: "three words: one pair in the title, one in the text", query: "heartbeat request manager", title: "The request manager", text: "A heartbeat request is sent.", titlePairs: "request+manager", textPairs: "heartbeat+request" },
  { id: "N2", case: "a repeated pair counts once", query: "request manager request manager", title: "RequestManager RequestManager", text: "None.", titlePairs: "request+manager manager+request", textPairs: null },
  { id: "N2", case: "a dotted symbol with a call", query: "RecordAccumulator.ready()", title: "Fix RecordAccumulator.ready() wakeups", text: "None.", titlePairs: "record+accumulator accumulator+ready", textPairs: null },
  { id: "N2", case: "an identifier written without its hyphen", query: "KIP770", title: "Add a config based on KIP-770", text: "None.", titlePairs: "kip+770", textPairs: null },
  { id: "N2", case: "an upper-case constant is one word", query: "member epoch", title: "Handle STALE_MEMBER_EPOCH", text: "The member has an epoch.", titlePairs: null, textPairs: null },
  { id: "N2", case: "a capital sigma: the shortcut is skipped, the pair is found", query: "ΟΔΟΣ xy", title: "ΟΔΟΣXy", text: "None.", titlePairs: "οδος+xy", textPairs: null },
  { id: "N2", case: "one word: no pair", query: "manager", title: "Request manager", text: "None.", titlePairs: null, textPairs: null },
] as const;
