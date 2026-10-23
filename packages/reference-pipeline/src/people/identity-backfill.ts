/**
 * Spec 019 amendment (8): the `identity-backfill` job. One calendar month per run, newest first,
 * from `min(month(coverageFrom), month(now) − 1)` back to the identity-link horizon: the month's
 * apache/kafka pull requests (GitHub GraphQL search) whose title names a `KAFKA-n`, and the Jira
 * assignee of each key (ASF Jira REST, anonymous). It writes the month to its own internal store,
 * `internal/identity/v1/<projectId>/backfill/<YYYY-MM>.json`, in the activity month schema with
 * threads only (so `parseActivityMonth` and `IdentityFacts.add` read it unchanged), then its record
 * `internal/identity/v1/backfill-last-run.json`. Only the identity-link job reads the store, and only
 * behind `IDENTITY_LINKS_BACKFILL=read`.
 *
 * Upstream budget (W120–W122, W128): at most 5 GitHub and 4 Jira requests a run, sequential, at
 * least 3 s apart, 30 s timeout each, no retry. The first 429, rate-limit 403, 5xx, timeout,
 * network error, unparsable body, GraphQL `errors`, `Retry-After` or GitHub remaining budget below
 * 1,000 stops the run: no month is written, the record says why. A month is atomic: written whole
 * or not at all; the record's finished months are the only cursor.
 */
import { compileIdentifierProfiles } from "@oss-knowledge-base/search";

import { SOURCE_USER_AGENT } from "../kafka-connectors";
import { extractKeys } from "../kafka-rules";
import { searchIdentifierProfiles } from "../search/profiles";
import {
  activityMonth,
  activityPersonId,
  encodeActivityMonth,
  parseActivityState,
  peopleActivityStateKey,
  PEOPLE_ACTIVITY_SCHEMA,
  type ActivityMonthV1,
  type ActivityThreadV1,
} from "./activity";

/** The one supported value of `IDENTITY_BACKFILL`. */
export const IDENTITY_BACKFILL_REVISION = "prs@1";
/** The one supported value of `IDENTITY_LINKS_BACKFILL`: the identity-link job reads the store. */
export const IDENTITY_LINKS_BACKFILL_READ = "read";

const IDENTITY_PREFIX = "internal/identity/v1/";
export const identityBackfillPrefix = (projectId: string) => `${IDENTITY_PREFIX}${projectId}/backfill/`;
export const identityBackfillMonthKey = (projectId: string, month: string) => `${identityBackfillPrefix(projectId)}${month}.json`;
export const IDENTITY_BACKFILL_LAST_RUN_KEY = `${IDENTITY_PREFIX}backfill-last-run.json`;

export const IDENTITY_BACKFILL_BUDGET = {
  githubRequests: 5,
  jiraRequests: 4,
  /**
   * GitHub search answers at most 1,000 results per query; `pageSize` × `githubRequests` (500) stays
   * below it, so the more-than-5-pages rule also stops every month above that cap.
   */
  pageSize: 100,
  jiraKeysPerRequest: 100,
  spacingMs: 3_000,
  timeoutMs: 30_000,
  /** The token is shared with the publication and Spec 022: stop when less than this is left. */
  minRemaining: 1_000,
  /** `POST /identity-backfill/run` answers 409 within this long of the last run (W126). */
  manualGuardMs: 60 * 60_000,
} as const;

/** The identity-link job's window: the newest 12 calendar months (`HORIZON_MONTHS` in its run). */
export const BACKFILL_HORIZON_MONTHS = 12;

export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
export const JIRA_SEARCH_URL = "https://issues.apache.org/jira/rest/api/2/search";
const JIRA_BROWSE_URL = "https://issues.apache.org/jira/browse/";

/** Where a project's backfill reads from. Kafka only (the only profile with a `corroboration` config). */
export interface IdentityBackfillProfile {
  readonly projectId: string;
  /** `owner/name` of the GitHub repository. */
  readonly repository: string;
  /** The activity log's thread prefix (`KAFKA` → `KAFKA-PR-<n>`). */
  readonly threadPrefix: string;
  /** The Jira key prefix edge A pairs (`KAFKA-`). */
  readonly issueKey: string;
}

