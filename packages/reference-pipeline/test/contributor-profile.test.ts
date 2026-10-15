/**
 * Spec 019 slice 2a: the contributor profile read from Spec 022's review store. Rows come from
 * `contributor-profile.cases.ts`; the store is built from the recorded GraphQL answer and the
 * constructed rows of that file.
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
import {
  PEOPLE_INDEX_TTL_MS,
  profileMonths,
  profileView,
  readPersonProfile,
  suppressionDigest,
  WORKS_WITH_CAP,
  type PeopleBucket,
  type PeopleRead,
  type PersonProfileV1,
} from "../src/people";
import { constructedRows, coverageRows, testPlanRows } from "./contributor-profile.cases";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const STATE = { schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: "2026-10-14T22:02:21Z", coverageFrom: "2025-10-14T00:00:00.000Z" };

const recorded = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/github-reviews/graphql-pull-reviews-kafka.json"), "utf8"));
const page = parsePullReviews(recorded, [23675, 23809, 99999999, 23165]);
if (!page.ok) throw new Error(page.error);
const recordedRows = page.pulls.flatMap((pull) => reviewRows(pull, { from: STATE.coverageFrom, machineUsers: [] }).rows);
const allRows: readonly ReviewRow[] = [...recordedRows, ...(constructedRows as unknown as readonly ReviewRow[])];

/** An in-memory R2 with Spec 022's objects; counts every `get` (W29). */
class CountingBucket implements PeopleBucket {
  readonly reads: string[] = [];
  constructor(readonly objects: Map<string, string>, private readonly broken: ReadonlySet<string> = new Set()) {}
  async get(key: string) {
    this.reads.push(key);
    if (this.broken.has(key)) throw new Error(`R2 failed for ${key}`);
    const body = this.objects.get(key);
    return body === undefined ? null : { text: async () => body };
  }
}

function store(projectId: string, rows: readonly ReviewRow[] = allRows, state: unknown = STATE): Map<string, string> {
  const objects = new Map<string, string>([[githubReviewsStateKey(projectId), JSON.stringify(state)]]);
  const byMonth = new Map<string, ReviewRow[]>();
  for (const row of rows) byMonth.set(reviewMonth(row.submittedAt), [...(byMonth.get(reviewMonth(row.submittedAt)) ?? []), row]);
  for (const [month, monthRows] of byMonth) objects.set(githubReviewsMonthKey(projectId, month), encodeReviewMonth(projectId, month, monthRows));
  return objects;
}

const kafka = () => new CountingBucket(store("apache-kafka"));

function given(body: PersonProfileV1): string {
  return `${body.totals.reviewsGiven.reviews} / ${body.totals.reviewsGiven.pullRequests}`;
}

function byState(body: PersonProfileV1): string {
  const names = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed" } as const;
  const parts = Object.entries(body.totals.reviewsGiven.byState).filter(([, count]) => count > 0).map(([state, count]) => {
    const before = state === "DISMISSED" ? [...new Set(body.reviewsGiven.flatMap((row) => (row.stateBefore === undefined ? [] : [names[row.stateBefore]])))] : [];
    return `${names[state as keyof typeof names]} ${count}${before.length > 0 ? ` (was ${before.join(", ")})` : ""}`;
  });
  return parts.length === 0 ? "—" : parts.sort().join(", ");
}

function received(body: PersonProfileV1): string {
  const totals = body.totals.reviewsReceived;
  return `${totals.reviews} / ${totals.pullRequests} / ${totals.reviewers}`;
}

function worksWith(body: PersonProfileV1): string {
  const view = profileView(body, "12m", NOW);
  const list = (label: string, entries: readonly { login: string; pullRequests: number }[]) =>
    entries.length === 0 ? [] : [`${label} ${entries.map((entry) => `${entry.login} ${entry.pullRequests}`).join(", ")}`];
  const parts = [...list("reviewed PRs by", view.worksWith.reviewedPullRequestsBy), ...list("reviewed by", view.worksWith.reviewedBy)];
  return parts.length === 0 ? "—" : parts.join("; ");
}

async function read(bucket: PeopleBucket, person: string, options: { project?: string; suppressed?: string; now?: number } = {}): Promise<PeopleRead> {
  const project = options.project ?? "kafka";
  const suppressed = options.suppressed === undefined || options.suppressed === "—"
    ? {}
    : { "apache-kafka": [await suppressionDigest("apache-kafka", `github:${options.suppressed}`)] };
  return readPersonProfile({ bucket, projectKey: project, personId: person, nowMs: options.now ?? NOW, suppressed });
}

