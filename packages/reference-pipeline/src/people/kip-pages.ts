/**
 * Spec 019 amendment (7), KIP authors revision: the `kip-pages` job. It reads the KIP pages changed
 * since its last good run from cwiki (Confluence REST, anonymous), takes each page's author line
 * and `JIRA:` field, reads the assignee of every issue the field names from ASF Jira, and keeps
 * one table per project under `internal/kips/v1/`. One responsibility: the facts a KIP page
 * states. It joins nothing (identity links stay with the identity-link job).
 *
 * Budget (W97, W101, W108): at most 10 cwiki and 3 Jira requests per run, sequential, 2 s apart,
 * 30 s timeout each, no retry. Any failed request or unparsable answer fails the run closed: no
 * table is written and the last good one stays.
 */
import { SOURCE_USER_AGENT } from "../kafka-connectors";
import { nameKey } from "../review-queue/roster";

export const KIP_AUTHORS_SCHEMA = "osskb.kip-authors.v1";
/** The one supported value of `KIP_PAGES`. */
export const KIP_PAGES_REVISION = "authors@1";
export const KIP_PAGES_LAST_RUN_KEY = "internal/kips/v1/last-run.json";
export const kipAuthorsKey = (projectId: string) => `internal/kips/v1/${projectId}/authors.json`;

export const KIP_PAGES_BUDGET = {
  cwikiRequests: 10,
  jiraRequests: 3,
  jiraKeysPerRequest: 100,
  spacingMs: 2000,
  timeoutMs: 90_000,
} as const;

const DAY_MS = 86_400_000;
const FIRST_RUN_DAYS = 365;
const CWIKI_BASE = "https://cwiki.apache.org/confluence";
const JIRA_SEARCH = "https://issues.apache.org/jira/rest/api/2/search";

/** Where a project's KIPs live (spec: `PeopleProfile.kipPages`). Kafka only; DataFusion has none. */
export interface KipPagesProfile {
  readonly projectId: string;
  readonly space: string;
  readonly titlePrefix: string;
  /** The Jira project whose keys the `JIRA:` field names. */
  readonly jiraProject: string;
}

export const KAFKA_KIP_PAGES: KipPagesProfile = { projectId: "apache-kafka", space: "KAFKA", titlePrefix: "KIP-", jiraProject: "KAFKA" };

export type KipAuthorStatus = "listed" | "no-list" | "unparsed";
export type KipJiraField = "one" | "several" | "empty" | "query" | "none";

export interface KipAuthorV1 { readonly name: string; readonly nameKey: string }
export interface KipIssueV1 {
  readonly key: string;
  readonly assignee: { readonly key: string; readonly display: string } | null;
  readonly readAt: string;
}
export interface KipPageV1 {
  readonly kip: number;
  readonly pageId: string;
  readonly version: number;
  readonly title: string;
  readonly url: string;
  readonly status: KipAuthorStatus;
  readonly authors: readonly KipAuthorV1[];
  readonly jira: KipJiraField;
  readonly issues: readonly KipIssueV1[];
}
export interface KipAuthorsTableV1 {
  readonly schema: typeof KIP_AUTHORS_SCHEMA;
  /** The start of the run that last changed the table's content. */
  readonly generatedAt: string;
  /** Pages modified since this time are covered (the first run's `since`). */
  readonly coverageFrom: string;
  readonly pages: readonly KipPageV1[];
}

export type KipPagesRunStatus = "ok" | "unchanged" | "failed" | "over-budget";
export interface KipPagesLastRunV1 {
  readonly ok: boolean;
  readonly status: KipPagesRunStatus;
  readonly at: string;
  readonly durationMs: number;
  readonly since: string | null;
  readonly requests: number;
  readonly jiraRequests: number;
  /** Results the search answered in this run, KIP or not. */
  readonly pagesRead: number;
  /** KIP pages new to the table or with a new version. */
  readonly pagesChanged: number;
  /** Pages in the resulting table with an author list, and with a line that is not a list. */
  readonly listed: number;
  readonly unparsed: number;
  /** Issues Jira answered in this run, and how many of them have no assignee. */
  readonly issuesRead: number;
  readonly unassigned: number;
  readonly bytesWritten: number;
  readonly r2: { readonly classA: number; readonly classB: number };
  readonly error?: string;
}
/** `last-run.json`, served unchanged as `/health` `kipPages` (W100). */
export interface KipPagesHealthV1 {
  readonly revision: string;
  readonly lastRun: KipPagesLastRunV1 | null;
  readonly lastGoodAt: string | null;
  readonly coverageFrom: string | null;
}

