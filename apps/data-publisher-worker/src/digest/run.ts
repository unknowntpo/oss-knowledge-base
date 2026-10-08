/**
 * Spec 014 slice 2: one digest run. Pins a Feed release, classifies, mixes, generates (when a
 * model is configured), translates, and publishes `en`, then `zh-Hant`, then the pointer
 * (Behavior 12). Complete objects for the same release and revisions are reused; a missing or
 * incomplete `zh-Hant` is retried by translation only (B2).
 */
import {
  cardInput, CLASSIFY_PROMPT, chooseHighlights, HIGHLIGHTS_PROMPT, MAX_TOKENS, mix,
  MODELS, NO_THINK, parseClassification, PROMPT_REVISION, proposalRows, protect, rejectSentence, restore,
  parseModelJson, CLEF_EXCERPT_CHARS, CLEF_MAX_REQUESTS, CLEF_MODELS, CLEF_REVISION, clefFeatures, clefRequest, clefRequestTokens, packClefBatches,
  styleOf,
  RULES_REVISION, rulesClassify, SCORING_REVISION, selectCandidates, sourceCoverage, SUMMARIZE_PROMPT,
  threadText, TRANSLATE_PROMPT, validateSentences, digestWindowStart,
  type CitedThread, type DigestProfile, type DigestV1, type Highlight, type ProposalRow, type Provenance,
  type Sentence, type Thread, type ThreadFeatures, type TopicCard,
} from "@oss-knowledge-base/reference-pipeline";
import { sha256Digest } from "@oss-knowledge-base/serving-contract";
import { ModelCalls, type Calibration, type DigestModel, type ModelErrorShape } from "./model";
import { DigestSourceError, readPinnedRelease, type DigestBucket } from "./store";

export const DIGEST_ROOT = "public/digest/v1/";
export const CLASSIFY_BATCH = 20;
export const CLASSIFY_IN_FLIGHT = 4;
/** Slice 2c: one call holds a week's items (Behavior 16). */
export const TRANSLATE_BATCH = 60;
/** Headline plus 3 highlight titles and bodies: translation items the highlights call can add. */
const HIGHLIGHT_ITEMS = 7;

/**
 * Behavior 15 (slice 2c): calls kept back before each card: 1 highlights call, the translation
 * batches for the items so far plus 3 more card sentences and the highlights items, and 1 retry.
 */
export function reserveCalls(itemsSoFar: number): number {
  return 1 + Math.ceil((itemsSoFar + 3 + HIGHLIGHT_ITEMS) / TRANSLATE_BATCH) + 1;
}
export const HIGHLIGHT_TITLE_CHARS = 80;

export type DigestFailureKind = "source-read" | "pointer-missing" | "write" | "internal";

export interface DigestRunInput {
  readonly bucket: DigestBucket;
  readonly profile: DigestProfile;
  readonly now: () => Date;
  readonly model?: DigestModel;
  readonly delay: (ms: number) => Promise<void>;
  /** Estimated neurons already spent today and the environment's daily cap (Behavior 15). */
  readonly spentToday: number;
  readonly cap: number;
  readonly dryRun: boolean;
  readonly deferred?: number;
  /** Test and measure hooks: the per-run request ceiling and the Clef request cap. */
  readonly limits?: { readonly maxCalls?: number; readonly maxClefRequests?: number };
}

/** Slice 2c (D78, D80): the person-led measure and why generated text was dropped. */
export interface GenerationReport {
  readonly style: { readonly sentences: number; readonly personLed: number; readonly contentFree: number };
  readonly rejections: Readonly<Record<string, number>>;
}

export interface DigestRunResult {
  readonly ok: boolean;
  readonly failureKind?: DigestFailureKind;
  readonly error?: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly sourceReleaseId: string | null;
  readonly objectKeys: { readonly en: string; readonly "zh-Hant": string } | null;
  readonly reused: "pair" | "en" | "none";
  readonly candidates: number;
  readonly cached: number;
  readonly modelCalls: number;
  readonly fallbacks: number;
  readonly limited: boolean;
  readonly deferred: number;
  /** Estimated neurons spent by this run, and today's total after it. */
  readonly estimatedNeurons: number;
  readonly spentToday: number;
  readonly dryRun: boolean;
  /** D35: shapes of failed model calls (at most 10) and the token-estimate calibration. */
  readonly modelErrors: readonly ModelErrorShape[];
  readonly calibration: Calibration;
  readonly style: GenerationReport["style"];
  readonly rejections: GenerationReport["rejections"];
  /** Dry runs only (D81): raw responses of unparsable or empty calls and failed translations. */
  readonly rawSamples?: readonly RawSample[];
  /** Dry runs return both objects instead of writing them (D60). */
  readonly objects?: { readonly en: DigestV1; readonly "zh-Hant": DigestV1 };
}

