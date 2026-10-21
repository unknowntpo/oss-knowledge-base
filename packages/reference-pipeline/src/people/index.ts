/**
 * Spec 019 slice 2a: the contributor profile, read at request time from Spec 022's review store
 * (`internal/github-reviews/v1/<projectId>/<YYYY-MM>.json` and `state.json`). No text body is read
 * or returned: a review row is who, on which pull request, which verdict, when.
 *
 * The page and the API share `profileView`, so a count on the page is the count in the response.
 */
import { communitySourceProfiles, githubProjectProfiles } from "../config";
import { DATAFUSION_DIGEST_PROFILE, KAFKA_DIGEST_PROFILE } from "../digest/profiles";
import {
  DELETED_ACCOUNT,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsMonthKey,
  githubReviewsStateKey,
  parseReviewMonthObject,
  type ReviewMonthExtras,
  type ReviewRow,
  type ReviewState,
} from "../github-reviews";
import {
  activityPersonId,
  indexActivityMonth,
  parseActivityMonth,
  parseActivityState,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  type ActivityKind,
  type ActivityMonthIndex,
  type ActivitySource,
  type ActivityThreadV1,
} from "./activity";
import { areaDistribution, areaTaxonomy, itemAreas, type PullAreasV1 } from "./areas";

export * from "./activity";
export * from "./areas";

export const PEOPLE_PROFILE_SCHEMA = "osskb.people-profile.v1";
/** Decision 4 / W26: the newest 12 calendar months, the current one included. */
export const PEOPLE_HORIZON_MONTHS = 12;
/** W29: how long an isolate keeps a parsed month or the review cursor before reading it again. */
export const PEOPLE_INDEX_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** `github-reviews` is Spec 022's store; the others are the activity log of slice 2b. */
export type PeopleSource = "github-reviews" | "github" | "jira" | "mail";
/** Sources the reader knows a store for. A source is "recorded" only when its store exists (W27). */
export const RECORDED_SOURCES: ReadonlySet<PeopleSource> = new Set(["github-reviews", "github", "jira", "mail"]);

export interface PeopleProject {
  readonly projectKey: string;
  readonly projectId: string;
  readonly label: string;
  /** `owner/repo`, for links to reviews and pull requests. */
  readonly repository: string;
  readonly sources: readonly PeopleSource[];
  /** Logins that are not people (W12): the project's machine users and GitHub Apps whose GraphQL login has no `[bot]`. */
  readonly bots: readonly string[];
  /** Behavior 6 / W4: labels that describe the process, not an area, left out of Areas. */
  readonly processLabels: readonly string[];
  /** Labels matching this are process labels too (DataFusion's release labels `v55.0.0`). */
  readonly processLabelPattern?: RegExp;
  /** Labels naming a KIP, counted as that KIP (`areas.ts`). */
  readonly kipLabelPattern?: RegExp;
}

/** The order the page lists sources in. */
const SOURCE_ORDER: readonly PeopleSource[] = ["github-reviews", "github", "jira", "mail"];
const GITHUB_APP_LOGINS = ["dependabot", "github-actions", "copilot-pull-request-reviewer", "Copilot", "renovate"];
const MACHINE_USERS: Readonly<Record<string, readonly string[]>> = {
  [KAFKA_DIGEST_PROFILE.projectId]: KAFKA_DIGEST_PROFILE.machineUsers,
  [DATAFUSION_DIGEST_PROFILE.projectId]: DATAFUSION_DIGEST_PROFILE.machineUsers,
};

export const PEOPLE_PROJECTS: readonly PeopleProject[] = githubProjectProfiles.map((profile) => ({
  projectKey: profile.projectKey,
  projectId: profile.projectId,
  label: profile.label,
  repository: `${profile.owner}/${profile.repo}`,
  sources: SOURCE_ORDER.filter((source) => source === "github-reviews" || source === "github" ||
    communitySourceProfiles.some((community) => community.projectId === profile.projectId && community.key === source)),
  bots: [...(MACHINE_USERS[profile.projectId] ?? []), ...GITHUB_APP_LOGINS],
  // Behavior 6: one taxonomy for review metadata and the activity log (`areas.ts`).
  ...areaTaxonomy(profile.projectId),
}));

export function peopleProject(projectKey: string | null | undefined): PeopleProject | undefined {
  return PEOPLE_PROJECTS.find((project) => project.projectKey === projectKey);
}

/**
 * P-e: identities removed on request. Each entry is `suppressionDigest(projectId, id)`, so the
 * list in this public repository does not spell the name. Empty: nobody has asked.
 */
export const PEOPLE_SUPPRESSED: Readonly<Record<string, readonly string[]>> = {};