export const KAFKA_IDENTITY_BACKFILL: IdentityBackfillProfile = {
  projectId: "apache-kafka", repository: "apache/kafka", threadPrefix: "KAFKA", issueKey: "KAFKA-",
};

export type IdentityBackfillStatus = "ok" | "complete" | "failed" | "limited" | "over-budget";

/** W130: `/health` `identityBackfill.lastRun`. */
export interface IdentityBackfillLastRunV1 {
  readonly ok: boolean;
  readonly status: IdentityBackfillStatus;
  readonly at: string;
  readonly durationMs: number;
  /** The month this run read (or tried to), null when it read none. */
  readonly month: string | null;
  /** Pull requests of the month GitHub answered, those with a key, the distinct keys, and the keys with an assignee. */
  readonly prs: number;
  readonly keyedPrs: number;
  readonly keys: number;
  readonly assigned: number;
  readonly requests: { readonly github: number; readonly jira: number };
  /** `limited` only: no cron run sends anything before this time. */
  readonly retryAfter?: string;
  readonly bytesWritten: number;
  readonly r2: { readonly classA: number; readonly classB: number };
  readonly error?: string;
  /** Spec 028: present only while `OBSERVABILITY_SIGNALS=on`. */
  readonly runId?: string;
  readonly trends?: unknown;
}

/** `backfill-last-run.json`, served unchanged as `/health` `identityBackfill` (W130). */
export interface IdentityBackfillRecordV1 {
  readonly revision: string;
  readonly lastRun: IdentityBackfillLastRunV1 | null;
  /** `done`: finished months, oldest first (the cursor); `next`: the month the next run reads; `remaining`: months left in the range. */
  readonly months: { readonly done: readonly string[]; readonly next: string | null; readonly remaining: number };
  /** The range of the last run that read the log's state: the horizon start and the newest month to fill. */
  readonly from: string | null;
  readonly until: string | null;
}

// ---------------------------------------------------------------------------------------------
// Months (W115)

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;

export function addMonths(month: string, count: number): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (number - 1) + count;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/**
 * The months the backfill fills, newest first: from `min(month(coverageFrom), month(now) − 1)` back
 * to the horizon start `month(now) − 11`, inclusive. The current month is never backfilled.
 */
export function backfillRange(nowMs: number, coverageFrom: string): { readonly from: string; readonly until: string; readonly months: readonly string[] } {
  const now = activityMonth(new Date(nowMs).toISOString());
  const coverage = activityMonth(coverageFrom);
  const previous = addMonths(now, -1);
  const until = coverage < previous ? coverage : previous;
  const from = addMonths(now, -(BACKFILL_HORIZON_MONTHS - 1));
  const months: string[] = [];
  for (let month = until; month >= from; month = addMonths(month, -1)) months.push(month);
  return { from, until, months };
}

/**
 * W116, W123: the finished months the identity-link job reads inside its window (ascending), or
 * throws when they are not contiguous with the log: the newest month to fill (`until`) missing
 * while some month is finished (a gap), or a finished month below a missing one (a hole). Empty
 * when nothing is finished or nothing of the window precedes the log.
 */
export function backfillMonthsToRead(input: { readonly done: readonly string[]; readonly window: readonly string[]; readonly until: string }): readonly string[] {
  const done = new Set(input.done);
  if (done.size === 0) return [];
  const needed = [...input.window].filter((month) => month <= input.until).sort().reverse();
  if (needed.length === 0) return [];
  if (!done.has(needed[0]!)) {
    const newest = [...done].sort().at(-1)!;
    throw new Error(`the backfill has a gap: its newest finished month is ${newest}, the first month to fill is ${needed[0]}`);
  }
  const read: string[] = [];
  let index = 0;
  while (index < needed.length && done.has(needed[index]!)) read.push(needed[index++]!);
  const below = needed.slice(index).find((month) => done.has(month));
  if (below !== undefined) throw new Error(`the backfill has a hole: ${needed[index]} is not finished, ${below} is`);
  return read.reverse();
}

