/**
 * Spec 019 amendment (8): the `identity-backfill` job and the identity-link job's reader behind
 * `IDENTITY_LINKS_BACKFILL` (W113–W127, W130). Rows come from `identity-backfill.cases.ts`.
 * GitHub and Jira are stubs: the core run gets a stub `fetch`, the Worker paths a stubbed
 * `globalThis.fetch` that throws on any host it does not expect. Nothing reaches upstream.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeIdentityLinks,
  encodeActivityMonth,
  IDENTITY_LINKS_LAST_RUN_KEY,
  IdentityFacts,
  identityLinksKey,
  KAFKA_IDENTITY_PROFILE,
  parseActivityMonth,
  PEOPLE_ACTIVITY_SCHEMA,
  PEOPLE_ACTIVITY_STATE_SCHEMA,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  type ActivityMonthV1,
  type ActivityThreadV1,
  type PeopleIdentityProfile,
} from "@oss-knowledge-base/reference-pipeline";
import {
  addMonths,
  backfillMonth,
  IDENTITY_BACKFILL_BUDGET,
  IDENTITY_BACKFILL_LAST_RUN_KEY,
  identityBackfillMonthKey,
  identityBackfillPrefix,
  KAFKA_IDENTITY_BACKFILL,
  monthSearchQuery,
  runIdentityBackfill,
  type IdentityBackfillRecordV1,
  type SearchNode,
} from "@oss-knowledge-base/reference-pipeline/identity-backfill";
import { readPersonProfile, suppressionDigest, type PeopleBucket } from "@oss-knowledge-base/reference-pipeline/people";
import { SOURCE_USER_AGENT } from "@oss-knowledge-base/reference-pipeline";

import worker from "../src/index";
import { IDENTITY_BACKFILL_WALL_MS } from "../src/identity-backfill/run";
import { runIdentityLinks, type IdentityLinksRecord } from "../src/identity-links/run";
import { WALL_BUDGET_MS } from "../src/signals/profile";
import { testPlanRows } from "./identity-backfill.cases";

const KAFKA = "apache-kafka";
const PROFILE = KAFKA_IDENTITY_BACKFILL;
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/identity-backfill/upstream-2026-10-23.json"), "utf8")) as {
  readonly pulls: Readonly<Record<string, readonly { readonly number: number; readonly title: string; readonly createdAt: string; readonly author: string | null }[]>>;
  readonly jira: Readonly<Record<string, { readonly assignee: string | null; readonly display: string | null; readonly status: string }>>;
  readonly accountIssues: Readonly<Record<string, string>>;
  readonly accountDisplays: Readonly<Record<string, string>>;
  readonly keyPulls: Readonly<Record<string, readonly (readonly [string | null, number])[]>>;
};
const NOW = Date.parse("2026-10-23T01:23:00.000Z");
const COVERAGE = "2026-09-10T02:45:16.000Z";
const BACKFILL_CRON = "23 1 * * *";
const JIRA = "https://issues.apache.org/jira/";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---- the stub upstream ---------------------------------------------------------------------------

const node = (number: number, title: string, createdAt: string, login: string | null = "m1a2st", type = "User"): SearchNode => ({
  number, title, createdAt, url: `https://github.com/apache/kafka/pull/${number}`, author: login === null ? null : { __typename: type, login },
});

type Answer = Response | (() => Response) | Error;
interface Sent { readonly kind: "github" | "jira"; readonly url: string; readonly init: RequestInit; readonly at: number; readonly keys: readonly string[]; readonly after: string | null; readonly q: string | null }

/**
 * GitHub answers the month's nodes 100 a page (cursor = page index), Jira answers each asked key from
 * `assignees` (absent keys left out). `override` replaces the n-th request's answer (1-based, both hosts).
 */
class Upstream {
  readonly sent: Sent[] = [];
  readonly timeouts: number[] = [];
  clock = NOW;
  issueCount?: number;
  hasNextPage?: (page: number) => boolean;
  remaining = 4_800;
  readonly override = new Map<number, Answer>();
  constructor(public nodes: readonly SearchNode[] = [], public assignees: Readonly<Record<string, unknown>> = {}) {}

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const github = url.startsWith("https://api.github.com/");
    const request = github ? JSON.parse(String(init.body)) as { query: string; variables: { q: string; after: string | null } } : undefined;
    const keys = github ? [] : (/key in \(([^)]*)\)/u.exec(new URL(url).searchParams.get("jql") ?? "")?.[1] ?? "").split(",").filter((key) => key !== "");
    this.sent.push({ kind: github ? "github" : "jira", url, init, at: this.clock, keys, after: request?.variables.after ?? null, q: request?.variables.q ?? null });
    this.clock += 400;
    const override = this.override.get(this.sent.length);
    if (override instanceof Error) throw override;
    if (override !== undefined) return typeof override === "function" ? override() : override;
    if (github) {
      const page = request!.variables.after === null ? 0 : Number(request!.variables.after);
      const slice = this.nodes.slice(page * 100, page * 100 + 100);
      const more = this.hasNextPage?.(page + 1) ?? (page + 1) * 100 < this.nodes.length;
      return Response.json({ data: {
        rateLimit: { remaining: this.remaining, resetAt: "2026-10-23T02:00:00Z" },
        search: { issueCount: this.issueCount ?? this.nodes.length, pageInfo: { hasNextPage: more, endCursor: String(page + 1) }, nodes: slice },
      } });
    }
    return Response.json({ issues: keys.filter((key) => key in this.assignees).map((key) => ({ key, fields: { assignee: this.assignees[key] } })) });
  };

  count(kind: "github" | "jira") {
    return this.sent.filter((call) => call.kind === kind).length;
  }
}

class MemoryBucket {
  readonly objects = new Map<string, string>();
  readonly operations: string[] = [];
  failGet?: (key: string) => boolean;
  failPut?: (key: string) => boolean;
  async get(key: string) {
    this.operations.push(`get ${key}`);
    if (this.failGet?.(key) === true) throw new Error(`injected R2 failure at ${key}`);
    return this.objects.get(key);
  }
  async put(key: string, body: string) {
    this.operations.push(`put ${key}`);
    if (this.failPut?.(key) === true) throw new Error(`injected R2 failure at ${key}`);
    this.objects.set(key, body);
  }
  count(verb: "get" | "put") {
    return this.operations.filter((operation) => operation.startsWith(`${verb} `)).length;
  }
}

const stateBody = (coverageFrom = COVERAGE, months: readonly string[] = ["2026-09", "2026-10"]) => JSON.stringify({
  schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: coverageFrom, coverageFrom, updatedAt: "2026-10-22T22:07:00.000Z", months,
});

function recordBody(done: readonly string[], lastRun: Partial<IdentityBackfillRecordV1["lastRun"]> | null = null): string {
  return JSON.stringify({ revision: "prs@1", lastRun, months: { done, next: null, remaining: 0 }, from: null, until: null });
}

function store(done?: readonly string[], options: { readonly coverageFrom?: string; readonly lastRun?: Partial<IdentityBackfillRecordV1["lastRun"]> | null } = {}) {
  const bucket = new MemoryBucket();
  bucket.objects.set(peopleActivityStateKey(KAFKA), stateBody(options.coverageFrom));
  if (done !== undefined) bucket.objects.set(IDENTITY_BACKFILL_LAST_RUN_KEY, recordBody(done, options.lastRun ?? null));
  return bucket;
}

async function backfill(bucket: MemoryBucket, upstream: Upstream, options: { readonly flag?: string; readonly manual?: boolean; readonly deadline?: number; readonly token?: string } = {}) {
  return runIdentityBackfill({
    flag: options.flag ?? "prs@1",
    profile: PROFILE,
    bucket,
    githubToken: options.token ?? "token-under-test",
    fetch: upstream.fetch,
    now: () => upstream.clock,
    delay: async (ms) => {
      upstream.clock += ms;
    },
    timeout: (ms) => {
      upstream.timeouts.push(ms);
      return new AbortController().signal;
    },
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    manual: options.manual === true,
    log: () => undefined,
  });
}

