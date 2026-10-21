/**
 * Spec 019 amendment (7), slice C: the checks of the profile's KIPs section behind `PEOPLE_KIPS` (W74, W75, W80,
 * W83, W87, W94–W96, W98, W102–W104, W109–W111). Rows come from
 * `packages/reference-pipeline/test/kip-profile.cases.ts` (`people-kips-profile.test.ts`) and
 * `kip-authors.cases.ts` (`people-kips.test.ts`); each row's check is here, keyed `<id>|<case>`.
 *
 * `recorded` rows read the committed public fixtures: the activity months of 2026-09-15 to
 * 2026-10-21 (`fixtures/identity-links/`, dev@ starters and the corroborated links), and the cwiki
 * pages and Jira assignees of 2026-10-21 (`fixtures/kip-pages/`), turned into `authors.json` by the
 * `kip-pages` job itself with a stub fetch. Facts the fixtures do not hold (KIP-1272, KIP-1311,
 * KIP-1357, KAFKA-20728) are constructed with the values the spec recorded, and say so.
 */
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  committerLinks,
  computeIdentityLinks,
  encodeActivityMonth,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsStateKey,
  IdentityFacts,
  identityLinksKey,
  KAFKA_COMMITTERS_URL,
  KAFKA_IDENTITY_PROFILE,
  mergeActivityMonth,
  OWNER_DECLARED_EXAMPLE,
  parseActivityMonth,
  PEOPLE_ACTIVITY_STATE_SCHEMA,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  refreshCommitters,
  validDeclaredLink,
  type ActivityMonthV1,
  type ActivityRowV1,
  type ActivityThreadV1,
  type CommittersCaptureV1,
  type DeclaredLinkV1,
  type IdentityLinksTableV1,
} from "@oss-knowledge-base/reference-pipeline";
import { KAFKA_KIP_PAGES, KIP_PAGES_REVISION, kipAuthorsKey, runKipPages, type KipAuthorsTableV1, type KipPageV1 } from "@oss-knowledge-base/reference-pipeline/kip-pages";
import { profileIdentityLinksKey, readPersonProfile, type KipLineV1, type PersonProfileV1 } from "@oss-knowledge-base/reference-pipeline/people";

import { onRequestGet as profileHandler } from "../functions/api/people/[project]/[id]";
import { registerVuePlugin } from "./vue-plugin";

const ROOT = join(import.meta.dir, "../../..");
export const KAFKA = "apache-kafka";
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as unknown;

// ---- recorded fixtures ------------------------------------------------------------------------

const ACTIVITY = read("packages/reference-pipeline/test/fixtures/identity-links/upstream-2026-09-15_2026-10-21.json") as { readonly capturedAt: string; readonly months: readonly ActivityMonthV1[] };
const RECORDED = ACTIVITY.months.map((month) => parseActivityMonth(month, KAFKA, month.month));
const NOW = Date.parse(ACTIVITY.capturedAt);
const COVERAGE_FROM = "2026-09-15T00:00:00.000Z";
const INPUTS = { coverageFrom: COVERAGE_FROM, months: ["2026-09", "2026-10"], activityUpdatedAt: ACTIVITY.capturedAt, rosterAt: null };

interface RecordedPage { readonly id: string; readonly title: string; readonly version: { readonly by?: { readonly username?: string; readonly userKey?: string } }; readonly body: { readonly view: { readonly value: string } } }
const CWIKI = read("packages/reference-pipeline/test/fixtures/kip-pages/cwiki-kips-2026-10-21.json") as { readonly responses: readonly { readonly results: readonly RecordedPage[] }[] };
const WINDOW = read("packages/reference-pipeline/test/fixtures/kip-pages/cwiki-window-2026-10-21.json") as { readonly window: { readonly results: readonly RecordedPage[] } };
export const JIRA = read("packages/reference-pipeline/test/fixtures/kip-pages/jira-assignees-2026-10-21.json") as { readonly response: { readonly issues: readonly { readonly fields: { readonly assignee?: { readonly key: string; readonly name: string } | null } }[] } };
/** GitHub logins in the recorded activity: public profile ids, shown as such even when a Confluence or Jira user name is spelled the same. */
export const GITHUB_LOGINS = new Set(RECORDED.flatMap((month) => Object.keys(month.people)).filter((id) => id.startsWith("github:")).map((id) => id.slice(7)));
const RECORDED_PAGES = [...CWIKI.responses.flatMap((response) => response.results), ...WINDOW.window.results];

/** `authors.json` as the `kip-pages` job writes it from the recorded cwiki pages and Jira answer. */
async function recordedAuthors(): Promise<KipAuthorsTableV1> {
  const objects = new Map<string, string>();
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  await runKipPages({
    flag: KIP_PAGES_REVISION,
    profile: KAFKA_KIP_PAGES,
    bucket: { get: async (key) => objects.get(key), put: async (key, body) => { objects.set(key, body); } },
    fetch: async (url) => (url.startsWith("https://cwiki.apache.org/")
      ? answer({ results: RECORDED_PAGES, start: 0, limit: 50, size: RECORDED_PAGES.length, _links: { base: "https://cwiki.apache.org/confluence" } })
      : answer(JIRA.response)),
    now: () => Date.parse("2026-10-21T03:43:00.000Z"),
    delay: async () => undefined,
  });
  return JSON.parse(objects.get(kipAuthorsKey(KAFKA))!) as KipAuthorsTableV1;
}

let AUTHORS: KipAuthorsTableV1;

function links(months: readonly ActivityMonthV1[] = RECORDED, identityLinks: readonly DeclaredLinkV1[] = [], blind = false): IdentityLinksTableV1 {
  const facts = new IdentityFacts(KAFKA, "KAFKA-", []);
  for (const month of months) facts.add(month);
  return computeIdentityLinks({ projectId: KAFKA, config: KAFKA_IDENTITY_PROFILE.corroboration!, facts, roster: null, identityLinks, blind, inputs: INPUTS }).table;
}

