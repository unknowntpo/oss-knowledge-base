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
  parseReviewMonth,
  type ReviewRow,
  type ReviewState,
} from "../github-reviews";

export const PEOPLE_PROFILE_SCHEMA = "osskb.people-profile.v1";
/** Decision 4 / W26: the newest 12 calendar months, the current one included. */
export const PEOPLE_HORIZON_MONTHS = 12;
/** W29: how long an isolate keeps a parsed month or the review cursor before reading it again. */
export const PEOPLE_INDEX_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** `github-reviews` is Spec 022's store; the others are the activity log of slice 2b. */
export type PeopleSource = "github-reviews" | "github" | "jira" | "mail";
/** What slice 2a reads. A community source not in this set is "not recorded yet" (W27). */
export const RECORDED_SOURCES: ReadonlySet<PeopleSource> = new Set(["github-reviews"]);

export interface PeopleProject {
  readonly projectKey: string;
  readonly projectId: string;
  readonly label: string;
  /** `owner/repo`, for links to reviews and pull requests. */
  readonly repository: string;
  readonly sources: readonly PeopleSource[];
  /** Logins that are not people (W12): the project's machine users and GitHub Apps whose GraphQL login has no `[bot]`. */
  readonly bots: readonly string[];
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
  /** A source whose identities have no store yet (2a: Jira, dev@). */
  | { readonly kind: "unrecorded"; readonly source: "jira" | "mail" };

/** `github:<login>`; `jira:` and `mail:` are well formed but not recorded in 2a. */
export function parsePersonId(value: string | null | undefined): ParsedPersonId | undefined {
  if (typeof value !== "string") return undefined;
  const colon = value.indexOf(":");
  const source = value.slice(0, colon);
  const key = value.slice(colon + 1);
  if (colon <= 0 || key.length === 0 || key.length > 200) return undefined;
  if (source === "github") return GITHUB_LOGIN.test(key) ? { kind: "github", login: key } : undefined;
  if (source === "jira" || source === "mail") return { kind: "unrecorded", source };
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
}

/**
 * Spec 019 Behavior 1 and W8: a bot's review counts for nobody; a review by the pull request's
 * author (an answer in a review thread) is not a review given, nor received.
 */
export function indexReviewMonth(rows: readonly ReviewRow[]): ReviewMonthIndex {
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
  return { people, bots };
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
  | { readonly source: "github-reviews"; readonly status: "recorded"; readonly from: string; readonly until: string; readonly storedFrom: string }
  | { readonly source: PeopleSource; readonly status: "not-recorded" };

export interface PersonProfileV1 {
  readonly schema: typeof PEOPLE_PROFILE_SCHEMA;
  readonly project: { readonly key: string; readonly id: string; readonly label: string; readonly repository: string };
  readonly identity: { readonly id: string; readonly source: "github"; readonly display: string; readonly url: string };
  readonly generatedAt: string;
  /** The 12-month view: from the later of `coverageFrom` and its first month, to the review cursor. */
  readonly period: { readonly from: string; readonly until: string; readonly months: readonly string[] };
  readonly coverage: readonly SourceCoverageV1[];
  /** W10: months that exist in the view but could not be read; their rows are missing from every count. */
  readonly unavailableMonths: readonly string[];
  readonly reviewsGiven: readonly ReviewGivenV1[];
  readonly reviewsReceived: readonly ReviewReceivedV1[];
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

interface StoreState { readonly updatedAt: string; readonly coverageFrom: string }

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

async function readState(bucket: PeopleBucket, projectId: string, nowMs: number): Promise<StoreState | undefined> {
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

/** A month without an object has no reviews (Spec 022 writes only months with rows). */
function readMonth(bucket: PeopleBucket, projectId: string, month: string, nowMs: number): Promise<ReviewMonthIndex> {
  const key = githubReviewsMonthKey(projectId, month);
  return cached(bucket, key, nowMs, async () => {
    const object = await bucket.get(key);
    if (object === null) return { people: new Map(), bots: new Set() };
    return indexReviewMonth(parseReviewMonth(JSON.parse(await object.text()), projectId, month));
  });
}

function coverageOf(project: PeopleProject, reviews: Extract<SourceCoverageV1, { status: "recorded" }> | undefined): readonly SourceCoverageV1[] {
  return project.sources.map((source) => (source === "github-reviews" && reviews !== undefined
    ? reviews
    : { source, status: "not-recorded" as const }));
}

/** `GET /api/people/:project/:id` (Spec 019 slice 2a). */
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
  const isSuppressed = async (login: string) => suppressed.size > 0 && suppressed.has(await suppressionDigest(project.projectId, personIdOf(login)));

  let state: StoreState | undefined;
  try {
    state = await readState(input.bucket, project.projectId, input.nowMs);
  } catch (error) {
    return { status: 503, body: { error: error instanceof Error ? error.message : "Unable to read the review store" } };
  }
  const months = state === undefined ? [] : profileMonths(input.nowMs, state.coverageFrom);
  const reviews = state === undefined || months.length === 0 ? undefined : {
    source: "github-reviews" as const,
    status: "recorded" as const,
    from: new Date(Math.max(Date.parse(state.coverageFrom), Date.parse(`${months[0]}-01T00:00:00.000Z`))).toISOString(),
    until: state.updatedAt,
    storedFrom: state.coverageFrom,
  };
  const coverage = coverageOf(project, reviews);
  const notFound = (unavailableMonths: readonly string[] = []): PeopleRead => ({
    status: 404,
    body: { error: `No recorded activity for this identity in ${project.label}`, coverage, ...(unavailableMonths.length === 0 ? {} : { unavailableMonths }) },
  });
  if (parsed.kind === "unrecorded") return notFound();
  if (isBotLogin(parsed.login, project) || parsed.login.toLowerCase() === DELETED_ACCOUNT) {
    return { status: 404, body: { error: "Bots and deleted accounts have no profile", coverage } };
  }
  if (await isSuppressed(parsed.login) || reviews === undefined) return notFound();

  const unavailableMonths: string[] = [];
  const indexes = await Promise.all(months.map((month) => readMonth(input.bucket, project.projectId, month, input.nowMs).catch(() => {
    unavailableMonths.push(month);
    return undefined;
  })));
  unavailableMonths.sort();
  const learnedBots = new Set(indexes.flatMap((index) => (index === undefined ? [] : [...index.bots])));
  if (isBotLogin(parsed.login, project, learnedBots)) return { status: 404, body: { error: "Bots and deleted accounts have no profile", coverage } };

  const key = parsed.login.toLowerCase();
  const from = Date.parse(reviews.from);
  const given: ReviewRow[] = [];
  const received: ReviewRow[] = [];
  for (const index of indexes) {
    const entry = index?.people.get(key);
    if (entry === undefined) continue;
    given.push(...entry.given.filter((row) => Date.parse(row.submittedAt) >= from));
    received.push(...entry.received.filter((row) => Date.parse(row.submittedAt) >= from));
  }
  if (given.length === 0 && received.length === 0) return notFound(unavailableMonths);
  const display = given[0]?.reviewer ?? received[0]!.prAuthor;

  // P-e: a counterpart who asked to be removed stays counted, but unnamed.
  const hidden = new Set<string>();
  if (suppressed.size > 0) {
    for (const login of new Set([...given.map((row) => row.prAuthor), ...received.map((row) => row.reviewer)])) {
      if (await isSuppressed(login)) hidden.add(login);
    }
  }
  const newestFirst = (a: ReviewRow, b: ReviewRow) => (a.submittedAt === b.submittedAt ? b.reviewId - a.reviewId : a.submittedAt < b.submittedAt ? 1 : -1);
  const verdict = (row: ReviewRow) => (row.stateBefore === undefined ? {} : { stateBefore: row.stateBefore });
  const body: Omit<PersonProfileV1, "totals"> = {
    schema: PEOPLE_PROFILE_SCHEMA,
    project: { key: project.projectKey, id: project.projectId, label: project.label, repository: project.repository },
    identity: { id: personIdOf(display), source: "github", display, url: `https://github.com/${display}` },
    generatedAt: new Date(input.nowMs).toISOString(),
    period: { from: reviews.from, until: reviews.until, months },
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
  };
  return { status: 200, body: { ...body, totals: profileTotals(body.reviewsGiven, body.reviewsReceived) } };
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
  /** One row per month (12 months) or per week starting Monday (90 days), oldest first. */
  readonly overTime: readonly { readonly label: string; readonly given: number; readonly received: number }[];
  readonly worksWith: {
    readonly reviewedPullRequestsBy: readonly { readonly login: string; readonly pullRequests: number }[];
    readonly reviewedBy: readonly { readonly login: string; readonly pullRequests: number }[];
  };
  readonly threads: readonly ProfileThread[];
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
  const overTime = labels.map((label) => ({
    label,
    given: given.filter((row) => bucketOf(row.submittedAt) === label).length,
    received: received.filter((row) => bucketOf(row.submittedAt) === label).length,
  }));

  const isPerson = (login: string | null): login is string =>
    login !== null && login.toLowerCase() !== DELETED_ACCOUNT && (project === undefined || !isBotLogin(login, project));
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
    empty: given.length === 0 && received.length === 0,
    totals,
    overTime,
    worksWith: {
      reviewedPullRequestsBy: shared(given.map((row) => [row.prAuthor, row.pr] as const)),
      reviewedBy: shared(received.map((row) => [row.reviewer, row.pr] as const)),
    },
    threads: threadList,
  };
}

/** The Monday (UTC) of the week holding `ms`, as `YYYY-MM-DD`. */
function weekStart(ms: number): string {
  const day = new Date(ms);
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - offset)).toISOString().slice(0, 10);
}
