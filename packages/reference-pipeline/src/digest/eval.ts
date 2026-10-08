/**
 * Spec 014 offline replay (`bun run digest -- eval|measure`): runs stages 1–6 on a committed
 * fixture with recorded model responses, validates every generated sentence, and estimates the
 * budget. It never calls a model or the network.
 */
import { digestWindowStart, selectCandidates, sourceCoverage } from "./candidates";
import { parseClassification } from "./classify";
import { estimateTokens, MAX_TOKENS, neurons, type PricedModel } from "./estimate";
import { cardInput, mix, threadText } from "./mixing";
import { CLASSIFY_PROMPT, HIGHLIGHTS_PROMPT, SUMMARIZE_PROMPT, TRANSLATE_PROMPT } from "./prompts";
import { chooseHighlights, digestCounts } from "./present";
import { proposalRows } from "./proposals";
import { protect } from "./protect";
import type { DigestDetail, DigestEntry, DigestProfile, Highlight, Sentence, Thread, ThreadFeatures, TopicCard } from "./types";
import { rejectSentence, validateSentences, type CitedThread, type Rejection } from "./validate";

export interface DigestFixture {
  readonly release: { readonly releaseId: string; readonly generatedAt: string };
  readonly entries: readonly DigestEntry[];
  readonly details: Readonly<Record<string, DigestDetail>>;
}

export interface RecordedResponses {
  readonly revision: string;
  readonly note: string;
  readonly classify: Readonly<Record<string, { topic: string; topicConfidence: number; routine: boolean; routineConfidence: number }>>;
  readonly cards: Readonly<Record<string, readonly Sentence[]>>;
  readonly proposals: Readonly<Record<string, Sentence>>;
  readonly headline: Sentence | null;
  readonly highlights: readonly Highlight[];
}

export type ErrorClass = "status-mismatch" | "misattribution" | "invented-claim" | "overbroad-stance";

export interface GoldenLabels {
  readonly revision: string;
  /** Important thread display ids, labeled by the human (empty until labeled). */
  readonly important: readonly string[];
  readonly negatives: readonly { readonly text: string; readonly cites: readonly string[]; readonly class: ErrorClass; readonly origin: string }[];
}

export const BATCH = { classify: 20, translate: 25 } as const;
export const MODELS = {
  summarizer: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  translator: "@cf/qwen/qwen3-30b-a3b-fp8",
} as const satisfies Record<string, PricedModel>;

function citedThreads(threads: readonly Thread[]): Map<string, CitedThread> {
  return new Map(threads.map((thread) => [thread.displayId, { title: thread.title, source: thread.source, status: thread.status }]));
}

export interface Replay {
  readonly candidates: readonly Thread[];
  readonly features: ReadonlyMap<string, ThreadFeatures>;
  readonly cards: readonly TopicCard[];
  readonly routine: readonly string[];
  readonly proposals: ReturnType<typeof proposalRows>;
  readonly kept: readonly { readonly where: string; readonly sentence: Sentence }[];
  readonly rejected: readonly { readonly where: string; readonly sentence: Sentence; readonly reason: Rejection }[];
  readonly highlights: { readonly highlights: readonly Highlight[]; readonly fallback: boolean };
  readonly headline: Sentence | null;
  readonly coverage: ReturnType<typeof sourceCoverage>;
  readonly cardInputs: ReadonlyMap<string, string>;
  readonly proposalInputs: ReadonlyMap<string, string>;
}

