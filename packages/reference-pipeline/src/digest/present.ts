/** Spec 014 Behavior 24 and 26: counts computed from the digest, the window label, and highlights. */
import type { DigestV1, Highlight, ProposalRow, TopicCard } from "./types";

export interface DigestCounts {
  readonly threads: number;
  readonly mailThreads: number;
  readonly proposals: number;
  readonly stages: Readonly<Record<string, number>>;
  readonly topics: number;
  readonly routine: number;
  readonly uncategorized: number;
}

/** The one function behind stats, anchors, stage counts (Behavior 26); never stored. */
export function digestCounts(digest: Pick<DigestV1, "proposals" | "cards" | "routine" | "threads" | "uncategorized">): DigestCounts {
  const stages: Record<string, number> = {};
  for (const row of digest.proposals) stages[row.group] = (stages[row.group] ?? 0) + 1;
  const threads = Object.values(digest.threads);
  return {
    threads: threads.length,
    mailThreads: threads.filter((thread) => thread.source === "mail").length,
    proposals: digest.proposals.length,
    stages,
    topics: digest.cards.length,
    routine: digest.routine.threads.length,
    uncategorized: digest.uncategorized?.threads.length ?? 0,
  };
}

/** Behavior 26: "<prefix> · " + Intl formatRange of the window in UTC; never a week number. */
export function windowLabel(prefix: string, locale: string, start: string, end: string): string {
  const format = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  return `${prefix} · ${format.formatRange(new Date(start), new Date(end))}`;
}

const SOURCE_LABEL: Readonly<Record<string, string>> = { github: "GitHub", mail: "dev@", jira: "JIRA" };

/** Behavior 26: a lagging source next to the stats, e.g. "JIRA through Sep 19". */
export function lagLabel(source: string, newestAt: string, locale = "en"): string {
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(newestAt));
  return `${SOURCE_LABEL[source] ?? source} through ${date}`;
}

/**
 * Behavior 24: valid highlights are shown as they are (1–2 stay 1–2); with none valid, the
 * fallback is the top proposal row's newest thread title and the top two cards' top thread titles.
 */
export function chooseHighlights(
  valid: readonly Highlight[],
  context: {
    readonly proposals: readonly ProposalRow[];
    readonly cards: readonly TopicCard[];
    readonly titles: ReadonlyMap<string, { title: string; lastActivityAt: string }>;
  },
): { readonly highlights: readonly Highlight[]; readonly fallback: boolean } {
  if (valid.length > 0) return { highlights: valid.slice(0, 3), fallback: false };
  const picks: string[] = [];
  const row = context.proposals[0];
  if (row !== undefined) {
    const newest = [...row.cites].sort((a, b) =>
      Date.parse(context.titles.get(b)?.lastActivityAt ?? "") - Date.parse(context.titles.get(a)?.lastActivityAt ?? "")
      || (a < b ? -1 : 1))[0];
    if (newest !== undefined) picks.push(newest);
  }
  for (const card of context.cards) {
    if (picks.length >= 3) break;
    const top = card.threads.find((id) => !picks.includes(id));
    if (top !== undefined) picks.push(top);
  }
  return {
    fallback: true,
    highlights: picks.map((id) => ({ title: context.titles.get(id)?.title ?? id, body: { text: context.titles.get(id)?.title ?? id, cites: [id] } })),
  };
}
