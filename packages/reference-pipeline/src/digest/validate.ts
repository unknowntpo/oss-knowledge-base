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
 * D97: completion forms. A participle from the list after is/are/was/were/has been/have been/
 * gets/got states that the work is done; so do bare "gets"/"got" before a deliverable ("Kraft gets
 * metrics") and "now" before a verb from NOW_VERBS ("now supports"). Not completion forms: "would",
 * "will", "is proposed", bare present verbs ("supports"), "gets"/"got" before a state word or another
 * participle ("gets stuck", "gets fenced"), "now" before other words ("now has", "now proposes"),
 * and a form preceded by a modal in its clause (text between , ; :). A modal after the form
 * ("are added and would ship") does not exempt it.
 */
const COMPLETION_PARTICIPLES = [
  "added", "fixed", "implemented", "improved", "supported", "avoided", "removed", "resolved", "enabled",
  "introduced", "completed", "finished", "updated", "upgraded", "replaced", "migrated", "deprecated",
  "prevented", "corrected", "addressed", "committed", "backported", "reverted", "delivered", "released",
  "shipped", "landed",
] as const;
/** Verbs that, after "now", describe shipped behavior. Chosen from what a delivered change does. */
const NOW_VERBS = [
  "supports", "uses", "includes", "returns", "rejects", "allows", "accepts", "runs", "exposes", "provides",
  "enables", "emits", "honors", "skips", "validates", "requires", "handles", "defaults", "retries", "tracks",
  "reports", "logs", "caches", "persists",
] as const;
/** Words after a bare "gets"/"got" that describe a state, not a deliverable. */
const STATE_WORDS = ["stuck", "lost", "stale", "hung", "wrong", "worse", "slow", "slower", "out", "into", "to", "in", "back", "rid", "through"] as const;
/** Case-sensitive, so "May" (the month) is not a modal; a sentence-initial modal is capitalized. */
const MODAL = /(?<![A-Za-z0-9_])(?:would|will|could|may|might|should|Would|Will|Could|Might|Should)(?![A-Za-z0-9_])/u;
const COMPLETION_FORMS: readonly RegExp[] = [
  new RegExp(`(?<![A-Za-z0-9_])(?:is|are|was|were|has\\s+been|have\\s+been|gets|got)\\s+(?:(?:now|already|finally|also)\\s+)?(?:${COMPLETION_PARTICIPLES.join("|")})(?![A-Za-z0-9_])`, "iu"),
  new RegExp(`(?<![A-Za-z0-9_])(?:gets|got)(?![A-Za-z0-9_])(?!\\s+(?:${STATE_WORDS.join("|")}|[A-Za-z]+ed)(?![A-Za-z0-9_]))`, "iu"),
  new RegExp(`(?<![A-Za-z0-9_])now\\s+(?:${NOW_VERBS.join("|")})(?![A-Za-z0-9_])`, "iu"),
];

/** The first completion form not preceded by a modal in its clause (D97). */
function completionForm(text: string): string | null {
  for (const clause of text.split(/[,;:，；：]/u)) {
    for (const pattern of COMPLETION_FORMS) {
      const match = pattern.exec(clause);
      if (match !== null && !MODAL.test(clause.slice(0, match.index))) return match[0].toLowerCase().replace(/\s+/gu, " ");
    }
  }
  return null;
}
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

/**
 * The comma-separated parts inside the sentence's outermost parentheses, lowercased:
 * "(KAFKA-1, closed)" gives ["kafka-1", "closed"]; nested parentheses stay inside their part
 * ("(KAFKA-1, 關閉（未合併）)" gives ["kafka-1", "關閉（未合併）"]).
 */
export function parentheticalWords(text: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "（") {
      if (depth > 0) current += char;
      depth += 1;
    } else if ((char === ")" || char === "）") && depth > 0) {
      depth -= 1;
      if (depth > 0) current += char;
      else {
        groups.push(current);
        current = "";
      }
    } else if (depth > 0) current += char;
  }
  return groups.flatMap((group) => group.split(/[,，、;；]/u).map((part) => part.trim().toLowerCase()).filter((part) => part !== ""));
}

/** D97: a completion form needs a final cited item; "(…, closed)" never allows one; a partial PR needs step wording. */
function tenseRejection(text: string, cited: readonly CitedThread[]): Rejection | null {
  const form = completionForm(text);
  if (form === null) return null;
  if (parentheticalWords(text).includes("closed")) return "tense:closed";
  const steps = STEP_WORDING.test(text);
  if (cited.some((thread) => final(thread) && (steps || !partial(thread)))) return null;
  if (cited.some((thread) => final(thread) && partial(thread))) return "tense:partial";
  return `tense:${form}`;
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
