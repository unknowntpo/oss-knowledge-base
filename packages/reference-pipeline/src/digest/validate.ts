/**
 * Spec 014 Behavior 9 and 30: validation of generated sentences. A sentence is kept only when
 * its length, citations, status words, stance verbs, and proposal keys all pass.
 */
import type { DigestProfile, Sentence } from "./types";

export const MAX_SENTENCE_CHARS = 240;

/** What a cited thread looks like to the accuracy rules. */
export interface CitedThread {
  readonly title: string;
  readonly source: "github" | "mail" | "jira";
  readonly status: string | null;
}

export type Rejection =
  | "length"
  | "no-cites"
  | "cite-outside-inputs"
  | `status:${string}`
  | `stance:${string}`
  | "other-proposal";

const STATUS_WORDS: readonly (readonly [readonly string[], (thread: CitedThread) => boolean])[] = [
  [["merged", "landed", "fixed"], (thread) => thread.status === "merged" || thread.status === "resolved"],
  [["released", "announced", "shipped"], (thread) => /\[announce\]/iu.test(thread.title)],
  [["verified", "passed", "approved", "accepted", "adopted"], (thread) => /\[(?:result|announce)\]/iu.test(thread.title)],
];

const STANCE = ["objected", "opposed", "rejected", "refused", "disagreed", "pushed back", "blocked"] as const;

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(?<![A-Za-z])${word.replace(/ /gu, "\\s+")}(?![A-Za-z])`, "iu").test(text);
}

export interface SentenceContext {
  /** Display ids given to the model in this call. */
  readonly inputs: ReadonlySet<string>;
  /** State of every thread that may be cited. */
  readonly threads: ReadonlyMap<string, CitedThread>;
  /** For a proposal line: its own key; other proposal keys are rejected. */
  readonly ownProposal?: string;
  readonly profile: DigestProfile;
}

/** Behavior 9 and 30 for one sentence; `null` means kept. */
export function rejectSentence(sentence: Sentence, context: SentenceContext): Rejection | null {
  const text = sentence.text;
  if (text.length < 1 || text.length > MAX_SENTENCE_CHARS) return "length";
  if (sentence.cites.length === 0) return "no-cites";
  if (sentence.cites.some((cite) => !context.inputs.has(cite))) return "cite-outside-inputs";
  const cited = sentence.cites.map((cite) => context.threads.get(cite)).filter((thread) => thread !== undefined);
  for (const [words, satisfied] of STATUS_WORDS) {
    for (const word of words) {
      if (hasWord(text, word) && !cited.some(satisfied)) return `status:${word}`;
    }
  }
  for (const word of STANCE) if (hasWord(text, word)) return `stance:${word}`;
  if (context.ownProposal !== undefined) {
    const keys = text.match(new RegExp(context.profile.proposal.keyPattern, "gu")) ?? [];
    if (keys.some((key) => key !== context.ownProposal)) return "other-proposal";
  }
  return null;
}

/** Keeps valid sentences in order, at most `limit`; reports each rejection. */
export function validateSentences(
  sentences: readonly Sentence[],
  context: SentenceContext,
  limit: number,
): { kept: Sentence[]; rejected: { sentence: Sentence; reason: Rejection }[] } {
  const kept: Sentence[] = [];
  const rejected: { sentence: Sentence; reason: Rejection }[] = [];
  for (const sentence of sentences) {
    const reason = rejectSentence(sentence, context);
    if (reason !== null) rejected.push({ sentence, reason });
    else if (kept.length < limit) kept.push(sentence);
  }
  return { kept, rejected };
}
