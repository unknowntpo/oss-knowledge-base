/**
 * Spec 022: the review ingestion job against a fake GitHub (the REST "updated since" listing and
 * the batched GraphQL read), an in-memory bucket and a controlled clock; and the Worker's flag.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { PullReviews, ReviewMonthObject, ReviewNode } from "@oss-knowledge-base/reference-pipeline";
import worker from "../src/index";
import { githubReviewsProjects } from "../src/github-reviews/projects";
import { runGithubReviews, type GithubReviewsLastRun, type GithubReviewsState } from "../src/github-reviews/run";
import { GITHUB_REVIEWS_LAST_RUN_KEY, githubReviewsMonthKey, githubReviewsStateKey, type GithubReviewsBucket } from "../src/github-reviews/store";

const KAFKA = { projectId: "apache-kafka", owner: "apache", repo: "kafka", machineUsers: [] as string[] };
const DATAFUSION = { projectId: "apache-datafusion", owner: "apache", repo: "datafusion", machineUsers: ["codecov-commenter"] };
const NOW = Date.parse("2026-10-13T22:07:00Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

class MemoryBucket implements GithubReviewsBucket {
  readonly objects = new Map<string, { body: string; etag: string }>();
  gets = 0;
  puts = 0;
  /** Runs once, between a month object's read and its write. */
  beforeWrite: (() => void) | undefined;
  failPut: ((key: string) => boolean) | undefined;
  private version = 0;

  set(key: string, body: string): void {
    this.objects.set(key, { body, etag: `e${(this.version += 1)}` });
  }
  json<T>(key: string): T | undefined {
    const object = this.objects.get(key);
    return object === undefined ? undefined : JSON.parse(object.body) as T;
  }
  async get(key: string) {
    this.gets += 1;
    return this.objects.get(key);
  }
  async putIfMatch(key: string, body: string, etag: string | null): Promise<boolean> {
    this.beforeWrite?.();
    this.beforeWrite = undefined;
    this.puts += 1;
    if ((this.objects.get(key)?.etag ?? null) !== etag) return false;
    this.set(key, body);
    return true;
  }
  async put(key: string, body: string): Promise<void> {
    this.puts += 1;
    if (this.failPut?.(key) === true) throw new Error("R2 put failed");
    this.set(key, body);
  }
}

interface Item { number: number; updated_at: string; pull_request?: { url: string } }

class FakeGitHub {
  readonly items = new Map<string, Item[]>();
  readonly pulls = new Map<string, Map<number, PullReviews>>();
  readonly calls: { repo: string; kind: "list" | "graphql"; url: string; numbers: number[]; authorization: string | null }[] = [];
  /** Returns a response to send instead of the real one. */
  intercept: ((call: FakeGitHub["calls"][number], count: number) => Response | undefined) | undefined;

  add(repo: string, number: number, updatedAt: string, reviews: readonly ReviewNode[] | null, author = "grace"): void {
    this.items.set(repo, [...(this.items.get(repo) ?? []).filter((item) => item.number !== number), {
      number, updated_at: updatedAt, ...(reviews === null ? {} : { pull_request: { url: `https://api.github.com/repos/apache/${repo}/pulls/${number}` } }),
    }]);
    if (reviews !== null) {
      const map = this.pulls.get(repo) ?? new Map<number, PullReviews>();
      map.set(number, { number, author: { login: author, __typename: "User" }, reviews: { totalCount: reviews.length, nodes: reviews } });
      this.pulls.set(repo, map);
    }
  }

