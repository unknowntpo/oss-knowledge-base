/**
 * Spec 022: one run of the GitHub review ingestion. For each project it lists what GitHub updated
 * since the stored cursor (REST, ascending), reads the reviews of those pull requests in batches
 * (GraphQL), merges the rows into one object per month, then moves the cursor. It runs in the
 * Worker invocation, outside the publication's Durable Object, and never touches the Feed, the
 * Search release, or the publication state.
 */
import {
  encodeReviewMonth,
  GITHUB_REVIEWS_AREAS_REVISION,
  GITHUB_REVIEWS_REVISION,
  mergeMonthExtras,
  parseReviewMonthObject,
  pullAreaMeta,
  pullDisplayNames,
  resolveGithubReviewsRevision,
  type GithubReviewsRevision,
  type PullAreaMeta,
  GITHUB_REVIEWS_STATE_SCHEMA,
  mergeReviewRows,
  nextKeysetPage,
  parsePullReviews,
  pullReviewsQuery,
  reviewMonth,
  reviewRows,
  selectUpdatedPulls,
  SOURCE_USER_AGENT,
  type ReviewRow,
  type UpdatedItem,
} from "@oss-knowledge-base/reference-pipeline";
import { graphqlPage, newCounter, retryAfterSeconds, SourceError, type Counter, type Delay, type FetchLike } from "../review-queue/fetchers";
import { sanitizeErrorMessage } from "../search-embedding/sanitize";
import {
  GITHUB_REVIEWS_BACKFILL_LAST_RUN_KEY,
  GITHUB_REVIEWS_LAST_RUN_KEY,
  githubReviewsBackfillKey,
  githubReviewsMonthKey,
  githubReviewsStateKey,
  type GithubReviewsBucket,
} from "./store";

/** Behavior 2: as the GitHub connector: a first run reads one day, later runs re-read 300 s. */
export const FIRST_RUN_LOOKBACK_MS = 86_400_000;
export const CURSOR_OVERLAP_MS = 300_000;
/** Behavior 3: new pull requests read per project per run (the 300 s overlap comes on top); a larger backlog continues on the next run. */
export const MAX_PULLS_PER_RUN = 500;
/** Behavior 4: pull requests per GraphQL request. */
export const PULLS_PER_BATCH = 25;
export const LIST_PAGE_SIZE = 100;
/** Behavior 3: listing pages per project per run; issues share the listing with pull requests. */
export const MAX_LIST_PAGES = 20;
/**
 * Behavior 5: the daily run does not write a review older than this, so it reads at most three
 * month objects per project. This bounds the daily run's writes, not what the store keeps (RV20,
 * Behavior 14): rows older than this stay, and the backfill writes them.
 */
export const REVIEW_WINDOW_MS = 35 * 86_400_000;

export { GITHUB_REVIEWS_STATE_SCHEMA };

export interface GithubReviewsState {
  readonly schema: typeof GITHUB_REVIEWS_STATE_SCHEMA;
  /** Everything GitHub updated up to here has been read. */
  readonly updatedAt: string;
  /** Reviews submitted before this were never read; a profile must not count from earlier. */
  readonly coverageFrom: string;
}

export interface GithubReviewsProject {
  readonly projectId: string;
  readonly owner: string;
  readonly repo: string;
  readonly machineUsers: readonly string[];
}

export interface ProjectRun {
  readonly ok: boolean;
  readonly since: string;
  readonly cursor: string | null;
  readonly coverageFrom: string | null;
  readonly listed: number;
  readonly pulls: number;
  readonly truncated: boolean;
  readonly reviews: number;
  readonly botReviews: number;
  readonly selfReviews: number;
  readonly added: number;
  readonly changed: number;
  readonly dismissed: number;
  readonly droppedPulls: number;
  /** Pull requests with more reviews in the window than one read returns. */
  readonly reviewsTruncated: number;
  readonly monthsRead: number;
  readonly monthsWritten: number;
  readonly restRequests: number;
  readonly graphqlRequests: number;
  readonly graphqlCost: number;
  readonly bytes: number;
  readonly durationMs: number;
  /** `metadata@2`: pull requests with more labels than one read returns (`LABELS_PER_PULL`). */
  readonly labelsTruncated: number;
  readonly failureKind?: string;
  readonly error?: string;
}

