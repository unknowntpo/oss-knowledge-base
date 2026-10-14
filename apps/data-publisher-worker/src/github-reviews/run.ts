/**
 * Spec 022: one run of the GitHub review ingestion. For each project it lists what GitHub updated
 * since the stored cursor (REST, ascending), reads the reviews of those pull requests in batches
 * (GraphQL), merges the rows into one object per month, then moves the cursor. It runs in the
 * Worker invocation, outside the publication's Durable Object, and never touches the Feed, the
 * Search release, or the publication state.
 */
import {
  encodeReviewMonth,
  GITHUB_REVIEWS_REVISION,
  mergeReviewRows,
  parsePullReviews,
  parseReviewMonth,
  pullReviewsQuery,
  resolveGithubReviews,
  reviewMonth,
  reviewRows,
  selectUpdatedPulls,
  SOURCE_USER_AGENT,
  type ReviewRow,
  type UpdatedItem,
} from "@oss-knowledge-base/reference-pipeline";
import { graphqlPage, newCounter, retryAfterSeconds, SourceError, type Counter, type Delay, type FetchLike } from "../review-queue/fetchers";
import { sanitizeErrorMessage } from "../search-embedding/sanitize";
import { GITHUB_REVIEWS_LAST_RUN_KEY, githubReviewsMonthKey, githubReviewsStateKey, type GithubReviewsBucket } from "./store";

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
/** Behavior 5: a review older than this is not written again, so a run reads at most three month objects per project. */
export const REVIEW_WINDOW_MS = 35 * 86_400_000;

export const GITHUB_REVIEWS_STATE_SCHEMA = "osskb.github-reviews-state.v1";

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

/** Another run wrote the month object between this run's read and its write. */
class MonthConflictError extends Error {}

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

async function listUpdated(deps: GithubReviewsDeps, counter: Counter, project: GithubReviewsProject, since: string, previousCursor: string, maxPulls: number) {
  const items: UpdatedItem[] = [];
  // Only pull requests newer than the cursor count against the cap (see `selectUpdatedPulls`).
  let pulls = 0;
  for (let page = 1; ; page += 1) {
    const url = new URL(`https://api.github.com/repos/${project.owner}/${project.repo}/issues`);
    for (const [key, value] of Object.entries({ state: "all", sort: "updated", direction: "asc", since, per_page: LIST_PAGE_SIZE, page })) url.searchParams.set(key, String(value));
    const values = await listPage(deps, counter, url.toString());
    items.push(...values);
    pulls += values.filter((item) => item.pull_request !== undefined && item.updated_at > previousCursor).length;
    if (values.length < LIST_PAGE_SIZE) return { items, morePages: false };
    if (pulls >= maxPulls || page >= MAX_LIST_PAGES) return { items, morePages: true };
  }
}

function parseState(body: string | undefined): GithubReviewsState | undefined {
  if (body === undefined) return undefined;
  const state = JSON.parse(body) as Partial<GithubReviewsState> | null;
  if (state?.schema !== GITHUB_REVIEWS_STATE_SCHEMA || typeof state.updatedAt !== "string" || typeof state.coverageFrom !== "string" ||
      Number.isNaN(Date.parse(state.updatedAt)) || Number.isNaN(Date.parse(state.coverageFrom))) {
    throw new SourceError("schema", "The stored review cursor is malformed");
  }
  return state as GithubReviewsState;
}