type Revisions = DigestV1["revisions"];

async function hash(text: string): Promise<string> {
  return (await sha256Digest(text)).slice("sha256:".length);
}

function revisionsFor(profile: DigestProfile, model: DigestModel | undefined): Revisions {
  const none = { model: "none", prompt: "none" };
  return {
    scoring: SCORING_REVISION,
    taxonomy: profile.taxonomy.revision,
    classifier: model === undefined ? { model: RULES_REVISION, prompt: "none" }
      : model.decide !== undefined ? { model: CLEF_MODELS.flash, prompt: CLEF_REVISION }
      : { model: MODELS.summarizer, prompt: PROMPT_REVISION },
    summarizer: model === undefined ? none : { model: MODELS.summarizer, prompt: PROMPT_REVISION },
    translator: model === undefined ? none : { model: MODELS.translator, prompt: PROMPT_REVISION },
  };
}

/** `en` is complete with no model limit and no fallback; `zh-Hant` with no "Not translated" item. */
export function isComplete(digest: DigestV1): boolean {
  if (digest.coverage.limited || digest.coverage.fallbacks > 0) return false;
  return digest.locale === "en" || digest.coverage.notTranslated === 0;
}

const parseJson = parseModelJson;

export const RAW_SAMPLE_LIMIT = 10;
export const RAW_SAMPLE_CHARS = 600;

export interface RawSample {
  readonly call: string;
  readonly reason: string;
  readonly text: string;
}

/** Slice 2d (Behavior 16, D81): raw responses of rejected calls; only a dry run's result carries them. */
class RawSamples {
  readonly items: RawSample[] = [];
  add(call: string, reason: string, text: string | undefined): void {
    if (text === undefined || this.items.length >= RAW_SAMPLE_LIMIT) return;
    this.items.push({ call, reason, text: text.slice(0, RAW_SAMPLE_CHARS) });
  }
}

interface Caches {
  readonly features: Map<string, ThreadFeatures & { readonly displayId: string }>;
  readonly generated: Map<string, { readonly sentences: readonly Sentence[]; readonly provenance: Provenance }>;
  readonly translations: Map<string, string>;
}

async function loadCaches(bucket: DigestBucket, keys: readonly string[]): Promise<Caches> {
  const caches: Caches = { features: new Map(), generated: new Map(), translations: new Map() };
  for (const key of keys) {
    const digest = await bucket.getJson(key) as DigestV1 | undefined;
    if (digest?.schema !== "osskb.digest.v1") continue;
    for (const [inputHash, feature] of Object.entries(digest.features ?? {})) {
      if (feature.source !== "rules") caches.features.set(inputHash, feature);
    }
    for (const card of digest.cards ?? []) {
      if (card.provenance !== undefined && card.status === "generated") {
        caches.generated.set(card.provenance.inputHash, { sentences: card.sentences, provenance: card.provenance });
      }
    }
    for (const row of digest.proposals ?? []) {
      if (row.provenance !== undefined && row.line !== null) {
        caches.generated.set(row.provenance.inputHash, { sentences: [row.line], provenance: row.provenance });
      }
    }
    for (const [textHash, text] of Object.entries(digest.translations ?? {})) caches.translations.set(textHash, text);
  }
  return caches;
}

/** Objects already under this release and revisions, grouped by English content hash. */
async function existingPairs(bucket: DigestBucket, prefix: string) {
  const pairs = new Map<string, { en?: string; zh: string[] }>();
  for (const key of await bucket.list(prefix)) {
    const match = /^([0-9a-f]{64})\/(en\.json|zh-Hant\.[0-9a-f]{16}\.json)$/u.exec(key.slice(prefix.length));
    if (match === null) continue;
    const pair = pairs.get(match[1]!) ?? { zh: [] };
    if (match[2] === "en.json") pair.en = key;
    else pair.zh.push(key);
    pairs.set(match[1]!, pair);
  }
  return pairs;
}