/** Stages 1–6 with recorded responses. */
export function replay(fixture: DigestFixture, recorded: RecordedResponses, profile: DigestProfile): Replay {
  const windowEnd = fixture.release.generatedAt;
  const candidates = selectCandidates(fixture.entries, fixture.details, profile, windowEnd);
  const features = new Map<string, ThreadFeatures>();
  const model = { model: recorded.revision, prompt: recorded.revision, generatedAt: windowEnd };
  for (let index = 0; index < candidates.length; index += BATCH.classify) {
    const batch = candidates.slice(index, index + BATCH.classify);
    const raw = JSON.stringify(batch.flatMap((thread) => {
      const item = recorded.classify[thread.displayId];
      return item === undefined ? [] : [{ id: thread.displayId, ...item }];
    }));
    for (const [id, feature] of parseClassification(raw, batch, profile, model).features) features.set(id, feature);
  }
  const mixed = mix(candidates, features, profile);
  const byId = new Map(candidates.map((thread) => [thread.displayId, thread]));
  const states = citedThreads(candidates);
  const kept: { where: string; sentence: Sentence }[] = [];
  const rejected: { where: string; sentence: Sentence; reason: Rejection }[] = [];
  const cardInputs = new Map<string, string>();
  const cards = mixed.cards.map((card) => {
    const input = cardInput(card.threads.map((id) => byId.get(id)!));
    cardInputs.set(card.topic, input.text);
    const result = validateSentences(recorded.cards[card.topic] ?? [], { inputs: new Set(input.threads), threads: states, profile }, 3);
    for (const sentence of result.kept) kept.push({ where: `card:${card.topic}`, sentence });
    for (const entry of result.rejected) rejected.push({ where: `card:${card.topic}`, ...entry });
    return { ...card, sentences: result.kept, status: result.kept.length > 0 ? "generated" as const : "fallback" as const };
  });
  const proposalInputs = new Map<string, string>();
  const proposals = proposalRows(candidates, profile).map((row) => {
    const input = cardInput(row.cites.map((id) => byId.get(id)!).filter((thread) => thread !== undefined));
    proposalInputs.set(row.key, input.text);
    const line = recorded.proposals[row.key];
    if (line === undefined) return row;
    const reason = rejectSentence(line, { inputs: new Set(input.threads), threads: states, ownProposal: row.key, profile });
    if (reason !== null) {
      rejected.push({ where: `proposal:${row.key}`, sentence: line, reason });
      return row;
    }
    kept.push({ where: `proposal:${row.key}`, sentence: line });
    return { ...row, line };
  });
  const allowed = new Set(kept.flatMap((entry) => entry.sentence.cites));
  const highlightContext = { inputs: allowed, threads: states, profile };
  const validHighlights = recorded.highlights.filter((highlight) => {
    const reason = rejectSentence(highlight.body, highlightContext);
    if (reason !== null) rejected.push({ where: "highlight", sentence: highlight.body, reason });
    return reason === null;
  });
  const headlineReason = recorded.headline === null ? null : rejectSentence(recorded.headline, highlightContext);
  if (recorded.headline !== null && headlineReason !== null) rejected.push({ where: "headline", sentence: recorded.headline, reason: headlineReason });
  const titles = new Map(candidates.map((thread) => [thread.displayId, { title: thread.title, lastActivityAt: thread.lastActivityAt }]));
  return {
    candidates, features, cards, routine: mixed.routine, proposals, kept, rejected,
    highlights: chooseHighlights(validHighlights, { proposals, cards, titles }),
    headline: headlineReason === null ? recorded.headline : null,
    coverage: sourceCoverage(fixture.entries, profile, windowEnd),
    cardInputs, proposalInputs,
  };
}

export interface EvalReport {
  readonly revision: string;
  readonly window: { readonly start: string; readonly end: string };
  readonly candidates: number;
  readonly counts: ReturnType<typeof digestCounts>;
  readonly cards: readonly { readonly topic: string; readonly threads: number; readonly status: string }[];
  readonly sentences: { readonly kept: number; readonly dropped: number; readonly shareDropped: number; readonly byReason: Readonly<Record<string, number>> };
  readonly negatives: readonly { readonly class: ErrorClass; readonly origin: string; readonly rejectedBy: Rejection | null }[];
  readonly errorClasses: Readonly<Record<ErrorClass, { readonly fixtures: number; readonly rejectedByRules: number }>>;
  readonly recall: string;
  readonly lagging: readonly string[];
}

export function evaluate(fixture: DigestFixture, recorded: RecordedResponses, labels: GoldenLabels, profile: DigestProfile): EvalReport {
  const run = replay(fixture, recorded, profile);
  const byReason: Record<string, number> = {};
  for (const entry of run.rejected) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
  const states = citedThreads(run.candidates);
  const negatives = labels.negatives.map((negative) => ({
    class: negative.class,
    origin: negative.origin,
    rejectedBy: rejectSentence({ text: negative.text, cites: negative.cites }, { inputs: new Set(negative.cites), threads: states, profile }),
  }));
  const errorClasses = Object.fromEntries((["status-mismatch", "misattribution", "invented-claim", "overbroad-stance"] as const).map((name) => [name, {
    fixtures: negatives.filter((negative) => negative.class === name).length,
    rejectedByRules: negatives.filter((negative) => negative.class === name && negative.rejectedBy !== null).length,
  }])) as Record<ErrorClass, { fixtures: number; rejectedByRules: number }>;
  const total = run.kept.length + run.rejected.length;
  const threads = Object.fromEntries(run.candidates.map((thread) => [thread.displayId, {
    title: thread.title, source: thread.source, status: thread.status, url: thread.url, score: thread.score,
  }]));
  let recall = "pending human labels";
  if (labels.important.length > 0) {
    const visible = new Set(run.cards.flatMap((card) => card.threads.slice(0, 5)));
    recall = `${labels.important.filter((id) => visible.has(id)).length}/${labels.important.length}`;
  }
  return {
    revision: recorded.revision,
    window: { start: digestWindowStart(fixture.release.generatedAt), end: fixture.release.generatedAt },
    candidates: run.candidates.length,
    counts: digestCounts({ proposals: run.proposals, cards: run.cards, routine: { threads: run.routine }, threads }),
    cards: run.cards.map((card) => ({ topic: card.topic, threads: card.threads.length, status: card.status })),
    sentences: { kept: run.kept.length, dropped: run.rejected.length, shareDropped: total === 0 ? 0 : run.rejected.length / total, byReason },
    negatives,
    errorClasses,
    recall,
    lagging: Object.entries(run.coverage).filter(([, value]) => value.lagging).map(([source]) => source),
  };
}

