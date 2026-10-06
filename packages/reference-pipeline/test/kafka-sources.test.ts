/**
 * Spec 012 rules, run from the test-plan case file. Each row's prose input maps to one
 * executable case below that computes the row's `expected` text from the real functions.
 */
import { describe, expect, test } from "bun:test";

import {
  extractKeys,
  isJiraPublished,
  jiraEventsFrom,
  jiraLinkIndex,
  jiraStatus,
  jiraWindow,
  JiraConnector,
  mailEventFrom,
  mailWindow,
  MAX_RESPONSE_CHARS,
  PonyMailConnector,
  ReferenceStateStore,
  threadKey,
  type GitHubCheckpointV1,
  type SourceFetch,
  type SourceHttpResponse,
  type SourcePollResult,
} from "../src";
import fixture from "./fixtures/kafka-sources.v1.json";
import { testPlanRows } from "./kafka-sources.cases";

const NOW = "2026-10-06T08:00:00.000Z";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const VOTE = "[VOTE] KIP-1279: Cluster Mirroring";

function before(ms: number): string {
  return new Date(Date.parse(NOW) - ms).toISOString();
}

function email(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mid: "15rddlqk42tqsjh5rw2r6so5cgns122f",
    epoch: Date.parse("2026-09-18T16:06:37Z") / 1000,
    subject: `Re: ${VOTE}`,
    from: "Federico Valeri <fe...@gmail.com>",
    body: "Hi all, the vote for KIP-1279 has passed.",
    ...overrides,
  };
}

function mail(overrides: Record<string, unknown> = {}) {
  const parsed = mailEventFrom(email(overrides), NOW);
  if (parsed.kind !== "event") throw new Error(`expected a mail event, got ${parsed.kind}`);
  return parsed.event;
}

function data(event: { readonly data: unknown }): Record<string, unknown> & { kips: string[]; issueKeys: string[] } {
  return event.data as never;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(",");
}

function response(status: number, body: string, headers: Record<string, string> = {}): SourceHttpResponse {
  return { status, headers: new Headers(headers), text: async () => body };
}

