/**
 * Spec 019 amendment (7), KIP authors revision: several authors per KIP, read from the KIP page's
 * author line by the `kip-pages` job, with the dev@ starter as fallback; the committers page as
 * `declared` links. [pending] until the amendment's merge PR runs it. `recorded` rows come from
 * public reads of cwiki.apache.org (Confluence REST, anonymous) and Pony Mail on 2026-10-21;
 * `constructed` rows are made up to reach a boundary.
 */
export const testPlanRows = [
  { id: "W93", case: "a plain list of nine", data: "recorded", input: "KIP-1165 view: \"Authors: Greg Harris, Ivan Yurchenko, …, Viktor Somogyi-Vass\"", expected: "listed; 9 names in page order" },
  { id: "W93", case: "the line ends at its block", data: "recorded", input: "KIP-1279 view: \"Authors: Luke Chen, Federico Valeri, Omnia Ibrahim, Gaurav Narula\" then a paragraph \"This design follows …\"", expected: "listed; 4 names, no text of the next paragraph" },
  { id: "W93", case: "user mentions", data: "recorded", input: "KIP-952: two ri:user mentions, rendered \"Mital Awachat\" \"Christo Lolov\" with no comma", expected: "listed; 2 names" },
  { id: "W93", case: "an email in the line", data: "recorded", input: "KIP-1183: \"xinyu<xinyuzhou@ automq.com >\"; KIP-1300: \"Viquar Khan (Vaquar.khan@gmail.com)\"", expected: "listed; \"xinyu\" / \"Viquar Khan\"; no @ stored" },
  { id: "W93", case: "a parenthesized co-author", data: "recorded", input: "KIP-1258: \"Author: <mention> (Ujjwal Kalia)\"", expected: "listed; the mention's name and \"Ujjwal Kalia\"" },
  { id: "W93", case: "not a list", data: "recorded", input: "KIP-986: \"Co-Authors: None of the below contents is final or necessarily correct. …\"", expected: "unparsed; no author" },
  { id: "W93", case: "no author line", data: "recorded", input: "KIP-1371 (template header only)", expected: "no-list" },
  { id: "W93", case: "collaborators are not authors", data: "recorded", input: "KIP-950: \"Authors: Mehari Beyene, Divij Vaidya\" and \"Collaborators: Karthik Rajagopalan, …\"", expected: "listed; the 2 authors only" },
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
  { id: "W97", case: "a 429", data: "constructed", input: "stub cwiki answers 429 on the first request", expected: "no table; last good kept; ok false, status failed; 1 request" },
  { id: "W97", case: "over budget", data: "constructed", input: "a window needing 11 pages of 50", expected: "status over-budget after 10 requests; nothing written" },
  { id: "W97", case: "positive control", data: "constructed", input: "stub answers 200 with 25 pages", expected: "table written; ok true" },
  { id: "W98", case: "isolation", data: "constructed", input: "the job throws on its cron", expected: "publication, digest and identity links unchanged; nothing outside internal/kips/v1/" },
  { id: "W98", case: "table missing", data: "constructed", input: "authors.json absent / not JSON", expected: "200; starter lines; \"author lists not available\"" },
  { id: "W99", case: "job off", data: "constructed", input: "KIP_PAGES unset", expected: "cron no-op, route 404, no cwiki request, no R2 call, no /health field" },
  { id: "W100", case: "health shape", data: "constructed", input: "a finished run", expected: "kipPages {revision, lastRun {ok, status, at, durationMs, since, requests, pagesRead, pagesChanged, listed, unparsed, bytesWritten, r2}, lastGoodAt, coverageFrom}" },
  { id: "W102", case: "names only", data: "recorded", input: "the W93 pages (with usernames, user keys, emails in their sources)", expected: "no username, user key, email, avatar or body text in any stored object or response" },
  { id: "W103", case: "committers as declared links", data: "constructed", input: "capture of 3 pairs, one name twice", expected: "2 declared entries with the committers page URL, date, reviewer" },
  { id: "W103", case: "refresh removes a pair", data: "constructed", input: "new capture without one pair", expected: "diff lists it as removed; no entry; next run splits" },
  { id: "W103", case: "blind check", data: "constructed", input: "measure:identity-links --blind", expected: "committers-page entries not read" },
  { id: "W104", case: "evidence must be a URL", data: "constructed", input: "entry github:unknowntpo ↔ mail:eric chang with evidence \"TODO(owner): …\"", expected: "rejected; no link" },
  { id: "W104", case: "with a URL", data: "recorded + constructed", input: "the same entry with an https URL; github:unknowntpo ↔ JIRAUSER306218 corroborated (5 keys)", expected: "one person; GitHub page lists KIP-1371" },
  { id: "W105", case: "a new version", data: "constructed", input: "KIP-n version 3 in the table, 4 in the answer", expected: "entry replaced" },
  { id: "W105", case: "unchanged", data: "constructed", input: "same versions", expected: "authors.json not written; last-run.json written" },
  { id: "W105", case: "the window", data: "constructed", input: "last good run 2026-10-21T03:43Z / no table", expected: "since 2026-10-20T03:43Z / 365 days back" },
  { id: "W105", case: "a page without a KIP number", data: "recorded", input: "\"Kafka Improvement Proposals\" index page", expected: "skipped" },
];
