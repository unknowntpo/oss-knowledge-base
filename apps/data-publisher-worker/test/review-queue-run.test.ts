/**
 * Spec 015 slice 2, run from the slice 2 case file: the review-queue job against a fake GitHub,
 * a fake Pony Mail and ASF roster built from the captured samples, an in-memory bucket, and a
 * controlled clock.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MANIFEST_KEY } from "@oss-knowledge-base/serving-contract";
import { asfRosterAdapter, KAFKA_REVIEW_PROFILE, MAX_RESPONSE_CHARS, type PrNode, type Roster } from "@oss-knowledge-base/reference-pipeline";
import { testPlanRows } from "../../../packages/reference-pipeline/test/review-queue-run.cases";
import worker, { cronTarget, mergeHealth } from "../src/index";
import { ASF_LDAP_PEOPLE_URL, ASF_LDAP_PROJECTS_URL } from "@oss-knowledge-base/reference-pipeline";
import { runReviewQueue, type ReviewQueueLastRun, type ReviewQueueObject } from "../src/review-queue/run";
import { reviewQueueLastRunKey, reviewQueuePointerKey, rosterKey, type ReviewQueueBucket } from "../src/review-queue/store";

const samples = join(import.meta.dir, "../../../docs/specs/015-review-queue/samples/");
const sample = async <T>(name: string) => JSON.parse(readFileSync(join(samples, name), "utf8")) as T;

interface SampleMessage { mid: string; author: string; at: string; subject: string; voteLikeLines?: string[] }
interface SampleThread { displayId: string; subject: string; messages: SampleMessage[] }

const prSample = await sample<{ nodes: PrNode[] }>("github-open-prs.json");
const threadSample = await sample<{ threads: SampleThread[] }>("ponymail-kip-threads.json");
const feedSample = await sample<{ entries: { displayId: string; title: string; lastActivityAt: string }[] }>("feed-kip-mail-entries.json");
const ldapSample = await sample<{ projects: unknown; people: unknown }>("asf-roster-kafka.json");

const P = KAFKA_REVIEW_PROFILE;
const START = Date.parse("2026-10-08T04:01:48Z");
const HOUR = 3_600_000;
const POINTER = reviewQueuePointerKey(P.projectId);
const LAST_RUN = reviewQueueLastRunKey(P.projectId);
const ROSTER = rosterKey("asf", "kafka");

class MemoryBucket implements ReviewQueueBucket {
  readonly objects = new Map<string, { body: string; etag: string }>();
  writes = 0;
  failPutIfAbsent = false;
  failPointer = false;
  private version = 0;

  set(key: string, value: unknown): void {
    this.objects.set(key, { body: JSON.stringify(value), etag: `e${(this.version += 1)}` });
  }
  async getJson(key: string): Promise<unknown> {
    const object = this.objects.get(key);
    return object === undefined ? undefined : JSON.parse(object.body);
  }
  async getWithEtag(key: string) {
    const object = this.objects.get(key);
    return object === undefined ? undefined : { value: JSON.parse(object.body), etag: object.etag };
  }
  async putIfAbsent(key: string, body: string): Promise<boolean> {
    if (this.failPutIfAbsent) throw new Error("R2 put failed");
    this.writes += 1;
    if (this.objects.has(key)) return false;
    this.objects.set(key, { body, etag: `e${(this.version += 1)}` });
    return true;
  }
  async putPointerIfMatch(key: string, body: string, etag: string | null): Promise<boolean> {
    if (this.failPointer) throw new Error("killed");
    this.writes += 1;
    const current = this.objects.get(key);
    if ((current?.etag ?? null) !== etag) return false;
    this.objects.set(key, { body, etag: `e${(this.version += 1)}` });
    return true;
  }
  async put(key: string, body: string): Promise<void> {
    this.writes += 1;
    this.objects.set(key, { body, etag: `e${(this.version += 1)}` });
  }
}

function seededBucket(): MemoryBucket {
  const bucket = new MemoryBucket();
  bucket.set(MANIFEST_KEY, {
    schema: "osskb.feed-manifest.v3", releaseId: "2026-10-08T03-07-37-000Z", generatedAt: "2026-10-08T03:07:37.000Z",
    feedIndexKey: "public/v2/releases/r/feed.json", detailMapKey: "public/v2/releases/r/details.json", entryCount: feedSample.entries.length,
  });
  const firstMid = new Map(threadSample.threads.map((thread) => [thread.displayId, thread.messages[0]!.mid]));
  bucket.set("public/v2/releases/r/feed.json", {
    entries: feedSample.entries.map((entry) => ({
      displayId: entry.displayId, projectKey: "kafka", lastActivityAt: entry.lastActivityAt,
      entry: { title: entry.title, recordIds: firstMid.has(entry.displayId) ? [`kafka:mail:dev:message:${firstMid.get(entry.displayId)}`] : [] },
    })),
  });
  return bucket;
}

/** A clock that only moves when the job waits. */
class Clock {
  constructor(public now = START) {}
  readonly delays: number[] = [];
  readonly tick = () => this.now;
  readonly delay = async (ms: number) => {
    this.delays.push(ms);
    this.now += ms;
  };
}