export async function runDigest(input: DigestRunInput): Promise<DigestRunResult> {
  const started = input.now();
  const calls = new ModelCalls(input.model, { spent: input.spentToday, cap: input.cap }, input.delay, input.limits?.maxCalls);
  const rejections: Record<string, number> = {};
  const samples = new RawSamples();
  let styled: GenerationReport["style"] = { sentences: 0, personLed: 0, contentFree: 0 };
  const base = {
    dryRun: input.dryRun,
    deferred: input.deferred ?? 0,
  };
  const finish = (fields: Partial<DigestRunResult> & Pick<DigestRunResult, "ok" | "reused">): DigestRunResult => {
    const completed = input.now();
    return {
      sourceReleaseId: null, objectKeys: null, candidates: 0, cached: 0, fallbacks: 0,
      ...base,
      ...fields,
      completedAt: completed.toISOString(),
      durationMs: completed.getTime() - started.getTime(),
      modelCalls: calls.calls,
      limited: calls.limited || calls.partial,
      style: styled,
      rejections: { ...rejections },
      ...(input.dryRun ? { rawSamples: [...samples.items] } : {}),
      modelErrors: [...calls.errors],
      calibration: calls.calibration(),
      estimatedNeurons: calls.spentToday - input.spentToday,
      spentToday: calls.spentToday,
    };
  };

  let pinned;
  try {
    pinned = await readPinnedRelease(input.bucket, input.profile.projectKey);
  } catch (error) {
    if (error instanceof DigestSourceError) return finish({ ok: false, reused: "none", failureKind: "source-read", error: error.message });
    return finish({ ok: false, reused: "none", failureKind: "internal", error: String(error) });
  }

  try {
    const revisions = revisionsFor(input.profile, input.model);
    const revisionHash = (await hash(JSON.stringify(revisions))).slice(0, 16);
    const prefix = `${DIGEST_ROOT}${input.profile.projectId}/${pinned.release.releaseId}/${revisionHash}/`;
    const pointerKey = `${DIGEST_ROOT}${input.profile.projectId}/current.json`;
    const pairs = await existingPairs(input.bucket, prefix);
    const pointer = await input.bucket.getJson(pointerKey) as { objectKeys?: { en?: string; "zh-Hant"?: string } } | undefined;

    // Reuse a complete pair for this release and revisions (Behavior 12).
    const completeEn: { key: string; en: DigestV1; zh: string[] }[] = [];
    for (const pair of pairs.values()) {
      if (pair.en === undefined) continue;
      const en = await input.bucket.getJson(pair.en) as DigestV1;
      if (!isComplete(en)) continue;
      for (const zhKey of pair.zh) {
        const zh = await input.bucket.getJson(zhKey) as DigestV1;
        if (isComplete(zh)) {
          styled = styleOfDigest(en);
          if (!input.dryRun) await input.bucket.putPointer(pointerKey, pointerBody(pair.en, zhKey, pinned.release.releaseId));
          return finish({ ok: true, reused: "pair", sourceReleaseId: pinned.release.releaseId, objectKeys: { en: pair.en, "zh-Hant": zhKey }, candidates: en.coverage.candidates });
        }
      }
      completeEn.push({ key: pair.en, en, zh: pair.zh });
    }
    for (const pair of completeEn) {
      const en = pair.en;
      // Complete English, missing or incomplete zh-Hant: translation only (B2, D61).
      // A new pair: the reused English with this run's coverage, then zh-Hant (Behavior 18, D79).
      const caches = await loadCaches(input.bucket, [...pair.zh, ...(pointer?.objectKeys?.["zh-Hant"] === undefined ? [] : [pointer.objectKeys["zh-Hant"]])]);
      const translated = await translate(en, caches, calls, selectCandidates(pinned.entries, pinned.details, input.profile, pinned.release.generatedAt), revisions, samples);
      const pairOut = withRunCoverage(en, translated, calls, input.spentToday);
      styled = styleOfDigest(pairOut.en);
      const keys = await pairKeys(prefix, pairOut.en, pairOut.zh);
      if (!input.dryRun) {
        await input.bucket.putIfAbsent(keys.en, JSON.stringify(pairOut.en));
        await input.bucket.putIfAbsent(keys.zh, JSON.stringify(pairOut.zh));
        await input.bucket.putPointer(pointerKey, pointerBody(keys.en, keys.zh, pinned.release.releaseId));
      }
      return finish({
        ok: true, reused: "en", sourceReleaseId: pinned.release.releaseId, objectKeys: { en: keys.en, "zh-Hant": keys.zh },
        candidates: en.coverage.candidates, ...(input.dryRun ? { objects: { en: pairOut.en, "zh-Hant": pairOut.zh } } : {}),
      });
    }

    const cacheKeys = [
      ...[...pairs.values()].flatMap((pair) => [...(pair.en === undefined ? [] : [pair.en]), ...pair.zh]),
      ...Object.values(pointer?.objectKeys ?? {}).filter((key): key is string => typeof key === "string"),
    ];
    const caches = await loadCaches(input.bucket, cacheKeys);
    const composed = await compose(pinned, caches, calls, revisions, input, rejections, samples);
    const translated = await translate(composed, caches, calls, selectCandidates(pinned.entries, pinned.details, input.profile, pinned.release.generatedAt), revisions, samples);
    const { en, zh } = withRunCoverage(composed, translated, calls, input.spentToday);
    styled = styleOfDigest(en);
    const { en: enKey, zh: zhKey } = await pairKeys(prefix, en, zh);
    if (!input.dryRun) {
      // Order matters: en, then zh-Hant, then the pointer; a crash between them serves the previous digest.
      await input.bucket.putIfAbsent(enKey, JSON.stringify(en));
      await input.bucket.putIfAbsent(zhKey, JSON.stringify(zh));
      await input.bucket.putPointer(pointerKey, pointerBody(enKey, zhKey, pinned.release.releaseId));
    }
    return finish({
      ok: true, reused: "none", sourceReleaseId: pinned.release.releaseId, objectKeys: { en: enKey, "zh-Hant": zhKey },
      candidates: en.coverage.candidates, cached: en.coverage.cached, fallbacks: en.coverage.fallbacks,
      ...(input.dryRun ? { objects: { en, "zh-Hant": zh } } : {}),
    });
  } catch (error) {
    return finish({ ok: false, reused: "none", sourceReleaseId: pinned.release.releaseId, failureKind: "write", error: String(error) });
  }
}