// ---- constructed data -------------------------------------------------------------------------

export class Month {
  readonly threads: Record<string, ActivityThreadV1> = {};
  readonly rows: ActivityRowV1[] = [];
  readonly people: Record<string, string> = {};
  constructor(readonly month: string) {}
  pr(number: number, login: string): this {
    const key = `KAFKA-PR-${number}`;
    const author = `github:${login.toLowerCase()}`;
    this.threads[key] = { source: "github", kind: "pull-request", title: `MINOR: change ${number}`, url: `https://github.com/apache/kafka/pull/${number}`, author, labels: [], kips: [] };
    this.rows.push({ id: `kafka:github:pull:${number}`, source: "github", kind: "pull-request", person: author, thread: key, at: `${this.month}-10T00:00:00Z` });
    this.people[author] = login;
    return this;
  }
  /** A Jira issue reported by `display` (so `jira:<display>` has a page), with an assignee account. */
  issue(key: string, display: string, assignee: readonly [string, string] | null, at = `${this.month}-11T00:00:00Z`): this {
    const person = `jira:${display.toLowerCase()}`;
    this.threads[key] = {
      source: "jira", kind: "issue", title: `${key}: constructed`, url: `https://issues.apache.org/jira/browse/${key}`, author: person, labels: [], kips: [],
      reporter: null, assignee: assignee === null ? null : { key: assignee[0], display: assignee[1] },
    };
    this.rows.push({ id: `kafka:jira:issue:${key}`, source: "jira", kind: "issue", person, thread: key, at });
    this.people[person] = display;
    return this;
  }
  mail(thread: string, title: string, display: string, day: string, opens: boolean): this {
    const person = `mail:${display.toLowerCase()}`;
    this.threads[thread] ??= { source: "mail", kind: "mail-thread", title, url: `https://lists.apache.org/thread/${thread}`, author: person, labels: [], kips: [] };
    const at = `${this.month}-${day}T09:00:00Z`;
    this.rows.push({ id: `kafka:mail:dev:message:${thread}-${display}-${at}`, source: "mail", kind: "message", person, thread, at, ...(opens ? { opens: true as const } : {}) });
    this.people[person] = display;
    return this;
  }
  build(): ActivityMonthV1 {
    return parseActivityMonth(JSON.parse(encodeActivityMonth({ schema: "osskb.people-activity.v1", projectId: KAFKA, month: this.month, people: this.people, threads: this.threads, rows: this.rows })), KAFKA, this.month);
  }
}

/** The recorded months with constructed months merged in (same month: rows added). */
export function withRecorded(...extra: readonly ActivityMonthV1[]): readonly ActivityMonthV1[] {
  const byMonth = new Map(RECORDED.map((month) => [month.month, month]));
  for (const month of extra) byMonth.set(month.month, mergeActivityMonth(byMonth.get(month.month), month));
  return [...byMonth.values()];
}

export function page(kip: number, options: { readonly authors?: readonly string[]; readonly issues?: readonly (readonly [string, readonly [string, string] | null, string?])[]; readonly title?: string } = {}): KipPageV1 {
  return {
    kip, pageId: String(800_000 + kip), version: 1, title: `KIP-${kip}: ${options.title ?? `Constructed ${kip}`}`, url: `https://cwiki.apache.org/confluence/pages/viewpage.action?pageId=${800_000 + kip}`,
    status: options.authors === undefined ? "no-list" : "listed",
    authors: (options.authors ?? []).map((name) => ({ name, nameKey: name })),
    jira: (options.issues ?? []).length === 0 ? "none" : (options.issues ?? []).length === 1 ? "one" : "several",
    issues: (options.issues ?? []).map(([key, assignee, readAt]) => ({ key, assignee: assignee === null ? null : { key: assignee[0], display: assignee[1] }, readAt: readAt ?? "2026-10-21T03:43:00.000Z" })),
  };
}
export const authorsTable = (pages: readonly KipPageV1[], generatedAt = "2026-10-21T03:43:00.000Z"): KipAuthorsTableV1 =>
  ({ schema: "osskb.kip-authors.v1", generatedAt, coverageFrom: "2025-10-21T03:43:00.000Z", pages });
const withPages = (table: KipAuthorsTableV1, ...pages: readonly KipPageV1[]): KipAuthorsTableV1 => authorsTable([...table.pages, ...pages]);
const declared = (a: string, b: string, evidence = "https://example.org/statement"): DeclaredLinkV1 => ({ a, b, evidence, date: "2026-10-21", reviewer: "unknowntpo" });

// ---- the store and the reader ------------------------------------------------------------------

interface Store {
  readonly months?: readonly ActivityMonthV1[];
  /** A table, raw text (corrupt), or null (absent). */
  readonly links?: IdentityLinksTableV1 | string | null;
  readonly authors?: KipAuthorsTableV1 | string | null;
  readonly coverageFrom?: string;
  readonly reviews?: boolean;
}

function store(options: Store = {}) {
  const objects = new Map<string, string>();
  const months = options.months ?? RECORDED;
  const coverageFrom = options.coverageFrom ?? COVERAGE_FROM;
  objects.set(peopleActivityStateKey(KAFKA), JSON.stringify({ schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: coverageFrom, coverageFrom, updatedAt: ACTIVITY.capturedAt, months: months.map((month) => month.month) }));
  if (options.reviews === true) objects.set(githubReviewsStateKey(KAFKA), JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: ACTIVITY.capturedAt, coverageFrom }));
  for (const month of months) objects.set(peopleActivityMonthKey(KAFKA, month.month), encodeActivityMonth(month));
  const table = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
  const linksValue = options.links === undefined ? links(months) : options.links;
  if (linksValue !== null) objects.set(profileIdentityLinksKey(KAFKA), table(linksValue));
  const authorsValue = options.authors === undefined ? AUTHORS : options.authors;
  if (authorsValue !== null) objects.set(kipAuthorsKey(KAFKA), table(authorsValue));
  const gets: string[] = [];
  const bucket = {
    get: async (key: string) => {
      gets.push(key);
      const body = objects.get(key);
      return body === undefined ? null : { text: async () => body };
    },
  };
  return { bucket, gets, objects };
}

