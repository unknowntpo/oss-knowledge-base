/** Spec 015 Behavior 12–13: vote lines, the tally (`tallyVote`), and the vote state. */
import type { VoteRule } from "./governance";
import { matchesRosterName, type Roster } from "./roster";
import type { ThreadStats } from "./threads";

/** Bump when the line rules change: cached vote lines are then refetched (Q27). */
export const VOTE_REGEX_VERSION = 1;

const STOP = /^\s*-{2,}\s*Original Message|^\s*From:\s/iu;
const VOTE_LINE =
  /^\s*(?<vote>[+-]1)(?=$|[\s(,.!])\s*(?<binding>\(\s*(?:non[-\s]?)?bin?ding\s*\)|(?:non[-\s]?)?bin?ding\b)?\s*(?<rest>.*)$/iu;
const VOTE_REST = /^(?:$|[.!,;)]|from me\b|thanks?\b|lgtm\b)/iu;

export type VoteValue = "+1" | "-1";
export type VoteMarker = "binding" | "non-binding" | null;

export interface VoteLines {
  readonly votes: readonly { readonly vote: VoteValue; readonly marker: VoteMarker; readonly line: string }[];
  readonly unclear: readonly { readonly line: string; readonly minus: boolean }[];
}

/**
 * Behavior 12: a vote line starts with +1 or -1, so `>` quoted lines never match; reading stops at
 * an Outlook-style quoted message.
 */
export function parseVoteLines(body: string): VoteLines {
  const votes: { vote: VoteValue; marker: VoteMarker; line: string }[] = [];
  const unclear: { line: string; minus: boolean }[] = [];
  for (const line of body.split(/\r?\n/u)) {
    if (STOP.test(line)) break;
    const match = VOTE_LINE.exec(line);
    if (match === null) continue;
    const vote = match.groups!.vote as VoteValue;
    if (!VOTE_REST.test(match.groups!.rest ?? "")) {
      unclear.push({ line: line.trim(), minus: vote === "-1" });
      continue;
    }
    const binding = match.groups!.binding;
    const marker: VoteMarker = binding === undefined ? null : /non/iu.test(binding) ? "non-binding" : "binding";
    votes.push({ vote, marker, line: line.trim() });
  }
  return { votes, unclear };
}

/** How a voter's latest vote counts: declared, via the roster role, unmarked, or unknown (no roster). */
export type Standing = "declared" | "declared-non-binding" | "roster" | "unmarked" | "unknown";

export type VoteState = "short" | "contested" | "unclear" | "unresolved" | "pending-close" | "passing";

export interface Tally {
  readonly voters: readonly { readonly author: string; readonly vote: VoteValue; readonly standing: Standing }[];
  readonly plus: number;
  readonly plusBinding: number;
  readonly plusBindingViaRoster: number;
  readonly minus: number;
  readonly minusBinding: number;
  /** Unmarked -1s not matched as binding (or of unknown standing without a roster). */
  readonly minusUnmarked: number;
  /** Unmarked +1s not matched as binding: not in the roster, or in it without the vote kind's role. */
  readonly unmarked: number;
  readonly unclear: number;
  readonly unclearMinus: number;
  readonly unread: number;
  readonly rootArchived: boolean;
  readonly rosterRead: boolean;
  readonly openedAt: string;
  /** A plain count: every body, the root, and the roster were read (Behavior 13). */
  readonly complete: boolean;
  readonly state: VoteState;
  readonly queued: boolean;
}

const HOUR_MS = 3_600_000;

function standing(marker: VoteMarker, author: string, rule: VoteRule, roster: Roster | null): Standing {
  if (marker === "binding") return "declared";
  if (marker === "non-binding") return "declared-non-binding";
  if (roster === null) return "unknown";
  return matchesRosterName(roster, author, rule.bindingRole) ? "roster" : "unmarked";
}