export interface GithubReviewsLastRun {
  readonly ok: boolean;
  readonly revision: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly projects: Readonly<Record<string, ProjectRun>>;
  readonly failureKind?: "config" | "source";
  readonly error?: string;
}

export interface GithubReviewsDeps {
  readonly flag: string | undefined;
  readonly bucket: GithubReviewsBucket;
  readonly projects: readonly GithubReviewsProject[];
  readonly githubToken: string;
  readonly githubFetch: FetchLike;
  readonly now: () => number;
  readonly delay: Delay;
  readonly dryRun?: boolean;
  readonly maxPullsPerRun?: number;
  /** How far a first run looks back; `FIRST_RUN_LOOKBACK_MS` when absent. Set only by `measure:github-reviews`. */
  readonly firstRunLookbackMs?: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Another run wrote the month object (or the cursor) between this run's read and its write. */
export class MonthConflictError extends Error {}

/** Behavior 13: the backfill cannot run as asked (no daily cursor yet, or another backfill in progress). */
class BackfillConfigError extends Error {}

/** One listing page; the same retry rules as the GraphQL read (one retry after a 5xx or a short Retry-After). */
async function listPage(deps: GithubReviewsDeps, counter: Counter, url: string): Promise<readonly UpdatedItem[]> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      counter.requests += 1;
      response = await deps.githubFetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${deps.githubToken}`,
          "User-Agent": SOURCE_USER_AGENT,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (error) {
      if (attempt === 0) {
        await deps.delay(5_000);
        continue;
      }
      throw new SourceError("transport", `GitHub listing: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new SourceError("auth", "GitHub listing 401");
    }
    if (response.status === 403 || response.status === 429) {
      const wait = retryAfterSeconds(response);
      await response.body?.cancel();
      if (attempt === 0 && wait !== undefined && wait <= 60) {
        await deps.delay(wait * 1000);
        continue;
      }
      throw new SourceError("rate-limit", `GitHub listing ${response.status}; Retry-After ${wait ?? "none"}`);
    }
    if (response.status >= 500 && attempt === 0) {
      await response.body?.cancel();
      await deps.delay(5_000);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceError("transport", `GitHub listing ${response.status}`);
    }
    const text = await response.text();
    counter.bytes += text.length;
    let items: unknown;
    try {
      items = JSON.parse(text);
    } catch {
      throw new SourceError("schema", "GitHub listing returned invalid JSON");
    }
    if (!Array.isArray(items) || !items.every((item) => Number.isInteger(item?.number) && typeof item?.updated_at === "string")) {
      throw new SourceError("schema", "GitHub listing is malformed");
    }
    // Only these three fields leave this function; titles and bodies are dropped with the response.
    return (items as UpdatedItem[]).map((item) => ({
      number: item.number,
      updated_at: item.updated_at,
      ...(item.pull_request === undefined || item.pull_request === null ? {} : { pull_request: true }),
    }));
  }
}

/**
 * Behavior 3: the ascending "updated since" listing, paged by key (`nextKeysetPage`) for both the
 * daily run and the backfill. Offset pages shift when an item already listed is updated meanwhile
 * (one item would be skipped), and GitHub answers 422 past about page 10 of a large listing, which
 * a day of more than about 1,000 updated issues would reach on every later run.
 */
