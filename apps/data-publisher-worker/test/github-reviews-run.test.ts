/**
 * Spec 022: the review ingestion job against a fake GitHub (the REST "updated since" listing and
 * the batched GraphQL read), an in-memory bucket and a controlled clock; and the Worker's flag.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { PullReviews, ReviewMonthObject, ReviewNode } from "@oss-knowledge-base/reference-pipeline";
import worker from "../src/index";
import { githubReviewsProjects } from "../src/github-reviews/projects";
import {
  runGithubReviews,
  runGithubReviewsBackfill,
  type GithubReviewsBackfillLastRun,
  type GithubReviewsBackfillState,
  type GithubReviewsLastRun,
  type GithubReviewsState,
} from "../src/github-reviews/run";
import { runGithubReviewsRefresh, type GithubReviewsRefreshLastRun } from "../src/github-reviews/refresh";
import {
  GITHUB_REVIEWS_BACKFILL_LAST_RUN_KEY,
  GITHUB_REVIEWS_LAST_RUN_KEY,
  GITHUB_REVIEWS_REFRESH_LAST_RUN_KEY,
  githubReviewsBackfillKey,
  githubReviewsMonthKey,
  githubReviewsStateKey,
  type GithubReviewsBucket,
} from "../src/github-reviews/store";

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
  /** Runs once, just before the conditional write of that key. */
  readonly beforeWriteOf = new Map<string, () => void>();
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
    const hook = this.beforeWriteOf.get(key);
    this.beforeWriteOf.delete(key);
    hook?.();
    this.puts += 1;
    if (this.failPut?.(key) === true) throw new Error("R2 put failed");
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
  /** `metadata@2` fields, returned only when the query asks for them (labels, title, public names). */
  readonly meta = new Map<string, { title: string; labels: string[]; names: Record<string, string | null> }>();
  readonly queries: string[] = [];
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
      this.queries.push(query);
      const areas = query.includes("labels(first:");
      const call = { repo: variables.repo, kind: "graphql" as const, url: input, numbers, authorization };
      this.calls.push(call);
      const intercepted = this.intercept?.(call, this.count(call.repo, "graphql"));
      if (intercepted !== undefined) return intercepted;
      const repository: Record<string, unknown> = {};
      const errors: unknown[] = [];
      for (const number of numbers) {
        const pull = this.pulls.get(variables.repo)?.get(number);
        const meta = this.meta.get(`${variables.repo}#${number}`);
        const actor = (value: { login: string; __typename: string } | null) =>
          (value === null || !areas ? value : { ...value, ...(value.__typename === "User" ? { name: meta?.names[value.login] ?? null } : {}) });
        repository[`p${number}`] = pull === undefined ? null : !areas ? pull : {
          ...pull,
          author: actor(pull.author),
          title: meta?.title ?? `KAFKA-${number}: a change`,
          labels: { totalCount: meta?.labels.length ?? 0, nodes: (meta?.labels ?? []).slice(0, 30).map((name) => ({ name })) },
          reviews: { ...pull.reviews, nodes: pull.reviews.nodes.map((node) => ({ ...node, author: actor(node.author) })) },
        };
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
    // GitHub refuses deep offsets of a large listing (seen 2026-10-14: page 10 answered, page 15 refused).
    if (page > 10) return Response.json({ message: "Pagination with the page parameter is not supported for large datasets, please use cursor based pagination (after/before)" }, { status: 422 });
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
  const refreshFlag = () => ("flag" in options ? options.flag : "metadata@1");
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
  const backfill = (from: string, dryRun = false, maxPullsPerRun = options.maxPullsPerRun) => runGithubReviewsBackfill({
    flag: "flag" in options ? options.flag : "metadata@1",
    bucket,
    projects: [KAFKA, DATAFUSION],
    githubToken: options.token ?? "token-under-test",
    githubFetch: github.fetch,
    now: () => now,
    delay: async (ms) => { waits.push(ms); },
    dryRun,
    from,
    ...(maxPullsPerRun === undefined ? {} : { maxPullsPerRun }),
  });
  const refresh = (dryRun = false) => runGithubReviewsRefresh({
    flag: refreshFlag(),
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
    bucket, github, waits, run, backfill, refresh,
    refreshRecord: () => bucket.json<GithubReviewsRefreshLastRun>(GITHUB_REVIEWS_REFRESH_LAST_RUN_KEY),
    progress: (projectId = KAFKA.projectId) => bucket.json<GithubReviewsBackfillState>(githubReviewsBackfillKey(projectId)),
    backfillRecord: () => bucket.json<GithubReviewsBackfillLastRun>(GITHUB_REVIEWS_BACKFILL_LAST_RUN_KEY),
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
    expect(capped).toMatchObject({ pulls: 500, truncated: true, restRequests: 6, graphqlRequests: 20 }); // keyed pages repeat their last second: 99 new items a page
  });

  test("RV9: a day with more than 1,000 updated items (a stale-bot sweep of issues) is listed by key and does not fail on deep pages", async () => {
    const w = world();
    for (let index = 1; index <= 1_200; index += 1) w.github.add("datafusion", 10_000 + index, at(NOW - DAY + 1_000 + index * 30_000), null);
    for (let index = 1; index <= 3; index += 1) w.github.add("datafusion", index, at(NOW - 120_000 + index * 1_000), [review(index, at(NOW - 120_000 + index * 1_000))]);
    const run = (await w.run()).projects[DATAFUSION.projectId]!;
    expect(run).toMatchObject({ ok: true, pulls: 3, added: 3, truncated: false, listed: 1_203 });
    const pages = w.github.calls.filter((call) => call.repo === "datafusion" && call.kind === "list").map((call) => new URL(call.url).searchParams);
    expect(pages.length).toBeGreaterThan(10);
    expect(pages.every((params) => params.get("page") === "1")).toBe(true);
    expect(w.state(DATAFUSION.projectId)!.updatedAt).toBe(at(NOW - 117_000));
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


const FROM = "2026-04-14T00:00:00.000Z";
const MAY = Date.parse("2026-05-01T00:00:00Z");
const ids = (w: ReturnType<typeof world>, month: string, projectId = KAFKA.projectId) => w.month(month, projectId)?.rows.map((row) => row.reviewId) ?? [];

/**
 * Six months of history on top of a day the daily run has already read: twelve pull requests
 * reviewed on 1 May; #30 updated in April with one review before `from`; #31 reviewed in May and
 * updated again today, so it is listed only at today's position; an issue in June.
 */
async function historyAfterFirstDay(maxPullsPerRun = 5) {
  const w = world({ maxPullsPerRun });
  seededDay(w);
  w.github.add("kafka", 30, "2026-04-20T00:00:00Z", [review(300, "2026-04-13T23:59:59Z"), review(301, "2026-04-20T00:00:00Z")]);
  for (let index = 10; index <= 21; index += 1) w.github.add("kafka", index, at(MAY + index * 3_600_000), [review(index, at(MAY + index * 3_600_000))]);
  w.github.add("kafka", 31, at(NOW - 7_000_000), [review(310, "2026-05-05T00:00:00Z"), review(311, at(NOW - 7_000_000))]);
  w.github.add("kafka", 32, "2026-06-01T00:00:00Z", null);
  await w.run(); // the daily first run: one day back
  w.advance(600_000);
  return w;
}

describe("Spec 022 backfill", () => {
  test("RV28: a backfill walks forward from `from` in chunks of the cap and stores only what the daily run does not own", async () => {
    const w = await historyAfterFirstDay();
    const daily = w.state()!;
    expect([daily.coverageFrom, ids(w, "2026-10")]).toEqual(["2026-10-12T22:07:00.000Z", [1, 311, 2, 3, 4]]);
    const runs = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const run = await w.backfill(FROM);
      runs.push(run.projects[KAFKA.projectId]!);
      if (run.projects[KAFKA.projectId]!.done) break;
      w.advance(60_000);
    }
    expect(runs.map((run) => [run.pulls, run.truncated, run.done])).toEqual([[5, true, false], [6, true, false], [6, true, false], [3, false, true]]); // after the first, each re-reads the pull request at its cursor
    expect(runs.every((run) => run.ok && run.from === FROM && run.until === daily.coverageFrom)).toBe(true);
    // 14 reviews in the window, plus #13 and #18 read again at the cursor; nothing at or after `until`.
    expect([runs.reduce((sum, run) => sum + run.reviews, 0), runs.reduce((sum, run) => sum + run.added, 0)]).toEqual([16, 14]);
    // #30's review before `from` is not stored; #31's May review is, though #31 was listed at today's update.
    expect(ids(w, "2026-04")).toEqual([301]);
    expect(ids(w, "2026-05")).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 310]);
    expect(ids(w, "2026-10")).toEqual([1, 311, 2, 3, 4]); // the daily run's rows, not written again
    expect(w.state()).toEqual({ ...daily, coverageFrom: FROM });
    expect(w.progress()).toMatchObject({ schema: "osskb.github-reviews-backfill.v1", from: FROM, until: daily.coverageFrom, completedAt: expect.any(String) });
    expect(w.progress(DATAFUSION.projectId)).toMatchObject({ from: FROM, completedAt: expect.any(String) });
    expect(w.state(DATAFUSION.projectId)!.coverageFrom).toBe(FROM);

    // Done: a further call sends nothing to GitHub and writes nothing but its run record.
    const calls = w.github.calls.length;
    const puts = w.bucket.puts;
    const again = await w.backfill(FROM);
    expect(again.projects[KAFKA.projectId]).toMatchObject({ ok: true, done: true, pulls: 0, restRequests: 0, graphqlRequests: 0, monthsWritten: 0 });
    expect([w.github.calls.length - calls, w.bucket.puts - puts]).toEqual([0, 1]);
  });

  test("RV29: the backfill never moves the daily cursor, and the daily run between and after its chunks reads only its own window", async () => {
    const w = await historyAfterFirstDay();
    const daily = w.state()!;
    await w.backfill(FROM);
    expect(w.state()).toEqual(daily);
    const progress = w.bucket.objects.get(githubReviewsBackfillKey(KAFKA.projectId));

    w.github.add("kafka", 105, at(NOW + 300_000), [review(7, at(NOW + 300_000))]);
    w.advance(DAY);
    const between = (await w.run()).projects[KAFKA.projectId]!;
    expect(between).toMatchObject({ ok: true, since: new Date(Date.parse(daily.updatedAt) - 300_000).toISOString(), coverageFrom: daily.coverageFrom, added: 1 });
    expect(w.bucket.objects.get(githubReviewsBackfillKey(KAFKA.projectId))).toBe(progress);

    while (!(await w.backfill(FROM)).projects[KAFKA.projectId]!.done) w.advance(60_000);
    const cursor = w.state()!.updatedAt;
    expect(w.state()).toMatchObject({ coverageFrom: FROM, updatedAt: cursor });
    w.advance(DAY);
    expect((await w.run()).projects[KAFKA.projectId]).toMatchObject({ ok: true, coverageFrom: FROM, since: new Date(Date.parse(cursor) - 300_000).toISOString() });
    expect(w.state()!.coverageFrom).toBe(FROM);
  });

  test("RV20: months older than the daily window, written by a backfill, are kept byte-identical by later daily runs", async () => {
    const w = await historyAfterFirstDay(500);
    while (!(await w.backfill(FROM)).projects[KAFKA.projectId]!.done) w.advance(60_000);
    const old = ["2026-04", "2026-05"].map((month) => w.bucket.objects.get(githubReviewsMonthKey(KAFKA.projectId, month)));
    // #31 is reviewed again today; its May review is read again by the daily run but older than its 35-day window.
    w.github.add("kafka", 31, at(NOW + 3_600_000), [review(310, "2026-05-05T00:00:00Z", { state: "DISMISSED" }), review(311, at(NOW - 7_000_000)), review(312, at(NOW + 3_600_000))]);
    w.advance(DAY);
    expect((await w.run()).projects[KAFKA.projectId]).toMatchObject({ ok: true, added: 1 });
    expect(["2026-04", "2026-05"].map((month) => w.bucket.objects.get(githubReviewsMonthKey(KAFKA.projectId, month)))).toEqual(old);
    expect(ids(w, "2026-05")).toContain(310);
  });

  test("RV30: an item updated while the backfill lists does not push another item off a page", async () => {
    const w = world();
    for (const project of [KAFKA, DATAFUSION]) {
      w.bucket.set(githubReviewsStateKey(project.projectId), JSON.stringify({ schema: "osskb.github-reviews-state.v1", updatedAt: at(NOW), coverageFrom: at(NOW - DAY) }));
    }
    const start = Date.parse(FROM);
    for (let index = 1; index <= 250; index += 1) w.github.add("kafka", index, at(start + index * 60_000), [review(index, at(start + index * 60_000))]);
    // After the first page, #1 is updated again: it moves to the end, and every later item one place up.
    w.github.intercept = (call, count) => {
      if (call.repo === "kafka" && call.kind === "list" && count === 2) w.github.add("kafka", 1, at(NOW - 60_000), [review(1, at(start + 60_000))]);
      return undefined;
    };
    const run = (await w.backfill(FROM, false, 500)).projects[KAFKA.projectId]!;
    expect(run).toMatchObject({ ok: true, done: true, added: 250 });
    expect(new Set(w.month("2026-04")!.rows.map((row) => row.reviewId)).size).toBe(250);
    const pages = w.github.calls.filter((call) => call.repo === "kafka" && call.kind === "list").map((call) => new URL(call.url).searchParams);
    expect(pages.every((params) => params.get("page") === "1")).toBe(true);
  });

  test("RV31: without a daily cursor, or with another backfill in progress, nothing is read from GitHub and nothing is written", async () => {
    const empty = world();
    seededDay(empty);
    const none = await empty.backfill(FROM);
    expect(none).toMatchObject({ ok: false, failureKind: "source" });
    expect(none.projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "config", restRequests: 0 });
    expect(empty.github.calls).toHaveLength(0);
    expect([...empty.bucket.objects.keys()]).toEqual([GITHUB_REVIEWS_BACKFILL_LAST_RUN_KEY]);

    const w = await historyAfterFirstDay();
    await w.backfill(FROM);
    const progress = w.bucket.objects.get(githubReviewsBackfillKey(KAFKA.projectId));
    const kafkaCalls = () => w.github.calls.filter((call) => call.repo === "kafka").length;
    const calls = kafkaCalls();
    const other = (await w.backfill("2026-05-01T00:00:00.000Z")).projects[KAFKA.projectId]!;
    expect(other).toMatchObject({ ok: false, failureKind: "config" });
    expect(other.error).toContain(FROM);
    expect(kafkaCalls()).toBe(calls);
    expect(w.bucket.objects.get(githubReviewsBackfillKey(KAFKA.projectId))).toBe(progress);
  });

  test("RV31: a month or the cursor written by the daily run meanwhile is a conflict; the backfill keeps its place and the next call repairs it", async () => {
    const w = await historyAfterFirstDay(500);
    const month = githubReviewsMonthKey(KAFKA.projectId, "2026-04");
    w.bucket.beforeWriteOf.set(month, () => w.bucket.set(month, JSON.stringify({ schema: "osskb.github-reviews.v1", projectId: KAFKA.projectId, month: "2026-04", rows: [] })));
    expect((await w.backfill(FROM)).projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "conflict", done: false });
    expect(w.progress()).toBeUndefined();
    expect(w.state()!.coverageFrom).toBe("2026-10-12T22:07:00.000Z");

    // The daily tick moves the cursor while the last chunk is being written.
    const stateKey = githubReviewsStateKey(KAFKA.projectId);
    const moved = { ...w.state()!, updatedAt: at(NOW + 120_000) };
    w.bucket.beforeWriteOf.set(stateKey, () => w.bucket.set(stateKey, JSON.stringify(moved)));
    expect((await w.backfill(FROM)).projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "conflict", done: false });
    expect(w.state()).toEqual(moved);
    expect(w.progress()).toBeUndefined();

    expect((await w.backfill(FROM)).projects[KAFKA.projectId]).toMatchObject({ ok: true, done: true, added: 0 });
    expect(w.state()).toEqual({ ...moved, coverageFrom: FROM });
    expect(ids(w, "2026-04")).toEqual([301]);
  });

  test("RV31: a daily run whose cursor a finishing backfill rewrote meanwhile fails as a conflict and does not undo coverageFrom", async () => {
    const w = await historyAfterFirstDay(500);
    const stateKey = githubReviewsStateKey(KAFKA.projectId);
    w.github.add("kafka", 106, at(NOW + 60_000), []);
    w.advance(DAY);
    w.bucket.beforeWriteOf.set(stateKey, () => w.bucket.set(stateKey, JSON.stringify({ ...w.state()!, coverageFrom: FROM })));
    expect((await w.run()).projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "conflict" });
    expect(w.state()!.coverageFrom).toBe(FROM);
    expect((await w.run()).projects[KAFKA.projectId]).toMatchObject({ ok: true, coverageFrom: FROM });
    expect(w.state()).toMatchObject({ coverageFrom: FROM, updatedAt: at(NOW + 60_000) });
  });

  test("RV31: a backfill that dies after its month writes repeats the chunk without adding a row", async () => {
    const w = await historyAfterFirstDay();
    w.bucket.failPut = (key) => key === githubReviewsBackfillKey(KAFKA.projectId);
    expect((await w.backfill(FROM)).projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "internal", monthsWritten: 2 });
    w.bucket.failPut = undefined;
    const april = w.bucket.objects.get(githubReviewsMonthKey(KAFKA.projectId, "2026-04"));
    expect((await w.backfill(FROM)).projects[KAFKA.projectId]).toMatchObject({ ok: true, pulls: 5, added: 0, monthsWritten: 0, done: false });
    expect(w.bucket.objects.get(githubReviewsMonthKey(KAFKA.projectId, "2026-04"))).toBe(april);
    expect(w.progress()!.cursor).toBe(at(MAY + 13 * 3_600_000));
  });

  test("RV32: a dry backfill reads GitHub and the bucket and writes nothing", async () => {
    const w = await historyAfterFirstDay();
    const puts = w.bucket.puts;
    const run = await w.backfill(FROM, true);
    expect(run).toMatchObject({ ok: true, dryRun: true });
    expect(run.projects[KAFKA.projectId]).toMatchObject({ pulls: 5, added: 5, monthsWritten: 0, done: false });
    expect(w.bucket.puts).toBe(puts);
    expect(w.progress()).toBeUndefined();
  });

  test("RV33: one call reads at most the cap per project: 500 of 700 pull requests with 6 listing pages and 20 GraphQL requests", async () => {
    const w = world();
    for (const project of [KAFKA, DATAFUSION]) {
      w.bucket.set(githubReviewsStateKey(project.projectId), JSON.stringify({ schema: "osskb.github-reviews-state.v1", updatedAt: at(NOW), coverageFrom: at(NOW - DAY) }));
    }
    const start = Date.parse(FROM);
    for (let index = 1; index <= 700; index += 1) w.github.add("kafka", index, at(start + index * 600_000), [review(index, at(start + index * 600_000))]);
    const gets = w.bucket.gets;
    const puts = w.bucket.puts;
    const run = (await w.backfill(FROM)).projects[KAFKA.projectId]!;
    expect(run).toMatchObject({ pulls: 500, truncated: true, done: false, restRequests: 6, graphqlRequests: 20, monthsRead: 1, monthsWritten: 1, added: 500 });
    // Kafka: its cursor, its progress and one month read; the month and its progress written. DataFusion has nothing
    // since `from`, so it completes: cursor and progress read; coverageFrom and progress written. Then the run record.
    expect([w.bucket.gets - gets, w.bucket.puts - puts]).toEqual([5, 5]);
  });

  test("RV34: the backfill run record names, per project, from, until, cursor, done and the counts of the call", async () => {
    const w = await historyAfterFirstDay();
    const run = await w.backfill(FROM);
    expect(w.backfillRecord()).toEqual(run);
    expect(run).toMatchObject({ ok: true, revision: "metadata@1", dryRun: false, from: FROM });
    expect(run.projects[KAFKA.projectId]).toMatchObject({
      ok: true, from: FROM, until: "2026-10-12T22:07:00.000Z", since: FROM, cursor: at(MAY + 13 * 3_600_000), coverageFrom: "2026-10-12T22:07:00.000Z",
      pulls: 5, truncated: true, done: false, added: 5, restRequests: 1, graphqlRequests: 1,
    });
    expect(w.lastRun()!.startedAt).not.toBe(run.startedAt); // the daily run record is not replaced
    expect(JSON.stringify(run)).not.toContain("token-under-test");
  });

  test("a failed run-record write is logged through the sanitizer for the run, the backfill and the refresh", async () => {
    const w = await historyAfterFirstDay();
    const records = new Set([GITHUB_REVIEWS_LAST_RUN_KEY, GITHUB_REVIEWS_BACKFILL_LAST_RUN_KEY, GITHUB_REVIEWS_REFRESH_LAST_RUN_KEY]);
    const put = w.bucket.put.bind(w.bucket);
    w.bucket.put = async (key, body) => {
      if (records.has(key)) throw new Error(`R2 put failed: Authorization: Bearer s3cr3t.t0ken ${"Zm9v+/8=".repeat(6)}`);
      return put(key, body);
    };
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
    try {
      await w.run();
      await w.backfill(FROM);
      await w.refresh();
    } finally {
      console.error = realError;
    }
    expect(logged).toEqual([
      "Recording the review run failed: R2 put failed: Authorization: Bearer [redacted] [redacted]",
      "Recording the review backfill failed: R2 put failed: Authorization: Bearer [redacted] [redacted]",
      "Recording the review refresh failed: R2 put failed: Authorization: Bearer [redacted] [redacted]",
    ]);
  });
});