export async function profile(personId: string, options: Store & { readonly kips?: boolean; readonly nowMs?: number } = {}): Promise<PersonProfileV1> {
  const result = await readPersonProfile({ bucket: store(options).bucket, projectKey: "kafka", personId, nowMs: options.nowMs ?? NOW, kips: options.kips ?? true });
  if (result.status !== 200) throw new Error(`${personId}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}
export const lineOf = (body: PersonProfileV1, kip: string) => body.kips!.lines.find((line) => line.kip === kip);
export const bases = (line: KipLineV1 | undefined) => line?.facts.map((fact) => (fact.basis === "assignee" ? `assignee ${fact.issues.join(",")}` : fact.basis));

export async function api(personId: string, options: Store & { readonly flag?: string } = {}) {
  const { bucket } = store(options);
  const env = { PEOPLE_PROFILES: "true", OSS_KB_BUCKET: bucket, ...(options.flag === undefined ? {} : { PEOPLE_KIPS: options.flag }) };
  return (profileHandler as unknown as (context: unknown) => Promise<Response>)({ env, params: { project: "kafka", id: encodeURIComponent(personId) }, request: new Request("https://dev.example/api/people") });
}

// ---- rendering ----------------------------------------------------------------------------------

export let render: (profile: PersonProfileV1, locale?: string) => Promise<string>;
export const text = (html: string) => html.replace(/<!--[\s\S]*?-->/gu, "").replace(/<[^>]+>/gu, " ").replace(/&#39;/gu, "'").replace(/&quot;/gu, "\"").replace(/&amp;/gu, "&").replace(/\s+/gu, " ").replace(/ ([,)])/gu, "$1").replace(/\( /gu, "(").trim();
export const section = (html: string) => html.slice(html.indexOf('data-section="kips"'), html.indexOf('data-section="areas"'));

/** Builds the recorded `authors.json` and the page renderer; each test file calls it in `beforeAll`. */
export async function setUpKips(): Promise<void> {
  AUTHORS = await recordedAuthors();
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.document = { documentElement: {}, querySelectorAll: () => [], createElement: () => ({}) };
  scope.window ??= { localStorage: { getItem: () => null, setItem: () => undefined }, navigator: { language: "en" }, dispatchEvent: () => true };
  scope.history ??= { state: null, replaceState: () => undefined, pushState: () => undefined };
  registerVuePlugin();
  await import("../i18n.js");
  const { useI18n } = await import("../src/i18n");
  const PersonProfile = (await import("../src/components/PersonProfile.vue")).default;
  const { createSSRApp, h } = await import("vue");
  const { renderToString } = await import("vue/server-renderer");
  const { createMemoryHistory, createRouter } = await import("vue-router");
  render = async (profileValue, locale = "en") => {
    useI18n().setLocale(locale);
    const app = createSSRApp({ render: () => h(PersonProfile as never, { profile: profileValue, nowMs: NOW }) });
    app.use(createRouter({ history: createMemoryHistory("/"), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] }));
    return renderToString(app);
  };
}

// ---- constructed scenarios shared by rows ---------------------------------------------------------

/** github:x opens a pull request; mail:x starts KIP-9001; the two are joined through a Jira account (corroborated). */
function linkedScenario(): Store {
  const month = new Month("2026-10").pr(9001, "x").mail("t9001", "[DISCUSS] KIP-9001: constructed", "X", "12", true).build();
  const table: IdentityLinksTableV1 = {
    schema: "osskb.identity-links.v1", revision: "corroborated@1", projectId: KAFKA, generatedAt: "2026-10-22T02:17:00.000Z", inputs: INPUTS,
    people: [{
      members: [{ id: "github:x" }, { id: "jira-account:JIRAUSER900001", display: "X" }, { id: "mail:x" }],
      links: [
        { a: "github:x", b: "jira-account:JIRAUSER900001", basis: "corroborated", evidence: [1, 2, 3].map((n) => ({ id: `KAFKA-9${n}`, url: `https://issues.apache.org/jira/browse/KAFKA-9${n}` })) },
        { a: "jira-account:JIRAUSER900001", b: "mail:x", basis: "corroborated", evidence: [9001, 9002].map((n) => ({ id: `KIP-${n}`, url: `https://lists.apache.org/thread/t${n}` })) },
      ],
    }],
  };
  return { months: [month], links: table, authors: authorsTable([]) };
}

/** Committers capture of three names, one of them twice on the page (W103, W95 rule 1). */
const capture = (pairs: readonly (readonly [string, string])[]): CommittersCaptureV1 => ({
  source: KAFKA_COMMITTERS_URL, capturedAt: "2026-10-21", committers: pairs.map(([name, login]) => ({ name, login, date: "2026-10-21", reviewer: "unknowntpo" })),
});
/** github:a and github:b open pull requests; "A B" and "C D" are authors of KIP-9100 and never write on dev@. */
function committerScenario(entries: readonly DeclaredLinkV1[], blind = false): Store {
  const month = new Month("2026-10").pr(9100, "a").pr(9101, "b").pr(9102, "c").pr(9103, "x").build();
  return { months: [month], links: links([month], entries, blind), authors: authorsTable([page(9100, { authors: ["A B", "C D"] })]) };
}