// ---------------------------------------------------------------------------------------------
// Reading a page (W93, W107)

export interface KipHeader {
  readonly status: KipAuthorStatus;
  readonly authors: readonly KipAuthorV1[];
  readonly jira: KipJiraField;
  readonly keys: readonly string[];
}

interface Block {
  /** Text with each user mention as `\u0001name\u0002`. */
  readonly text: string;
  /** Jira keys in the block's links, macros and text, in order. */
  readonly keys: readonly string[];
  /** Whether the block holds a Jira macro without a key (a query). */
  readonly query: boolean;
}

const MENTION_OPEN = "\u0001";
const MENTION_CLOSE = "\u0002";
const SPLIT = "\u0003";
const BLOCK_TAGS = new Set(["p", "td", "th"]);
const HEADING = /^h[1-6]$/u;
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gu;

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu").exec(attributes);
  return match === null ? undefined : decode(match[1] ?? match[2] ?? "");
}

/**
 * The page header: everything before the first heading that follows the `Status` heading, or
 * before the first heading when the page has none (KIP-1165's line sits above `Status`, KIP-1026's
 * below it, KIP-1381 puts a title heading above `Status`).
 */
function headerOf(html: string): string {
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/giu)];
  const status = headings.findIndex((match) => decode(match[2]!.replace(/<[^>]*>/gu, "")).trim().toLowerCase() === "status");
  const end = headings[status < 0 ? 0 : status + 1];
  return end === undefined ? html : html.slice(0, end.index);
}

/** The header's paragraphs and table cells, in the order they close (an inner block first). */
function blocksOf(html: string, jiraProject: string): Block[] {
  const keyPattern = new RegExp(`\\b${jiraProject}-\\d+\\b`, "gu");
  interface Frame { text: string; keys: string[]; query: boolean }
  const frames: Frame[] = [];
  const blocks: Block[] = [];
  let mention: string | undefined;
  let headingDepth = 0;
  const addText = (raw: string) => {
    if (headingDepth > 0) return;
    const text = decode(raw);
    if (mention !== undefined) {
      mention += text;
      return;
    }
    for (const frame of frames) {
      frame.text += text;
      frame.keys.push(...(text.match(keyPattern) ?? []));
    }
  };
  let last = 0;
  for (const match of html.matchAll(TAG)) {
    addText(html.slice(last, match.index));
    last = match.index + match[0].length;
    const closing = match[1] === "/";
    const tag = match[2]!.toLowerCase();
    const attributes = match[3] ?? "";
    if (HEADING.test(tag)) {
      headingDepth = Math.max(0, headingDepth + (closing ? -1 : 1));
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      if (!closing) frames.push({ text: "", keys: [], query: false });
      else {
        const frame = frames.pop();
        if (frame !== undefined) blocks.push(frame);
      }
      continue;
    }
    if (tag === "br" && mention === undefined) {
      for (const frame of frames) frame.text += " ";
      continue;
    }
    if (tag === "a" && closing && mention !== undefined) {
      const name = mention;
      mention = undefined;
      for (const frame of frames) frame.text += `${MENTION_OPEN}${name}${MENTION_CLOSE}`;
      continue;
    }
    if (closing) continue;
    if (tag === "a" && /\buser-mention\b/u.test(attribute(attributes, "class") ?? "") && !match[0].endsWith("/>")) {
      mention = "";
      continue;
    }
    const keys = [attribute(attributes, "data-jira-key"), attribute(attributes, "href")]
      .flatMap((value) => (value === undefined ? [] : value.match(keyPattern) ?? []));
    const jiraMacro = attribute(attributes, "data-macro-name") === "jira" && attribute(attributes, "data-jira-key") === undefined;
    for (const frame of frames) {
      frame.keys.push(...keys);
      if (jiraMacro) frame.query = true;
    }
  }
  addText(html.slice(last));
  while (frames.length > 0) blocks.push(frames.pop()!);
  return blocks;
}

const squash = (text: string) => text.replace(/\s+/gu, " ").trim();
const AUTHOR_LABEL = /^(?:co-)?authors?\s*:/iu;
/** 1 to 5 words of letters (any script), `.`, `-` and `'`. */
const NAME = /^[\p{L}\p{M}.'-]+(?: [\p{L}\p{M}.'-]+){0,4}$/u;

