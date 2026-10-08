/** Spec 015 Behavior 1–7: open-PR snapshot pages, the wait clock, buckets, and card labels. */
import { isMachineAuthor } from "../digest/candidates";
import type { ReviewProfile } from "./governance";

export interface GitHubActor {
  readonly login: string;
  readonly __typename: "User" | "Bot" | "Organization" | "Mannequin" | "EnterpriseUserAccount";
}

export interface PrNode {
  readonly number: number;
  readonly title: string;
  readonly isDraft: boolean;
  readonly createdAt: string;
  readonly author: GitHubActor | null;
  readonly reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  readonly reviewRequests: {
    readonly totalCount: number;
    readonly nodes: readonly { readonly requestedReviewer: { readonly __typename: string; readonly login?: string; readonly slug?: string } | null }[];
  };
  readonly latestReviews: {
    readonly totalCount: number;
    readonly nodes: readonly { readonly author: GitHubActor | null; readonly state: string; readonly submittedAt: string | null }[];
  };
  readonly timelineItems: {
    readonly nodes: readonly {
      readonly __typename: string;
      readonly createdAt?: string;
      readonly commit?: { readonly committedDate: string };
    }[];
  };
}

/** Behavior 1: the measured query (`samples/github-open-prs.graphql`), with the repository as variables. */
export const OPEN_PRS_QUERY = `query($owner: String!, $repo: String!, $cursor: String, $n: Int!) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: $n, after: $cursor) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title isDraft createdAt
        author { login __typename }
        reviewDecision
        reviewRequests(first: 10) { totalCount nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } } } }
        latestReviews(first: 20) { totalCount nodes { author { login __typename } state submittedAt } }
        timelineItems(last: 1, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, READY_FOR_REVIEW_EVENT, REOPENED_EVENT]) { nodes { __typename ... on PullRequestCommit { commit { committedDate } } ... on HeadRefForcePushedEvent { createdAt } ... on ReadyForReviewEvent { createdAt } ... on ReopenedEvent { createdAt } } }
      }
    }
  }
}`;

export type PrPage =
  | { readonly ok: true; readonly totalCount: number; readonly hasNextPage: boolean; readonly endCursor: string | null; readonly nodes: readonly PrNode[]; readonly droppedNodes: number }
  | { readonly ok: false; readonly failureKind: "schema"; readonly error: string };

function schema(error: string): PrPage {
  return { ok: false, failureKind: "schema", error };
}

/** Behavior 1: node-scoped GraphQL errors drop that node; any other error fails the page. */
export function parsePrPage(body: unknown): PrPage {
  const root = body as { data?: unknown; errors?: unknown } | null;
  const connection = (root?.data as { repository?: { pullRequests?: unknown } } | null | undefined)?.repository?.pullRequests as
    | { totalCount?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown }
    | undefined;
  if (connection === undefined || connection === null) return schema("GraphQL response has no pullRequests");
  if (!Array.isArray(connection.nodes) || typeof connection.totalCount !== "number" || typeof connection.pageInfo?.hasNextPage !== "boolean") {
    return schema("GraphQL pullRequests is malformed");
  }
  const dropped = new Set<number>();
  const errors = root?.errors;
  if (errors !== undefined) {
    if (!Array.isArray(errors)) return schema("GraphQL errors is not a list");
    for (const error of errors as { message?: unknown; path?: unknown }[]) {
      const path = error.path;
      if (Array.isArray(path) && path[0] === "repository" && path[1] === "pullRequests" && path[2] === "nodes" && Number.isInteger(path[3])) {
        dropped.add(path[3] as number);
      } else {
        return schema(`GraphQL error: ${String(error.message)}`);
      }
    }
  }
  const nodes = (connection.nodes as (PrNode | null)[]).filter((node, index): node is PrNode => node !== null && !dropped.has(index));
  if (connection.pageInfo.hasNextPage && connection.nodes.length === 0) return schema("GraphQL page is empty but claims a next page");
  const endCursor = typeof connection.pageInfo.endCursor === "string" ? connection.pageInfo.endCursor : null;
  return { ok: true, totalCount: connection.totalCount, hasNextPage: connection.pageInfo.hasNextPage, endCursor, nodes, droppedNodes: dropped.size };
}

/** Behavior 1: the union of all pages, first occurrence of each PR number kept. */
export function mergePrPages(pages: readonly Extract<PrPage, { ok: true }>[]): { readonly nodes: readonly PrNode[]; readonly droppedNodes: number } {
  const seen = new Set<number>();
  const nodes: PrNode[] = [];
  for (const page of pages) {
    for (const node of page.nodes) {
      if (seen.has(node.number)) continue;
      seen.add(node.number);
      nodes.push(node);
    }
  }
  return { nodes, droppedNodes: pages.reduce((sum, page) => sum + page.droppedNodes, 0) };
}

export const DAY_MS = 86_400_000;

export type PrBucket = "approved" | "noReviewer" | "waiting";
export type NotQueuedReason = "draft" | "machine-author" | "recent-no-reviewer" | "recent-review-wait" | "author-turn";

export interface PrState {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly draft: boolean;
  readonly machineAuthor: boolean;
  readonly reviewers: number;
  /** A reviewer list was truncated, so `reviewers` is a lower bound (Q47). */
  readonly reviewersAtLeast: boolean;
  readonly authorUpdatedAt: string;
  readonly lastReviewAt: string | null;
  readonly waitingSince: string;
  readonly waitDays: number;
  readonly bucket: PrBucket | null;
  readonly reason: NotQueuedReason | null;
}