export async function suppressionDigest(projectId: string, personId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`osskb-people-suppression-v1\u0000${projectId}\u0000${personId.toLowerCase()}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u;

export type ParsedPersonId =
  | { readonly kind: "github"; readonly login: string }
  /**
   * Slice 2b: a Jira or dev@ identity, keyed by its normalized display name (`activityPersonId`).
   * `id` is the canonical form (`jira:chia-ping tsai`); the source is part of it (strict identity).
   */
  | { readonly kind: "name"; readonly source: "jira" | "mail"; readonly id: string };

/** `github:<login>`, `jira:<name>`, `mail:<name>`. */
export function parsePersonId(value: string | null | undefined): ParsedPersonId | undefined {
  if (typeof value !== "string") return undefined;
  const colon = value.indexOf(":");
  const source = value.slice(0, colon);
  const key = value.slice(colon + 1);
  if (colon <= 0 || key.length === 0 || key.length > 200) return undefined;
  if (source === "github") return GITHUB_LOGIN.test(key) ? { kind: "github", login: key } : undefined;
  if (source === "jira" || source === "mail") {
    const id = activityPersonId(source, key);
    return id === undefined ? undefined : { kind: "name", source, id };
  }
  return undefined;
}

export function personIdOf(login: string): string {
  return `github:${login}`;
}

/** W12: a login is not a person when the project lists it, it ends in `[bot]`, or GitHub typed it `Bot` in a stored row. */
export function isBotLogin(login: string, project: PeopleProject, learned: ReadonlySet<string> = new Set()): boolean {
  const key = login.toLowerCase();
  return key.endsWith("[bot]") || learned.has(key) || project.bots.some((bot) => bot.toLowerCase() === key);
}

/** W26: the 12-month view's months, oldest first, without months before the store's `coverageFrom`. */
export function profileMonths(nowMs: number, coverageFrom: string): readonly string[] {
  const now = new Date(nowMs);
  const first = new Date(coverageFrom).toISOString().slice(0, 7);
  const months: string[] = [];
  for (let back = PEOPLE_HORIZON_MONTHS - 1; back >= 0; back -= 1) {
    months.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7));
  }
  return months.filter((month) => month >= first);
}

/** One month's rows by identity (lower-cased login). Slice 7's month summary stores these counters (decision 10). */
export interface ReviewMonthIndex {
  readonly people: ReadonlyMap<string, { readonly given: readonly ReviewRow[]; readonly received: readonly ReviewRow[] }>;
  /** Logins GitHub typed `Bot` in this month's rows. */
  readonly bots: ReadonlySet<string>;
  /** Spec 022 `metadata@2`: the month's pull-request metadata (raw label names, title KIP ids), by number. */
  readonly pulls: ReadonlyMap<number, { readonly labels: readonly string[]; readonly kips?: readonly string[] }>;
  /** Spec 022 `metadata@2`: public display names by lower-cased login. */
  readonly names: ReadonlyMap<string, string>;
}

/**
 * Spec 019 Behavior 1 and W8: a bot's review counts for nobody; a review by the pull request's
 * author (an answer in a review thread) is not a review given, nor received.
 */
export function indexReviewMonth(rows: readonly ReviewRow[], extras: ReviewMonthExtras = {}): ReviewMonthIndex {
  const people = new Map<string, { given: ReviewRow[]; received: ReviewRow[] }>();
  const bots = new Set<string>();
  const person = (login: string) => {
    const key = login.toLowerCase();
    let entry = people.get(key);
    if (entry === undefined) people.set(key, entry = { given: [], received: [] });
    return entry;
  };
  for (const row of rows) {
    if (row.isBot) {
      bots.add(row.reviewer.toLowerCase());
      continue;
    }
    if (row.reviewer.toLowerCase() === row.prAuthor.toLowerCase()) continue;
    person(row.reviewer).given.push(row);
    person(row.prAuthor).received.push(row);
  }
  return {
    people,
    bots,
    pulls: new Map(Object.entries(extras.pulls ?? {}).map(([pr, meta]) => [Number(pr), meta])),
    names: new Map(Object.entries(extras.people ?? {}).map(([login, name]) => [login.toLowerCase(), name])),
  };
}

export interface ReviewGivenV1 {
  readonly reviewId: number;
  readonly pr: number;
  /** Null when the author asked to be removed (P-e). */
  readonly prAuthor: string | null;
  readonly state: ReviewState;
  readonly stateBefore?: Exclude<ReviewState, "DISMISSED">;
  readonly submittedAt: string;
  readonly inlineComments: number;
}

export interface ReviewReceivedV1 {
  readonly reviewId: number;
  readonly pr: number;
  /** Null when the reviewer asked to be removed (P-e). */
  readonly reviewer: string | null;
  readonly state: ReviewState;
  readonly stateBefore?: Exclude<ReviewState, "DISMISSED">;
  readonly submittedAt: string;
  readonly inlineComments: number;
}

export type SourceCoverageV1 =
  | {
      readonly source: PeopleSource;
      readonly status: "recorded";
      readonly from: string;
      readonly until: string;
      /** Where the store's counts start: Spec 022's `coverageFrom`; the activity log's first append minus 35 days. */
      readonly storedFrom: string;
      /** Activity log sources: the first append's time (W27). */
      readonly firstAppendAt?: string;
    }
  | { readonly source: PeopleSource; readonly status: "not-recorded" };

/** One of the identity's activity-log records (slice 2b): metadata only. */
export interface ActivityRecordV1 {
  readonly id: string;
  readonly source: ActivitySource;
  readonly kind: ActivityKind;
  readonly at: string;
  readonly thread: string;
  readonly merged?: string;
}

export interface PersonActivityV1 {
  /** The identity's rows in the 12-month view, newest first; a record is listed once (its newest month). */
  readonly records: readonly ActivityRecordV1[];
  /** The threads those rows are in. `author` is null for a bot, an unknown, or a suppressed author. */
  readonly threads: Readonly<Record<string, ActivityThreadV1>>;
  /** Display names of the thread authors named in `threads`. */
  readonly people: Readonly<Record<string, string>>;
}

export interface PersonProfileV1 {
  readonly schema: typeof PEOPLE_PROFILE_SCHEMA;
  readonly project: { readonly key: string; readonly id: string; readonly label: string; readonly repository: string };
  /** `url` is the upstream profile; Jira and dev@ identities have none (only a display name is kept). */
  /**
   * `url` is the upstream profile; Jira and dev@ identities have none (only a display name is kept).
   * `name` (W51): the GitHub account's public profile name from the review store, display only; it
   * links nothing across sources.
   */
  readonly identity: { readonly id: string; readonly source: "github" | "jira" | "mail"; readonly display: string; readonly url?: string; readonly name?: string };
  readonly generatedAt: string;
  /** The 12-month view: from the earliest recorded source's start (never before the first month) to the latest source's end. */
  readonly period: { readonly from: string; readonly until: string; readonly months: readonly string[] };
  readonly coverage: readonly SourceCoverageV1[];
  /** W10: months that exist in the view but could not be read; their rows are missing from every count. */
  readonly unavailableMonths: readonly string[];
  readonly reviewsGiven: readonly ReviewGivenV1[];
  readonly reviewsReceived: readonly ReviewReceivedV1[];
  /** Counterparts in these rows that GitHub typed `Bot` (W12): counted, never listed under Works with. */
  readonly bots: readonly string[];
  /** Slice 2b: present when the activity log is recorded for the community. */
  readonly activity?: PersonActivityV1;
  /**
   * W46: the areas of the pull requests in `reviewsGiven` and `reviewsReceived` that have stored
   * metadata (Spec 022 `metadata@2`), by number: area labels after the community's taxonomy, and KIP
   * ids. Absent when no month of the view has metadata; a pull request missing here is not covered (W49).
   */
  readonly pullAreas?: Readonly<Record<string, PullAreasV1>>;
  /** The 12-month view's totals, as `profileView(…, "12m")` computes them for the page. */
  readonly totals: ProfileTotals;
}

export interface ProfileTotals {
  readonly reviewsGiven: {
    readonly reviews: number;
    readonly pullRequests: number;
    readonly byState: Readonly<Record<ReviewState, number>>;
    readonly inlineComments: number;
  };
  readonly reviewsReceived: { readonly reviews: number; readonly pullRequests: number; readonly reviewers: number };
  /** Slice 2b: present when the response has `activity`. */
  readonly activity?: ActivityTotals;
}

/** Counts of the activity log's records (slice 2b). Threads are distinct; a record counts once. */
export interface ActivityTotals {
  /** Pull requests opened in the period (by creation time), and how many of them are merged. */
  readonly pullRequests: number;
  readonly mergedPullRequests: number;
  readonly issues: number;
  /** GitHub conversation comments, on how many threads, and how many of them on the person's own threads. */
  readonly comments: number;
  readonly commentedThreads: number;
  readonly commentsOnOwn: number;
  /** Jira issues reported (counted in the month of their last update) and comments. */
  readonly jiraIssues: number;
  readonly jiraComments: number;
  readonly jiraThreads: number;
  readonly messages: number;
  readonly mailThreads: number;
  /** dev@ threads whose title starts with `[DISCUSS]` or `[VOTE]`. */
  readonly discussThreads: number;
  readonly voteThreads: number;
}

export interface PeopleErrorV1 {
  readonly error: string;
  /** On a 404 for a known community: what the profile reads, so the page can say it (W11, W27). */
  readonly coverage?: readonly SourceCoverageV1[];
  readonly unavailableMonths?: readonly string[];
}

export type PeopleRead =
  | { readonly status: 200; readonly body: PersonProfileV1 }
  | { readonly status: 400 | 404 | 503; readonly body: PeopleErrorV1 };

/** The part of an R2 bucket the reader uses; tests count calls through it (W29). */
export interface PeopleBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export interface StoreState { readonly updatedAt: string; readonly coverageFrom: string }

type CacheEntry = { readonly at: number; readonly value: Promise<unknown> };
const isolateCache = new WeakMap<object, Map<string, CacheEntry>>();
const CACHE_ENTRIES = 64;

/** W29: one read per key per bucket per `PEOPLE_INDEX_TTL_MS`; a failed read is not kept. */
function cached<T>(bucket: PeopleBucket, key: string, nowMs: number, load: () => Promise<T>): Promise<T> {
  let entries = isolateCache.get(bucket);
  if (entries === undefined) isolateCache.set(bucket, entries = new Map());
  const hit = entries.get(key);
  if (hit !== undefined && nowMs - hit.at < PEOPLE_INDEX_TTL_MS && nowMs >= hit.at) return hit.value as Promise<T>;
  const value = load();
  entries.delete(key);
  entries.set(key, { at: nowMs, value });
  value.catch(() => {
    if (entries.get(key)?.value === value) entries.delete(key);
  });
  for (const oldest of entries.keys()) {
    if (entries.size <= CACHE_ENTRIES) break;
    entries.delete(oldest);
  }
  return value;
}

/** Shared with person search (slice 3), so both read through one per-isolate cache (W43). */
export async function readState(bucket: PeopleBucket, projectId: string, nowMs: number): Promise<StoreState | undefined> {
  return cached(bucket, githubReviewsStateKey(projectId), nowMs, async () => {
    const object = await bucket.get(githubReviewsStateKey(projectId));
    if (object === null) return undefined;
    const state = JSON.parse(await object.text()) as Partial<StoreState> & { readonly schema?: unknown };
    if (state.schema !== GITHUB_REVIEWS_STATE_SCHEMA || typeof state.updatedAt !== "string" || typeof state.coverageFrom !== "string" ||
        Number.isNaN(Date.parse(state.updatedAt)) || Number.isNaN(Date.parse(state.coverageFrom))) {
      throw new Error("The review store's state is malformed");
    }
    return { updatedAt: state.updatedAt, coverageFrom: state.coverageFrom };
  });
}

/** A month without an object has no reviews (Spec 022 writes only months with rows). Shared with person search (W43). */
export function readMonth(bucket: PeopleBucket, projectId: string, month: string, nowMs: number): Promise<ReviewMonthIndex> {
  const key = githubReviewsMonthKey(projectId, month);
  return cached(bucket, key, nowMs, async () => {
    const object = await bucket.get(key);
    if (object === null) return { people: new Map(), bots: new Set(), pulls: new Map(), names: new Map() };
    const parsed = parseReviewMonthObject(JSON.parse(await object.text()), projectId, month);
    return indexReviewMonth(parsed.rows, parsed);
  });
}

interface ActivityStoreState { readonly coverageFrom: string; readonly updatedAt: string; readonly firstAppendAt: string }

/** Slice 2b: the activity log's `state.json`; undefined before the first append (flag off, or Prod). */
function readActivityState(bucket: PeopleBucket, projectId: string, nowMs: number): Promise<ActivityStoreState | undefined> {
  const key = peopleActivityStateKey(projectId);
  return cached(bucket, key, nowMs, async () => {
    const object = await bucket.get(key);
    if (object === null) return undefined;
    const state = parseActivityState(JSON.parse(await object.text()));
    return { coverageFrom: state.coverageFrom, updatedAt: state.updatedAt, firstAppendAt: state.firstAppendAt };
  });
}

interface IndexedActivityMonth {
  readonly index: ActivityMonthIndex;
  readonly threads: Readonly<Record<string, ActivityThreadV1>>;
  readonly people: Readonly<Record<string, string>>;
}

/** An activity month parsed once per isolate into the per-identity index the summary stores (decision 10). */
function readActivityMonth(bucket: PeopleBucket, projectId: string, month: string, nowMs: number): Promise<IndexedActivityMonth> {
  const key = peopleActivityMonthKey(projectId, month);
  return cached(bucket, key, nowMs, async () => {
    const object = await bucket.get(key);
    if (object === null) return { index: { people: new Map() }, threads: {}, people: {} };
    const parsed = parseActivityMonth(JSON.parse(await object.text()), projectId, month);
    return { index: indexActivityMonth(parsed), threads: parsed.threads, people: parsed.people };
  });
}

/** The store's coverage clipped to the 12-month view, or undefined when the view holds none of it. */
function recordedCoverage(source: PeopleSource, storedFrom: string, until: string, nowMs: number, firstAppendAt?: string) {
  const months = profileMonths(nowMs, storedFrom);
  if (months.length === 0) return undefined;
  return {
    months,
    coverage: {
      source,
      status: "recorded" as const,
      from: new Date(Math.max(Date.parse(storedFrom), Date.parse(`${months[0]}-01T00:00:00.000Z`))).toISOString(),
      until,
      storedFrom,
      ...(firstAppendAt === undefined ? {} : { firstAppendAt }),
    },
  };
}

/** `GET /api/people/:project/:id` (Spec 019 slices 2a and 2b). */
export async function readPersonProfile(input: {
  readonly bucket: PeopleBucket;
  readonly projectKey: string | null | undefined;
  readonly personId: string | null | undefined;
  readonly nowMs: number;
  /** Defaults to `PEOPLE_SUPPRESSED`; tests pass their own list (W12). */
  readonly suppressed?: Readonly<Record<string, readonly string[]>>;
}): Promise<PeopleRead> {
  const project = peopleProject(input.projectKey);
  if (project === undefined) return { status: 400, body: { error: "Unknown project" } };
  const parsed = parsePersonId(input.personId);
  if (parsed === undefined) return { status: 400, body: { error: "Invalid person id" } };
  const suppressed = new Set((input.suppressed ?? PEOPLE_SUPPRESSED)[project.projectId] ?? []);
  const isSuppressedId = async (personId: string) => suppressed.size > 0 && suppressed.has(await suppressionDigest(project.projectId, personId));
  const isSuppressed = (login: string) => isSuppressedId(personIdOf(login));

  let state: StoreState | undefined;
  let activityState: ActivityStoreState | undefined;
  try {
    state = await readState(input.bucket, project.projectId, input.nowMs);
    // Slice 2b: one more read per project and isolate; absent until the log's first append.
    activityState = project.sources.some((source) => source !== "github-reviews")
      ? await readActivityState(input.bucket, project.projectId, input.nowMs)
      : undefined;
  } catch (error) {
    return { status: 503, body: { error: error instanceof Error ? error.message : "Unable to read the review store" } };
  }
  const reviewView = state === undefined ? undefined : recordedCoverage("github-reviews", state.coverageFrom, state.updatedAt, input.nowMs);
  const activityView = activityState === undefined
    ? undefined
    : recordedCoverage("github", activityState.coverageFrom, activityState.updatedAt, input.nowMs, activityState.firstAppendAt);
  const months = reviewView?.months ?? [];
  const activityMonths = activityView?.months ?? [];
  const reviews = reviewView?.coverage;
  const coverage: readonly SourceCoverageV1[] = project.sources.map((source) => {
    if (source === "github-reviews") return reviews ?? { source, status: "not-recorded" as const };
    return activityView === undefined ? { source, status: "not-recorded" as const } : { ...activityView.coverage, source };
  });
  const notFound = (unavailableMonths: readonly string[] = []): PeopleRead => ({
    status: 404,
    body: { error: `No recorded activity for this identity in ${project.label}`, coverage, ...(unavailableMonths.length === 0 ? {} : { unavailableMonths }) },
  });
  const personKey = parsed.kind === "github" ? `github:${parsed.login.toLowerCase()}` : parsed.id;
  if (parsed.kind === "github" && (isBotLogin(parsed.login, project) || parsed.login.toLowerCase() === DELETED_ACCOUNT)) {
    return { status: 404, body: { error: "Bots and deleted accounts have no profile", coverage } };
  }
  if (await isSuppressedId(parsed.kind === "github" ? personIdOf(parsed.login) : parsed.id)) return notFound();
  if (parsed.kind === "name" && !project.sources.includes(parsed.source)) return notFound();
  if (reviews === undefined && activityView === undefined) return notFound();

  const unavailableMonths: string[] = [];
  const indexes = parsed.kind !== "github" ? [] : await Promise.all(months.map((month) => readMonth(input.bucket, project.projectId, month, input.nowMs).catch(() => {
    unavailableMonths.push(month);
    return undefined;
  })));
  const activityIndexes = await Promise.all(activityMonths.map((month) => readActivityMonth(input.bucket, project.projectId, month, input.nowMs).catch(() => {
    if (!unavailableMonths.includes(month)) unavailableMonths.push(month);
    return undefined;
  })));
  unavailableMonths.sort();
  const learnedBots = new Set(indexes.flatMap((index) => (index === undefined ? [] : [...index.bots])));
  if (parsed.kind === "github" && isBotLogin(parsed.login, project, learnedBots)) {
    return { status: 404, body: { error: "Bots and deleted accounts have no profile", coverage } };
  }

  const from = reviews === undefined ? Number.POSITIVE_INFINITY : Date.parse(reviews.from);
  const given: ReviewRow[] = [];
  const received: ReviewRow[] = [];
  if (parsed.kind === "github") {
    const key = parsed.login.toLowerCase();
    for (const index of indexes) {
      const entry = index?.people.get(key);
      if (entry === undefined) continue;
      given.push(...entry.given.filter((row) => Date.parse(row.submittedAt) >= from));
      received.push(...entry.received.filter((row) => Date.parse(row.submittedAt) >= from));
    }
  }

  // Slice 2b: the identity's activity rows, each record once (a Jira issue is in every month it was updated; the newest wins).
  const activityFrom = activityView === undefined ? "" : activityView.coverage.from;
  const records = new Map<string, ActivityRecordV1>();
  const threads: Record<string, ActivityThreadV1> = {};
  const names: Record<string, string> = {};
  let display: string | undefined;
  activityMonths.forEach((_, position) => {
    const month = activityIndexes[position];
    const entry = month?.index.people.get(personKey);
    if (month === undefined || entry === undefined) return;
    display = month.people[personKey] ?? display;
    for (const row of entry.rows) {
      if (row.at < activityFrom) continue;
      const previous = records.get(row.id);
      if (previous !== undefined && previous.at >= row.at) continue;
      records.set(row.id, { id: row.id, source: row.source, kind: row.kind, at: row.at, thread: row.thread, ...(row.merged === undefined ? {} : { merged: row.merged }) });
      threads[row.thread] = month.threads[row.thread]!;
      const author = month.threads[row.thread]!.author;
      if (author !== null && month.people[author] !== undefined) names[author] = month.people[author]!;
    }
  });
  if (given.length === 0 && received.length === 0 && records.size === 0) return notFound(unavailableMonths);

  // W46, W51: pull-request metadata and the public name; a newer month's value replaces an older one.
  const reviewedPrs = new Set([...given, ...received].map((row) => row.pr));
  const pullMeta = new Map<number, { readonly labels: readonly string[]; readonly kips?: readonly string[] }>();
  let withMetadata = false;
  let publicName: string | undefined;
  if (parsed.kind === "github") {
    const key = parsed.login.toLowerCase();
    for (const index of indexes) {
      if (index === undefined) continue;
      if (index.pulls.size > 0) withMetadata = true;
      for (const pr of reviewedPrs) {
        const meta = index.pulls.get(pr);
        if (meta !== undefined) pullMeta.set(pr, meta);
      }
      publicName = index.names.get(key) ?? publicName;
    }
  }
  const pullAreas: Record<string, PullAreasV1> = {};
  for (const [pr, meta] of [...pullMeta].sort((a, b) => a[0] - b[0])) {
    const areas = itemAreas(meta.labels, meta.kips ?? [], project);
    pullAreas[String(pr)] = areas.kips.length === 0 ? { labels: areas.labels } : areas;
  }
  if (parsed.kind === "github") display = given[0]?.reviewer ?? received[0]?.prAuthor ?? display ?? parsed.login;

  // P-e: a counterpart who asked to be removed stays counted, but unnamed.
  const hidden = new Set<string>();
  const hiddenIds = new Set<string>();
  if (suppressed.size > 0) {
    for (const login of new Set([...given.map((row) => row.prAuthor), ...received.map((row) => row.reviewer)])) {
      if (await isSuppressed(login)) hidden.add(login);
    }
    for (const author of Object.keys(names)) if (await isSuppressedId(author)) hiddenIds.add(author);
  }
  // Amendment (7), W68: a Jira thread's reporter and assignee accounts are internal; no response carries them.
  const shownThreads = Object.fromEntries(Object.entries(threads).map(([key, { reporter: _reporter, assignee: _assignee, ...thread }]) => [key,
    thread.author !== null && (hiddenIds.has(thread.author) || (thread.author.startsWith("github:") && isBotLogin(thread.author.slice(7), project, learnedBots)))
      ? { ...thread, author: null }
      : thread]));
  const newestFirst = (a: ReviewRow, b: ReviewRow) => (a.submittedAt === b.submittedAt ? b.reviewId - a.reviewId : a.submittedAt < b.submittedAt ? 1 : -1);
  const verdict = (row: ReviewRow) => (row.stateBefore === undefined ? {} : { stateBefore: row.stateBefore });
  // A Jira or dev@ identity has no reviews: its period is the activity log's alone.
  const periods = [parsed.kind === "github" ? reviews : undefined, activityView?.coverage].filter((item) => item !== undefined);
  const activity: PersonActivityV1 | undefined = activityView === undefined ? undefined : {
    records: [...records.values()].sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1)),
    threads: shownThreads,
    people: Object.fromEntries(Object.entries(names).filter(([id]) => !hiddenIds.has(id) && Object.values(shownThreads).some((thread) => thread.author === id))),
  };
  const body: Omit<PersonProfileV1, "totals"> = {
    schema: PEOPLE_PROFILE_SCHEMA,
    project: { key: project.projectKey, id: project.projectId, label: project.label, repository: project.repository },
    identity: parsed.kind === "github"
      ? { id: personIdOf(display!), source: "github", display: display!, url: `https://github.com/${display}`, ...(publicName === undefined ? {} : { name: publicName }) }
      : { id: parsed.id, source: parsed.source, display: display ?? parsed.id.slice(parsed.source.length + 1) },
    generatedAt: new Date(input.nowMs).toISOString(),
    period: {
      from: periods.map((item) => item.from).sort()[0]!,
      until: periods.map((item) => item.until).sort().at(-1)!,
      months: [...new Set([...(parsed.kind === "github" ? months : []), ...activityMonths])].sort(),
    },
    coverage,
    unavailableMonths,
    reviewsGiven: given.sort(newestFirst).map((row) => ({
      reviewId: row.reviewId, pr: row.pr, prAuthor: hidden.has(row.prAuthor) ? null : row.prAuthor, state: row.state, ...verdict(row),
      submittedAt: row.submittedAt, inlineComments: row.inlineComments,
    })),
    reviewsReceived: received.sort(newestFirst).map((row) => ({
      reviewId: row.reviewId, pr: row.pr, reviewer: hidden.has(row.reviewer) ? null : row.reviewer, state: row.state, ...verdict(row),
      submittedAt: row.submittedAt, inlineComments: row.inlineComments,
    })),
    bots: [...new Set([...given.map((row) => row.prAuthor), ...received.map((row) => row.reviewer)])]
      .filter((login) => !hidden.has(login) && learnedBots.has(login.toLowerCase())).sort(),
    ...(activity === undefined ? {} : { activity }),
    ...(withMetadata ? { pullAreas } : {}),
  };
  const totals = profileTotals(body.reviewsGiven, body.reviewsReceived);
  return {
    status: 200,
    body: { ...body, totals: activity === undefined ? totals : { ...totals, activity: activityTotals(activity.records, activity.threads, personKey) } },
  };
}