  count(repo: string, kind: "list" | "graphql"): number {
    return this.calls.filter((call) => call.repo === repo && call.kind === kind).length;
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const authorization = new Headers(init.headers).get("authorization");
    const url = new URL(input);
    if (url.pathname === "/graphql") {
      const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: { repo: string } };
      const numbers = [...query.matchAll(/p(\d+): pullRequest/gu)].map((match) => Number(match[1]));
      const call = { repo: variables.repo, kind: "graphql" as const, url: input, numbers, authorization };
      this.calls.push(call);
      const intercepted = this.intercept?.(call, this.count(call.repo, "graphql"));
      if (intercepted !== undefined) return intercepted;
      const repository: Record<string, unknown> = {};
      const errors: unknown[] = [];
      for (const number of numbers) {
        const pull = this.pulls.get(variables.repo)?.get(number);
        repository[`p${number}`] = pull ?? null;
        if (pull === undefined) errors.push({ type: "NOT_FOUND", path: ["repository", `p${number}`], message: "Could not resolve" });
      }
      return Response.json({ data: { rateLimit: { cost: 1, remaining: 4999 }, repository }, ...(errors.length === 0 ? {} : { errors }) });
    }
    const repo = url.pathname.split("/")[3]!;
    const call = { repo, kind: "list" as const, url: input, numbers: [], authorization };
    this.calls.push(call);
    const intercepted = this.intercept?.(call, this.count(repo, "list"));
    if (intercepted !== undefined) return intercepted;
    const since = url.searchParams.get("since")!;
    const size = Number(url.searchParams.get("per_page"));
    const page = Number(url.searchParams.get("page"));
    const all = (this.items.get(repo) ?? []).filter((item) => Date.parse(item.updated_at) >= Date.parse(since))
      .sort((a, b) => (a.updated_at === b.updated_at ? a.number - b.number : a.updated_at < b.updated_at ? -1 : 1));
    // A real listing item carries a title and a body; the job must not keep them.
    return Response.json(all.slice((page - 1) * size, page * size).map((item) => ({ ...item, title: "A title", body: "A body the job must drop" })));
  };
}

const review = (id: number, submittedAt: string, extra: Partial<ReviewNode> = {}): ReviewNode => ({
  databaseId: id, author: { login: "ada", __typename: "User" }, state: "APPROVED", submittedAt, commit: { oid: "a".repeat(40) }, comments: { totalCount: 0 }, ...extra,
});

function world(options: { flag?: string | undefined; token?: string; maxPullsPerRun?: number } = {}) {
  const bucket = new MemoryBucket();
  const github = new FakeGitHub();
  const waits: number[] = [];
  let now = NOW;
  const run = (dryRun = false) => runGithubReviews({
    flag: "flag" in options ? options.flag : "metadata@1",
    bucket,
    projects: [KAFKA, DATAFUSION],
    githubToken: options.token ?? "token-under-test",
    githubFetch: github.fetch,
    now: () => now,
    delay: async (ms) => { waits.push(ms); },
    dryRun,
    ...(options.maxPullsPerRun === undefined ? {} : { maxPullsPerRun: options.maxPullsPerRun }),
  });
  return {
    bucket, github, waits, run,
    advance: (ms: number) => { now += ms; },
    state: (projectId = KAFKA.projectId) => bucket.json<GithubReviewsState>(githubReviewsStateKey(projectId)),
    month: (month: string, projectId = KAFKA.projectId) => bucket.json<ReviewMonthObject>(githubReviewsMonthKey(projectId, month)),
    lastRun: () => bucket.json<GithubReviewsLastRun>(GITHUB_REVIEWS_LAST_RUN_KEY),
  };
}

/** A day like the measured one: two pull requests reviewed, one untouched, one issue. */
function seededDay(w: ReturnType<typeof world>) {
  w.github.add("kafka", 101, at(NOW - 3_600_000), [
    review(1, at(NOW - 7_200_000), { author: { login: "copilot-pull-request-reviewer", __typename: "Bot" }, state: "COMMENTED", comments: { totalCount: 2 } }),
    review(2, at(NOW - 5_400_000), { author: { login: "grace", __typename: "User" }, state: "COMMENTED", comments: { totalCount: 1 } }),
    review(3, at(NOW - 3_600_000)),
  ]);
  w.github.add("kafka", 102, at(NOW - 1_800_000), []);
  w.github.add("kafka", 103, at(NOW - 600_000), [review(4, at(NOW - 600_000), { state: "CHANGES_REQUESTED", author: { login: "linus", __typename: "User" } })]);
  w.github.add("datafusion", 900, at(NOW - 900_000), null);
  w.github.add("datafusion", 901, at(NOW - 1_200_000), [review(5, at(NOW - 1_200_000), { author: { login: "codecov-commenter", __typename: "User" }, state: "COMMENTED" })]);
}