/** Behavior 2: GitHub's `Bot` type, or Spec 014's `isMachineAuthor` (`[bot]` suffix, profile list). */
export function isMachineActor(actor: { readonly login?: string; readonly __typename: string }, profile: ReviewProfile): boolean {
  return actor.__typename === "Bot" || isMachineAuthor(actor.login ?? "", profile);
}

function later(a: string, b: string | null | undefined): string {
  return b !== null && b !== undefined && Date.parse(b) > Date.parse(a) ? b : a;
}

/** Behavior 3–5. */
export function classifyPr(node: PrNode, now: string, profile: ReviewProfile): PrState {
  const author = node.author?.login ?? "ghost";
  const machineAuthor = node.author !== null && isMachineActor(node.author, profile);
  const reviewers = new Set<string>();
  for (const { requestedReviewer } of node.reviewRequests.nodes) {
    if (requestedReviewer === null || isMachineActor(requestedReviewer, profile)) continue;
    reviewers.add(requestedReviewer.__typename === "Team" ? `team:${requestedReviewer.slug}` : `user:${requestedReviewer.login}`);
  }
  let lastReviewAt: string | null = null;
  for (const review of node.latestReviews.nodes) {
    if (review.author === null || isMachineActor(review.author, profile) || review.author.login === author) continue;
    reviewers.add(`user:${review.author.login}`);
    if (review.submittedAt !== null) lastReviewAt = lastReviewAt === null ? review.submittedAt : later(lastReviewAt, review.submittedAt);
  }
  const reviewersAtLeast = node.reviewRequests.totalCount > node.reviewRequests.nodes.length ||
    node.latestReviews.totalCount > node.latestReviews.nodes.length;
  const item = node.timelineItems.nodes.at(-1);
  const authorUpdatedAt = later(node.createdAt, item?.commit?.committedDate ?? item?.createdAt);
  const waitingSince = later(authorUpdatedAt, lastReviewAt);
  const waitMs = Date.parse(now) - Date.parse(waitingSince);
  const overdue = waitMs > profile.reviewWaitDays * DAY_MS;
  const authorSpokeLast = lastReviewAt === null || Date.parse(authorUpdatedAt) > Date.parse(lastReviewAt);
  let bucket: PrBucket | null = null;
  let reason: NotQueuedReason | null = null;
  if (node.isDraft) reason = "draft";
  else if (machineAuthor) reason = "machine-author";
  else if (node.reviewDecision === "APPROVED") bucket = "approved";
  else if (reviewers.size === 0 && !reviewersAtLeast) {
    if (overdue) bucket = "noReviewer";
    else reason = "recent-no-reviewer";
  } else if (!authorSpokeLast) reason = "author-turn";
  else if (overdue) bucket = "waiting";
  else reason = "recent-review-wait";
  return {
    number: node.number, title: node.title, author, draft: node.isDraft, machineAuthor,
    reviewers: reviewers.size, reviewersAtLeast, authorUpdatedAt, lastReviewAt, waitingSince,
    waitDays: Math.floor(waitMs / DAY_MS), bucket, reason,
  };
}

export interface PrRow {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly reviewers: number;
  readonly reviewersAtLeast: boolean;
  readonly waitingSince: string;
  readonly waitDays: number;
}

export interface PrReviewState {
  readonly reviewers: number;
  readonly reviewersAtLeast: boolean;
}

export interface PrQueue {
  readonly noReviewer: readonly PrRow[];
  readonly waiting: readonly PrRow[];
  readonly approved: readonly PrRow[];
  /** Behavior 7: every open non-draft PR's reviewer count, for topic-page labels. */
  readonly reviewState: Readonly<Record<number, PrReviewState>>;
}

export function prUrl(profile: ReviewProfile, number: number): string {
  return `https://github.com/${profile.github.owner}/${profile.github.repo}/pull/${number}`;
}

/** Behavior 6: longest wait (whole days) first, then the lower number. */
export function byWait(a: { readonly waitDays: number; readonly order: number }, b: { readonly waitDays: number; readonly order: number }): number {
  return b.waitDays - a.waitDays || a.order - b.order;
}

export function buildPrQueue(nodes: readonly PrNode[], now: string, profile: ReviewProfile): PrQueue {
  const rows: Record<PrBucket, (PrRow & { order: number })[]> = { noReviewer: [], waiting: [], approved: [] };
  const reviewState: Record<number, PrReviewState> = {};
  for (const node of nodes) {
    const value = classifyPr(node, now, profile);
    if (!value.draft) reviewState[value.number] = { reviewers: value.reviewers, reviewersAtLeast: value.reviewersAtLeast };
    if (value.bucket === null) continue;
    rows[value.bucket].push({
      number: value.number, title: value.title, url: prUrl(profile, value.number), author: value.author,
      reviewers: value.reviewers, reviewersAtLeast: value.reviewersAtLeast, waitingSince: value.waitingSince,
      waitDays: value.waitDays, order: value.number,
    });
  }
  const sorted = (list: (PrRow & { order: number })[]): PrRow[] => list.sort(byWait).map(({ order: _order, ...row }) => row);
  return { noReviewer: sorted(rows.noReviewer), waiting: sorted(rows.waiting), approved: sorted(rows.approved), reviewState };
}

/** Behavior 7: the topic-page label; drafts and PRs outside the snapshot have none. */
export function prCardLabel(state: PrReviewState | undefined): string | null {
  if (state === undefined) return null;
  if (state.reviewers === 0 && !state.reviewersAtLeast) return "Awaiting reviewer";
  return `In review · ${state.reviewersAtLeast ? "≥ " : ""}${state.reviewers} reviewer${state.reviewers === 1 && !state.reviewersAtLeast ? "" : "s"}`;
}