async function listUpdated(deps: GithubReviewsDeps, counter: Counter, project: GithubReviewsProject, since: string, previousCursor: string, maxPulls: number) {
  const items: UpdatedItem[] = [];
  const seen = new Set<string>();
  // Only pull requests newer than the cursor count against the cap (see `selectUpdatedPulls`).
  let pulls = 0;
  let request = { since, page: 1 };
  for (let pages = 1; ; pages += 1) {
    const url = new URL(`https://api.github.com/repos/${project.owner}/${project.repo}/issues`);
    for (const [key, value] of Object.entries({ state: "all", sort: "updated", direction: "asc", since: request.since, per_page: LIST_PAGE_SIZE, page: request.page })) url.searchParams.set(key, String(value));
    const values = await listPage(deps, counter, url.toString());
    const fresh = values.filter((item) => !seen.has(`${item.number}@${item.updated_at}`));
    for (const item of fresh) seen.add(`${item.number}@${item.updated_at}`);
    items.push(...fresh);
    pulls += fresh.filter((item) => item.pull_request !== undefined && item.updated_at > previousCursor).length;
    if (values.length < LIST_PAGE_SIZE) return { items, morePages: false };
    if (pulls >= maxPulls || pages >= MAX_LIST_PAGES) return { items, morePages: true };
    request = nextKeysetPage(request, values);
  }
}

export function parseState(body: string | undefined): GithubReviewsState | undefined {
  if (body === undefined) return undefined;
  const state = JSON.parse(body) as Partial<GithubReviewsState> | null;
  if (state?.schema !== GITHUB_REVIEWS_STATE_SCHEMA || typeof state.updatedAt !== "string" || typeof state.coverageFrom !== "string" ||
      Number.isNaN(Date.parse(state.updatedAt)) || Number.isNaN(Date.parse(state.coverageFrom))) {
    throw new SourceError("schema", "The stored review cursor is malformed");
  }
  return state as GithubReviewsState;
}

type RunCounts = {
  labelsTruncated: number;
  reviews: number; botReviews: number; selfReviews: number; added: number; changed: number; dismissed: number;
  droppedPulls: number; reviewsTruncated: number; monthsRead: number; monthsWritten: number; graphqlCost: number;
};

/** One month's newly read rows and, under `metadata@2`, what was read about their pull requests and logins. */
interface MonthRead {
  readonly rows: ReviewRow[];
  readonly pulls: Map<number, PullAreaMeta>;
  readonly names: Map<string, string | null>;
}

/** What one batched read gives, per pull request: its rows, and under `metadata@2` its metadata and names. */
export async function readBatch(deps: GithubReviewsDeps, project: GithubReviewsProject, graphql: Counter, batch: readonly number[], areas: boolean, run: { graphqlCost: number; droppedPulls: number }) {
  const body = await graphqlPage(
    { token: deps.githubToken, fetchImpl: deps.githubFetch, delay: deps.delay, counter: graphql, query: pullReviewsQuery(batch, { areas }) },
    { owner: project.owner, repo: project.repo },
  );
  const page = parsePullReviews(body, batch);
  if (!page.ok) throw new SourceError("schema", page.error);
  run.graphqlCost += page.cost;
  run.droppedPulls += page.dropped.length;
  return page;
}

/** Behavior 4–6: the reviews of `numbers`, 25 pull requests a request, as rows grouped by month. */
async function readRows(deps: GithubReviewsDeps, project: GithubReviewsProject, graphql: Counter, numbers: readonly number[], window: { readonly from: string; readonly until?: string }, run: RunCounts, areas: boolean) {
  const byMonth = new Map<string, MonthRead>();
  for (let index = 0; index < numbers.length; index += PULLS_PER_BATCH) {
    const page = await readBatch(deps, project, graphql, numbers.slice(index, index + PULLS_PER_BATCH), areas, run);
    for (const pull of page.pulls) {
      const result = reviewRows(pull, { ...window, machineUsers: project.machineUsers });
      if (result.truncated) run.reviewsTruncated += 1;
      const meta = areas ? pullAreaMeta(pull) : undefined;
      const names = areas ? pullDisplayNames(pull) : undefined;
      if (areas && (pull.labels?.totalCount ?? 0) > (pull.labels?.nodes.length ?? 0)) run.labelsTruncated += 1;
      for (const row of result.rows) {
        run.reviews += 1;
        if (row.isBot) run.botReviews += 1;
        else if (row.reviewer === row.prAuthor) run.selfReviews += 1;
        const month = reviewMonth(row.submittedAt);
        const entry = byMonth.get(month) ?? byMonth.set(month, { rows: [], pulls: new Map(), names: new Map() }).get(month)!;
        entry.rows.push(row);
        if (meta !== undefined) entry.pulls.set(row.pr, meta);
        // RV38: a month keeps the names of the logins in its own rows only.
        for (const login of [row.reviewer, row.prAuthor]) if (names?.has(login) === true) entry.names.set(login, names.get(login)!);
      }
    }
  }
  return byMonth;
}

