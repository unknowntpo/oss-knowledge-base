/**
 * Spec 014 slice 2b: the decision-model classifier (Behavior 6) on Cloudflare's Clef-flash.
 *
 * Clef returns a probability for each caller-defined option of each question
 * (https://developers.cloudflare.com/workers-ai/models/clef-flash/, read 2026-10-08):
 *   request  { state, questions: { <id>: { type: "choice", instructions, criteria: { <option>: <description> } }
 *                                         | { type: "noul", instructions } } }   (1–64 questions)
 *   response { model, answers: { <id>: { choice, probabilities } | { probability } }, usage }
 * Assumption (unconfirmed until the D35 Dev dry run): Workers AI truncates long `state` text near
 * 2K tokens, so `state` carries only threads' titles and short excerpts and is packed to stay under
 * it (CLEF_STATE_TOKENS); the questions are billed but not part of `state`.
 * Truncation check (slice 2c): Clef-flash returned no `usage` on Dev, so every request ends `state`
 * with a canary `{ref: "end", word}` and asks question `end` for that word among 4. A cut `state`
 * loses the canary; a canary probability below 0.5 (or reported prompt tokens under 80% of the
 * estimate, when `usage` exists) makes the whole batch unseen: rules features.
 * One choice question per thread: the taxonomy topics plus `routine`, described by the profile's
 * `taxonomy.descriptions`. A thread is routine when that option's probability is at
 * least 0.5, and goes to the routine section at 0.6 or more (`placement`, Behavior 6); its topic is
 * the most probable topic option.
 */
import { rulesClassify } from "./classify";
import { estimateTokens } from "./estimate";
import type { DigestProfile, Thread, ThreadFeatures } from "./types";

export const CLEF_MODELS = { flash: "@cf/cloudflare/clef-flash", full: "@cf/cloudflare/clef" } as const;
export type ClefModel = (typeof CLEF_MODELS)[keyof typeof CLEF_MODELS];
export const CLEF_REVISION = "digest-clef@2";
/** Head room under the assumed ~2K-token truncation of `state` (D35 confirms). */
export const CLEF_STATE_TOKENS = 1_800;
/** Reported prompt tokens below this share of the estimate mean truncation (fail safe). */
export const CLEF_SEEN_RATIO = 0.8;
export const CLEF_MAX_QUESTIONS = 64;
/** Thread questions per request: the 64-question limit minus the canary question. */
export const CLEF_MAX_THREADS = CLEF_MAX_QUESTIONS - 1;
/** At most this many Clef requests per run; later threads get rules features (Behavior 6). */
export const CLEF_MAX_REQUESTS = 20;
export const CANARY_REF = "end";
/** Canary words; a request's canary is chosen by its thread count, the others are decoys. */
export const CANARY_WORDS = ["amber", "falcon", "glacier", "lantern"] as const;
/** A canary probability below this means the model did not see the end of `state`. */
export const CANARY_SEEN = 0.5;
export const CLEF_EXCERPT_CHARS = 120;
export const ROUTINE_OPTION = "routine";

export type ClefQuestion =
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "noul"; readonly instructions: string };

export type ClefStateItem =
  | { readonly ref: string; readonly title: string; readonly excerpt: string }
  | { readonly ref: typeof CANARY_REF; readonly word: string };

export interface ClefRequest {
  readonly state: readonly ClefStateItem[];
  readonly questions: Readonly<Record<string, ClefQuestion>>;
}

export interface ClefResponse {
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly usage?: Readonly<Record<string, unknown>>;
}

function questionsFor(ref: string, profile: DigestProfile): Record<string, ClefQuestion> {
  const descriptions = profile.taxonomy.descriptions ?? {};
  return {
    [ref]: {
      type: "choice",
      instructions: `Topic of ${ref}`,
      criteria: Object.fromEntries([...profile.taxonomy.topics, ROUTINE_OPTION].map((option) => [option, descriptions[option] ?? option])),
    },
  };
}

function stateOf(thread: Thread, ref: string) {
  return { ref, title: thread.title, excerpt: thread.rootExcerpt.slice(0, CLEF_EXCERPT_CHARS) };
}

/** The canary word for a batch of `size` threads. */
export function canaryWord(size: number): string {
  return CANARY_WORDS[size % CANARY_WORDS.length]!;
}

