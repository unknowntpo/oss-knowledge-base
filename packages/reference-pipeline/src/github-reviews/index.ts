/**
 * Spec 022: GitHub pull-request reviews as metadata rows. Pure rules only: the flag, the batched
 * GraphQL read and its parser, which reviews become rows, how a month object is merged, and the
 * `Reviewers:` trailer comparison. No review text is requested, so none can be stored.
 */

/** The only supported value of the `GITHUB_REVIEWS` flag. */
export const GITHUB_REVIEWS_REVISION = "metadata@1";

/**
 * Behavior 1: unset or blank is off. Any value other than the supported revision is an error, so a
 * typo can neither switch the job on in a shape nobody chose nor leave it silently off.
 */
export function resolveGithubReviews(value: string | undefined): boolean {
  const flag = value?.trim() ?? "";
  if (flag === "") return false;
  if (flag !== GITHUB_REVIEWS_REVISION) throw new Error(`GITHUB_REVIEWS "${value}" is not supported (${GITHUB_REVIEWS_REVISION}, or unset)`);
  return true;
}

export const REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export interface ReviewActor {
  readonly login: string;
  readonly __typename: string;
}

export interface ReviewNode {
  readonly databaseId: number | null;
  readonly author: ReviewActor | null;
  readonly state: string;
  readonly submittedAt: string | null;
  readonly commit: { readonly oid: string } | null;
  readonly comments: { readonly totalCount: number };
}

export interface PullReviews {
  readonly number: number;
  readonly author: ReviewActor | null;
  readonly reviews: { readonly totalCount: number; readonly nodes: readonly ReviewNode[] };
}

/** Reviews read per pull request: the newest ones, because a run looks for what was just submitted. */
export const REVIEWS_PER_PULL = 100;

const PULL_FIELDS = `number author { login __typename } reviews(last: ${REVIEWS_PER_PULL}) { totalCount nodes { databaseId author { login __typename } state submittedAt commit { oid } comments { totalCount } } }`;

/**
 * Behavior 4: one request for a batch of pull requests, each under the alias `p<number>`. The
 * fields are fixed here; a review's or a comment's text is not among them.
 */
export function pullReviewsQuery(numbers: readonly number[]): string {
  if (numbers.length === 0) throw new Error("A review batch needs at least one pull request");
  for (const number of numbers) if (!Number.isInteger(number) || number <= 0) throw new Error(`Invalid pull request number ${number}`);
  const pulls = numbers.map((number) => `p${number}: pullRequest(number: ${number}) { ${PULL_FIELDS} }`).join("\n    ");
  return `query($owner: String!, $repo: String!) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $repo) {
    ${pulls}
  }
}`;
}

export type PullReviewsPage =
  | { readonly ok: true; readonly pulls: readonly PullReviews[]; readonly dropped: readonly number[]; readonly cost: number }
  | { readonly ok: false; readonly error: string };

function isActor(value: unknown): value is ReviewActor | null {
  if (value === null) return true;
  const actor = value as Partial<ReviewActor> | undefined;
  return typeof actor?.login === "string" && typeof actor.__typename === "string";
}

function isReviewNode(value: unknown): value is ReviewNode {
  const node = value as Partial<ReviewNode> | null | undefined;
  return node !== null && node !== undefined &&
    (node.databaseId === null || Number.isInteger(node.databaseId)) && isActor(node.author) &&
    typeof node.state === "string" && (node.submittedAt === null || typeof node.submittedAt === "string") &&
    (node.commit === null || typeof node.commit?.oid === "string") && Number.isInteger(node.comments?.totalCount);
}

/**
 * Behavior 4: an error scoped to one alias (a number that is not a pull request) drops that pull
 * request; any other error, or a malformed node, fails the whole batch.
 */