/** Behavior 18 (slice 2c): both objects of a pair carry the run's coverage, computed after translation. */
function withRunCoverage(en: DigestV1, zh: DigestV1, calls: ModelCalls, spentBefore: number): { en: DigestV1; zh: DigestV1 } {
  const coverage = {
    ...en.coverage,
    notTranslated: zh.coverage.notTranslated,
    modelCalls: calls.calls,
    limited: calls.limited || calls.partial,
    estimatedNeurons: calls.spentToday - spentBefore,
  };
  return { en: { ...en, coverage }, zh: { ...zh, coverage } };
}

async function pairKeys(prefix: string, en: DigestV1, zh: DigestV1): Promise<{ en: string; zh: string }> {
  const contentHash = await hash(JSON.stringify(en));
  return { en: `${prefix}${contentHash}/en.json`, zh: `${prefix}${contentHash}/zh-Hant.${(await hash(JSON.stringify(zh))).slice(0, 16)}.json` };
}

function styleOfDigest(en: DigestV1): GenerationReport["style"] {
  return styleOf([...en.cards.flatMap((card) => card.sentences.map((sentence) => sentence.text)),
    ...en.proposals.flatMap((row) => (row.line === null ? [] : [row.line.text]))]);
}

function pointerBody(en: string, zh: string, sourceReleaseId: string): string {
  return JSON.stringify({ schema: "osskb.digest-pointer.v1", objectKeys: { en, "zh-Hant": zh }, sourceReleaseId });
}