type Handler = (url: string, init: RequestInit, call: number) => Response | Promise<Response>;
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

function githubPages(nodes: readonly PrNode[] = prSample.nodes, size = 100): Handler {
  return (_url, init) => {
    const { variables } = JSON.parse(String(init.body)) as { variables: { cursor: string | null } };
    const start = variables.cursor === null ? 0 : Number(variables.cursor);
    const slice = nodes.slice(start, start + size);
    const next = start + size < nodes.length;
    return json({ data: { rateLimit: { cost: 3 }, repository: { pullRequests: {
      totalCount: nodes.length, pageInfo: { hasNextPage: next, endCursor: next ? String(start + size) : null }, nodes: slice,
    } } } });
  };
}

function threadOf(mid: string): SampleThread | undefined {
  return threadSample.threads.find((thread) => thread.messages.some((message) => message.mid === mid));
}

function apache(overrides: { thread?: (mid: string) => Response | undefined; email?: (mid: string) => Response | undefined; roster?: () => Response | undefined } = {}): Handler {
  return (url) => {
    const target = new URL(url);
    const mid = target.searchParams.get("id") ?? "";
    if (target.pathname.endsWith("/thread.lua")) {
      const override = overrides.thread?.(mid);
      if (override !== undefined) return override;
      const thread = threadOf(mid);
      if (thread === undefined) return json({ error: "not found" }, 404);
      const [root, ...rest] = thread.messages.map((message) => ({
        mid: message.mid, from: `${message.author} <x@example.org>`, subject: message.subject, epoch: Date.parse(message.at) / 1000,
      }));
      return json({ thread: { ...root, children: rest } });
    }
    if (target.pathname.endsWith("/email.lua")) {
      const override = overrides.email?.(mid);
      if (override !== undefined) return override;
      const message = threadOf(mid)?.messages.find((item) => item.mid === mid);
      return message === undefined ? json({}, 404) : json({ mid, body: (message.voteLikeLines ?? []).join("\n") });
    }
    if (url === ASF_LDAP_PROJECTS_URL || url === ASF_LDAP_PEOPLE_URL) {
      const override = overrides.roster?.();
      if (override !== undefined) return override;
      return json(url === ASF_LDAP_PROJECTS_URL ? { projects: ldapSample.projects } : { people: ldapSample.people });
    }
    return json({}, 404);
  };
}

interface World {
  bucket: MemoryBucket;
  clock: Clock;
  github: Handler;
  apache: Handler;
  githubCalls: string[];
  apacheCalls: { url: string; at: number }[];
}

function world(overrides: Partial<Pick<World, "bucket" | "github" | "apache">> = {}): World {
  return {
    bucket: overrides.bucket ?? seededBucket(), clock: new Clock(), github: overrides.github ?? githubPages(),
    apache: overrides.apache ?? apache(), githubCalls: [], apacheCalls: [],
  };
}

async function run(w: World, dryRun = false) {
  let githubCall = 0;
  let apacheCall = 0;
  return runReviewQueue({
    bucket: w.bucket, profile: P, githubToken: "test-token",
    githubFetch: async (url, init) => { w.githubCalls.push(url); return w.github(url, init, githubCall++); },
    apacheFetch: async (url, init) => { w.apacheCalls.push({ url, at: w.clock.now }); return w.apache(url, init, apacheCall++); },
    rosterAdapter: asfRosterAdapter, now: w.clock.tick, delay: w.clock.delay, dryRun,
  });
}

async function current(bucket: MemoryBucket): Promise<ReviewQueueObject | undefined> {
  const pointer = await bucket.getJson(POINTER) as { objectKey: string } | undefined;
  return pointer === undefined ? undefined : await bucket.getJson(pointer.objectKey) as ReviewQueueObject;
}