export function parsePullReviews(body: unknown, numbers: readonly number[]): PullReviewsPage {
  const root = body as { data?: { repository?: unknown; rateLimit?: { cost?: unknown } } | null; errors?: unknown } | null;
  const repository = root?.data?.repository as Readonly<Record<string, unknown>> | null | undefined;
  if (repository === null || repository === undefined || typeof repository !== "object") return { ok: false, error: "GraphQL response has no repository" };
  const dropped = new Set<number>();
  if (root?.errors !== undefined) {
    if (!Array.isArray(root.errors)) return { ok: false, error: "GraphQL errors is not a list" };
    for (const error of root.errors as { message?: unknown; path?: unknown }[]) {
      const alias = Array.isArray(error.path) && error.path.length === 2 && error.path[0] === "repository" ? /^p(\d+)$/u.exec(String(error.path[1])) : null;
      if (alias === null) return { ok: false, error: `GraphQL error: ${String(error.message)}` };
      dropped.add(Number(alias[1]));
    }
  }
  const pulls: PullReviews[] = [];
  for (const number of numbers) {
    const node = repository[`p${number}`] as Partial<PullReviews> | null | undefined;
    if (dropped.has(number)) continue;
    if (node === null || node === undefined) {
      dropped.add(number);
      continue;
    }
    if (node.number !== number || !isActor(node.author) || !Number.isInteger(node.reviews?.totalCount) ||
        !Array.isArray(node.reviews?.nodes) || !node.reviews.nodes.every(isReviewNode)) {
      return { ok: false, error: `GraphQL pull request ${number} is malformed` };
    }
    pulls.push(node as PullReviews);
  }
  const cost = root?.data?.rateLimit?.cost;
  return { ok: true, pulls, dropped: [...dropped].sort((a, b) => a - b), cost: typeof cost === "number" ? cost : 0 };
}

/** One review, as stored. Who, on whose pull request, which verdict, when, on which commit. */
export interface ReviewRow {
  /** GitHub's review id; the row's identity, and the anchor of its link (`#pullrequestreview-<id>`). */
  readonly reviewId: number;
  readonly pr: number;
  /** The pull request's author, so a reply by the author to a review thread is not counted as a review given. */
  readonly prAuthor: string;
  readonly reviewer: string;
  readonly isBot: boolean;
  readonly state: ReviewState;
  /** The verdict seen before the review was dismissed; present only when the dismissal was observed. */
  readonly stateBefore?: Exclude<ReviewState, "DISMISSED">;
  readonly submittedAt: string;
  readonly commit: string | null;
  /** Inline comments submitted with this review. A reply in a review thread is its own review with one. */
  readonly inlineComments: number;
}

/** Stored when GitHub returns no author: the account was deleted. */
export const DELETED_ACCOUNT = "ghost";

/**
 * Behavior 6: GitHub's own `Bot` type first (the Copilot reviewer's GraphQL login has no `[bot]`
 * suffix), then the suffix, then the project's machine users. Never a substring of the login.
 */
export function isReviewBot(actor: ReviewActor | null, machineUsers: readonly string[]): boolean {
  if (actor === null) return false;
  return actor.__typename === "Bot" || actor.login.endsWith("[bot]") || machineUsers.includes(actor.login);
}

const isReviewState = (state: string): state is ReviewState => (REVIEW_STATES as readonly string[]).includes(state);

/**
 * Behavior 5: the rows of one pull request. A review counts when it was submitted (pending reviews
 * have no time), carries an id, is not older than `from` and, when `until` is given, is older than it. `truncated` says the pull request has
 * more reviews than were read and the oldest one read is still inside the window, so older reviews
 * inside the window may be missing.
 */