/** W93: the author line's names, or why there are none. */
function authorsOf(block: Block | undefined): Pick<KipHeader, "status" | "authors"> {
  if (block === undefined) return { status: "no-list", authors: [] };
  const value = squash(block.text).replace(AUTHOR_LABEL, "");
  const parts: string[] = [];
  for (const piece of value.split(new RegExp(`(${MENTION_OPEN}[^${MENTION_CLOSE}]*${MENTION_CLOSE})`, "u"))) {
    if (piece.startsWith(MENTION_OPEN)) {
      parts.push(piece.slice(1, -1));
      continue;
    }
    const text = piece
      .replace(/<[^<>]*>/gu, SPLIT) // an address in angle brackets goes with its brackets (KIP-1183)
      .replace(/\(([^()]*)\)/gu, `${SPLIT}$1${SPLIT}`); // a parenthesized part is its own part (KIP-1258)
    parts.push(...text.split(new RegExp(`[,;&${SPLIT}]|\\s+and\\s+`, "u")));
  }
  const names = parts.map(squash).filter((part) => part !== "" && !/[@<>]/u.test(part));
  if (names.length === 0 || names.some((name) => !NAME.test(name) || !/\p{L}/u.test(name))) return { status: "unparsed", authors: [] };
  return { status: "listed", authors: names.map((name) => ({ name, nameKey: nameKey(name).toLowerCase() })) };
}

/** W107: the `JIRA:` field's keys in page order, without duplicates and without the template's `<project>-1`. */
function jiraOf(block: Block | undefined, jiraProject: string): Pick<KipHeader, "jira" | "keys"> {
  if (block === undefined) return { jira: "none", keys: [] };
  const keys = [...new Set(block.keys)].filter((key) => key !== `${jiraProject}-1`);
  if (keys.length > 0) return { jira: keys.length === 1 ? "one" : "several", keys };
  return { jira: block.query ? "query" : "empty", keys: [] };
}

/** Reads a page's rendered view (`body.view`): its author line and its `JIRA:` field. */
export function parseKipHeader(html: string, profile: KipPagesProfile): KipHeader {
  const blocks = blocksOf(headerOf(html), profile.jiraProject);
  const text = (block: Block) => squash(block.text.replaceAll(MENTION_OPEN, " ").replaceAll(MENTION_CLOSE, " "));
  return {
    ...authorsOf(blocks.find((block) => AUTHOR_LABEL.test(text(block)))),
    ...jiraOf(blocks.find((block) => /^jira/iu.test(text(block))), profile.jiraProject),
  };
}

// ---------------------------------------------------------------------------------------------
// The run (W97, W100, W105, W108)

export interface KipPagesBucket {
  /** The object's text, or undefined when absent. One Class B request. */
  get(key: string): Promise<string | undefined>;
  /** A plain put. One Class A request. */
  put(key: string, body: string): Promise<void>;
}

export interface KipPagesRunDeps {
  /** The value of `KIP_PAGES`; only `authors@1` runs. */
  readonly flag: string;
  readonly profile: KipPagesProfile;
  readonly bucket: KipPagesBucket;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly delay: (ms: number) => Promise<void>;
  /** Reads and parses, writes nothing. */
  readonly dryRun?: boolean;
}

class RunFailure extends Error {
  constructor(message: string, readonly status: "failed" | "over-budget" = "failed") {
    super(message);
  }
}

interface SearchPage {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly html: string;
}

function searchPages(body: unknown): { readonly pages: SearchPage[]; readonly next: string | undefined; readonly base: string } {
  const value = body as { results?: unknown; _links?: { next?: unknown; base?: unknown } } | null;
  if (value === null || typeof value !== "object" || !Array.isArray(value.results)) throw new RunFailure("cwiki answered without a results list");
  const pages = value.results.map((item: unknown) => {
    const result = item as { id?: unknown; title?: unknown; version?: { number?: unknown }; body?: { view?: { value?: unknown } } } | null;
    const html = result?.body?.view?.value;
    if (result === null || typeof result !== "object" || typeof result.id !== "string" || typeof result.title !== "string" ||
      typeof result.version?.number !== "number" || typeof html !== "string") throw new RunFailure("cwiki answered a result without id, title, version or body.view");
    return { id: result.id, title: result.title, version: result.version.number, html };
  });
  const next = value._links?.next;
  const base = typeof value._links?.base === "string" ? value._links.base : CWIKI_BASE;
  return { pages, next: typeof next === "string" && next !== "" ? next : undefined, base };
}