async function compose(
  pinned: Awaited<ReturnType<typeof readPinnedRelease>>,
  caches: Caches,
  calls: ModelCalls,
  revisions: Revisions,
  input: DigestRunInput,
  rejections: Record<string, number>,
  samples: RawSamples,
): Promise<DigestV1> {
  const reject = (reason: string) => { rejections[reason] = (rejections[reason] ?? 0) + 1; };
  const { profile } = input;
  const windowEnd = pinned.release.generatedAt;
  const generatedAt = input.now().toISOString();
  const candidates = selectCandidates(pinned.entries, pinned.details, profile, windowEnd);
  const byId = new Map(candidates.map((thread) => [thread.displayId, thread]));
  const states = new Map<string, CitedThread>(candidates.map((thread) => [thread.displayId, thread]));
  const modelConfigured = input.model !== undefined;
  let fallbacks = 0;
  let cached = 0;
  let classifiedByModel = 0;

  // Stage 2: features, cached by hash(model input, classifier revision) (Behavior 11).
  const classifierRevision = `${revisions.classifier.model}|${revisions.classifier.prompt}`;
  const features = new Map<string, ThreadFeatures>();
  const stored: Record<string, ThreadFeatures & { displayId: string }> = {};
  const pending: { thread: Thread; inputHash: string }[] = [];
  for (const thread of candidates) {
    // The cache key is the classifier's own input: Clef sees the title and a short excerpt.
    const classifierInput = calls.decides
      ? JSON.stringify([thread.title, thread.rootExcerpt.slice(0, CLEF_EXCERPT_CHARS)])
      : threadText(thread, { maxExcerpts: 3 });
    const inputHash = await hash(`${classifierInput}\n${classifierRevision}`);
    const hit = caches.features.get(inputHash);
    if (hit !== undefined && modelConfigured) {
      const feature = { ...hit, source: "cache" as const };
      features.set(thread.displayId, feature);
      stored[inputHash] = { ...feature, displayId: thread.displayId };
      cached += 1;
    } else if (!modelConfigured) {
      const feature = rulesClassify(thread, profile);
      features.set(thread.displayId, feature);
      stored[inputHash] = { ...feature, displayId: thread.displayId };
    } else {
      pending.push({ thread, inputHash });
    }
  }
  const model = { model: revisions.classifier.model, prompt: revisions.classifier.prompt, generatedAt };
  const record = (item: { thread: Thread; inputHash: string }, feature: ThreadFeatures) => {
    if (feature.source === "model") classifiedByModel += 1;
    features.set(item.thread.displayId, feature);
    stored[item.inputHash] = { ...feature, displayId: item.thread.displayId };
  };
  if (calls.decides) {
    // Slice 2b: Clef-flash, requests packed under its state budget, 4 in flight.
    const byId = new Map(pending.map((item) => [item.thread.displayId, item]));
    const packed = packClefBatches(pending.map((item) => item.thread), profile);
    const batches = packed.slice(0, input.limits?.maxClefRequests ?? CLEF_MAX_REQUESTS);
    // Threads past the request cap get rules features; the run is limited (Behavior 6).
    for (const thread of packed.slice(batches.length).flat()) {
      record(byId.get(thread.displayId)!, rulesClassify(thread, profile));
      calls.partial = true;
    }
    for (let index = 0; index < batches.length; index += CLASSIFY_IN_FLIGHT) {
      await Promise.all(batches.slice(index, index + CLASSIFY_IN_FLIGHT).map(async (batch) => {
        const request = clefRequest(batch, profile);
        const response = await calls.decide(CLEF_MODELS.flash, request);
        const parsed = clefFeatures(response, batch, profile, model, clefRequestTokens(request));
        if (parsed.unseen) calls.canaryMisses += 1;
        if (response === undefined || parsed.fallbacks > 0) fallbacks += 1;
        for (const thread of batch) record(byId.get(thread.displayId)!, parsed.features.get(thread.displayId)!);
      }));
    }
  } else {
    const batches: { thread: Thread; inputHash: string }[][] = [];
    for (let index = 0; index < pending.length; index += CLASSIFY_BATCH) batches.push(pending.slice(index, index + CLASSIFY_BATCH));
    const prompt = CLASSIFY_PROMPT.replace("{topics}", profile.taxonomy.topics.join(", "));
    for (let index = 0; index < batches.length; index += CLASSIFY_IN_FLIGHT) {
      await Promise.all(batches.slice(index, index + CLASSIFY_IN_FLIGHT).map(async (batch) => {
        const threads = batch.map((item) => item.thread);
        const text = `${prompt}\n<threads>\n${threads.map((thread) => threadText(thread, { maxExcerpts: 3 })).join("\n\n")}\n</threads>`;
        const output = await calls.call(MODELS.summarizer, text, MAX_TOKENS.classify);
        const parsed = parseClassification(output ?? "", threads, profile, model);
        if (output === undefined) fallbacks += 1;
        for (const item of batch) record(item, parsed.features.get(item.thread.displayId)!);
      }));
    }
  }

  // Stages 3–5.
  const mixed = mix(candidates, features, profile);
  const summarizerRevision = `${revisions.summarizer.model}|${revisions.summarizer.prompt}`;
  const generate = async (call: string, threads: readonly Thread[], limit: number, ownProposal?: string, allowCall: () => boolean = () => true) => {
    const inputText = cardInput(threads);
    const inputHash = await hash(`${inputText.text}\n${limit}\n${summarizerRevision}`);
    const included = inputText.threads.map((id) => byId.get(id)!);
    const recordIds = included.flatMap((thread) => thread.records.map((record) => record.id));
    const context = { inputs: new Set(inputText.threads), threads: states, profile, ...(ownProposal === undefined ? {} : { ownProposal }) };
    const hit = caches.generated.get(inputHash);
    if (hit !== undefined) {
      cached += 1;
      return { sentences: validateSentences(hit.sentences, context, limit).kept, provenance: { ...hit.provenance, source: "cache" as const } };
    }
    if (!modelConfigured) return { sentences: [] as Sentence[], provenance: undefined };
    if (!allowCall()) {
      // Skipped to keep the reserve for highlights and translation (Behavior 15, slice 2c).
      calls.partial = true;
      fallbacks += 1;
      return { sentences: [] as Sentence[], provenance: undefined };
    }
    const max = String(limit);
    const output = await calls.call(MODELS.summarizer,
      `${SUMMARIZE_PROMPT.replace("{max}", max)}\n<threads>\n${inputText.text}\n</threads>`, limit === 1 ? MAX_TOKENS.proposal : MAX_TOKENS.card);
    const parsed = parseJson(output) as { sentences?: unknown } | undefined;
    const raw = Array.isArray(parsed?.sentences) ? parsed.sentences.filter(isSentence) : [];
    if (output !== undefined && parsed === undefined) {
      reject("unparsable");
      samples.add(call, "unparsable", output);
    } else if (output !== undefined && raw.length === 0) {
      reject("empty");
      samples.add(call, "empty", output);
    }
    const validated = validateSentences(raw, context, limit);
    for (const item of validated.rejected) reject(item.reason);
    const kept = validated.kept;
    if (kept.length === 0) {
      fallbacks += 1;
      return { sentences: [] as Sentence[], provenance: undefined };
    }
    const provenance: Provenance = {
      source: "model", model: revisions.summarizer.model, prompt: revisions.summarizer.prompt,
      inputRecordIds: recordIds, inputHash, generatedAt, reviewStatus: "unreviewed",
    };
    return { sentences: kept, provenance };
  };

  // Value order (Behavior 15, slice 2c): proposal rows, then cards by score, both within a reserve.
  const proposals: ProposalRow[] = [];
  const cards: TopicCard[] = [];
  const itemsSoFar = () => proposals.filter((row) => row.line !== null).length + cards.reduce((sum, card) => sum + card.sentences.length, 0);
  const withinReserve = () => calls.remaining > reserveCalls(itemsSoFar());
  for (const row of proposalRows(candidates, profile)) {
    const result = await generate(`proposal:${row.key}`, row.cites.map((id) => byId.get(id)).filter((thread) => thread !== undefined), 1, row.key, withinReserve);
    proposals.push({ ...row, line: result.sentences[0] ?? null, ...(result.provenance === undefined ? {} : { provenance: result.provenance }) });
  }
  for (const card of mixed.cards) {
    const result = await generate(`card:${card.topic}`, card.threads.map((id) => byId.get(id)!), 3, undefined, withinReserve);
    cards.push({
      ...card, sentences: result.sentences, status: result.sentences.length > 0 ? "generated" : "fallback",
      ...(result.provenance === undefined ? {} : { provenance: result.provenance }),
    });
  }

  // Headline and highlights (Behavior 24).
  const kept = [...cards.flatMap((card) => card.sentences), ...proposals.flatMap((row) => (row.line === null ? [] : [row.line]))];
  const titles = new Map(candidates.map((thread) => [thread.displayId, { title: thread.title, lastActivityAt: thread.lastActivityAt }]));
  let headline: Sentence | null = null;
  let valid: Highlight[] = [];
  let highlightsProvenance: Provenance | null = null;
  if (kept.length > 0 && modelConfigured) {
    const inputText = JSON.stringify(kept);
    const output = await calls.call(MODELS.summarizer, `${HIGHLIGHTS_PROMPT}\n<sentences>\n${inputText}\n</sentences>`, MAX_TOKENS.highlights);
    const parsed = parseJson(output) as { headline?: unknown; highlights?: unknown } | undefined;
    const context = { inputs: new Set(kept.flatMap((sentence) => sentence.cites)), threads: states, profile };
    const items = Array.isArray(parsed?.highlights) ? parsed.highlights : [];
    if (output !== undefined && parsed === undefined) {
      reject("unparsable");
      samples.add("highlights", "unparsable", output);
    } else if (parsed !== undefined && !isSentence(parsed.headline) && items.length === 0) {
      reject("empty");
      samples.add("highlights", "empty", output);
    }
    if (isSentence(parsed?.headline)) {
      const reason = rejectSentence(parsed.headline, context);
      if (reason === null) headline = parsed.headline;
      else reject(reason);
    }
    // D80: every dropped highlight is counted by its reason.
    valid = items.filter((item): item is Highlight => {
      if (item === null || typeof item !== "object" || !isSentence((item as Highlight).body)) {
        reject("empty");
        return false;
      }
      const reason = rejectSentence((item as Highlight).body, context);
      if (reason !== null) {
        reject(reason);
        return false;
      }
      const title = (item as Highlight).title;
      if (typeof title !== "string" || [...title].length < 1 || [...title].length > HIGHLIGHT_TITLE_CHARS) {
        reject("title");
        return false;
      }
      return true;
    }).slice(0, 3);
    if (output === undefined || (valid.length === 0 && headline === null)) fallbacks += 1;
    if (valid.length > 0 || headline !== null) {
      highlightsProvenance = {
        source: "model", model: revisions.summarizer.model, prompt: revisions.summarizer.prompt,
        inputRecordIds: [], inputHash: await hash(`${inputText}\n${summarizerRevision}`), generatedAt, reviewStatus: "unreviewed",
      };
    }
  }
  const chosen = chooseHighlights(valid, { proposals, cards, titles });
  const threads = Object.fromEntries(candidates.map((thread) => [thread.displayId, {
    title: thread.title, source: thread.source, status: thread.status, url: thread.url, score: thread.score,
    excerpt: thread.rootExcerpt.slice(0, 280), lastActivityAt: thread.lastActivityAt,
    ...(thread.records.at(-1)!.author === "unknown sender" ? {} : { author: thread.records.at(-1)!.author }),
  }]));
  const digest: DigestV1 = {
    schema: "osskb.digest.v1",
    projectId: profile.projectId,
    locale: "en",
    window: { start: digestWindowStart(windowEnd), end: windowEnd },
    generatedAt,
    sourceRelease: pinned.release,
    revisions,
    coverage: {
      candidates: candidates.length,
      classifiedByModel,
      cached,
      fallbacks,
      notTranslated: 0,
      modelCalls: calls.calls,
      limited: calls.limited || calls.partial,
      estimatedNeurons: calls.spentToday - input.spentToday,
      sources: sourceCoverage(pinned.entries, profile, windowEnd),
    },
    empty: candidates.length === 0,
    headline,
    highlights: chosen.highlights,
    highlightsProvenance,
    proposals,
    cards,
    routine: { threads: mixed.routine },
    uncategorized: { threads: mixed.uncategorized },
    threads,
    features: stored,
  };
  return digest;
}

