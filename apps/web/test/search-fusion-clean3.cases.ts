/**
 * Spec 016 fusion (H84): ten queries added on 2026-10-13 as clean evidence for `rrf-group@3`. The
 * single source for `search-fusion-scores.test.ts`, for `bun run eval:search-fusion`, and for the
 * table in docs/specs/016-semantic-search/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * `rrf-group@3` was designed after reading the 76 labelled rows captured before (the verifier's 20
 * among them), so none of those is evidence that it was not fitted. These ten were written and
 * labelled after its three constants were fixed (head 3, reference 20, margin 0.04) and before it
 * was run on them; they were asked once (10 model calls) and not edited:
 * `fixtures/hybrid-replay.clean-3.2026-10-13.json`.
 *
 * `lexical-right`: a title's words plus one word no title needs (`bug`, `removal`, `performance`),
 * the shape of the verifier's `LogManager cleanup`, where the first lexical thread does not hold
 * every query word and `rrf-group@2` protects nothing. `gap`: other words or another language.
 * A row is met when every `expected` thread ranks within `within`. Labelled by the implementer
 * from titles the public Dev API had shown; owner to confirm.
 */
const jira = (key: number) => `kafka:jira:issue:KAFKA-${key}`;
const pull = (number: number) => `kafka:github:pull:${number}`;
const datafusion = (kind: "pull" | "issue", number: number) => `datafusion:github:${kind}:${number}`;
const all = (...ids: readonly string[]) => ids.join(" ");

export const testPlanRows = [
  { id: "H84", kind: "lexical-right", labels: "implementer", query: "AsyncKafkaConsumer bug", expected: all(pull(23756), pull(23123), jira(21229)), within: 5 },
  { id: "H84", kind: "lexical-right", labels: "implementer", query: "ClientQuotaMetadataManager migration", expected: all(jira(19818), pull(23555)), within: 5 },
  { id: "H84", kind: "lexical-right", labels: "implementer", query: "LogManagerBuilder removal", expected: all(pull(23385), jira(21038)), within: 5 },
  { id: "H84", kind: "lexical-right", labels: "implementer", query: "stale coordinator cache fix", expected: all(pull(23630), jira(21181)), within: 5 },
  { id: "H84", kind: "lexical-right", labels: "implementer", query: "windowed restore optimisation backport", expected: all(pull(23434), jira(20876), pull(23435)), within: 5 },
  { id: "H84", kind: "lexical-right", labels: "implementer", query: "push down topk join benchmark", expected: all(datafusion("pull", 25093), datafusion("pull", 21621), datafusion("pull", 22760)), within: 5 },
  { id: "H84", kind: "lexical-right", labels: "implementer", query: "heartbeat request manager performance", expected: all(jira(19804), pull(23687), pull(20964)), within: 5 },
  { id: "H84", kind: "gap", labels: "implementer", query: "why does the controller not retry registering", expected: all(jira(18874), pull(19321)), within: 5 },
  { id: "H84", kind: "gap", labels: "implementer", query: "安全性政策", expected: all(datafusion("issue", 25916), datafusion("pull", 25917)), within: 5 },
  { id: "H84", kind: "gap", labels: "implementer", query: "CPU busy loop after login failure", expected: all(pull(21714), jira(20253)), within: 5 },
] as const;