function assigneesOf(body: unknown): Map<string, KipIssueV1["assignee"]> {
  const value = body as { issues?: unknown } | null;
  if (value === null || typeof value !== "object" || !Array.isArray(value.issues)) throw new RunFailure("Jira answered without an issues list");
  const result = new Map<string, KipIssueV1["assignee"]>();
  for (const item of value.issues) {
    const issue = item as { key?: unknown; fields?: { assignee?: unknown } } | null;
    if (issue === null || typeof issue !== "object" || typeof issue.key !== "string" || issue.fields === undefined) throw new RunFailure("Jira answered an issue without key or fields");
    const assignee = issue.fields.assignee as { key?: unknown; displayName?: unknown } | null | undefined;
    if (assignee === null || assignee === undefined) {
      result.set(issue.key, null);
      continue;
    }
    if (typeof assignee.key !== "string" || typeof assignee.displayName !== "string") throw new RunFailure("Jira answered an assignee without key or displayName");
    // W110: the key and the display name only.
    result.set(issue.key, { key: assignee.key, display: assignee.displayName });
  }
  return result;
}

const iso = (ms: number) => new Date(ms).toISOString();
const cqlDate = (ms: number) => iso(ms).slice(0, 10);

export function kipSearchUrl(profile: KipPagesProfile, since: number): string {
  const params = new URLSearchParams({
    cql: `space=${profile.space} and type=page and title~"${profile.titlePrefix.replace(/-$/u, "")}" and lastmodified >= "${cqlDate(since)}" order by lastmodified asc`,
    expand: "body.view,version",
    limit: "50",
  });
  return `${CWIKI_BASE}/rest/api/content/search?${params}`;
}

export function jiraAssigneeUrl(keys: readonly string[]): string {
  const params = new URLSearchParams({ jql: `key in (${keys.join(",")})`, fields: "assignee", validateQuery: "warn", maxResults: String(KIP_PAGES_BUDGET.jiraKeysPerRequest) });
  return `${JIRA_SEARCH}?${params}`;
}

/** Sorted pages and a fixed key order, so equal inputs give equal bytes. */
export function serializeKipTable(table: KipAuthorsTableV1): string {
  const pages = [...table.pages].sort((a, b) => a.kip - b.kip || Number(a.pageId) - Number(b.pageId) || (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0));
  return `${JSON.stringify({
    schema: KIP_AUTHORS_SCHEMA,
    generatedAt: table.generatedAt,
    coverageFrom: table.coverageFrom,
    pages: pages.map((page) => ({
      kip: page.kip, pageId: page.pageId, version: page.version, title: page.title, url: page.url, status: page.status,
      authors: page.authors.map((author) => ({ name: author.name, nameKey: author.nameKey })),
      jira: page.jira,
      issues: page.issues.map((issue) => ({ key: issue.key, assignee: issue.assignee === null ? null : { key: issue.assignee.key, display: issue.assignee.display }, readAt: issue.readAt })),
    })),
  })}\n`;
}

function parseTable(text: string): KipAuthorsTableV1 {
  const value = JSON.parse(text) as Partial<KipAuthorsTableV1>;
  if (value.schema !== KIP_AUTHORS_SCHEMA || typeof value.generatedAt !== "string" || typeof value.coverageFrom !== "string" || !Array.isArray(value.pages)) {
    throw new Error("not an osskb.kip-authors.v1 table");
  }
  return value as KipAuthorsTableV1;
}

