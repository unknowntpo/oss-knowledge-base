/**
 * Spec 022 amendment (areas), Behavior 15: the manual refresh that gives month objects written
 * before `metadata@2` their pull-request metadata and display names. It lists nothing: the pull
 * requests to read are the ones in the stored rows without a `pulls` entry, so it needs no
 * progress object. Each call reads at most `MAX_PULLS_PER_RUN` pull requests per project, oldest
 * month first, and writes each month it filled with a conditional write. Calls repeat until every
 * month of the store is complete (`done`). Rows are never changed by a refresh.
 */
import {
  encodeReviewMonth,
  GITHUB_REVIEWS_AREAS_REVISION,
  mergeMonthExtras,
  parseReviewMonthObject,
  pullAreaMeta,
  pullDisplayNames,
  type PullAreaMeta,
} from "@oss-knowledge-base/reference-pipeline";
import { newCounter, SourceError } from "../review-queue/fetchers";
import { errorText, sanitizeErrorMessage } from "../search-embedding/sanitize";
import {
  MAX_PULLS_PER_RUN,
  MonthConflictError,
  parseState,
  PULLS_PER_BATCH,
  readBatch,
  resolveRunConfig,
  type GithubReviewsDeps,
  type GithubReviewsLastRun,
  type GithubReviewsProject,
} from "./run";
import { GITHUB_REVIEWS_REFRESH_LAST_RUN_KEY, githubReviewsMonthKey, githubReviewsStateKey } from "./store";

export interface RefreshProjectRun {
  readonly ok: boolean;
  /** Months of the store, from `coverageFrom`'s month to the cursor's. */
  readonly months: number;
  /** Months that had every pull request's metadata before this call. */
  readonly monthsComplete: number;
  readonly monthsRead: number;
  readonly monthsWritten: number;
  /** Distinct pull requests of the stored rows without metadata when the call started. */
  readonly pullsMissing: number;
  readonly pullsRead: number;
  readonly droppedPulls: number;
  readonly labelsTruncated: number;
  readonly graphqlRequests: number;
  readonly graphqlCost: number;
  readonly bytes: number;
  readonly durationMs: number;
  /** Every month of the store has metadata for every pull request of its rows. */
  readonly done: boolean;
  readonly failureKind?: string;
  readonly error?: string;
}

export interface GithubReviewsRefreshLastRun extends Omit<GithubReviewsLastRun, "projects"> {
  readonly projects: Readonly<Record<string, RefreshProjectRun>>;
}

/** The store's months, oldest first: from the month of `coverageFrom` to the month of the cursor. */
export function storeMonths(coverageFrom: string, until: string): readonly string[] {
  const months: string[] = [];
  const end = until.slice(0, 7);
  for (let at = new Date(`${coverageFrom.slice(0, 7)}-01T00:00:00Z`); ; at = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))) {
    const month = at.toISOString().slice(0, 7);
    if (month > end) return months;
    months.push(month);
  }
}

class RefreshConfigError extends Error {}