export function clefRequest(batch: readonly Thread[], profile: DigestProfile): ClefRequest {
  const refs = batch.map((_, index) => `t${index + 1}`);
  const word = canaryWord(batch.length);
  return {
    state: [...batch.map((thread, index) => stateOf(thread, refs[index]!)), { ref: CANARY_REF, word }],
    questions: {
      ...Object.assign({}, ...batch.map((_, index) => questionsFor(refs[index]!, profile))),
      [CANARY_REF]: {
        type: "choice",
        instructions: `The word of item ${CANARY_REF}`,
        criteria: Object.fromEntries(CANARY_WORDS.map((option) => [option, option])),
      },
    },
  };
}

/** Billed input: state and questions. */
export function clefRequestTokens(request: ClefRequest): number {
  return estimateTokens(JSON.stringify(request));
}

/** The part Workers AI truncates. */
export function clefStateTokens(request: Pick<ClefRequest, "state">): number {
  return estimateTokens(JSON.stringify(request.state));
}

/** Packs threads in order into requests under the state budget and the 64-question limit. */
export function packClefBatches(threads: readonly Thread[], profile: DigestProfile, maxTokens = CLEF_STATE_TOKENS): Thread[][] {
  const batches: Thread[][] = [];
  let current: Thread[] = [];
  for (const thread of threads) {
    const next = [...current, thread];
    const fits = next.length <= CLEF_MAX_THREADS && clefStateTokens(clefRequest(next, profile)) <= maxTokens;
    if (fits || current.length === 0) {
      current = next;
    } else {
      batches.push(current);
      current = [thread];
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function probability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/**
 * Behavior 6 and 16 for Clef: valid option probabilities give model features (routine when the
 * `routine` option has probability ≥ 0.5; topic = most probable taxonomy option, with its
 * probability renormalised over the topics as the confidence); a missing or invalid answer gives
 * that thread rules features.
 */
export function clefFeatures(
  response: ClefResponse | undefined,
  batch: readonly Thread[],
  profile: DigestProfile,
  model: { model: string; prompt: string; generatedAt: string },
  estimatedTokens?: number,
): { features: Map<string, ThreadFeatures>; fallbacks: number; unseen: boolean } {
  const features = new Map<string, ThreadFeatures>();
  let fallbacks = 0;
  const reported = response?.usage?.prompt_tokens;
  const canary = response?.answers?.[CANARY_REF] as { probabilities?: Record<string, unknown> } | undefined;
  const canarySeen = (probability(canary?.probabilities?.[canaryWord(batch.length)]) ?? 0) >= CANARY_SEEN;
  const truncated = typeof reported === "number" && estimatedTokens !== undefined && reported < CLEF_SEEN_RATIO * estimatedTokens;
  if (response !== undefined && (!canarySeen || truncated)) {
    for (const thread of batch) features.set(thread.displayId, rulesClassify(thread, profile));
    return { features, fallbacks: batch.length, unseen: true };
  }
  batch.forEach((thread, index) => {
    const answer = response?.answers?.[`t${index + 1}`] as { probabilities?: Record<string, unknown> } | undefined;
    const options = [...profile.taxonomy.topics, ROUTINE_OPTION];
    const probabilities = options.map((option) => probability(answer?.probabilities?.[option]));
    if (probabilities.some((value) => value === undefined)) {
      features.set(thread.displayId, rulesClassify(thread, profile));
      fallbacks += 1;
      return;
    }
    const routineProbability = probabilities[options.length - 1]!;
    const topics = profile.taxonomy.topics.map((topic, at) => ({ topic, p: probabilities[at]! }));
    const topicMass = topics.reduce((sum, item) => sum + item.p, 0);
    const best = [...topics].sort((a, b) => b.p - a.p || (a.topic < b.topic ? -1 : 1))[0]!;
    const routine = routineProbability >= 0.5;
    features.set(thread.displayId, {
      topic: best.topic,
      topicConfidence: topicMass > 0 ? best.p / topicMass : 0,
      routine,
      routineConfidence: routine ? routineProbability : 1 - routineProbability,
      source: "model",
      ...model,
    });
  });
  return { features, fallbacks, unseen: false };
}