function parseHealth(text: string | undefined): KipPagesHealthV1 | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<KipPagesHealthV1>;
    return typeof value === "object" && value !== null ? value as KipPagesHealthV1 : undefined;
  } catch {
    return undefined;
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** One run of the job for one project. Never throws; the record says what happened. */
export async function runKipPages(deps: KipPagesRunDeps): Promise<KipPagesHealthV1> {
  const start = deps.now();
  const at = iso(start);
  const dryRun = deps.dryRun === true;
  const r2 = { classA: 0, classB: 0 };
  const counts = { requests: 0, jiraRequests: 0, pagesRead: 0, pagesChanged: 0, listed: 0, unparsed: 0, issuesRead: 0, unassigned: 0, bytesWritten: 0 };
  let since: number | undefined;
  let previousHealth: KipPagesHealthV1 | undefined;
  let lastGoodAt: string | null = null;
  let coverageFrom: string | null = null;
  let status: KipPagesRunStatus = "failed";
  let error: string | undefined;
  const headers = { Accept: "application/json", "User-Agent": SOURCE_USER_AGENT };
  let upstreamCalls = 0;
  const call = async (url: string): Promise<unknown> => {
    if (upstreamCalls > 0) await deps.delay(KIP_PAGES_BUDGET.spacingMs);
    upstreamCalls += 1;
    let response: Response;
    try {
      response = await deps.fetch(url, { headers, signal: AbortSignal.timeout(KIP_PAGES_BUDGET.timeoutMs) });
    } catch (cause) {
      throw new RunFailure(`${new URL(url).host}: ${errorText(cause)}`);
    }
    if (!response.ok) throw new RunFailure(`${new URL(url).host} answered ${response.status}`);
    try {
      return JSON.parse(await response.text()) as unknown;
    } catch {
      throw new RunFailure(`${new URL(url).host} answered a body that is not JSON`);
    }
  };

  try {
    if (deps.flag.trim() !== KIP_PAGES_REVISION) throw new RunFailure(`KIP_PAGES is ${JSON.stringify(deps.flag)}; only ${KIP_PAGES_REVISION} is supported`);
    const tableKey = kipAuthorsKey(deps.profile.projectId);
    r2.classB += 1;
    const previousText = await deps.bucket.get(tableKey);
    r2.classB += 1;
    previousHealth = parseHealth(await deps.bucket.get(KIP_PAGES_LAST_RUN_KEY));
    lastGoodAt = previousHealth?.lastGoodAt ?? null;
    coverageFrom = previousHealth?.coverageFrom ?? null;
    let previous: KipAuthorsTableV1 | undefined;
    try {
      previous = previousText === undefined ? undefined : parseTable(previousText);
    } catch (cause) {
      throw new RunFailure(`the previous table is unreadable: ${errorText(cause)}`);
    }
    // W105: the last good run's start minus one day; 365 days back without a table.
    const lastGood = previous === undefined ? undefined : Date.parse(lastGoodAt ?? previous.generatedAt);
    since = lastGood === undefined || Number.isNaN(lastGood) ? start - FIRST_RUN_DAYS * DAY_MS : lastGood - DAY_MS;
    const tableCoverage = previous?.coverageFrom ?? iso(since);

    // cwiki, page by page.
    const results: SearchPage[] = [];
    let url: string | undefined = kipSearchUrl(deps.profile, since);
    while (url !== undefined) {
      if (counts.requests >= KIP_PAGES_BUDGET.cwikiRequests) throw new RunFailure(`the window needs more than ${KIP_PAGES_BUDGET.cwikiRequests} cwiki requests`, "over-budget");
      counts.requests += 1;
      const answer = searchPages(await call(url));
      results.push(...answer.pages);
      counts.pagesRead += answer.pages.length;
      url = answer.next === undefined ? undefined : new URL(answer.next.startsWith("/") ? `${answer.base}${answer.next}` : answer.next).href;
    }

    // Pages: replaced when the version changes, kept otherwise.
    const kipPattern = new RegExp(`^${deps.profile.titlePrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(\\d+)\\b`, "u");
    const byId = new Map((previous?.pages ?? []).map((page) => [page.pageId, page]));
    const changed = new Map<string, { readonly page: SearchPage; readonly kip: number; readonly header: KipHeader }>();
    for (const page of results) {
      const kip = kipPattern.exec(page.title);
      if (kip === null) continue;
      if (byId.get(page.id)?.version === page.version) continue;
      changed.set(page.id, { page, kip: Number(kip[1]), header: parseKipHeader(page.html, deps.profile) });
    }
    counts.pagesChanged = changed.size;

    // Jira: the keys of changed pages; on Mondays also every other key, oldest reading first.
    const changedKeys = [...new Set([...changed.values()].flatMap((entry) => entry.header.keys))];
    const capacity = KIP_PAGES_BUDGET.jiraRequests * KIP_PAGES_BUDGET.jiraKeysPerRequest;
    if (changedKeys.length > capacity) throw new RunFailure(`${changedKeys.length} Jira keys need more than ${KIP_PAGES_BUDGET.jiraRequests} Jira requests`, "over-budget");
    const toRead = [...changedKeys];
    if (new Date(start).getUTCDay() === 1) {
      const chosen = new Set(changedKeys);
      const stored = [...byId.values()].filter((page) => !changed.has(page.pageId))
        .flatMap((page) => page.issues)
        .filter((issue) => !chosen.has(issue.key) && (chosen.add(issue.key), true))
        .sort((a, b) => (a.readAt < b.readAt ? -1 : a.readAt > b.readAt ? 1 : 0));
      toRead.push(...stored.slice(0, capacity - toRead.length).map((issue) => issue.key));
    }
    const readings = new Map<string, KipIssueV1["assignee"]>();
    for (let offset = 0; offset < toRead.length; offset += KIP_PAGES_BUDGET.jiraKeysPerRequest) {
      counts.jiraRequests += 1;
      const batch = toRead.slice(offset, offset + KIP_PAGES_BUDGET.jiraKeysPerRequest);
      const answered = assigneesOf(await call(jiraAssigneeUrl(batch)));
      // Only the keys asked for: an issue answered under another key (moved) is not this page's.
      for (const key of batch) if (answered.has(key)) readings.set(key, answered.get(key)!);
    }
    counts.issuesRead = readings.size;
    counts.unassigned = [...readings.values()].filter((assignee) => assignee === null).length;

    // W108/W109: the newest reading wins; a key read and not answered is dropped; earlier assignees are not kept.
    const readKeys = new Set(toRead);
    const previousIssues = new Map((previous?.pages ?? []).flatMap((page) => page.issues.map((issue) => [issue.key, issue] as const)));
    const issuesFor = (keys: readonly string[]): KipIssueV1[] => keys.flatMap((key) => {
      if (readings.has(key)) return [{ key, assignee: readings.get(key)!, readAt: at }];
      if (readKeys.has(key)) return [];
      const kept = previousIssues.get(key);
      return kept === undefined ? [] : [kept];
    });
    const pages: KipPageV1[] = [...byId.values()].filter((page) => !changed.has(page.pageId))
      .map((page) => ({ ...page, issues: issuesFor(page.issues.map((issue) => issue.key)) }));
    for (const { page, kip, header } of changed.values()) {
      pages.push({
        kip, pageId: page.id, version: page.version, title: page.title,
        url: `${CWIKI_BASE}/pages/viewpage.action?pageId=${encodeURIComponent(page.id)}`,
        status: header.status, authors: header.authors, jira: header.jira, issues: issuesFor(header.keys),
      });
    }
    counts.listed = pages.filter((page) => page.status === "listed").length;
    counts.unparsed = pages.filter((page) => page.status === "unparsed").length;

    // Written only when the content changes; `generatedAt` is the run that changed it.
    const before = previous === undefined ? undefined : serializeKipTable(previous);
    const same = previous === undefined ? undefined : serializeKipTable({ schema: KIP_AUTHORS_SCHEMA, generatedAt: previous.generatedAt, coverageFrom: tableCoverage, pages });
    if (before !== undefined && before === same) status = "unchanged";
    else {
      status = "ok";
      const body = serializeKipTable({ schema: KIP_AUTHORS_SCHEMA, generatedAt: at, coverageFrom: tableCoverage, pages });
      if (!dryRun) {
        r2.classA += 1;
        await deps.bucket.put(tableKey, body);
        counts.bytesWritten = new TextEncoder().encode(body).byteLength;
      }
    }
    coverageFrom = tableCoverage;
    lastGoodAt = dryRun ? lastGoodAt : at;
  } catch (cause) {
    status = cause instanceof RunFailure ? cause.status : "failed";
    error = errorText(cause);
  }

  const ok = status === "ok" || status === "unchanged";
  const record = (classA: number): KipPagesHealthV1 => ({
    revision: deps.flag.trim(),
    lastRun: {
      ok, status, at, durationMs: Math.max(0, deps.now() - start), since: since === undefined ? null : iso(since),
      ...counts, r2: { classA, classB: r2.classB }, ...(error === undefined ? {} : { error }),
    },
    lastGoodAt,
    coverageFrom,
  });
  if (dryRun) return record(r2.classA);
  const health = record(r2.classA + 1);
  try {
    await deps.bucket.put(KIP_PAGES_LAST_RUN_KEY, `${JSON.stringify(health)}\n`);
  } catch (cause) {
    console.error(`kip-pages: the run record was not written: ${errorText(cause)}`);
  }
  return health;
}