describe("Spec 019 slice 2a: profile from the review store", () => {
  test.each([...testPlanRows])("$id: $person, $case → $status", async (row) => {
    const result = await read(kafka(), row.person, { suppressed: row.suppressed });
    expect(result.status).toBe(row.status);
    if (result.status !== 200) {
      expect(row.given).toBe("—");
      return;
    }
    expect(given(result.body)).toBe(row.given);
    expect(byState(result.body)).toBe(row.byState);
    expect(received(result.body)).toBe(row.received);
    expect(worksWith(result.body)).toBe(row.worksWith);
  });

  test.each([...coverageRows])("$id: coverage of $project", async (row) => {
    const projectId = row.project === "kafka" ? "apache-kafka" : "apache-datafusion";
    const result = await read(new CountingBucket(store(projectId)), "github:chia7712", { project: row.project });
    expect(result.status).toBe(200);
    const body = result.body as PersonProfileV1;
    const recordedPart = body.coverage.flatMap((item) => (item.status === "recorded" ? [`${item.source} ${item.from} → ${item.until} (stored from ${item.storedFrom})`] : []));
    const missing = body.coverage.filter((item) => item.status === "not-recorded").map((item) => item.source);
    expect(`${recordedPart.join("; ")}; ${missing.join(", ")} not recorded`).toBe(row.coverage);
    // The period the header shows is the recorded source's.
    expect(body.period.from).toBe("2025-11-01T00:00:00.000Z");
    expect(body.period.until).toBe(STATE.updatedAt);
  });

  test("W27: a 404 for a known community still states what is recorded and what is not", async () => {
    const result = await read(kafka(), "jira:5f2a9c1e");
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ coverage: [{ source: "github-reviews", status: "recorded" }, { source: "github", status: "not-recorded" }, { source: "jira", status: "not-recorded" }, { source: "mail", status: "not-recorded" }] });
  });

  test("W27: without a review store (flag off, or Prod) every source is not recorded and no identity has a profile", async () => {
    const result = await read(new CountingBucket(new Map()), "github:chia7712");
    expect(result.status).toBe(404);
    expect((result.body.coverage ?? []).every((item) => item.status === "not-recorded")).toBe(true);
    // Positive control: the same request against the store answers.
    expect((await read(kafka(), "github:chia7712")).status).toBe(200);
  });

  test("W8: rows are read as Spec 022 stores them: state, earlier verdict, time, inline comments; no commit, no text", async () => {
    const result = await read(kafka(), "github:constructed-reviewer");
    expect(result.status).toBe(200);
    expect((result.body as PersonProfileV1).reviewsGiven).toEqual([
      { reviewId: 2, pr: 90001, prAuthor: "constructed-author", state: "DISMISSED", stateBefore: "APPROVED", submittedAt: "2026-09-16T10:00:00Z", inlineComments: 0 },
    ]);
    const chia = (await read(kafka(), "github:chia7712")).body as PersonProfileV1;
    expect(chia.reviewsGiven.map((row) => [row.reviewId, row.state, row.inlineComments])).toEqual([[5441233492, "COMMENTED", 1], [4949350354, "COMMENTED", 2]]);
    expect(chia.totals.reviewsGiven.inlineComments).toBe(3);
    // Positive control for the self-reply rule on the same input: the stored rows do hold her answers.
    expect(recordedRows.filter((row) => row.reviewer === "gabriellefu" && row.prAuthor === "gabriellefu").length).toBe(18);
  });

  test("W12: a Bot-typed login learned from the rows is named in `bots` and listed under no Works with; positive control without the Bot row", async () => {
    const mjsax = (await read(kafka(), "github:mjsax")).body as PersonProfileV1;
    expect(mjsax.bots).toEqual(["acme-review-app"]);
    expect(mjsax.reviewsGiven.some((row) => row.prAuthor === "acme-review-app")).toBe(true);
    expect(profileView(mjsax, "12m", NOW).worksWith.reviewedPullRequestsBy.map((entry) => entry.login)).not.toContain("acme-review-app");
    const human = allRows.filter((row) => row.reviewer !== "acme-review-app");
    const control = (await read(new CountingBucket(store("apache-kafka", human)), "github:mjsax")).body as PersonProfileV1;
    expect(control.bots).toEqual([]);
    expect(profileView(control, "12m", NOW).worksWith.reviewedPullRequestsBy.map((entry) => entry.login)).toContain("acme-review-app");
    expect((await read(new CountingBucket(store("apache-kafka", human)), "github:acme-review-app")).status).toBe(200);
  });

  test("W8: an identity is matched without regard to case; the stored login is displayed", async () => {
    const result = await read(kafka(), "github:CHIA7712");
    expect(result.status).toBe(200);
    expect((result.body as PersonProfileV1).identity).toEqual({ id: "github:chia7712", source: "github", display: "chia7712", url: "https://github.com/chia7712" });
  });

  test("W26: with month objects for 13 months, only the newest 12 are read and counted", async () => {
    const bucket = kafka();
    expect(bucket.objects.has(githubReviewsMonthKey("apache-kafka", "2025-10"))).toBe(true);
    const old = await read(bucket, "github:old-reviewer");
    expect(old.status).toBe(404);
    expect(bucket.reads).not.toContain(githubReviewsMonthKey("apache-kafka", "2025-10"));
    expect(bucket.reads).toContain(githubReviewsMonthKey("apache-kafka", "2025-11"));
    expect(profileMonths(NOW, STATE.coverageFrom)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    // Positive control at exactly 12 months: the first second of the view counts.
    expect((await read(bucket, "github:edge-reviewer")).status).toBe(200);
  });

  test("W26: months before coverageFrom are not read, even inside the 12 months", () => {
    expect(profileMonths(NOW, "2026-08-20T00:00:00Z")).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(profileMonths(Date.parse("2026-01-03T00:00:00Z"), "2020-01-01T00:00:00Z")).toEqual(
      ["2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01"]);
  });

  test("W29: a cold request reads state.json and the 12 months; a warm one reads nothing; after 10 minutes it reads again", async () => {
    const bucket = kafka();
    expect((await read(bucket, "github:chia7712")).status).toBe(200);
    expect(bucket.reads.length).toBe(13);
    expect(bucket.reads[0]).toBe(githubReviewsStateKey("apache-kafka"));
    expect((await read(bucket, "github:lucasbru", { now: NOW + PEOPLE_INDEX_TTL_MS - 1 })).status).toBe(200);
    expect(bucket.reads.length).toBe(13);
    expect((await read(bucket, "github:lucasbru", { now: NOW + PEOPLE_INDEX_TTL_MS })).status).toBe(200);
    expect(bucket.reads.length).toBe(26);
  });

  test("W29: a failed read is not kept: the next request reads that object again", async () => {
    const key = githubReviewsMonthKey("apache-kafka", "2026-09");
    const broken = new Set([key]);
    const bucket = new CountingBucket(store("apache-kafka"), broken);
    await read(bucket, "github:mjsax");
    broken.delete(key);
    const second = await read(bucket, "github:mjsax");
    expect(bucket.reads.filter((read) => read === key).length).toBe(2);
    expect((second.body as PersonProfileV1).unavailableMonths).toEqual([]);
  });

  test("W10: a month that cannot be read or parsed is named; the profile answers with the other months", async () => {
    const objects = store("apache-kafka");
    objects.set(githubReviewsMonthKey("apache-kafka", "2026-09"), "{not json");
    const result = await read(new CountingBucket(objects, new Set([githubReviewsMonthKey("apache-kafka", "2026-10")])), "github:mjsax");
    expect(result.status).toBe(200);
    const body = result.body as PersonProfileV1;
    expect(body.unavailableMonths).toEqual(["2026-09", "2026-10"]);
    // Only the August comment is left; positive control: all three with every month readable.
    expect(body.totals.reviewsGiven.reviews).toBe(1);
    expect(((await read(kafka(), "github:mjsax")).body as PersonProfileV1).totals.reviewsGiven.reviews).toBe(4);
  });

  test("W10: a month object of another project or month is refused, not counted", async () => {
    const objects = store("apache-kafka");
    objects.set(githubReviewsMonthKey("apache-kafka", "2026-09"), encodeReviewMonth("apache-datafusion", "2026-09", []));
    const body = (await read(new CountingBucket(objects), "github:mjsax")).body as PersonProfileV1;
    expect(body.unavailableMonths).toEqual(["2026-09"]);
  });

  test("W11: unknown project and malformed ids are 400; a malformed review cursor is 503", async () => {
    expect((await read(kafka(), "github:chia7712", { project: "flink" })).status).toBe(400);
    for (const id of ["chia7712", "github:", "github:a b", "github:-leading", "github:../../state", "twitter:chia7712", ""]) {
      expect((await read(kafka(), id)).status).toBe(400);
    }
    const broken = new CountingBucket(store("apache-kafka", allRows, { schema: "something-else" }));
    expect((await read(broken, "github:chia7712")).status).toBe(503);
  });

  test("W13: no response for any fixture identity holds an address, a score or a rank", async () => {
    const people = new Set(allRows.flatMap((row) => [row.reviewer, row.prAuthor]));
    let served = 0;
    for (const login of people) {
      const result = await read(kafka(), `github:${login}`);
      const text = JSON.stringify(result.body);
      expect(text).not.toMatch(/@[A-Za-z0-9-]+\.[A-Za-z]{2,}/u);
      const keys = new Set<string>();
      JSON.parse(text, (key, value) => {
        keys.add(key.toLowerCase());
        return value;
      });
      expect([...keys].filter((key) => /score|rank|percentile|grade/u.test(key))).toEqual([]);
      if (result.status === 200) served += 1;
    }
    // Positive control: the walk saw served profiles, not only 404s.
    expect(served).toBeGreaterThan(5);
  });

  test("W5: the 12-month view of the page equals the response's totals; 90 days narrows it", async () => {
    const body = (await read(kafka(), "github:gabriellefu")).body as PersonProfileV1;
    const year = profileView(body, "12m", NOW);
    expect(year.totals).toEqual(body.totals);
    expect(year.overTime.map((row) => row.label)).toEqual([...body.period.months]);
    expect(year.overTime.find((row) => row.label === "2026-08")?.received).toBe(2);
    const quarter = profileView(body, "90d", NOW);
    expect(quarter.from).toBe(new Date(NOW - 90 * 86_400_000).toISOString());
    expect(quarter.totals.reviewsReceived.reviews).toBe(9);
    // A month later the August reviews (chia7712 08-17, mjsax 08-20) leave the 90 days.
    expect(profileView(body, "90d", Date.parse("2026-11-20T00:00:00Z")).totals.reviewsReceived).toEqual({ reviews: 7, pullRequests: 1, reviewers: 3 });
    expect(quarter.overTime[0]!.label).toBe("2026-07-13");
    expect(quarter.overTime.every((row) => new Date(`${row.label}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
  });

  test("W6: an identity whose rows are all before the selected period is empty in that period; positive control in 12 months", async () => {
    const body = (await read(kafka(), "github:edge-reviewer")).body as PersonProfileV1;
    expect(profileView(body, "90d", NOW).empty).toBe(true);
    expect(profileView(body, "12m", NOW).empty).toBe(false);
  });

  test("Behavior 9: each Works with list is capped at 10, by shared PRs then name", async () => {
    const rows: ReviewRow[] = Array.from({ length: 12 }, (_, index) => ({
      reviewId: 100 + index, pr: 80000 + index, prAuthor: `author-${String.fromCharCode(97 + index)}`, reviewer: "busy",
      isBot: false, state: "APPROVED", submittedAt: "2026-10-01T00:00:00Z", commit: null, inlineComments: 0,
    }));
    rows.push({ ...rows[11]!, reviewId: 999, pr: 80999 });
    const body = (await read(new CountingBucket(store("apache-kafka", rows)), "github:busy")).body as PersonProfileV1;
    const list = profileView(body, "12m", NOW).worksWith.reviewedPullRequestsBy;
    expect(list.length).toBe(WORKS_WITH_CAP);
    expect(list[0]).toEqual({ login: "author-l", pullRequests: 2 });
    expect(list.slice(1).map((entry) => entry.login)).toEqual(["author-a", "author-b", "author-c", "author-d", "author-e", "author-f", "author-g", "author-h", "author-i"]);
  });

  test("W5: threads are newest first, with the person's part and a link to the review", async () => {
    const body = (await read(kafka(), "github:lucasbru")).body as PersonProfileV1;
    const threads = profileView(body, "12m", NOW).threads;
    expect(threads.map((thread) => [thread.pr, thread.role, thread.reviews])).toEqual([[23675, "author", 1], [23165, "reviewer", 4]]);
    expect(threads[1]!.url).toBe("https://github.com/apache/kafka/pull/23165#pullrequestreview-5425459798");
    expect(threads[1]!.states).toEqual({ COMMENTED: 3, APPROVED: 1 });
    expect(threads[0]!.url).toBe("https://github.com/apache/kafka/pull/23675");
  });
});