export const kipProfileChecks: Record<string, () => Promise<void>> = {
  "W74|own KIPs on a dev@ page": async () => {
    const body = await profile("mail:arnab nandy");
    expect(body.kips!.lines.map((line) => line.kip)).toEqual(["KIP-1382", "KIP-1381"]);
    for (const line of body.kips!.lines) {
      expect(bases(line)).toEqual(["starter"]);
      expect(line.discussion?.at.slice(0, 10)).toBe("2026-10-16");
      expect(line.discussion?.url).toStartWith("https://lists.apache.org/");
      expect(line.pageUrl).toStartWith("https://cwiki.apache.org/");
    }
    expect(lineOf(body, "KIP-1381")!.title).toStartWith("Allow Brokers to Dis");
    const html = await render(body);
    // After the activity tiles.
    expect([...html.matchAll(/data-section="([a-z-]+)"/gu)].map((match) => match[1]).slice(0, 4)).toEqual(["header", "over-time", "activity", "kips"]);
    const kips = text(section(html));
    expect(kips).toContain("KIP-1382");
    expect(kips).toContain("started the discussion");
    expect(kips).toContain("started by Arnab nandy on 2026-10-16");
    expect(section(html)).toContain(`href="${lineOf(body, "KIP-1381")!.discussion!.url}"`);
  },
  "W74|linked KIPs on a GitHub page": async () => {
    const body = await profile("github:x", linkedScenario());
    const line = lineOf(body, "KIP-9001")!;
    expect(bases(line)).toEqual(["starter"]);
    const via = line.facts[0]!.via!;
    expect(via.map((step) => [step.basis, step.to.source, step.to.display, step.to.id])).toEqual([
      ["corroborated", "jira", "X", "jira:x"], ["corroborated", "mail", "X", "mail:x"],
    ]);
    expect(via[0]!.evidence.map((item) => item.id)).toEqual(["KAFKA-91", "KAFKA-92", "KAFKA-93"]);
    expect(JSON.stringify(body)).not.toContain("JIRAUSER900001");
    const kips = section(await render(body));
    expect(text(kips)).toContain("Through Jira “X” (corroborated): KAFKA-91, KAFKA-92, KAFKA-93");
    expect(kips).toContain('href="https://issues.apache.org/jira/browse/KAFKA-91"');
    // Positive control: mail:x itself lists it without a link.
    expect(lineOf(await profile("mail:x", linkedScenario()), "KIP-9001")!.facts[0]!.via).toBeUndefined();
  },
  "W74|a starter-only line's title": async () => {
    const month = new Month("2026-10")
      .mail("t9201", "[DISCUSS] KIP-9201: First title", "Title Person", "03", true)
      .mail("t9202", "DISCUSS: KIP-9202 - Second title", "Title Person", "04", true)
      .mail("t9203", "[discuss] KIP-9203：Third title", "Title Person", "05", true).build();
    const body = await profile("mail:title person", { months: [month], authors: authorsTable([]) });
    expect(body.kips!.lines.map((line) => [line.kip, line.pageUrl, line.title])).toEqual([
      ["KIP-9203", undefined, "Third title"], ["KIP-9202", undefined, "Second title"], ["KIP-9201", undefined, "First title"],
    ]);
    // The discussion keeps the subject as written.
    expect(lineOf(body, "KIP-9201")!.discussion!.title).toBe("[DISCUSS] KIP-9201: First title");
  },
  "W74|flag off": async () => {
    const off = store();
    const result = await readPersonProfile({ bucket: off.bucket, projectKey: "kafka", personId: "mail:arnab nandy", nowMs: NOW });
    expect(result.status).toBe(200);
    expect("kips" in result.body).toBe(false);
    expect(off.gets.filter((key) => key.includes("internal/identity/") || key.includes("internal/kips/"))).toEqual([]);
    expect(await render(result.body as PersonProfileV1)).not.toContain('data-section="kips"');
    // The Pages flag: unset or any other value reads nothing; "true" reads both tables.
    for (const flag of [undefined, "", "false", "TRUE"]) {
      const body = await (await api("mail:arnab nandy", flag === undefined ? {} : { flag })).json() as PersonProfileV1;
      expect("kips" in body).toBe(false);
    }
    const on = store();
    await readPersonProfile({ bucket: on.bucket, projectKey: "kafka", personId: "mail:arnab nandy", nowMs: NOW, kips: true });
    expect(on.gets.filter((key) => key.includes("internal/identity/") || key.includes("internal/kips/")).sort()).toEqual([kipAuthorsKey(KAFKA), identityLinksKey(KAFKA)].sort());
    expect("kips" in await (await api("mail:arnab nandy", { flag: "true" })).json() as object).toBe(true);
  },
  "W75|the note": async () => {
    const month = new Month("2026-10").mail("t1", "[DISCUSS] KIP-9200: constructed", "Note Person", "02", true).build();
    const body = await profile("mail:note person", {
      months: [month], coverageFrom: "2026-09-10T00:00:00.000Z",
      links: { ...links([month]), generatedAt: "2026-10-22T02:17:00.000Z" }, authors: authorsTable([]),
    });
    expect([body.kips!.startersFrom, body.kips!.links]).toEqual(["2026-09-10T00:00:00.000Z", { available: true, generatedAt: "2026-10-22T02:17:00.000Z" }]);
    const notes = text(section(await render(body)).split("data-kips-how")[1]!);
    expect(notes).toContain("“Started the discussion” is the sender of the first message of the KIP's earliest [DISCUSS] thread on dev@, not “authored”");
    expect(notes).toContain("recorded since 2026-09-10; KIPs started before 2026-09-10 are not listed");
    expect(notes).toContain("the link table computed 2026-10-22;");
    expect(text(section(await render(body, "zh-Hant")))).toContain("2026-09-10 之前開始討論的 KIP 不會列出");
  },
  "W80|link table missing or corrupt": async () => {
    for (const value of [null, "{not json", JSON.stringify({ schema: "osskb.identity-links.v1", projectId: KAFKA, generatedAt: "x", people: [{ members: "nope" }] })]) {
      const response = await api("mail:eric chang", { flag: "true", links: value });
      expect(response.status).toBe(200);
      const body = await response.json() as PersonProfileV1;
      expect(body.kips!.links).toEqual({ available: false });
      expect(bases(lineOf(body, "KIP-1371"))).toEqual(["starter"]);
      expect(text(section(await render(body)))).toContain("Links not available; only this identity's own KIPs are listed.");
      // No corroborated link without the table: github:unknowntpo lists nothing.
      expect((await profile("github:unknowntpo", { links: value })).kips!.lines).toEqual([]);
    }
    // Positive control: with the table, the link is used and the note says when it was computed.
    expect((await profile("mail:eric chang")).kips!.links.available).toBe(true);
    expect(lineOf(await profile("github:unknowntpo"), "KIP-1371")).toBeDefined();
  },
  "W83|rows written before the flag": async () => {
    const before = new Month("2026-09").mail("t1", "[DISCUSS] KIP-9300: constructed", "Old Starter", "20", false).build();
    const body = await profile("mail:old starter", { months: [before], authors: authorsTable([]) });
    expect(body.kips!.lines).toEqual([]);
    expect(body.kips!.startsKnownFrom).toBeNull();
    expect(text(section(await render(body)))).toContain("No thread start is recorded yet, so no discussion starter is listed.");
    // Later rows carry the flag: starters are known from the first of them, and the note says so.
    const after = new Month("2026-10").mail("t2", "[DISCUSS] KIP-9301: constructed", "Old Starter", "05", true).build();
    const mixed = await profile("mail:old starter", { months: [before, after], authors: authorsTable([]) });
    expect(mixed.kips!.lines.map((line) => line.kip)).toEqual(["KIP-9301"]);
    expect(text(section(await render(mixed)))).toContain("The earliest thread start in the record is 2026-10-05; a thread whose first message is not recorded has no starter.");
    // Positive control: the same September row with the flag is a starter.
    const flagged = new Month("2026-09").mail("t1", "[DISCUSS] KIP-9300: constructed", "Old Starter", "20", true).build();
    expect((await profile("mail:old starter", { months: [flagged], authors: authorsTable([]) })).kips!.lines.map((line) => line.kip)).toEqual(["KIP-9300"]);
  },
  "W87|profile reads": async () => {
    // Twelve months of coverage, so the reader reads W29's 26 objects for a GitHub identity.
    const months = Array.from({ length: 12 }, (_, back) => new Date(Date.UTC(2026, 9 - back, 1)).toISOString().slice(0, 7));
    const built = months.map((value, index) => new Month(value).pr(9400 + index, "reader").build());
    const counting = store({ months: built, coverageFrom: "2025-09-01T00:00:00.000Z", reviews: true });
    const call = (nowMs: number) => readPersonProfile({ bucket: counting.bucket, projectKey: "kafka", personId: "github:reader", nowMs, kips: true });
    expect((await call(NOW)).status).toBe(200);
    expect(counting.gets.length).toBe(28);
    expect(counting.gets).toContain(identityLinksKey(KAFKA));
    expect(counting.gets).toContain(kipAuthorsKey(KAFKA));
    await call(NOW + 9 * 60_000);
    expect(counting.gets.length).toBe(28);
    // Positive control: after 10 minutes everything is read again.
    await call(NOW + 11 * 60_000);
    expect(counting.gets.length).toBe(56);
    // Without the flag the same request reads 26.
    const off = store({ months: built, coverageFrom: "2025-09-01T00:00:00.000Z", reviews: true });
    await readPersonProfile({ bucket: off.bucket, projectKey: "kafka", personId: "github:reader", nowMs: NOW });
    expect(off.gets.length).toBe(26);
  },
};

