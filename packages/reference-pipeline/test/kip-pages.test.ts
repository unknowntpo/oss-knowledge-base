import { describe, expect, test } from "bun:test";
import { testPlanRows } from "./kip-pages.cases";
import {
  KAFKA_KIP_PAGES,
  KIP_PAGES_BUDGET,
  KIP_PAGES_LAST_RUN_KEY,
  KIP_PAGES_REVISION,
  kipAuthorsKey,
  parseKipHeader,
  runKipPages,
  type KipAuthorsTableV1,
  type KipPagesBucket,
  type KipPagesHealthV1,
  type KipPagesRunDeps,
} from "../src/people/kip-pages";

interface RecordedPage {
  readonly id: string;
  readonly title: string;
  readonly version: { readonly number: number };
  readonly body: { readonly view: { readonly value: string } };
}
interface RecordedSearch { readonly results: readonly RecordedPage[]; readonly _links: Record<string, string> }

const fixture = (name: string) => Bun.file(new URL(`./fixtures/kip-pages/${name}`, import.meta.url)).json();
const kips = await fixture("cwiki-kips-2026-10-21.json") as { readonly responses: readonly RecordedSearch[] };
const windowFixture = await fixture("cwiki-window-2026-10-21.json") as { readonly window: RecordedSearch; readonly paging: RecordedSearch; readonly index: RecordedSearch };
const jiraFixture = await fixture("jira-assignees-2026-10-21.json") as { readonly response: { readonly issues: readonly unknown[] } };
const recordedPages = kips.responses.flatMap((response) => response.results);

function recorded(kip: number, pageId?: string): RecordedPage {
  const page = recordedPages.find((value) => value.title.startsWith(`KIP-${kip}:`) && (pageId === undefined || value.id === pageId));
  if (page === undefined) throw new Error(`no recorded page for KIP-${kip}`);
  return page;
}
const header = (kip: number, pageId?: string) => parseKipHeader(recorded(kip, pageId).body.view.value, KAFKA_KIP_PAGES);
const names = (kip: number, pageId?: string) => header(kip, pageId).authors.map((author) => author.name);
const constructedHeader = (html: string) => parseKipHeader(`<h1>Status</h1>${html}<h1>Motivation</h1><p>Authors: Not Me</p>`, KAFKA_KIP_PAGES);

/** An in-memory bucket that records every call, by billing class. */
class MemoryBucket implements KipPagesBucket {
  readonly objects = new Map<string, string>();
  readonly calls: string[] = [];
  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) this.objects.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  async get(key: string): Promise<string | undefined> {
    this.calls.push(`get ${key}`);
    return this.objects.get(key);
  }
  async put(key: string, body: string): Promise<void> {
    this.calls.push(`put ${key}`);
    this.objects.set(key, body);
  }
  puts(): string[] { return this.calls.filter((call) => call.startsWith("put ")); }
  table(): KipAuthorsTableV1 | undefined {
    const body = this.objects.get(kipAuthorsKey("apache-kafka"));
    return body === undefined ? undefined : JSON.parse(body) as KipAuthorsTableV1;
  }
  health(): KipPagesHealthV1 { return JSON.parse(this.objects.get(KIP_PAGES_LAST_RUN_KEY)!) as KipPagesHealthV1; }
}

type Answer = Response | Error | ((url: string) => Response | Error);
interface Upstream {
  readonly fetch: KipPagesRunDeps["fetch"];
  readonly requests: { readonly url: string; readonly init: RequestInit | undefined }[];
  readonly delays: number[];
  readonly events: string[];
}

