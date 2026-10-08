/**
 * Spec 014 slice 2b: the decision-model classifier (Behavior 6) on Cloudflare's Clef-flash.
 *
 * Clef returns a probability for each caller-defined option of each question
 * (https://developers.cloudflare.com/workers-ai/models/clef-flash/, read 2026-10-08):
 *   request  { state, questions: { <id>: { type: "choice", instructions, criteria: { <option>: <description> } }
 *                                         | { type: "noul", instructions } } }   (1–64 questions)
 *   response { model, answers: { <id>: { choice, probabilities } | { probability } }, usage }
 * Workers AI truncates long `state` text (about 2K tokens), so `state` carries only threads' titles
 * and short excerpts and is packed to stay under CLEF_STATE_TOKENS; the questions are billed but not
 * part of `state` (confirmed or corrected on Dev by D35). One choice question per thread:
 * the taxonomy topics plus `routine`, so a thread is routine when that option's probability is at
 * least 0.6 (Behavior 6), and its topic is the most probable non-routine option.
 */
import { rulesClassify } from "./classify";
import { estimateTokens } from "./estimate";
import type { DigestProfile, Thread, ThreadFeatures } from "./types";

export const CLEF_MODELS = { flash: "@cf/cloudflare/clef-flash", full: "@cf/cloudflare/clef" } as const;
export type ClefModel = (typeof CLEF_MODELS)[keyof typeof CLEF_MODELS];
export const CLEF_REVISION = "digest-clef@1";
/** Head room under Workers AI's ~2K-token truncation of `state`. */
export const CLEF_STATE_TOKENS = 1_800;
export const CLEF_MAX_QUESTIONS = 64;
export const CLEF_EXCERPT_CHARS = 120;
export const ROUTINE_OPTION = "routine";

export type ClefQuestion =
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "noul"; readonly instructions: string };

export interface ClefRequest {
  readonly state: readonly { readonly ref: string; readonly title: string; readonly excerpt: string }[];
  readonly questions: Readonly<Record<string, ClefQuestion>>;
}

export interface ClefResponse {
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly usage?: Readonly<Record<string, unknown>>;
}

/** Short option descriptions (every option repeats per thread, so they stay to a few words). */
const OPTION_HINTS: Readonly<Record<string, string>> = {
  releases: "releases",
  "group-coordination": "group coordinator, assignors",
  clients: "producer, consumer clients",
  "share-groups": "share groups",
  streams: "Kafka Streams",
  connect: "Connect, MirrorMaker",
  storage: "log, tiered, diskless storage",
  kraft: "KRaft, metadata",
  security: "security, ACLs, CVEs",
  observability: "metrics",
  community: "committers, PMC, admin",
  other: "other",
  [ROUTINE_OPTION]: "deps, build, tests, docs, backports",
};

function questionsFor(ref: string, profile: DigestProfile): Record<string, ClefQuestion> {
  return {
    [ref]: {
      type: "choice",
      instructions: `Topic of ${ref}`,
      criteria: Object.fromEntries([...profile.taxonomy.topics, ROUTINE_OPTION].map((option) => [option, OPTION_HINTS[option] ?? option])),
    },
  };
}

function stateOf(thread: Thread, ref: string) {
  return { ref, title: thread.title, excerpt: thread.rootExcerpt.slice(0, CLEF_EXCERPT_CHARS) };
}

export function clefRequest(batch: readonly Thread[], profile: DigestProfile): ClefRequest {
  const refs = batch.map((_, index) => `t${index + 1}`);
  return {
    state: batch.map((thread, index) => stateOf(thread, refs[index]!)),
    questions: Object.assign({}, ...batch.map((_, index) => questionsFor(refs[index]!, profile))),
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
    const fits = next.length <= CLEF_MAX_QUESTIONS && clefStateTokens(clefRequest(next, profile)) <= maxTokens;
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
): { features: Map<string, ThreadFeatures>; fallbacks: number } {
  const features = new Map<string, ThreadFeatures>();
  let fallbacks = 0;
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
  return { features, fallbacks };
}
