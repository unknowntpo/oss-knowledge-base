/**
 * Spec 019 amendment (7), "Started a KIP discussion" (W66): who started the discussion of each KIP
 * within the activity log's coverage. A pure function of the activity months the profile already
 * reads; the identity-link job uses the same function. Browser-safe.
 *
 * 1. A dev@ thread is a KIP discussion when its title (reply prefixes removed) starts with
 *    `[DISCUSS]` or `DISCUSS:` (any case) and names exactly one KIP.
 * 2. Its root is the oldest recorded message of the thread flagged `opens` (no reply prefix). A
 *    thread with no root in the data has no starter; rows written before the flag existed have no
 *    flag and count as no root (W83).
 * 3. For KIP-n, the starter of the thread with the earliest root started the discussion; later
 *    threads with the same number credit nobody.
 */
import { extractKeys } from "../kafka-rules";
import type { ActivityMonthV1 } from "./activity";

export interface KipStarterV1 {
  readonly kip: string;
  /** The starter's dev@ identity (`mail:<name key>`). */
  readonly person: string;
  readonly display: string;
  /** The month's thread key (`KAFKA-MAIL-3bc971ac`). */
  readonly thread: string;
  readonly title: string;
  readonly url: string;
  /** The root message's time. */
  readonly at: string;
}

const DISCUSS_TITLE = /^(?:\[discuss\]|discuss:)/iu;

/** The single KIP a thread title opens a discussion of, or undefined (rule 1). */
export function discussedKip(title: string): string | undefined {
  if (!DISCUSS_TITLE.test(title.trim())) return undefined;
  const kips = extractKeys(title).kips;
  return kips.length === 1 ? kips[0] : undefined;
}

interface Root {
  readonly id: string;
  readonly person: string;
  readonly display: string;
  readonly at: string;
  readonly title: string;
  readonly url: string;
}

/**
 * Accumulates the facts rule 2 needs, one month at a time, so a caller keeps only one parsed
 * month (Spec 009). Months may be added in any order; the result is the same.
 */
export class KipStarterAccumulator {
  private readonly roots = new Map<string, Root>();

  add(month: ActivityMonthV1): void {
    for (const row of month.rows) {
      if (row.source !== "mail" || row.kind !== "message" || row.opens !== true) continue;
      const thread = month.threads[row.thread];
      if (thread === undefined || discussedKip(thread.title) === undefined) continue;
      const previous = this.roots.get(row.thread);
      if (previous !== undefined && (previous.at < row.at || (previous.at === row.at && previous.id <= row.id))) continue;
      this.roots.set(row.thread, {
        id: row.id, person: row.person, display: month.people[row.person] ?? row.person.slice("mail:".length),
        at: row.at, title: thread.title, url: thread.url,
      });
    }
  }

  /** Rule 3: per KIP, the thread with the earliest root; sorted by KIP number. */
  result(): readonly KipStarterV1[] {
    const byKip = new Map<string, KipStarterV1>();
    for (const [thread, root] of [...this.roots].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      const kip = discussedKip(root.title)!;
      const previous = byKip.get(kip);
      if (previous !== undefined && (previous.at < root.at || (previous.at === root.at && previous.thread <= thread))) continue;
      byKip.set(kip, { kip, person: root.person, display: root.display, thread, title: root.title, url: root.url, at: root.at });
    }
    return [...byKip.values()].sort((a, b) => Number(a.kip.slice(4)) - Number(b.kip.slice(4)));
  }
}

/** W66: the starters of every KIP discussion in `months`. */
export function kipStarters(months: readonly ActivityMonthV1[]): readonly KipStarterV1[] {
  const accumulator = new KipStarterAccumulator();
  for (const month of months) accumulator.add(month);
  return accumulator.result();
}