/** Behavior 13: one vote per voter (latest wins) and the lazy-majority state. */
export function tallyVote(thread: ThreadStats, rule: VoteRule, roster: Roster | null, now: string): Tally {
  const latest = new Map<string, { vote: VoteValue; marker: VoteMarker }>();
  let unread = 0;
  let unclear = 0;
  let unclearMinus = 0;
  for (const message of thread.members) {
    if (message.body === null) {
      unread += 1;
      continue;
    }
    const lines = parseVoteLines(message.body);
    unclear += lines.unclear.length;
    unclearMinus += lines.unclear.filter((line) => line.minus).length;
    const last = lines.votes.at(-1);
    if (last !== undefined) latest.set(message.author, { vote: last.vote, marker: last.marker });
  }
  const voters = [...latest].map(([author, value]) => ({ author, vote: value.vote, standing: standing(value.marker, author, rule, roster) }));
  const binding = (value: Standing) => value === "declared" || value === "roster";
  const plusVoters = voters.filter((voter) => voter.vote === "+1");
  const plusBinding = plusVoters.filter((voter) => binding(voter.standing)).length;
  const minusVoters = voters.filter((voter) => voter.vote === "-1");
  const minusBinding = minusVoters.filter((voter) => binding(voter.standing)).length;
  const minusUnmarked = minusVoters.filter((voter) => voter.standing === "unmarked" || voter.standing === "unknown").length;
  const complete = unread === 0 && thread.rootArchived && roster !== null;
  const openHours = (Date.parse(now) - Date.parse(thread.openedAt)) / HOUR_MS;
  // A "seen" tally holds lower bounds, so it never asserts contested, pending-close, or passing.
  let state: VoteState;
  if (plusBinding < rule.quorum) state = "short";
  else if (!complete) state = "unresolved";
  else if (plusBinding <= minusBinding) state = "contested";
  else if (unclearMinus > 0) state = "unclear";
  else if (openHours < rule.minOpenHours) state = "pending-close";
  else state = "passing";
  return {
    voters, plus: plusVoters.length, plusBinding,
    plusBindingViaRoster: plusVoters.filter((voter) => voter.standing === "roster").length,
    minus: minusVoters.length, minusBinding, minusUnmarked, unmarked: plusVoters.filter((voter) => voter.standing === "unmarked").length,
    unclear, unclearMinus, unread, rootArchived: thread.rootArchived, rosterRead: roster !== null,
    openedAt: thread.openedAt, complete, state,
    queued: state === "short" || state === "contested" || state === "unclear" || state === "unresolved",
  };
}

/** Behavior 13 wording (English; the web app renders the same parts through i18n keys). */
export function tallyText(tally: Tally, quorum: number): string {
  const ge = tally.complete ? "" : "≥ ";
  const parts = [
    `${tally.complete ? "" : "seen "}+1 × ${tally.plus} · binding ${ge}${tally.plusBinding} of ${quorum}${tally.plusBindingViaRoster > 0 ? ` (${tally.plusBindingViaRoster} via roster)` : ""}`,
    ...(tally.minusBinding > 0 ? [`binding -1 × ${ge}${tally.minusBinding}`] : []),
    ...(tally.minusUnmarked > 0 ? [`${tally.minusUnmarked} unmarked -1`] : []),
    ...(tally.unmarked > 0 ? [`${tally.unmarked} unmarked`] : []),
    ...(tally.unclear > 0 ? [`${tally.unclear} unclear`] : []),
  ].join(" · ");
  if (tally.complete) return parts;
  const reasons = [
    ...(tally.unread > 0 ? [`${tally.unread} message${tally.unread === 1 ? "" : "s"} unread`] : []),
    ...(tally.rootArchived ? [] : ["thread start not archived"]),
    ...(tally.rosterRead ? [] : ["roster unavailable"]),
  ];
  return `${parts}; ${reasons.join(", ")}`;
}