describe("Spec 022 areas (metadata@2)", () => {
  const DAY1 = NOW - 6 * 3_600_000;
  const seed = (w: ReturnType<typeof world>) => {
    w.github.add("kafka", 10, at(DAY1), [review(101, at(DAY1 - 60_000), { author: { login: "ada", __typename: "User" } })], "grace");
    w.github.add("kafka", 11, at(DAY1 + 1_000), [review(102, at(DAY1 - 30_000), { author: { login: "copilot-pull-request-reviewer", __typename: "Bot" } })], "eve");
    w.github.meta.set("kafka#10", { title: "KAFKA-10: Fix the consumer (KIP-1071, KIP-932)", labels: ["triage", "clients", "consumer", "clients"], names: { ada: "Ada Lovelace", grace: "grace" } });
    w.github.meta.set("kafka#11", { title: "MINOR: Tidy", labels: [], names: { eve: "eve@example.org" } });
  };

  test("RV36: under metadata@1 the read asks for no title, label or name, and a stored month's pulls and people are kept", async () => {
    const w = world();
    seed(w);
    const month = at(DAY1).slice(0, 7);
    const stored = { schema: "osskb.github-reviews.v1", projectId: KAFKA.projectId, month, rows: [], pulls: { "9": { labels: ["core"] } }, people: { eve: "Eve" } };
    w.bucket.set(githubReviewsMonthKey(KAFKA.projectId, month), JSON.stringify(stored));
    await w.run();
    expect(w.github.queries.some((query) => /labels|title|on User/u.test(query))).toBe(false);
    const object = w.month(month)!;
    expect(object.rows.map((row) => row.reviewId)).toEqual([101, 102]);
    expect(object.pulls).toEqual({ "9": { labels: ["core"] } });
    expect(object.people).toEqual({ eve: "Eve" });
    expect(w.lastRun()!.revision).toBe("metadata@1");
    // The metadata@1 record keeps its fields and their order: no labelsTruncated.
    expect(Object.keys(w.lastRun()!.projects[KAFKA.projectId]!)).toEqual([
      "ok", "since", "cursor", "coverageFrom", "listed", "pulls", "truncated", "reviews", "botReviews", "selfReviews", "added", "changed", "dismissed",
      "droppedPulls", "reviewsTruncated", "monthsRead", "monthsWritten", "graphqlCost", "restRequests", "graphqlRequests", "bytes", "durationMs",
    ]);
    const backfill = await w.backfill("2026-10-01");
    expect("labelsTruncated" in backfill.projects[KAFKA.projectId]!).toBe(false);
  });

  test("RV37: under metadata@2 each reviewed pull request's labels and title KIPs are stored once per month, in the same requests; no title is stored", async () => {
    const plain = world();
    seed(plain);
    await plain.run();
    const w = world({ flag: "metadata@2" });
    seed(w);
    await w.run();
    expect(w.github.count("kafka", "graphql")).toBe(plain.github.count("kafka", "graphql"));
    const object = w.month(at(DAY1).slice(0, 7))!;
    expect(object.pulls).toEqual({ "10": { labels: ["clients", "consumer", "triage"], kips: ["KIP-932", "KIP-1071"] }, "11": { labels: [] } });
    expect(object.rows.every((row) => Object.keys(row).length === 9)).toBe(true);
    const body = w.bucket.objects.get(githubReviewsMonthKey(KAFKA.projectId, at(DAY1).slice(0, 7)))!.body;
    expect(body).not.toContain("Fix the consumer");
    expect(body).not.toContain("MINOR");
    expect(w.lastRun()!.revision).toBe("metadata@2");
    expect(w.lastRun()!.projects[KAFKA.projectId]!.labelsTruncated).toBe(0);
  });

  test("RV38: a login's public name is stored once per month; an address, a name equal to the login and a bot's name are not", async () => {
    const w = world({ flag: "metadata@2" });
    seed(w);
    await w.run();
    const month = at(DAY1).slice(0, 7);
    expect(w.month(month)!.people).toEqual({ "ada": "Ada Lovelace" });
    // Read again after ada cleared her name: the name is removed.
    w.github.meta.set("kafka#10", { title: "KAFKA-10: Fix", labels: ["clients"], names: { ada: null, grace: null } });
    w.github.add("kafka", 10, at(DAY1 + 3_600_000), [review(101, at(DAY1 - 60_000))], "grace");
    w.advance(2 * 3_600_000);
    await w.run();
    expect(w.month(month)!.people).toEqual({});
    expect(w.month(month)!.pulls!["10"]).toEqual({ labels: ["clients"] });
  });

  test("RV39: a pull request reviewed in two months has its entry in both; a newer read replaces the labels in both", async () => {
    const w = world({ flag: "metadata@2" });
    w.bucket.set(githubReviewsStateKey(KAFKA.projectId), JSON.stringify({ schema: "osskb.github-reviews-state.v1", updatedAt: at(NOW - 3 * 3_600_000), coverageFrom: "2026-09-01T00:00:00.000Z" }));
    w.github.add("kafka", 20, at(NOW - 3_600_000), [review(201, "2026-09-30T23:59:00Z"), review(202, "2026-10-01T00:00:10Z")]);
    w.github.meta.set("kafka#20", { title: "KAFKA-20: x", labels: ["streams"], names: {} });
    await w.run();
    expect([w.month("2026-09")!.pulls, w.month("2026-10")!.pulls]).toEqual([{ "20": { labels: ["streams"] } }, { "20": { labels: ["streams"] } }]);
    w.github.meta.set("kafka#20", { title: "KAFKA-20: x", labels: ["streams", "tests"], names: {} });
    w.github.add("kafka", 20, at(NOW + 3_600_000), [review(201, "2026-09-30T23:59:00Z"), review(202, "2026-10-01T00:00:10Z")]);
    w.advance(2 * 3_600_000);
    const second = await w.run();
    expect(second.projects[KAFKA.projectId]).toMatchObject({ ok: true, added: 0, changed: 0, monthsWritten: 2 });
    expect([w.month("2026-09")!.pulls, w.month("2026-10")!.pulls]).toEqual([{ "20": { labels: ["streams", "tests"] } }, { "20": { labels: ["streams", "tests"] } }]);
  });

  const legacyStore = (w: ReturnType<typeof world>, count: number, projectId = KAFKA.projectId, repo = "kafka") => {
    w.bucket.set(githubReviewsStateKey(projectId), JSON.stringify({ schema: "osskb.github-reviews-state.v1", updatedAt: "2026-10-13T20:00:00Z", coverageFrom: "2026-08-01T00:00:00.000Z" }));
    const months = ["2026-08", "2026-09", "2026-10"];
    for (const [index, month] of months.entries()) {
      const rows = Array.from({ length: count }, (_, n) => ({
        reviewId: 100_000 * (index + 1) + n, pr: 1_000 * (index + 1) + n, prAuthor: "grace", reviewer: "ada", isBot: false, state: "APPROVED" as const,
        submittedAt: `${month}-02T10:00:00Z`, commit: null, inlineComments: 0,
      }));
      w.bucket.set(githubReviewsMonthKey(projectId, month), JSON.stringify({ schema: "osskb.github-reviews.v1", projectId, month, rows }));
      for (const row of rows) {
        w.github.add(repo, row.pr, "2026-10-13T00:00:00Z", [review(row.reviewId, row.submittedAt)], "grace");
        w.github.meta.set(`${repo}#${row.pr}`, { title: `KAFKA-${row.pr}: x`, labels: ["core", "triage"], names: { ada: "Ada Lovelace" } });
      }
    }
    return months;
  };

  test("RV40: the refresh fills months written before metadata@2, oldest first, the cap per call, and changes no row", async () => {
    const w = world({ flag: "metadata@2", maxPullsPerRun: 30 });
    const months = legacyStore(w, 20);
    const rowsBefore = months.map((month) => JSON.stringify(w.month(month)!.rows));
    const first = await w.refresh();
    expect(first.projects[KAFKA.projectId]).toMatchObject({ ok: true, months: 3, monthsComplete: 0, monthsWritten: 2, pullsMissing: 60, pullsRead: 30, done: false, graphqlRequests: 2 });
    expect(Object.keys(w.month("2026-08")!.pulls!)).toHaveLength(20);
    expect(Object.keys(w.month("2026-09")!.pulls!)).toHaveLength(10);
    expect(w.month("2026-10")!.pulls).toBeUndefined();
    const second = await w.refresh();
    expect(second.projects[KAFKA.projectId]).toMatchObject({ ok: true, monthsComplete: 1, pullsRead: 30, done: true });
    expect(months.map((month) => JSON.stringify(w.month(month)!.rows))).toEqual(rowsBefore);
    expect(w.month("2026-10")!.people).toEqual({ ada: "Ada Lovelace" });
    const calls = w.github.count("kafka", "graphql");
    const third = await w.refresh();
    expect(third.projects[KAFKA.projectId]).toMatchObject({ ok: true, monthsComplete: 3, monthsWritten: 0, pullsRead: 0, done: true });
    expect(w.github.count("kafka", "graphql")).toBe(calls);
    expect(w.github.count("kafka", "list")).toBe(0); // the refresh lists nothing
    expect(w.refreshRecord()).toEqual(third);
  });

  test("RV41: the refresh under metadata@1, or without a daily cursor, reads nothing; a dry call writes nothing", async () => {
    const off = world();
    legacyStore(off, 2);
    const refused = await off.refresh();
    expect(refused).toMatchObject({ ok: false, failureKind: "config" });
    expect(refused.error).toContain("metadata@2");
    expect(off.github.calls).toHaveLength(0);
    const empty = world({ flag: "metadata@2" });
    const none = await empty.refresh();
    expect(none.projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "config" });
    expect(empty.github.calls).toHaveLength(0);
    const dry = world({ flag: "metadata@2" });
    legacyStore(dry, 2);
    const puts = dry.bucket.puts;
    const result = await dry.refresh(true);
    expect(result.projects[KAFKA.projectId]).toMatchObject({ ok: true, pullsRead: 6, monthsWritten: 0 });
    expect(dry.bucket.puts).toBe(puts);
  });

  test("RV41: a month written meanwhile is a conflict the next call repairs; a pull request GitHub no longer resolves ends with no labels", async () => {
    const w = world({ flag: "metadata@2" });
    legacyStore(w, 2);
    w.github.pulls.get("kafka")!.delete(2001); // a deleted pull request
    w.bucket.beforeWriteOf.set(githubReviewsMonthKey(KAFKA.projectId, "2026-08"), () => {
      const key = githubReviewsMonthKey(KAFKA.projectId, "2026-08");
      w.bucket.set(key, w.bucket.objects.get(key)!.body);
    });
    const first = await w.refresh();
    expect(first.projects[KAFKA.projectId]).toMatchObject({ ok: false, failureKind: "conflict" });
    const second = await w.refresh();
    expect(second.projects[KAFKA.projectId]).toMatchObject({ ok: true, done: true, droppedPulls: 1 });
    expect(w.month("2026-09")!.pulls!["2001"]).toEqual({ labels: [] });
    expect((await w.refresh()).projects[KAFKA.projectId]).toMatchObject({ pullsRead: 0, done: true });
  });

  test("RV43: one refresh call reads at most 500 pull requests per project in 20 GraphQL requests; R2: the cursor and each month read, each filled month and the record written", async () => {
    const w = world({ flag: "metadata@2" });
    legacyStore(w, 240);
    legacyStore(w, 1, DATAFUSION.projectId, "datafusion");
    const gets = w.bucket.gets;
    const puts = w.bucket.puts;
    const run = await w.refresh();
    expect(run.projects[KAFKA.projectId]).toMatchObject({ pullsMissing: 720, pullsRead: 500, graphqlRequests: 20, monthsRead: 3, monthsWritten: 3, done: false });
    expect(w.bucket.gets - gets).toBe(2 * (1 + 3));
    expect(w.bucket.puts - puts).toBe(3 + 3 + 1);
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
    expect(text).toBe(JSON.stringify({ environment: "development", running: false, digest: { running: false }, reviewQueue: null, searchEmbedding: JSON.parse(text).searchEmbedding, searchQuery: JSON.parse(text).searchQuery, sreAgent: { mode: "off" }, components: JSON.parse(text).components }));
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

  test("RV26: Dev sets metadata@2 (amendment 2026-10-15) and Prod nothing; with Dev's value and an empty bucket the first tick reads one day back", async () => {
    const vars = async (environment: "development" | "production") =>
      (JSON.parse(await Bun.file(new URL(`../wrangler.${environment}.jsonc`, import.meta.url)).text()) as { vars?: Record<string, string> }).vars ?? {};
    const dev = (await vars("development")).GITHUB_REVIEWS;
    expect(dev).toBe("metadata@2");
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

  test("RV27: the backfill route needs the bearer token, the flag and a valid from; it runs while the caller waits", async () => {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const from = day(Date.now() - 30 * DAY);
    const post = (env: unknown, query: string, authorization = "Bearer manual-under-test") =>
      worker.fetch(new Request(`https://data.example/github-reviews/backfill${query}`, { method: "POST", headers: { authorization } }), env as never);

    const off = environment(undefined);
    expect((await post(off.env, `?from=${from}`, "Bearer wrong")).status).toBe(401);
    const disabled = await post(off.env, `?from=${from}`);
    expect([disabled.status, await disabled.json()]).toEqual([403, { ok: false, disabled: true }]);

    const cursor = { schema: "osskb.github-reviews-state.v1", updatedAt: new Date(Date.now() - 3_600_000).toISOString(), coverageFrom: new Date(Date.now() - DAY).toISOString() };
    const on = environment("metadata@1", Object.fromEntries(githubReviewsProjects.map((project) => [githubReviewsStateKey(project.projectId), cursor])));
    for (const query of ["", "?from=yesterday", `?from=${day(Date.now() - 400 * DAY)}`]) {
      const refused = await post(on.env, query);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ ok: false });
    }
    expect(on.outbound).toEqual([]);
    expect(on.operations).toEqual([]);

    const dry = await post(on.env, `?from=${from}&dryRun=1`);
    expect(dry.status).toBe(200);
    expect(on.operations.filter((operation) => operation.startsWith("put "))).toEqual([]);
    const response = await post(on.env, `?from=${from}`);
    const body = await response.json() as GithubReviewsBackfillLastRun;
    expect([response.status, body.ok, body.from]).toEqual([200, true, `${from}T00:00:00.000Z`]);
    expect(Object.values(body.projects).map((project) => project.done)).toEqual([true, true]);
    expect(on.outbound.filter((url) => url.startsWith("https://api.github.com/repos/")).every((url) => new URL(url).searchParams.get("since") === `${from}T00:00:00.000Z`)).toBe(true);
    expect(on.operations).toContain(`put ${GITHUB_REVIEWS_BACKFILL_LAST_RUN_KEY}`);
    expect(on.operations).not.toContain(`put ${GITHUB_REVIEWS_LAST_RUN_KEY}`);
  });

  test("RV34: with the flag set /health carries the backfill record as githubReviewsBackfill, null before the first call; unset, no field", async () => {
    const record = { ok: true, from: "2026-04-14T00:00:00.000Z", projects: {} };
    const withRun = environment("metadata@1", { [GITHUB_REVIEWS_BACKFILL_LAST_RUN_KEY]: record });
    const body = await (await worker.fetch(new Request("https://data.example/health"), withRun.env as never)).json() as Record<string, unknown>;
    expect(body.githubReviewsBackfill).toEqual(record);
    expect(body.githubReviews).toBeNull();
    const before = await (await worker.fetch(new Request("https://data.example/health"), environment("metadata@1").env as never)).json() as Record<string, unknown>;
    expect("githubReviewsBackfill" in before && before.githubReviewsBackfill === null).toBe(true);
    const off = await (await worker.fetch(new Request("https://data.example/health"), environment(undefined).env as never)).text();
    expect(off).not.toContain("githubReviewsBackfill");
  });

  test("RV42: the refresh route needs the bearer token and the flag; /health carries githubReviewsRefresh under metadata@2 only", async () => {
    const post = (env: unknown, token = "manual-under-test") => worker.fetch(new Request("https://data.example/github-reviews/refresh-areas", { method: "POST", headers: { authorization: `Bearer ${token}` } }), env as never);
    expect((await post(environment("metadata@2").env, "wrong")).status).toBe(401);
    expect((await post(environment(undefined).env)).status).toBe(403);
    const v1 = await post(environment("metadata@1").env);
    expect([v1.status, (await v1.json() as { failureKind: string }).failureKind]).toEqual([502, "config"]);
    const record = { ok: true, projects: {} };
    const on = await (await worker.fetch(new Request("https://data.example/health"), environment("metadata@2", { [GITHUB_REVIEWS_REFRESH_LAST_RUN_KEY]: record }).env as never)).json() as Record<string, unknown>;
    expect(on.githubReviewsRefresh).toEqual(record);
    const before = await (await worker.fetch(new Request("https://data.example/health"), environment("metadata@2").env as never)).json() as Record<string, unknown>;
    expect("githubReviewsRefresh" in before && before.githubReviewsRefresh === null).toBe(true);
    const v1Health = await (await worker.fetch(new Request("https://data.example/health"), environment("metadata@1").env as never)).text();
    expect(v1Health).not.toContain("githubReviewsRefresh");
  });

  test("RV7: every GitHub project is ingested, with its machine users", () => {
    expect(githubReviewsProjects.map((project) => [project.projectId, project.owner, project.repo])).toEqual([["apache-kafka", "apache", "kafka"], ["apache-datafusion", "apache", "datafusion"]]);
    expect(githubReviewsProjects.find((project) => project.projectId === "apache-datafusion")!.machineUsers).toContain("codecov-commenter");
  });
});
