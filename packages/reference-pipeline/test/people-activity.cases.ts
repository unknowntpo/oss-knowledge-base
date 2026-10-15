/**
 * Spec 019 slice 2b test plan: the single source for `people-activity.test.ts` and for the slice
 * 2b table in docs/specs/019-contributor-profile/spec.md (`bun run docs:test-plan`).
 *
 * `recorded`: the Dev Kafka release 2026-10-14T22:07:43Z as captured on 2026-10-15
 * (`fixtures/people-activity/kafka-dev.json`): every thread one of the Example identities wrote in,
 * with its root record. The log is built as the publication's first append would build it at that
 * release (coverage from 35 days before it, 2026-09-09T22:07:43Z) and read at the capture time.
 * `constructed`: the events of `constructedEvents` in the test, appended to the same store.
 *
 * Columns: `github` = pull requests opened in the period (merged), conversation comments on how
 * many threads (on the person's own threads); `jira` = issues reported (by last update), comments,
 * distinct issues; `mail` = messages in threads, `[DISCUSS]` / `[VOTE]` threads; `areas` = the
 * five largest labels (process labels left out), KIP numbers, sources without label data;
 * `worksWith` = the first four authors of threads the person wrote in (Works with, "wrote in threads started by").
 * Expected values were computed from the fixture by a separate script, not by this code.
 */
export const testPlanRows = [
  { id: "W1", case: "a committer who comments on others' pull requests and opens none", data: "recorded", person: "github:chia7712", status: 200, github: "PRs 0 (merged 0), comments 59 on 48 threads (own 0)", jira: "—", mail: "—", areas: "clients 10, streams 9, build 8, core 8, group-coordinator 6; KIP-932 2, KIP-909 1, KIP-1071 1", worksWith: "gabriellefu 5, harmadasg 4, jim0987795064 3, m1a2st 3" },
  { id: "W1", case: "the same person's Jira identity: its own page, nothing added from GitHub or dev@", data: "recorded", person: "jira:Chia-Ping Tsai", status: 200, github: "—", jira: "issues 72, comments 12, on 78 issues", mail: "—", areas: "no area data from jira", worksWith: "Mickael Maison 2, Andrew Schofield 1, David Jacot 1, Edoardo Comar 1" },
  { id: "W1", case: "the same person's dev@ identity: 21 messages in 13 threads", data: "recorded", person: "mail:Chia-Ping Tsai", status: 200, github: "—", jira: "—", mail: "21 in 13 threads; [DISCUSS] 6, [VOTE] 6", areas: "KIP-1153 1, KIP-1342 1, KIP-1349 1; no area data from mail", worksWith: "Andrew Schofield 1, David Jacot 1, Ming-Yen Chung 1, Omnia Ibrahim 1" },
  { id: "W1", case: "a pull-request author: 18 of his PRs are in the release, 7 were opened inside the log's coverage", data: "recorded", person: "github:m1a2st", status: 200, github: "PRs 7 (merged 5), comments 26 on 20 threads (own 7)", jira: "—", mail: "—", areas: "clients 8, consumer 5, core 5, group-coordinator 5, storage 4; KIP-932 1", worksWith: "dajac 4, mimaison 2, nileshkumar3 2, aliehsaeedii 1" },
  { id: "W1", case: "a dev@ identity with no GitHub page under this name", data: "recorded", person: "mail:Andrew Schofield", status: 200, github: "—", jira: "—", mail: "23 in 11 threads; [DISCUSS] 4, [VOTE] 4", areas: "KIP-1368 2, KIP-1279 1, KIP-1306 1, KIP-1349 1, KIP-1371 1; no area data from mail", worksWith: "Chia-Ping Tsai 2, Aditya Kousik 1, Apoorv Mittal 1" },
  { id: "W1", case: "the same name in Jira: a separate identity (strict identity, decision 5)", data: "recorded", person: "jira:andrew schofield", status: 200, github: "—", jira: "issues 4, comments 4, on 8 issues", mail: "—", areas: "no area data from jira", worksWith: "Apoorv Mittal 2, Luke Chen 1, Shekhar Prasad Rajak 1" },
  { id: "W1", case: "his GitHub login: unlinked, counted on its own", data: "recorded", person: "github:AndrewJSchofield", status: 200, github: "PRs 6 (merged 4), comments 4 on 3 threads (own 2)", jira: "—", mail: "—", areas: "clients 7, consumer 5, build 1, producer 1; KIP-932 3", worksWith: "apoorvmittal10 1, ezhou413 1" },
  { id: "W3", case: "a pull request opened on the last second of September and updated 40 days later counts in September", data: "constructed", person: "github:edge-author", status: 200, github: "PRs 1 (merged 1), comments 0 on 0 threads (own 0)", jira: "—", mail: "—", areas: "—", worksWith: "—" },
  { id: "W4", case: "labels `clients`, `small`, `ci-approved`: the area is `clients` only", data: "constructed", person: "github:label-author", status: 200, github: "PRs 1 (merged 0), comments 0 on 0 threads (own 0)", jira: "—", mail: "—", areas: "clients 1", worksWith: "—" },
  { id: "W12", case: "a GitHub bot's comments are not logged: no page", data: "constructed", person: "github:ci-bot", status: 404, github: "—", jira: "—", mail: "—", areas: "—", worksWith: "—" },
  { id: "W12", case: "a Jira identity the connector marks as a bot: no page", data: "constructed", person: "jira:Jenkins Bot", status: 404, github: "—", jira: "—", mail: "—", areas: "—", worksWith: "—" },
  { id: "W11", case: "a dev@ sender without a name (`unknown sender`) is no identity", data: "constructed", person: "mail:unknown sender", status: 400, github: "—", jira: "—", mail: "—", areas: "—", worksWith: "—" },
  { id: "W11", case: "a Jira identity in a community without Jira (DataFusion)", data: "recorded", person: "jira:Chia-Ping Tsai @ datafusion", status: 404, github: "—", jira: "—", mail: "—", areas: "—", worksWith: "—" },
] as const;