/** A stub upstream: cwiki and Jira answers in order; anything past them fails the test. */
function upstream(cwiki: readonly Answer[], jira: readonly Answer[] = []): Upstream {
  const queues = { cwiki: [...cwiki], jira: [...jira] };
  const requests: Upstream["requests"] = [];
  const delays: number[] = [];
  const events: string[] = [];
  return {
    requests,
    delays,
    events,
    fetch: async (url, init) => {
      requests.push({ url, init });
      const host = url.startsWith("https://cwiki.apache.org/") ? "cwiki" : url.startsWith("https://issues.apache.org/jira/") ? "jira" : undefined;
      events.push(`fetch ${host ?? url}`);
      if (host === undefined) throw new Error(`unexpected request ${url}`);
      const next = queues[host].shift();
      if (next === undefined) throw new Error(`no ${host} answer left for ${url}`);
      const answer = typeof next === "function" ? next(url) : next;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const BASE = "https://cwiki.apache.org/confluence";
function searchAnswer(results: readonly unknown[], next?: string) {
  return json({ results, start: 0, limit: 50, size: results.length, _links: { base: BASE, context: "/confluence", ...(next === undefined ? {} : { next }) } });
}
function fakePage(kip: number, version: number, html: string, id = String(900_000 + kip)) {
  return { id, type: "page", status: "current", title: `KIP-${kip}: Constructed page ${kip}`, version: { number: version, by: { username: "someone", userKey: "8aa9", displayName: "Some One" } }, body: { view: { value: html, representation: "view" } } };
}
const jiraHeader = (...keys: string[]) => `<h1>Status</h1><p>JIRA: ${keys.map((key) => `<a href="https://issues.apache.org/jira/browse/${key}">${key}</a>`).join(", ")}</p><h1>Motivation</h1>`;
function jiraAnswer(issues: readonly { key: string; assignee: { key: string; displayName: string } | null }[]) {
  return json({ startAt: 0, maxResults: 100, total: issues.length, issues: issues.map((issue) => ({ key: issue.key, fields: { assignee: issue.assignee } })) });
}

// 2026-10-21 is a Wednesday; 2026-10-19 a Monday.
const WEDNESDAY = Date.parse("2026-10-21T03:43:00Z");
const MONDAY = Date.parse("2026-10-19T03:43:00Z");

function deps(bucket: MemoryBucket, source: Upstream, now = WEDNESDAY, extra: Partial<KipPagesRunDeps> = {}): KipPagesRunDeps {
  return {
    flag: KIP_PAGES_REVISION,
    profile: KAFKA_KIP_PAGES,
    bucket,
    fetch: source.fetch,
    now: () => now,
    delay: async (ms) => { source.delays.push(ms); source.events.push(`delay ${ms}`); },
    ...extra,
  };
}

/** A previous good state: a table and the run record that wrote it. */
function previous(pages: KipAuthorsTableV1["pages"], lastGoodAt = "2026-10-20T03:43:00.000Z") {
  const table: KipAuthorsTableV1 = { schema: "osskb.kip-authors.v1", generatedAt: lastGoodAt, coverageFrom: "2025-10-21T03:43:00.000Z", pages };
  const health: KipPagesHealthV1 = {
    revision: KIP_PAGES_REVISION,
    lastRun: null,
    lastGoodAt,
    coverageFrom: table.coverageFrom,
  };
  return { [kipAuthorsKey("apache-kafka")]: table, [KIP_PAGES_LAST_RUN_KEY]: health };
}
function tablePage(kip: number, version: number, keys: readonly string[], assignee: (key: string, index: number) => { key: string; display: string } | null = () => null, readAt = "2026-10-20T03:43:00.000Z"): KipAuthorsTableV1["pages"][number] {
  return {
    kip, pageId: String(900_000 + kip), version, title: `KIP-${kip}: Constructed page ${kip}`, url: `${BASE}/pages/viewpage.action?pageId=${900_000 + kip}`,
    status: "no-list", authors: [], jira: keys.length === 0 ? "empty" : keys.length === 1 ? "one" : "several",
    issues: keys.map((key, index) => ({ key, assignee: assignee(key, index), readAt })),
  };
}
const keysOf = (url: string) => /key in \(([^)]*)\)/u.exec(new URL(url).searchParams.get("jql") ?? "")?.[1]?.split(",") ?? [];

async function failClosed(answer: Answer) {
  const before = previous([tablePage(1, 1, ["KAFKA-1001"])]);
  const bucket = new MemoryBucket(before);
  const source = upstream([answer]);
  const result = await runKipPages(deps(bucket, source));
  expect(result.lastRun?.ok).toBe(false);
  expect(result.lastRun?.status).toBe("failed");
  expect(result.lastRun?.requests).toBe(1);
  expect(source.requests.length).toBe(1);
  expect(bucket.puts()).toEqual([`put ${KIP_PAGES_LAST_RUN_KEY}`]);
  expect(bucket.objects.get(kipAuthorsKey("apache-kafka"))).toBe(JSON.stringify(before[kipAuthorsKey("apache-kafka")]));
  expect(result.lastGoodAt).toBe("2026-10-20T03:43:00.000Z");
  return result;
}

const checks: Record<string, () => Promise<void> | void> = {
  "W93 a plain list of nine": () => {
    expect(header(1165).status).toBe("listed");
    expect(names(1165)).toEqual(["Greg Harris", "Ivan Yurchenko", "Jorge Quilcate", "Giuseppe Lillo", "Anatolii Popov", "Juha Mynttinen", "Josep Prat", "Filip Yonov", "Viktor Somogyi-Vass"]);
    expect(header(1165).authors.at(-1)).toEqual({ name: "Viktor Somogyi-Vass", nameKey: "viktor somogyi-vass" });
  },
  "W93 a plain list across spans": () => {
    expect(header(1360).status).toBe("listed");
    expect(names(1360)).toEqual(["Omnia Ibrahim", "Gaurav Narula", "Luke Chen", "Federico Valeri"]);
  },
  "W93 the line ends at its block": () => {
    expect(header(1279).status).toBe("listed");
    expect(names(1279)).toEqual(["Luke Chen", "Federico Valeri", "Omnia Ibrahim", "Gaurav Narula"]);
  },
  "W93 user mentions": () => {
    expect(header(952).status).toBe("listed");
    expect(names(952)).toEqual(["Mital Awachat", "Christo Lolov"]);
  },
  "W93 an email in the line": () => {
    expect([header(1183).status, names(1183)]).toEqual(["listed", ["xinyu"]]);
    expect([header(1300, "406622741").status, names(1300, "406622741")]).toEqual(["listed", ["Viquar Khan"]]);
    expect(JSON.stringify([header(1183), header(1300, "406622741")])).not.toContain("@");
  },
  "W93 a parenthesized co-author": () => {
    expect(header(1258).status).toBe("listed");
    expect(names(1258)).toEqual(["ujjwal kalia", "Ujjwal Kalia"]);
  },
  "W93 a line under the Status heading": () => {
    expect([header(1026).status, names(1026)]).toEqual(["listed", ["Arpit Goyal"]]);
  },
  "W93 a block that does not start with the label": () => {
    expect(header(986)).toMatchObject({ status: "no-list", authors: [] });
    // Positive control: the same words at the start of the block are a line (and not a list).
    expect(constructedHeader("<p><em>Co-Authors: None of the below contents is final or necessarily correct.</em></p>").status).toBe("unparsed");
  },
  "W93 not a list": () => {
    expect(constructedHeader("<p><strong>Authors:</strong> the Kafka streams team, see the discussion thread for the full list of people</p>")).toMatchObject({ status: "unparsed", authors: [] });
    // One bad part spoils the line: no partial list.
    expect(constructedHeader("<p>Authors: Greg Harris, see the discussion thread for the full list of people</p>")).toMatchObject({ status: "unparsed", authors: [] });
    // Positive control: the first part alone is a list.
    expect(constructedHeader("<p>Authors: Greg Harris</p>")).toMatchObject({ status: "listed", authors: [{ name: "Greg Harris", nameKey: "greg harris" }] });
  },
  "W93 no author line": () => {
    expect(header(1371)).toMatchObject({ status: "no-list", authors: [] });
    expect(header(1128).status).toBe("no-list");
  },
  "W93 collaborators are not authors": () => {
    expect(names(950)).toEqual(["Mehari Beyene", "Divij Vaidya"]);
    expect(JSON.stringify(header(950))).not.toContain("Karthik");
    expect(constructedHeader("<p>Collaborators: Karthik Rajagopalan</p><p>Contributors: Luke Chen</p>").status).toBe("no-list");
  },
  "W93 the word and, & and ;": () => {
    expect(constructedHeader("<p>Authors: Henry Cai; Tom Thornton &amp; Greg Harris and Anna Müller-O'Brien</p>").authors.map((author) => author.name))
      .toEqual(["Henry Cai", "Tom Thornton", "Greg Harris", "Anna Müller-O'Brien"]);
    // "and" inside a name is not a separator.
    expect(constructedHeader("<p>Author: Andrew Anderson</p>").authors.map((author) => author.name)).toEqual(["Andrew Anderson"]);
  },
  "W107 one issue": () => {
    expect(header(1371)).toMatchObject({ jira: "one", keys: ["KAFKA-20995"] });
    expect(header(1165)).toMatchObject({ jira: "one", keys: ["KAFKA-19161"] });
    expect(header(1026)).toMatchObject({ jira: "one", keys: ["KAFKA-16209"] });
  },
  "W107 several issues": () => {
    expect(header(1370)).toMatchObject({ jira: "several", keys: ["KAFKA-20888", "KAFKA-20883"] });
  },
  "W107 several issues as links": () => {
    expect(header(1105)).toMatchObject({ jira: "several", keys: ["KAFKA-17928", "KAFKA-17980"] });
    expect(header(1128)).toMatchObject({ jira: "several", keys: ["KAFKA-17178", "KAFKA-17131", "KAFKA-19688"] });
  },
  "W107 empty": () => {
    expect(header(1383)).toMatchObject({ jira: "empty", keys: [] });
    expect(header(1183)).toMatchObject({ jira: "empty", keys: [] });
  },
  "W107 the template's link": () => {
    expect(constructedHeader('<p><strong>JIRA</strong>: <a href="https://issues.apache.org/jira/browse/KAFKA-1">here</a> [Change the link from KAFKA-1 to your own ticket]</p>')).toMatchObject({ jira: "empty", keys: [] });
    // Positive control: KAFKA-10 is not the template's KAFKA-1.
    expect(constructedHeader("<p>JIRA: KAFKA-10</p>")).toMatchObject({ jira: "one", keys: ["KAFKA-10"] });
  },
  "W107 a query macro": () => {
    expect(constructedHeader('<p>JIRA: <span class="jira-issues conf-macro output-block" data-macro-name="jira" data-hasbody="false">jqlQuery: labels = kip-1</span></p>')).toMatchObject({ jira: "query", keys: [] });
  },
  "W107 no field": () => {
    expect(parseKipHeader(windowFixture.index.results[0]!.body.view.value, KAFKA_KIP_PAGES)).toMatchObject({ jira: "none", keys: [], status: "no-list" });
    expect(constructedHeader("<p>Discussion thread: here</p>")).toMatchObject({ jira: "none", keys: [] });
  },
  "W108 batching and unknown keys": async () => {
    const keys = [...Array.from({ length: 159 }, (_, index) => `KAFKA-${20_000 + index}`), "KAFKA-99999999"];
    const page = fakePage(5000, 1, jiraHeader(...keys));
    const bucket = new MemoryBucket();
    const known = (url: string) => jiraAnswer(keysOf(url).filter((key) => key !== "KAFKA-99999999").map((key) => ({ key, assignee: { key: "JIRAUSER1", displayName: "A B" } })));
    const source = upstream([searchAnswer([page])], [known, known]);
    const result = await runKipPages(deps(bucket, source));
    const jiraUrls = source.requests.filter((request) => request.url.startsWith("https://issues.apache.org/")).map((request) => new URL(request.url));
    expect(jiraUrls.map((url) => keysOf(url.href).length)).toEqual([100, 60]);
    for (const url of jiraUrls) {
      expect(url.origin + url.pathname).toBe("https://issues.apache.org/jira/rest/api/2/search");
      expect(url.searchParams.get("fields")).toBe("assignee");
      expect(url.searchParams.get("validateQuery")).toBe("warn");
      expect(url.searchParams.get("maxResults")).toBe("100");
    }
    expect(result.lastRun).toMatchObject({ ok: true, jiraRequests: 2, issuesRead: 159 });
    const stored = bucket.table()!.pages[0]!;
    expect(stored.jira).toBe("several");
    expect(stored.issues.length).toBe(159);
    expect(stored.issues.some((issue) => issue.key === "KAFKA-99999999")).toBe(false);
  },
  "W108 recorded assignees": async () => {
    const pages = [recorded(1165), recorded(1360), recorded(1105)];
    const bucket = new MemoryBucket();
    const source = upstream([searchAnswer(pages)], [json(jiraFixture.response)]);
    const result = await runKipPages(deps(bucket, source));
    expect(result.lastRun?.ok).toBe(true);
    const issues = Object.fromEntries(bucket.table()!.pages.map((page) => [page.kip, page.issues.map((issue) => [issue.key, issue.assignee])]));
    expect(issues).toEqual({
      1105: [["KAFKA-17928", { key: "JIRAUSER306303", display: "Chu Cheng Li" }], ["KAFKA-17980", { key: "ckamal", display: "Kamal Chandraprakash" }]],
      1165: [["KAFKA-19161", { key: "ivanyu", display: "Ivan Yurchenko" }]],
      1360: [["KAFKA-20715", null]],
    });
    expect(result.lastRun).toMatchObject({ issuesRead: 4, unassigned: 1 });
  },
  "W108 Jira fails": async () => {
    const before = previous([tablePage(1, 1, ["KAFKA-1001"])]);
    const bucket = new MemoryBucket(before);
    const source = upstream([searchAnswer([fakePage(1, 2, jiraHeader("KAFKA-1002"))])], [json("Service Unavailable", 503)]);
    const result = await runKipPages(deps(bucket, source));
    expect(result.lastRun).toMatchObject({ ok: false, status: "failed", requests: 1, jiraRequests: 1 });
    expect(bucket.puts()).toEqual([`put ${KIP_PAGES_LAST_RUN_KEY}`]);
    expect(bucket.objects.get(kipAuthorsKey("apache-kafka"))).toBe(JSON.stringify(before[kipAuthorsKey("apache-kafka")]));
    // Positive control: the same run with Jira answering writes the new issue.
    const ok = new MemoryBucket(before);
    await runKipPages(deps(ok, upstream([searchAnswer([fakePage(1, 2, jiraHeader("KAFKA-1002"))])], [jiraAnswer([{ key: "KAFKA-1002", assignee: null }])])));
    expect(ok.table()!.pages[0]!.issues.map((issue) => issue.key)).toEqual(["KAFKA-1002"]);
  },
  "W108 Monday re-read": async () => {
    const pages = Array.from({ length: 80 }, (_, index) => tablePage(index + 1, 1, [`KAFKA-${3000 + 2 * index}`, `KAFKA-${3001 + 2 * index}`]));
    const bucket = new MemoryBucket(previous(pages));
    const answer = (url: string) => jiraAnswer(keysOf(url).map((key) => ({ key, assignee: null })));
    const source = upstream([searchAnswer([])], [answer, answer]);
    const result = await runKipPages(deps(bucket, source, MONDAY));
    expect(result.lastRun).toMatchObject({ ok: true, requests: 1, jiraRequests: 2, issuesRead: 160 });
    expect(new Set(bucket.table()!.pages.flatMap((page) => page.issues.map((issue) => issue.readAt)))).toEqual(new Set(["2026-10-19T03:43:00.000Z"]));
    // Positive control: the same table on a Wednesday reads no issue.
    const wednesday = new MemoryBucket(previous(pages));
    const quiet = upstream([searchAnswer([])]);
    expect((await runKipPages(deps(wednesday, quiet))).lastRun).toMatchObject({ ok: true, requests: 1, jiraRequests: 0, status: "unchanged" });
  },
  "W108 Monday cap": async () => {
    const pages = Array.from({ length: 350 }, (_, index) => tablePage(index + 1, 1, [`KAFKA-${4000 + index}`], () => null,
      new Date(Date.parse("2026-10-01T00:00:00Z") + index * 60_000).toISOString()));
    const bucket = new MemoryBucket(previous(pages));
    const answer = (url: string) => jiraAnswer(keysOf(url).map((key) => ({ key, assignee: null })));
    const source = upstream([searchAnswer([fakePage(350, 2, jiraHeader("KAFKA-4349"))])], [answer, answer, answer]);
    const result = await runKipPages(deps(bucket, source, MONDAY));
    expect(result.lastRun).toMatchObject({ ok: true, jiraRequests: 3, issuesRead: 300 });
    const read = source.requests.filter((request) => request.url.startsWith("https://issues.apache.org/")).flatMap((request) => keysOf(request.url));
    expect(read[0]).toBe("KAFKA-4349");
    expect(read.slice(1)).toEqual(Array.from({ length: 299 }, (_, index) => `KAFKA-${4000 + index}`));
  },
  "W108 a re-read replaces the assignee": async () => {
    const before = previous([tablePage(7, 1, ["KAFKA-7000"], () => ({ key: "a-key", display: "Person A" }))]);
    const bucket = new MemoryBucket(before);
    const source = upstream([searchAnswer([fakePage(7, 2, jiraHeader("KAFKA-7000"))])], [jiraAnswer([{ key: "KAFKA-7000", assignee: { key: "b-key", displayName: "Person B" } }])]);
    await runKipPages(deps(bucket, source));
    const text = bucket.objects.get(kipAuthorsKey("apache-kafka"))!;
    expect(bucket.table()!.pages[0]!.issues).toEqual([{ key: "KAFKA-7000", assignee: { key: "b-key", display: "Person B" }, readAt: "2026-10-21T03:43:00.000Z" }]);
    expect(text).not.toContain("Person A");
  },
  "W110 Jira fields kept": async () => {
    const bucket = new MemoryBucket();
    const source = upstream([searchAnswer([recorded(1371)])], [json(jiraFixture.response)]);
    await runKipPages(deps(bucket, source));
    expect(bucket.table()!.pages[0]!.issues).toEqual([{ key: "KAFKA-20995", assignee: { key: "JIRAUSER306218", display: "Eric Chang" }, readAt: "2026-10-21T03:43:00.000Z" }]);
    const reporter = (jiraFixture.response.issues.find((issue) => (issue as { key: string }).key === "KAFKA-20995") as { fields: { reporter: { name: string } } }).fields.reporter;
    for (const text of [bucket.objects.get(kipAuthorsKey("apache-kafka"))!, bucket.objects.get(KIP_PAGES_LAST_RUN_KEY)!]) {
      for (const field of ["reporter", "\"name\"", "timeZone", "avatarUrls", "active", "emailAddress", "self"]) expect(text).not.toContain(field);
      if (reporter.name !== "unknowntpo") expect(text).not.toContain(reporter.name);
    }
  },
  "W102 names only": async () => {
    const bucket = new MemoryBucket();
    const source = upstream([searchAnswer(recordedPages)], [json(jiraFixture.response)]);
    const result = await runKipPages(deps(bucket, source));
    expect(result.lastRun?.ok).toBe(true);
    const stored = [bucket.objects.get(kipAuthorsKey("apache-kafka"))!, bucket.objects.get(KIP_PAGES_LAST_RUN_KEY)!].join("\n");
    expect(stored.replaceAll(KIP_PAGES_REVISION, "")).not.toContain("@");
    // A Jira account key may equal a Confluence username (`ckamal`); keys are stored as assignees, usernames never.
    const jiraKeys = new Set(bucket.table()!.pages.flatMap((page) => page.issues.flatMap((issue) => (issue.assignee === null ? [] : [issue.assignee.key]))));
    for (const page of recordedPages) {
      const by = (page.version as unknown as { by: { username: string; userKey: string } }).by;
      expect(stored).not.toContain(by.userKey);
      if (!jiraKeys.has(by.username)) expect(stored).not.toContain(`"${by.username}"`);
    }
    for (const forbidden of ["username", "userKey", "profilePicture", "avatar", "data-username", "mital.awachat", "christo_lolov", "Please keep the discussion", "This design follows"]) {
      expect(stored).not.toContain(forbidden);
    }
    // Positive control: the names themselves are stored.
    expect(stored).toContain("Viktor Somogyi-Vass");
    expect(stored).toContain("Mital Awachat");
  },
  "W97 a 429": async () => {
    await failClosed(json("Too Many Requests", 429));
  },
  "W97 a 5xx, a timeout, unparsable JSON": async () => {
    await failClosed(json("Bad Gateway", 502));
    const timeout = await failClosed(new DOMException("The operation timed out.", "TimeoutError") as unknown as Error);
    expect(timeout.lastRun?.error).toContain("timed out");
    await failClosed(json("<html>busy</html>"));
    await failClosed(json({ results: "not a list" }));
  },
  "W97 over budget": async () => {
    const before = previous([tablePage(1, 1, [])]);
    const bucket = new MemoryBucket(before);
    const pageAnswers = Array.from({ length: 11 }, (_, index) => searchAnswer([fakePage(100 + index, 1, "<p>x</p>")], `/rest/api/content/search?start=${50 * (index + 1)}`));
    const source = upstream(pageAnswers);
    const result = await runKipPages(deps(bucket, source));
    expect(result.lastRun).toMatchObject({ ok: false, status: "over-budget", requests: KIP_PAGES_BUDGET.cwikiRequests, since: "2026-10-19T03:43:00.000Z" });
    expect(source.requests.length).toBe(10);
    expect(bucket.puts()).toEqual([`put ${KIP_PAGES_LAST_RUN_KEY}`]);
    // The next run starts from the same since, because the last good run did not move.
    const next = upstream([searchAnswer([])]);
    const again = await runKipPages(deps(bucket, next, WEDNESDAY + 3_600_000));
    expect(again.lastRun?.since).toBe("2026-10-19T03:43:00.000Z");
  },
  "W97 positive control": async () => {
    const bucket = new MemoryBucket(previous([]));
    const pages = Array.from({ length: 25 }, (_, index) => fakePage(200 + index, 1, "<h1>Status</h1><p>JIRA: TBD</p>"));
    const source = upstream([searchAnswer(pages)]);
    const result = await runKipPages(deps(bucket, source));
    expect(result.lastRun).toMatchObject({ ok: true, status: "ok", requests: 1, pagesRead: 25, pagesChanged: 25 });
    expect(bucket.table()!.pages.length).toBe(25);
    expect(result.lastGoodAt).toBe("2026-10-21T03:43:00.000Z");
  },
  "W101 pacing": async () => {
    const bucket = new MemoryBucket();
    const source = upstream([
      searchAnswer([fakePage(1, 1, jiraHeader("KAFKA-1100"))], "/rest/api/content/search?start=50"),
      searchAnswer([fakePage(2, 1, "<p/>")], "/rest/api/content/search?start=100"),
      searchAnswer([fakePage(3, 1, "<p/>")]),
    ], [jiraAnswer([{ key: "KAFKA-1100", assignee: null }])]);
    await runKipPages(deps(bucket, source));
    expect(source.events).toEqual(["fetch cwiki", "delay 2000", "fetch cwiki", "delay 2000", "fetch cwiki", "delay 2000", "fetch jira"]);
    expect(source.requests[1]!.url).toBe(`${BASE}/rest/api/content/search?start=50`);
    for (const request of source.requests) {
      expect(new Headers(request.init?.headers).get("user-agent")).toContain("https://github.com/unknowntpo/oss-knowledge-base");
      expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(KIP_PAGES_BUDGET).toEqual({ cwikiRequests: 10, jiraRequests: 3, jiraKeysPerRequest: 100, spacingMs: 2000, timeoutMs: 30_000 });
  },
  "W105 a new version": async () => {
    const bucket = new MemoryBucket(previous([tablePage(9, 3, [])]));
    const source = upstream([searchAnswer([fakePage(9, 4, "<p>Authors: New Name</p>")])]);
    const result = await runKipPages(deps(bucket, source));
    expect(result.lastRun).toMatchObject({ status: "ok", pagesChanged: 1 });
    expect(bucket.table()!.pages).toMatchObject([{ kip: 9, version: 4, status: "listed", authors: [{ name: "New Name" }] }]);
  },
  "W105 unchanged": async () => {
    const before = previous([tablePage(9, 3, [])]);
    const bucket = new MemoryBucket(before);
    // The answer holds the same version with a different body: the stored entry is kept, not re-read.
    const source = upstream([searchAnswer([fakePage(9, 3, "<p>Authors: Someone Else</p>")])]);
    const result = await runKipPages(deps(bucket, source));
    expect(result.lastRun).toMatchObject({ ok: true, status: "unchanged", pagesRead: 1, pagesChanged: 0, bytesWritten: 0, r2: { classA: 1, classB: 2 } });
    expect(bucket.puts()).toEqual([`put ${KIP_PAGES_LAST_RUN_KEY}`]);
    expect(result.lastGoodAt).toBe("2026-10-21T03:43:00.000Z");
  },
  "W105 the window": async () => {
    const withTable = upstream([searchAnswer([])]);
    const first = await runKipPages(deps(new MemoryBucket(previous([], "2026-10-21T03:43:00.000Z")), withTable, Date.parse("2026-10-22T03:43:00Z")));
    expect(first.lastRun?.since).toBe("2026-10-20T03:43:00.000Z");
    const cql = new URL(withTable.requests[0]!.url).searchParams.get("cql");
    expect(cql).toBe('space=KAFKA and type=page and title~"KIP" and lastmodified >= "2026-10-20" order by lastmodified asc');
    expect(new URL(withTable.requests[0]!.url).searchParams.get("expand")).toBe("body.view,version");
    expect(new URL(withTable.requests[0]!.url).searchParams.get("limit")).toBe("50");
    const empty = upstream([searchAnswer([])]);
    const none = await runKipPages(deps(new MemoryBucket(), empty));
    expect(none.lastRun?.since).toBe("2025-10-21T03:43:00.000Z");
    expect(none.coverageFrom).toBe("2025-10-21T03:43:00.000Z");
  },
  "W105 a page without a KIP number": async () => {
    const bucket = new MemoryBucket();
    const source = upstream([searchAnswer([...windowFixture.index.results, recorded(1371)])], [json(jiraFixture.response)]);
    const result = await runKipPages(deps(bucket, source));
    expect(result.lastRun).toMatchObject({ pagesRead: 2, pagesChanged: 1 });
    expect(bucket.table()!.pages.map((page) => page.kip)).toEqual([1371]);
  },
  "W105 byte-equal": async () => {
    const results = [...windowFixture.window.results, recorded(1300, "406622741"), recorded(1300, "406623554")];
    const jiraKeys = (url: string) => jiraAnswer(keysOf(url).map((key) => ({ key, assignee: null })));
    const a = new MemoryBucket();
    await runKipPages(deps(a, upstream([searchAnswer(results)], [jiraKeys])));
    const b = new MemoryBucket();
    await runKipPages(deps(b, upstream([searchAnswer([...results].reverse())], [jiraKeys])));
    expect(a.objects.get(kipAuthorsKey("apache-kafka"))).toBe(b.objects.get(kipAuthorsKey("apache-kafka"))!);
    const table = a.table()!;
    expect(table.pages.map((page) => `${page.kip}/${page.pageId}`)).toEqual([...table.pages.map((page) => `${page.kip}/${page.pageId}`)].sort((x, y) => {
      const [kx, px] = x.split("/").map(Number) as [number, number];
      const [ky, py] = y.split("/").map(Number) as [number, number];
      return kx - ky || px - py;
    }));
    expect(table.pages.filter((page) => page.kip === 1300).map((page) => page.pageId)).toEqual(["406622741", "406623554"]);
    // KIP-1376's issue and KIP-1163's author line, as recorded.
    expect(table.pages.find((page) => page.kip === 1376)).toMatchObject({ status: "no-list", jira: "one", issues: [{ key: "KAFKA-20728" }] });
    expect(table.pages.find((page) => page.kip === 1163)?.authors.length).toBe(8);
  },
};

describe("Spec 019 amendment (7) slice B: the kip-pages job", () => {
  test("every case row has a check and every check a row", () => {
    expect(Object.keys(checks).sort()).toEqual(testPlanRows.map((row) => `${row.id} ${row.case}`).sort());
  });

  test.each([...testPlanRows])("$id: $case ($data)", async (row) => {
    const check = checks[`${row.id} ${row.case}`];
    if (check === undefined) throw new Error(`no check for ${row.id} ${row.case}`);
    await check();
  });

  test("W100: the run record has the /health shape, with the flag's revision", async () => {
    const bucket = new MemoryBucket();
    const result = await runKipPages(deps(bucket, upstream([searchAnswer([recorded(1371)])], [json(jiraFixture.response)])));
    expect(Object.keys(result).sort()).toEqual(["coverageFrom", "lastGoodAt", "lastRun", "revision"]);
    expect(Object.keys(result.lastRun!).sort()).toEqual(["at", "bytesWritten", "durationMs", "issuesRead", "jiraRequests", "listed", "ok", "pagesChanged", "pagesRead", "r2", "requests", "since", "status", "unassigned", "unparsed"]);
    expect(result).toMatchObject({ revision: "authors@1", lastRun: { ok: true, status: "ok", listed: 0, unparsed: 0, r2: { classA: 2, classB: 2 } } });
    expect(bucket.health()).toEqual(result);
  });

  test("W100: an unsupported flag value fails the run without an upstream request", async () => {
    const bucket = new MemoryBucket();
    const source = upstream([]);
    const result = await runKipPages(deps(bucket, source, WEDNESDAY, { flag: "true" }));
    expect(result.lastRun).toMatchObject({ ok: false, status: "failed" });
    expect(result.lastRun?.error).toContain("KIP_PAGES");
    expect(source.requests).toEqual([]);
  });

  test("W105: a dry run reads and parses but writes nothing", async () => {
    const bucket = new MemoryBucket();
    const result = await runKipPages(deps(bucket, upstream([searchAnswer([recorded(1165)])], [json(jiraFixture.response)]), WEDNESDAY, { dryRun: true }));
    expect(result.lastRun).toMatchObject({ ok: true, listed: 1, bytesWritten: 0, r2: { classA: 0 } });
    expect(bucket.puts()).toEqual([]);
  });

  test("W97: an unreadable previous table fails the run before any upstream request", async () => {
    const bucket = new MemoryBucket({ [kipAuthorsKey("apache-kafka")]: "{not json" });
    const source = upstream([]);
    const result = await runKipPages(deps(bucket, source));
    expect(result.lastRun).toMatchObject({ ok: false, status: "failed", requests: 0 });
    expect(bucket.objects.get(kipAuthorsKey("apache-kafka"))).toBe("{not json");
  });
});