export function reviewRows(pull: PullReviews, options: { readonly from: string; readonly until?: string; readonly machineUsers: readonly string[] }): {
  readonly rows: readonly ReviewRow[];
  readonly truncated: boolean;
} {
  const rows: ReviewRow[] = [];
  let oldest: string | undefined;
  for (const node of pull.reviews.nodes) {
    if (node.submittedAt === null || node.databaseId === null || !isReviewState(node.state)) continue;
    if (oldest === undefined || node.submittedAt < oldest) oldest = node.submittedAt;
    if (Date.parse(node.submittedAt) < Date.parse(options.from)) continue;
    // Behavior 13: a backfill stores only what the daily run does not own (before its `coverageFrom`).
    if (options.until !== undefined && Date.parse(node.submittedAt) >= Date.parse(options.until)) continue;
    rows.push({
      reviewId: node.databaseId,
      pr: pull.number,
      prAuthor: pull.author?.login ?? DELETED_ACCOUNT,
      reviewer: node.author?.login ?? DELETED_ACCOUNT,
      isBot: isReviewBot(node.author, options.machineUsers),
      state: node.state,
      submittedAt: node.submittedAt,
      commit: node.commit?.oid ?? null,
      inlineComments: node.comments.totalCount,
    });
  }
  const truncated = pull.reviews.totalCount > pull.reviews.nodes.length && oldest !== undefined && Date.parse(oldest) >= Date.parse(options.from);
  return { rows, truncated };
}

/** The UTC month a review belongs to: the month it was submitted in. */
export function reviewMonth(submittedAt: string): string {
  return new Date(submittedAt).toISOString().slice(0, 7);
}

export const REVIEW_MONTH_SCHEMA = "osskb.github-reviews.v1";

/**
 * Behavior 7–10: where review rows and the cursor live (nothing under `public/`). Here, not in the
 * Worker, because the Pages profile reader (Spec 019 slice 2a) reads the same objects.
 */
export const githubReviewsPrefix = (projectId: string) => `internal/github-reviews/v1/${projectId}/`;
export const githubReviewsMonthKey = (projectId: string, month: string) => `${githubReviewsPrefix(projectId)}${month}.json`;
export const githubReviewsStateKey = (projectId: string) => `${githubReviewsPrefix(projectId)}state.json`;
export const GITHUB_REVIEWS_STATE_SCHEMA = "osskb.github-reviews-state.v1";

export interface ReviewMonthObject {
  readonly schema: typeof REVIEW_MONTH_SCHEMA;
  readonly projectId: string;
  readonly month: string;
  readonly rows: readonly ReviewRow[];
}

function rowKey(row: ReviewRow): string {
  return JSON.stringify([row.reviewId, row.pr, row.prAuthor, row.reviewer, row.isBot, row.state, row.stateBefore ?? null, row.submittedAt, row.commit, row.inlineComments]);
}

/**
 * Behavior 7–8: rows are keyed by review id; reading a review again replaces its row, so an
 * overlap or a retried run adds nothing. A review now `DISMISSED` whose stored row had a verdict
 * keeps that verdict as `stateBefore`. Rows are ordered by time, then id, so equal content is
 * equal bytes and an unchanged month is not written again.
 */
export function mergeReviewRows(stored: readonly ReviewRow[], incoming: readonly ReviewRow[]): {
  readonly rows: readonly ReviewRow[];
  readonly added: number;
  readonly changed: number;
  readonly dismissed: number;
} {
  const byId = new Map(stored.map((row) => [row.reviewId, row]));
  let added = 0;
  let changed = 0;
  let dismissed = 0;
  for (const row of incoming) {
    const previous = byId.get(row.reviewId);
    let next = row;
    if (row.state === "DISMISSED" && previous !== undefined) {
      const before = previous.state === "DISMISSED" ? previous.stateBefore : previous.state;
      if (before !== undefined) next = { ...row, stateBefore: before };
    }
    if (previous === undefined) added += 1;
    else if (rowKey(previous) !== rowKey(next)) {
      changed += 1;
      if (next.state === "DISMISSED" && previous.state !== "DISMISSED") dismissed += 1;
    }
    byId.set(row.reviewId, next);
  }
  const rows = [...byId.values()].sort((a, b) => (a.submittedAt === b.submittedAt ? a.reviewId - b.reviewId : a.submittedAt < b.submittedAt ? -1 : 1));
  return { rows, added, changed, dismissed };
}