/** A fake fetch that returns the scripted responses in order and records URLs and sleeps. */
function scripted(responses: readonly SourceHttpResponse[]) {
  const urls: string[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetch: SourceFetch = async (url) => {
    urls.push(url);
    const next = queue.shift();
    if (next === undefined) throw new Error("no scripted response");
    return next;
  };
  return { fetch, urls, sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
}

const emptyJiraPage = JSON.stringify({ startAt: 0, maxResults: 100, total: 0, issues: [] });

function checkpoint(source: string, updatedAt: string): GitHubCheckpointV1 {
  return { schema: "osskb.github-checkpoint.v1", connectorRevision: "github@1", sources: { [source]: { updatedAt } } };
}

async function pony(body: unknown, previous?: string) {
  const script = scripted([response(200, typeof body === "string" ? body : JSON.stringify(body))]);
  const result = await new PonyMailConnector({ fetch: script.fetch, sleep: script.sleep })
    .poll(previous === undefined ? undefined : checkpoint("kafka:mail:dev", previous), NOW);
  return { result, script };
}

async function jira(responses: readonly SourceHttpResponse[], previous?: string) {
  const script = scripted(responses);
  const result = await new JiraConnector({ fetch: script.fetch, sleep: script.sleep })
    .poll(previous === undefined ? undefined : checkpoint("kafka:jira", previous), NOW);
  return { result, script };
}

function failed(result: SourcePollResult, withRetryAfter = false): string {
  if (result.complete) return "ok";
  return `source failed (${result.failureKind}${withRetryAfter ? `, retry after ${result.retryAfterSeconds} s` : ""})`;
}

function cursorOf(result: SourcePollResult, source: string): string | undefined {
  return result.complete ? result.candidateCheckpoint.sources[source]?.updatedAt : undefined;
}

const issue20184 = fixture.jiraSearch.issues[0]!;
const issue20186 = fixture.jiraSearch.issues[1]!;

function jiraIssue(value: unknown) {
  const parsed = jiraEventsFrom(value, NOW);
  if (parsed.kind !== "events") throw new Error(`expected Jira events: ${parsed.reason}`);
  return parsed.events;
}

function published(key: string, kips: readonly string[], githubTitles: readonly string[], mailSubjects: readonly string[]): string {
  return isJiraPublished({ key, kips }, jiraLinkIndex({ githubTitles, mailSubjects })) ? "published" : "not published";
}

function jiraWindowText(cursor: string): string {
  const window = jiraWindow(cursor, NOW);
  return `updated >= "-${window.size}m"; gap capped ${window.gapCapped ? "yes" : "no"}`;
}

function mailWindowText(cursor: string): string {
  const window = mailWindow(cursor, NOW);
  return `d=lte=${window.size}d; gap capped ${window.gapCapped ? "yes" : "no"}`;
}

const subjectOf = (input: string) => input.replace(/^constructed: /u, "");

interface CaseRow { readonly id: string; readonly rule: string; readonly input: string; readonly expected: string }
type Case = (row: CaseRow) => string | Promise<string>;

const cases: Record<string, Case> = {
  "mail record|mid 15rddlqk42tqsjh5rw2r6so5cgns122f, from \"Federico Valeri <fe...@gmail.com>\", subject \"Re: [VOTE] KIP-1279: Cluster Mirroring\", epoch 2026-09-18T16:06:37Z": () => {
    const event = mail();
    return `entity ${event.entityId}; occurredAt ${data(event).occurredAt}; author ${data(event).author}; url ${event.canonicalUrl}; kips ${list(data(event).kips)}; issueKeys ${list(data(event).issueKeys)}`;
  },
  "mail record|constructed: from \"Jun Rao via dev <de...@kafka.apache.org>\"": () =>
    `author ${data(mail({ from: "Jun Rao via dev <de...@kafka.apache.org>" })).author}`,
  "mail record|constructed: from \"<an...@outlook.com>\" (no display name)": () => {
    const event = mail({ from: "<an...@outlook.com>" });
    return `author ${data(event).author} (${JSON.stringify(event).includes("outlook") ? "address stored" : "address never stored"})`;
  },
  "mail record|constructed: from \"o....@gmail.com\" (bare address)": () => {
    const event = mail({ from: "o....@gmail.com" });
    return `author ${data(event).author} (${JSON.stringify(event).includes("o....@") ? "address stored" : "address never stored"})`;
  },
  "keys|constructed: XKIP-1279 and MYKAFKA-20184": (row) => {
    const keys = extractKeys(subjectOf(row.input));
    return `kips ${list(keys.kips)}; issueKeys ${list(keys.issueKeys)}`;
  },
  "keys|[jira] [Created] (KAFKA-21049) Async consumer can busy-loop …": (row) => `issueKeys ${list(extractKeys(row.input).issueKeys)}`,
  "keys|constructed: [DISCUSS] KIP-13680: …": (row) => {
    const { kips } = extractKeys(subjectOf(row.input));
    return `kips ${list(kips)}${kips.includes("KIP-1368") ? "" : " (not KIP-1368)"}`;
  },
  "keys|constructed: re: kip-1279 question": (row) => {
    const keys = extractKeys(subjectOf(row.input));
    return `kips ${list(keys.kips)}; issueKeys ${list(keys.issueKeys)}`;
  },
  "keys|constructed: see KAFKA-20184a": (row) => `issueKeys ${list(extractKeys(subjectOf(row.input)).issueKeys)}`,
  ...Object.fromEntries([
    "[jira] [Created] (KAFKA-21049) Async consumer can busy-loop while waiting for fetch progress when retry.backoff.ms is zero",
    "constructed: [PR] MINOR: Fix produce-ack race in ShareConsumerDLQTest multi-topic tests.",
    "[DISCUSS] KIP-1368: Client framework name and version",
    "[VOTE] 4.4.0 RC3",
    "constructed: Re: [jira] [Created] (KAFKA-21049) Async consumer can busy-loop …",
    "constructed: [JIRA] [Resolved] (KAFKA-20953) Remove hamcrest …",
  ].map((input) => [`mail filter|${input}`, () => {
    const parsed = mailEventFrom(email({ subject: subjectOf(input) }), NOW);
    return parsed.kind === "filtered" ? "dropped" : parsed.kind === "event" ? "kept" : parsed.kind;
  }])),
  ...Object.fromEntries([
    VOTE,
    `Re: ${VOTE}`,
    "constructed: RE: Fwd:  Re: [VOTE]  KIP-1279: Cluster Mirroring",
    "constructed: AW: [VOTE] KIP-1279: Cluster Mirroring",
    "[DISCUSS] KIP-1279: Cluster Mirroring",
  ].map((input) => [`thread key|${input}`, () => threadKey(subjectOf(input))])),
  "thread key|constructed: [RESULT] [VOTE] KIP-1279: Cluster Mirroring": (row) => {
    const key = threadKey(subjectOf(row.input));
    return key === threadKey(VOTE) ? key : `${key} (separate thread)`;
  },
  "jira record|KAFKA-20186 \"Cluster Mirroring\", In Progress, description \"…tracks the development of KIP-1279: …\"": () => {
    const issue = data(jiraIssue(issue20186)[0]!);
    return `title ${issue.title}; status ${issue.status}; kips ${list(issue.kips)}`;
  },
  "jira record|KAFKA-20810, Open, description \"…/pages/440304679/KIP-1368+Client+framework…\"": () => {
    const issue = data(jiraIssue({
      key: "KAFKA-20810",
      fields: {
        summary: "Client framework name and version",
        status: { name: "Open" },
        updated: "2026-07-17T15:32:05.817+0000",
        description: "This Jira tracks the implementation of [https://cwiki.apache.org/confluence/spaces/KAFKA/pages/440304679/KIP-1368+Client+framework+name+and+version].",
      },
    })[0]!);
    return `status ${issue.status}; kips ${list(issue.kips)}`;
  },
  "jira record|KAFKA-20184, Patch Available, no KIP in summary or description": () => {
    const issue = data(jiraIssue(issue20184)[0]!);
    return `status ${issue.status}; kips ${list(issue.kips)}`;
  },
  "jira time|updated 2026-09-29T20:24:00.702+0000": () => {
    const event = jiraIssue(issue20184)[0]!;
    return event.sourceCursor === data(event).occurredAt ? `cursor and occurredAt ${event.sourceCursor}` : "cursor differs from occurredAt";
  },
  "jira record|KAFKA-20184 comment by loicgreffier, updated 2026-09-29T20:24:00.702+0000": () => {
    const comment = jiraIssue(issue20184).find((event) => data(event).author === "Loïc Greffier")!;
    const id = comment.entityId.split(":").at(-1)!;
    return `entity ${comment.entityId.replace(id, "<id>")}; url ${comment.canonicalUrl.replace("https://issues.apache.org/jira", "…").replace(id, "<id>")}`;
  },
  "jira record|constructed: comment created 2026-09-20T10:00:00.000+0000, edited 2026-09-29T20:24:00.702+0000": () => {
    const edited = {
      ...issue20184,
      fields: {
        ...issue20184.fields,
        comment: { total: 1, comments: [{ ...issue20184.fields.comment.comments[3]!, created: "2026-09-20T10:00:00.000+0000" }] },
      },
    };
    const comment = jiraIssue(edited)[1]!;
    return `cursor ${comment.sourceCursor}; occurredAt ${data(comment).occurredAt}`;
  },
  ...Object.fromEntries(["Resolved", "Closed", "Reopened"].map((input) => [`jira status|${input}`, () => jiraStatus(input)])),
  "jira status|constructed: Triage Needed (unknown name)": () => jiraStatus("Triage Needed"),
  "jira publish|KAFKA-20184; retained PR #21518 \"KAFKA-20184: Remove static jose4j references from DefaultJwtValidator\"": () =>
    published("KAFKA-20184", [], ["KAFKA-20184: Remove static jose4j references from DefaultJwtValidator"], [`Re: ${VOTE}`]),
  "jira publish|KAFKA-20186; kips KIP-1279; retained dev@ thread \"[VOTE] KIP-1279: Cluster Mirroring\"; no PR": () =>
    published("KAFKA-20186", ["KIP-1279"], [], [VOTE]),
  "jira publish|constructed: KAFKA-20186; kips KIP-1279; no retained dev@ subject names KIP-1279; no PR": () =>
    published("KAFKA-20186", ["KIP-1279"], [], ["[DISCUSS] KIP-1368: Client framework name and version"]),
  "jira publish|constructed: KAFKA-20184; retained dev@ subject \"Re: KAFKA-20184 jose4j at runtime\"": () =>
    published("KAFKA-20184", [], [], ["Re: KAFKA-20184 jose4j at runtime"]),
  "jira publish|constructed: KAFKA-20292; retained PR \"WIP: KAFKA-20292: …\" (key mid-title)": () =>
    published("KAFKA-20292", [], ["WIP: KAFKA-20292: …"], []),
  "jira publish|constructed: KAFKA-20292; only PR title cites KAFKA-202920": () =>
    published("KAFKA-20292", [], ["KAFKA-202920: something else"], []),
  "jira publish|KAFKA-21227 \"Speed up ColdStartStickinessIntegrationTest\"; no PR, mail subject, or KIP cites it": () =>
    published("KAFKA-21227", [], ["KAFKA-20184: Remove static jose4j references from DefaultJwtValidator"], [VOTE]),
  "jira publish|constructed: KAFKA-21227; retained PR \"KAFKA-21227: Speed up ColdStartStickinessIntegrationTest\"": () =>
    published("KAFKA-21227", [], [fixture.githubPulls[1]!.title], []),
  "backfill window|message epoch 2026-09-06T08:00:00Z (now − 30 d)": () =>
    mailEventFrom(email({ epoch: Date.parse("2026-09-06T08:00:00Z") / 1000 }), NOW).kind === "event" ? "ingested" : "not ingested",
  "backfill window|message epoch 2026-09-06T07:59:59Z (now − 30 d − 1 s)": () =>
    mailEventFrom(email({ epoch: Date.parse("2026-09-06T07:59:59Z") / 1000 }), NOW).kind === "event" ? "ingested" : "not ingested",
  "backfill window|no Jira cursor": async () => {
    const { script } = await jira([response(200, emptyJiraPage)]);
    return `JQL ${new URL(script.urls[0]!).searchParams.get("jql")!.match(/updated >= "[^"]+"/u)![0]}`;
  },
  "backfill window|no mail cursor": async () => {
    const { script } = await pony({ hits: 0, emails: [] });
    return `d=${new URL(script.urls[0]!).searchParams.get("d")}`;
  },
  "jira window|cursor 60 min before now": () => jiraWindowText(before(60 * MIN)),
  "jira window|cursor 3 d before now": () => jiraWindowText(before(3 * DAY)),
  "jira window|cursor 29 d 23 h 50 min before now": () => jiraWindowText(before(29 * DAY + 23 * HOUR + 50 * MIN)),
  "jira window|cursor 29 d 23 h 51 min before now": () => jiraWindowText(before(29 * DAY + 23 * HOUR + 51 * MIN)),
  "jira window|cursor exactly 30 d before now": () => jiraWindowText(before(30 * DAY)),
  "jira window|cursor 30 d 1 min before now": () => jiraWindowText(before(30 * DAY + MIN)),
  "jira window|cursor 40 d before now": () => jiraWindowText(before(40 * DAY)),
  "mail window|cursor 1 h before now": () => mailWindowText(before(HOUR)),
  "mail window|cursor exactly 1 d before now": () => mailWindowText(before(DAY)),
  "mail window|cursor 1 d 1 s before now": () => mailWindowText(before(DAY + 1000)),
  "mail window|cursor 29 d 1 s before now": () => mailWindowText(before(29 * DAY + 1000)),
  "mail window|cursor exactly 30 d before now": () => mailWindowText(before(30 * DAY)),
  "mail window|cursor 30 d 1 s before now": () => mailWindowText(before(30 * DAY + 1000)),
  "mail window|constructed: cursor 1 h after now (misdated mail)": () => mailWindowText(before(-HOUR)),
  "mail window|cursor 40 d before now": () => mailWindowText(before(40 * DAY)),
  "retry|constructed: Jira 429 with Retry-After: 30, then 200": async () => {
    const { result, script } = await jira([response(429, "", { "retry-after": "30" }), response(200, emptyJiraPage)]);
    return `${script.sleeps.length === 1 ? `one retry after ${script.sleeps[0]! / 1000} s` : `${script.sleeps.length} retries`}; ${failed(result)}`;
  },
  "retry|constructed: Jira 429 with Retry-After: 120": async () => {
    const { result, script } = await jira([response(429, "", { "retry-after": "120" }), response(200, emptyJiraPage)]);
    return `${script.urls.length === 1 ? "no retry" : "retried"}; ${failed(result, true)}; ${result.complete ? "cursor advanced" : "cursor unchanged"}`;
  },
  "retry|constructed: Pony Mail 503, then 503": async () => {
    const script = scripted([response(503, ""), response(503, "")]);
    const result = await new PonyMailConnector({ fetch: script.fetch, sleep: script.sleep }).poll(undefined, NOW);
    return `${script.urls.length === 2 ? "one retry" : `${script.urls.length - 1} retries`}; ${failed(result)}; ${result.complete ? "cursor advanced" : "cursor unchanged"}`;
  },
  ...Object.fromEntries([
    ["constructed: message without epoch", { epoch: undefined }],
    ["constructed: message with subject null", { subject: null }],
    ["constructed: message without mid", { mid: undefined }],
  ].map(([input, overrides]) => [`malformed mail|${input as string}`, async () => {
    const { result } = await pony({ hits: 2, emails: [email(overrides as Record<string, unknown>), email({ mid: "qqq7mwdbyd74337t4ob5fv8yp28pv8sv" })] });
    return result.complete && result.stats?.skipped === 1 && result.events.length === 1 ? "skipped, counted" : "not skipped";
  }])),
  ...Object.fromEntries([61, 119].map((minutes) => [`misdated mail|constructed: epoch ${minutes} min after now`, async () => {
    const previous = before(HOUR);
    const { result } = await pony({ hits: 1, emails: [email({ epoch: (Date.parse(NOW) + minutes * MIN) / 1000 })] }, previous);
    return result.complete && result.stats?.skipped === 1 && result.events.length === 0
      ? `skipped, counted; ${cursorOf(result, "kafka:mail:dev") === previous ? "cursor unchanged" : "cursor moved"}`
      : "not skipped";
  }])),
  "counts|constructed: one [jira] notification, one message without epoch, one human message": async () => {
    const { result } = await pony({ hits: 3, emails: [
      email({ mid: "n1", subject: "[jira] [Created] (KAFKA-21049) Async consumer can busy-loop" }),
      email({ mid: "n2", epoch: undefined }),
      email(),
    ] });
    return result.complete
      ? `read ${result.stats?.read}; filtered ${result.stats?.filtered}; skipped ${result.stats?.skipped}; ingested ${result.events.length}`
      : failed(result);
  },
  "misdated mail|constructed: epoch 2 d after now": async () => {
    const previous = before(HOUR);
    const { result } = await pony({ hits: 1, emails: [email({ epoch: (Date.parse(NOW) + 2 * DAY) / 1000 })] }, previous);
    return result.complete && result.stats?.skipped === 1
      ? `skipped, counted; ${cursorOf(result, "kafka:mail:dev") === previous ? "cursor unchanged" : "cursor moved"}`
      : "not skipped";
  },
  "misdated mail|constructed: epoch 59 min after now": async () => {
    const { result } = await pony({ hits: 1, emails: [email({ epoch: (Date.parse(NOW) + 59 * MIN) / 1000 })] }, before(HOUR));
    return result.complete && result.events.length === 1
      ? `ingested; ${cursorOf(result, "kafka:mail:dev") === NOW ? "cursor = now" : `cursor = ${cursorOf(result, "kafka:mail:dev")}`}`
      : "not ingested";
  },
  "malformed jira|constructed: issue without fields.updated": async () => {
    const broken = { ...issue20186, fields: { ...issue20186.fields, updated: undefined } };
    const page = JSON.stringify({ startAt: 0, maxResults: 100, total: 2, issues: [issue20184, broken] });
    const { result } = await jira([response(200, page)]);
    return result.complete && result.stats?.skipped === 1 &&
      cursorOf(result, "kafka:jira") === "2026-09-29T20:24:00.702Z" ? "skipped, counted; cursor = newest valid updated" : "unexpected";
  },
  "malformed jira|constructed: issue without key": async () => {
    const page = JSON.stringify({ startAt: 0, maxResults: 100, total: 2, issues: [issue20184, { ...issue20186, key: undefined }] });
    const { result } = await jira([response(200, page)]);
    return result.complete && result.stats?.skipped === 1 ? "skipped, counted" : "not skipped";
  },
  "duplicate|same mid 15rddlqk42tqsjh5rw2r6so5cgns122f in two overlapping windows": async () => {
    const store = new ReferenceStateStore();
    for (let run = 0; run < 2; run += 1) {
      const { result } = await pony({ hits: 2, emails: [email(), email()] });
      if (!result.complete) return "failed";
      store.appendKeepingStored(result.events);
    }
    return store.readEvents().length === 1 ? "one event" : `${store.readEvents().length} events`;
  },
  "conflict|constructed: same mid and epoch, different preview text": () => {
    const store = new ReferenceStateStore();
    store.appendKeepingStored([mail({ body: "first preview" })]);
    const conflicts = store.appendKeepingStored([mail({ body: "second preview" })]);
    const kept = data(store.readEvents()[0]!).excerpt;
    return `${kept === "first preview" ? "first stored event kept" : "replaced"}; ${conflicts.length === 1 ? "conflict counted" : "not counted"}; run not failed`;
  },
  "truncated mail|constructed: hits 500, emails 499": async () => {
    const { result } = await pony({ hits: 500, emails: Array.from({ length: 499 }, (_, index) => email({ mid: `m${index}` })) }, before(HOUR));
    return `${failed(result)}; ${result.complete ? "cursor advanced" : "cursor unchanged"}`;
  },
  "truncated mail|constructed: hits 500, emails 500": async () => {
    const { result } = await pony({ hits: 500, emails: Array.from({ length: 500 }, (_, index) => email({ mid: `m${index}` })) });
    return result.complete ? `ok, ${result.stats?.read} read` : failed(result);
  },
  "schema|constructed: Pony Mail 200 without emails array": async () => failed((await pony({ hits: 0 })).result),
  "schema|constructed: Pony Mail 200 with emails []": async () => {
    const { result } = await pony({ hits: 0, emails: [] });
    return result.complete ? `ok, ${result.stats?.read} read` : failed(result);
  },
  "schema|Jira 200 text/html (login page, as /rest/api/3/search returns)": async () =>
    failed((await jira([response(200, "<!DOCTYPE html><html><title>Log in - ASF JIRA</title></html>", { "content-type": "text/html" })])).result),
  "schema|constructed: Jira 200 with total \"3\" (a string)": async () =>
    failed((await jira([response(200, JSON.stringify({ startAt: 0, maxResults: 100, total: "3", issues: [] }))])).result),
  "size|constructed: Jira page of exactly 4 MiB (captured 100-issue page: 671 KB)": async () =>
    failed((await jira([response(200, paddedJson(MAX_RESPONSE_CHARS))])).result),
  "size|constructed: Jira page of 4 MiB + 1 character": async () => {
    const { result } = await jira([response(200, paddedJson(MAX_RESPONSE_CHARS + 1))], before(HOUR));
    return `${failed(result)}; ${result.complete ? "cursor advanced" : "cursor unchanged"}`;
  },
};

function paddedJson(length: number): string {
  const prefix = `{"startAt":0,"maxResults":100,"total":0,"issues":[],"pad":"`;
  const suffix = `"}`;
  return `${prefix}${"x".repeat(length - prefix.length - suffix.length)}${suffix}`;
}

describe("Spec 012 Kafka source rules", () => {
  test.each([...testPlanRows] as CaseRow[])("$id: $rule — $input", async (row) => {
    const run = cases[`${row.rule}|${row.input}`];
    if (run === undefined) throw new Error(`No executable case for ${row.id} ${row.rule}: ${row.input}`);
    expect(await run(row)).toBe(row.expected);
  });

  test("every executable case has a test-plan row", () => {
    const rows = new Set(testPlanRows.map((row) => `${row.rule}|${row.input}`));
    expect(Object.keys(cases).filter((key) => !rows.has(key))).toEqual([]);
  });

  test("K28: a backfill makes at most 1 Pony Mail and 2 Jira requests, sequential, with a User-Agent and no credentials", async () => {
    const pages = [0, 100].map((startAt) => JSON.stringify({
      startAt, maxResults: 100, total: 250,
      issues: Array.from({ length: 100 }, (_, index) => ({ ...issue20186, key: `KAFKA-${30000 + startAt + index}` })),
    }));
    const headers: Record<string, string>[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch: SourceFetch = async (url, init) => {
      headers.push({ ...init.headers });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return response(200, url.includes("lists.apache.org") ? JSON.stringify(fixture.ponyStats) : pages.shift()!);
    };
    const mailConnector = new PonyMailConnector({ fetch });
    const jiraConnector = new JiraConnector({ fetch });
    const mailResult = await mailConnector.poll(undefined, NOW);
    const jiraResult = await jiraConnector.poll(undefined, NOW);

    expect(mailResult.complete && jiraResult.complete).toBe(true);
    expect(mailConnector.requests.requests).toBe(1);
    expect(jiraConnector.requests.requests).toBe(2);
    expect(jiraResult.complete && jiraResult.truncated).toBe(true);
    expect(cursorOf(jiraResult, "kafka:jira")).toBe("2026-10-06T06:49:33.889Z");
    expect(maxInFlight).toBe(1);
    for (const header of headers) {
      expect(header["User-Agent"]).toBe("oss-knowledge-base/1.0 (+https://github.com/unknowntpo/oss-knowledge-base)");
      expect(Object.keys(header).map((name) => name.toLowerCase())).not.toContain("authorization");
    }
  });
});