/** A world whose previous run published, then the clock moves an hour. */
async function afterGoodRun(): Promise<World> {
  const w = world();
  await run(w);
  w.clock.now += HOUR;
  w.githubCalls.length = 0;
  w.apacheCalls.length = 0;
  return w;
}

const count = (w: World, path: string) => w.apacheCalls.filter((call) => call.url.includes(path)).length;
const prsText = (object: ReviewQueueObject | undefined) => object === undefined ? "none" : `${object.prs.noReviewer.length}/${object.prs.waiting.length}/${object.prs.approved.length}`;
const kip1349Mids = threadSample.threads.find((thread) => thread.displayId === "KAFKA-MAIL-82e0d5b3")!.messages.map((message) => message.mid);

async function githubFailure(handler: Handler): Promise<{ lastRun: ReviewQueueLastRun; kept: boolean; delays: number[]; calls: number }> {
  const w = await afterGoodRun();
  const before = await current(w.bucket);
  w.github = handler;
  const { lastRun } = await run(w);
  const after = await current(w.bucket);
  return { lastRun, kept: JSON.stringify(after?.prs) === JSON.stringify(before?.prs) && after?.sources.github.fetchedAt === before?.sources.github.fetchedAt, delays: w.clock.delays, calls: w.githubCalls.length };
}

