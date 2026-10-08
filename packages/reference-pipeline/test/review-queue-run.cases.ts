/**
 * Spec 015 slice 2 test plan (the job in the data Worker), [pending] until slice 2 runs it.
 * See review-queue.cases.ts for the capture notes.
 */
export const testPlanRows = [
  { id: "Q17", rule: "rate limit", input: "constructed: GraphQL HTTP 403 \"secondary rate limit\", Retry-After 120", expected: "no retry; PR section keeps the previous snapshot; github failureKind rate-limit" },
  { id: "Q17", rule: "rate limit", input: "constructed: HTTP 429 with Retry-After 30, then 200", expected: "one retry after 30 s; snapshot published" },
  { id: "Q17", rule: "rate limit", input: "constructed: HTTP 429 with Retry-After 60, then 200", expected: "one retry; published" },
  { id: "Q17", rule: "rate limit", input: "constructed: HTTP 429 with Retry-After 61", expected: "no retry; previous kept; rate-limit" },
  { id: "Q17", rule: "rate limit", input: "constructed: HTTP 200 with errors[0].type RATE_LIMITED", expected: "rate-limit; previous snapshot kept" },
  { id: "Q18", rule: "partial pages", input: "constructed: page 3 of 7 returns 502 twice", expected: "no PR snapshot published; previous kept; failureKind transport" },
  { id: "Q25", rule: "thread fetch", input: "constructed: thread.lua 503 twice for KIP-1376, previous row exists", expected: "previous row kept with its fetchedAt" },
  { id: "Q25", rule: "thread fetch", input: "constructed: thread.lua 503 twice for a new thread", expected: "row omitted; unavailable 1 shown" },
  { id: "Q26", rule: "email fetch", input: "constructed: email.lua 404 for one KIP-1349 message", expected: "row shows seen wording (Q16); message counted unread" },
  { id: "Q27", rule: "cache", input: "constructed: second run, KIP-1349 thread unchanged", expected: "0 email.lua requests for KIP-1349" },
  { id: "Q27", rule: "cache", input: "constructed: previous object regexVersion 1, current 2", expected: "6 email.lua requests for KIP-1349" },
  { id: "Q30", rule: "feed release", input: "constructed: public/v2/current.json missing", expected: "KIP section keeps previous; PR section updated; mail failureKind pointer-missing" },
  { id: "Q32", rule: "overlap", input: "constructed: run B (started later) wrote pointer; run A finishes after", expected: "A's pointer write refused (older generatedAt); B stays" },
  { id: "Q33", rule: "too large", input: "constructed: GraphQL page body 4 MiB + 1 byte", expected: "failureKind too-large; previous kept" },
  { id: "Q33", rule: "too large", input: "constructed: GraphQL page body exactly 4 MiB", expected: "accepted" },
  { id: "Q42", rule: "auth", input: "constructed: GraphQL HTTP 401", expected: "failureKind auth; no retry; KIP section updated" },
  { id: "Q43", rule: "first run", input: "constructed: no previous object; Pony Mail down; GitHub ok", expected: "published; PR column filled; KIP column unavailable; mail ok false" },
  { id: "Q44", rule: "crash", input: "constructed: run killed after the content object write", expected: "pointer unchanged; next run publishes; verify:health flags last-run older than 2 h" },
  { id: "Q45", rule: "write", input: "constructed: R2 put of the content object throws", expected: "pointer and previous object unchanged; last-run failureKind write" },
  { id: "Q48", rule: "mail retry", input: "constructed: thread.lua 503 with Retry-After 5, then 200", expected: "one retry after 5 s; row updated" },
  { id: "Q48", rule: "mail retry", input: "constructed: 21 thread requests", expected: "sequential, at least 1 s apart" },
  { id: "Q52", rule: "roster cache", input: "constructed: stored roster fetched 23 h 59 min ago", expected: "reused; 0 roster requests" },
  { id: "Q52", rule: "roster cache", input: "constructed: stored roster fetched exactly 24 h ago", expected: "refetched; 2 roster requests" },
  { id: "Q52", rule: "roster cache", input: "constructed: stored roster 30 h old, refetch fails", expected: "stored roster and its fetchedAt kept" },
  { id: "Q52", rule: "roster cache", input: "constructed: no stored roster, refetch fails", expected: "no roster; tallies use the seen wording (Q29)" },
];