const storedRecord = (bucket: MemoryBucket) => JSON.parse(bucket.objects.get(IDENTITY_BACKFILL_LAST_RUN_KEY)!) as IdentityBackfillRecordV1;
const storedMonth = (bucket: MemoryBucket, month: string) => parseActivityMonth(JSON.parse(bucket.objects.get(identityBackfillMonthKey(KAFKA, month))!), KAFKA, month);
const jiraUser = (key: string, display: string) => ({
  self: `https://issues.apache.org/jira/rest/api/2/user?username=${key}`, key, name: "constructed-account-name", displayName: display,
  timeZone: "Constructed/Zone", active: true, emailAddress: "constructed@example.invalid", avatarUrls: { "48x48": "https://issues.apache.org/jira/secure/useravatar?constructed=1" },
});

/** `n` keyed pull requests in 2026-09, `keys` distinct keys among them. */
function septemberNodes(n: number, keys = n): SearchNode[] {
  return Array.from({ length: n }, (_, index) => node(1000 + index, `KAFKA-${20000 + (index % keys)}: change ${index}`, `2026-09-${String(1 + (index % 28)).padStart(2, "0")}T10:00:00Z`));
}

// ---- the recorded sample as activity months ------------------------------------------------------

const recordedAssignee = (key: string): { key: string; display: string } | null | undefined => {
  if (key in FIXTURE.accountIssues) return { key: FIXTURE.accountIssues[key]!, display: FIXTURE.accountDisplays[FIXTURE.accountIssues[key]!]! };
  const entry = FIXTURE.jira[key];
  if (entry === undefined) return undefined;
  return entry.assignee === null ? null : { key: entry.assignee, display: entry.display! };
};

/** The recorded assignee of every key the nodes' titles name (keys Jira did not answer are left out). */
function assigneesFor(nodes: readonly SearchNode[]): Map<string, { key: string; display: string } | null> {
  const map = new Map<string, { key: string; display: string } | null>();
  for (const item of nodes) {
    for (const match of item.title.matchAll(/\bKAFKA-?(\d+)\b/giu)) {
      const key = `KAFKA-${match[1]}`;
      const assignee = recordedAssignee(key);
      if (assignee !== undefined) map.set(key, assignee);
    }
  }
  return map;
}

/** The sample's pull requests as search nodes, by creation month. */
function recordedNodes(filter: (pull: { createdAt: string }) => boolean = () => true): Map<string, SearchNode[]> {
  const byMonth = new Map<string, SearchNode[]>();
  for (const [login, pulls] of Object.entries(FIXTURE.pulls)) {
    for (const pull of pulls) {
      if (!filter(pull)) continue;
      const month = pull.createdAt.slice(0, 7);
      (byMonth.get(month) ?? byMonth.set(month, []).get(month)!).push(node(pull.number, pull.title, pull.createdAt, pull.author ?? login));
    }
  }
  return byMonth;
}

/** Log-shaped months (rows and people as the log keeps them) holding pull requests and Jira assignees. */
function logMonth(month: string, nodes: readonly SearchNode[], assignees: ReadonlyMap<string, { key: string; display: string } | null>): ActivityMonthV1 {
  const threads: Record<string, ActivityThreadV1> = {};
  const rows: ActivityMonthV1["rows"][number][] = [];
  const people: Record<string, string> = {};
  for (const item of nodes) {
    const author = `github:${item.author!.login.toLowerCase()}`;
    threads[`KAFKA-PR-${item.number}`] = { source: "github", kind: "pull-request", title: item.title, url: item.url, author, labels: [], kips: [] };
    rows.push({ id: `kafka:github:pull:${item.number}`, source: "github", kind: "pull-request", person: author, thread: `KAFKA-PR-${item.number}`, at: item.createdAt });
    people[author] = item.author!.login;
  }
  for (const [key, assignee] of assignees) {
    threads[key] = { source: "jira", kind: "issue", title: `${key}: summary`, url: `https://issues.apache.org/jira/browse/${key}`, author: null, labels: [], kips: [], reporter: null, assignee };
  }
  return parseActivityMonth(JSON.parse(encodeActivityMonth({ schema: PEOPLE_ACTIVITY_SCHEMA, projectId: KAFKA, month, people, threads, rows })), KAFKA, month);
}

const jiraOnly = (month: string, entries: Readonly<Record<string, string>>, store: "log" | "backfill") => {
  const threads: Record<string, ActivityThreadV1> = {};
  for (const [key, account] of Object.entries(entries)) {
    threads[key] = { source: "jira", kind: "issue", title: store === "log" ? `${key}: summary` : key, url: `https://issues.apache.org/jira/browse/${key}`, author: null, labels: [], kips: [], reporter: null, assignee: { key: account, display: account } };
  }
  return { schema: PEOPLE_ACTIVITY_SCHEMA, projectId: KAFKA, month, people: {}, threads, rows: [] } as ActivityMonthV1;
};

// ---- the identity-link job over both stores --------------------------------------------------------

const LINKS_PROFILE: PeopleIdentityProfile = { ...KAFKA_IDENTITY_PROFILE, identityLinks: [], roster: null };
let linksClock = Date.parse("2026-10-23T02:17:00.000Z");

function linksBucket(logMonths: readonly ActivityMonthV1[], backfillMonths: readonly ActivityMonthV1[] = [], done?: readonly string[]) {
  const bucket = new MemoryBucket();
  bucket.objects.set(peopleActivityStateKey(KAFKA), stateBody(COVERAGE, logMonths.map((month) => month.month)));
  for (const month of logMonths) bucket.objects.set(peopleActivityMonthKey(KAFKA, month.month), encodeActivityMonth(month));
  for (const month of backfillMonths) bucket.objects.set(identityBackfillMonthKey(KAFKA, month.month), encodeActivityMonth(month));
  if (done !== undefined) bucket.objects.set(IDENTITY_BACKFILL_LAST_RUN_KEY, recordBody(done));
  return bucket;
}

function links(bucket: MemoryBucket, backfillFlag?: string, options: { readonly dryRun?: boolean } = {}) {
  return runIdentityLinks({
    flag: "corroborated@1", backfillFlag, bucket, profiles: [LINKS_PROFILE], bots: () => [], suppressed: {}, digest: suppressionDigest,
    now: () => linksClock, dryRun: options.dryRun === true,
  });
}

const table = (bucket: MemoryBucket) => bucket.objects.get(identityLinksKey(KAFKA));
const linkOf = (body: string | undefined, a: string, b: string) => (JSON.parse(body ?? "{\"people\":[]}") as { people: { links: { a: string; b: string; basis: string; evidence: unknown[] }[] }[] })
  .people.flatMap((person) => person.links).find((link) => link.a === a && link.b === b);

function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  for (let month = from; month <= to; month = addMonths(month, 1)) months.push(month);
  return months;
}

// ---- the Worker environment --------------------------------------------------------------------------

