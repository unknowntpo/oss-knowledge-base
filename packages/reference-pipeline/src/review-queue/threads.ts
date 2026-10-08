/** Spec 015 Behavior 8–10: KIP candidates from the Feed, Pony Mail threads, and repliers. */
import { mailAuthor, threadKey } from "../kafka-rules";
import type { ReviewProfile } from "./governance";

/** A Feed index entry reduced to what candidate selection reads. */
export interface FeedMailEntry {
  readonly displayId: string;
  readonly title: string;
  readonly lastActivityAt: string;
}

export interface ThreadMessage {
  readonly mid: string;
  /** `mailAuthor(from)`. */
  readonly author: string;
  readonly at: string;
  readonly subject: string;
  /** Full body for vote threads (Behavior 11); null when not read. */
  readonly body: string | null;
}

export type KipStage = "vote" | "discuss";

export interface KipCandidate {
  readonly key: string;
  readonly stage: KipStage;
  readonly displayId: string;
  readonly title: string;
}

function hasTag(title: string, tag: string): boolean {
  return title.toLowerCase().includes(`[${tag.toLowerCase()}]`);
}

function isMail(entry: FeedMailEntry, profile: ReviewProfile): boolean {
  return entry.displayId.startsWith(`${profile.projectKey.toUpperCase()}-MAIL-`);
}

function proposalKeys(title: string, profile: ReviewProfile): string[] {
  return [...new Set(title.match(new RegExp(profile.proposal.keyPattern, "gu")) ?? [])];
}

/**
 * Behavior 8: one row per proposal key with a tagged dev@ thread. A vote supersedes discuss; a
 * `[RESULT]` thread removes the key. The newest thread of a stage is used.
 */
export function kipCandidates(entries: readonly FeedMailEntry[], profile: ReviewProfile): {
  readonly candidates: readonly KipCandidate[];
  readonly tagged: { readonly vote: number; readonly discuss: number; readonly result: number };
} {
  const empty = { candidates: [], tagged: { vote: 0, discuss: 0, result: 0 } };
  if (profile.proposal.kind === null || profile.mail === null) return empty;
  const { vote, discuss, result } = profile.tags;
  const byKey = new Map<string, { vote?: FeedMailEntry; discuss?: FeedMailEntry; result: boolean }>();
  const tagged = { vote: 0, discuss: 0, result: 0 };
  const newer = (current: FeedMailEntry | undefined, entry: FeedMailEntry) =>
    current === undefined || entry.lastActivityAt > current.lastActivityAt ? entry : current;
  for (const entry of entries) {
    if (!isMail(entry, profile)) continue;
    const keys = proposalKeys(entry.title, profile);
    if (keys.length === 0) continue;
    const stage = hasTag(entry.title, result) ? "result" : hasTag(entry.title, vote) ? "vote" : hasTag(entry.title, discuss) ? "discuss" : null;
    if (stage === null) continue;
    tagged[stage] += 1;
    for (const key of keys) {
      const slot = byKey.get(key) ?? { result: false };
      if (stage === "result") slot.result = true;
      else slot[stage] = newer(slot[stage], entry);
      byKey.set(key, slot);
    }
  }
  const candidates: KipCandidate[] = [];
  for (const [key, slot] of byKey) {
    if (slot.result) continue;
    const entry = slot.vote ?? slot.discuss;
    if (entry === undefined) continue;
    candidates.push({ key, stage: slot.vote === undefined ? "discuss" : "vote", displayId: entry.displayId, title: entry.title });
  }
  candidates.sort((a, b) => proposalNumber(a.key) - proposalNumber(b.key));
  return { candidates, tagged };
}

export function proposalNumber(key: string): number {
  return Number(key.match(/\d+/u)?.[0] ?? Number.NaN);
}

/** Behavior 9: a Pony Mail `thread.lua` response, flattened; anything else is a parse failure (Q28). */
export function parsePonyThread(body: unknown): ThreadMessage[] {
  const root = (typeof body === "object" && body !== null ? (body as { thread?: unknown }).thread : undefined);
  if (typeof root !== "object" || root === null) throw new Error("Pony Mail thread response has no thread");
  const messages: ThreadMessage[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as { mid?: unknown; from?: unknown; subject?: unknown; epoch?: unknown; children?: unknown };
    if (typeof node.mid !== "string" || typeof node.from !== "string" || typeof node.subject !== "string" || typeof node.epoch !== "number") {
      throw new Error("Pony Mail thread node is malformed");
    }
    messages.push({ mid: node.mid, author: mailAuthor(node.from), at: new Date(node.epoch * 1000).toISOString(), subject: node.subject, body: null });
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new Error("Pony Mail thread children is not a list");
      stack.push(...node.children);
    }
  }
  return messages;
}

const REPLY = /^\s*(?:re|fwd?|fw|aw)\s*:/iu;

export interface ThreadStats {
  readonly members: readonly ThreadMessage[];
  /** The oldest member without a reply prefix; null when the thread start is not archived. */
  readonly root: ThreadMessage | null;
  readonly rootArchived: boolean;
  /** Root time, else the oldest member's time. */
  readonly openedAt: string;
  /** Distinct authors other than the root's; a lower bound when the root is not archived. */
  readonly repliers: number;
  readonly lastReplyAt: string | null;
}

/**
 * Behavior 9–10. Members share the candidate's thread key (the oldest message's subject when no
 * subject is given), ordered by time then message id.
 */
export function threadStats(messages: readonly ThreadMessage[], subject?: string, machineUsers: readonly string[] = []): ThreadStats {
  const ordered = [...messages].sort((a, b) => a.at.localeCompare(b.at) || a.mid.localeCompare(b.mid));
  if (ordered.length === 0) throw new Error("A thread needs at least one message");
  const key = threadKey(subject ?? ordered[0]!.subject);
  const members = ordered.filter((message) => threadKey(message.subject) === key);
  if (members.length === 0) throw new Error(`No message has the thread key ${key}`);
  const root = members.find((message) => !REPLY.test(message.subject)) ?? null;
  const replies = members.filter((message) => message !== root);
  const repliers = new Set(replies.map((message) => message.author)
    .filter((author) => author !== root?.author && !machineUsers.includes(author)));
  return {
    members, root, rootArchived: root !== null, openedAt: (root ?? members[0]!).at,
    repliers: repliers.size, lastReplyAt: replies.at(-1)?.at ?? null,
  };
}

export function threadUrl(rootMid: string): string {
  return `https://lists.apache.org/thread/${rootMid}`;
}

export function feedLink(displayId: string): string {
  return `/#/feed/${displayId}`;
}
