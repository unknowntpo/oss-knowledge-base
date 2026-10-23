/**
 * Spec 029: the retained-set rules (RT2) and the pool rule (RT3). The single source for
 * `retention.test.ts` and for the test plan in docs/specs/029-r2-retention/spec.md
 * (`bun run docs:test-plan`). Releases are written as their UTC date, ids at 22:07Z; W = 30 days,
 * floor N = 2, grace 48 h; the run is at 2026-10-22T10:17Z, so the window starts at
 * 2026-09-22T10:17Z. All rows are constructed.
 */
export const RUN_AT = Date.parse("2026-10-22T10:17:00Z");

export const testPlanRows = [
  { id: "RT2", case: "31 verified daily releases", input: "09-21 … 10-21, pointers at 10-21", retained: "09-22 … 10-21", candidate: "09-21" },
  { id: "RT2", case: "pointer rolled back to an old release", input: "40 verified daily 09-12 … 10-21, Feed pointer at 09-15", retained: "09-22 … 10-21 + 09-15", candidate: "the other 9" },
  { id: "RT2", case: "Feed and Search pointers on different releases", input: "verified daily 10-19 … 10-21; Feed 10-21, Search 10-20", retained: "10-19 … 10-21, both kept", candidate: "—" },
  { id: "RT2", case: "embedding job pinned to a release outside the window", input: "verified 09-01 and 09-22 … 10-21; `lastRun.releaseId` 09-01", retained: "window + 09-01", candidate: "—" },
  { id: "RT2", case: "digest pointer outside the window", input: "verified 09-02 and 09-22 … 10-21; digest `sourceReleaseId` 09-02", retained: "window + 09-02", candidate: "—" },
  { id: "RT2", case: "publishing stalled 45 days", input: "verified daily 08-01 … 09-07, pointers at 09-07", retained: "09-06, 09-07 (floor)", candidate: "08-01 … 09-05" },
  { id: "RT2", case: "hourly releases inside the window", input: "verified hourly 09-22T11Z … 10-13", retained: "all", candidate: "—" },
  { id: "RT2", case: "release without evidence, 3 days old", input: "crashed attempt 10-19; verified 10-20, 10-21", retained: "10-20, 10-21", candidate: "10-19" },
  { id: "RT2", case: "release without evidence, 47 h old", input: "crashed attempt 10-20T11:17Z; verified 10-20, 10-21", retained: "kept (grace)", candidate: "—" },
  { id: "RT2", case: "floor = 1", input: "config", retained: "rejected: floor must be ≥ 2", candidate: "—" },
  { id: "RT3", case: "pool object unmarked, uploaded 49 h ago", input: "—", retained: "—", candidate: "candidate" },
  { id: "RT3", case: "pool object unmarked, uploaded 47 h ago", input: "—", retained: "kept (grace)", candidate: "—" },
  { id: "RT3", case: "pool object marked only by the oldest release in the window", input: "uploaded 09-02", retained: "kept", candidate: "—" },
];

export type RetentionCase = (typeof testPlanRows)[number];

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

/** A release id (`2026-10-21T22-07-00-000Z`) at `at`. */
export const releaseIdAt = (at: number) => new Date(at).toISOString().replace(/[:.]/gu, "-");
const daily = (from: string, to: string): number[] => {
  const out: number[] = [];
  for (let at = Date.parse(`2026-${from}T22:07:00Z`); at <= Date.parse(`2026-${to}T22:07:00Z`); at += DAY) out.push(at);
  return out;
};
const day = (date: string) => Date.parse(`2026-${date}T22:07:00Z`);

/** One RT2 row as data: verified releases (with evidence), crashed attempts (no evidence), pins. */
export interface ReleaseFixture {
  readonly verified: readonly number[];
  readonly crashed?: readonly number[];
  readonly feed: number;
  readonly search: number;
  readonly digest?: number;
  readonly embedding?: number;
  /** Expected, as release times; every other listed release is a candidate. */
  readonly retained: readonly number[];
  readonly floor?: number;
}

export const releaseFixtures: Readonly<Record<string, ReleaseFixture | "floor-rejected">> = {
  "31 verified daily releases": { verified: daily("09-21", "10-21"), feed: day("10-21"), search: day("10-21"), retained: daily("09-22", "10-21") },
  "pointer rolled back to an old release": { verified: daily("09-12", "10-21"), feed: day("09-15"), search: day("10-21"), retained: [...daily("09-22", "10-21"), day("09-15")] },
  "Feed and Search pointers on different releases": { verified: daily("10-19", "10-21"), feed: day("10-21"), search: day("10-20"), retained: daily("10-19", "10-21") },
  "embedding job pinned to a release outside the window": { verified: [day("09-01"), ...daily("09-22", "10-21")], feed: day("10-21"), search: day("10-21"), embedding: day("09-01"), retained: [day("09-01"), ...daily("09-22", "10-21")] },
  "digest pointer outside the window": { verified: [day("09-02"), ...daily("09-22", "10-21")], feed: day("10-21"), search: day("10-21"), digest: day("09-02"), retained: [day("09-02"), ...daily("09-22", "10-21")] },
  "publishing stalled 45 days": { verified: daily("08-01", "09-07"), feed: day("09-07"), search: day("09-07"), retained: [day("09-06"), day("09-07")] },
  "hourly releases inside the window": (() => {
    const hourly: number[] = [];
    for (let at = Date.parse("2026-09-22T11:07:00Z"); at <= Date.parse("2026-10-13T22:07:00Z"); at += HOUR) hourly.push(at);
    return { verified: hourly, feed: hourly.at(-1)!, search: hourly.at(-1)!, retained: hourly };
  })(),
  "release without evidence, 3 days old": { verified: daily("10-20", "10-21"), crashed: [day("10-19")], feed: day("10-21"), search: day("10-21"), retained: daily("10-20", "10-21") },
  "release without evidence, 47 h old": { verified: daily("10-20", "10-21"), crashed: [Date.parse("2026-10-20T11:17:00Z")], feed: day("10-21"), search: day("10-21"), retained: [...daily("10-20", "10-21"), Date.parse("2026-10-20T11:17:00Z")] },
  "floor = 1": "floor-rejected",
};

/** RT3 rows: one pool object each; `markedBy` is the release whose evidence lists it. */
export const poolFixtures: Readonly<Record<string, { readonly uploaded: number; readonly marked: boolean; readonly candidate: boolean }>> = {
  "pool object unmarked, uploaded 49 h ago": { uploaded: RUN_AT - 49 * HOUR, marked: false, candidate: true },
  "pool object unmarked, uploaded 47 h ago": { uploaded: RUN_AT - 47 * HOUR, marked: false, candidate: false },
  "pool object marked only by the oldest release in the window": { uploaded: Date.parse("2026-09-02T22:07:00Z"), marked: true, candidate: false },
};