/**
 * Behavior 7–9: merges each month, oldest first, and writes it only if it changed and nobody wrote
 * it meanwhile. Under `metadata@1` a month's stored `pulls` and `people` are kept as they are.
 */
async function writeMonths(deps: GithubReviewsDeps, project: GithubReviewsProject, byMonth: ReadonlyMap<string, MonthRead>, run: RunCounts) {
  for (const month of [...byMonth.keys()].sort()) {
    const key = githubReviewsMonthKey(project.projectId, month);
    const stored = await deps.bucket.get(key);
    run.monthsRead += 1;
    const object = stored === undefined ? { rows: [] } : parseReviewMonthObject(JSON.parse(stored.body), project.projectId, month);
    const read = byMonth.get(month)!;
    const merged = mergeReviewRows(object.rows, read.rows);
    run.added += merged.added;
    run.changed += merged.changed;
    run.dismissed += merged.dismissed;
    const extras = mergeMonthExtras(object, read.pulls, read.names);
    const body = encodeReviewMonth(project.projectId, month, merged.rows, extras);
    if (deps.dryRun === true || body === stored?.body) continue;
    if (!await deps.bucket.putIfMatch(key, body, stored?.etag ?? null)) throw new MonthConflictError(`Review month ${month} changed during the run`);
    run.monthsWritten += 1;
  }
}

async function runProject(deps: GithubReviewsDeps, project: GithubReviewsProject, startedMs: number, revision: GithubReviewsRevision): Promise<ProjectRun> {
  const rest = newCounter();
  const graphql = newCounter();
  const maxPulls = deps.maxPullsPerRun ?? MAX_PULLS_PER_RUN;
  let since = iso(startedMs - (deps.firstRunLookbackMs ?? FIRST_RUN_LOOKBACK_MS));
  const run = {
    cursor: null as string | null, coverageFrom: null as string | null, listed: 0, pulls: 0, truncated: false, reviews: 0, botReviews: 0, selfReviews: 0,
    added: 0, changed: 0, dismissed: 0, droppedPulls: 0, reviewsTruncated: 0, monthsRead: 0, monthsWritten: 0, graphqlCost: 0, labelsTruncated: 0,
  };
  const done = (extra: { readonly ok: boolean; readonly failureKind?: string; readonly error?: string }): ProjectRun => ({
    ...extra, since, ...run, restRequests: rest.requests, graphqlRequests: graphql.requests, bytes: rest.bytes + graphql.bytes, durationMs: deps.now() - startedMs,
  });
  try {
    const stateKey = githubReviewsStateKey(project.projectId);
    const stateObject = await deps.bucket.get(stateKey);
    const state = parseState(stateObject?.body);
    if (state !== undefined) since = iso(Date.parse(state.updatedAt) - CURSOR_OVERLAP_MS);
    const coverageFrom = state?.coverageFrom ?? since;
    run.cursor = state?.updatedAt ?? null;
    run.coverageFrom = coverageFrom;

    const previousCursor = state?.updatedAt ?? since;
    const listing = await listUpdated(deps, rest, project, since, previousCursor, maxPulls);
    const selected = selectUpdatedPulls(listing.items, { maxPulls, morePages: listing.morePages, previousCursor });
    run.listed = listing.items.length;
    run.pulls = selected.numbers.length;
    run.truncated = selected.truncated;

    const from = iso(Math.max(Date.parse(coverageFrom), startedMs - REVIEW_WINDOW_MS));
    const byMonth = await readRows(deps, project, graphql, selected.numbers, { from }, run, revision === GITHUB_REVIEWS_AREAS_REVISION);
    // Oldest month first; a run that dies here leaves the cursor where it was, and the next run
    // reads the same reviews into the same rows.
    await writeMonths(deps, project, byMonth, run);

    const next: GithubReviewsState = { schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: selected.cursor, coverageFrom };
    // Conditional on the cursor read at the start, so a backfill that moved `coverageFrom` meanwhile
    // is never overwritten with the older value (Behavior 13); the next run repairs a conflict.
    if (deps.dryRun !== true && (state?.updatedAt !== next.updatedAt || state.coverageFrom !== next.coverageFrom) &&
        !await deps.bucket.putIfMatch(stateKey, JSON.stringify(next), stateObject?.etag ?? null)) {
      throw new MonthConflictError("The review cursor changed during the run");
    }
    run.cursor = selected.cursor;
    return done({ ok: true });
  } catch (error) {
    const failureKind = error instanceof SourceError ? error.failureKind : error instanceof MonthConflictError ? "conflict" : "internal";
    return done({ ok: false, failureKind, error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) });
  }
}