async function refreshProject(deps: GithubReviewsDeps, project: GithubReviewsProject, startedMs: number): Promise<RefreshProjectRun> {
  const graphql = newCounter();
  const cap = deps.maxPullsPerRun ?? MAX_PULLS_PER_RUN;
  const run = {
    months: 0, monthsComplete: 0, monthsRead: 0, monthsWritten: 0, pullsMissing: 0, pullsRead: 0, droppedPulls: 0, labelsTruncated: 0, graphqlCost: 0, done: false,
  };
  const finish = (extra: { readonly ok: boolean; readonly failureKind?: string; readonly error?: string }): RefreshProjectRun => ({
    ...extra, ...run, graphqlRequests: graphql.requests, bytes: graphql.bytes, durationMs: deps.now() - startedMs,
  });
  try {
    const state = parseState((await deps.bucket.get(githubReviewsStateKey(project.projectId)))?.body);
    if (state === undefined) throw new RefreshConfigError("No daily cursor yet: there is nothing stored to refresh");
    const months = storeMonths(state.coverageFrom, state.updatedAt);
    run.months = months.length;
    // Pass 1: every month's missing pull requests, oldest month first. The parsed months lacking
    // entries are held until pass 3: about 0.3 MB of JSON each, about 15 to 20 MB parsed for 13 (estimate).
    const pending: { readonly month: string; readonly key: string; readonly stored: { readonly body: string; readonly etag: string }; readonly object: ReturnType<typeof parseReviewMonthObject>; readonly missing: readonly number[] }[] = [];
    for (const month of months) {
      const key = githubReviewsMonthKey(project.projectId, month);
      const stored = await deps.bucket.get(key);
      run.monthsRead += 1;
      if (stored === undefined) {
        run.monthsComplete += 1;
        continue;
      }
      const object = parseReviewMonthObject(JSON.parse(stored.body), project.projectId, month);
      const missing = [...new Set(object.rows.map((row) => row.pr))].filter((pr) => object.pulls?.[String(pr)] === undefined).sort((a, b) => a - b);
      if (missing.length === 0) run.monthsComplete += 1;
      else pending.push({ month, key, stored, object, missing });
    }
    // Pass 2: at most the cap, oldest month first, in full batches of 25 across months.
    const toRead = [...new Set(pending.flatMap((entry) => entry.missing))].slice(0, cap);
    run.pullsMissing = new Set(pending.flatMap((entry) => entry.missing)).size;
    const read = new Map<number, { readonly meta: PullAreaMeta; readonly names: ReadonlyMap<string, string | null> }>();
    for (let index = 0; index < toRead.length; index += PULLS_PER_BATCH) {
      const batch = toRead.slice(index, index + PULLS_PER_BATCH);
      const page = await readBatch(deps, project, graphql, batch, true, run);
      for (const pull of page.pulls) {
        read.set(pull.number, { meta: pullAreaMeta(pull), names: pullDisplayNames(pull) });
        if ((pull.labels?.totalCount ?? 0) > (pull.labels?.nodes.length ?? 0)) run.labelsTruncated += 1;
      }
      // A number GitHub no longer resolves (deleted or transferred) is stored without labels, so the refresh ends.
      for (const pr of page.dropped) read.set(pr, { meta: { labels: [] }, names: new Map() });
      run.pullsRead += batch.length;
    }
    // Pass 3: each month that gained metadata, oldest first, with a conditional write.
    let incomplete = 0;
    for (const { month, key, stored, object, missing } of pending) {
      const filled = missing.filter((pr) => read.has(pr));
      if (filled.length < missing.length) incomplete += 1;
      if (filled.length === 0) continue;
      const pulls = new Map(filled.map((pr) => [pr, read.get(pr)!.meta]));
      // RV38: names of the logins in this month's rows on the pull requests filled now.
      const names = new Map<string, string | null>();
      for (const row of object.rows) {
        const entry = pulls.has(row.pr) ? read.get(row.pr) : undefined;
        if (entry === undefined) continue;
        for (const login of [row.reviewer, row.prAuthor]) if (entry.names.has(login)) names.set(login, entry.names.get(login)!);
      }
      const body = encodeReviewMonth(project.projectId, month, object.rows, mergeMonthExtras(object, pulls, names));
      if (deps.dryRun === true || body === stored.body) continue;
      if (!await deps.bucket.putIfMatch(key, body, stored.etag)) throw new MonthConflictError(`Review month ${month} changed during the refresh`);
      run.monthsWritten += 1;
    }
    run.done = incomplete === 0;
    return finish({ ok: true });
  } catch (error) {
    const failureKind = error instanceof RefreshConfigError ? "config" : error instanceof SourceError ? error.failureKind : error instanceof MonthConflictError ? "conflict" : "internal";
    return finish({ ok: false, failureKind, error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) });
  }
}

/**
 * Behavior 15: one manual refresh call over every project. Only `metadata@2` refreshes: under
 * `metadata@1` the call is a `config` failure that reads nothing. Its record goes to
 * `refresh-last-run.json` unless the call is dry. This function does not throw.
 */
export async function runGithubReviewsRefresh(deps: GithubReviewsDeps): Promise<GithubReviewsRefreshLastRun> {
  const startedMs = deps.now();
  const projects: Record<string, RefreshProjectRun> = {};
  const { revision, failure: configFailure } = resolveRunConfig(deps);
  let failure: Pick<GithubReviewsLastRun, "failureKind" | "error"> = configFailure;
  if (failure.failureKind === undefined && revision !== GITHUB_REVIEWS_AREAS_REVISION) {
    failure = { failureKind: "config", error: sanitizeErrorMessage(`The refresh needs GITHUB_REVIEWS=${GITHUB_REVIEWS_AREAS_REVISION}`) };
  }
  if (failure.failureKind === undefined) {
    for (const project of deps.projects) projects[project.projectId] = await refreshProject(deps, project, deps.now());
    if (Object.values(projects).some((project) => !project.ok)) failure = { failureKind: "source" };
  }
  const completedMs = deps.now();
  const lastRun: GithubReviewsRefreshLastRun = {
    ok: failure.failureKind === undefined,
    revision: revision ?? "",
    dryRun: deps.dryRun === true,
    startedAt: new Date(startedMs).toISOString(),
    completedAt: new Date(completedMs).toISOString(),
    durationMs: completedMs - startedMs,
    projects,
    ...failure,
  };
  if (deps.dryRun !== true) {
    await deps.bucket.put(GITHUB_REVIEWS_REFRESH_LAST_RUN_KEY, JSON.stringify(lastRun))
      .catch((error: unknown) => console.error(`Recording the review refresh failed: ${errorText(error)}`));
  }
  return lastRun;
}
