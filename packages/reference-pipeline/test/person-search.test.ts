/**
 * Spec 019 slice 3: person results for Search, read from the same review store and the same
 * per-isolate cache as the profile. Rows come from `person-search.cases.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  encodeReviewMonth,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsMonthKey,
  githubReviewsStateKey,
  parsePullReviews,
  reviewMonth,
  reviewRows,
  type ReviewRow,
} from "../src/github-reviews";
import { peopleActivityStateKey, PEOPLE_INDEX_TTL_MS, readPersonProfile, suppressionDigest, type PeopleBucket } from "../src/people";
import { PEOPLE_SEARCH_SCHEMA, personQueryKey, searchPeople, type PeopleSearchRead } from "../src/people/search";
import { constructedRows } from "./contributor-profile.cases";
import { searchRows, testPlanRows } from "./person-search.cases";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const STATE = { schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: "2026-10-14T22:02:21Z", coverageFrom: "2025-10-14T00:00:00.000Z" };

const recorded = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/github-reviews/graphql-pull-reviews-kafka.json"), "utf8"));
const page = parsePullReviews(recorded, [23675, 23809, 99999999, 23165]);
if (!page.ok) throw new Error(page.error);
const allRows: readonly ReviewRow[] = [
  ...page.pulls.flatMap((pull) => reviewRows(pull, { from: STATE.coverageFrom, machineUsers: [] }).rows),
  ...(constructedRows as unknown as readonly ReviewRow[]),
  ...(searchRows as unknown as readonly ReviewRow[]),
];

class CountingBucket implements PeopleBucket {
  readonly reads: string[] = [];
  constructor(readonly objects: Map<string, string>, readonly broken: Set<string> = new Set()) {}
  async get(key: string) {
    this.reads.push(key);
    if (this.broken.has(key)) throw new Error(`R2 failed for ${key}`);
    const body = this.objects.get(key);
    return body === undefined ? null : { text: async () => body };
  }
}

function store(projectId: string, state: unknown = STATE): Map<string, string> {
  const objects = new Map<string, string>([[githubReviewsStateKey(projectId), JSON.stringify(state)]]);
  const byMonth = new Map<string, ReviewRow[]>();
  for (const row of allRows) byMonth.set(reviewMonth(row.submittedAt), [...(byMonth.get(reviewMonth(row.submittedAt)) ?? []), row]);
  for (const [month, monthRows] of byMonth) objects.set(githubReviewsMonthKey(projectId, month), encodeReviewMonth(projectId, month, monthRows));
  return objects;
}

const projectIds: Record<string, string> = { kafka: "apache-kafka", datafusion: "apache-datafusion" };

async function search(bucket: PeopleBucket, query: string, options: { project?: string; suppressed?: string; now?: number } = {}): Promise<PeopleSearchRead> {
  const project = options.project ?? "kafka";
  const projectId = projectIds[project]!;
  const suppressed = options.suppressed === undefined || options.suppressed === "—"
    ? {}
    : { [projectId]: [await suppressionDigest(projectId, `github:${options.suppressed}`)] };
  return searchPeople({ bucket, projectKey: project, query, nowMs: options.now ?? NOW, suppressed });
}

const listed = (read: PeopleSearchRead) => {
  if (read.status !== 200) throw new Error(`status ${read.status}`);
  return read.body.people.length === 0 ? "—" : read.body.people.map((person) => `${person.id} ${person.match}`).join(", ");
};

describe("Spec 019 slice 3: person results from the review store", () => {
  test.each([...testPlanRows])("$id: $project \"$query\", $case → $people", async (row) => {
    const bucket = new CountingBucket(store(projectIds[row.project]!));
    const read = await search(bucket, row.query, { project: row.project, suppressed: row.suppressed });
    expect(listed(read)).toBe(row.people);
    expect(bucket.reads.length).toBe(row.reads);
    if (read.status === 200) {
      expect(read.body.schema).toBe(PEOPLE_SEARCH_SCHEMA);
      expect(read.body.project).toBe(row.project);
      for (const person of read.body.people) expect(person.source).toBe("github");
    }
  });

  test("W40: a login is found by its exact query if and only if its profile answers 200", async () => {
    const logins = [...new Set(allRows.flatMap((row) => [row.reviewer, row.prAuthor]))];
    expect(logins.length).toBeGreaterThan(15);
    const bucket = new CountingBucket(store("apache-kafka"));
    const mismatches: string[] = [];
    let found = 0;
    for (const login of logins) {
      const profile = await readPersonProfile({ bucket, projectKey: "kafka", personId: `github:${login}`, nowMs: NOW, suppressed: {} });
      const people = (await search(bucket, login)).body as unknown as { people: { id: string; match: string; display: string }[] };
      const exact = people.people.find((person) => person.match === "exact");
      if (exact !== undefined) found += 1;
      const hasProfile = profile.status === 200;
      if (hasProfile !== (exact !== undefined) || (hasProfile && exact!.id !== profile.body.identity.id)) mismatches.push(login);
      // Every result, exact or prefix, leads to a page that exists.
      for (const person of people.people) {
        const linked = await readPersonProfile({ bucket, projectKey: "kafka", personId: person.id, nowMs: NOW, suppressed: {} });
        if (linked.status !== 200) mismatches.push(`${login} → ${person.id}`);
      }
    }
    expect(mismatches).toEqual([]);
    // Positive control: most logins have a page, and some do not (bots, before the view).
    expect(found).toBeGreaterThan(10);
    expect(found).toBeLessThan(logins.length);
  });

  test("W40: rows before coverageFrom inside a month that is read do not count; positive control with the earlier coverageFrom", async () => {
    const late = new CountingBucket(store("apache-kafka", { ...STATE, coverageFrom: "2025-11-15T00:00:00.000Z" }));
    expect(listed(await search(late, "edge-reviewer"))).toBe("—");
    expect((await readPersonProfile({ bucket: late, projectKey: "kafka", personId: "github:edge-reviewer", nowMs: NOW, suppressed: {} })).status).toBe(404);
    expect(listed(await search(new CountingBucket(store("apache-kafka")), "edge-reviewer"))).toBe("github:edge-reviewer exact");
  });

  test("W40: a month that cannot be read is skipped; people of the other months are found", async () => {
    const month = githubReviewsMonthKey("apache-kafka", "2026-08");
    const bucket = new CountingBucket(store("apache-kafka"), new Set([month]));
    expect(listed(await search(bucket, "lu"))).toBe("github:lucasbru prefix");
    expect(listed(await search(bucket, "edge-reviewer"))).toBe("github:edge-reviewer exact");
    // Positive control: readable again after the failed read was dropped from the cache.
    bucket.broken.clear();
    expect(listed(await search(bucket, "lu"))).toBe("github:lu exact, github:lu-a prefix, github:lu-b prefix");
  });

  test("W42: an unknown project is 400; an unreadable review cursor is 503; no review store means no people", async () => {
    expect((await search(new CountingBucket(store("apache-kafka")), "chia7712", { project: "kafka" })).status).toBe(200);
    expect((await searchPeople({ bucket: new CountingBucket(store("apache-kafka")), projectKey: "flink", query: "chia7712", nowMs: NOW })).status).toBe(400);
    const malformed = new CountingBucket(new Map([[githubReviewsStateKey("apache-kafka"), "{"]]));
    expect((await search(malformed, "chia7712")).status).toBe(503);
    expect(listed(await search(new CountingBucket(new Map()), "chia7712"))).toBe("—");
  });

  test("W43: cold reads state.json and the 12 months a profile reads; warm reads nothing; after 10 minutes again", async () => {
    const bucket = new CountingBucket(store("apache-kafka"));
    await search(bucket, "chia7712");
    expect(bucket.reads.length).toBe(13);
    expect(bucket.reads[0]).toBe(githubReviewsStateKey("apache-kafka"));
    await search(bucket, "lu", { now: NOW + PEOPLE_INDEX_TTL_MS - 1 });
    expect(bucket.reads.length).toBe(13);
    await search(bucket, "lu", { now: NOW + PEOPLE_INDEX_TTL_MS });
    expect(bucket.reads.length).toBe(26);

    // The profile and the search share the isolate's cache: the same keys, read once.
    const shared = new CountingBucket(store("apache-kafka"));
    await readPersonProfile({ bucket: shared, projectKey: "kafka", personId: "github:chia7712", nowMs: NOW });
    const profileKeys = [...shared.reads].sort();
    await search(shared, "chia");
    // Slice 2b: the profile also reads the activity log's state.json (absent here); the search reads nothing more.
    expect(shared.reads.length).toBe(14);
    const fresh = new CountingBucket(store("apache-kafka"));
    await search(fresh, "chia");
    expect([...fresh.reads, peopleActivityStateKey("apache-kafka")].sort()).toEqual(profileKeys);
  });

  test("W41: the query key is the lower-cased login; anything else has none", () => {
    expect(personQueryKey("  @Chia7712 ")).toBe("chia7712");
    expect(personQueryKey("chia-7712")).toBe("chia-7712");
    for (const query of ["", "@", "@@chia", "-chia", "chia 7712", "chia7712[bot]", "github:chia7712", "é", "a".repeat(40)]) {
      expect(personQueryKey(query)).toBeUndefined();
    }
    expect(personQueryKey("a".repeat(39))).toBe("a".repeat(39));
  });

  test("Behavior 9: a response holds no score, rank or address", async () => {
    const read = await search(new CountingBucket(store("apache-kafka")), "lu");
    const text = JSON.stringify(read.body);
    expect(text).not.toMatch(/score|rank|@[a-z0-9-]+\.[a-z]/iu);
    expect(Object.keys((read.body as unknown as { people: object[] }).people[0]!).sort()).toEqual(["display", "id", "match", "source"]);
  });
});