/** Behavior 1: the revision the flag names, or a `config` failure (unset, unsupported, no token). */
export function resolveRunConfig(deps: Pick<GithubReviewsDeps, "flag" | "githubToken">): { readonly revision?: GithubReviewsRevision; readonly failure: Pick<GithubReviewsLastRun, "failureKind" | "error"> } {
  try {
    const revision = resolveGithubReviewsRevision(deps.flag);
    if (revision === undefined) throw new Error("GITHUB_REVIEWS is not set");
    if (deps.githubToken.trim() === "") throw new Error("GITHUB_SOURCE_TOKEN is not configured");
    return { revision, failure: {} };
  } catch (error) {
    return { failure: { failureKind: "config", error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) } };
  }
}

/**
 * One run over every project. A project that fails keeps its cursor and its rows and does not stop
 * the others. The run record is written unless the run is dry; this function does not throw.
 */
export async function runGithubReviews(deps: GithubReviewsDeps): Promise<GithubReviewsLastRun> {
  const startedMs = deps.now();
  const projects: Record<string, ProjectRun> = {};
  const { revision, failure: configFailure } = resolveRunConfig(deps);
  let failure: Pick<GithubReviewsLastRun, "failureKind" | "error"> = configFailure;
  if (failure.failureKind === undefined) {
    for (const project of deps.projects) projects[project.projectId] = await runProject(deps, project, deps.now(), revision!);
    if (Object.values(projects).some((project) => !project.ok)) failure = { failureKind: "source" };
  }
  const completedMs = deps.now();
  const lastRun: GithubReviewsLastRun = {
    ok: failure.failureKind === undefined,
    revision: revision ?? GITHUB_REVIEWS_REVISION,
    dryRun: deps.dryRun === true,
    startedAt: iso(startedMs),
    completedAt: iso(completedMs),
    durationMs: completedMs - startedMs,
    projects,
    ...failure,
  };
  if (deps.dryRun !== true) {
    await deps.bucket.put(GITHUB_REVIEWS_LAST_RUN_KEY, JSON.stringify(lastRun))
      .catch((error: unknown) => console.error(`Recording the review run failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  return lastRun;
}

export const GITHUB_REVIEWS_BACKFILL_SCHEMA = "osskb.github-reviews-backfill.v1";

/** Behavior 13: where a backfill has got to, kept apart from the daily cursor. */
export interface GithubReviewsBackfillState {
  readonly schema: typeof GITHUB_REVIEWS_BACKFILL_SCHEMA;
  /** The oldest submission time it stores. */
  readonly from: string;
  /** The daily run's `coverageFrom` when the backfill started: it stores reviews submitted before this only. */
  readonly until: string;
  /** Every item GitHub updated from `from` up to here has been read. */
  readonly cursor: string;
  readonly completedAt: string | null;
}

export interface BackfillProjectRun extends ProjectRun {
  readonly from: string;
  readonly until: string | null;
  /** The listing reached the present and `coverageFrom` was moved to `from`. */
  readonly done: boolean;
}

export interface GithubReviewsBackfillLastRun extends Omit<GithubReviewsLastRun, "projects"> {
  readonly from: string;
  readonly projects: Readonly<Record<string, BackfillProjectRun>>;
}

function parseBackfill(body: string | undefined): GithubReviewsBackfillState | undefined {
  if (body === undefined) return undefined;
  const state = JSON.parse(body) as Partial<GithubReviewsBackfillState> | null;
  if (state?.schema !== GITHUB_REVIEWS_BACKFILL_SCHEMA || [state.from, state.until, state.cursor].some((value) => typeof value !== "string" || Number.isNaN(Date.parse(value))) ||
      (state.completedAt !== null && typeof state.completedAt !== "string")) {
    throw new SourceError("schema", "The stored backfill progress is malformed");
  }
  return state as GithubReviewsBackfillState;
}

/**
 * Behavior 13: one chunk of the backfill of one project. It lists, oldest first and by key, what
 * GitHub updated since the backfill's own cursor, reads at most the cap's worth of pull requests,
 * and stores their reviews submitted in [`from`, `until`): `until` is the daily run's
 * `coverageFrom`, so the two never write the same review. When the listing reaches the present, it
 * moves the daily `coverageFrom` to `from` (conditional on the cursor it read, never touching
 * `updatedAt`) and marks itself complete. Writes: months, then the cursor, then its progress.
 */
async function runBackfillProject(deps: GithubReviewsDeps, project: GithubReviewsProject, from: string, startedMs: number, revision: GithubReviewsRevision): Promise<BackfillProjectRun> {
  const rest = newCounter();
  const graphql = newCounter();
  const maxPulls = deps.maxPullsPerRun ?? MAX_PULLS_PER_RUN;
  let since = from;
  let until: string | null = null;
  let done = false;
  const run = {
    cursor: null as string | null, coverageFrom: null as string | null, listed: 0, pulls: 0, truncated: false, reviews: 0, botReviews: 0, selfReviews: 0,
    added: 0, changed: 0, dismissed: 0, droppedPulls: 0, reviewsTruncated: 0, monthsRead: 0, monthsWritten: 0, graphqlCost: 0, labelsTruncated: 0,
  };
  const finish = (extra: { readonly ok: boolean; readonly failureKind?: string; readonly error?: string }): BackfillProjectRun => ({
    ...extra, from, until, done, since, ...run, restRequests: rest.requests, graphqlRequests: graphql.requests, bytes: rest.bytes + graphql.bytes, durationMs: deps.now() - startedMs,
  });
  try {
    const stateKey = githubReviewsStateKey(project.projectId);
    const stateObject = await deps.bucket.get(stateKey);
    const state = parseState(stateObject?.body);
    if (state === undefined) throw new BackfillConfigError("No daily cursor yet: the backfill fills in before the daily run's coverageFrom, so run the daily ingestion first");
    run.coverageFrom = state.coverageFrom;
    const progressKey = githubReviewsBackfillKey(project.projectId);
    const progressObject = await deps.bucket.get(progressKey);
    const stored = parseBackfill(progressObject?.body);
    const inProgress = stored !== undefined && stored.completedAt === null ? stored : undefined;
    if (inProgress !== undefined && inProgress.from !== from) {
      throw new BackfillConfigError(`A backfill from ${inProgress.from} is in progress; call again with from=${inProgress.from}`);
    }
    if (inProgress === undefined && Date.parse(from) >= Date.parse(state.coverageFrom)) {
      // Nothing before coverageFrom is asked for: already covered.
      run.cursor = stored?.cursor ?? null;
      done = true;
      return finish({ ok: true });
    }
    const progress: GithubReviewsBackfillState = inProgress ?? { schema: GITHUB_REVIEWS_BACKFILL_SCHEMA, from, until: state.coverageFrom, cursor: from, completedAt: null };
    until = progress.until;
    run.cursor = progress.cursor;
    if (progress.cursor !== from) since = iso(Date.parse(progress.cursor) - CURSOR_OVERLAP_MS);

    const listing = await listUpdated(deps, rest, project, since, progress.cursor, maxPulls);
    const selected = selectUpdatedPulls(listing.items, { maxPulls, morePages: listing.morePages, previousCursor: progress.cursor });
    run.listed = listing.items.length;
    run.pulls = selected.numbers.length;
    run.truncated = selected.truncated;

    const byMonth = await readRows(deps, project, graphql, selected.numbers, { from, until: progress.until }, run, revision === GITHUB_REVIEWS_AREAS_REVISION);
    await writeMonths(deps, project, byMonth, run);

    const complete = !selected.truncated;
    if (complete && Date.parse(from) < Date.parse(state.coverageFrom)) {
      const next: GithubReviewsState = { ...state, coverageFrom: from };
      if (deps.dryRun !== true && !await deps.bucket.putIfMatch(stateKey, JSON.stringify(next), stateObject!.etag)) {
        throw new MonthConflictError("The review cursor changed during the backfill");
      }
    }
    const next: GithubReviewsBackfillState = { ...progress, cursor: selected.cursor, completedAt: complete ? iso(deps.now()) : null };
    if (deps.dryRun !== true && !await deps.bucket.putIfMatch(progressKey, JSON.stringify(next), progressObject?.etag ?? null)) {
      throw new MonthConflictError("The backfill progress changed during the call");
    }
    run.cursor = selected.cursor;
    if (complete) {
      run.coverageFrom = from;
      done = true;
    }
    return finish({ ok: true });
  } catch (error) {
    const failureKind = error instanceof BackfillConfigError ? "config" : error instanceof SourceError ? error.failureKind : error instanceof MonthConflictError ? "conflict" : "internal";
    return finish({ ok: false, failureKind, error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) });
  }
}

/**
 * Behavior 13: one manual backfill call over every project. `from` is validated by the route
 * (`resolveBackfillFrom`). The daily run record is not touched; this call's record goes to
 * `backfill-last-run.json` unless the call is dry. This function does not throw.
 */
export async function runGithubReviewsBackfill(deps: GithubReviewsDeps & { readonly from: string }): Promise<GithubReviewsBackfillLastRun> {
  const startedMs = deps.now();
  const projects: Record<string, BackfillProjectRun> = {};
  const { revision, failure: configFailure } = resolveRunConfig(deps);
  let failure: Pick<GithubReviewsLastRun, "failureKind" | "error"> = configFailure;
  if (failure.failureKind === undefined) {
    for (const project of deps.projects) projects[project.projectId] = await runBackfillProject(deps, project, deps.from, deps.now(), revision!);
    if (Object.values(projects).some((project) => !project.ok)) failure = { failureKind: "source" };
  }
  const completedMs = deps.now();
  const lastRun: GithubReviewsBackfillLastRun = {
    ok: failure.failureKind === undefined,
    revision: revision ?? GITHUB_REVIEWS_REVISION,
    dryRun: deps.dryRun === true,
    from: deps.from,
    startedAt: iso(startedMs),
    completedAt: iso(completedMs),
    durationMs: completedMs - startedMs,
    projects,
    ...failure,
  };
  if (deps.dryRun !== true) {
    await deps.bucket.put(GITHUB_REVIEWS_BACKFILL_LAST_RUN_KEY, JSON.stringify(lastRun))
      .catch((error: unknown) => console.error(`Recording the review backfill failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  return lastRun;
}