describe("Spec 022 review ingestion run", () => {
  test("RV4: a first run reads one day and records where coverage starts; the next run re-reads 300 s", async () => {
    const w = world();
    seededDay(w);
    w.github.add("kafka", 50, at(NOW - DAY - 1_000), [review(90, at(NOW - DAY - 1_000))]); // updated before the first day
    const first = await w.run();
    expect(first.ok).toBe(true);
    const list = new URL(w.github.calls.find((call) => call.repo === "kafka" && call.kind === "list")!.url);
    expect(Object.fromEntries(list.searchParams)).toEqual({ state: "all", sort: "updated", direction: "asc", since: "2026-10-12T22:07:00.000Z", per_page: "100", page: "1" });
    expect(w.state()).toEqual({ schema: "osskb.github-reviews-state.v1", updatedAt: at(NOW - 600_000), coverageFrom: "2026-10-12T22:07:00.000Z" });
    expect(w.month("2026-10")!.rows.map((row) => row.reviewId)).toEqual([1, 2, 3, 4]); // review 90 is before coverage
    expect(w.state(DATAFUSION.projectId)!.updatedAt).toBe(at(NOW - 900_000)); // the issue is the newest item

    w.advance(DAY);
    w.github.add("kafka", 104, at(NOW + 3_600_000), [review(6, at(NOW + 3_600_000))]);
    await w.run();
    const second = new URL(w.github.calls.filter((call) => call.repo === "kafka" && call.kind === "list").at(-1)!.url);
    expect(second.searchParams.get("since")).toBe(new Date(NOW - 600_000 - 300_000).toISOString());
    expect(w.state()).toMatchObject({ updatedAt: at(NOW + 3_600_000), coverageFrom: "2026-10-12T22:07:00.000Z" });
    expect(w.month("2026-10")!.rows.map((row) => row.reviewId)).toEqual([1, 2, 3, 4, 6]);
    for (const call of w.github.calls) expect(call.authorization).toBe("Bearer token-under-test");
  });

  test("RV5: a run over the overlap adds no row and writes neither the month nor the cursor again", async () => {
    const w = world();
    seededDay(w);
    await w.run();
    const stored = w.bucket.objects.get(githubReviewsMonthKey(KAFKA.projectId, "2026-10"))!;
    const puts = w.bucket.puts;
    w.advance(60_000);
    const again = await w.run();
    const kafka = again.projects[KAFKA.projectId]!;
    expect(kafka).toMatchObject({ ok: true, pulls: 1, reviews: 1, added: 0, changed: 0, monthsRead: 1, monthsWritten: 0 }); // #103 is inside the 300 s overlap
    expect(w.bucket.objects.get(githubReviewsMonthKey(KAFKA.projectId, "2026-10"))).toBe(stored);
    expect(w.bucket.puts - puts).toBe(1); // the run record only
  });

  test("RV9: a backlog above the cap is read over several runs, oldest first, and no review is lost", async () => {
    const w = world({ maxPullsPerRun: 5 });
    for (let index = 1; index <= 12; index += 1) w.github.add("kafka", index, at(NOW - DAY + index * 60_000), [review(index, at(NOW - DAY + index * 60_000))]);
    const runs = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      runs.push((await w.run()).projects[KAFKA.projectId]!);
      w.advance(60_000);
    }
    // Each later run also re-reads the pull requests inside the 300 s overlap; they do not count against the cap.
    expect(runs.map((run) => [run.pulls, run.truncated, run.added])).toEqual([[5, true, 5], [10, true, 5], [8, false, 2]]);
    expect(runs.map((run) => run.cursor)).toEqual([5, 10, 12].map((minute) => at(NOW - DAY + minute * 60_000)));
    expect(w.month("2026-10")!.rows.map((row) => row.reviewId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(w.github.calls.filter((call) => call.kind === "graphql" && call.repo === "kafka").map((call) => call.numbers.length)).toEqual([5, 10, 8]);
  });

  test("RV12: reviews on either side of a month boundary go to two objects, each ordered by time", async () => {
    const w = world();
    const start = Date.parse("2026-10-01T00:10:00Z");
    w.advance(start - NOW);
    w.github.add("kafka", 7, "2026-10-01T00:05:00Z", [review(2, "2026-10-01T00:00:00Z"), review(1, "2026-09-30T23:59:59Z"), review(3, "2026-09-30T23:00:00Z")]);
    const run = (await w.run()).projects[KAFKA.projectId]!;
    expect(run).toMatchObject({ monthsRead: 2, monthsWritten: 2, added: 3 });
    expect(w.month("2026-09")).toMatchObject({ schema: "osskb.github-reviews.v1", projectId: "apache-kafka", month: "2026-09" });
    expect(w.month("2026-09")!.rows.map((row) => row.reviewId)).toEqual([3, 1]);
    expect(w.month("2026-10")!.rows.map((row) => row.reviewId)).toEqual([2]);
  });

  test("RV13: a GraphQL batch that fails twice fails that project only; it writes nothing and keeps its cursor", async () => {
    const w = world();
    seededDay(w);
    w.github.intercept = (call) => (call.repo === "kafka" && call.kind === "graphql" ? new Response("bad gateway", { status: 502 }) : undefined);
    const run = await w.run();
    expect(run).toMatchObject({ ok: false, failureKind: "source" });
    expect(run.projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "transport", graphqlRequests: 2, monthsWritten: 0 });
    expect(run.projects[DATAFUSION.projectId]).toMatchObject({ ok: true, added: 1 });
    expect(w.state()).toBeUndefined();
    expect(w.month("2026-10")).toBeUndefined();
    expect(w.month("2026-10", DATAFUSION.projectId)!.rows).toHaveLength(1);
    expect(w.waits).toEqual([5_000]);

    w.github.intercept = undefined;
    w.advance(600_000);
    expect((await w.run()).projects[KAFKA.projectId]).toMatchObject({ ok: true, added: 4 }); // the retry reads the same day
  });

  test("RV14: 401 and a rate limit stop the project without a retry; a short Retry-After is honoured once", async () => {
    const unauthorized = world();
    seededDay(unauthorized);
    unauthorized.github.intercept = (call) => (call.kind === "list" ? new Response("", { status: 401 }) : undefined);
    const first = await unauthorized.run();
    expect(first.projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "auth", restRequests: 1, graphqlRequests: 0 });

    const limited = world();
    seededDay(limited);
    limited.github.intercept = (call) => (call.kind === "list" ? new Response("", { status: 403, headers: { "retry-after": "120" } }) : undefined);
    expect((await limited.run()).projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "rate-limit", restRequests: 1 });
    expect(limited.waits).toEqual([]);

    const brief = world();
    seededDay(brief);
    brief.github.intercept = (call, count) => (call.repo === "kafka" && call.kind === "list" && count === 1 ? new Response("", { status: 429, headers: { "retry-after": "30" } }) : undefined);
    expect((await brief.run()).projects[KAFKA.projectId]).toMatchObject({ ok: true, restRequests: 2, added: 4 });
    expect(brief.waits).toEqual([30_000]);

    const graphqlLimited = world();
    seededDay(graphqlLimited);
    graphqlLimited.github.intercept = (call) => (call.kind === "graphql" ? Response.json({ errors: [{ type: "RATE_LIMITED" }] }) : undefined);
    expect((await graphqlLimited.run()).projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "rate-limit", graphqlRequests: 1 });
  });

  test("RV15: a run that dies after the month write leaves the cursor; the next run writes the same rows once", async () => {
    const w = world();
    seededDay(w);
    w.bucket.failPut = (key) => key === githubReviewsStateKey(KAFKA.projectId);
    const died = (await w.run()).projects[KAFKA.projectId]!;
    expect(died).toMatchObject({ ok: false, failureKind: "internal", monthsWritten: 1 });
    expect(w.state()).toBeUndefined();
    const stored = w.bucket.objects.get(githubReviewsMonthKey(KAFKA.projectId, "2026-10"))!;

    w.bucket.failPut = undefined;
    const next = (await w.run()).projects[KAFKA.projectId]!;
    expect(next).toMatchObject({ ok: true, added: 0, changed: 0, monthsWritten: 0 });
    expect(w.bucket.objects.get(githubReviewsMonthKey(KAFKA.projectId, "2026-10"))).toBe(stored);
    expect(w.state()!.updatedAt).toBe(at(NOW - 600_000));
  });

  test("RV16: a month object changed by another run between read and write is not overwritten", async () => {
    const w = world();
    seededDay(w);
    const key = githubReviewsMonthKey(KAFKA.projectId, "2026-10");
    w.bucket.beforeWrite = () => w.bucket.set(key, JSON.stringify({ schema: "osskb.github-reviews.v1", projectId: KAFKA.projectId, month: "2026-10", rows: [] }));
    const run = (await w.run()).projects[KAFKA.projectId]!;
    expect(run).toMatchObject({ ok: false, failureKind: "conflict", monthsWritten: 0 });
    expect(w.month("2026-10")!.rows).toEqual([]);
    expect(w.state()).toBeUndefined();
    expect((await w.run()).projects[KAFKA.projectId]).toMatchObject({ ok: true, added: 4 });
  });

  test("RV17: an unsupported flag value or a missing token sends nothing to GitHub and is recorded as a config failure", async () => {
    for (const options of [{ flag: "true" }, { flag: undefined }, { token: " " }]) {
      const w = world(options);
      seededDay(w);
      const run = await w.run();
      expect(run).toMatchObject({ ok: false, failureKind: "config", projects: {} });
      expect(w.github.calls).toHaveLength(0);
      expect(w.bucket.gets).toBe(0);
      expect(w.lastRun()).toEqual(run);
    }
  });

  test("RV18: a malformed stored cursor or month object fails the project and is left as it is", async () => {
    const cursor = world();
    seededDay(cursor);
    cursor.bucket.set(githubReviewsStateKey(KAFKA.projectId), JSON.stringify({ schema: "osskb.github-reviews-state.v1", updatedAt: "yesterday" }));
    expect((await cursor.run()).projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "schema", restRequests: 0 });
    expect(cursor.bucket.json<{ updatedAt: string }>(githubReviewsStateKey(KAFKA.projectId))!.updatedAt).toBe("yesterday");

    const month = world();
    seededDay(month);
    const key = githubReviewsMonthKey(KAFKA.projectId, "2026-10");
    month.bucket.set(key, JSON.stringify({ schema: "something-else", rows: [] }));
    expect((await month.run()).projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "internal", monthsWritten: 0 });
    expect(month.bucket.json<{ schema: string }>(key)!.schema).toBe("something-else");
    expect(month.state()).toBeUndefined();
  });

  test("RV19: a dry run reads GitHub and the bucket and writes nothing", async () => {
    const w = world();
    seededDay(w);
    const run = await w.run(true);
    expect(run).toMatchObject({ ok: true, dryRun: true });
    expect(run.projects[KAFKA.projectId]).toMatchObject({ reviews: 4, added: 4, monthsWritten: 0 });
    expect(w.bucket.puts).toBe(0);
    expect(w.bucket.objects.size).toBe(0);
  });

  test("RV8: a reply by the pull request's author is stored with prAuthor equal to reviewer and counted apart, as are bots", async () => {
    const w = world();
    seededDay(w);
    const run = await w.run();
    expect(run.projects[KAFKA.projectId]).toMatchObject({ reviews: 4, botReviews: 1, selfReviews: 1 });
    expect(run.projects[DATAFUSION.projectId]).toMatchObject({ reviews: 1, botReviews: 1 }); // the project's machine user
    const rows = w.month("2026-10")!.rows;
    expect(rows.map((row) => [row.reviewer, row.prAuthor, row.isBot, row.state, row.inlineComments])).toEqual([
      ["copilot-pull-request-reviewer", "grace", true, "COMMENTED", 2],
      ["grace", "grace", false, "COMMENTED", 1],
      ["ada", "grace", false, "APPROVED", 0],
      ["linus", "grace", false, "CHANGES_REQUESTED", 0],
    ]);
  });

  test("RV10: nothing stored holds a title or text from GitHub", async () => {
    const w = world();
    seededDay(w);
    await w.run();
    const stored = [...w.bucket.objects.values()].map((object) => object.body).join("\n");
    expect(stored).not.toContain("A body the job must drop");
    expect(stored).not.toContain("A title");
    expect(Object.keys(w.month("2026-10")!.rows[0]!).sort()).toEqual(["commit", "inlineComments", "isBot", "pr", "prAuthor", "reviewId", "reviewer", "state", "submittedAt"]);
    expect([...w.bucket.objects.keys()].every((key) => key.startsWith("internal/github-reviews/v1/"))).toBe(true);
  });

  test("RV20: a first run stores nothing submitted before its day, even on a pull request updated today", async () => {
    const w = world();
    w.github.add("kafka", 7, at(NOW - 3_600_000), [review(1, at(NOW - 40 * DAY)), review(2, at(NOW - DAY - 1_000)), review(3, at(NOW - 3_600_000))]);
    await w.run();
    expect(w.month("2026-10")!.rows.map((row) => row.reviewId)).toEqual([3]);
    expect(w.month("2026-09")).toBeUndefined();
  });

  test("RV20: a review older than 35 days is not written, however far back coverage starts", async () => {
    const w = world();
    w.bucket.set(githubReviewsStateKey(KAFKA.projectId), JSON.stringify({ schema: "osskb.github-reviews-state.v1", updatedAt: at(NOW - DAY), coverageFrom: at(NOW - 60 * DAY) }));
    w.github.add("kafka", 7, at(NOW - 3_600_000), [review(1, at(NOW - 35 * DAY - 1_000)), review(2, at(NOW - 35 * DAY)), review(3, at(NOW - 3_600_000))]);
    const run = (await w.run()).projects[KAFKA.projectId]!;
    expect(run).toMatchObject({ reviews: 2, monthsRead: 2 });
    expect([...(w.month("2026-09")?.rows ?? []), ...w.month("2026-10")!.rows].map((row) => row.reviewId)).toEqual([2, 3]);
  });

  test("RV6: a review stored as approved and dismissed later keeps the verdict it had", async () => {
    const w = world();
    w.github.add("kafka", 7, at(NOW - 3_600_000), [review(1, at(NOW - 3_600_000))]);
    await w.run();
    w.advance(DAY);
    w.github.add("kafka", 7, at(NOW + 3_600_000), [review(1, at(NOW - 3_600_000), { state: "DISMISSED" })]);
    const run = (await w.run()).projects[KAFKA.projectId]!;
    expect(run).toMatchObject({ changed: 1, dismissed: 1, added: 0, monthsWritten: 1 });
    expect(w.month("2026-10")!.rows).toMatchObject([{ reviewId: 1, state: "DISMISSED", stateBefore: "APPROVED" }]);
  });

  test("RV22: the measured busiest day costs 3 listing pages and 7 GraphQL requests; the cap bounds a run at 26 per project", async () => {
    const w = world();
    // 2026-10-13: 70 Kafka pull requests; 85 DataFusion pull requests and 30 issues (Spec 022 Evidence).
    for (let index = 1; index <= 70; index += 1) w.github.add("kafka", index, at(NOW - DAY + index * 60_000), [review(index, at(NOW - DAY + index * 60_000))]);
    for (let index = 1; index <= 115; index += 1) w.github.add("datafusion", index, at(NOW - DAY + index * 60_000), index % 4 === 0 && index <= 120 ? null : [review(1_000 + index, at(NOW - DAY + index * 60_000))]);
    const day = await w.run();
    expect([w.github.count("kafka", "list"), w.github.count("kafka", "graphql")]).toEqual([1, 3]);
    expect([w.github.count("datafusion", "list"), w.github.count("datafusion", "graphql")]).toEqual([2, 4]);
    expect(day.projects[KAFKA.projectId]).toMatchObject({ restRequests: 1, graphqlRequests: 3, graphqlCost: 3, monthsRead: 1, monthsWritten: 1 });
    expect(w.bucket.gets).toBe(4); // per project: the cursor and one month
    expect(w.bucket.puts).toBe(5); // per project: one month and the cursor; then the run record

    const backlog = world();
    for (let index = 1; index <= 700; index += 1) backlog.github.add("kafka", index, at(NOW - DAY + index * 1_000), []);
    const capped = (await backlog.run()).projects[KAFKA.projectId]!;
    expect(capped).toMatchObject({ pulls: 500, truncated: true, restRequests: 5, graphqlRequests: 20 });
  });

  test("RV24: the run record names, per project, the cursor, coverage, counts and requests", async () => {
    const w = world();
    seededDay(w);
    w.github.add("kafka", 99999999, at(NOW - 60_000), null);
    w.github.items.get("kafka")!.at(-1)!.pull_request = { url: "x" }; // listed as a pull request GitHub cannot resolve
    const run = await w.run();
    expect(w.lastRun()).toEqual(run);
    expect(run).toMatchObject({ ok: true, revision: "metadata@1", dryRun: false, startedAt: "2026-10-13T22:07:00.000Z" });
    expect(run.projects[KAFKA.projectId]).toMatchObject({
      ok: true, since: "2026-10-12T22:07:00.000Z", cursor: at(NOW - 60_000), coverageFrom: "2026-10-12T22:07:00.000Z",
      listed: 4, pulls: 4, truncated: false, reviews: 4, botReviews: 1, selfReviews: 1, added: 4, changed: 0, dismissed: 0,
      droppedPulls: 1, reviewsTruncated: 0, monthsRead: 1, monthsWritten: 1, restRequests: 1, graphqlRequests: 1, graphqlCost: 1,
    });
    expect(run.projects[KAFKA.projectId]!.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(run)).not.toContain("token-under-test");
  });
});