function environment(options: { readonly flag?: string; readonly fetch?: "empty" | "throws"; readonly failPuts?: boolean; readonly failGets?: boolean; readonly stored?: Record<string, string>; readonly extra?: Record<string, string> } = {}) {
  const bucketCalls: string[] = [];
  const objects = new Map(Object.entries(options.stored ?? {}));
  const jobs: string[] = [];
  const outbound: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    outbound.push(url);
    if (options.fetch === "throws") throw new Error("upstream is down");
    if (url === "https://api.github.com/graphql") {
      return Response.json({ data: { rateLimit: { remaining: 4800, resetAt: "2026-10-23T02:00:00Z" }, search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const object = (name: string, body: unknown) => ({
    idFromName: (id: string) => id,
    get: () => ({
      fetch: async (url: string, init?: RequestInit) => {
        jobs.push(`${name} ${init?.method ?? "GET"} ${url}`);
        return Response.json(body, { status: url.endsWith("/run") ? 202 : 200 });
      },
    }),
  });
  const env = {
    PUBLICATION_ENVIRONMENT: "development",
    MANUAL_TRIGGER_TOKEN: "manual-under-test",
    GITHUB_SOURCE_TOKEN: "token-under-test",
    IDENTITY_BACKFILL_CRON: BACKFILL_CRON,
    IDENTITY_LINKS_CRON: "17 2 * * *",
    DIGEST_CRON: "47 22 * * *",
    PIPELINE_STATE: object("publication", { environment: "development", running: false }),
    DIGEST_RUN: object("digest", { running: false }),
    OSS_KB_BUCKET: {
      get: async (key: string) => {
        bucketCalls.push(`get ${key}`);
        if (options.failGets === true) throw new Error("R2 get failed");
        const body = objects.get(key);
        return body === undefined ? null : { text: async () => body, json: async () => JSON.parse(body) };
      },
      put: async (key: string, body: string) => {
        bucketCalls.push(`put ${key}`);
        if (options.failPuts === true) throw new Error("R2 put failed");
        objects.set(key, body);
        return {};
      },
    },
    ...(options.flag === undefined ? {} : { IDENTITY_BACKFILL: options.flag }),
    ...options.extra,
  };
  const tick = async (cron: string) => {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron, scheduledTime: Date.now() } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
    await Promise.all(pending);
  };
  const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://data.example${path}`, init), env as never);
  return { env, bucketCalls, objects, jobs, outbound, tick, request };
}

const post = (token?: string) => ({ method: "POST", ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }) });
const BACKFILL_KEYS = (key: string) => key === IDENTITY_BACKFILL_LAST_RUN_KEY || key.startsWith(identityBackfillPrefix(KAFKA));

// ---- the executable rows ---------------------------------------------------------------------------

const checks: Record<string, () => Promise<void> | void> = {
  "W113 keyed pull requests kept": () => {
    const pulls = FIXTURE.pulls.m1a2st!;
    expect(pulls.length).toBe(91);
    let kept = 0;
    const threads: Record<string, ActivityThreadV1> = {};
    for (const [month, nodes] of recordedNodes((pull) => pulls.includes(pull as never))) {
      const result = backfillMonth(PROFILE, month, nodes, new Map());
      for (const [key, thread] of Object.entries(result.threads)) {
        threads[key] = thread;
        kept += 1;
      }
    }
    expect([kept, pulls.length - kept]).toEqual([58, 33]);
    expect(Object.keys(threads).every((key) => /^KAFKA-PR-\d+$/u.test(key))).toBe(true);
    expect(new Set(Object.values(threads).map((thread) => thread.author))).toEqual(new Set(["github:m1a2st"]));
    expect(Object.values(threads).every((thread) => thread.labels.length === 0 && thread.source === "github" && thread.kind === "pull-request")).toBe(true);
    // A MINOR pull request is not stored.
    expect(threads["KAFKA-PR-23881"]).toBeUndefined();
    expect(threads["KAFKA-PR-23879"]?.title).toBe("KAFKA-19042 Rewrite TransactionsBounceTest from Scala to Java");
  },
  "W113 hyphenless key": async () => {
    const upstream = new Upstream([node(1, "KAFKA1234 fix", "2026-09-05T00:00:00Z"), node(2, "Kafka 4.2.0 release", "2026-09-06T00:00:00Z")], { "KAFKA-1234": null });
    const bucket = store();
    await backfill(bucket, upstream);
    const month = storedMonth(bucket, "2026-09");
    expect(Object.keys(month.threads).sort()).toEqual(["KAFKA-1234", "KAFKA-PR-1"]);
    expect(upstream.sent.find((call) => call.kind === "jira")!.keys).toEqual(["KAFKA-1234"]);
  },
  "W113 bot and deleted author": () => {
    const month = backfillMonth(PROFILE, "2026-09", [
      node(1, "KAFKA-1 bump", "2026-09-01T00:00:00Z", "dependabot", "Bot"),
      node(2, "KAFKA-2 fix", "2026-09-02T00:00:00Z", null),
      node(3, "KAFKA-3 fix", "2026-09-03T00:00:00Z", "M1A2ST"),
    ], new Map());
    expect(["KAFKA-PR-1", "KAFKA-PR-2", "KAFKA-PR-3"].map((key) => month.threads[key]?.author)).toEqual([null, null, "github:m1a2st"]);
  },
  "W113 month boundary": async () => {
    const upstream = new Upstream([node(1, "KAFKA-1 late", "2026-08-31T23:59:59Z"), node(2, "KAFKA-2 early", "2026-09-01T00:00:00Z")], { "KAFKA-1": null, "KAFKA-2": null });
    const bucket = store();
    await backfill(bucket, upstream);
    expect(Object.keys(storedMonth(bucket, "2026-09").threads).sort()).toEqual(["KAFKA-2", "KAFKA-PR-2"]);
    expect(upstream.sent[0]!.q).toBe("repo:apache/kafka is:pr created:2026-09-01T00:00:00+00:00..2026-09-30T23:59:59+00:00 sort:created-asc");
    expect(monthSearchQuery(PROFILE, "2026-02")).toContain("2026-02-28T23:59:59+00:00");
  },
  "W114 assignee kept, nothing else": async () => {
    const keys = Object.keys(FIXTURE.jira).slice(0, 50);
    const nodes = keys.map((key, index) => node(100 + index, `${key}: change`, "2026-09-15T00:00:00Z"));
    const assignees = Object.fromEntries(keys.map((key) => {
      const entry = FIXTURE.jira[key]!;
      return [key, entry.assignee === null ? null : jiraUser(entry.assignee, entry.display!)];
    }));
    const upstream = new Upstream(nodes, assignees);
    upstream.fetch = ((original) => async (url: string, init: RequestInit) => {
      const response = await original(url, init);
      if (!url.startsWith(JIRA)) return response;
      // The recorded answer carried `status` too (the Example asked for `assignee,status`).
      const body = await response.json() as { issues: { key: string; fields: Record<string, unknown> }[] };
      for (const issue of body.issues) issue.fields.status = { name: FIXTURE.jira[issue.key]!.status };
      return Response.json(body);
    })(upstream.fetch);
    const bucket = store();
    await backfill(bucket, upstream);
    const month = storedMonth(bucket, "2026-09");
    for (const key of keys) {
      const entry = FIXTURE.jira[key]!;
      expect(month.threads[key]).toEqual({
        source: "jira", kind: "issue", title: key, url: `https://issues.apache.org/jira/browse/${key}`, author: null, labels: [], kips: [], reporter: null,
        assignee: entry.assignee === null ? null : { key: entry.assignee, display: entry.display! },
      });
    }
    const body = bucket.objects.get(identityBackfillMonthKey(KAFKA, "2026-09"))!;
    for (const forbidden of ["Resolved", "status", "constructed-account-name", "Constructed/Zone", "avatarUrls", "useravatar", "emailAddress", "constructed@example.invalid", "\"active\""]) expect(body).not.toContain(forbidden);
    // Positive control: the account keys are there.
    expect(body).toContain("JIRAUSER305187");
    expect(new URL(upstream.sent.find((call) => call.kind === "jira")!.url).searchParams.get("fields")).toBe("assignee");
  },
  "W114 unassigned and missing key": async () => {
    const upstream = new Upstream([node(1, "KAFKA-1 a", "2026-09-02T00:00:00Z"), node(2, "KAFKA-2 b", "2026-09-03T00:00:00Z")], { "KAFKA-1": null });
    const bucket = store();
    await backfill(bucket, upstream);
    const month = storedMonth(bucket, "2026-09");
    expect(month.threads["KAFKA-1"]?.assignee).toBeNull();
    expect(month.threads["KAFKA-2"]).toBeUndefined();
    expect(month.threads["KAFKA-PR-2"]).toBeDefined();
    expect(storedRecord(bucket).lastRun).toMatchObject({ keys: 2, assigned: 0 });
  },
  "W114 batching": async () => {
    const upstream = new Upstream(septemberNodes(222), {});
    const bucket = store();
    await backfill(bucket, upstream);
    const jira = upstream.sent.filter((call) => call.kind === "jira");
    expect(jira.map((call) => call.keys.length)).toEqual([100, 100, 22]);
    const params = new URL(jira[0]!.url).searchParams;
    expect([params.get("fields"), params.get("validateQuery"), params.get("maxResults")]).toEqual(["assignee", "warn", "100"]);
    expect(storedRecord(bucket).lastRun).toMatchObject({ status: "ok", requests: { github: 3, jira: 3 }, keys: 222 });
  },
  "W114 moved issue": async () => {
    const upstream = new Upstream([node(1, "KAFKA-10 a", "2026-09-02T00:00:00Z")]);
    upstream.override.set(2, Response.json({ issues: [{ key: "KAFKA-20", fields: { assignee: jiraUser("JIRAUSER1", "Someone") } }] }));
    const bucket = store();
    await backfill(bucket, upstream);
    const month = storedMonth(bucket, "2026-09");
    expect(["KAFKA-10", "KAFKA-20"].map((key) => key in month.threads)).toEqual([false, false]);
  },
  "W115 newest first": async () => {
    const upstream = new Upstream();
    const bucket = store();
    await backfill(bucket, upstream);
    expect(upstream.sent[0]!.q).toContain("created:2026-09-01");
    const record = storedRecord(bucket);
    expect(record.months).toEqual({ done: ["2026-09"], next: "2026-08", remaining: 10 });
    expect([record.from, record.until, record.lastRun?.month]).toEqual(["2025-11", "2026-09", "2026-09"]);
  },
  "W115 resume": async () => {
    const upstream = new Upstream();
    const bucket = store(["2026-08", "2026-09"]);
    await backfill(bucket, upstream);
    expect(upstream.sent.map((call) => /created:(\d{4}-\d{2})/u.exec(call.q!)![1])).toEqual(["2026-07"]);
    expect(storedRecord(bucket).months).toEqual({ done: ["2026-07", "2026-08", "2026-09"], next: "2026-06", remaining: 8 });
  },
  "W115 horizon moved": async () => {
    const upstream = new Upstream();
    upstream.clock = Date.parse("2026-11-05T01:23:00Z");
    const bucket = store(monthsBetween("2025-12", "2026-09"));
    await backfill(bucket, upstream);
    expect(upstream.sent).toEqual([]);
    expect(storedRecord(bucket)).toMatchObject({ months: { next: null, remaining: 0 }, from: "2025-12", until: "2026-09", lastRun: { status: "complete", ok: true } });
    expect(bucket.objects.has(identityBackfillMonthKey(KAFKA, "2025-11"))).toBe(false);
  },
  "W115 complete": async () => {
    const upstream = new Upstream();
    const bucket = store(monthsBetween("2025-11", "2026-09"));
    await backfill(bucket, upstream);
    expect(upstream.sent).toEqual([]);
    expect(storedRecord(bucket).lastRun).toMatchObject({ status: "complete", r2: { classA: 1, classB: 2 } });
    expect(bucket.count("put")).toBe(1);
    const before = bucket.operations.length;
    upstream.clock += 86_400_000;
    const second = await backfill(bucket, upstream);
    expect(second.skipped).toBe("complete");
    expect(upstream.sent).toEqual([]);
    expect(bucket.operations.slice(before).filter((operation) => operation.startsWith("put "))).toEqual([]);
  },
  "W115 month before record": async () => {
    const upstream = new Upstream([node(1, "KAFKA-1 a", "2026-09-02T00:00:00Z")], { "KAFKA-1": null });
    const bucket = store();
    await backfill(bucket, upstream);
    expect(bucket.operations.filter((operation) => operation.startsWith("put "))).toEqual([`put ${identityBackfillMonthKey(KAFKA, "2026-09")}`, `put ${IDENTITY_BACKFILL_LAST_RUN_KEY}`]);
    expect([bucket.count("get"), bucket.count("put")]).toEqual([2, 2]);
    expect(storedRecord(bucket).lastRun?.r2).toEqual({ classA: 2, classB: 2 });
  },
  "W116 reader off": async () => {
    const log = [logMonth("2026-09", [node(1, "KAFKA-1 a", "2026-09-20T00:00:00Z", "x")], new Map([["KAFKA-1", { key: "A", display: "A" }]])), logMonth("2026-10", [], new Map())];
    const backfillMonths = [jiraOnly("2026-08", { "KAFKA-1": "Z" }, "backfill"), backfillMonth(PROFILE, "2026-08", [node(2, "KAFKA-2 b", "2026-08-02T00:00:00Z", "x")], new Map([["KAFKA-2", { key: "A", display: "A" }]]))];
    const without = linksBucket(log);
    await links(without);
    const withStore = linksBucket(log, [backfillMonths[1]!], ["2026-08", "2026-09"]);
    const record = await links(withStore);
    expect(table(withStore)).toBe(table(without)!);
    expect(withStore.operations.filter((operation) => BACKFILL_KEYS(operation.slice(4)))).toEqual([]);
    expect("backfill" in record.lastRun.inputs).toBe(false);
    // Positive control: with the flag the same bucket's store is read.
    await links(withStore, "read");
    expect(withStore.operations.filter((operation) => BACKFILL_KEYS(operation.slice(4))).length).toBeGreaterThan(0);
  },
  "W116 reader flag not read": async () => {
    const log = [logMonth("2026-09", [node(1, "KAFKA-1 a", "2026-09-20T00:00:00Z", "x")], new Map([["KAFKA-1", { key: "A", display: "A" }]])), logMonth("2026-10", [], new Map())];
    const store = [backfillMonth(PROFILE, "2026-08", [node(2, "KAFKA-2 b", "2026-08-02T00:00:00Z", "x")], new Map([["KAFKA-2", { key: "A", display: "A" }]]))];
    const without = linksBucket(log);
    await links(without);
    // Blank is unset (as for every flag of this Worker): the store is not read and the table is the same.
    const blank = linksBucket(log, store, ["2026-08", "2026-09"]);
    expect((await links(blank, "  ")).lastRun.ok).toBe(true);
    expect(table(blank)).toBe(table(without)!);
    expect(blank.operations.filter((operation) => BACKFILL_KEYS(operation.slice(4)))).toEqual([]);
    for (const value of ["off", "on", "Read", "yes please"]) {
      const bucket = linksBucket(log, store, ["2026-08", "2026-09"]);
      bucket.objects.set(identityLinksKey(KAFKA), "last good table");
      const record = await links(bucket, value);
      expect(record.lastRun.ok).toBe(false);
      expect(record.lastRun.error).toContain(`IDENTITY_LINKS_BACKFILL "${value}" is not supported`);
      expect(table(bucket)).toBe("last good table");
      expect(bucket.operations.filter((operation) => operation.startsWith("put ") && operation.slice(4) === identityLinksKey(KAFKA))).toEqual([]);
      expect(bucket.operations.filter((operation) => BACKFILL_KEYS(operation.slice(4)))).toEqual([]);
    }
    // Positive control: "read" on the same layout reads the store.
    const read = linksBucket(log, store, ["2026-08", "2026-09"]);
    await links(read, "read");
    expect(read.operations.filter((operation) => BACKFILL_KEYS(operation.slice(4))).length).toBeGreaterThan(0);
  },
  "W116 reader on (positive control)": async () => {
    const split = (pull: { createdAt: string }) => pull.createdAt < COVERAGE;
    const before = recordedNodes((pull) => split(pull) && pull.createdAt >= "2025-11-01");
    const after = recordedNodes((pull) => !split(pull));
    const backfillMonths = [...before].map(([month, nodes]) => backfillMonth(PROFILE, month, nodes, assigneesFor(nodes)));
    const log = ["2026-09", "2026-10"].map((month) => logMonth(month, after.get(month) ?? [], assigneesFor(after.get(month) ?? [])));
    const done = monthsBetween("2025-11", "2026-09");
    const off = linksBucket(log, backfillMonths, done);
    await links(off);
    const offLink = linkOf(table(off), "github:m1a2st", "jira-account:JIRAUSER305187");
    expect(offLink === undefined || offLink.evidence.length < 22).toBe(true);
    const on = linksBucket(log, backfillMonths, done);
    const record = await links(on, "read");
    expect(linkOf(table(on), "github:m1a2st", "jira-account:JIRAUSER305187")).toMatchObject({ basis: "corroborated" });
    expect(linkOf(table(on), "github:m1a2st", "jira-account:JIRAUSER305187")!.evidence.length).toBeGreaterThanOrEqual(19);
    expect(record.lastRun.inputs.backfill).toEqual({ months: done, until: "2026-09" });
    expect(record.lastRun.ok).toBe(true);
  },
  "W116 same month in both stores": async () => {
    const pulls = (month: string, keys: readonly number[]) => keys.map((key) => node(key, `KAFKA-${key} x`, `${month}-12T00:00:00Z`, "x"));
    const logSeptember = logMonth("2026-09", pulls("2026-09", [1, 2, 3]), new Map([["KAFKA-1", { key: "B", display: "B" }], ["KAFKA-2", { key: "B", display: "B" }], ["KAFKA-3", { key: "B", display: "B" }]]));
    const backfillSeptember = backfillMonth(PROFILE, "2026-09", [], new Map([["KAFKA-1", { key: "A", display: "A" }]]));
    const backfillAugust = backfillMonth(PROFILE, "2026-08", [], new Map([["KAFKA-2", { key: "A", display: "A" }]]));
    const bucket = linksBucket([logSeptember, logMonth("2026-10", [], new Map())], [backfillAugust, backfillSeptember], ["2026-08", "2026-09"]);
    await links(bucket, "read");
    expect(linkOf(table(bucket), "github:x", "jira-account:B")?.evidence.length).toBe(3);
    expect(linkOf(table(bucket), "github:x", "jira-account:A")).toBeUndefined();
    // The fact store alone: an older month read after a newer one does not replace it either.
    const facts = new IdentityFacts(KAFKA, "KAFKA-", []);
    facts.add(logSeptember);
    facts.add(backfillAugust);
    expect(facts.snapshot().jira.get("KAFKA-2")?.assignee?.key).toBe("B");
  },
  "W116 window": async () => {
    const log = [logMonth("2026-09", [], new Map()), logMonth("2026-10", [], new Map())];
    const done = monthsBetween("2025-10", "2026-09");
    const bucket = linksBucket(log, done.map((month) => backfillMonth(PROFILE, month, [], new Map())), done);
    const record = await links(bucket, "read");
    const reads = bucket.operations.filter((operation) => operation.startsWith("get ") && /\/\d{4}-\d{2}\.json$/u.test(operation)).map((operation) => operation.slice(4));
    expect(reads).toEqual([
      ...monthsBetween("2025-11", "2026-09").map((month) => identityBackfillMonthKey(KAFKA, month)),
      peopleActivityMonthKey(KAFKA, "2026-09"),
      peopleActivityMonthKey(KAFKA, "2026-10"),
    ]);
    expect(reads.length).toBe(13);
    expect(record.lastRun.inputs.backfill?.months).toEqual(monthsBetween("2025-11", "2026-09"));
    expect(record.lastRun.r2.classB).toBeLessThanOrEqual(17);
    expect(record.lastRun.r2.classA).toBeLessThanOrEqual(2);
  },
  "W117 twelve-month pairs": () => {
    const months = [...recordedNodes()].map(([month, nodes]) => backfillMonth(PROFILE, month, nodes, assigneesFor(nodes)));
    // The pull requests naming the four accounts' keys carry no creation time in the sample: one month holds them.
    const others = Object.entries(FIXTURE.keyPulls).flatMap(([key, pulls]) => pulls.map(([login, number]) => node(number, key, "2026-09-15T00:00:00Z", login)));
    const accountKeys = new Map(Object.keys(FIXTURE.accountIssues).map((key) => [key, recordedAssignee(key)!]));
    months.push(backfillMonth(PROFILE, "2026-09", others, accountKeys));
    const facts = new IdentityFacts(KAFKA, "KAFKA-", []);
    for (const month of months.sort((a, b) => a.month.localeCompare(b.month))) facts.add(parseActivityMonth(JSON.parse(encodeActivityMonth(month)), KAFKA, month.month));
    const result = computeIdentityLinks({
      projectId: KAFKA, config: KAFKA_IDENTITY_PROFILE.corroboration!, facts, roster: null, identityLinks: [],
      inputs: { coverageFrom: COVERAGE, months: [], activityUpdatedAt: "2026-10-23T00:00:00.000Z", rosterAt: null },
    });
    const corroborated = result.table.people.flatMap((person) => person.links).filter((link) => link.basis === "corroborated")
      .map((link) => [link.a, link.b, link.evidence.length]).sort();
    expect(corroborated).toEqual([
      ["github:dybyte", "jira-account:JIRAUSER312871", 9],
      ["github:harmadasg", "jira-account:JIRAUSER306203", 20],
      ["github:m1a2st", "jira-account:JIRAUSER305187", 22],
      ["github:unknowntpo", "jira-account:JIRAUSER306218", 10],
    ]);
    expect(result.counts.rejected.dominance).toBe(2);
    // The two refused pairs are m1a2st's: Chia-Ping Tsai 5 and Gergely Harmadás 3 (both reach the minimum).
    const { pulls, jira } = facts.snapshot();
    const pairs = new Map<string, Set<string>>();
    for (const [issue, authors] of pulls) {
      const assignee = jira.get(issue)?.assignee;
      if (assignee === null || assignee === undefined || !authors.has("github:m1a2st")) continue;
      (pairs.get(assignee.display) ?? pairs.set(assignee.display, new Set()).get(assignee.display)!).add(issue);
    }
    expect([pairs.get("Ken Huang")?.size, pairs.get("Chia-Ping Tsai")?.size, pairs.get("Gergely Harmadás")?.size]).toEqual([22, 5, 3]);
    expect(result.table.people.some((person) => person.members.some((member) => member.id === "github:chia7712"))).toBe(false);
  },
  "W118 dry run with backfill": async () => {
    const log = [logMonth("2026-09", [], new Map()), logMonth("2026-10", [], new Map())];
    const seeded = linksBucket(log, [backfillMonth(PROFILE, "2026-09", [], new Map())], ["2026-09"]);
    const env = environment({ stored: Object.fromEntries(seeded.objects), extra: { IDENTITY_LINKS: "corroborated@1" } });
    const response = await env.request("/identity-links/run?dryRun=1&backfill=1&blind=1", post("manual-under-test"));
    expect(response.status).toBe(200);
    const body = await response.json() as IdentityLinksRecord;
    expect(body.lastRun).toMatchObject({ dryRun: true, blind: true, inputs: { backfill: { months: ["2026-09"], until: "2026-09" } } });
    expect(body.precision).toMatchObject({ contradict: 0 });
    expect(env.bucketCalls).toContain(`get ${IDENTITY_BACKFILL_LAST_RUN_KEY}`);
    expect(env.bucketCalls).toContain(`get ${identityBackfillMonthKey(KAFKA, "2026-09")}`);
    expect(env.bucketCalls.filter((call) => call.startsWith("put "))).toEqual([]);
    expect(env.outbound).toEqual([]);
    // Positive control: without `backfill=1` the dry run reads no backfill object.
    const plain = environment({ stored: Object.fromEntries(seeded.objects), extra: { IDENTITY_LINKS: "corroborated@1" } });
    const plainBody = await (await plain.request("/identity-links/run?dryRun=1&blind=1", post("manual-under-test"))).json() as IdentityLinksRecord;
    expect(plain.bucketCalls.filter((call) => BACKFILL_KEYS(call.slice(4)))).toEqual([]);
    expect("backfill" in plainBody.lastRun.inputs).toBe(false);
  },
  "W119 profile unchanged": async () => {
    const pulls = [node(1, "KAFKA-1 a", "2026-09-20T00:00:00Z")];
    const log = [logMonth("2026-09", pulls, new Map()), logMonth("2026-10", [], new Map())];
    const base = linksBucket(log);
    const withStore = linksBucket(log, [backfillMonth(PROFILE, "2026-08", [node(2, "KAFKA-2 b", "2026-08-03T00:00:00Z")], new Map([["KAFKA-2", { key: "JIRAUSER305187", display: "Ken Huang" }]]))], ["2026-08"]);
    const reads: string[] = [];
    const reader = (objects: ReadonlyMap<string, string>): PeopleBucket => ({
      get: async (key: string) => {
        reads.push(key);
        const body = objects.get(key);
        return body === undefined ? null : { text: async () => body };
      },
    });
    const read = (objects: ReadonlyMap<string, string>) => readPersonProfile({ bucket: reader(objects), projectKey: "kafka", personId: "github:m1a2st", nowMs: Date.parse("2026-10-23T00:00:00Z"), kips: true });
    const plain = await read(base.objects);
    const stored = await read(withStore.objects);
    expect(plain.status).toBe(200);
    expect(JSON.stringify(stored)).toBe(JSON.stringify(plain));
    expect(reads.filter((key) => /^internal\/identity\/v1\/[^/]+\/backfill\//u.test(key) || key === IDENTITY_BACKFILL_LAST_RUN_KEY)).toEqual([]);
    // Positive control: the reader did read the log.
    expect(reads).toContain(peopleActivityMonthKey(KAFKA, "2026-09"));
  },
  "W120 429": async () => {
    const upstream = new Upstream(septemberNodes(150));
    upstream.override.set(2, new Response("slow down", { status: 429 }));
    const bucket = store(["2026-07"]);
    await backfill(bucket, upstream);
    expect(upstream.sent.length).toBe(2);
    expect(bucket.objects.has(identityBackfillMonthKey(KAFKA, "2026-09"))).toBe(false);
    expect(storedRecord(bucket)).toMatchObject({ lastRun: { ok: false, status: "limited", month: "2026-09" }, months: { done: ["2026-07"] } });
  },
  "W120 rate-limit 403": async () => {
    const limited = new Upstream(septemberNodes(5));
    limited.override.set(1, new Response("{\"message\":\"You have exceeded a secondary rate limit\"}", { status: 403 }));
    const a = store();
    await backfill(a, limited);
    expect([limited.sent.length, storedRecord(a).lastRun?.status, a.objects.has(identityBackfillMonthKey(KAFKA, "2026-09"))]).toEqual([1, "limited", false]);
    const forbidden = new Upstream(septemberNodes(5));
    forbidden.override.set(1, new Response("{\"message\":\"Resource not accessible\"}", { status: 403 }));
    const b = store();
    await backfill(b, forbidden);
    expect([forbidden.sent.length, storedRecord(b).lastRun?.status, b.objects.has(identityBackfillMonthKey(KAFKA, "2026-09"))]).toEqual([1, "failed", false]);
  },
  "W120 5xx, timeout, network, bad JSON, GraphQL errors": async () => {
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    const cases: [number, Answer, string][] = [
      [2, new Response("bad gateway", { status: 502 }), "502"],
      [1, timeout, "timed out"],
      [2, new TypeError("network connection lost"), "network"],
      [1, new Response("<html>oops</html>", { status: 200 }), "not JSON"],
      [1, Response.json({ errors: [{ type: "SOMETHING", message: "boom" }], data: null }), "errors"],
    ];
    for (const [at, answer, text] of cases) {
      const upstream = new Upstream(septemberNodes(3));
      upstream.override.set(at, answer);
      const bucket = store();
      await backfill(bucket, upstream);
      expect(upstream.sent.length).toBe(at);
      const record = storedRecord(bucket);
      expect(record.lastRun).toMatchObject({ ok: false, status: "failed" });
      expect(record.lastRun?.error).toContain(text);
      expect(bucket.objects.has(identityBackfillMonthKey(KAFKA, "2026-09"))).toBe(false);
      expect(record.lastRun?.retryAfter).toBeUndefined();
    }
  },
  "W120 positive control": async () => {
    const upstream = new Upstream(septemberNodes(230, 150), {});
    const bucket = store();
    const result = await backfill(bucket, upstream);
    expect(result.record?.lastRun).toMatchObject({ ok: true, status: "ok", prs: 230, keyedPrs: 230, keys: 150, requests: { github: 3, jira: 2 } });
    expect(upstream.sent.map((call) => call.kind)).toEqual(["github", "github", "github", "jira", "jira"]);
    for (let index = 1; index < upstream.sent.length; index += 1) expect(upstream.sent[index]!.at - upstream.sent[index - 1]!.at).toBeGreaterThanOrEqual(IDENTITY_BACKFILL_BUDGET.spacingMs);
    expect(upstream.timeouts).toEqual([30_000, 30_000, 30_000, 30_000, 30_000]);
    for (const call of upstream.sent) expect((call.init.headers as Record<string, string>)["User-Agent"]).toBe(SOURCE_USER_AGENT);
    expect((upstream.sent[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer token-under-test");
    expect(upstream.sent.slice(3).every((call) => !("Authorization" in (call.init.headers as Record<string, string>)))).toBe(true);
    expect(upstream.sent.map((call) => call.after).slice(0, 3)).toEqual([null, "1", "2"]);
    expect(Object.keys(storedMonth(bucket, "2026-09").threads).length).toBe(230);
    // The cron's wall budget equals the Spec 028 declaration, and a request that could outlast it is not sent.
    expect(WALL_BUDGET_MS["identity-backfill"]).toBe(IDENTITY_BACKFILL_WALL_MS);
    const late = new Upstream(septemberNodes(3));
    await backfill(store(), late, { deadline: late.clock + 10_000 });
    expect(late.sent).toEqual([]);
  },
  "W121 headroom": async () => {
    const body = new Upstream(septemberNodes(3));
    body.remaining = 900;
    const a = store();
    await backfill(a, body);
    expect(body.sent.length).toBe(1);
    expect(storedRecord(a).lastRun).toMatchObject({ status: "limited", retryAfter: "2026-10-23T02:00:00Z" });
    expect(a.objects.has(identityBackfillMonthKey(KAFKA, "2026-09"))).toBe(false);
    const header = new Upstream(septemberNodes(3));
    header.override.set(1, () => Response.json({ data: { rateLimit: { remaining: 4800, resetAt: "x" }, search: { issueCount: 3, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
      { headers: { "x-ratelimit-remaining": "999", "x-ratelimit-reset": String(Date.parse("2026-10-23T01:50:00Z") / 1000) } }));
    const b = store();
    await backfill(b, header);
    expect(storedRecord(b).lastRun).toMatchObject({ status: "limited", retryAfter: "2026-10-23T01:50:00.000Z" });
    // Positive control: 1,000 left is enough.
    const enough = new Upstream(septemberNodes(3), {});
    enough.remaining = 1_000;
    const c = store();
    await backfill(c, enough);
    expect(storedRecord(c).lastRun?.status).toBe("ok");
  },
  "W121 Retry-After": async () => {
    const upstream = new Upstream(septemberNodes(3), {});
    upstream.override.set(2, () => Response.json({ issues: [] }, { headers: { "Retry-After": "120" } }));
    const bucket = store();
    await backfill(bucket, upstream);
    const record = storedRecord(bucket);
    expect(record.lastRun).toMatchObject({ status: "limited", ok: false });
    expect(Date.parse(record.lastRun!.retryAfter!) - Date.parse(record.lastRun!.at)).toBeGreaterThanOrEqual(120_000);
    expect(bucket.objects.has(identityBackfillMonthKey(KAFKA, "2026-09"))).toBe(false);
    upstream.override.clear();
    const sent = upstream.sent.length;
    const operations = bucket.operations.length;
    upstream.clock = Date.parse(record.lastRun!.at) + 60_000;
    const early = await backfill(bucket, upstream);
    expect(early.skipped).toBe("retry-after");
    expect(upstream.sent.length).toBe(sent);
    expect(bucket.operations.slice(operations)).toEqual([`get ${IDENTITY_BACKFILL_LAST_RUN_KEY}`]);
    upstream.clock = Date.parse(record.lastRun!.retryAfter!) + 1_000;
    await backfill(bucket, upstream);
    expect(storedRecord(bucket).lastRun).toMatchObject({ status: "ok", month: "2026-09" });
  },
  "W122 over budget": async () => {
    const attempt = async (setup: (upstream: Upstream) => void, nodes: SearchNode[]) => {
      const upstream = new Upstream(nodes, {});
      setup(upstream);
      const bucket = store(["2026-07"]);
      await backfill(bucket, upstream);
      expect(storedRecord(bucket)).toMatchObject({ lastRun: { status: "over-budget", month: "2026-09" }, months: { done: ["2026-07"], next: "2026-09" } });
      expect(bucket.objects.has(identityBackfillMonthKey(KAFKA, "2026-09"))).toBe(false);
      expect(bucket.count("put")).toBe(1);
      return upstream;
    };
    expect((await attempt((upstream) => { upstream.issueCount = 640; }, septemberNodes(100))).sent.length).toBe(1);
    expect((await attempt((upstream) => { upstream.issueCount = 1_200; }, septemberNodes(100))).sent.length).toBe(1);
    // GitHub's 1,000-result search cap needs no check of its own: 5 pages of 100 stay below it.
    expect(IDENTITY_BACKFILL_BUDGET.pageSize * IDENTITY_BACKFILL_BUDGET.githubRequests).toBeLessThanOrEqual(1_000);
    const growing = await attempt((upstream) => { upstream.issueCount = 480; upstream.hasNextPage = () => true; }, septemberNodes(480));
    expect([growing.count("github"), growing.count("jira")]).toEqual([5, 0]);
    const keyed = await attempt(() => undefined, septemberNodes(401));
    expect([keyed.count("github"), keyed.count("jira")]).toEqual([5, 0]);
    // The next run tries the same month (here within budget: it finishes it).
    const upstream = new Upstream(septemberNodes(3), {});
    const bucket = store(["2026-07"]);
    upstream.issueCount = 640;
    await backfill(bucket, upstream);
    upstream.issueCount = undefined;
    upstream.clock += 86_400_000;
    await backfill(bucket, upstream);
    expect(upstream.sent.map((call) => /created:(\d{4}-\d{2})/u.exec(call.q ?? "")?.[1]).filter(Boolean)).toEqual(["2026-09", "2026-09"]);
    expect(storedRecord(bucket).lastRun?.status).toBe("ok");
  },
  "W123 gap": async () => {
    const log = [logMonth("2026-09", [node(1, "KAFKA-1 a", "2026-09-20T00:00:00Z", "x")], new Map()), logMonth("2026-10", [], new Map())];
    const bucket = linksBucket(log, [backfillMonth(PROFILE, "2026-07", [], new Map())], ["2026-07"]);
    bucket.objects.set(identityLinksKey(KAFKA), "LAST GOOD");
    const record = await links(bucket, "read");
    expect(record.lastRun).toMatchObject({ ok: false, status: "failed" });
    expect(record.lastRun.error).toContain("gap");
    expect(table(bucket)).toBe("LAST GOOD");
  },
  "W123 finished month missing": async () => {
    const log = [logMonth("2026-09", [], new Map()), logMonth("2026-10", [], new Map())];
    const missing = linksBucket(log, [backfillMonth(PROFILE, "2026-09", [], new Map())], ["2026-08", "2026-09"]);
    missing.objects.set(identityLinksKey(KAFKA), "LAST GOOD");
    const a = await links(missing, "read");
    expect([a.lastRun.status, table(missing)]).toEqual(["failed", "LAST GOOD"]);
    expect(a.lastRun.error).toContain(identityBackfillMonthKey(KAFKA, "2026-08"));
    const broken = linksBucket(log, [backfillMonth(PROFILE, "2026-09", [], new Map())], ["2026-09"]);
    broken.objects.set(identityBackfillMonthKey(KAFKA, "2026-09"), "{\"schema\":\"other\"}");
    broken.objects.set(identityLinksKey(KAFKA), "LAST GOOD");
    const b = await links(broken, "read");
    expect([b.lastRun.status, table(broken)]).toEqual(["failed", "LAST GOOD"]);
  },
  "W123 unparsable record": async () => {
    const bucket = linksBucket([logMonth("2026-09", [], new Map()), logMonth("2026-10", [], new Map())]);
    bucket.objects.set(IDENTITY_BACKFILL_LAST_RUN_KEY, "{not json");
    bucket.objects.set(identityLinksKey(KAFKA), "LAST GOOD");
    const record = await links(bucket, "read");
    expect([record.lastRun.status, table(bucket)]).toEqual(["failed", "LAST GOOD"]);
  },
  "W123 no record": async () => {
    const log = [logMonth("2026-09", [node(1, "KAFKA-1 a", "2026-09-20T00:00:00Z", "x")], new Map()), logMonth("2026-10", [], new Map())];
    const without = linksBucket(log);
    await links(without);
    const read = linksBucket(log);
    const record = await links(read, "read");
    expect(record.lastRun).toMatchObject({ ok: true, inputs: { backfill: null } });
    expect(table(read)).toBe(table(without)!);
  },
  "W123 nothing finished yet": async () => {
    const log = [logMonth("2026-09", [], new Map()), logMonth("2026-10", [], new Map())];
    const bucket = linksBucket(log, [], []);
    const record = await links(bucket, "read");
    expect(record.lastRun).toMatchObject({ ok: true, inputs: { backfill: null } });
  },
  "W123 hole inside done": async () => {
    const log = [logMonth("2026-09", [], new Map()), logMonth("2026-10", [], new Map())];
    const bucket = linksBucket(log, ["2026-07", "2026-09"].map((month) => backfillMonth(PROFILE, month, [], new Map())), ["2026-07", "2026-09"]);
    bucket.objects.set(identityLinksKey(KAFKA), "LAST GOOD");
    const record = await links(bucket, "read");
    expect([record.lastRun.status, table(bucket)]).toEqual(["failed", "LAST GOOD"]);
    expect(record.lastRun.error).toContain("hole");
    // Positive control: the contiguous store is read.
    const fine = linksBucket(log, ["2026-08", "2026-09"].map((month) => backfillMonth(PROFILE, month, [], new Map())), ["2026-08", "2026-09"]);
    expect((await links(fine, "read")).lastRun.inputs.backfill).toEqual({ months: ["2026-08", "2026-09"], until: "2026-09" });
  },
  "W124 isolation": async () => {
    const stored = { [peopleActivityStateKey(KAFKA)]: stateBody() };
    const failing = environment({ flag: "prs@1", fetch: "throws", failPuts: true, stored });
    await failing.tick(BACKFILL_CRON);
    expect(failing.jobs).toEqual([]);
    expect(failing.outbound).toEqual(["https://api.github.com/graphql"]);
    expect(failing.bucketCalls.filter((call) => call.startsWith("put ")).every((call) => BACKFILL_KEYS(call.slice(4)))).toBe(true);
    expect(failing.bucketCalls).toContain(`put ${IDENTITY_BACKFILL_LAST_RUN_KEY}`);
    const unreadable = environment({ flag: "prs@1", failGets: true, failPuts: true, stored });
    await unreadable.tick(BACKFILL_CRON);
    expect([unreadable.jobs, unreadable.outbound]).toEqual([[], []]);
    expect(unreadable.bucketCalls).toEqual([`get ${IDENTITY_BACKFILL_LAST_RUN_KEY}`]);
  },
  "W124 the publication tick": async () => {
    const on = environment({ flag: "prs@1", extra: { IDENTITY_LINKS: "corroborated@1" }, stored: { [peopleActivityStateKey(KAFKA)]: stateBody() } });
    await on.tick("7 22 * * *");
    expect(on.jobs).toEqual(["publication POST https://pipeline.internal/run"]);
    await on.tick("17 2 * * *");
    expect(on.outbound.filter((url) => url.includes("api.github.com") || url.includes("issues.apache.org"))).toEqual([]);
    expect(on.bucketCalls.filter((call) => BACKFILL_KEYS(call.slice(4)))).toEqual([]);
    // Positive control: its own tick does call upstream.
    await on.tick(BACKFILL_CRON);
    expect(on.outbound).toEqual(["https://api.github.com/graphql"]);
  },
  "W125 off": async () => {
    for (const flag of [undefined, "", "  "]) {
      const off = environment(flag === undefined ? { stored: { [peopleActivityStateKey(KAFKA)]: stateBody() } } : { flag, stored: { [peopleActivityStateKey(KAFKA)]: stateBody() } });
      await off.tick(BACKFILL_CRON);
      expect([off.jobs, off.outbound, off.bucketCalls]).toEqual([[], [], []]);
      for (const token of [undefined, "manual-under-test"]) expect((await off.request("/identity-backfill/run", post(token))).status).toBe(404);
      const health = await (await off.request("/health")).json() as Record<string, unknown>;
      expect("identityBackfill" in health).toBe(false);
      expect([off.outbound, off.bucketCalls.filter((call) => BACKFILL_KEYS(call.slice(4)))]).toEqual([[], []]);
    }
  },
  "W125 unsupported value": async () => {
    const env = environment({ flag: "prs@2", stored: { [peopleActivityStateKey(KAFKA)]: stateBody(), [IDENTITY_BACKFILL_LAST_RUN_KEY]: recordBody(["2026-09"]) } });
    await env.tick(BACKFILL_CRON);
    expect([env.jobs, env.outbound]).toEqual([[], []]);
    const record = JSON.parse(env.objects.get(IDENTITY_BACKFILL_LAST_RUN_KEY)!) as IdentityBackfillRecordV1;
    expect(record.lastRun).toMatchObject({ ok: false, status: "failed", requests: { github: 0, jira: 0 } });
    expect(record.lastRun?.error).toContain("prs@2");
    expect(record.months.done).toEqual(["2026-09"]);
    expect(env.bucketCalls.filter((call) => call.startsWith("put "))).toEqual([`put ${IDENTITY_BACKFILL_LAST_RUN_KEY}`]);
  },
  "W126 too soon": async () => {
    const realNow = Date.now;
    try {
      const last = Date.parse("2026-10-23T01:23:00Z");
      const env = environment({ flag: "prs@1", stored: { [peopleActivityStateKey(KAFKA)]: stateBody(), [IDENTITY_BACKFILL_LAST_RUN_KEY]: recordBody([], { at: new Date(last).toISOString(), status: "ok", ok: true }) } });
      Date.now = () => last + 30 * 60_000;
      expect((await env.request("/identity-backfill/run", post())).status).toBe(401);
      expect((await env.request("/identity-backfill/run", post("wrong"))).status).toBe(401);
      const soon = await env.request("/identity-backfill/run", post("manual-under-test"));
      expect(soon.status).toBe(409);
      expect(await soon.json() as unknown).toEqual({ ok: false, skipped: "too-soon" });
      expect(env.outbound).toEqual([]);
      expect(env.bucketCalls.filter((call) => call.startsWith("put "))).toEqual([]);
      Date.now = () => last + 61 * 60_000;
      const later = await env.request("/identity-backfill/run", post("manual-under-test"));
      expect(later.status).toBe(200);
      expect(env.outbound).toEqual(["https://api.github.com/graphql"]);
      expect((await later.json() as IdentityBackfillRecordV1).lastRun).toMatchObject({ ok: true, month: "2026-09" });
    } finally {
      Date.now = realNow;
    }
  },
  "W127 rollback": async () => {
    const pulls = (month: string, keys: readonly number[]) => keys.map((key) => node(key, `KAFKA-${key} x`, `${month}-12T00:00:00Z`, "x"));
    const assignee = (keys: readonly number[]) => new Map(keys.map((key) => [`KAFKA-${key}`, { key: "Y", display: "Y" }] as const));
    const log = [logMonth("2026-09", pulls("2026-09", [1]), assignee([1])), logMonth("2026-10", [], new Map())];
    const backfillMonths = [backfillMonth(PROFILE, "2026-09", pulls("2026-09", [2, 3]), assignee([2, 3]))];
    const reference = linksBucket(log);
    await links(reference);
    const bucket = linksBucket(log, backfillMonths, ["2026-09"]);
    await links(bucket, "read");
    expect(linkOf(table(bucket), "github:x", "jira-account:Y")?.evidence.length).toBe(3);
    linksClock += 86_400_000;
    const record = await links(bucket);
    expect(record.lastRun.status).toBe("ok");
    expect(table(bucket)).toBe(table(reference)!);
  },
  "W130 health field": async () => {
    const limited = {
      revision: "prs@1",
      lastRun: { ok: false, status: "limited", at: "2026-10-23T01:23:00.000Z", durationMs: 4100, month: "2026-09", prs: 0, keyedPrs: 0, keys: 0, assigned: 0,
        requests: { github: 2, jira: 0 }, retryAfter: "2026-10-23T02:00:00Z", bytesWritten: 0, r2: { classA: 1, classB: 2 }, error: "api.github.com answered 429 token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      months: { done: ["2026-08"], next: "2026-09", remaining: 10 }, from: "2025-11", until: "2026-09",
    };
    const env = environment({ flag: "prs@1", stored: { [IDENTITY_BACKFILL_LAST_RUN_KEY]: JSON.stringify(limited) } });
    const body = await (await env.request("/health")).json() as { identityBackfill: typeof limited };
    expect(body.identityBackfill.lastRun).toMatchObject({ status: "limited", retryAfter: "2026-10-23T02:00:00Z", requests: { github: 2, jira: 0 }, r2: { classA: 1, classB: 2 }, month: "2026-09" });
    expect(Object.keys(body.identityBackfill).sort()).toEqual(["from", "lastRun", "months", "revision", "until"]);
    expect(body.identityBackfill.months).toEqual(limited.months);
    expect(body.identityBackfill.lastRun.error).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(env.bucketCalls.filter((call) => call === `get ${IDENTITY_BACKFILL_LAST_RUN_KEY}`).length).toBe(1);
    // A real run's record has every field W130 names.
    const upstream = new Upstream(septemberNodes(2), {});
    const bucket = store();
    await backfill(bucket, upstream);
    expect(Object.keys(storedRecord(bucket).lastRun!).sort()).toEqual(["assigned", "at", "bytesWritten", "durationMs", "keyedPrs", "keys", "month", "ok", "prs", "r2", "requests", "status"]);
  },
  "W130 flag unset": async () => {
    const off = environment({ stored: { [IDENTITY_BACKFILL_LAST_RUN_KEY]: recordBody(["2026-09"]) } });
    const offBody = await (await off.request("/health")).json() as Record<string, unknown>;
    expect("identityBackfill" in offBody).toBe(false);
    expect(off.bucketCalls.filter((call) => BACKFILL_KEYS(call.slice(4)))).toEqual([]);
    const before = environment({ flag: "prs@1" });
    expect((await (await before.request("/health")).json() as { identityBackfill: unknown }).identityBackfill)
      .toEqual({ revision: "prs@1", lastRun: null, months: { done: [], next: null, remaining: 0 }, from: null, until: null });
    const unreadable = environment({ flag: "prs@1", stored: { [IDENTITY_BACKFILL_LAST_RUN_KEY]: "{not json" } });
    const body = await (await unreadable.request("/health")).json() as Record<string, unknown>;
    expect("identityBackfill" in body && body.identityBackfill === null).toBe(true);
  },
};

describe("Spec 019 amendment (8): the identity-backfill job and the identity-link reader", () => {
  test("every case row has a check and every check a row", () => {
    expect(Object.keys(checks).sort()).toEqual(testPlanRows.map((row) => `${row.id} ${row.case}`).sort());
  });

  test.each([...testPlanRows])("$id: $case ($data)", async (row) => {
    const check = checks[`${row.id} ${row.case}`];
    if (check === undefined) throw new Error(`no check for ${row.id} ${row.case}`);
    await check();
  });

  test("W125: merged off: no IDENTITY_BACKFILL, IDENTITY_BACKFILL_CRON or IDENTITY_LINKS_BACKFILL and no 23 1 * * * entry on Dev or Prod", async () => {
    const read = async (name: string) => JSON.parse(await Bun.file(new URL(`../wrangler.${name}.jsonc`, import.meta.url)).text()) as { vars?: Record<string, string>; triggers?: { crons?: string[] } };
    for (const name of ["development", "production"]) {
      const config = await read(name);
      for (const variable of ["IDENTITY_BACKFILL", "IDENTITY_BACKFILL_CRON", "IDENTITY_LINKS_BACKFILL"]) expect(variable in (config.vars ?? {})).toBe(false);
      expect(config.triggers?.crons ?? []).not.toContain(BACKFILL_CRON);
    }
  });
});