/**
 * Slice 2b: which sources each community records now, for `GET /api/people` (author links in
 * Detail, W28). Reads each project's two `state.json` objects at most once per isolate per TTL.
 */
export async function recordedSources(bucket: PeopleBucket, nowMs: number): Promise<Readonly<Record<string, readonly PeopleSource[]>>> {
  const entries = await Promise.all(PEOPLE_PROJECTS.map(async (project) => {
    const [reviews, activity] = await Promise.all([
      readState(bucket, project.projectId, nowMs).catch(() => undefined),
      project.sources.some((source) => source !== "github-reviews")
        ? readActivityState(bucket, project.projectId, nowMs).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    return [project.projectKey, project.sources.filter((source) => (source === "github-reviews" ? reviews !== undefined : activity !== undefined))] as const;
  }));
  return Object.fromEntries(entries);
}

/** Slice 2b: the activity counts of a set of records; the response's `totals.activity` and the page's counts. */
export function activityTotals(records: readonly ActivityRecordV1[], threads: Readonly<Record<string, ActivityThreadV1>>, personKey: string): ActivityTotals {
  const distinct = (filter: (record: ActivityRecordV1) => boolean) => new Set(records.filter(filter).map((record) => record.thread)).size;
  const title = (record: ActivityRecordV1) => threads[record.thread]?.title ?? "";
  const github = (record: ActivityRecordV1) => record.source === "github";
  const comment = (record: ActivityRecordV1) => github(record) && record.kind === "comment";
  return {
    pullRequests: records.filter((record) => github(record) && record.kind === "pull-request").length,
    mergedPullRequests: records.filter((record) => github(record) && record.kind === "pull-request" && record.merged !== undefined).length,
    issues: records.filter((record) => github(record) && record.kind === "issue").length,
    comments: records.filter(comment).length,
    commentedThreads: distinct(comment),
    commentsOnOwn: records.filter((record) => comment(record) && threads[record.thread]?.author === personKey).length,
    jiraIssues: records.filter((record) => record.source === "jira" && record.kind === "issue").length,
    jiraComments: records.filter((record) => record.source === "jira" && record.kind === "comment").length,
    jiraThreads: distinct((record) => record.source === "jira"),
    messages: records.filter((record) => record.source === "mail").length,
    mailThreads: distinct((record) => record.source === "mail"),
    discussThreads: distinct((record) => record.source === "mail" && /^\[DISCUSS\]/iu.test(title(record))),
    voteThreads: distinct((record) => record.source === "mail" && /^\[VOTE\]/iu.test(title(record))),
  };
}

export function profileTotals(given: readonly ReviewGivenV1[], received: readonly ReviewReceivedV1[]): ProfileTotals {
  const byState: Record<ReviewState, number> = { APPROVED: 0, CHANGES_REQUESTED: 0, COMMENTED: 0, DISMISSED: 0 };
  for (const row of given) byState[row.state] += 1;
  return {
    reviewsGiven: {
      reviews: given.length,
      pullRequests: new Set(given.map((row) => row.pr)).size,
      byState,
      inlineComments: given.reduce((sum, row) => sum + row.inlineComments, 0),
    },
    reviewsReceived: {
      reviews: received.length,
      pullRequests: new Set(received.map((row) => row.pr)).size,
      reviewers: new Set(received.map((row) => row.reviewer ?? `#hidden-${row.reviewId}`)).size,
    },
  };
}

export type ProfilePeriod = "12m" | "90d";

export interface ProfileThread {
  readonly pr: number;
  readonly url: string;
  /** The person's part: they reviewed it, or they wrote it and others reviewed it. */
  readonly role: "reviewer" | "author";
  readonly reviews: number;
  readonly states: Readonly<Partial<Record<ReviewState, number>>>;
  /** For `reviewer`: the PR's author; for `author`: the number of distinct reviewers. */
  readonly counterpart: string | null;
  readonly reviewers: number;
  readonly lastAt: string;
}

export interface ProfileView {
  readonly from: string;
  readonly until: string;
  readonly days: number;
  readonly empty: boolean;
  readonly totals: ProfileTotals;
  /**
   * One row per month (12 months) or per week starting Monday (90 days), oldest first. With the
   * activity log, also the identity's records per source in that bucket.
   */
  readonly overTime: readonly {
    readonly label: string;
    readonly given: number;
    readonly received: number;
    readonly github?: number;
    readonly jira?: number;
    readonly mail?: number;
  }[];
  readonly worksWith: {
    readonly reviewedPullRequestsBy: readonly { readonly login: string; readonly pullRequests: number }[];
    readonly reviewedBy: readonly { readonly login: string; readonly pullRequests: number }[];
  };
  readonly threads: readonly ProfileThread[];
  /** Slice 2b: what the activity log holds for the period; absent when the community's log is not recorded. */
  readonly activity?: ActivityView;
}

export interface ActivityThreadView {
  readonly key: string;
  readonly source: ActivitySource;
  readonly title: string;
  readonly url: string;
  /** `author`: the person opened the thread (in this period or before); otherwise they wrote in it. */
  readonly role: "author" | "participant";
  /** The person's records in the thread in the period, by kind. */
  readonly kinds: Readonly<Partial<Record<ActivityKind, number>>>;
  readonly merged: boolean;
  readonly lastAt: string;
}

export interface ActivityView {
  readonly totals: ActivityTotals;
  /** W4: labels of the identity's GitHub threads minus process labels, and KIP numbers, each with its thread count. */
  readonly areas: {
    readonly labels: readonly { readonly label: string; readonly threads: number }[];
    readonly kips: readonly { readonly kip: string; readonly threads: number }[];
    /** Sources with records in the period that carry no labels ("no area data from dev@"). */
    readonly noLabelSources: readonly ActivitySource[];
  };
  readonly threads: readonly ActivityThreadView[];
  /** Behavior 9: authors of the threads the person wrote in, by shared threads, capped at 10. */
  readonly wroteInThreadsBy: readonly { readonly id: string; readonly display: string; readonly threads: number }[];
}

/** Behavior 9: each "Works with" list is grouped by relation and capped at 10 names. */
export const WORKS_WITH_CAP = 10;

/** What the page shows for one period; `12m` equals the response's `totals`. */
export function profileView(profile: PersonProfileV1, period: ProfilePeriod, nowMs: number): ProfileView {
  const project = peopleProject(profile.project.key);
  const periodFrom = Date.parse(profile.period.from);
  const fromMs = period === "12m" ? periodFrom : Math.max(periodFrom, nowMs - 90 * DAY_MS);
  const inPeriod = (row: { readonly submittedAt: string }) => Date.parse(row.submittedAt) >= fromMs;
  const given = profile.reviewsGiven.filter(inPeriod);
  const received = profile.reviewsReceived.filter(inPeriod);
  const totals = profileTotals(given, received);
  const until = profile.period.until;

  const bucketOf = period === "12m"
    ? (at: string) => at.slice(0, 7)
    : (at: string) => weekStart(Date.parse(at));
  const labels: string[] = [];
  if (period === "12m") labels.push(...profile.period.months);
  else for (let week = Date.parse(weekStart(fromMs)); week <= Math.max(fromMs, Date.parse(until)); week += 7 * DAY_MS) labels.push(weekStart(week));
  const records = (profile.activity?.records ?? []).filter((record) => Date.parse(record.at) >= fromMs);
  /** The last instant of a month or week bucket, as an ISO time. */
  const bucketEnd = (label: string) => (period === "12m"
    ? new Date(Date.UTC(Number(label.slice(0, 4)), Number(label.slice(5, 7)), 1) - 1).toISOString()
    : new Date(Date.parse(`${label}T00:00:00.000Z`) + 7 * DAY_MS - 1).toISOString());
  const overTime = labels.map((label) => ({
    label,
    given: given.filter((row) => bucketOf(row.submittedAt) === label).length,
    received: received.filter((row) => bucketOf(row.submittedAt) === label).length,
    // A bucket that ends before the activity log's coverage has no count, not 0 (W27).
    ...(profile.activity === undefined ? {} : Object.fromEntries(profile.coverage
      .flatMap((item) => (item.status === "recorded" && item.source !== "github-reviews" && bucketEnd(label) >= item.from ? [item.source] : []))
      .map((source) => [source, records.filter((record) => record.source === source && bucketOf(record.at) === label).length]))),
  }));

  const learned = new Set(profile.bots.map((login) => login.toLowerCase()));
  const isPerson = (login: string | null): login is string =>
    login !== null && login.toLowerCase() !== DELETED_ACCOUNT && !learned.has(login.toLowerCase()) &&
    (project === undefined || !isBotLogin(login, project));
  const shared = (pairs: readonly (readonly [string | null, number])[]) => {
    const byLogin = new Map<string, Set<number>>();
    for (const [login, pr] of pairs) if (isPerson(login)) (byLogin.get(login) ?? byLogin.set(login, new Set()).get(login)!).add(pr);
    return [...byLogin].map(([login, prs]) => ({ login, pullRequests: prs.size }))
      .sort((a, b) => b.pullRequests - a.pullRequests || a.login.localeCompare(b.login))
      .slice(0, WORKS_WITH_CAP);
  };

  const threads = new Map<string, { pr: number; role: "reviewer" | "author"; rows: { state: ReviewState; submittedAt: string; reviewId: number }[]; counterpart: string | null; reviewers: Set<string> }>();
  for (const row of given) {
    const key = `reviewer:${row.pr}`;
    const thread = threads.get(key) ?? threads.set(key, { pr: row.pr, role: "reviewer", rows: [], counterpart: row.prAuthor, reviewers: new Set() }).get(key)!;
    thread.rows.push(row);
  }
  for (const row of received) {
    const key = `author:${row.pr}`;
    const thread = threads.get(key) ?? threads.set(key, { pr: row.pr, role: "author", rows: [], counterpart: null, reviewers: new Set() }).get(key)!;
    thread.rows.push(row);
    thread.reviewers.add(row.reviewer ?? `#hidden-${row.reviewId}`);
  }
  const repository = profile.project.repository;
  const threadList = [...threads.values()].map((thread): ProfileThread => {
    const latest = [...thread.rows].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : b.reviewId - a.reviewId))[0]!;
    const states: Partial<Record<ReviewState, number>> = {};
    for (const row of thread.rows) states[row.state] = (states[row.state] ?? 0) + 1;
    return {
      pr: thread.pr,
      url: thread.role === "reviewer"
        ? `https://github.com/${repository}/pull/${thread.pr}#pullrequestreview-${latest.reviewId}`
        : `https://github.com/${repository}/pull/${thread.pr}`,
      role: thread.role,
      reviews: thread.rows.length,
      states,
      counterpart: thread.counterpart,
      reviewers: thread.reviewers.size,
      lastAt: latest.submittedAt,
    };
  }).sort((a, b) => (a.lastAt === b.lastAt ? b.pr - a.pr : a.lastAt < b.lastAt ? 1 : -1));

  return {
    from: new Date(fromMs).toISOString(),
    until,
    days: Math.max(1, Math.ceil((Date.parse(until) - fromMs) / DAY_MS)),
    empty: given.length === 0 && received.length === 0 && records.length === 0,
    totals,
    overTime,
    worksWith: {
      reviewedPullRequestsBy: shared(given.map((row) => [row.prAuthor, row.pr] as const)),
      reviewedBy: shared(received.map((row) => [row.reviewer, row.pr] as const)),
    },
    threads: threadList,
    ...(profile.activity === undefined ? {} : { activity: activityView(profile, records, project) }),
  };
}