export interface MeasureReport {
  readonly cold: { readonly neurons: number; readonly modelCalls: number; readonly r2Reads: number; readonly byStage: Readonly<Record<string, number>> };
  readonly steady: { readonly neurons: number; readonly reclassified: number };
}

/** D25/D26: neurons and counters for a cold and a steady run, from prompts built on the fixture. */
export function measure(fixture: DigestFixture, recorded: RecordedResponses, profile: DigestProfile): MeasureReport {
  const run = replay(fixture, recorded, profile);
  const prompt = CLASSIFY_PROMPT.replace("{topics}", profile.taxonomy.topics.join(", "));
  const classifyNeurons = (threads: readonly Thread[]) => {
    let total = 0;
    for (let index = 0; index < threads.length; index += BATCH.classify) {
      const batch = threads.slice(index, index + BATCH.classify);
      const input = `${prompt}\n<threads>\n${batch.map((thread) => threadText(thread, { maxExcerpts: 3 })).join("\n\n")}\n</threads>`;
      const output = JSON.stringify(batch.map((thread) => ({ id: thread.displayId, ...recorded.classify[thread.displayId] })));
      total += neurons(MODELS.summarizer, estimateTokens(input), Math.min(estimateTokens(output), MAX_TOKENS.classify));
    }
    return total;
  };
  const summarize = (input: string, output: unknown, max: number) =>
    neurons(MODELS.summarizer, estimateTokens(`${SUMMARIZE_PROMPT}\n<threads>\n${input}\n</threads>`), Math.min(estimateTokens(JSON.stringify(output)), max));
  const cards = run.cards.reduce((sum, card) => sum + summarize(run.cardInputs.get(card.topic) ?? "", { sentences: card.sentences }, MAX_TOKENS.card), 0);
  const rows = run.proposals.reduce((sum, row) => sum + summarize(run.proposalInputs.get(row.key) ?? "", { sentences: row.line === null ? [] : [row.line] }, MAX_TOKENS.proposal), 0);
  const highlightsInput = `${HIGHLIGHTS_PROMPT}\n<sentences>\n${JSON.stringify(run.kept.map((entry) => entry.sentence))}\n</sentences>`;
  const highlights = neurons(MODELS.summarizer, estimateTokens(highlightsInput),
    Math.min(estimateTokens(JSON.stringify({ headline: run.headline, highlights: run.highlights.highlights })), MAX_TOKENS.highlights));
  const items = [...run.kept.map((entry) => entry.sentence.text), ...(run.headline === null ? [] : [run.headline.text]),
    ...run.highlights.highlights.flatMap((highlight) => [highlight.title, highlight.body.text])];
  let translation = 0;
  let translationCalls = 0;
  for (let index = 0; index < items.length; index += BATCH.translate) {
    const batch = items.slice(index, index + BATCH.translate);
    const input = `${TRANSLATE_PROMPT}\n<items>\n${batch.map((text) => protect(text, []).masked).join("\n")}\n</items>`;
    // zh-Hant output: about one CJK character (one token) per two English characters.
    const outputTokens = Math.ceil(batch.reduce((sum, text) => sum + text.length, 0) / 2);
    translation += neurons(MODELS.translator, estimateTokens(input), Math.min(outputTokens, MAX_TOKENS.translation));
    translationCalls += 1;
  }
  const classify = classifyNeurons(run.candidates);
  const recentStart = Date.parse(fixture.release.generatedAt) - 86_400_000;
  const changed = run.candidates.filter((thread) => Date.parse(thread.lastActivityAt) >= recentStart);
  const modelCalls = Math.ceil(run.candidates.length / BATCH.classify) + run.cards.length + run.proposals.length + 1 + translationCalls;
  return {
    cold: {
      neurons: classify + cards + rows + highlights + translation,
      modelCalls,
      r2Reads: 4 + run.candidates.length + 2 + 1,
      byStage: { classify, cards, proposals: rows, highlights, translation },
    },
    steady: { neurons: classifyNeurons(changed) + cards + rows + highlights + translation, reclassified: changed.length },
  };
}
