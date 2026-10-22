/**
 * Spec 019 amendment (7), KIP authors revision: several authors per KIP, read from the KIP page's
 * author line by the `kip-pages` job, with the dev@ starter as fallback; the committers page as
 * `declared` links. Run by `apps/web/test/people-kips.test.ts` (slice C). `recorded` rows come from
 * public reads of cwiki.apache.org (Confluence REST, anonymous) and Pony Mail on 2026-10-21;
 * `constructed` rows are made up to reach a boundary.
 *
 * The rows of the `kip-pages` job itself (W93, W97–W100, W105, W107, W108, W110) moved to
 * `kip-pages.cases.ts` and the Worker's `kip-pages-worker.cases.ts` when that job was built
 * (slice B); the rows left here are read by the profile at request time and by the identity-link
 * job. W98's "table missing" and W102's response half stay for the profile.
 */
export const testPlanRows = [
  { id: "W94", case: "author and starter", data: "recorded", input: "KIP-1165 list names Viktor Somogyi-Vass; he started the recorded [DISCUSS] thread", expected: "\"author (KIP page)\", \"also started the discussion\"" },
  { id: "W94", case: "starter only", data: "recorded", input: "KIP-1371: no line; started by Eric Chang", expected: "mail:eric chang: \"started the discussion\"" },
  { id: "W94", case: "a starter the list does not name", data: "recorded + constructed", input: "KIP-1272 list \"Henry Cai, Thomas Thornton, Greg Harris\"; starter \"Henry Haiying Cai\" inside a constructed coverage", expected: "mail:henry haiying cai: \"started the discussion\"; not an author" },
  { id: "W94", case: "creator and editors give nothing", data: "recorded", input: "KIP-1357 editor Matthias J. Sax; KIP-1026 creator Divij Vaidya, author Arpit Goyal", expected: "no line for Matthias J. Sax or Divij Vaidya" },
  { id: "W95", case: "linked by writing in the discussion", data: "constructed", input: "KIP-1165 list; mail:greg harris wrote in a KIP-1165 thread in coverage", expected: "Greg Harris links to mail:greg harris (\"named on the KIP page, wrote in its discussion\")" },
  { id: "W95", case: "same name, other KIP only", data: "constructed", input: "mail:greg harris wrote only in a KIP-1150 thread", expected: "Greg Harris on KIP-1165 is a plain name" },
  { id: "W95", case: "linked by a declared entry", data: "constructed", input: "committers capture pair github:x ↔ mail:a b; author \"A B\" never on dev@", expected: "A B links to the person of github:x" },
  { id: "W95", case: "a different written name", data: "recorded", input: "author \"Henry Cai\"; dev@ identity mail:henry haiying cai", expected: "plain name; no link" },
  { id: "W95", case: "names never join identities", data: "constructed", input: "author \"A B\"; github:x and mail:a b unlinked", expected: "link table unchanged; no corroborated edge from the author line" },
  { id: "W96", case: "the section", data: "recorded + constructed", input: "PEOPLE_KIPS=true; mail:viktor somogyi-vass with KIP-1165", expected: "one line: KIP-1165, title, label, 9 names in page order, page and thread links" },
  { id: "W96", case: "a linked identity", data: "constructed", input: "github:x declared to mail:x, an author of KIP-n", expected: "github:x lists KIP-n with the link's basis" },
  { id: "W98", case: "table missing", data: "constructed", input: "authors.json absent / not JSON", expected: "200; starter lines; \"author lists not available\"" },
  { id: "W102", case: "names only", data: "recorded", input: "the W93 pages (with usernames, user keys, emails in their sources)", expected: "no username, user key, email, avatar or body text in any stored object or response" },
  { id: "W103", case: "committers as declared links", data: "constructed", input: "capture of 3 pairs, one name twice", expected: "2 declared entries with the committers page URL, date, reviewer" },
  { id: "W103", case: "refresh removes a pair", data: "constructed", input: "new capture without one pair", expected: "diff lists it as removed; no entry; next run splits" },
  { id: "W103", case: "blind check", data: "constructed", input: "measure:identity-links --blind", expected: "committers-page entries not read" },
  { id: "W104", case: "evidence must be a URL", data: "constructed", input: "entry github:unknowntpo ↔ mail:eric chang with evidence \"TODO(owner): …\"", expected: "rejected; no link" },
  { id: "W104", case: "with a URL", data: "recorded + constructed", input: "the same entry with an https URL; github:unknowntpo ↔ JIRAUSER306218 corroborated (5 keys)", expected: "one person; GitHub page lists KIP-1371" },
  { id: "W94", case: "assignee below the author line", data: "recorded", input: "KIP-1165: author line names Ivan Yurchenko; KAFKA-19161 assignee Ivan Yurchenko", expected: "jira-account of Ivan Yurchenko: \"author (KIP page)\" via a link, \"also assigned KAFKA-19161\"; otherwise \"assigned the KIP's Jira issue (KAFKA-19161)\"" },
  { id: "W94", case: "assignee above the starter", data: "recorded", input: "KIP-1376: KAFKA-20728 assignee Arnab Nandy; starter Mickael Maison", expected: "Arnab Nandy's Jira account: \"assigned the KIP's Jira issue (KAFKA-20728)\"; mail:mickael maison: \"started the discussion\"" },
  { id: "W109", case: "activity log is newer", data: "constructed", input: "job read A at 2026-10-20; activity-log entry with assignee B updated 2026-10-21", expected: "line for B only" },
  { id: "W109", case: "unassigned", data: "recorded", input: "KIP-1360 KAFKA-20715 assignee null", expected: "no assignee line" },
  { id: "W109", case: "two people on two issues", data: "recorded", input: "KIP-1105: two issues, Chu Cheng Li and Kamal Chandraprakash", expected: "each gets a line naming their own KAFKA-n" },
  { id: "W111", case: "through a corroborated link", data: "recorded", input: "github:unknowntpo ↔ JIRAUSER306218 (5 keys); KIP-1371 KAFKA-20995 assignee JIRAUSER306218", expected: "github:unknowntpo lists KIP-1371, basis corroborated" },
  { id: "W111", case: "no link", data: "recorded", input: "KIP-1360: no assignee; github:x unlinked", expected: "nothing listed on the GitHub page" },
  { id: "W111", case: "a committer holding the issue", data: "recorded", input: "KIP-1311 assignee Chia-Ping Tsai, starter Siddhartha Devineni", expected: "chia7712's Jira account: \"assigned the KIP's Jira issue\", never \"author\"" },
];