describe("Spec 022 flag in the Worker", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function environment(flag: string | undefined, stored: Record<string, unknown> = {}) {
    const operations: string[] = [];
    const publisher: string[] = [];
    const outbound: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      outbound.push(String(input));
      return String(input).includes("/graphql") ? Response.json({ data: { repository: {} } }) : Response.json([]);
    }) as typeof fetch;
    const stub = (body: unknown, log?: string[]) => ({
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (url: string, init?: RequestInit) => {
          log?.push(`${init?.method ?? "GET"} ${url}`);
          return Response.json(body, { status: url.endsWith("/run") ? 202 : 200 });
        },
      }),
    });
    const env = {
      PUBLICATION_ENVIRONMENT: "development",
      GITHUB_SOURCE_TOKEN: "token-under-test",
      MANUAL_TRIGGER_TOKEN: "manual-under-test",
      PIPELINE_STATE: stub({ environment: "development", running: false }, publisher),
      DIGEST_RUN: stub({ running: false }),
      OSS_KB_BUCKET: {
        get: async (key: string) => {
          operations.push(`get ${key}`);
          return key in stored ? { json: async () => stored[key], text: async () => JSON.stringify(stored[key]), etag: "e1" } : null;
        },
        put: async (key: string) => {
          operations.push(`put ${key}`);
          return {};
        },
      },
      ...(flag === undefined ? {} : { GITHUB_REVIEWS: flag }),
    };
    const pending: Promise<unknown>[] = [];
    const tick = async () => {
      await worker.scheduled({ cron: "7 22 * * *", scheduledTime: NOW } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
      await Promise.all(pending);
    };
    return { env, operations, publisher, outbound, tick };
  }

  test("RV2: with the flag unset a publication tick only schedules the publication: no GitHub request, no bucket request", async () => {
    const off = environment(undefined);
    await off.tick();
    expect(off.publisher).toEqual(["POST https://pipeline.internal/run"]);
    expect(off.outbound).toEqual([]);
    expect(off.operations).toEqual([]);

    // Positive control: the same tick with the flag set reads GitHub and the bucket, and schedules the same publication.
    const on = environment("metadata@1");
    await on.tick();
    expect(on.publisher).toEqual(off.publisher);
    expect(on.outbound.filter((url) => url.startsWith("https://api.github.com/repos/")).length).toBe(githubReviewsProjects.length);
    expect(on.operations).toContain(`put ${GITHUB_REVIEWS_LAST_RUN_KEY}`);
  });

  test("RV2: with the flag unset /health is byte-identical to before and the manual route answers 403 without running", async () => {
    const off = environment(undefined);
    const health = await worker.fetch(new Request("https://data.example/health"), off.env as never);
    const text = await health.text();
    expect(text).toBe(JSON.stringify({ environment: "development", running: false, digest: { running: false }, reviewQueue: null, searchEmbedding: JSON.parse(text).searchEmbedding, searchQuery: JSON.parse(text).searchQuery }));
    expect(text).not.toContain("githubReviews");
    expect(off.operations).toEqual(["get public/review-queue/v1/apache-kafka/last-run.json"]);

    const unauthorized = await worker.fetch(new Request("https://data.example/github-reviews/run", { method: "POST" }), off.env as never);
    expect(unauthorized.status).toBe(401);
    const disabled = await worker.fetch(new Request("https://data.example/github-reviews/run", { method: "POST", headers: { authorization: "Bearer manual-under-test" } }), off.env as never);
    expect([disabled.status, await disabled.json()]).toEqual([403, { ok: false, disabled: true }]);
    expect(off.outbound).toEqual([]);
  });

  test("RV17: a flag with an unsupported value still schedules the publication and records the review run as a config failure", async () => {
    const bad = environment("true");
    await bad.tick();
    expect(bad.publisher).toEqual(["POST https://pipeline.internal/run"]);
    expect(bad.outbound).toEqual([]);
    expect(bad.operations).toEqual([`put ${GITHUB_REVIEWS_LAST_RUN_KEY}`]);
  });

  test("RV24: with the flag set /health carries the run record as githubReviews, or null before the first run", async () => {
    const record = { ok: true, completedAt: "2026-10-13T22:07:05.000Z" };
    const withRun = environment("metadata@1", { [GITHUB_REVIEWS_LAST_RUN_KEY]: record });
    const body = await (await worker.fetch(new Request("https://data.example/health"), withRun.env as never)).json() as { githubReviews: unknown };
    expect(body.githubReviews).toEqual(record);
    const before = environment("metadata@1");
    const empty = await (await worker.fetch(new Request("https://data.example/health"), before.env as never)).json() as Record<string, unknown>;
    expect("githubReviews" in empty && empty.githubReviews === null).toBe(true);
  });

  test("RV26: Dev sets metadata@1 and Prod nothing; with Dev's value and an empty bucket the first tick reads one day back", async () => {
    const vars = async (environment: "development" | "production") =>
      (JSON.parse(await Bun.file(new URL(`../wrangler.${environment}.jsonc`, import.meta.url)).text()) as { vars?: Record<string, string> }).vars ?? {};
    const dev = (await vars("development")).GITHUB_REVIEWS;
    expect(dev).toBe("metadata@1");
    expect("GITHUB_REVIEWS" in await vars("production")).toBe(false);

    const first = environment(dev);
    const before = Date.now();
    await first.tick();
    const after = Date.now();
    expect(first.publisher).toEqual(["POST https://pipeline.internal/run"]);
    // The Worker runs on the wall clock: each project lists from one day before the tick.
    const since = first.outbound.filter((url) => url.startsWith("https://api.github.com/repos/")).map((url) => Date.parse(new URL(url).searchParams.get("since")!));
    expect(since).toHaveLength(githubReviewsProjects.length);
    for (const start of since) expect(start >= before - DAY && start <= after - DAY).toBe(true);
    // An empty day writes each project's first cursor and the run record, nothing older.
    expect(first.operations.filter((operation) => operation.startsWith("put "))).toEqual([
      ...githubReviewsProjects.map((project) => `put ${githubReviewsStateKey(project.projectId)}`),
      `put ${GITHUB_REVIEWS_LAST_RUN_KEY}`,
    ]);
  });

  test("RV7: every GitHub project is ingested, with its machine users", () => {
    expect(githubReviewsProjects.map((project) => [project.projectId, project.owner, project.repo])).toEqual([["apache-kafka", "apache", "kafka"], ["apache-datafusion", "apache", "datafusion"]]);
    expect(githubReviewsProjects.find((project) => project.projectId === "apache-datafusion")!.machineUsers).toContain("codecov-commenter");
  });
});
