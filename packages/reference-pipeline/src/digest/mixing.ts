/** Spec 014 Behavior 7–9: mixing, keywords, and the summarizer's card input. */
import { byScore } from "./candidates";
import { placement } from "./classify";
import type { DigestProfile, Thread, ThreadFeatures, TopicCard } from "./types";

export const VISIBLE_THREADS = 5;
export const CARD_INPUT_THREADS = 12;
export const CARD_INPUT_CHARS = 6_000;

export interface Mix {
  readonly cards: TopicCard[];
  readonly routine: string[];
}

/** Behavior 7: each candidate exactly once, in a card or in routine; cards by top-3 score sum. */
export function mix(threads: readonly Thread[], features: ReadonlyMap<string, ThreadFeatures>, profile: DigestProfile): Mix {
  const byTopic = new Map<string, Thread[]>();
  const routine: Thread[] = [];
  for (const thread of threads) {
    const feature = features.get(thread.displayId);
    if (feature === undefined) throw new Error(`No features for ${thread.displayId}`);
    const place = placement(feature);
    if (place.routine) routine.push(thread);
    else byTopic.set(place.topic, [...(byTopic.get(place.topic) ?? []), thread]);
  }
  const cards: TopicCard[] = [];
  for (const topic of profile.taxonomy.topics) {
    const members = (byTopic.get(topic) ?? []).sort(byScore);
    if (members.length === 0) continue;
    cards.push({
      topic,
      score: members.slice(0, 3).reduce((sum, thread) => sum + thread.score, 0),
      threads: members.map((thread) => thread.displayId),
      keywords: keywords(members.map((thread) => thread.title), threads.map((thread) => thread.title)),
      sentences: [],
      status: "fallback",
    });
  }
  cards.sort((a, b) => b.score - a.score || (a.topic < b.topic ? -1 : 1));
  return { cards, routine: routine.sort(byScore).map((thread) => thread.displayId) };
}

/** A card shows its first 5 threads and "n more" (Behavior 7). */
export function visibleThreads(card: Pick<TopicCard, "threads">): { shown: readonly string[]; more: number } {
  return { shown: card.threads.slice(0, VISIBLE_THREADS), more: Math.max(0, card.threads.length - VISIBLE_THREADS) };
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "its", "of", "on", "or",
  "re", "the", "to", "via", "when", "with", "without", "minor", "wip", "draft", "discuss", "vote", "result", "pr",
  "add", "use", "not", "all", "after", "before", "per", "can", "do", "does", "should",
]);

function terms(title: string): string[] {
  const cleaned = title
    .replace(/\b(?:KIP|KAFKA|FLIP|PR|ISSUE)-\d+\b/gu, " ")
    .replace(/\[\d+\/N\]|\[\d+\/\d+\]/giu, " ")
    .replace(/#\d+/gu, " ");
  const out = new Set<string>();
  for (const raw of cleaned.split(/[^A-Za-z0-9_.-]+/u)) {
    // Version-like tokens (4.4.0) stay whole; identifiers split on dots and camelCase.
    const parts = /^\d+(?:\.\d+)+$/u.test(raw) ? [raw] : raw.split(".").flatMap((part) =>
      /[a-z][A-Z]/u.test(part) ? part.split(/(?<=[a-z0-9])(?=[A-Z])/u) : [part]);
    for (const part of parts) {
      const term = part.replace(/^[.-]+|[.-]+$/gu, "");
      if (term.length < 2 || /^\d+$/u.test(term) || STOPWORDS.has(term.toLowerCase())) continue;
      out.add(term.toLowerCase());
    }
  }
  return [...out];
}

/** Behavior 8: top 5 title terms by tf-idf (tf in the card, df across all candidates), ties alphabetical. */
export function keywords(cardTitles: readonly string[], allTitles: readonly string[], limit = 5): string[] {
  const df = new Map<string, number>();
  for (const title of allTitles) for (const term of terms(title)) df.set(term, (df.get(term) ?? 0) + 1);
  const tf = new Map<string, number>();
  for (const title of cardTitles) for (const term of terms(title)) tf.set(term, (tf.get(term) ?? 0) + 1);
  const total = Math.max(allTitles.length, 1);
  return [...tf.entries()]
    .map(([term, count]) => ({ term, score: count * Math.log(total / Math.max(df.get(term) ?? 1, 1)) }))
    .sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
    .slice(0, limit)
    .map((entry) => entry.term);
}

/** Behavior 6 and 9: one thread's model text (title, root excerpt, in-window excerpts). */
export function threadText(thread: Thread, options: { maxExcerpts?: number; anonymize?: boolean } = {}): string {
  const lines = [`[${thread.displayId}] ${thread.title} (${thread.source}, ${thread.status ?? "unknown"})`,
    `root: ${thread.rootExcerpt.slice(0, 280)}`];
  const records = options.maxExcerpts === undefined ? thread.records : thread.records.slice(-options.maxExcerpts);
  for (const record of records) {
    const author = record.author === "unknown sender" ? "anonymous" : record.author;
    lines.push(`- ${author} ${record.occurredAt.slice(0, 10)}: ${record.excerpt.slice(0, options.maxExcerpts === undefined ? undefined : 200)}`);
  }
  return lines.join("\n");
}

/** Behavior 9: up to 12 threads by score, all in-window excerpts, stopping at 6,000 characters. */
export function cardInput(threads: readonly Thread[]): { threads: string[]; text: string } {
  const included: string[] = [];
  let text = "";
  for (const thread of [...threads].sort(byScore).slice(0, CARD_INPUT_THREADS)) {
    const block = threadText(thread);
    const next = text === "" ? block : `${text}\n\n${block}`;
    if (next.length > CARD_INPUT_CHARS) {
      if (included.length === 0) {
        text = next.slice(0, CARD_INPUT_CHARS);
        included.push(thread.displayId);
      }
      break;
    }
    text = next;
    included.push(thread.displayId);
  }
  return { threads: included, text };
}