function isSentence(value: unknown): value is Sentence {
  return value !== null && typeof value === "object" && typeof (value as Sentence).text === "string"
    && Array.isArray((value as Sentence).cites) && (value as Sentence).cites.every((cite) => typeof cite === "string");
}

interface Item {
  readonly id: string;
  readonly text: string;
  readonly names: readonly string[];
}

/** Behavior 25: translate every generated English text; failures keep English, marked. */
async function translate(
  en: DigestV1,
  caches: Caches,
  calls: ModelCalls,
  candidates: readonly Thread[],
  revisions: Revisions,
  samples: RawSamples,
): Promise<DigestV1> {
  const translatorRevision = `${revisions.translator.model}|${revisions.translator.prompt}`;
  // Names to protect: for a card or row, the authors of the records given to the model; for the
  // highlights call, candidate authors that appear in its input sentences (Behavior 25).
  const authorOf = new Map(candidates.flatMap((thread) => thread.records.map((record) => [record.id, record.author] as const)));
  const inputNames = (provenance: Provenance | undefined) => [...new Set((provenance?.inputRecordIds ?? [])
    .map((id) => authorOf.get(id)).filter((name): name is string => name !== undefined && name !== "unknown sender"))];
  const keptText = [...en.cards.flatMap((card) => card.sentences.map((sentence) => sentence.text)),
    ...en.proposals.flatMap((row) => (row.line === null ? [] : [row.line.text]))].join("\n");
  const highlightNames = [...new Set(authorOf.values())].filter((name) => name !== "unknown sender" && keptText.includes(name));
  const items: Item[] = [];
  for (const card of en.cards) {
    card.sentences.forEach((sentence, index) => items.push({ id: `card:${card.topic}:${index}`, text: sentence.text, names: inputNames(card.provenance) }));
  }
  for (const row of en.proposals) if (row.line !== null) items.push({ id: `proposal:${row.key}`, text: row.line.text, names: inputNames(row.provenance) });
  if (en.headline !== null) items.push({ id: "headline", text: en.headline.text, names: highlightNames });
  if (en.highlightsProvenance !== null) {
    en.highlights.forEach((highlight, index) => {
      items.push({ id: `highlight:${index}:title`, text: highlight.title, names: highlightNames });
      items.push({ id: `highlight:${index}:body`, text: highlight.body.text, names: highlightNames });
    });
  }
  const translations: Record<string, string> = {};
  const result = new Map<string, string | null>();
  const todo: { item: Item; textHash: string; spans: readonly string[]; masked: string }[] = [];
  for (const item of items) {
    const textHash = await hash(`${item.text}\n${translatorRevision}`);
    const hit = caches.translations.get(textHash);
    if (hit !== undefined) {
      result.set(item.id, hit);
      translations[textHash] = hit;
      continue;
    }
    const masked = protect(item.text, item.names);
    todo.push({ item, textHash, spans: masked.spans, masked: masked.masked });
  }
  for (let index = 0; index < todo.length; index += TRANSLATE_BATCH) {
    const batch = todo.slice(index, index + TRANSLATE_BATCH);
    const prompt = `${TRANSLATE_PROMPT}\n<items>\n${JSON.stringify(batch.map((entry) => ({ id: entry.item.id, text: entry.masked })))}\n</items>\n${NO_THINK}`;
    let parsed: unknown;
    for (let attempt = 0; attempt < 2 && calls.enabled; attempt += 1) {
      const output = await calls.call(MODELS.translator, prompt, MAX_TOKENS.translation);
      parsed = parseJson(output);
      if (Array.isArray(parsed)) break;
      samples.add(`translate:${index / TRANSLATE_BATCH}`, "unparsable", output);
    }
    const byId = new Map<string, string>();
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry !== null && typeof entry === "object" && typeof entry.id === "string" && typeof entry.text === "string") byId.set(entry.id, entry.text);
      }
    }
    for (const entry of batch) {
      const translatedText = byId.get(entry.item.id);
      const restored = translatedText === undefined ? null : restore(translatedText, entry.spans);
      if (restored === null) samples.add(`translate:${entry.item.id}`, translatedText === undefined ? "missing" : "placeholders", translatedText);
      result.set(entry.item.id, restored);
      if (restored !== null) translations[entry.textHash] = restored;
    }
  }
  let notTranslated = 0;
  const pick = (id: string, sentence: Sentence): Sentence => {
    const text = result.get(id);
    if (text === undefined || text === null) {
      notTranslated += 1;
      return { ...sentence, notTranslated: true };
    }
    return { ...sentence, text };
  };
  const cards = en.cards.map((card) => ({ ...card, sentences: card.sentences.map((sentence, index) => pick(`card:${card.topic}:${index}`, sentence)) }));
  const proposals = en.proposals.map((row) => (row.line === null ? row : { ...row, line: pick(`proposal:${row.key}`, row.line) }));
  const headline = en.headline === null ? null : pick("headline", en.headline);
  const highlights = en.highlightsProvenance === null ? en.highlights : en.highlights.map((highlight, index) => {
    const title = result.get(`highlight:${index}:title`);
    const titleFailed = title === undefined || title === null;
    if (titleFailed) notTranslated += 1;
    return {
      ...(titleFailed ? { title: highlight.title, titleNotTranslated: true as const } : { title }),
      body: pick(`highlight:${index}:body`, highlight.body),
    };
  });
  return {
    ...en,
    locale: "zh-Hant",
    cards,
    proposals,
    headline,
    highlights,
    coverage: { ...en.coverage, notTranslated, modelCalls: calls.calls, limited: en.coverage.limited || calls.limited || calls.partial },
    translations,
  };
}
