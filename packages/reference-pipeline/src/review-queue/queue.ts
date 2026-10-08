/** Spec 015 Behavior 6, 10, 13–15: KIP rows, column summaries, and the one counting function. */
import { voteRule, type ReviewProfile } from "./governance";
import { byWait, DAY_MS, type PrQueue } from "./prs";
import type { Roster } from "./roster";
import { kipCandidates, proposalNumber, threadStats, type FeedMailEntry, type ThreadMessage, type ThreadStats } from "./threads";
import { tallyVote, type Tally } from "./votes";

interface KipRowBase {
  readonly key: string;
  readonly displayId: string;
  readonly title: string;
  /** The root's message id, else the oldest member's (both open the thread on lists.apache.org). */
  readonly rootMid: string;
  readonly stats: ThreadStats;
  /** Days since the last reply, else since the root (Behavior 6). */
  readonly waitDays: number;
  readonly queued: boolean;
}

export interface VoteRow extends KipRowBase { readonly tally: Tally }
export type DiscussRow = KipRowBase;

export interface KipRows {
  readonly vote: readonly VoteRow[];
  readonly discuss: readonly DiscussRow[];
  /** Candidates whose thread could not be read (Behavior 14). */
  readonly unavailable: number;
}

export interface ReviewQueue {
  readonly prs: PrQueue;
  readonly kips: KipRows;
}

/**
 * Behavior 8–13. `threads` holds each candidate's messages by display id; a candidate without
 * an entry is unavailable.
 */
export function buildKipRows(input: {
  readonly entries: readonly FeedMailEntry[];
  readonly threads: ReadonlyMap<string, readonly ThreadMessage[]>;
  readonly roster: Roster | null;
  readonly profile: ReviewProfile;
  readonly now: string;
}): KipRows {
  const rule = voteRule(input.profile, "proposal");
  if (input.profile.proposal.kind !== null && rule === undefined) throw new Error("governance has no proposal vote rule");
  const vote: VoteRow[] = [];
  const discuss: DiscussRow[] = [];
  let unavailable = 0;
  for (const candidate of kipCandidates(input.entries, input.profile).candidates) {
    const messages = input.threads.get(candidate.displayId);
    if (messages === undefined || messages.length === 0) {
      unavailable += 1;
      continue;
    }
    const stats = threadStats(messages, candidate.title, input.profile.machineUsers, candidate.key);
    const since = stats.lastReplyAt ?? stats.openedAt;
    const base = {
      key: candidate.key, displayId: candidate.displayId, title: candidate.title,
      rootMid: (stats.root ?? stats.members[0]!).mid, stats,
      waitDays: Math.floor((Date.parse(input.now) - Date.parse(since)) / DAY_MS),
    };
    if (candidate.stage === "vote") {
      const tally = tallyVote(stats, rule!, input.roster, input.now);
      vote.push({ ...base, tally, queued: tally.queued });
    } else {
      discuss.push({ ...base, queued: stats.repliers < input.profile.fewRepliers });
    }
  }
  const order = <T extends KipRowBase>(rows: T[]) =>
    rows.map((row) => ({ row, waitDays: row.waitDays, order: proposalNumber(row.key) })).sort(byWait).map((item) => item.row);
  return { vote: order(vote), discuss: order(discuss), unavailable };
}

export interface ReviewQueueCounts {
  readonly noReviewer: number;
  readonly waiting: number;
  readonly approved: number;
  readonly prs: number;
  readonly vote: number;
  readonly discuss: number;
  readonly kips: number;
  readonly unavailable: number;
}

/** Behavior 15: the only function that counts. */
export function reviewQueueCounts(queue: ReviewQueue): ReviewQueueCounts {
  const noReviewer = queue.prs.noReviewer.length;
  const waiting = queue.prs.waiting.length;
  const approved = queue.prs.approved.length;
  const vote = queue.kips.vote.filter((row) => row.queued).length;
  const discuss = queue.kips.discuss.filter((row) => row.queued).length;
  return {
    noReviewer, waiting, approved, prs: noReviewer + waiting + approved,
    vote, discuss, kips: vote + discuss, unavailable: queue.kips.unavailable,
  };
}

/** Behavior 15: a queue whose stored counts differ from its arrays is not published. */
export function checkStoredCounts(queue: ReviewQueue, stored: ReviewQueueCounts): boolean {
  const actual = reviewQueueCounts(queue);
  return (Object.keys(actual) as (keyof ReviewQueueCounts)[]).every((key) => actual[key] === stored[key]) &&
    Object.keys(stored).length === Object.keys(actual).length;
}

export interface ColumnRow {
  readonly id: string;
  readonly waitDays: number;
}

/** Behavior 6: totals and the 3 longest waits per column. */
export function columnSummary(queue: ReviewQueue, rows = 3): {
  readonly prs: { readonly total: number; readonly top: readonly ColumnRow[] };
  readonly kips: { readonly total: number; readonly top: readonly ColumnRow[] };
} {
  const counts = reviewQueueCounts(queue);
  const prs = [...queue.prs.noReviewer, ...queue.prs.waiting, ...queue.prs.approved]
    .map((row) => ({ id: `#${row.number}`, waitDays: row.waitDays, order: row.number }));
  const kips = [...queue.kips.vote, ...queue.kips.discuss].filter((row) => row.queued)
    .map((row) => ({ id: row.key, waitDays: row.waitDays, order: proposalNumber(row.key) }));
  const top = (list: { id: string; waitDays: number; order: number }[]) =>
    list.sort(byWait).slice(0, rows).map(({ id, waitDays }) => ({ id, waitDays }));
  return { prs: { total: counts.prs, top: top(prs) }, kips: { total: counts.kips, top: top(kips) } };
}