/** Reads a stored record; throws on any other shape (the identity-link job then fails closed, W123). */
export function parseIdentityBackfillRecord(value: unknown): IdentityBackfillRecordV1 {
  const record = value as Partial<IdentityBackfillRecordV1> | null;
  const months = record?.months as Partial<IdentityBackfillRecordV1["months"]> | undefined;
  if (record === null || typeof record !== "object" || typeof record.revision !== "string" || months === null || typeof months !== "object" ||
      !Array.isArray(months.done) || !months.done.every((month) => typeof month === "string" && MONTH.test(month))) {
    throw new Error("the backfill record is malformed");
  }
  return record as IdentityBackfillRecordV1;
}

// ---------------------------------------------------------------------------------------------
// Reading a month (W113, W114)

const identifiers = compileIdentifierProfiles(searchIdentifierProfiles);

/** The `KAFKA-n` keys of a title by the project's search pattern (`KAFKA1234` too), as edge A reads them. */
export function titleKeys(profile: IdentityBackfillProfile, title: string): readonly string[] {
  return identifiers.identifiersOf(profile.projectId, title, "")
    .map((identifier) => identifier.toUpperCase())
    .filter((identifier) => identifier.startsWith(profile.issueKey));
}

const lastDay = (month: string) => {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, "0")}`;
};

/** GitHub search over the month's creation times, in UTC, oldest first. */
export function monthSearchQuery(profile: IdentityBackfillProfile, month: string): string {
  return `repo:${profile.repository} is:pr created:${month}-01T00:00:00+00:00..${lastDay(month)}T23:59:59+00:00 sort:created-asc`;
}

export const MONTH_SEARCH_GRAPHQL = "query($q: String!, $after: String) { rateLimit { remaining resetAt } "
  + `search(type: ISSUE, first: ${IDENTITY_BACKFILL_BUDGET.pageSize}, after: $after, query: $q) { issueCount pageInfo { hasNextPage endCursor } `
  + "nodes { ... on PullRequest { number title createdAt url author { __typename login } } } } }";

export function jiraAssigneesUrl(keys: readonly string[]): string {
  const params = new URLSearchParams({ jql: `key in (${keys.join(",")})`, fields: "assignee", validateQuery: "warn", maxResults: String(IDENTITY_BACKFILL_BUDGET.jiraKeysPerRequest) });
  return `${JIRA_SEARCH_URL}?${params}`;
}

export interface SearchNode {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
  readonly url: string;
  readonly author: { readonly __typename: string; readonly login: string } | null;
}

export interface SearchPage {
  readonly issueCount: number;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly nodes: readonly SearchNode[];
  readonly remaining: number | null;
  readonly resetAt: string | null;
}

class RunFailure extends Error {
  constructor(message: string, readonly status: "failed" | "limited" | "over-budget" = "failed", readonly retryAfter?: string) {
    super(message);
  }
}

/** One GraphQL search answer; throws on `errors` or any other shape. */
export function parseSearchPage(body: unknown): SearchPage {
  const value = body as { data?: { rateLimit?: { remaining?: unknown; resetAt?: unknown }; search?: unknown }; errors?: unknown } | null;
  if (value !== null && typeof value === "object" && Array.isArray(value.errors) && value.errors.length > 0) {
    const first = value.errors[0] as { message?: unknown; type?: unknown } | null;
    throw new RunFailure(`GitHub GraphQL answered errors: ${String(first?.type ?? first?.message ?? "unknown")}`.slice(0, 200));
  }
  const search = value?.data?.search as { issueCount?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown } | null | undefined;
  if (search === null || search === undefined || typeof search !== "object" || typeof search.issueCount !== "number" ||
      typeof search.pageInfo?.hasNextPage !== "boolean" || !Array.isArray(search.nodes)) {
    throw new RunFailure("GitHub GraphQL answered without a search result");
  }
  const nodes = search.nodes.map((item: unknown): SearchNode => {
    const node = item as Partial<SearchNode> | null;
    const author = node?.author as { __typename?: unknown; login?: unknown } | null | undefined;
    if (node === null || typeof node !== "object" || typeof node.number !== "number" || typeof node.title !== "string" ||
        typeof node.createdAt !== "string" || Number.isNaN(Date.parse(node.createdAt)) || typeof node.url !== "string" ||
        (author !== null && (typeof author !== "object" || typeof author.__typename !== "string" || typeof author.login !== "string"))) {
      throw new RunFailure("GitHub GraphQL answered a pull request without number, title, createdAt, url or author");
    }
    return { number: node.number, title: node.title, createdAt: node.createdAt, url: node.url, author: author === null ? null : { __typename: author.__typename as string, login: author.login as string } };
  });
  const remaining = value?.data?.rateLimit?.remaining;
  const resetAt = value?.data?.rateLimit?.resetAt;
  const endCursor = search.pageInfo.endCursor;
  return {
    issueCount: search.issueCount, hasNextPage: search.pageInfo.hasNextPage, endCursor: typeof endCursor === "string" ? endCursor : null, nodes,
    remaining: typeof remaining === "number" ? remaining : null, resetAt: typeof resetAt === "string" ? resetAt : null,
  };
}

/** W114: per answered key the assignee's key and display name, or null; nothing else of the user object. */
export function parseJiraAssignees(body: unknown): ReadonlyMap<string, { readonly key: string; readonly display: string } | null> {
  const value = body as { issues?: unknown } | null;
  if (value === null || typeof value !== "object" || !Array.isArray(value.issues)) throw new RunFailure("Jira answered without an issues list");
  const result = new Map<string, { readonly key: string; readonly display: string } | null>();
  for (const item of value.issues) {
    const issue = item as { key?: unknown; fields?: { assignee?: unknown } } | null;
    if (issue === null || typeof issue !== "object" || typeof issue.key !== "string" || issue.fields === null || typeof issue.fields !== "object") {
      throw new RunFailure("Jira answered an issue without key or fields");
    }
    const assignee = issue.fields.assignee as { key?: unknown; displayName?: unknown } | null | undefined;
    if (assignee === null || assignee === undefined) {
      result.set(issue.key, null);
      continue;
    }
    if (typeof assignee.key !== "string" || typeof assignee.displayName !== "string") throw new RunFailure("Jira answered an assignee without key or displayName");
    result.set(issue.key, { key: assignee.key, display: assignee.displayName });
  }
  return result;
}

/**
 * W113, W114: the month object from the month's search nodes and the keys' assignees. Pull requests
 * created outside the month or without a key are left out; a key Jira did not answer gets no thread.
 */
export function backfillMonth(
  profile: IdentityBackfillProfile,
  month: string,
  nodes: readonly SearchNode[],
  assignees: ReadonlyMap<string, { readonly key: string; readonly display: string } | null>,
): ActivityMonthV1 {
  const threads: Record<string, ActivityThreadV1> = {};
  for (const node of nodes) {
    if (activityMonth(node.createdAt) !== month || titleKeys(profile, node.title).length === 0) continue;
    const author = node.author === null || node.author.__typename === "Bot" ? null : activityPersonId("github", node.author.login) ?? null;
    threads[`${profile.threadPrefix}-PR-${node.number}`] = {
      source: "github", kind: "pull-request", title: node.title, url: node.url, author, labels: [], kips: [...extractKeys(node.title).kips].sort(),
    };
  }
  for (const [key, assignee] of assignees) {
    threads[key] = {
      source: "jira", kind: "issue", title: key, url: `${JIRA_BROWSE_URL}${key}`, author: null, labels: [], kips: [], reporter: null,
      assignee: assignee === null ? null : { key: assignee.key, display: assignee.display },
    };
  }
  return { schema: PEOPLE_ACTIVITY_SCHEMA, projectId: profile.projectId, month, people: {}, threads, rows: [] };
}

/** The distinct keys of the month's kept pull requests, in natural order. */
export function monthKeys(profile: IdentityBackfillProfile, month: string, nodes: readonly SearchNode[]): readonly string[] {
  const keys = new Set<string>();
  for (const node of nodes) if (activityMonth(node.createdAt) === month) for (const key of titleKeys(profile, node.title)) keys.add(key);
  return [...keys].sort((a, b) => Number(a.slice(profile.issueKey.length)) - Number(b.slice(profile.issueKey.length)) || (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// The run (W115, W120–W122, W126, W128, W130)

export interface IdentityBackfillBucket {
  /** The object's text, or undefined when absent. One Class B request. */
  get(key: string): Promise<string | undefined>;
  /** A plain put. One Class A request. */
  put(key: string, body: string): Promise<void>;
}

export interface IdentityBackfillDeps {
  /** The value of `IDENTITY_BACKFILL`; only `prs@1` runs. */
  readonly flag: string;
  readonly profile: IdentityBackfillProfile;
  readonly bucket: IdentityBackfillBucket;
  /** The publisher's GitHub token (`GITHUB_SOURCE_TOKEN`, the one Spec 022 uses). */
  readonly githubToken: string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly delay: (ms: number) => Promise<void>;
  /** The request's abort signal; `AbortSignal.timeout` when absent. */
  readonly timeout?: (ms: number) => AbortSignal;
  /** Epoch ms the run must finish its requests by; a request that could end after it is not sent. */
  readonly deadline?: number;
  /** `POST /identity-backfill/run`: refused within 60 minutes of the last run (W126). */
  readonly manual?: boolean;
  /** Called with a real run's record before it is written (Spec 028 `runId` and trends); a throw keeps the record. */
  readonly finish?: (record: IdentityBackfillRecordV1) => Promise<IdentityBackfillRecordV1>;
  /** Where an error line goes when the record cannot be written; `console.error` when absent. */
  readonly log?: (message: string) => void;
}

export type IdentityBackfillSkip = "too-soon" | "retry-after" | "complete" | "unreadable";

export interface IdentityBackfillResult {
  /** The record as written, or as stored when the run wrote nothing; null when there is none. */
  readonly record: IdentityBackfillRecordV1 | null;
  /** Why the run sent nothing and wrote nothing. */
  readonly skipped?: IdentityBackfillSkip;
  readonly error?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** `Retry-After` as seconds or an HTTP date, as an ISO time; undefined when absent or unreadable. */
function retryAfterOf(value: string | null, nowMs: number): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return iso(nowMs + Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? iso(nowMs) : iso(date);
}

/** `x-ratelimit-reset` (epoch seconds) as an ISO time. */
function resetOf(value: string | null): string | undefined {
  return value !== null && /^\d+$/u.test(value.trim()) ? iso(Number(value.trim()) * 1000) : undefined;
}

function parseStoredRecord(text: string | undefined): IdentityBackfillRecordV1 | undefined {
  if (text === undefined) return undefined;
  return parseIdentityBackfillRecord(JSON.parse(text));
}

/** One run of the job. Never throws; the result says what happened. */
export async function runIdentityBackfill(deps: IdentityBackfillDeps): Promise<IdentityBackfillResult> {
  const start = deps.now();
  const at = iso(start);
  const budget = IDENTITY_BACKFILL_BUDGET;
  const r2 = { classA: 0, classB: 0 };
  const requests = { github: 0, jira: 0 };
  const counts = { prs: 0, keyedPrs: 0, keys: 0, assigned: 0, bytesWritten: 0 };
  const log = deps.log ?? ((message: string) => console.error(message));

  // The record is the cursor: a run that cannot read it writes nothing, so it cannot lose `done`.
  let previous: IdentityBackfillRecordV1 | undefined;
  try {
    r2.classB += 1;
    previous = parseStoredRecord(await deps.bucket.get(IDENTITY_BACKFILL_LAST_RUN_KEY));
  } catch (cause) {
    const error = `the backfill record cannot be read: ${errorText(cause)}`;
    log(`identity-backfill: ${error}`);
    return { record: null, skipped: "unreadable", error };
  }
  const stored = previous ?? null;
  const lastAt = previous?.lastRun === null || previous?.lastRun === undefined ? Number.NaN : Date.parse(previous.lastRun.at);
  if (deps.manual === true && !Number.isNaN(lastAt) && start - lastAt < budget.manualGuardMs) return { record: stored, skipped: "too-soon" };
  const retryAfter = previous?.lastRun?.retryAfter === undefined ? Number.NaN : Date.parse(previous.lastRun.retryAfter);
  if (!Number.isNaN(retryAfter) && start < retryAfter) return { record: stored, skipped: "retry-after" };

  let done = [...(previous?.months.done ?? [])].sort();
  let from = previous?.from ?? null;
  let until = previous?.until ?? null;
  let next: string | null = previous?.months.next ?? null;
  let remaining = previous?.months.remaining ?? 0;
  let month: string | null = null;
  let status: IdentityBackfillStatus = "failed";
  let error: string | undefined;
  let limitedUntil: string | undefined;

  const headers = { "User-Agent": SOURCE_USER_AGENT };
  const signal = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  let sent = 0;
  const call = async (kind: "github" | "jira", url: string, init: RequestInit): Promise<{ readonly body: unknown; readonly response: Response }> => {
    const host = new URL(url).host;
    if (sent > 0) await deps.delay(budget.spacingMs);
    if (deps.deadline !== undefined && deps.now() + budget.timeoutMs > deps.deadline) {
      throw new RunFailure(`stopped before ${host}: the request could outlast the run's wall-clock limit`);
    }
    sent += 1;
    requests[kind] += 1;
    let response: Response;
    try {
      response = await deps.fetch(url, { ...init, signal: signal(budget.timeoutMs) });
    } catch (cause) {
      throw new RunFailure(`${host}: ${errorText(cause)}`);
    }
    const retry = retryAfterOf(response.headers.get("retry-after"), deps.now());
    const reset = resetOf(response.headers.get("x-ratelimit-reset"));
    if (response.status === 429) throw new RunFailure(`${host} answered 429`, "limited", retry ?? reset);
    if (response.status === 403) {
      const text = await response.text().catch(() => "");
      if (retry !== undefined || response.headers.get("x-ratelimit-remaining") === "0" || /rate limit/iu.test(text)) {
        throw new RunFailure(`${host} answered 403 (rate limit)`, "limited", retry ?? reset);
      }
      throw new RunFailure(`${host} answered 403`);
    }
    if (retry !== undefined) throw new RunFailure(`${host} answered ${response.status} with Retry-After`, "limited", retry);
    if (!response.ok) throw new RunFailure(`${host} answered ${response.status}`);
    const remainingHeader = response.headers.get("x-ratelimit-remaining");
    if (kind === "github" && remainingHeader !== null && /^\d+$/u.test(remainingHeader.trim()) && Number(remainingHeader) < budget.minRemaining) {
      throw new RunFailure(`GitHub rate limit remaining ${remainingHeader} is below ${budget.minRemaining}`, "limited", reset);
    }
    try {
      return { body: JSON.parse(await response.text()) as unknown, response };
    } catch {
      throw new RunFailure(`${host} answered a body that is not JSON`);
    }
  };

  try {
    if (deps.flag.trim() !== IDENTITY_BACKFILL_REVISION) {
      throw new RunFailure(`IDENTITY_BACKFILL is ${JSON.stringify(deps.flag)}; only ${IDENTITY_BACKFILL_REVISION} is supported`);
    }
    if (deps.githubToken.trim() === "") throw new RunFailure("no GitHub token (GITHUB_SOURCE_TOKEN) is set");
    r2.classB += 1;
    let stateText: string | undefined;
    try {
      stateText = await deps.bucket.get(peopleActivityStateKey(deps.profile.projectId));
    } catch (cause) {
      throw new RunFailure(`reading the activity log's state failed: ${errorText(cause)}`);
    }
    if (stateText === undefined) throw new RunFailure("the activity log has no state yet (no coverageFrom)");
    let coverageFrom: string;
    try {
      coverageFrom = parseActivityState(JSON.parse(stateText)).coverageFrom;
    } catch (cause) {
      throw new RunFailure(`the activity log's state does not parse: ${errorText(cause)}`);
    }
    const range = backfillRange(start, coverageFrom);
    from = range.from;
    until = range.until;
    const finished = new Set(done);
    const open = range.months.filter((candidate) => !finished.has(candidate));
    next = open[0] ?? null;
    remaining = open.length;
    if (next === null) {
      // Nothing left: recorded once, then every later run sends and writes nothing (W115).
      if (previous?.lastRun?.status === "complete") return { record: stored, skipped: "complete" };
      status = "complete";
    } else {
      month = next;
      // 1. The month's pull requests, page by page.
      const nodes: SearchNode[] = [];
      let after: string | null = null;
      for (;;) {
        if (requests.github >= budget.githubRequests) throw new RunFailure(`${month} needs more than ${budget.githubRequests} search requests`, "over-budget");
        const { body } = await call("github", GITHUB_GRAPHQL_URL, {
          method: "POST",
          headers: { ...headers, Authorization: `Bearer ${deps.githubToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: MONTH_SEARCH_GRAPHQL, variables: { q: monthSearchQuery(deps.profile, month), after } }),
        });
        const page = parseSearchPage(body);
        if (page.remaining !== null && page.remaining < budget.minRemaining) {
          throw new RunFailure(`GitHub rate limit remaining ${page.remaining} is below ${budget.minRemaining}`, "limited", page.resetAt ?? undefined);
        }
        if (Math.ceil(page.issueCount / budget.pageSize) > budget.githubRequests) {
          throw new RunFailure(`${month} has ${page.issueCount} pull requests: more than ${budget.githubRequests} search pages`, "over-budget");
        }
        nodes.push(...page.nodes);
        if (!page.hasNextPage) break;
        after = page.endCursor;
      }
      counts.prs = nodes.filter((node) => activityMonth(node.createdAt) === month).length;
      counts.keyedPrs = nodes.filter((node) => activityMonth(node.createdAt) === month && titleKeys(deps.profile, node.title).length > 0).length;
      // 2. The keys' assignees, 100 keys a request.
      const keys = monthKeys(deps.profile, month, nodes);
      counts.keys = keys.length;
      if (Math.ceil(keys.length / budget.jiraKeysPerRequest) > budget.jiraRequests) {
        throw new RunFailure(`${month} has ${keys.length} keys: more than ${budget.jiraRequests} Jira requests`, "over-budget");
      }
      const assignees = new Map<string, { readonly key: string; readonly display: string } | null>();
      for (let offset = 0; offset < keys.length; offset += budget.jiraKeysPerRequest) {
        const batch = keys.slice(offset, offset + budget.jiraKeysPerRequest);
        const { body } = await call("jira", jiraAssigneesUrl(batch), { headers: { ...headers, Accept: "application/json" } });
        const answered = parseJiraAssignees(body);
        // Only the keys asked for, under the same key: a moved issue answers under its new key (W114).
        for (const key of batch) if (answered.has(key)) assignees.set(key, answered.get(key)!);
      }
      counts.assigned = [...assignees.values()].filter((assignee) => assignee !== null).length;
      // 3. The month, whole, then the record.
      const body = encodeActivityMonth(backfillMonth(deps.profile, month, nodes, assignees));
      r2.classA += 1;
      try {
        await deps.bucket.put(identityBackfillMonthKey(deps.profile.projectId, month), body);
      } catch (cause) {
        throw new RunFailure(`writing ${month} failed: ${errorText(cause)}`);
      }
      counts.bytesWritten = new TextEncoder().encode(body).byteLength;
      done = [...new Set([...done, month])].sort();
      const left = open.slice(1);
      next = left[0] ?? null;
      remaining = left.length;
      status = "ok";
    }
  } catch (cause) {
    status = cause instanceof RunFailure ? cause.status : "failed";
    error = errorText(cause);
    limitedUntil = cause instanceof RunFailure && cause.status === "limited" ? cause.retryAfter : undefined;
  }

  const record: IdentityBackfillRecordV1 = {
    revision: deps.flag.trim(),
    lastRun: {
      ok: status === "ok" || status === "complete", status, at, durationMs: Math.max(0, deps.now() - start), month,
      ...counts, requests: { ...requests },
      ...(limitedUntil === undefined ? {} : { retryAfter: limitedUntil }),
      r2: { classA: r2.classA + 1, classB: r2.classB },
      ...(error === undefined ? {} : { error }),
    },
    months: { done, next, remaining },
    from,
    until,
  };
  const final = deps.finish === undefined ? record : await deps.finish(record).catch(() => record);
  try {
    await deps.bucket.put(IDENTITY_BACKFILL_LAST_RUN_KEY, `${JSON.stringify(final)}\n`);
  } catch (cause) {
    log(`identity-backfill: the run record was not written: ${errorText(cause)}`);
  }
  return { record: final };
}