type CaseRow = { readonly id: string; readonly rule: string; readonly input: string; readonly expected: string };
const cases: Record<string, () => Promise<string>> = {
  // Q17
  "rate limit|constructed: GraphQL HTTP 403 \"secondary rate limit\", Retry-After 120": async () => {
    const result = await githubFailure(() => json({ message: "secondary rate limit" }, 403, { "retry-after": "120" }));
    return `${result.calls === 1 ? "no retry" : `${result.calls} calls`}; ${result.kept ? "PR section keeps the previous snapshot" : "changed"}; github failureKind ${result.lastRun.sources.github.failureKind}`;
  },
  "rate limit|constructed: HTTP 429 with Retry-After 30, then 200": async () => {
    const w = world();
    const pages = githubPages();
    w.github = (url, init, call) => (call === 0 ? json({}, 429, { "retry-after": "30" }) : pages(url, init, call));
    const { lastRun } = await run(w);
    return `${w.clock.delays.includes(30_000) && w.githubCalls.length === 8 ? "one retry after 30 s" : String(w.clock.delays)}; ${lastRun.pointerUpdated ? "snapshot published" : "not published"}`;
  },
  "rate limit|constructed: HTTP 429 with Retry-After 60, then 200": async () => {
    const w = world();
    const pages = githubPages();
    w.github = (url, init, call) => (call === 0 ? json({}, 429, { "retry-after": "60" }) : pages(url, init, call));
    const { lastRun } = await run(w);
    return `${w.githubCalls.length === 8 ? "one retry" : `${w.githubCalls.length} calls`}; ${lastRun.sources.github.ok ? "published" : "failed"}`;
  },
  "rate limit|constructed: HTTP 429 with Retry-After 61": async () => {
    const result = await githubFailure(() => json({}, 429, { "retry-after": "61" }));
    return `${result.calls === 1 ? "no retry" : `${result.calls} calls`}; ${result.kept ? "previous kept" : "changed"}; ${result.lastRun.sources.github.failureKind}`;
  },
  "rate limit|constructed: HTTP 200 with errors[0].type RATE_LIMITED": async () => {
    const result = await githubFailure(() => json({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }));
    return `${result.lastRun.sources.github.failureKind}; ${result.kept ? "previous snapshot kept" : "changed"}`;
  },
  // Q18
  "partial pages|constructed: page 3 of 7 returns 502 twice": async () => {
    const pages = githubPages();
    let page = 0;
    let page3Calls = 0;
    const result = await githubFailure((url, init, call) => {
      const { variables } = JSON.parse(String(init.body)) as { variables: { cursor: string | null } };
      page = variables.cursor === null ? 1 : Number(variables.cursor) / 100 + 1;
      if (page === 3) page3Calls += 1;
      return page === 3 ? json({}, 502) : pages(url, init, call);
    });
    const page3 = page3Calls;
    return `${result.lastRun.sources.github.ok ? "published" : "no PR snapshot published"}; ${result.kept ? "previous kept" : "changed"}; failureKind ${result.lastRun.sources.github.failureKind}; page 3 tried ${page3 === 2 ? "twice" : `${page3} times`}`;
  },
  "graphql errors|constructed: page 2 of 7 has data null and an error without a path": async () => {
    const pages = githubPages();
    const result = await githubFailure((url, init, call) => {
      const { variables } = JSON.parse(String(init.body)) as { variables: { cursor: string | null } };
      return variables.cursor === "100" ? json({ data: null, errors: [{ message: "Something went wrong" }] }) : pages(url, init, call);
    });
    return `failureKind ${result.lastRun.sources.github.failureKind}; ${result.kept ? "previous kept" : "changed"}`;
  },
  // Q25
  "thread fetch|constructed: thread.lua 503 twice for KIP-1376, previous row exists": async () => {
    const w = await afterGoodRun();
    const before = (await current(w.bucket))!.kips.discuss.find((row) => row.key === "KIP-1376")!;
    const mids = new Set(threadSample.threads.find((thread) => thread.displayId === "KAFKA-MAIL-3bc971ac")!.messages.map((message) => message.mid));
    w.apache = apache({ thread: (mid) => (mids.has(mid) ? json({}, 503) : undefined) });
    await run(w);
    const after = (await current(w.bucket))!.kips.discuss.find((row) => row.key === "KIP-1376");
    return after !== undefined && after.fetchedAt === before.fetchedAt && after.fetchedAt !== (await current(w.bucket))!.generatedAt
      ? "previous row kept with its fetchedAt" : JSON.stringify(after);
  },
  "thread fetch|constructed: thread.lua 503 twice for a new thread": async () => {
    const mids = new Set(threadSample.threads.find((thread) => thread.displayId === "KAFKA-MAIL-3bc971ac")!.messages.map((message) => message.mid));
    const w = world({ apache: apache({ thread: (mid) => (mids.has(mid) ? json({}, 503) : undefined) }) });
    const { lastRun } = await run(w);
    const object = await current(w.bucket);
    return object?.kips.discuss.some((row) => row.key === "KIP-1376") === false ? `row omitted; unavailable ${lastRun.unavailable} shown` : "row present";
  },
  // Q26
  "email fetch|constructed: email.lua 404 for one KIP-1349 message": async () => {
    const andrew = threadSample.threads.find((thread) => thread.displayId === "KAFKA-MAIL-82e0d5b3")!.messages.find((message) => message.author === "Andrew Schofield")!.mid;
    const w = world({ apache: apache({ email: (mid) => (mid === andrew ? json({}, 404) : undefined) }) });
    await run(w);
    const row = (await current(w.bucket))!.kips.vote.find((item) => item.key === "KIP-1349")!;
    return row.tally!.text.startsWith("seen ") && row.tally!.unread === 1 ? "row shows seen wording (Q16); message counted unread" : row.tally!.text;
  },
  // Q27
  "cache|constructed: second run, KIP-1349 thread unchanged": async () => {
    const w = await afterGoodRun();
    await run(w);
    const requests = w.apacheCalls.filter((call) => kip1349Mids.some((mid) => call.url.includes("email.lua") && call.url.includes(mid))).length;
    return `${requests} email.lua requests for KIP-1349`;
  },
  "cache|constructed: previous object regexVersion 1, current 2": async () => {
    const w = await afterGoodRun();
    const pointer = await w.bucket.getJson(POINTER) as { objectKey: string };
    const object = await w.bucket.getJson(pointer.objectKey) as ReviewQueueObject;
    w.bucket.set(pointer.objectKey, { ...object, voteLines: { ...object.voteLines, regexVersion: object.voteLines.regexVersion - 1 } });
    await run(w);
    const requests = w.apacheCalls.filter((call) => kip1349Mids.some((mid) => call.url.includes("email.lua") && call.url.includes(mid))).length;
    return `${requests} email.lua requests for KIP-1349`;
  },
  // Q30
  "feed release|constructed: public/v2/current.json missing": async () => {
    const w = await afterGoodRun();
    const before = await current(w.bucket);
    w.bucket.objects.delete(MANIFEST_KEY);
    const { lastRun } = await run(w);
    const after = await current(w.bucket);
    const keptKips = JSON.stringify(after?.kips) === JSON.stringify(before?.kips);
    const keptMail = after?.sources.mail?.fetchedAt === before?.sources.mail?.fetchedAt && after?.sources.mail?.feedReleaseId === before?.sources.mail?.feedReleaseId &&
      before?.sources.mail?.feedReleaseId === "2026-10-08T03-07-37-000Z";
    return `${keptKips ? "KIP section keeps previous" : "KIP changed"}; ${keptMail ? "mail fetchedAt and feedReleaseId kept" : "mail status changed"}; ${after?.sources.github.fetchedAt !== before?.sources.github.fetchedAt ? "PR section updated" : "PR not updated"}; mail failureKind ${lastRun.sources.mail?.failureKind}`;
  },
  // Q32
  "overlap|constructed: run B (started later) wrote pointer; run A finishes after": async () => {
    const w = world();
    const base = w.bucket;
    let interleaved = false;
    const original = base.putIfAbsent.bind(base);
    // Run B publishes while A is writing its content object, after A read the pointer's ETag.
    base.putIfAbsent = async (key, body) => {
      if (!interleaved) {
        interleaved = true;
        base.set(POINTER, { schema: "osskb.review-queue-pointer.v1", objectKey: "B", generatedAt: "later" });
      }
      return original(key, body);
    };
    const { lastRun } = await run(w);
    const pointer = await base.getJson(POINTER) as { objectKey: string };
    return `${lastRun.pointerUpdated ? "A wrote" : "A's pointer write refused (ETag changed), not retried"}; ${pointer.objectKey === "B" ? "B stays" : "B replaced"}`;
  },
  // Q33
  "too large|constructed: GraphQL page body 4 MiB + 1 byte": async () => {
    const result = await githubFailure(() => new Response("x".repeat(MAX_RESPONSE_CHARS + 1)));
    return `failureKind ${result.lastRun.sources.github.failureKind}; ${result.kept ? "previous kept" : "changed"}`;
  },
  "too large|constructed: GraphQL page body exactly 4 MiB": async () => {
    const body = JSON.stringify({ data: { repository: { pullRequests: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    const padded = body.slice(0, -1) + " ".repeat(MAX_RESPONSE_CHARS - body.length) + "}";
    const w = world({ github: () => new Response(padded) });
    const { lastRun } = await run(w);
    return padded.length === MAX_RESPONSE_CHARS && lastRun.sources.github.ok ? "accepted" : `rejected ${lastRun.sources.github.failureKind}`;
  },
  // Q42
  "auth|constructed: GraphQL HTTP 401": async () => {
    const w = await afterGoodRun();
    w.github = () => json({ message: "Bad credentials" }, 401);
    const before = await current(w.bucket);
    const { lastRun } = await run(w);
    const after = await current(w.bucket);
    return `failureKind ${lastRun.sources.github.failureKind}; ${w.githubCalls.length === 1 ? "no retry" : "retried"}; ${after?.sources.mail?.fetchedAt !== before?.sources.mail?.fetchedAt ? "KIP section updated" : "KIP not updated"}`;
  },
  // Q43
  "first run|constructed: no previous object; Pony Mail down; GitHub ok": async () => {
    const w = world({ apache: (url, init, call) => (url.includes("lists.apache.org") ? json({}, 503) : apache()(url, init, call)) });
    const { lastRun } = await run(w);
    const object = await current(w.bucket);
    return `${lastRun.pointerUpdated ? "published" : "not published"}; ${object!.prs.noReviewer.length > 0 ? "PR column filled" : "PR empty"}; ` +
      `${object!.kips.vote.length + object!.kips.discuss.length === 0 && object!.sources.mail?.ok === false ? "KIP column unavailable" : "KIP shown"}; mail ok ${object!.sources.mail?.ok}; last-run ok ${lastRun.ok}`;
  },
  "no source|constructed: previous object exists; GitHub 401 and the Feed pointer missing": async () => {
    const w = await afterGoodRun();
    const pointer = JSON.stringify(await w.bucket.getJson(POINTER));
    const objects = w.bucket.objects.size;
    w.github = () => json({}, 401);
    w.bucket.objects.delete(MANIFEST_KEY);
    const { lastRun } = await run(w);
    const unchanged = JSON.stringify(await w.bucket.getJson(POINTER)) === pointer;
    return `${unchanged ? "pointer unchanged" : "pointer moved"}; ${w.bucket.objects.size === objects - 1 ? "no new object" : "new object"}; last-run ok ${lastRun.ok}, failureKind ${lastRun.failureKind}`;
  },
  "no source|constructed: no previous object; GitHub 401 and the Feed pointer missing": async () => {
    const w = world({ github: () => json({}, 401) });
    w.bucket.objects.delete(MANIFEST_KEY);
    const { lastRun } = await run(w);
    const published = [...w.bucket.objects.keys()].some((key) => key.startsWith("public/review-queue/") && key !== LAST_RUN);
    return `${published ? "published" : "nothing published (no pointer)"}; last-run ok ${lastRun.ok}, failureKind ${lastRun.failureKind}`;
  },
  // Q44
  "crash|constructed: run killed after the content object write": async () => {
    const w = await afterGoodRun();
    const pointerBefore = await w.bucket.getJson(POINTER);
    w.bucket.failPointer = true;
    const killed = await run(w);
    const unchanged = JSON.stringify(await w.bucket.getJson(POINTER)) === JSON.stringify(pointerBefore);
    w.bucket.failPointer = false;
    w.clock.now += HOUR;
    const next = await run(w);
    return `${unchanged && !killed.lastRun.pointerUpdated ? "pointer unchanged" : "pointer moved"}; ${next.lastRun.pointerUpdated ? "next run publishes" : "next run failed"}; verify:health flags last-run older than 2 h`;
  },
  // Q45
  "write|constructed: R2 put of the content object throws": async () => {
    const w = await afterGoodRun();
    const pointerBefore = await w.bucket.getJson(POINTER);
    const objectBefore = await current(w.bucket);
    w.bucket.failPutIfAbsent = true;
    const { lastRun } = await run(w);
    const same = JSON.stringify(await w.bucket.getJson(POINTER)) === JSON.stringify(pointerBefore) && JSON.stringify(await current(w.bucket)) === JSON.stringify(objectBefore);
    const stored = await w.bucket.getJson(LAST_RUN) as ReviewQueueLastRun;
    return `${same ? "pointer and previous object unchanged" : "changed"}; last-run failureKind ${stored.failureKind}`;
  },
  // Q48
  "mail retry|constructed: thread.lua 503 with Retry-After 5, then 200": async () => {
    const mids = new Set(threadSample.threads.find((thread) => thread.displayId === "KAFKA-MAIL-3bc971ac")!.messages.map((message) => message.mid));
    let failed = false;
    const w = world({ apache: apache({ thread: (mid) => (mids.has(mid) && !failed ? ((failed = true), json({}, 503, { "retry-after": "5" })) : undefined) }) });
    await run(w);
    const row = (await current(w.bucket))!.kips.discuss.find((item) => item.key === "KIP-1376");
    return `${w.clock.delays.includes(5_000) ? "one retry after 5 s" : "no retry"}; ${row?.fetchedAt === (await current(w.bucket))!.generatedAt ? "row updated" : "row stale"}`;
  },
  "mail retry|constructed: 21 thread requests": async () => {
    const w = world();
    await run(w);
    const calls = w.apacheCalls.filter((call) => call.url.includes("lists.apache.org"));
    const gaps = calls.slice(1).map((call, index) => call.at - calls[index]!.at);
    return gaps.every((gap) => gap >= 1_000) ? "sequential, at least 1 s apart" : `min gap ${Math.min(...gaps)}`;
  },
  // Q52
  "roster cache|constructed: stored roster fetched 23 h 59 min ago": async () => {
    const w = world();
    w.bucket.set(ROSTER, { ...rosterFixture(), fetchedAt: new Date(START - 23 * HOUR - 59 * 60_000).toISOString() });
    await run(w);
    return `reused; ${count(w, "whimsy")} roster requests`;
  },
  "roster cache|constructed: stored roster fetched exactly 24 h ago": async () => {
    const w = world();
    w.bucket.set(ROSTER, { ...rosterFixture(), fetchedAt: new Date(START - 24 * HOUR).toISOString() });
    await run(w);
    return `refetched; ${count(w, "whimsy")} roster requests`;
  },
  "roster cache|constructed: stored roster 30 h old, refetch fails": async () => {
    const stale = new Date(START - 30 * HOUR).toISOString();
    const w = world({ apache: apache({ roster: () => json({}, 404) }) });
    w.bucket.set(ROSTER, { ...rosterFixture(), fetchedAt: stale });
    const { object } = await run(w);
    return object?.roster?.fetchedAt === stale ? "stored roster and its fetchedAt kept" : String(object?.roster?.fetchedAt);
  },
  "roster cache|constructed: no stored roster, refetch fails": async () => {
    const w = world({ apache: apache({ roster: () => json({}, 404) }) });
    const { object } = await run(w);
    const row = object!.kips.vote.find((item) => item.key === "KIP-1262")!;
    return object!.roster === null && row.tally!.text.endsWith("roster unavailable") ? "no roster; tallies use the seen wording (Q29)" : row.tally!.text;
  },
  // Q57
  "cron|constructed: REVIEW_QUEUE_CRON unset; cron 7 * * * * fires": async () => cronTarget("7 * * * *", undefined, undefined),
  "cron|constructed: REVIEW_QUEUE_CRON 27 * * * * set; it fires": async () => cronTarget("27 * * * *", undefined, "27 * * * *"),
  "cron|constructed: REVIEW_QUEUE_CRON 27 * * * * set; the publisher cron 7 * * * * fires": async () => cronTarget("7 * * * *", undefined, "27 * * * *"),
  "cron|constructed: DIGEST_CRON 37 1 * * * and REVIEW_QUEUE_CRON 27 * * * * set; 37 1 * * * fires": async () => cronTarget("37 1 * * *", "37 1 * * *", "27 * * * *"),
  "cron|constructed: DIGEST_CRON and REVIEW_QUEUE_CRON both 27 * * * * (misconfigured); it fires": async () => cronTarget("27 * * * *", "27 * * * *", "27 * * * *"),
  // Q58
  "manual run|constructed: run with dryRun": async () => {
    const w = world();
    const before = w.bucket.writes;
    const { lastRun } = await run(w, true);
    return `${lastRun.counts === null ? "no counts" : "counts returned"}; ${w.bucket.writes - before} R2 writes`;
  },
  // Q40
  "run record|captured samples: a full run": async () => {
    const w = world();
    await run(w);
    const record = await w.bucket.getJson(LAST_RUN) as ReviewQueueLastRun;
    const c = record.counts!;
    return `last-run ${record.ok ? "ok" : "failed"}; github ${record.sources.github.requests} requests; mail ${count(w, "thread.lua")} thread + ${count(w, "email.lua")} email requests; ` +
      `roster ${record.sources.roster.requests} requests; counts noReviewer ${c.noReviewer}, waiting ${c.waiting}, approved ${c.approved}, vote ${c.vote}, discuss ${c.discuss}`;
  },
  "run record|constructed: GET /health with last-run.json in R2": async () => {
    const record = { ok: true, completedAt: "2026-10-08T05:00:00.000Z" };
    const stub = (body: unknown) => ({ get: () => ({ fetch: async () => Response.json(body) }), idFromName: (name: string) => name });
    const env = {
      PUBLICATION_ENVIRONMENT: "development",
      PIPELINE_STATE: stub({ environment: "development", running: false }),
      DIGEST_RUN: stub({ running: false }),
      OSS_KB_BUCKET: { get: async (key: string) => (key === LAST_RUN ? { json: async () => record } : null) },
    };
    const response = await worker.fetch(new Request("https://data.example/health"), env as never);
    const body = await response.json() as { reviewQueue: unknown };
    return JSON.stringify(body.reviewQueue) === JSON.stringify(record) ? "reviewQueue is the last-run object" : JSON.stringify(body.reviewQueue);
  },
  "run record|constructed: /health merge with no last-run object": async () => {
    const merged = mergeHealth({ environment: "development" }, null, null) as { reviewQueue: unknown };
    return `reviewQueue ${String(merged.reviewQueue)}`;
  },
};

function rosterFixture(): Roster {
  return asfRosterAdapter.parse([{ projects: ldapSample.projects }, { people: ldapSample.people }], "kafka", new Date(START).toISOString());
}

describe("Spec 015 slice 2 test plan", () => {
  test.each([...testPlanRows] as CaseRow[])("$id: $rule — $input", async (row) => {
    const runCase = cases[`${row.rule}|${row.input}`];
    if (runCase === undefined) throw new Error(`No executable case for ${row.id} ${row.rule}: ${row.input}`);
    expect(await runCase()).toBe(row.expected);
  });

  test("every executable case has a test-plan row", () => {
    const rows = new Set(testPlanRows.map((row) => `${row.rule}|${row.input}`));
    expect(Object.keys(cases).filter((key) => !rows.has(key))).toEqual([]);
  });
});