export function encodeReviewMonth(projectId: string, month: string, rows: readonly ReviewRow[]): string {
  const object: ReviewMonthObject = { schema: REVIEW_MONTH_SCHEMA, projectId, month, rows };
  return JSON.stringify(object);
}

export function parseReviewMonth(value: unknown, projectId: string, month: string): readonly ReviewRow[] {
  const object = value as Partial<ReviewMonthObject> | null | undefined;
  if (object?.schema !== REVIEW_MONTH_SCHEMA || object.projectId !== projectId || object.month !== month || !Array.isArray(object.rows)) {
    throw new Error(`Review month object ${projectId}/${month} is malformed`);
  }
  return object.rows;
}

/** The slice of a repository listing item the job reads (`GET /repos/{o}/{r}/issues`). */
export interface UpdatedItem {
  readonly number: number;
  readonly updated_at: string;
  readonly pull_request?: unknown;
}

/**
 * Behavior 3: the pull requests of an ascending "updated since" listing. Those at or before the
 * stored cursor are the overlap: read again, and not counted against the cap, so a run always
 * moves on to something new. Of the newer ones at most `maxPulls` are kept. The cursor moves to
 * the newest item read and never backwards; when newer pull requests were left out it stops at the
 * last one kept, because the ones after it are unread. `morePages` says the listing itself was cut.
 */
export function selectUpdatedPulls(items: readonly UpdatedItem[], options: { readonly maxPulls: number; readonly morePages: boolean; readonly previousCursor: string }): {
  readonly numbers: readonly number[];
  readonly cursor: string;
  readonly truncated: boolean;
} {
  const pulls = items.filter((item) => item.pull_request !== undefined && item.pull_request !== null);
  const fresh = pulls.filter((item) => item.updated_at > options.previousCursor);
  const cut = fresh.length > options.maxPulls;
  const last = cut ? fresh[options.maxPulls - 1]! : undefined;
  const kept = last === undefined ? pulls : pulls.slice(0, pulls.indexOf(last) + 1);
  const cursor = (cut ? kept : items).reduce((latest, item) => (item.updated_at > latest ? item.updated_at : latest), options.previousCursor);
  return { numbers: [...new Set(kept.map((item) => item.number))], cursor, truncated: cut || options.morePages };
}

/** Behavior 13: the oldest start a backfill may ask for, about 13 months (the store keeps at least that much). */
export const BACKFILL_MAX_LOOKBACK_DAYS = 395;

/**
 * Behavior 13: the `from` of a backfill request: a UTC date (`2026-04-14`) or an ISO time with a
 * zone, in the past, and not before the floor. Anything else is refused before GitHub is called.
 */
export function resolveBackfillFrom(value: string | null | undefined, nowMs: number): { readonly ok: true; readonly from: string } | { readonly ok: false; readonly error: string } {
  const text = value?.trim() ?? "";
  if (text === "") return { ok: false, error: "from is required (an ISO date such as 2026-04-14)" };
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/u.test(text) || Number.isNaN(Date.parse(text))) {
    return { ok: false, error: `from "${text}" is not an ISO date (2026-04-14 or 2026-04-14T00:00:00Z)` };
  }
  const ms = Date.parse(/T/u.test(text) ? text : `${text}T00:00:00Z`);
  if (ms >= nowMs) return { ok: false, error: `from ${new Date(ms).toISOString()} is not in the past` };
  const floor = nowMs - BACKFILL_MAX_LOOKBACK_DAYS * 86_400_000;
  if (ms < floor) return { ok: false, error: `from ${new Date(ms).toISOString()} is before the floor ${new Date(floor).toISOString()} (${BACKFILL_MAX_LOOKBACK_DAYS} days)` };
  return { ok: true, from: new Date(ms).toISOString() };
}

