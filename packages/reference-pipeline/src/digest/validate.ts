/**
 * Spec 014 Behavior 9 and 30: validation of generated sentences. A sentence is kept only when
 * its length, citations, status words, status tense (D97), stance verbs, and proposal keys all pass.
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
  | `tense:${string}`
  | "other-proposal";

const STATUS_WORDS: readonly (readonly [readonly string[], (thread: CitedThread) => boolean])[] = [
  [["merged", "landed", "fixed"], (thread) => thread.status === "merged" || thread.status === "resolved"],
  [["released", "announced", "shipped"], (thread) => /\[announce\]/iu.test(thread.title)],
  [["verified", "passed", "approved", "accepted", "adopted"], (thread) => /\[(?:result|announce)\]/iu.test(thread.title)],
];

const STANCE = ["objected", "opposed", "rejected", "refused", "disagreed", "pushed back", "blocked"] as const;

/**
 * D97: completion forms. Participles after is/are/was/were/has been/have been/gets/got state that
 * the work is done; "gets"/"got" alone ("Kraft gets metrics") and "now <verb>s" do too. "would",
 * "will", "is proposed", and bare present verbs ("supports") are not completion forms.
 */
const COMPLETION_PARTICIPLES = [
  "added", "fixed", "implemented", "improved", "supported", "avoided", "removed", "resolved", "enabled",
  "introduced", "completed", "finished", "updated", "upgraded", "replaced", "migrated", "deprecated",
  "prevented", "corrected", "addressed",
] as const;
const COMPLETION_FORMS: readonly RegExp[] = [
  new RegExp(`(?<![A-Za-z0-9_])(?:is|are|was|were|has\\s+been|have\\s+been|gets|got)\\s+(?:(?:now|already|finally|also)\\s+)?(?:${COMPLETION_PARTICIPLES.join("|")})(?![A-Za-z0-9_])`, "iu"),
  /(?<![A-Za-z0-9_])(?:gets|got)(?![A-Za-z0-9_])/iu,
  /(?<![A-Za-z0-9_])now\s+[a-z]+s(?![A-Za-z0-9_])/iu,
];
/** A "[k/N]" or "[k/n]" PR title with k < n: one part of a series (D97). */
const PARTIAL = /\[\s*(\d+)\s*\/\s*(N|\d+)\s*\]/iu;
/** Wording that says a partial PR is one step (D97). */
const STEP_WORDING = /(?<![A-Za-z0-9_])(?:(?:first|next|another|initial)\s+step|part\s+\d+\s+of|step\s+\d+)(?![A-Za-z0-9_])/iu;

function partial(thread: CitedThread): boolean {
  const match = PARTIAL.exec(thread.title);
  return match !== null && (match[2]!.toUpperCase() === "N" || Number(match[1]) < Number(match[2]));
}

/** A cited item whose work is done: a merged PR, a resolved issue, or a [RESULT]/[ANNOUNCE] thread. */
function final(thread: CitedThread): boolean {
  if (thread.status === "merged" || thread.status === "resolved") return true;
  return /\[(?:result|announce)\]/iu.test(thread.title);
}

/** The status words inside the sentence's parentheses: "(KAFKA-1, closed)" gives ["closed"]. */
export function parentheticalWords(text: string): string[] {
  return [...text.matchAll(/[(（]([^()（）]*)[)）]/gu)]
    .flatMap((match) => match[1]!.split(/[,，、;；]/u).map((part) => part.trim().toLowerCase()).filter((part) => part !== ""));
}

/** D97: a completion form needs a final cited item; "(…, closed)" never allows one; a partial PR needs step wording. */
function tenseRejection(text: string, cited: readonly CitedThread[]): Rejection | null {
  const form = COMPLETION_FORMS.map((pattern) => pattern.exec(text)).find((match) => match !== null);
  if (form === undefined) return null;
  if (parentheticalWords(text).includes("closed")) return "tense:closed";
  const steps = STEP_WORDING.test(text);
  if (cited.some((thread) => final(thread) && (steps || !partial(thread)))) return null;
  if (cited.some((thread) => final(thread) && partial(thread))) return "tense:partial";
  return `tense:${form[0]!.toLowerCase().replace(/\s+/gu, " ")}`;
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${word.replace(/ /gu, "\\s+")}(?![A-Za-z0-9_])`, "iu").test(text);
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
  const length = [...text].length; // characters (code points), not UTF-16 units
  if (text.trim().length === 0 || length > MAX_SENTENCE_CHARS) return "length";
  if (sentence.cites.length === 0) return "no-cites";
  if (sentence.cites.some((cite) => !context.inputs.has(cite))) return "cite-outside-inputs";
  const cited = sentence.cites.map((cite) => context.threads.get(cite)).filter((thread) => thread !== undefined);
  for (const [words, satisfied] of STATUS_WORDS) {
    for (const word of words) {
      if (hasWord(text, word) && !cited.some(satisfied)) return `status:${word}`;
    }
  }
  const tense = tenseRejection(text, cited);
  if (tense !== null) return tense;
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