async function runProject(deps: GithubReviewsDeps, project: GithubReviewsProject, startedMs: number): Promise<ProjectRun> {
  const rest = newCounter();
  const graphql = newCounter();
  const maxPulls = deps.maxPullsPerRun ?? MAX_PULLS_PER_RUN;
  let since = iso(startedMs - (deps.firstRunLookbackMs ?? FIRST_RUN_LOOKBACK_MS));
  const run = {
    cursor: null as string | null, coverageFrom: null as string | null, listed: 0, pulls: 0, truncated: false, reviews: 0, botReviews: 0, selfReviews: 0,
    added: 0, changed: 0, dismissed: 0, droppedPulls: 0, reviewsTruncated: 0, monthsRead: 0, monthsWritten: 0, graphqlCost: 0,
  };
  const done = (extra: { readonly ok: boolean; readonly failureKind?: string; readonly error?: string }): ProjectRun => ({
    ...extra, since, ...run, restRequests: rest.requests, graphqlRequests: graphql.requests, bytes: rest.bytes + graphql.bytes, durationMs: deps.now() - startedMs,
  });
  try {
    const stateKey = githubReviewsStateKey(project.projectId);
    const state = parseState((await deps.bucket.get(stateKey))?.body);
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
    const byMonth = new Map<string, ReviewRow[]>();
    for (let index = 0; index < selected.numbers.length; index += PULLS_PER_BATCH) {
      const numbers = selected.numbers.slice(index, index + PULLS_PER_BATCH);
      const body = await graphqlPage(
        { token: deps.githubToken, fetchImpl: deps.githubFetch, delay: deps.delay, counter: graphql, query: pullReviewsQuery(numbers) },
        { owner: project.owner, repo: project.repo },
      );
      const page = parsePullReviews(body, numbers);
      if (!page.ok) throw new SourceError("schema", page.error);
      run.graphqlCost += page.cost;
      run.droppedPulls += page.dropped.length;
      for (const pull of page.pulls) {
        const result = reviewRows(pull, { from, machineUsers: project.machineUsers });
        if (result.truncated) run.reviewsTruncated += 1;
        for (const row of result.rows) {
          run.reviews += 1;
          if (row.isBot) run.botReviews += 1;
          else if (row.reviewer === row.prAuthor) run.selfReviews += 1;
          const month = reviewMonth(row.submittedAt);
          byMonth.set(month, [...(byMonth.get(month) ?? []), row]);
        }
      }
    }

    // Oldest month first; a run that dies here leaves the cursor where it was, and the next run
    // reads the same reviews into the same rows.
    for (const month of [...byMonth.keys()].sort()) {
      const key = githubReviewsMonthKey(project.projectId, month);
      const stored = await deps.bucket.get(key);
      run.monthsRead += 1;
      const merged = mergeReviewRows(stored === undefined ? [] : parseReviewMonth(JSON.parse(stored.body), project.projectId, month), byMonth.get(month)!);
      run.added += merged.added;
      run.changed += merged.changed;
      run.dismissed += merged.dismissed;
      const body = encodeReviewMonth(project.projectId, month, merged.rows);
      if (deps.dryRun === true || body === stored?.body) continue;
      if (!await deps.bucket.putIfMatch(key, body, stored?.etag ?? null)) throw new MonthConflictError(`Review month ${month} changed during the run`);
      run.monthsWritten += 1;
    }

    const next: GithubReviewsState = { schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: selected.cursor, coverageFrom };
    if (deps.dryRun !== true && (state?.updatedAt !== next.updatedAt || state.coverageFrom !== next.coverageFrom)) {
      await deps.bucket.put(stateKey, JSON.stringify(next));
    }
    run.cursor = selected.cursor;
    return done({ ok: true });
  } catch (error) {
    const failureKind = error instanceof SourceError ? error.failureKind : error instanceof MonthConflictError ? "conflict" : "internal";
    return done({ ok: false, failureKind, error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) });
  }
}

/**
 * One run over every project. A project that fails keeps its cursor and its rows and does not stop
 * the others. The run record is written unless the run is dry; this function does not throw.
 */
export async function runGithubReviews(deps: GithubReviewsDeps): Promise<GithubReviewsLastRun> {
  const startedMs = deps.now();
  const projects: Record<string, ProjectRun> = {};
  let failure: Pick<GithubReviewsLastRun, "failureKind" | "error"> = {};
  try {
    if (!resolveGithubReviews(deps.flag)) throw new Error("GITHUB_REVIEWS is not set");
    if (deps.githubToken.trim() === "") throw new Error("GITHUB_SOURCE_TOKEN is not configured");
  } catch (error) {
    failure = { failureKind: "config", error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) };
  }
  if (failure.failureKind === undefined) {
    for (const project of deps.projects) projects[project.projectId] = await runProject(deps, project, deps.now());
    if (Object.values(projects).some((project) => !project.ok)) failure = { failureKind: "source" };
  }
  const completedMs = deps.now();
  const lastRun: GithubReviewsLastRun = {
    ok: failure.failureKind === undefined,
    revision: GITHUB_REVIEWS_REVISION,
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