/**
 * Behavior 13: the next request of a keyset listing. Offset pages shift when an item already listed
 * is updated meanwhile (it moves to the end) and the next page would skip one; a backfill lists
 * hundreds of pages, so each page starts again at page 1 from one second before the last item it
 * received (GitHub's `since` has second precision; the repeated second is deduplicated by the
 * caller). Only when a whole page falls inside that second does it move to the next page instead.
 */
export function nextKeysetPage(current: { readonly since: string; readonly page: number }, items: readonly UpdatedItem[]): { readonly since: string; readonly page: number } {
  const last = items.at(-1);
  if (last === undefined) return current;
  const next = Date.parse(last.updated_at) - 1_000;
  return next > Date.parse(current.since) ? { since: new Date(next).toISOString(), page: 1 } : { since: current.since, page: current.page + 1 };
}

/**
 * Behavior 12: the reviewer names of a Kafka squash-merge message (`Reviewers: Name <address>, …`).
 * Addresses, bracketed or bare, are dropped here and never returned.
 */
export function parseReviewersTrailer(message: string): readonly string[] {
  const names: string[] = [];
  for (const line of message.split("\n")) {
    const match = /^\s*Reviewers?:\s*(.+)$/iu.exec(line);
    if (match === null) continue;
    for (const part of match[1]!.split(",")) {
      const name = part.replace(/<[^>]*>/gu, " ").replace(/\S*@\S*/gu, " ").replace(/\s+/gu, " ").trim();
      if (name !== "") names.push(name);
    }
  }
  return names;
}

export interface TrailerPull {
  readonly pr: number;
  readonly trailerNames: readonly string[];
}

export interface TrailerAgreement {
  readonly pulls: number;
  readonly pullsWithTrailer: number;
  readonly trailerNames: number;
  /** Trailer names that are the display name, or the login, of someone with a stored review on that pull request. */
  readonly matched: number;
  readonly unmatched: readonly { readonly pr: number; readonly name: string }[];
  /** Human reviewers with a stored `APPROVED` row who are not named in that pull request's trailer. */
  readonly approversNotInTrailer: readonly { readonly pr: number; readonly reviewer: string }[];
}

const fold = (value: string) => value.normalize("NFC").trim().toLowerCase();

/**
 * Behavior 12: compares stored review rows with the trailers of merged pull requests. A trailer is
 * written by hand by the committer, so the result is a measure of agreement, not a pass or fail.
 */
export function trailerAgreement(pulls: readonly TrailerPull[], rows: readonly ReviewRow[], displayNames: Readonly<Record<string, string | null>>): TrailerAgreement {
  const unmatched: { pr: number; name: string }[] = [];
  const approversNotInTrailer: { pr: number; reviewer: string }[] = [];
  let trailerNames = 0;
  let matched = 0;
  let pullsWithTrailer = 0;
  for (const pull of pulls) {
    if (pull.trailerNames.length === 0) continue;
    pullsWithTrailer += 1;
    const own = rows.filter((row) => row.pr === pull.pr && !row.isBot && row.reviewer !== row.prAuthor);
    const keysOf = (login: string) => [fold(login), ...(typeof displayNames[login] === "string" ? [fold(displayNames[login]!)] : [])];
    const reviewerKeys = new Set(own.flatMap((row) => keysOf(row.reviewer)));
    const named = new Set(pull.trailerNames.map(fold));
    for (const name of pull.trailerNames) {
      trailerNames += 1;
      if (reviewerKeys.has(fold(name))) matched += 1;
      else unmatched.push({ pr: pull.pr, name });
    }
    for (const reviewer of new Set(own.filter((row) => row.state === "APPROVED").map((row) => row.reviewer))) {
      if (!keysOf(reviewer).some((key) => named.has(key))) approversNotInTrailer.push({ pr: pull.pr, reviewer });
    }
  }
  return { pulls: pulls.length, pullsWithTrailer, trailerNames, matched, unmatched, approversNotInTrailer };
}
