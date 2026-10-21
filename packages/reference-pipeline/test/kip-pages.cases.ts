/**
 * Spec 019 amendment (7), KIP authors revision, slice B: the `kip-pages` job (the KIP page's author
 * line, its `JIRA:` field and each issue's assignee). The single source for `kip-pages.test.ts`
 * and for the slice B table in docs/specs/019-contributor-profile/spec.md (`bun run docs:test-plan`).
 *
 * `recorded`: anonymous reads of cwiki.apache.org (Confluence REST `content/search`, `body.view`)
 * and issues.apache.org (Jira REST `search`, `fields=assignee,reporter`) on 2026-10-21, committed
 * under `fixtures/kip-pages/`. `constructed`: made-up pages or stub answers that reach a boundary.
 * Rows of amendment (7) that the profile reads at request time stay in `kip-authors.cases.ts`.
 */
export const testPlanRows = [
  { id: "W93", case: "a plain list of nine", data: "recorded", input: "KIP-1165 view: \"Authors: Greg Harris, Ivan Yurchenko, …, Viktor Somogyi-Vass\"", expected: "listed; 9 names in page order" },
  { id: "W93", case: "a plain list across spans", data: "recorded", input: "KIP-1360 view: \"Authors: Omnia Ibrahim, Gaurav Narula,\" then a span \" Luke Chen, Federico Valeri\"", expected: "listed; 4 names" },
  { id: "W93", case: "the line ends at its block", data: "recorded", input: "KIP-1279 view: \"Authors: Luke Chen, Federico Valeri, Omnia Ibrahim, Gaurav Narula\" then a paragraph \"This design follows …\"", expected: "listed; 4 names, no text of the next paragraph" },
  { id: "W93", case: "user mentions", data: "recorded", input: "KIP-952: two user mentions, rendered \"Mital Awachat\" \"Christo Lolov\" with no comma", expected: "listed; 2 names" },
  { id: "W93", case: "an email in the line", data: "recorded", input: "KIP-1183: \"xinyu<xinyuzhou@automq.com>\"; KIP-1300 (page 406622741): \"Viquar Khan (Vaquar.khan@gmail.com)\"", expected: "listed; \"xinyu\" / \"Viquar Khan\"; no @ stored" },
  { id: "W93", case: "a parenthesized co-author", data: "recorded", input: "KIP-1258: \"Co-Author: <mention ujjwal kalia> (Ujjwal Kalia)\"", expected: "listed; the mention's name and \"Ujjwal Kalia\"" },
  { id: "W93", case: "a line under the Status heading", data: "recorded", input: "KIP-1026: \"Author: Arpit Goyal\" between the Status heading and the next heading", expected: "listed; \"Arpit Goyal\" (the header ends at the first heading after Status)" },
  { id: "W93", case: "a block that does not start with the label", data: "recorded", input: "KIP-986: \"To Co-Authors: None of the below contents is final or necessarily correct. …\"", expected: "no-list; no author" },
  { id: "W93", case: "not a list", data: "constructed", input: "\"Authors: the Kafka streams team, see the discussion thread for the full list of people\"", expected: "unparsed; no author, never a partial list" },
  { id: "W93", case: "no author line", data: "recorded", input: "KIP-1371 (template header only)", expected: "no-list" },
  { id: "W93", case: "collaborators are not authors", data: "recorded", input: "KIP-950: \"Authors: Mehari Beyene, Divij Vaidya\" and \"Collaborators: Karthik Rajagopalan, …\"", expected: "listed; the 2 authors only" },
  { id: "W93", case: "the word and, & and ;", data: "constructed", input: "\"Authors: Henry Cai; Tom Thornton & Greg Harris and Anna Müller-O'Brien\"", expected: "listed; 4 names" },
  { id: "W107", case: "one issue", data: "recorded", input: "KIP-1371 header \"JIRA: KAFKA-20995\"", expected: "one [KAFKA-20995]" },
  { id: "W107", case: "several issues", data: "recorded", input: "KIP-1370 header with KAFKA-20888 and KAFKA-20883 (Jira macros)", expected: "several, in page order" },
  { id: "W107", case: "several issues as links", data: "recorded", input: "KIP-1105 \"JIRA: KAFKA-17928 and KAFKA-17980\"; KIP-1128 three Jira macros", expected: "several [KAFKA-17928, KAFKA-17980]; [KAFKA-17178, KAFKA-17131, KAFKA-19688]" },
  { id: "W107", case: "empty", data: "recorded", input: "KIP-1383 \"JIRA: here [Ticket will be opened once the KIP is approved]\" linking KAFKA-1; KIP-1183 \"JIRA:\"", expected: "empty" },
  { id: "W107", case: "the template's link", data: "constructed", input: "\"JIRA: here [Change the link from KAFKA-1 to your own ticket]\" linking KAFKA-1", expected: "empty" },
  { id: "W107", case: "a query macro", data: "constructed", input: "JIRA block holding a jqlQuery macro", expected: "query, no key" },
  { id: "W107", case: "no field", data: "recorded", input: "\"Kafka Improvement Proposals\" index page body", expected: "none" },
  { id: "W108", case: "batching and unknown keys", data: "constructed", input: "160 keys incl. KAFKA-99999999", expected: "2 requests (100 + 60) with fields=assignee and validateQuery=warn; unknown key dropped" },
  { id: "W108", case: "recorded assignees", data: "recorded", input: "KIP-1165 KAFKA-19161; KIP-1360 KAFKA-20715; KIP-1105 KAFKA-17928, KAFKA-17980; unknown KAFKA-99999999", expected: "Ivan Yurchenko (ivanyu); null; Chu Cheng Li and Kamal Chandraprakash; dropped" },
  { id: "W108", case: "Jira fails", data: "constructed", input: "stub Jira answers 503", expected: "no table; last good kept; ok false, status failed" },
  { id: "W108", case: "Monday re-read", data: "constructed", input: "run on a Monday, table with 160 keys, no page changed", expected: "1 cwiki request, 2 Jira requests; every issue's readAt is the run" },
  { id: "W108", case: "Monday cap", data: "constructed", input: "run on a Monday, table with 350 keys, one changed page", expected: "3 Jira requests: the changed page's key, then the 299 oldest readings; never over budget from the re-read" },
  { id: "W108", case: "a re-read replaces the assignee", data: "constructed", input: "table: KAFKA-n assignee A; changed page re-reads KAFKA-n as B", expected: "assignee B only; A is not kept" },
  { id: "W110", case: "Jira fields kept", data: "recorded", input: "KAFKA-20995 with assignee and reporter user objects", expected: "assignee {key JIRAUSER306218, display Eric Chang} only; no reporter, name, timeZone, avatar" },
  { id: "W102", case: "names only", data: "recorded", input: "the recorded pages (usernames, user keys, avatars, emails in their sources) and Jira answer", expected: "no username, user key, email, avatar or body text in authors.json or last-run.json" },
  { id: "W97", case: "a 429", data: "constructed", input: "stub cwiki answers 429 on the first request", expected: "no table; last good kept; ok false, status failed; 1 request" },
  { id: "W97", case: "a 5xx, a timeout, unparsable JSON", data: "constructed", input: "stub cwiki answers 502 / throws a timeout / answers \"<html>\"", expected: "each: no table; last good kept; ok false, status failed; no retry" },
  { id: "W97", case: "over budget", data: "constructed", input: "a window needing 11 pages of 50", expected: "status over-budget after 10 requests; nothing written but last-run.json; next run starts from the same since" },
  { id: "W97", case: "positive control", data: "constructed", input: "stub answers 200 with 25 pages", expected: "table written; ok true" },
  { id: "W101", case: "pacing", data: "constructed", input: "a run of 3 cwiki pages and 1 Jira request", expected: "sequential; a 2 s delay before every request after the first; 30 s timeout signal; the project's User-Agent" },
  { id: "W105", case: "a new version", data: "constructed", input: "KIP-n version 3 in the table, 4 in the answer", expected: "entry replaced" },
  { id: "W105", case: "unchanged", data: "constructed", input: "same versions", expected: "authors.json not written; last-run.json written; status unchanged" },
  { id: "W105", case: "the window", data: "constructed", input: "last good run 2026-10-21T03:43Z / no table", expected: "since 2026-10-20T03:43Z / 365 days back" },
  { id: "W105", case: "a page without a KIP number", data: "recorded", input: "\"Kafka Improvement Proposals\" index page", expected: "skipped" },
  { id: "W105", case: "byte-equal", data: "recorded", input: "the recorded 7-day window, answered in two orders", expected: "equal bytes, pages sorted by KIP then page id (two KIP-1300 pages)" },
];