function activityView(profile: PersonProfileV1, records: readonly ActivityRecordV1[], project: PeopleProject | undefined): ActivityView {
  const activity = profile.activity!;
  const personKey = profile.identity.source === "github" ? `github:${profile.identity.display.toLowerCase()}` : profile.identity.id;
  const byThread = new Map<string, ActivityRecordV1[]>();
  for (const record of records) (byThread.get(record.thread) ?? byThread.set(record.thread, []).get(record.thread)!).push(record);
  const noLabels = new Set<ActivitySource>();
  const authors = new Map<string, number>();
  const threads: ActivityThreadView[] = [];
  for (const [key, rows] of byThread) {
    const thread = activity.threads[key]!;
    if (thread.source !== "github") noLabels.add(thread.source);
    const author = thread.author === personKey || rows.some((row) => row.kind === "pull-request" || row.kind === "issue") ? "author" : "participant";
    if (author === "participant" && thread.author !== null && activity.people[thread.author] !== undefined) {
      authors.set(thread.author, (authors.get(thread.author) ?? 0) + 1);
    }
    const kinds: Partial<Record<ActivityKind, number>> = {};
    for (const row of rows) kinds[row.kind] = (kinds[row.kind] ?? 0) + 1;
    threads.push({
      key, source: thread.source, title: thread.title, url: thread.url, role: author, kinds,
      merged: rows.some((row) => row.merged !== undefined), lastAt: rows.map((row) => row.at).sort().at(-1)!,
    });
  }
  // Behavior 6: the same taxonomy and aggregation as the review areas (`areas.ts`).
  const distribution = areaDistribution([...byThread.keys()].map((key) => ({ key, labels: activity.threads[key]!.labels, kips: activity.threads[key]!.kips })),
    project ?? areaTaxonomy(profile.project.id));
  return {
    totals: activityTotals(records, activity.threads, personKey),
    areas: {
      labels: distribution.areas.map((area) => ({ label: area.label, threads: area.items })),
      kips: distribution.kips.map((entry) => ({ kip: entry.kip, threads: entry.items })),
      noLabelSources: [...noLabels].sort(),
    },
    threads: threads.sort((a, b) => (a.lastAt === b.lastAt ? a.key.localeCompare(b.key) : a.lastAt < b.lastAt ? 1 : -1)),
    wroteInThreadsBy: [...authors]
      .map(([id, count]) => ({ id, display: activity.people[id]!, threads: count }))
      .sort((a, b) => b.threads - a.threads || a.display.localeCompare(b.display))
      .slice(0, WORKS_WITH_CAP),
  };
}

/** The Monday (UTC) of the week holding `ms`, as `YYYY-MM-DD`. */
function weekStart(ms: number): string {
  const day = new Date(ms);
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - offset)).toISOString().slice(0, 10);
}