export const kipAuthorChecks: Record<string, () => Promise<void>> = {
  "W94|author and starter": async () => {
    const body = await profile("mail:viktor somogyi-vass");
    expect(bases(lineOf(body, "KIP-1165"))).toEqual(["author", "starter"]);
    const html = text(section(await render(body)));
    expect(html).toContain("author (KIP page) · also started the discussion");
  },
  "W94|starter only": async () => {
    const body = await profile("mail:eric chang");
    expect(bases(lineOf(body, "KIP-1371"))).toEqual(["starter"]);
    expect(lineOf(body, "KIP-1371")!.authors).toBeUndefined();
    expect(text(section(await render(body)))).not.toContain("author (KIP page)");
  },
  "W94|a starter the list does not name": async () => {
    // KIP-1272 as recorded on 2026-10-21 (page list and dev@ root), placed inside a constructed coverage.
    const month = new Month("2026-10").mail("t1272", "[DISCUSS] KIP-1272: constructed", "Henry Haiying Cai", "03", true).build();
    const authors = authorsTable([page(1272, { authors: ["Henry Cai", "Thomas Thornton", "Greg Harris"] })]);
    const body = await profile("mail:henry haiying cai", { months: [month], authors });
    expect(bases(lineOf(body, "KIP-1272"))).toEqual(["starter"]);
    expect(lineOf(body, "KIP-1272")!.authors!.map((author) => [author.name, author.person])).toEqual([["Henry Cai", undefined], ["Thomas Thornton", undefined], ["Greg Harris", undefined]]);
  },
  "W94|creator and editors give nothing": async () => {
    // KIP-1026 is recorded (creator Divij Vaidya, author Arpit Goyal); KIP-1357's editor Matthias J. Sax is constructed as a no-list page.
    const month = new Month("2026-10")
      .mail("t1", "[DISCUSS] KIP-1026: handling producer snapshot", "Divij Vaidya", "03", false)
      .mail("t2", "[DISCUSS] KIP-1357: constructed", "Matthias J. Sax", "04", false).build();
    const authors = withPages(AUTHORS, page(1357));
    for (const person of ["mail:divij vaidya", "mail:matthias j. sax"]) expect((await profile(person, { months: [month], authors })).kips!.lines).toEqual([]);
    // The table holds no creator or editor at all.
    expect(Object.keys(AUTHORS.pages.find((item) => item.kip === 1026)!).sort()).toEqual(["authors", "issues", "jira", "kip", "pageId", "status", "title", "url", "version"]);
    expect(AUTHORS.pages.find((item) => item.kip === 1026)!.authors.map((author) => author.name)).toEqual(["Arpit Goyal"]);
  },
  "W95|linked by writing in the discussion": async () => {
    const month = new Month("2026-10").mail("t1165b", "Re: [DISCUSS] KIP-1165: Object Consolidation for Diskless", "Greg Harris", "07", false).build();
    const months = withRecorded(month);
    const body = await profile("mail:viktor somogyi-vass", { months });
    const greg = lineOf(body, "KIP-1165")!.authors!.find((author) => author.name === "Greg Harris")!;
    expect(greg.person).toEqual({ id: "mail:greg harris", rule: "discussion" });
    expect(text(section(await render(body)))).toContain("Greg Harris (named on the KIP page, wrote in its discussion)");
    expect(bases(lineOf(await profile("mail:greg harris", { months }), "KIP-1165"))).toEqual(["author"]);
  },
  "W95|same name, other KIP only": async () => {
    const month = new Month("2026-10").mail("t1150", "[DISCUSS] KIP-1150: Diskless Topics", "Greg Harris", "07", false).build();
    const months = withRecorded(month);
    const greg = lineOf(await profile("mail:viktor somogyi-vass", { months }), "KIP-1165")!.authors!.find((author) => author.name === "Greg Harris")!;
    expect(greg.person).toBeUndefined();
    expect(lineOf(await profile("mail:greg harris", { months }), "KIP-1165")).toBeUndefined();
  },
  "W95|linked by a declared entry": async () => {
    const scenario = committerScenario(committerLinks(capture([["A B", "a"]])));
    const body = await profile("github:a", scenario);
    const line = lineOf(body, "KIP-9100")!;
    expect(bases(line)).toEqual(["author"]);
    expect(line.authors![0]).toEqual({ name: "A B", person: { id: "github:a", rule: "declared" } });
    expect(line.facts[0]!.via!.map((step) => [step.basis, step.to.id, step.evidence.map((item) => item.url)])).toEqual([["declared", "mail:a b", [KAFKA_COMMITTERS_URL]]]);
    // Positive control: without the entry, A B is a plain name and github:a lists nothing.
    expect((await profile("github:a", committerScenario([]))).kips!.lines).toEqual([]);
  },
  "W95|a different written name": async () => {
    const month = new Month("2026-10").mail("t1272", "[DISCUSS] KIP-1272: constructed", "Henry Haiying Cai", "03", true).build();
    const body = await profile("mail:henry haiying cai", { months: [month], authors: authorsTable([page(1272, { authors: ["Henry Cai", "Thomas Thornton", "Greg Harris"] })]) });
    expect(lineOf(body, "KIP-1272")!.authors![0]).toEqual({ name: "Henry Cai" });
    expect(bases(lineOf(body, "KIP-1272"))).not.toContain("author");
  },
  "W95|names never join identities": async () => {
    const month = new Month("2026-10").pr(9102, "x").mail("t", "[VOTE] 9.9.9 RC0", "A B", "05", false).build();
    const table = links([month]);
    const before = JSON.stringify(table);
    const scenario: Store = { months: [month], links: table, authors: authorsTable([page(9100, { authors: ["A B"] })]) };
    expect((await profile("github:x", scenario)).kips!.lines).toEqual([]);
    expect((await profile("mail:a b", scenario)).kips!.lines).toEqual([]);
    expect(JSON.stringify(table)).toBe(before);
    // The identity-link job reads no author list: the table holds no link for either identity.
    expect(table.people.flatMap((person) => person.members.map((member) => member.id))).toEqual([]);
  },
  "W96|the section": async () => {
    const body = await profile("mail:viktor somogyi-vass");
    const line = lineOf(body, "KIP-1165")!;
    expect(line.title).toBe("Object Consolidation for Diskless");
    expect(line.authors!.map((author) => author.name)).toEqual(["Greg Harris", "Ivan Yurchenko", "Jorge Quilcate", "Giuseppe Lillo", "Anatolii Popov", "Juha Mynttinen", "Josep Prat", "Filip Yonov", "Viktor Somogyi-Vass"]);
    const html = section(await render(body));
    const kip = html.slice(html.indexOf('data-kip="KIP-1165"'));
    expect(kip).toContain(`href="${line.pageUrl}"`);
    expect(kip).toContain(`href="${line.discussion!.url}"`);
    expect(text(kip)).toContain("Authors: Greg Harris, Ivan Yurchenko, Jorge Quilcate, Giuseppe Lillo, Anatolii Popov, Juha Mynttinen, Josep Prat, Filip Yonov, Viktor Somogyi-Vass");
    expect(kip).toContain(`href="/kafka/people/${encodeURIComponent("mail:viktor somogyi-vass")}"`);
    expect(text(html)).toContain("Author lines and Jira issues: KIP pages changed since 2025-10-21, read 2026-10-21");
    expect(text(html)).toContain("a page without an author line lists only who started the discussion");
  },
  "W96|a linked identity": async () => {
    const month = new Month("2026-10").pr(9500, "x").build();
    const scenario: Store = { months: [month], links: links([month], [declared("github:x", "mail:x")]), authors: authorsTable([page(9500, { authors: ["X"] })]) };
    const line = lineOf(await profile("github:x", scenario), "KIP-9500")!;
    expect(bases(line)).toEqual(["author"]);
    expect(line.facts[0]!.via!.map((step) => step.basis)).toEqual(["declared"]);
  },
  "W98|table missing": async () => {
    for (const value of [null, "<html>", JSON.stringify({ schema: "osskb.kip-authors.v1", generatedAt: "x", coverageFrom: "y", pages: [{ kip: "one" }] })]) {
      const response = await api("mail:eric chang", { flag: "true", authors: value });
      expect(response.status).toBe(200);
      const body = await response.json() as PersonProfileV1;
      expect(body.kips!.authorLists).toEqual({ available: false });
      expect(bases(lineOf(body, "KIP-1371"))).toEqual(["starter"]);
      expect(lineOf(body, "KIP-1371")!.pageUrl).toBeUndefined();
      expect(text(section(await render(body)))).toContain("Author lists not available");
    }
  },
  "W102|names only": async () => {
    const usernames = new Set(RECORDED_PAGES.flatMap((item) => [item.version.by?.username, item.version.by?.userKey]).filter((value): value is string => typeof value === "string" && !GITHUB_LOGINS.has(value.toLowerCase())));
    expect(usernames.size).toBeGreaterThan(0);
    for (const person of ["mail:viktor somogyi-vass", "mail:eric chang", "github:unknowntpo", "mail:arnab nandy"]) {
      const response = await api(person, { flag: "true" });
      const json = await response.text();
      const html = await render(JSON.parse(json) as PersonProfileV1);
      for (const output of [json, html]) {
        for (const name of usernames) expect(output).not.toMatch(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u"));
        expect(output).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/u);
        expect(output).not.toMatch(/profilePicture|useravatar|avatarUrls|userKey|timeZone/u);
        expect(output).not.toContain("None of the below contents is final");
      }
    }
  },
  "W103|committers as declared links": async () => {
    const entries = committerLinks(capture([["A B", "a"], ["C D", "c"], ["E F", "e"], ["E F", "e2"]]));
    expect(entries).toEqual([
      { a: "github:a", b: "mail:a b", evidence: KAFKA_COMMITTERS_URL, date: "2026-10-21", reviewer: "unknowntpo" },
      { a: "github:c", b: "mail:c d", evidence: KAFKA_COMMITTERS_URL, date: "2026-10-21", reviewer: "unknowntpo" },
    ]);
    const line = lineOf(await profile("github:c", committerScenario(entries)), "KIP-9100")!;
    expect(line.authors![1]).toEqual({ name: "C D", person: { id: "github:c", rule: "declared" } });
  },
  "W103|refresh removes a pair": async () => {
    const previous = capture([["A B", "a"], ["C D", "b"]]);
    const diff = refreshCommitters(previous, [{ name: "A B", login: "a" }], { date: "2026-10-22", reviewer: "unknowntpo" });
    expect(diff.removed.map((pair) => pair.login)).toEqual(["b"]);
    const entries = committerLinks(diff.capture);
    expect(entries.map((entry) => entry.a)).toEqual(["github:a"]);
    // Before the refresh github:b lists KIP-9100 through C D; after it, the profile is split.
    expect(lineOf(await profile("github:b", committerScenario(committerLinks(previous))), "KIP-9100")).toBeDefined();
    expect((await profile("github:b", committerScenario(entries))).kips!.lines).toEqual([]);
  },
  "W103|blind check": async () => {
    const entries = committerLinks(capture([["A B", "a"]]));
    expect((await profile("github:a", committerScenario(entries, true))).kips!.lines).toEqual([]);
    expect(lineOf(await profile("github:a", committerScenario(entries, false)), "KIP-9100")).toBeDefined();
  },
  "W104|evidence must be a URL": async () => {
    expect(validDeclaredLink(OWNER_DECLARED_EXAMPLE)).toBe(false);
    const body = await profile("github:unknowntpo", { links: links(RECORDED, [OWNER_DECLARED_EXAMPLE]) });
    expect(bases(lineOf(body, "KIP-1371"))).toEqual(["assignee KAFKA-20995"]);
  },
  "W104|with a URL": async () => {
    const entry = { ...OWNER_DECLARED_EXAMPLE, evidence: "https://github.com/unknowntpo" };
    const body = await profile("github:unknowntpo", { links: links(RECORDED, [entry]) });
    const line = lineOf(body, "KIP-1371")!;
    expect(bases(line)).toEqual(["assignee KAFKA-20995", "starter"]);
    expect(line.facts[1]!.via!.map((step) => [step.basis, step.to.id])).toEqual([["declared", "mail:eric chang"]]);
  },
  "W94|assignee below the author line": async () => {
    // Recorded: KIP-1165's author line names Ivan Yurchenko; KAFKA-19161's assignee is his account. His Jira page gets a constructed row.
    const month = new Month("2026-10").issue("KAFKA-90001", "Ivan Yurchenko", null).build();
    const months = withRecorded(month);
    const unlinked = await profile("jira:ivan yurchenko", { months });
    expect(bases(lineOf(unlinked, "KIP-1165"))).toEqual(["assignee KAFKA-19161"]);
    expect(text(section(await render(unlinked)))).toContain("assigned the KIP's Jira issue (KAFKA-19161)");
    const table = links(months);
    const linkedTable: IdentityLinksTableV1 = {
      ...table,
      people: [...table.people, {
        members: [{ id: "jira-account:ivanyu", display: "Ivan Yurchenko" }, { id: "mail:ivan yurchenko" }],
        links: [{ a: "jira-account:ivanyu", b: "mail:ivan yurchenko", basis: "declared", evidence: [{ id: "declared", url: "https://example.org/statement" }] }],
      }],
    };
    const linked = await profile("jira:ivan yurchenko", { months, links: linkedTable });
    expect(bases(lineOf(linked, "KIP-1165"))).toEqual(["author", "assignee KAFKA-19161"]);
    expect(text(section(await render(linked)))).toContain("author (KIP page) · also assigned KAFKA-19161");
    expect(JSON.stringify(linked)).not.toMatch(/\bivanyu\b/u);
  },
  "W94|assignee above the starter": async () => {
    // Recorded starter (Mickael Maison, KIP-1376); KAFKA-20728's assignee Arnab Nandy as the spec recorded it, with a constructed account key.
    const month = new Month("2026-10").issue("KAFKA-90002", "Arnab Nandy", null).build();
    const months = withRecorded(month);
    const authors = authorsTable([...AUTHORS.pages.filter((item) => item.kip !== 1376), page(1376, { title: "Support setting TLS named groups", issues: [["KAFKA-20728", ["JIRAUSER900002", "Arnab Nandy"]]] })]);
    expect(bases(lineOf(await profile("jira:arnab nandy", { months, authors }), "KIP-1376"))).toEqual(["assignee KAFKA-20728"]);
    expect(bases(lineOf(await profile("mail:mickael maison", { months, authors }), "KIP-1376"))).toEqual(["starter"]);
  },
  "W109|activity log is newer": async () => {
    const months = [new Month("2026-10").issue("KAFKA-90003", "Person A", null).issue("KAFKA-90004", "Person B", null)
      .issue("KAFKA-90100", "Reporter", ["JIRAUSER-B", "Person B"], "2026-10-21T00:00:00Z").build()];
    const authors = authorsTable([page(9600, { issues: [["KAFKA-90100", ["JIRAUSER-A", "Person A"], "2026-10-20T03:43:00.000Z"]] })]);
    expect(bases(lineOf(await profile("jira:person b", { months, authors }), "KIP-9600"))).toEqual(["assignee KAFKA-90100"]);
    expect(lineOf(await profile("jira:person a", { months, authors }), "KIP-9600")).toBeUndefined();
    // Positive control: an older activity entry does not replace the job's newer reading.
    const older = [new Month("2026-10").issue("KAFKA-90003", "Person A", null).issue("KAFKA-90004", "Person B", null)
      .issue("KAFKA-90100", "Reporter", ["JIRAUSER-B", "Person B"], "2026-10-19T00:00:00Z").build()];
    expect(bases(lineOf(await profile("jira:person a", { months: older, authors }), "KIP-9600"))).toEqual(["assignee KAFKA-90100"]);
    expect(lineOf(await profile("jira:person b", { months: older, authors }), "KIP-9600")).toBeUndefined();
  },
  "W109|unassigned": async () => {
    expect(AUTHORS.pages.find((item) => item.kip === 1360)!.issues).toEqual([{ key: "KAFKA-20715", assignee: null, readAt: "2026-10-21T03:43:00.000Z" }]);
    // Nobody holds KAFKA-20715: an author of KIP-1360 who wrote in its discussion gets the author line only.
    const month = new Month("2026-10").mail("t1360", "[DISCUSS] KIP-1360: Cluster Synchronous Mirroring", "Luke Chen", "05", false).build();
    const body = await profile("mail:luke chen", { months: [month] });
    expect(bases(lineOf(body, "KIP-1360"))).toEqual(["author"]);
    expect(lineOf(body, "KIP-1360")!.issues).toEqual([{ key: "KAFKA-20715", url: "https://issues.apache.org/jira/browse/KAFKA-20715", assignee: null }]);
    expect(text(section(await render(body)))).toContain("KAFKA-20715 (unassigned)");
  },
  "W109|two people on two issues": async () => {
    const month = new Month("2026-10").issue("KAFKA-90005", "Chu Cheng Li", null).issue("KAFKA-90006", "Kamal Chandraprakash", null).build();
    const months = withRecorded(month);
    expect(bases(lineOf(await profile("jira:chu cheng li", { months }), "KIP-1105"))).toEqual(["assignee KAFKA-17928"]);
    expect(bases(lineOf(await profile("jira:kamal chandraprakash", { months }), "KIP-1105"))).toEqual(["assignee KAFKA-17980"]);
  },
  "W111|through a corroborated link": async () => {
    const body = await profile("github:unknowntpo");
    const line = lineOf(body, "KIP-1371")!;
    expect(bases(line)).toEqual(["assignee KAFKA-20995"]);
    const step = line.facts[0]!.via![0]!;
    expect([step.basis, step.to.source, step.to.display, step.to.id]).toEqual(["corroborated", "jira", "Eric Chang", "jira:eric chang"]);
    expect(step.evidence.map((item) => item.id)).toEqual(["KAFKA-21152", "KAFKA-21172", "KAFKA-21252", "KAFKA-21262", "KAFKA-21266", "KAFKA-21276"]);
    expect(JSON.stringify(body)).not.toContain("JIRAUSER306218");
    const html = text(section(await render(body)));
    expect(html).toContain("assigned the KIP's Jira issue (KAFKA-20995)");
    // Five keys and the rest counted (W69's five, plus KAFKA-21266 opened on the capture day).
    expect(html).toContain("Through Jira “Eric Chang” (corroborated): KAFKA-21152, KAFKA-21172, KAFKA-21252, KAFKA-21262, KAFKA-21266 and 1 more");
    // Positive control: the same request without the link table lists nothing.
    expect((await profile("github:unknowntpo", { links: null })).kips!.lines).toEqual([]);
  },
  "W111|no link": async () => {
    const month = new Month("2026-10").pr(9700, "x").build();
    expect((await profile("github:x", { months: withRecorded(month) })).kips!.lines).toEqual([]);
  },
  "W111|a committer holding the issue": async () => {
    // KIP-1311 as the spec recorded it (assignee Chia-Ping Tsai, starter Siddhartha Devineni), constructed.
    const month = new Month("2026-10").issue("KAFKA-90007", "Chia-Ping Tsai", null)
      .mail("t1311", "[DISCUSS] KIP-1311: constructed", "Siddhartha Devineni", "02", true).build();
    const authors = authorsTable([page(1311, { issues: [["KAFKA-90311", ["chia7712", "Chia-Ping Tsai"]]] })]);
    const body = await profile("jira:chia-ping tsai", { months: [month], authors });
    expect(bases(lineOf(body, "KIP-1311"))).toEqual(["assignee KAFKA-90311"]);
    const html = text(section(await render(body)));
    expect(html).toContain("assigned the KIP's Jira issue (KAFKA-90311)");
    expect(html).not.toContain("author (KIP page)");
    expect(JSON.stringify(body)).not.toMatch(/\bchia7712\b/u);
    expect(bases(lineOf(await profile("mail:siddhartha devineni", { months: [month], authors }), "KIP-1311"))).toEqual(["starter"]);
  },
};

