/**
 * Spec 019 amendment (7), KIP authors revision, slice B: the `kip-pages` job inside the publisher
 * Worker (its cron entry, its route, its `/health` field). The single source for
 * `kip-pages-run.test.ts` and for the slice B Worker table in
 * docs/specs/019-contributor-profile/spec.md (`bun run docs:test-plan`). All rows are constructed:
 * a stub environment with a recording bucket and stub Durable Objects.
 */
export const testPlanRows = [
  { id: "W98", case: "isolation", data: "constructed", input: "the job's cron tick with cwiki throwing and the bucket failing its puts", expected: "publication, digest and every other job not started; no write outside internal/kips/v1/; the tick does not throw" },
  { id: "W98", case: "the publication tick", data: "constructed", input: "the publication's cron tick with KIP_PAGES set", expected: "the publication is scheduled; no cwiki or Jira request; nothing under internal/kips/v1/" },
  { id: "W99", case: "job off", data: "constructed", input: "KIP_PAGES unset, KIP_PAGES_CRON set", expected: "cron no-op, route 404, no cwiki request, no R2 call, no /health field" },
  { id: "W99", case: "positive control", data: "constructed", input: "KIP_PAGES=authors@1 with the same cron", expected: "the cron runs the job: one cwiki request, internal/kips/v1/ written; the route answers 401 without the token and 200 with it" },
  { id: "W100", case: "health shape", data: "constructed", input: "a finished run, then no run yet, then an unreadable record", expected: "kipPages is the run record; {revision, lastRun: null, lastGoodAt: null, coverageFrom: null}; null" },
];
