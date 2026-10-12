/**
 * Spec 017 guard rows: the single source for `real-corpus-guards.test.ts`, for the rank table of
 * `scripts/real-corpus.ts`, and for the table in docs/specs/017-lexical-ranking/spec.md (`bun run
 * docs:test-plan` regenerates it). They guard against over-correction: queries whose expected
 * thread holds the words but not adjacent in query order, and long threads that should win.
 *
 * Each row searches `fixtures/real-corpus-snapshot.v1.json` with the release's statistics.
 * `ranksAt2` and `ranksAt3` are the ranks of the `expected` threads, in their listed order;
 * `longThread` is the rank of dev@ "4.4.0 Release Manager" at `@2` then `@3` (`null` when it is
 * the expected thread or holds no query word). A row passes when every expected thread ranks
 * within `within`. A row where `@3` does not pass is kept as a known limitation.
 *
 * These rows use the words of the Spec 017 case queries in another order or combination, so the
 * snapshot records every statistic they need. The snapshot was not selected for them: at `@2`
 * their first results equal the public Dev API's (read 2026-10-12, release
 * `feed-2026-10-12T03-07-12-000Z`: the first 20 for the reordered queries, the first 14 for
 * `kafka release`); at `@3` that comparison is made after the switch (N17). All rows are
 * implementer-labelled, owner to confirm.
 */
import { RELEASE_MANAGER_THREAD } from "./real-corpus.cases";

const jira = (key: number) => `kafka:jira:issue:KAFKA-${key}`;
const pull = (number: number) => `kafka:github:pull:${number}`;
const all = (...ids: readonly string[]) => ids.join(" ");

const DISCUSS_4_5_0 = "kafka:mail:dev:message:tj10yosjhl359dylxqw430hb7rmbqnts";
const DISCUSS_4_3_2 = "kafka:mail:dev:message:rjvjnr2y63t0tkhysjtoq5znz57cg2lj";
const DISCUSS_4_2_2 = "kafka:mail:dev:message:2d84s3w41gkpldz9hx0fv5ofx9yv223k";

export const testPlanRows = [
  {
    id: "N18", case: "long thread, its title words in the other order", query: "manager release",
    expected: RELEASE_MANAGER_THREAD, within: 1, ranksAt2: "1", ranksAt3: "1", longThread: null, at2: "pass", at3: "pass",
    why: "The 19-message thread titled `4.4.0 Release Manager` is the answer; the query earns no phrase bonus, and the bounded thread score must not cost it first place.",
  },
  {
    id: "N18", case: "long threads, their title words apart", query: "kafka release",
    expected: all(DISCUSS_4_5_0, DISCUSS_4_3_2, DISCUSS_4_2_2), within: 3, ranksAt2: "4 2 5", ranksAt3: "1 2 3", longThread: "1 4", at2: "fail", at3: "pass",
    why: "The three `[DISCUSS] Apache Kafka 4.x release` threads (5 to 8 messages) hold `Kafka` and `release` with the version between them. `4.4.0 Release Manager` does not name Kafka.",
  },
  {
    id: "N18", case: "class-name words in the other order", query: "manager log",
    expected: all(jira(20390), pull(23772), pull(23385), jira(21038)), within: 7, ranksAt2: "2 6 4 7", ranksAt3: "1 5 3 6", longThread: "1 12", at2: "pass", at3: "pass",
    why: "The `LogManager` titles of the `log manager` row; no title holds `manager log`, so no bonus applies.",
  },
  {
    id: "N18", case: "known limitation: a topic's words in the other order", query: "storage tiered",
    expected: all(pull(21108), pull(23456), jira(20047), jira(17665), jira(19968)), within: 5, ranksAt2: "3 8 19 11 21", ranksAt3: "3 5 19 7 21", longThread: null, at2: "fail", at3: "fail",
    why: "The five `tiered storage` titles. Without the bonus `@3` ranks them about as `@2` does (never lower): the gain on `tiered storage` comes from adjacency in query order.",
  },
  {
    id: "N18", case: "known limitation: a role and a product word in the other order", query: "controller kraft",
    expected: all(pull(19321), jira(18874), jira(20839), jira(21129)), within: 4, ranksAt2: "10 4 5 8", ranksAt3: "9 1 2 6", longThread: null, at2: "fail", at3: "fail",
    why: "The four `KRaft controller` titles. Better than `@2` through the thread score alone, but not all in the first four.",
  },
  {
    id: "N18", case: "known limitation: the long thread still leads without adjacency", query: "manager request",
    expected: all(jira(19804), pull(23687), jira(19738), pull(22667), pull(20964)), within: 9, ranksAt2: "8 22 12 20 19", ranksAt3: "7 21 11 18 19", longThread: "1 1", at2: "fail", at3: "fail",
    why: "The `request manager` titles with the words reversed. `request` is in 6,962 of 8,700 chunks (G44), so without the bonus `manager` decides and `4.4.0 Release Manager` stays first: the fix for `request manager` rests on the phrase bonus.",
  },
] as const;
