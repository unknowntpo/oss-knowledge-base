/**
 * Spec 014 slice 2: the digest run, its publication, recovery, and run control, from the run
 * case file plus named tests. A fake model stands in for Workers AI; R2 and Durable Object storage
 * are in memory; the published release is built from the captured slice 1 fixture.
 */
import { describe, expect, test } from "bun:test";

import {
  CLASSIFY_PROMPT, HIGHLIGHTS_PROMPT, KAFKA_DIGEST_PROFILE, rulesClassify, SUMMARIZE_PROMPT, TRANSLATE_PROMPT,
  type DigestFixture, type DigestV1, type PricedModel,
} from "@oss-knowledge-base/reference-pipeline";
import { detailPoolKey, FEED_DETAIL_POOL, MANIFEST_KEY, sha256Digest } from "@oss-knowledge-base/serving-contract";
import fixtureJson from "../../../packages/reference-pipeline/test/fixtures/topic-digest-kafka-2026-10-06.json";
import { testPlanRows } from "../../../packages/reference-pipeline/test/topic-digest-run.cases";
import {
  estimateTokens, DAILY_CAP, DAILY_NEURON_BUDGET, DIGEST_NEURON_CALIBRATION, digestLedgerNeurons, settledNeurons,
  callEstimate, CANARY_WORDS, canaryWord, clefRequest, CLEF_EXCERPT_CHARS, placement, clefStateTokens, type ClefModel, type ClefRequest, type ClefResponse,
} from "@oss-knowledge-base/reference-pipeline";
import { ModelCallError, ModelCalls, RETRY_DELAY_MS, type DigestModel } from "../src/digest/model";
import { DIGEST_ROOT, reserveCalls, runDigest, TRANSLATE_BATCH, type DigestRunInput, type DigestRunResult } from "../src/digest/run";
import { DEFER_MS, DigestRunner, publisherBusy, type DigestStorage } from "../src/digest/runner";
import type { DigestBucket } from "../src/digest/store";
import worker, { cronTarget, digestModel, mergeHealth } from "../src/index";
import { responseText, toModelCallError, WorkersAiModel, type AiBinding } from "../src/digest/workers-ai";
import { modelErrorKind, MAX_CALLS_PER_RUN } from "../src/digest/model";

const fixture = fixtureJson as unknown as DigestFixture;
const RELEASE = fixture.release.releaseId;
const NOW = new Date("2026-10-07T01:37:00.000Z");
const POINTER = `${DIGEST_ROOT}apache-kafka/current.json`;

class MemoryBucket implements DigestBucket {
  readonly objects = new Map<string, string>();
  readonly writes: string[] = [];
  readonly reads: string[] = [];
  failPutOn?: (key: string) => boolean;
  onRead?: (key: string) => void;

  async getJson(key: string): Promise<unknown> {
    this.reads.push(key);
    this.onRead?.(key);
    const body = this.objects.get(key);
    return body === undefined ? undefined : JSON.parse(body);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async putIfAbsent(key: string, body: string): Promise<boolean> {
    if (this.failPutOn?.(key)) throw new Error(`crash before ${key}`);
    if (this.objects.has(key)) return false;
    this.objects.set(key, body);
    this.writes.push(key);
    return true;
  }

  async putPointer(key: string, body: string): Promise<void> {
    if (this.failPutOn?.(key)) throw new Error(`crash before ${key}`);
    this.objects.set(key, body);
    this.writes.push(key);
  }
}

/** Publishes the captured Kafka fixture as a Feed release (manifest v3, index, detail map, pool). */
async function publish(bucket: MemoryBucket, options: { entries?: DigestFixture["entries"]; releaseId?: string; generatedAt?: string } = {}) {
  const releaseId = options.releaseId ?? RELEASE;
  const entries = options.entries ?? fixture.entries;
  const details: Record<string, string> = {};
  for (const entry of entries) {
    const detail = fixture.details[entry.displayId];
    if (detail === undefined) continue;
    const body = JSON.stringify({ entry: { id: entry.id, title: detail.title }, records: detail.records });
    const digest = await sha256Digest(body);
    details[entry.id] = digest;
    bucket.objects.set(detailPoolKey(FEED_DETAIL_POOL, digest), body);
  }
  const prefix = `public/v2/releases/${releaseId}/feed/`;
  bucket.objects.set(`${prefix}index.json`, JSON.stringify({
    entries: entries.map((entry) => ({
      displayId: entry.displayId, projectKey: entry.projectKey, status: entry.status, lastActivityAt: entry.lastActivityAt,
      sourceCounts: entry.sourceCounts, links: entry.links ?? null, entry: { id: entry.id, title: entry.title },
    })),
  }));
  bucket.objects.set(`${prefix}details.json`, JSON.stringify({ schema: "osskb.feed-detail-map.v1", releaseId, details }));
  bucket.objects.set(MANIFEST_KEY, JSON.stringify({
    schema: "osskb.feed-manifest.v3", releaseId, generatedAt: options.generatedAt ?? fixture.release.generatedAt,
    feedIndexKey: `${prefix}index.json`, detailMapKey: `${prefix}details.json`, entryCount: entries.length,
  }));
}

type Kind = "classify" | "summarize" | "highlights" | "translate";

function kindOf(prompt: string): Kind {
  if (prompt.startsWith(CLASSIFY_PROMPT.slice(0, 40))) return "classify";
  if (prompt.startsWith(SUMMARIZE_PROMPT.slice(0, 40))) return "summarize";
  if (prompt.startsWith(HIGHLIGHTS_PROMPT.slice(0, 40))) return "highlights";
  if (prompt.startsWith(TRANSLATE_PROMPT.slice(0, 40))) return "translate";
  throw new Error("unknown prompt");
}

/** A deterministic stand-in for Workers AI; `fail` decides per call whether to throw or return text. */
class FakeModel implements DigestModel {
  readonly calls: Kind[] = [];
  readonly prompts: string[] = [];
  readonly modelsUsed: PricedModel[] = [];
  readonly maxTokens: [Kind, number][] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly fail: (kind: Kind, index: number, prompt: string) => Error | string | undefined = () => undefined) {}

  async run(model: PricedModel, prompt: string, maxTokens: number): Promise<string> {
    const kind = kindOf(prompt);
    const index = this.calls.filter((item) => item === kind).length;
    this.calls.push(kind);
    this.modelsUsed.push(model);
    this.maxTokens.push([kind, maxTokens]);
    this.prompts.push(prompt);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.inFlight -= 1;
    const failure = this.fail(kind, index, prompt);
    if (failure instanceof Error) throw failure;
    if (typeof failure === "string") return failure;
    const body = prompt.slice(prompt.indexOf("\n<"));
    if (kind === "classify") {
      const ids = [...body.matchAll(/^\[([A-Z]+-[A-Za-z0-9-]+)\] (.*) \(/gmu)].map((match) => [match[1]!, match[2]!] as const);
      return JSON.stringify(ids.map(([id, title]) => {
        const rules = rulesClassify({ title }, KAFKA_DIGEST_PROFILE);
        return { id, topic: rules.topic, topicConfidence: 0.9, routine: rules.routine, routineConfidence: 0.9 };
      }));
    }
    if (kind === "summarize") {
      const id = /^\[([A-Z]+-[A-Za-z0-9-]+)\]/mu.exec(body)![1]!;
      return JSON.stringify({ sentences: [{ text: `Summary about ${id} with Andrew Schofield and KIP-1.`.replace(" and KIP-1", ""), cites: [id] }] });
    }
    if (kind === "highlights") {
      const sentences = JSON.parse(body.slice(body.indexOf("["), body.lastIndexOf("]") + 1)) as { cites: string[] }[];
      return JSON.stringify({
        headline: { text: "This week in Kafka.", cites: [sentences[0]!.cites[0]] },
        highlights: sentences.slice(0, 3).map((sentence, n) => ({ title: `Highlight ${n + 1}`, body: { text: `Body ${n + 1}.`, cites: [sentence.cites[0]] } })),
      });
    }
    const items = JSON.parse(body.slice(body.indexOf("["), body.lastIndexOf("]") + 1)) as { id: string; text: string }[];
    return JSON.stringify(items.map((item) => ({ id: item.id, text: `譯：${item.text}` })));
  }
}

/** FakeModel plus Clef-style decisions: rules topic at 0.9, routine option at 0.9 when rules say routine. */
class FakeDecider extends FakeModel {
  readonly requests: ClefRequest[] = [];
  constructor(
    fail: (kind: Kind, index: number, prompt: string) => Error | string | undefined = () => undefined,
    private readonly answer: (request: ClefRequest) => ClefResponse | Error | undefined = () => undefined,
  ) {
    super(fail);
  }

  async decide(_model: ClefModel, request: ClefRequest): Promise<ClefResponse> {
    this.requests.push(request);
    this.calls.push("classify");
    const custom = this.answer(request);
    if (custom instanceof Error) throw custom;
    if (custom !== undefined) return custom;
    const options = [...KAFKA_DIGEST_PROFILE.taxonomy.topics, "routine"];
    const threads = threadItems(request);
    const canary = { probabilities: Object.fromEntries(CANARY_WORDS.map((word) => [word, word === canaryWord(threads.length) ? 0.97 : 0.01])) };
    const answers = Object.fromEntries([...threads.map((item) => {
      const rules = rulesClassify({ title: item.title }, KAFKA_DIGEST_PROFILE);
      const probabilities = Object.fromEntries(options.map((option) => [option,
        option === "routine" ? (rules.routine ? 0.9 : 0.05) : option === rules.topic ? 0.9 : 0.01]));
      return [item.ref, { choice: rules.topic, probabilities }];
    }), ["end", canary]]);
    return { answers, usage: { prompt_tokens: Math.round(JSON.stringify(request).length / 3) } };
  }
}

const noDelay = async () => {};

/** The thread items of a Clef request (the canary excluded). */
function threadItems(request: ClefRequest): { ref: string; title: string; excerpt: string }[] {
  return request.state.filter((item): item is { ref: string; title: string; excerpt: string } => "title" in item);
}

/** A correct canary answer for a batch of `size` threads. */
function canaryAnswer(size: number, p = 0.97) {
  return { probabilities: Object.fromEntries(CANARY_WORDS.map((word) => [word, word === canaryWord(size) ? p : (1 - p) / 3])) };
}

function input(bucket: MemoryBucket, overrides: Partial<DigestRunInput> = {}): DigestRunInput {
  return { bucket, profile: KAFKA_DIGEST_PROFILE, now: () => NOW, delay: noDelay, spentToday: 0, cap: DAILY_CAP.dev, dryRun: false, ...overrides };
}

async function objects(bucket: MemoryBucket, result: DigestRunResult): Promise<{ en: DigestV1; zh: DigestV1 }> {
  return {
    en: JSON.parse(bucket.objects.get(result.objectKeys!.en)!) as DigestV1,
    zh: JSON.parse(bucket.objects.get(result.objectKeys!["zh-Hant"])!) as DigestV1,
  };
}

async function published(model?: DigestModel, overrides: Partial<DigestRunInput> = {}) {
  const bucket = new MemoryBucket();
  await publish(bucket);
  const result = await runDigest(input(bucket, { ...(model === undefined ? {} : { model }), ...overrides }));
  return { bucket, result };
}

class MemoryStorage implements DigestStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, value); }
  async delete(key: string) { return this.values.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(time: number) { this.alarm = time; }
}

type DeployConfig = { triggers?: { crons?: string[] }; vars?: Record<string, string>; ai?: { binding?: string } };
async function deployConfig(environment: "development" | "production"): Promise<DeployConfig> {
  return JSON.parse((await Bun.file(new URL(`../wrangler.${environment}.jsonc`, import.meta.url)).text()).replace(/^\s*\/\/.*$/gmu, "")) as DeployConfig;
}
const busy = (status: unknown) => (publisherBusy(status) ? "busy" : "not busy");
const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

function runner(bucket: MemoryBucket, storage: MemoryStorage, publisherBusy: () => Promise<boolean> = async () => false, model?: DigestModel) {
  let clock = NOW.getTime();
  const instance = new DigestRunner({
    storage, bucket, profile: KAFKA_DIGEST_PROFILE, environment: "development", enabled: true,
    ...(model === undefined ? {} : { model }),
    now: () => new Date(clock), delay: noDelay, publisherBusy,
  });
  return { instance, advance: (ms: number) => { clock += ms; } };
}

type CaseRow = (typeof testPlanRows)[number];
const cases: Record<string, () => Promise<string>> = {
  // D10
  "cache|constructed: previous digest has KAFKA-PR-23426 with the same model-input hash and classifier revision": async () => {
    const { bucket } = await published(new FakeModel());
    await publish(bucket, { releaseId: "next-release" });
    const model = new FakeModel();
    const result = await runDigest(input(bucket, { model }));
    const { en } = await objects(bucket, result);
    const feature = Object.values(en.features).find((item) => item.displayId === "KAFKA-PR-23426")!;
    return feature.source === "cache" && !model.calls.includes("classify") ? "features reused, 0 model calls for it" : `${feature.source} ${model.calls.join()}`;
  },
  "cache|constructed: same model-input hash, classifier prompt revision changed": async () => {
    const { bucket } = await published(new FakeModel());
    // A different revision set (no model) cannot reuse model features: it classifies by rules again.
    await publish(bucket, { releaseId: "next-release" });
    const result = await runDigest(input(bucket));
    const { en } = await objects(bucket, result);
    return Object.values(en.features).every((item) => item.source === "rules") && en.revisions.classifier.model !== "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      ? "reclassified" : "reused";
  },
  "cache|constructed: no new records, but the window slid past the oldest excerpt (input text changed)": async () => {
    const { bucket } = await published(new FakeModel());
    await publish(bucket, { releaseId: "next-release", generatedAt: "2026-10-07T13:07:37.000Z" });
    const model = new FakeModel();
    await runDigest(input(bucket, { model }));
    return model.calls.includes("classify") ? "reclassified" : "reused";
  },
  "cache|constructed: card input set and summarizer revision unchanged": async () => {
    const { bucket } = await published(new FakeModel());
    await publish(bucket, { releaseId: "next-release" });
    const model = new FakeModel();
    const result = await runDigest(input(bucket, { model }));
    const { en } = await objects(bucket, result);
    const reused = en.cards.filter((card) => card.status === "generated").every((card) => card.provenance?.source === "cache");
    return reused && !model.calls.includes("summarize") ? "summary reused, 0 model calls" : model.calls.join();
  },
  // D13
  "model down|constructed: binding throws (network) twice for a classify batch": async () => {
    const delays: number[] = [];
    let failures = 0;
    // The first batch holds the highest-scoring thread; only that batch fails, twice.
    const model = new FakeModel((kind, _index, prompt) => (kind === "classify" && prompt.includes("[KAFKA-MAIL-85a6bd91]") && failures++ < 2 ? new Error("network") : undefined));
    const { bucket, result } = await published(model, { delay: async (ms) => { delays.push(ms); } });
    const { en } = await objects(bucket, result);
    const rules = Object.values(en.features).filter((item) => item.source === "rules").length;
    return `${delays.filter((ms) => ms === RETRY_DELAY_MS).length} retry after ${RETRY_DELAY_MS / 1000} s; batch gets rules features; fallbacks +${rules}`;
  },
  "model down|constructed: summary call returns 3040 (capacity) then succeeds": async () => {
    const model = new FakeModel((kind, index) => (kind === "summarize" && index === 0 ? new ModelCallError("capacity", 3040) : undefined));
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    const retried = model.calls.filter((kind) => kind === "summarize").length === en.cards.length + en.proposals.length + 1;
    return retried && en.cards[0]!.status === "generated" ? "1 retry; generated" : "not retried";
  },
  "model down|constructed: binding throws an error with no recognizable code, twice": async () => {
    let failures = 0;
    const model = new FakeModel((kind, _index, prompt) => (kind === "classify" && prompt.includes("[KAFKA-MAIL-85a6bd91]") && failures++ < 2 ? new TypeError("something odd") : undefined));
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    const rules = Object.values(en.features).filter((item) => item.source === "rules").length;
    return model.calls.filter((kind) => kind === "classify").length === 13 && rules === 20
      ? "1 retry; batch gets rules features (unidentified errors are retried like 3040)" : `${rules}`;
  },
  "model down|constructed: every call fails": async () => {
    const { bucket, result } = await published(new FakeModel(() => new Error("down")));
    const { en } = await objects(bucket, result);
    const rules = await published();
    const rulesEn = (await objects(rules.bucket, rules.result)).en;
    return result.ok && en.cards.every((card) => card.status === "fallback")
      && JSON.stringify(en.proposals.map((row) => [row.key, row.stages])) === JSON.stringify(rulesEn.proposals.map((row) => [row.key, row.stages]))
      ? "digest published; all cards fallback (keywords + threads); KIP block unchanged" : "not published";
  },
  // D14
  "rate limit|constructed: error 3036 (daily free allocation used)": async () => {
    const model = new FakeModel((kind, index) => (kind === "classify" && index === 0 ? new ModelCallError("allocation", 3036) : undefined));
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    // Batches already in flight finish; nothing starts after the limit, and nothing is retried.
    return model.calls.length <= 4 && model.calls.every((kind) => kind === "classify") && result.limited && en.cards.every((card) => card.status === "fallback")
      ? "no retry; remaining calls skipped; limited true; fallback" : `${model.calls.length}`;
  },
  "rate limit|constructed: AI Gateway 429 (gateway rate limit)": async () => {
    const model = new FakeModel((kind, index) => (kind === "classify" && index === 0 ? new ModelCallError("rate limited", undefined, 429) : undefined));
    const { result } = await published(model);
    return model.calls.length <= 4 && model.calls.every((kind) => kind === "classify") && result.limited
      ? "no retry; remaining calls skipped; limited true; fallback" : `${model.calls.length}`;
  },
  // D17
  "empty|constructed: 0 candidates": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket, { entries: fixture.entries.filter((entry) => entry.lastActivityAt < "2026-09-01") });
    const model = new FakeModel();
    const result = await runDigest(input(bucket, { model }));
    const { en } = await objects(bucket, result);
    return result.ok && en.empty && model.calls.length === 0 ? "digest published, empty true, 0 model calls" : "not empty";
  },
  // D9
  "provenance|constructed: a generated card, a proposal line, and a model feature": async () => {
    const { bucket, result } = await published(new FakeModel());
    const { en } = await objects(bucket, result);
    const card = en.cards.find((item) => item.status === "generated")!;
    const row = en.proposals.find((item) => item.line !== null)!;
    const feature = Object.values(en.features).find((item) => item.source === "model")!;
    const complete = [card.provenance, row.provenance].every((provenance) => provenance !== undefined
      && provenance.model.length > 0 && provenance.prompt.length > 0 && provenance.inputRecordIds.length > 0
      && provenance.generatedAt === NOW.toISOString() && provenance.reviewStatus === "unreviewed")
      && feature.model !== undefined && feature.prompt !== undefined && feature.generatedAt !== undefined;
    return complete ? "each records model, prompt revision, input record ids (cards and rows), generatedAt; cards and rows reviewStatus unreviewed" : "missing";
  },
  // D55
  "highlights call|constructed: the headline-and-highlights call fails twice": async () => {
    const { bucket, result } = await published(new FakeModel((kind) => (kind === "highlights" ? new Error("down") : undefined)));
    const { en } = await objects(bucket, result);
    return result.ok && en.headline === null && en.highlightsProvenance === null && en.highlights.length === 3
      ? "fallback highlights, no headline; run continues" : "wrong";
  },
  // D50
  "translate|constructed: the translation batch returns non-JSON twice": async () => {
    const model = new FakeModel((kind, index) => (kind === "translate" && index < 2 ? "Sure, here is the translation" : undefined));
    const { bucket, result } = await published(model);
    const { zh } = await objects(bucket, result);
    const sentences = [...zh.cards.flatMap((card) => card.sentences), ...zh.proposals.flatMap((row) => (row.line ? [row.line] : []))];
    const items = sentences.length + (zh.headline === null ? 0 : 1) + zh.highlights.length * 2;
    const batches = Math.ceil(items / TRANSLATE_BATCH);
    const firstBatch = sentences.slice(0, TRANSLATE_BATCH);
    const laterTranslated = items <= TRANSLATE_BATCH || sentences.slice(TRANSLATE_BATCH).every((sentence) => sentence.notTranslated !== true);
    return model.calls.filter((kind) => kind === "translate").length === batches + 1 && firstBatch.every((sentence) => sentence.notTranslated === true) && laterTranslated && result.ok
      ? "1 retry of that batch only; every item in it Not translated; zh-Hant published" : `${batches} ${model.calls.filter((kind) => kind === "translate").length}`;
  },
  "translate|constructed: the translation omits one item and adds an unknown id": async () => {
    const model = new FakeModel();
    const original = model.run.bind(model);
    model.run = async (name, prompt, max) => {
      const output = await original(name, prompt, max);
      if (kindOf(prompt) !== "translate") return output;
      const items = JSON.parse(output) as { id: string; text: string }[];
      return JSON.stringify([...items.slice(1), { id: "card:nope:9", text: "x" }]);
    };
    const { bucket, result } = await published(model);
    const { zh } = await objects(bucket, result);
    const sentences = zh.cards.flatMap((card) => card.sentences);
    return sentences[0]!.notTranslated === true && sentences.slice(1).every((sentence) => sentence.text.startsWith("譯："))
      ? "that item Not translated; unknown id ignored; the rest translated" : "wrong";
  },
  // D61
  "recovery|constructed: en written, crash before zh-Hant": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    bucket.failPutOn = (key) => key.includes("/zh-Hant.");
    const crashed = await runDigest(input(bucket, { model: new FakeModel() }));
    bucket.failPutOn = undefined;
    const model = new FakeModel();
    const retry = await runDigest(input(bucket, { model }));
    const order = bucket.writes.slice(-2);
    return !crashed.ok && retry.reused === "en" && model.calls.every((kind) => kind === "translate") && order[0]!.includes("/zh-Hant.") && order[1] === POINTER
      ? "retry writes zh-Hant then the pointer; 0 classify or summary calls" : `${retry.reused} ${model.calls.join()}`;
  },
  "recovery|constructed: published zh-Hant has a Not translated item": async () => {
    const first = await published(new FakeModel((kind, index) => (kind === "translate" && index < 2 ? "not json" : undefined)));
    const missing = (await objects(first.bucket, first.result)).zh.coverage.notTranslated;
    const model = new FakeModel();
    const retry = await runDigest(input(first.bucket, { model }));
    const { zh } = await objects(first.bucket, retry);
    const sent = model.prompts.reduce((sum, prompt) => sum + (prompt.match(/"id":/gu) ?? []).length, 0);
    return retry.reused === "en" && model.calls.every((kind) => kind === "translate") && zh.coverage.notTranslated === 0 && sent === missing && missing > 0
      ? "next run translates only the Not translated items; new zh-Hant has 0 Not translated" : `${retry.reused} sent ${sent} of ${missing}`;
  },
  // D19
  "recovery|constructed: en and zh-Hant written, crash before the pointer": async () => {
    const { bucket } = await published(new FakeModel());
    const previous = bucket.objects.get(POINTER);
    await publish(bucket, { releaseId: "next-release" });
    bucket.failPutOn = (key) => key === POINTER;
    const crashed = await runDigest(input(bucket, { model: new FakeModel() }));
    const served = bucket.objects.get(POINTER);
    bucket.failPutOn = undefined;
    const model = new FakeModel();
    const retry = await runDigest(input(bucket, { model }));
    return !crashed.ok && served === previous && retry.reused === "pair" && model.calls.length === 0 && bucket.writes.at(-1) === POINTER
      ? "previous pointer served until the retry; retry writes only the pointer, 0 model calls" : `${retry.reused}`;
  },
  "recovery|constructed: a limited en for the same release": async () => {
    const { bucket } = await published(new FakeModel((kind, index) => (kind === "summarize" && index === 0 ? new ModelCallError("allocation", 3036) : undefined)));
    const model = new FakeModel();
    const retry = await runDigest(input(bucket, { model }));
    const { en } = await objects(bucket, retry);
    return retry.reused === "none" && !en.coverage.limited && Object.values(en.features).some((item) => item.source === "cache")
      ? "next run publishes a new pair; the limited en is used as a cache" : `${retry.reused}`;
  },
  // D11
  "publication|constructed: a run with a fake model": async () => {
    const { bucket, result } = await published(new FakeModel());
    const writes = bucket.writes;
    const pointer = JSON.parse(bucket.objects.get(POINTER)!) as Record<string, unknown>;
    return writes.length === 3 && writes[0]!.endsWith("/en.json") && writes[1]!.includes("/zh-Hant.") && writes[2] === POINTER
      && JSON.stringify(Object.keys(pointer)) === JSON.stringify(["schema", "objectKeys", "sourceReleaseId"])
      && JSON.stringify(pointer.objectKeys) === JSON.stringify(result.objectKeys)
      ? "writes en, then zh-Hant, then the pointer {schema, objectKeys, sourceReleaseId}" : writes.join();
  },
  // D20
  "publication|constructed: a new Feed release is published while the run reads Details": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    let switched = false;
    bucket.onRead = (key) => {
      if (!switched && key.startsWith(FEED_DETAIL_POOL)) {
        switched = true;
        void publish(bucket, { releaseId: "later-release" });
      }
    };
    const result = await runDigest(input(bucket));
    const readLater = bucket.reads.some((key) => key.includes("later-release"));
    return result.sourceReleaseId === RELEASE && !readLater
      ? "digest names the pinned release; no object from the new release is read" : `${result.sourceReleaseId}`;
  },
  // D37
  "highlights|constructed: the fake model returns a headline and 3 highlights citing kept sentences": async () => {
    const { bucket, result } = await published(new FakeModel());
    const { en } = await objects(bucket, result);
    return en.headline !== null && en.highlights.length === 3 && en.highlightsProvenance?.source === "model"
      ? "headline and 3 highlights published, each validated" : "missing";
  },
  // D59
  "deferral|constructed: publisher running at 4 consecutive alarms": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    const { instance, advance } = runner(bucket, storage, async () => true);
    const rearmed: number[] = [];
    for (let n = 0; n < 4; n += 1) {
      await instance.alarm();
      rearmed.push(storage.alarm! - (NOW.getTime() + n * 15 * 60_000));
      advance(DEFER_MS);
    }
    return rearmed.every((delta) => delta === 15 * 60_000) && DEFER_MS === 15 * 60_000 && storage.values.get("lastRun") === undefined
      ? "re-armed 15 min later each time; no run" : rearmed.join();
  },
  "deferral|constructed: publisher still running at the 5th alarm": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    const { instance } = runner(bucket, storage, async () => true);
    for (let n = 0; n < 5; n += 1) await instance.alarm();
    const lastRun = storage.values.get("lastRun") as DigestRunResult | undefined;
    return lastRun?.ok === true ? `runs; lastRun.deferred ${lastRun.deferred}` : "no run";
  },
  // D22
  "run control|constructed: POST /digest/run while an alarm is pending": async () => {
    const storage = new MemoryStorage();
    const { instance } = runner(new MemoryBucket(), storage);
    const first = await instance.request(false);
    const second = await instance.request(false);
    return first.status === 202 && second.status === 409 ? `409 ${(second.body as { skipped: string }).skipped}` : `${second.status}`;
  },
  "run control|constructed: digest cron unset; cron 7 22 * * * fires": async () => cronTarget("7 22 * * *", undefined),
  "run control|constructed: digest cron 37 1 * * * set; it fires": async () => cronTarget("37 1 * * *", "37 1 * * *"),
  // D60
  "dry run|constructed: POST /digest/run?dryRun=1": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const before = bucket.objects.size;
    const storage = new MemoryStorage();
    const { instance } = runner(bucket, storage, async () => false, new FakeModel());
    const response = await instance.request(true);
    const body = response.body as DigestRunResult;
    const health = await instance.health();
    return response.status === 200 && body.objects?.en.locale === "en" && body.objects["zh-Hant"].locale === "zh-Hant"
      && bucket.writes.length === 0 && bucket.objects.size === before && health.today.estimatedNeurons > 0 && health.lastRun?.dryRun === true
      ? "returns en and zh-Hant; 0 R2 writes; spend added to today; lastRun.dryRun true" : `${response.status} ${bucket.writes.length}`;
  },
  // Added after the slice 2 mutation run.
  "rate limit|constructed: today's estimated spend already at the daily cap": async () => {
    const model = new FakeModel();
    const { bucket, result } = await published(model, { spentToday: DAILY_CAP.dev });
    const { en } = await objects(bucket, result);
    return model.calls.length === 0 && result.limited && Object.values(en.features).every((item) => item.source === "rules") && en.cards.every((card) => card.status === "fallback")
      ? "no model call; limited true; rules features and fallback cards" : `${model.calls.length}`;
  },
  "recovery|constructed: an en with a model fallback (a card's summary failed) for the same release": async () => {
    // The text-model classifier of this constructed run plus two charged failures reach about 4,800
    // estimated neurons since digest-prompts@5 (D103); a higher cap keeps this row about fallbacks, not the cap.
    const { bucket, result } = await published(new FakeModel((kind, index) => (kind === "summarize" && index < 2 ? new Error("down") : undefined)), { cap: 10_000 });
    const { en } = await objects(bucket, result);
    const retry = await runDigest(input(bucket, { model: new FakeModel() }));
    return en.coverage.fallbacks > 0 && !en.coverage.limited && retry.reused === "none" && retry.objectKeys!.en !== result.objectKeys!.en
      ? "next run is not a reuse; it publishes a new pair" : `${retry.reused}`;
  },
  "translate|constructed: the translation drops one item's placeholder": async () => {
    const model = new FakeModel();
    const original = model.run.bind(model);
    model.run = async (name, prompt, max) => {
      const output = await original(name, prompt, max);
      if (kindOf(prompt) !== "translate") return output;
      const items = JSON.parse(output) as { id: string; text: string }[];
      return JSON.stringify(items.map((item, index) => (index === 0 ? { ...item, text: item.text.replace(/⟦\d+⟧/gu, "") } : item)));
    };
    const { bucket, result } = await published(model);
    const { en, zh } = await objects(bucket, result);
    const first = zh.cards[0]!.sentences[0]!;
    const noPlaceholders = !JSON.stringify(zh).includes("⟦");
    return first.notTranslated === true && first.text === en.cards[0]!.sentences[0]!.text && noPlaceholders
      ? "that item Not translated (English kept); no placeholder text in zh-Hant" : `${first.text}`;
  },
  "translate|constructed: a card sentence \"… (KAFKA-PR-n, open).\" is translated with 已合併 in its parentheses": async () => {
    const model = new FakeModel((kind, _index, prompt) => {
      if (kind !== "summarize") return undefined;
      const id = /^\[([A-Z]+-[A-Za-z0-9-]+)\]/mu.exec(prompt.slice(prompt.indexOf("\n<")))![1]!;
      return JSON.stringify({ sentences: [{ text: `The change would land (${id}, open).`, cites: [id] }] });
    });
    const original = model.run.bind(model);
    let drifted = "";
    model.run = async (name, prompt, max) => {
      const output = await original(name, prompt, max);
      if (kindOf(prompt) !== "translate") return output;
      const items = JSON.parse(output) as { id: string; text: string }[];
      drifted = items.find((item) => item.id.startsWith("card:"))!.id;
      return JSON.stringify(items.map((item) => ({ ...item, text: item.text.replace(", open)", item.id === drifted ? ", 已合併)" : ", 仍在進行)") })));
    };
    const { bucket, result } = await published(model);
    const { en, zh } = await objects(bucket, result);
    const [, topic, index] = drifted.split(":");
    const card = zh.cards.find((item) => item.topic === topic)!;
    const enCard = en.cards.find((item) => item.topic === topic)!;
    const item = card.sentences[Number(index)]!;
    const cachedValues = Object.values(zh.translations ?? {});
    const others = zh.cards.flatMap((each) => each.sentences).filter((sentence) => sentence !== item);
    return item.notTranslated === true && item.text === enCard.sentences[Number(index)]!.text
      && result.rejections["translate:status-drift"] === 1 && !cachedValues.some((text) => text.includes("已合併"))
      && others.length > 0 && others.every((sentence) => sentence.notTranslated !== true)
      ? "that item Not translated (English kept); rejections[\"translate:status-drift\"] 1; not cached; the other items translated"
      : JSON.stringify({ item, rejections: result.rejections });
  },
  "translate|constructed: Kafka profile with glossary kafka-glossary@2": async () => {
    const model = new FakeModel();
    const { bucket, result } = await published(model);
    const { zh } = await objects(bucket, result);
    const prompts = model.prompts.filter((prompt) => kindOf(prompt) === "translate");
    return `revisions.translator.prompt ${zh.revisions.translator.prompt}; ${prompts.length > 0 && prompts.every((prompt) => prompt.includes("offloading → 卸載") && prompt.includes("磁碟 not 磁盤")) ? "every translation prompt lists offloading → 卸載 and 磁碟 not 磁盤" : "glossary missing"}`;
  },
  "highlights|constructed: one highlight cites a thread that no kept sentence cites": async () => {
    const model = new FakeModel();
    const original = model.run.bind(model);
    model.run = async (name, prompt, max) => {
      const output = await original(name, prompt, max);
      if (kindOf(prompt) !== "highlights") return output;
      const parsed = JSON.parse(output) as { highlights: { body: { cites: string[] } }[] };
      parsed.highlights[0]!.body.cites = ["KAFKA-PR-99999"];
      return JSON.stringify(parsed);
    };
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    return en.highlights.length === 2 && en.highlights.every((item) => !item.body.cites.includes("KAFKA-PR-99999"))
      ? "that highlight dropped; the other 2 shown" : `${en.highlights.length}`;
  },
  "publication|constructed: the detail map names a different release than the manifest": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const mapKey = `public/v2/releases/${RELEASE}/feed/details.json`;
    bucket.objects.set(mapKey, JSON.stringify({ ...JSON.parse(bucket.objects.get(mapKey)!), releaseId: "other-release" }));
    const result = await runDigest(input(bucket));
    return !result.ok && result.failureKind === "source-read" && bucket.writes.length === 0 ? "source-read failure; nothing written" : `${result.failureKind}`;
  },
  // Added after the PR #35 verifier mutation pass.
  "run control|constructed: DIGEST_CRON 37 1 * * * set; the publisher cron 7 22 * * * fires": async () => cronTarget("7 22 * * *", "37 1 * * *"),
  "dry run|constructed: two dry runs on the same UTC day": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    const { instance } = runner(bucket, storage, async () => false, new FakeModel());
    const first = (await instance.request(true)).body as DigestRunResult;
    const second = (await instance.request(true)).body as DigestRunResult;
    const today = (await instance.health()).today.estimatedNeurons;
    return first.estimatedNeurons > 0 && today === first.estimatedNeurons + second.estimatedNeurons && second.spentToday === today
      ? "today.estimatedNeurons is the sum of both runs" : `${first.estimatedNeurons} ${second.estimatedNeurons} ${today}`;
  },
  "dry run|constructed: a dry run's stored lastRun": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const keys = [...bucket.objects.keys()].sort().join();
    const storage = new MemoryStorage();
    const { instance } = runner(bucket, storage, async () => false, new FakeModel());
    await instance.request(true);
    const stored = storage.values.get("lastRun") as Record<string, unknown>;
    return !("objects" in stored) && [...bucket.objects.keys()].sort().join() === keys ? "no objects stored; R2 keys unchanged" : "stored";
  },
  "highlights call|constructed: the highlights call fails; same release runs again": async () => {
    const { bucket, result } = await published(new FakeModel((kind) => (kind === "highlights" ? new Error("down") : undefined)));
    const { en } = await objects(bucket, result);
    const retry = await runDigest(input(bucket, { model: new FakeModel() }));
    return en.coverage.fallbacks > 0 && retry.reused === "none" ? "fallbacks counted; the next run is not a reuse" : `${en.coverage.fallbacks} ${retry.reused}`;
  },
  "cache|constructed: a classify batch fell back to rules; the next run has a working model": async () => {
    let failures = 0;
    const { bucket, result } = await published(new FakeModel((kind, _index, prompt) =>
      (kind === "classify" && prompt.includes("[KAFKA-MAIL-85a6bd91]") && failures++ < 2 ? new Error("down") : undefined)));
    const before = (await objects(bucket, result)).en;
    const ruled = Object.values(before.features).filter((item) => item.source === "rules").map((item) => item.displayId);
    await publish(bucket, { releaseId: "next-release" });
    const model = new FakeModel();
    const retry = await runDigest(input(bucket, { model }));
    const after = (await objects(bucket, retry)).en;
    const now = ruled.map((id) => Object.values(after.features).find((item) => item.displayId === id)!.source);
    return ruled.length === 20 && now.every((source) => source === "model") && model.calls.includes("classify")
      ? "those threads are classified by the model, not served from cache" : `${ruled.length} ${now.join()}`;
  },
  "window|constructed: a run on the captured release": async () => {
    const { bucket, result } = await published();
    const { en } = await objects(bucket, result);
    return Date.parse(en.window.end) - Date.parse(en.window.start) === 7 * 86_400_000 && en.window.end === fixture.release.generatedAt
      ? "window.start is window.end minus 7 days" : `${en.window.start} ${en.window.end}`;
  },
  "window|constructed: an entry whose newest activity is exactly the window start": async () => {
    const start = new Date(Date.parse(fixture.release.generatedAt) - 7 * 86_400_000).toISOString();
    const entry = { ...fixture.entries.find((item) => item.displayId === "KAFKA-PR-23426")!, lastActivityAt: start };
    const original = fixture.details["KAFKA-PR-23426"]!;
    const details = { ...fixture.details, "KAFKA-PR-23426": { ...original, records: original.records.map((record, index) => (index === 0 ? { ...record, author: "boundary", occurredAt: start } : record)).slice(0, 1) } };
    const bucket = new MemoryBucket();
    const saved = fixture.details;
    (fixture as { details: unknown }).details = details;
    try {
      await publish(bucket, { entries: [entry] });
    } finally {
      (fixture as { details: unknown }).details = saved;
    }
    const result = await runDigest(input(bucket));
    const read = bucket.reads.some((key) => key.startsWith(FEED_DETAIL_POOL));
    return read && result.candidates === 1 ? "its Detail is read and it is a candidate" : `${read} ${result.candidates}`;
  },
  "publication|constructed: the Feed manifest is v2": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const manifest = JSON.parse(bucket.objects.get(MANIFEST_KEY)!) as Record<string, unknown>;
    bucket.objects.set(MANIFEST_KEY, JSON.stringify({ ...manifest, schema: "osskb.feed-manifest.v2", detailPrefix: "public/v2/releases/x/details/" }));
    const result = await runDigest(input(bucket));
    return !result.ok && result.failureKind === "source-read" && bucket.writes.length === 0 ? "source-read failure; nothing written" : `${result.failureKind}`;
  },
  "publication|constructed: the pointer's schema": async () => {
    const { bucket } = await published();
    return (JSON.parse(bucket.objects.get(POINTER)!) as { schema: string }).schema;
  },
  "model down|constructed: a cold run classifies 12 batches": async () => {
    const model = new FakeModel();
    const bucket = new MemoryBucket();
    await publish(bucket);
    const tracked: number[] = [];
    const original = model.run.bind(model);
    model.run = async (name, prompt, max) => {
      const output = original(name, prompt, max);
      if (kindOf(prompt) === "classify") tracked.push(model.inFlight);
      return output;
    };
    await runDigest(input(bucket, { model }));
    const peak = Math.max(...tracked);
    return peak <= 4 && peak === 4 ? "at most 4 classify calls in flight, and 4 reached" : `${peak}`;
  },
  "spend|constructed: today's spend plus the next call's estimate equals the cap exactly": async () => {
    const prompt = "x".repeat(4_000);
    const estimate = digestLedgerNeurons(callEstimate("@cf/meta/llama-3.3-70b-instruct-fp8-fast", prompt, 300));
    const model: DigestModel = { run: async () => "ok" };
    const calls = new ModelCalls(model, { spent: 4_500 - estimate, cap: 4_500 }, noDelay);
    const output = await calls.call("@cf/meta/llama-3.3-70b-instruct-fp8-fast", prompt, 300);
    const over = new ModelCalls(model, { spent: 4_501 - estimate, cap: 4_500 }, noDelay);
    const skipped = await over.call("@cf/meta/llama-3.3-70b-instruct-fp8-fast", prompt, 300);
    return output === "ok" && skipped === undefined && over.limited ? "the call runs" : `${output} ${skipped}`;
  },
  "spend|constructed: a call that fails twice": async () => {
    const prompt = "x".repeat(4_000);
    const estimate = digestLedgerNeurons(callEstimate("@cf/meta/llama-3.3-70b-instruct-fp8-fast", prompt, 300));
    const calls = new ModelCalls({ run: async () => { throw new Error("down"); } }, { spent: 100, cap: 4_500 }, noDelay);
    await calls.call("@cf/meta/llama-3.3-70b-instruct-fp8-fast", prompt, 300);
    return calls.spentToday === 100 + 2 * estimate && calls.calls === 2 ? "both attempts add the pre-call estimate to today's spend (G21)" : `${calls.spentToday}`;
  },
  "deferral|constructed: a deferred run completes, then the publisher runs at the next alarm": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    let publisherBusy = true;
    const { instance } = runner(bucket, storage, async () => publisherBusy);
    for (let n = 0; n < 5; n += 1) await instance.alarm();
    const ranOnce = (storage.values.get("lastRun") as DigestRunResult).deferred === 4;
    storage.values.delete("lastRun");
    publisherBusy = true;
    await instance.alarm();
    return ranOnce && storage.values.get("lastRun") === undefined && storage.values.get("deferrals") === 1
      ? "the counter restarted: the alarm defers again" : "ran";
  },
  "deferral|constructed: 2 deferrals recorded, then POST /digest/run": async () => {
    const storage = new MemoryStorage();
    storage.values.set("deferrals", 2);
    const { instance } = runner(new MemoryBucket(), storage);
    const response = await instance.request(false);
    return response.status === 202 && !storage.values.has("deferrals") ? "counter cleared; the new alarm can defer 4 times" : `${storage.values.get("deferrals")}`;
  },
  // PR #40 verifier rows.
  "clef|constructed: Clef reports 1,000 prompt tokens for a request the job estimated at 1,500": async () => clefWithUsage(1_000, 1_500),
  "clef|constructed: a whole run where every Clef response reports 1 prompt token": async () => {
    const truncated = new FakeDecider();
    const original = truncated.decide.bind(truncated);
    truncated.decide = async (model, request) => ({ ...(await original(model, request)), usage: { prompt_tokens: 1 } });
    const { bucket, result } = await published(truncated);
    const { en } = await objects(bucket, result);
    const sources = new Set(Object.values(en.features).map((item) => item.source));
    return sources.size === 1 && sources.has("rules") && en.coverage.fallbacks >= truncated.requests.length && truncated.requests.length > 0
      ? "every thread gets rules features; every batch counted as a fallback" : `${[...sources]} ${en.coverage.fallbacks}/${truncated.requests.length}`;
  },
  "clef|constructed: Clef reports 1,400 prompt tokens for a request estimated at 1,500": async () => clefWithUsage(1_400, 1_500),
  "spend|constructed: a Clef decide with today's spend exactly at the cap": async () => {
    const { clefRequest, neurons: price } = await import("@oss-knowledge-base/reference-pipeline");
    const thread = { displayId: "KAFKA-PR-1", entryId: "e", title: "t", source: "github" as const, status: "open", url: null, rootExcerpt: "", records: [], score: 1, lastActivityAt: NOW.toISOString() };
    const request = clefRequest([thread], KAFKA_DIGEST_PROFILE);
    const decider = new FakeDecider();
    const calls = new ModelCalls(decider, { spent: 4_500, cap: 4_500 }, noDelay);
    const roomy = new ModelCalls(new FakeDecider(), { spent: 0, cap: 4_500 }, noDelay);
    const answered = await roomy.decide("@cf/cloudflare/clef-flash", request);
    // A request small enough that its raw price rounds to 0 neurons must still be gated.
    const tiny = clefRequest([], KAFKA_DIGEST_PROFILE);
    const result = await calls.decide("@cf/cloudflare/clef-flash", tiny);
    const raw = price("@cf/cloudflare/clef-flash", 50, 0);
    return result === undefined && calls.limited && decider.requests.length === 0 && answered !== undefined && roomy.spentToday >= 1 && raw === 0
      ? "skipped; limited true; the pre-call estimate is at least 1 neuron" : `${calls.limited} ${roomy.spentToday} ${raw}`;
  },
  "gateway|constructed: a text-generation request through WorkersAiModel": async () => {
    const bodies: Record<string, unknown>[] = [];
    const ai: AiBinding = { run: async (_model, inputs) => { bodies.push(inputs); return { response: "ok" }; } };
    await new WorkersAiModel(ai, "osskb-digest-dev").run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", "p", 300);
    const body = bodies[0]!;
    return Array.isArray(body.messages) && body.max_tokens === 300 && body.temperature === 0 ? "body has messages, max_tokens, temperature 0" : JSON.stringify(body);
  },
  "clef|constructed: a run with the Clef decider": async () => {
    const { bucket, result } = await published(new FakeDecider());
    const { en } = await objects(bucket, result);
    return `revisions.classifier is ${en.revisions.classifier.model} with ${en.revisions.classifier.prompt}`;
  },
  "dry run|constructed: the model reports twice the estimated input tokens": async () => {
    const calls = new ModelCalls({ run: async (_model, prompt) => ({ text: "ok", usage: { prompt_tokens: 2 * estimateTokens(prompt) } }) }, { spent: 0, cap: 4_500 }, noDelay);
    await calls.call("@cf/qwen/qwen3-30b-a3b-fp8", "x".repeat(400), 10);
    return `calibration ratio ${calls.calibration().ratio}`;
  },
  "dry run|constructed: 2 text calls with usage, then 2 Clef requests of which 1 reports usage": async () => {
    let clef = 0;
    const calls = new ModelCalls({
      run: async () => ({ text: "ok", usage: { prompt_tokens: 10 } }),
      decide: async () => (clef++ === 0 ? { answers: {}, usage: { prompt_tokens: 10 } } : { answers: {} }),
    }, { spent: 0, cap: 4_500 }, noDelay);
    await calls.call("@cf/qwen/qwen3-30b-a3b-fp8", "x".repeat(40), 10);
    await calls.call("@cf/qwen/qwen3-30b-a3b-fp8", "x".repeat(40), 10);
    const { clefRequest } = await import("@oss-knowledge-base/reference-pipeline");
    const request = clefRequest([], KAFKA_DIGEST_PROFILE);
    await calls.decide("@cf/cloudflare/clef-flash", request);
    await calls.decide("@cf/cloudflare/clef-flash", request);
    const c = calls.calibration();
    return `calls ${c.calls}, callsWithUsage ${c.callsWithUsage}, clefCalls ${c.clefCalls}, clefCallsWithUsage ${c.clefCallsWithUsage}`;
  },
  // Slice 2b.
  "clef|constructed: answer t1 security 0.7, clients 0.2, other 0.1, routine 0.1": async () => {
    const feature = await oneClef({ security: 0.7, clients: 0.2, other: 0.1, routine: 0.1 });
    return `topic ${feature.topic}, topicConfidence ${feature.topicConfidence.toFixed(2)}, routine ${feature.routine} (${feature.routineConfidence.toFixed(2)})`;
  },
  "clef|constructed: answer t1 routine 0.45, other 0.55": async () => {
    const feature = await oneClef({ routine: 0.45, other: 0.55 });
    return `topic ${feature.topic}, topicConfidence ${feature.topicConfidence.toFixed(2)}, routine ${feature.routine} (${feature.routineConfidence.toFixed(2)})`;
  },
  "clef|constructed: answer t1 routine 0.5, other 0.25, security 0.25": async () => {
    const feature = await oneClef({ routine: 0.5, other: 0.25, security: 0.25 });
    return `topic ${feature.topic}, topicConfidence ${feature.topicConfidence.toFixed(2)}, routine ${feature.routine} (${feature.routineConfidence.toFixed(2)})`;
  },
  "clef|constructed: 70 threads with one-letter titles and no excerpt": async () => {
    const { packClefBatches } = await import("@oss-knowledge-base/reference-pipeline");
    const threads = Array.from({ length: 70 }, (_, index) => ({ displayId: `KAFKA-PR-${index}`, entryId: "e", title: "x", source: "github" as const, status: "open", url: null, rootExcerpt: "", records: [], score: 1, lastActivityAt: NOW.toISOString() }));
    const batches = packClefBatches(threads, KAFKA_DIGEST_PROFILE);
    const each = batches.every((batch) => Object.keys(clefRequest(batch, KAFKA_DIGEST_PROFILE).questions).length === batch.length + 1);
    return `${batches.length} requests: ${batches.map((batch) => batch.length).join(" + ")} thread questions${each ? ", each plus the canary" : ""}`;
  },
  "clef|constructed: answer t1 routine 0.6, other 0.4": async () => {
    const feature = await oneClef({ routine: 0.6, other: 0.4 });
    return placement(feature).routine ? `routine section by placement() (routineConfidence ${feature.routineConfidence.toFixed(2)})` : "card";
  },
  "clef|constructed: answer t1 routine 0.55, other 0.45": async () => {
    const feature = await oneClef({ routine: 0.55, other: 0.45 });
    return feature.routine && !placement(feature).routine
      ? `routine true (${feature.routineConfidence.toFixed(2)}) but a card by placement(): below the 0.6 section gate` : `${feature.routine} ${placement(feature).routine}`;
  },
  "clef|captured week, cold run with Clef": async () => {
    const model = new FakeDecider();
    await published(model);
    const states = model.requests.map((request) => clefStateTokens(request));
    const questions = model.requests.map((request) => Object.keys(request.questions).length);
    const excerpts = model.requests.flatMap((request) => threadItems(request).map((item) => item.excerpt.length));
    return `${model.requests.length} Clef requests; every state at most ${Math.max(...states) <= 1_800 ? "1,800" : Math.max(...states)} tokens; at most ${Math.max(...questions) <= 64 ? 64 : Math.max(...questions)} questions; excerpts at most ${Math.max(...excerpts) <= CLEF_EXCERPT_CHARS ? CLEF_EXCERPT_CHARS : Math.max(...excerpts)} chars`;
  },
  "clef|constructed: the request body for one batch": async () => {
    const seen: { model: string; inputs: Record<string, unknown>; options?: Record<string, unknown> }[] = [];
    const ai: AiBinding = { run: async (model, inputs, options) => { seen.push({ model, inputs, ...(options ? { options } : {}) }); return { answers: {} }; } };
    const model = new WorkersAiModel(ai, "osskb-digest-dev");
    const bucket = new MemoryBucket();
    await publish(bucket);
    await runDigest(input(bucket, { model, cap: 4_500 }));
    const clef = seen.find((call) => call.model === "@cf/cloudflare/clef-flash")!;
    const state = clef.inputs.state as { ref: string; title?: string; excerpt?: string; word?: string }[];
    const questions = clef.inputs.questions as Record<string, { type: string; criteria: Record<string, string> }>;
    const question = questions.t1!;
    const descriptions = KAFKA_DIGEST_PROFILE.taxonomy.descriptions!;
    const described = Object.entries(question.criteria).every(([option, text]) => text === descriptions[option]);
    const last = state.at(-1)!;
    return clef.inputs.model === "clef-flash" && JSON.stringify(Object.keys(state[0]!)) === JSON.stringify(["ref", "title", "excerpt"])
      && last.ref === "end" && typeof last.word === "string"
      && Object.keys(questions).length === state.length && question.type === "choice" && Object.keys(question.criteria).length === 13 && described
      && questions.end !== undefined && Object.keys(questions.end.criteria).length === 4
      ? "model clef-flash; state [{ref, title, excerpt}] then the canary; one choice question per thread with 13 options (12 topics + routine) described by the profile, plus question end" : JSON.stringify(clef.inputs).slice(0, 300);
  },
  "clef|constructed: a new comment on a thread whose title and root excerpt are unchanged": async () => {
    const { bucket } = await published(new FakeDecider());
    // Next release: KAFKA-PR-23426 gains an in-window comment; its title and root excerpt stay.
    const original = fixture.details["KAFKA-PR-23426"]!;
    const extra = { ...original.records.at(-1)!, id: `${original.records.at(-1)!.id}-new`, author: "newcomer", occurredAt: "2026-10-06T13:00:00Z", excerpt: "a new comment" };
    const saved = fixture.details;
    (fixture as { details: unknown }).details = { ...saved, "KAFKA-PR-23426": { ...original, records: [...original.records, extra] } };
    try {
      await publish(bucket, { releaseId: "next-release" });
    } finally {
      (fixture as { details: unknown }).details = saved;
    }
    const model = new FakeDecider();
    const retry = await runDigest(input(bucket, { model }));
    const { en } = await objects(bucket, retry);
    const feature = Object.values(en.features).find((item) => item.displayId === "KAFKA-PR-23426")!;
    const asked = model.requests.some((request) => threadItems(request).some((item) => item.title === original.title));
    return feature.source === "cache" && !asked ? "Clef features reused from cache; 0 Clef requests for it" : `${feature.source} ${asked}`;
  },
  "clef|constructed: answer for t2 missing, t3 probability 1.4": async () => {
    const model = new FakeDecider(undefined, (request) => {
      const options = [...KAFKA_DIGEST_PROFILE.taxonomy.topics, "routine"];
      const good = Object.fromEntries(options.map((option) => [option, option === "other" ? 0.9 : 0.01]));
      return { answers: { ...Object.fromEntries(threadItems(request).flatMap((item) =>
        item.ref === "t2" ? [] : [[item.ref, { probabilities: item.ref === "t3" ? { ...good, other: 1.4 } : good }]])), end: canaryAnswer(threadItems(request).length) } };
    });
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    const first = threadItems(model.requests[0]!).map((item) => item.title);
    const byTitle = (title: string) => Object.values(en.features).find((item) => en.threads[item.displayId]?.title === title)!;
    const sources = first.map((title) => byTitle(title).source);
    return sources[1] === "rules" && sources[2] === "rules" && sources[0] === "model" && sources.slice(3).every((source) => source === "model") && en.coverage.fallbacks > 0
      ? "t2 and t3 get rules features; the rest model; batch counted as a fallback" : sources.join();
  },
  "clef|constructed: the Clef request fails twice": async () => {
    let failures = 0;
    const model = new FakeDecider(undefined, (request) =>
      (threadItems(request).some((item) => item.title.includes("New committer")) && failures++ < 2 ? new Error("down") : undefined));
    const delays: number[] = [];
    const { bucket, result } = await published(model, { delay: async (ms) => { delays.push(ms); } });
    const { en } = await objects(bucket, result);
    const committer = Object.values(en.features).find((item) => item.displayId === "KAFKA-MAIL-85a6bd91")!;
    return failures === 2 && delays.includes(RETRY_DELAY_MS) && committer.source === "rules" ? "1 retry; the batch gets rules features" : `${failures} ${committer.source}`;
  },
  "errors|binding throws \"AiError: 3036: daily free allocation of 10,000 neurons used\"": async () => {
    const error = toModelCallError(new Error("AiError: 3036: daily free allocation of 10,000 neurons used"));
    return `code ${error.code}; ${modelErrorKind(error)}`;
  },
  "errors|binding throws \"AI Gateway: 429 Too Many Requests\"": async () => {
    const error = toModelCallError(new Error("AI Gateway: 429 Too Many Requests"));
    return `status ${error.status}; ${modelErrorKind(error)}`;
  },
  "errors|binding throws \"Gateway spend limit reached\"": async () => modelErrorKind(toModelCallError(new Error("Gateway spend limit reached"))),
  "errors|binding throws \"AiError: 5007: internal server error\"": async () => {
    const error = toModelCallError(new Error("AiError: 5007: internal server error"));
    return `code ${error.code}; ${modelErrorKind(error)}`;
  },
  "text response|Workers AI returns {response: \"<think>…</think>{\\\"sentences\\\":[]}\", usage}": async () => {
    const parsed = responseText({ response: "<think>Let me think.</think>{\"sentences\":[]}", usage: { prompt_tokens: 10 } });
    return `text ${parsed.text}; usage ${parsed.usage?.prompt_tokens === 10 ? "kept" : "lost"}`;
  },
  "text response|Workers AI returns {response: {sentences: []}} (JSON mode object)": async () => `text ${responseText({ response: { sentences: [] } }).text}`,
  "gateway|DIGEST_MODEL workers-ai, DIGEST_GATEWAY_ID osskb-digest-dev, AI binding": async () => {
    const options: unknown[] = [];
    const ai: AiBinding = { run: async (_model, _inputs, option) => { options.push(option); return { response: "{}" }; } };
    const model = digestModel({ DIGEST_MODEL: "workers-ai", DIGEST_GATEWAY_ID: "osskb-digest-dev", AI: ai })!;
    await model.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", "p", 10);
    await model.decide("@cf/cloudflare/clef-flash", { state: [], questions: {} });
    return options.every((option) => JSON.stringify(option) === JSON.stringify({ gateway: { id: "osskb-digest-dev", skipCache: true } })) && options.length === 2
      ? "every call passes {gateway: {id: osskb-digest-dev, skipCache: true}}" : JSON.stringify(options);
  },
  "gateway|AI binding without DIGEST_GATEWAY_ID (or DIGEST_MODEL unset)": async () => {
    const ai: AiBinding = { run: async () => ({}) };
    const none = [
      digestModel({ DIGEST_MODEL: "workers-ai", AI: ai }),
      digestModel({ DIGEST_GATEWAY_ID: "osskb-digest-dev", AI: ai }),
      digestModel({ DIGEST_MODEL: "workers-ai", DIGEST_GATEWAY_ID: "osskb-digest-dev" }),
      digestModel({ DIGEST_MODEL: "workers-ai", DIGEST_GATEWAY_ID: " ", AI: ai }),
    ];
    return none.every((model) => model === undefined) ? "no model: rules only" : "model";
  },
  "spend|constructed: the 51st model request of one run": async () => {
    const calls = new ModelCalls({ run: async () => "ok" }, { spent: 0, cap: 1_000_000 }, noDelay);
    for (let n = 0; n < MAX_CALLS_PER_RUN; n += 1) await calls.call("@cf/qwen/qwen3-30b-a3b-fp8", "p", 10);
    const before = calls.limited;
    const last = await calls.call("@cf/qwen/qwen3-30b-a3b-fp8", "p", 10);
    return MAX_CALLS_PER_RUN === 50 && !before && last === undefined && calls.limited && calls.calls === 50 ? "skipped; limited true" : `${calls.calls}`;
  },
  // Slice 2c.
  "canary|constructed: Clef answers the canary word with probability 0.3": async () => canaryClef(0.3),
  "canary|constructed: Clef answers the canary word with probability 0.9": async () => canaryClef(0.9),
  "canary|constructed: canary word 0.45, every decoy 0.01": async () => {
    const { clefFeatures } = await import("@oss-knowledge-base/reference-pipeline");
    const thread = { displayId: "KAFKA-PR-1", entryId: "e", title: "t", source: "github" as const, status: "open", url: null, rootExcerpt: "", records: [], score: 1, lastActivityAt: NOW.toISOString() };
    const options = [...KAFKA_DIGEST_PROFILE.taxonomy.topics, "routine"];
    const probabilities = Object.fromEntries(options.map((option) => [option, option === "security" ? 0.9 : 0.01]));
    const end = { probabilities: Object.fromEntries(CANARY_WORDS.map((item) => [item, item === canaryWord(1) ? 0.45 : 0.01])) };
    const parsed = clefFeatures({ answers: { t1: { probabilities }, end } }, [thread], KAFKA_DIGEST_PROFILE, { model: "m", prompt: "p", generatedAt: "g" });
    return parsed.unseen && parsed.fallbacks === 1 ? "the whole batch is unseen: rules features, counted as a fallback" : "model features";
  },
  "canary|constructed: canary word 0.6, decoy falcon 0.55": async () => {
    const { clefFeatures } = await import("@oss-knowledge-base/reference-pipeline");
    const thread = { displayId: "KAFKA-PR-1", entryId: "e", title: "t", source: "github" as const, status: "open", url: null, rootExcerpt: "", records: [], score: 1, lastActivityAt: NOW.toISOString() };
    const options = [...KAFKA_DIGEST_PROFILE.taxonomy.topics, "routine"];
    const probabilities = Object.fromEntries(options.map((option) => [option, option === "security" ? 0.9 : 0.01]));
    const word = canaryWord(1);
    const decoy = CANARY_WORDS.find((item) => item !== word)!;
    const end = { probabilities: Object.fromEntries(CANARY_WORDS.map((item) => [item, item === word ? 0.6 : item === decoy ? 0.55 : 0.01])) };
    const parsed = clefFeatures({ answers: { t1: { probabilities }, end } }, [thread], KAFKA_DIGEST_PROFILE, { model: "m", prompt: "p", generatedAt: "g" });
    return parsed.unseen && parsed.features.get("KAFKA-PR-1")!.source === "rules" && parsed.fallbacks === 1
      ? "the whole batch is unseen: rules features, counted as a fallback" : "model features";
  },
  "canary|constructed: a whole run where every Clef response omits the canary answer": async () => {
    const model = new FakeDecider();
    const original = model.decide.bind(model);
    model.decide = async (name, request) => {
      const response = await original(name, request);
      const { end: _end, ...answers } = response.answers as Record<string, unknown>;
      return { ...response, answers };
    };
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    const sources = new Set(Object.values(en.features).map((item) => item.source));
    const { clefCalls, clefCanaryMisses } = result.calibration;
    return sources.size === 1 && sources.has("rules") && clefCalls > 0 && clefCanaryMisses === clefCalls
      ? "every thread gets rules features; clefCanaryMisses equals clefCalls" : `${[...sources]} ${clefCanaryMisses}/${clefCalls}`;
  },
  "clef|constructed: the Clef request criteria for the Kafka profile": async () => {
    const { CLEF_REVISION } = await import("@oss-knowledge-base/reference-pipeline");
    const thread = { displayId: "KAFKA-PR-1", entryId: "e", title: "t", source: "github" as const, status: "open", url: null, rootExcerpt: "", records: [], score: 1, lastActivityAt: NOW.toISOString() };
    const question = clefRequest([thread], KAFKA_DIGEST_PROFILE).questions.t1 as { criteria: Record<string, string> };
    const descriptions = KAFKA_DIGEST_PROFILE.taxonomy.descriptions!;
    const ok = [...KAFKA_DIGEST_PROFILE.taxonomy.topics, "routine"].every((option) => question.criteria[option] === descriptions[option] && (option === "other" || descriptions[option] !== option));
    return ok ? `every topic option's criterion is the profile description; revision ${CLEF_REVISION}` : JSON.stringify(question.criteria);
  },
  "call order|captured week, cold run with Clef": async () => {
    const model = new FakeDecider();
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    const labels = model.calls.map((kind, index) => (kind === "summarize" ? (model.maxTokens.find((_, at) => at === index - model.calls.slice(0, index).filter((item) => item === "classify").length)?.[1] === 160 ? "proposal" : "card") : kind));
    const collapsed = labels.filter((label, index) => index === 0 || labels[index - 1] !== label);
    const cardFirstIds = model.prompts.filter((prompt) => prompt.startsWith(SUMMARIZE_PROMPT.slice(0, 40)) && prompt.includes("at most 3 sentences"))
      .map((prompt) => /^\[([A-Z]+-[A-Za-z0-9-]+)\]/mu.exec(prompt.slice(prompt.indexOf("\n<")))![1]!);
    const byScore = JSON.stringify(cardFirstIds) === JSON.stringify(en.cards.map((card) => card.threads[0]));
    return collapsed.join(">") === "classify>proposal>card>highlights>translate" && byScore
      ? "classify, then proposal rows, then cards by score, then highlights, then translation" : `${collapsed.join(">")} ${byScore}`;
  },
  "call order|constructed: captured week with a 30-request ceiling": async () => {
    const { bucket, result } = await published(new FakeDecider(), { limits: { maxCalls: 30 } });
    const { en, zh } = await objects(bucket, result);
    const lines = en.proposals.every((row) => row.line !== null);
    const fallbackAt = en.cards.findIndex((card) => card.status === "fallback");
    const suffix = fallbackAt > 0 && en.cards.slice(fallbackAt).every((card) => card.status === "fallback");
    return lines && en.highlightsProvenance !== null && suffix && result.limited && zh.coverage.notTranslated === 0 && result.modelCalls <= 30
      ? "every proposal line, the highlights call, and translation ran; the lowest-score cards fall back; limited true; no item Not translated"
      : `${lines} ${en.highlightsProvenance !== null} ${fallbackAt} ${result.limited} ${zh.coverage.notTranslated} ${result.modelCalls}`;
  },
  "call order|constructed: a ModelCalls ceiling of 3 requests": async () => {
    const calls = new ModelCalls({ run: async () => "ok" }, { spent: 0, cap: 1_000_000 }, noDelay, 3);
    for (let n = 0; n < 3; n += 1) await calls.call("@cf/qwen/qwen3-30b-a3b-fp8", "p", 10);
    const fourth = await calls.call("@cf/qwen/qwen3-30b-a3b-fp8", "p", 10);
    return fourth === undefined && calls.limited && calls.calls === 3 ? "the 4th request is skipped; limited true" : `${calls.calls}`;
  },
  "call order|constructed: captured week with a Clef cap of 3 requests": async () => {
    const model = new FakeDecider();
    const { bucket, result } = await published(model, { limits: { maxClefRequests: 3 } });
    const { en } = await objects(bucket, result);
    const asked = new Set(model.requests.flatMap((request) => threadItems(request).map((item) => item.title)));
    const others = Object.values(en.features).filter((item) => !asked.has(en.threads[item.displayId]!.title));
    return model.requests.length === 3 && others.length > 0 && others.every((item) => item.source === "rules") && result.limited
      ? "3 Clef requests; the other threads get rules features; limited true" : `${model.requests.length} ${others.length} ${result.limited}`;
  },
  "bounds|constructed: the max_tokens of each call kind in a cold run": async () => {
    const model = new FakeDecider();
    await published(model);
    const of = (kind: Kind) => [...new Set(model.maxTokens.filter(([item]) => item === kind).map(([, tokens]) => tokens))].sort((a, b) => b - a);
    const [card, proposal] = of("summarize");
    return `card ${card}, proposal ${proposal}, highlights ${of("highlights").join("/")}, translation ${of("translate").join("/")}`;
  },
  "bounds|captured week, cold run with Clef": async () => {
    const model = new FakeDecider();
    const { bucket, result } = await published(model);
    const { zh } = await objects(bucket, result);
    const translations = model.prompts.filter((prompt) => prompt.startsWith(TRANSLATE_PROMPT.slice(0, 40)));
    return translations.length === 1 && translations[0]!.trimEnd().endsWith("/no_think") && zh.coverage.notTranslated === 0
      ? "1 translation call for every item; its prompt ends with /no_think" : `${translations.length}`;
  },
  "style|constructed: card sentences \"Omnia Ibrahim proposed Apache Kafka 4.4.0 RC4.\" and \"KIP-1349 moves snapshot frequency to bytes.\"": async () => {
    let done = false;
    const model = new FakeDecider((kind, _index, prompt) => {
      if (kind !== "summarize") return undefined;
      if (done || !prompt.includes("at most 3 sentences")) return "no";
      done = true;
      const id = /^\[([A-Z]+-[A-Za-z0-9-]+)\]/mu.exec(prompt.slice(prompt.indexOf("\n<")))![1]!;
      return JSON.stringify({ sentences: [{ text: "Omnia Ibrahim proposed Apache Kafka 4.4.0 RC4.", cites: [id] }, { text: "KIP-1349 moves snapshot frequency to bytes.", cites: [id] }] });
    });
    const { result, bucket } = await published(model);
    const { en } = await objects(bucket, result);
    return `style {sentences ${result.style.sentences}, personLed ${result.style.personLed}}; summarizer prompt ${en.revisions.summarizer.prompt}`;
  },
  "coverage|constructed: the translation batch returns non-JSON twice": async () => {
    const model = new FakeModel((kind, index) => (kind === "translate" && index < 2 ? "Sure, here is the translation" : undefined));
    const { bucket, result } = await published(model);
    const { en, zh } = await objects(bucket, result);
    const marked = [...zh.cards.flatMap((card) => card.sentences), ...zh.proposals.flatMap((row) => (row.line ? [row.line] : [])), ...(zh.headline ? [zh.headline] : []),
      ...zh.highlights.map((highlight) => highlight.body)].filter((sentence) => sentence.notTranslated === true).length
      + zh.highlights.filter((highlight) => highlight.titleNotTranslated === true).length;
    return JSON.stringify(en.coverage) === JSON.stringify(zh.coverage) && zh.coverage.notTranslated === marked && marked > 0
      ? "en and zh-Hant coverage identical; notTranslated equals the zh-Hant items marked Not translated" : `${JSON.stringify(en.coverage)} ${JSON.stringify(zh.coverage)} ${marked}`;
  },
  "coverage|constructed: a complete en with an incomplete zh-Hant, retried": async () => {
    const failing = new FakeModel((kind) => (kind === "translate" ? "not json" : undefined));
    const { bucket, result: first } = await published(failing);
    const second = await runDigest(input(bucket, { model: new FakeModel() }));
    const { en, zh } = await objects(bucket, second);
    const pointer = JSON.parse(bucket.objects.get(`${DIGEST_ROOT}apache-kafka/current.json`)!) as { objectKeys: { en: string; "zh-Hant": string } };
    return second.reused === "en" && second.objectKeys!.en !== first.objectKeys!.en && JSON.stringify(en.coverage) === JSON.stringify(zh.coverage)
      && pointer.objectKeys.en === second.objectKeys!.en && pointer.objectKeys["zh-Hant"] === second.objectKeys!["zh-Hant"] && zh.coverage.notTranslated === 0
      ? "a new pair with identical coverage; the pointer names both new objects" : `${second.reused} ${second.objectKeys!.en === first.objectKeys!.en}`;
  },
  "rejections|constructed: a proposal call returns JSON cut off mid-string": async () => {
    let cut = false;
    const model = new FakeDecider((kind, _index, prompt) => {
      if (kind !== "summarize" || cut || !prompt.includes("at most 1 sentences")) return undefined;
      cut = true;
      return '{"sentences":[{"text":"KIP-1349 moves snapshot frequency';
    });
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    return result.rejections.unparsable === 1 && en.proposals[0]!.line === null ? "rejections.unparsable 1; that line null" : JSON.stringify(result.rejections);
  },
  "rejections|constructed: a card sentence says merged while its cited PR is open": async () => {
    let used = false;
    const model = new FakeDecider((kind, _index, prompt) => {
      if (kind !== "summarize" || used || !prompt.includes("at most 3 sentences")) return undefined;
      const match = /^\[([A-Z]+-PR-[A-Za-z0-9-]+)\] .* \(github, open\)$/mu.exec(prompt.slice(prompt.indexOf("\n<")));
      if (match === null) return undefined;
      used = true;
      return JSON.stringify({ sentences: [{ text: "The change merged this week.", cites: [match[1]!] }] });
    });
    const { result } = await published(model);
    return `rejections["status:merged"] ${result.rejections["status:merged"]}`;
  },
  "rejections|constructed: the highlights call returns a headline citing a thread outside its inputs and a highlight body with \"objected\"": async () => {
    const model = new FakeDecider((kind, _index, prompt) => {
      if (kind !== "highlights") return undefined;
      const body = prompt.slice(prompt.indexOf("\n<"));
      const cite = (JSON.parse(body.slice(body.indexOf("["), body.lastIndexOf("]") + 1)) as { cites: string[] }[])[0]!.cites[0]!;
      return JSON.stringify({ headline: { text: "A week of work.", cites: ["KAFKA-PR-999999"] },
        highlights: [{ title: "Pushback", body: { text: "Reviewers objected to the change.", cites: [cite] } }] });
    });
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    return `rejections["cite-outside-inputs"] ${result.rejections["cite-outside-inputs"]}, rejections["stance:objected"] ${result.rejections["stance:objected"]}; headline ${en.headline === null ? "null" : "kept"}`;
  },
  "rejections|constructed: the highlights call returns no headline and 4 items: an 81-character title, a title without a body, \"junk\", and one valid item": async () => {
    const model = new FakeDecider((kind, _index, prompt) => {
      if (kind !== "highlights") return undefined;
      const body = prompt.slice(prompt.indexOf("\n<"));
      const cite = (JSON.parse(body.slice(body.indexOf("["), body.lastIndexOf("]") + 1)) as { cites: string[] }[])[0]!.cites[0]!;
      const valid = { text: "Snapshot frequency moves to bytes.", cites: [cite] };
      return JSON.stringify({ highlights: [{ title: "t".repeat(81), body: valid }, { title: "No body" }, "junk", { title: "Kept", body: valid }] });
    });
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    const kept = en.highlightsProvenance === null ? 0 : en.highlights.length;
    return `rejections.title ${result.rejections.title}, rejections.empty ${result.rejections.empty}; ${kept} highlight kept; headline ${en.headline === null ? "null" : "kept"}`;
  },
  "rejections|constructed: the highlights call returns {}": async () => {
    const model = new FakeDecider((kind) => (kind === "highlights" ? "{}" : undefined));
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    return `rejections.empty ${result.rejections.empty}; headline ${en.headline === null ? "null" : "kept"}`;
  },
  "uncategorized|captured week, cold run with Clef": async () => {
    const { bucket, result } = await published(new FakeDecider());
    const { en } = await objects(bucket, result);
    const placed = Object.values(en.features).filter((item) => { const place = placement(item); return !place.routine && place.topic === "other"; }).map((item) => item.displayId);
    const listed = en.uncategorized?.threads ?? [];
    const scores = listed.map((id) => en.threads[id]!.score);
    const sorted = scores.every((score, index) => index === 0 || scores[index - 1]! >= score);
    return listed.length > 0 && new Set(listed).size === new Set(placed).size && placed.every((id) => listed.includes(id)) && sorted
      ? "en.uncategorized lists every non-routine thread placed in other, by score; not empty" : `${listed.length} ${placed.length}`;
  },
  "call order|constructed: captured week at every ceiling from 20 to 35 requests": async () => {
    const short: string[] = [];
    for (let ceiling = 20; ceiling <= 35; ceiling += 1) {
      const model = new FakeDecider();
      await published(model, { limits: { maxCalls: ceiling } });
      const before = model.calls.indexOf("highlights");
      if (before < 0 || ceiling - before < 3) short.push(`${ceiling}:${before < 0 ? "none" : ceiling - before}`);
    }
    return short.length === 0 ? "at least 3 requests remain at the highlights call (highlights, 1 translation, 1 retry)" : short.join(" ");
  },
  "call order|constructed: the reserve for 50 and for 51 items so far": async () => `${reserveCalls(50)} and ${reserveCalls(51)}`,
  // Slice 2d.
  "raw samples|constructed: dry run where one proposal call returns prose and one translated item drops its placeholder": async () => {
    let prose = false;
    const model = new FakeDecider((kind, _index, prompt) => {
      if (kind === "summarize" && !prose && prompt.includes("at most 1 sentences")) { prose = true; return "I cannot find a clear development here."; }
      if (kind === "translate") {
        const body = prompt.slice(prompt.indexOf("\n<"));
        const items = JSON.parse(body.slice(body.indexOf("["), body.lastIndexOf("]") + 1)) as { id: string; text: string }[];
        const target = items.find((item) => item.id.startsWith("proposal:") && item.text.includes("⟦0⟧"));
        return JSON.stringify(items.map((item) => ({ id: item.id, text: item === target ? "譯：無佔位符" : `譯：${item.text}` })));
      }
      return undefined;
    });
    const { result } = await published(model, { dryRun: true });
    const calls = (result.rawSamples ?? []).map((sample) => `${sample.call.replace(/:KIP-\d+$/u, ":<key>")}|${sample.reason}`);
    return calls.includes("proposal:<key>|unparsable") && calls.includes("translate:proposal:<key>|placeholders")
      ? "rawSamples has {call proposal:<key>, reason unparsable} and {call translate:proposal:<key>, reason placeholders}" : calls.join(" ");
  },
  "raw samples|constructed: dry run where every summarize call returns 700 characters of prose": async () => {
    const model = new FakeDecider((kind) => (kind === "summarize" ? "x".repeat(700) : undefined));
    const { result } = await published(model, { dryRun: true });
    const samples = result.rawSamples ?? [];
    return samples.length === 10 && samples.every((sample) => sample.text.length === 600) ? "10 rawSamples, each 600 characters" : `${samples.length}`;
  },
  "raw samples|constructed: a dry run through DigestRunner with rejected responses": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    const { instance } = runner(bucket, storage, async () => false, new FakeModel((kind) => (kind === "summarize" ? "prose" : undefined)));
    const response = (await instance.request(true)).body as DigestRunResult;
    const stored = storage.values.get("lastRun") as Record<string, unknown>;
    return (response.rawSamples?.length ?? 0) > 0 && !("rawSamples" in stored)
      ? "the dry-run response carries rawSamples; the stored lastRun behind /health has none" : `${response.rawSamples?.length} ${"rawSamples" in stored}`;
  },
  "raw samples|constructed: dry run where the first card returns {\"sentences\":[]}, the highlights call returns prose, and the translation batch returns prose twice": async () => {
    let first = true;
    const model = new FakeDecider((kind, _index, prompt) => {
      if (kind === "summarize" && first && prompt.includes("at most 3 sentences")) { first = false; return '{"sentences":[]}'; }
      if (kind === "highlights" || kind === "translate") return "Sorry, no JSON.";
      return undefined;
    });
    const { result } = await published(model, { dryRun: true });
    const seen = (result.rawSamples ?? []).map((sample) => `${sample.call.replace(/^card:.*/u, "card:<topic>")} ${sample.reason}`);
    return ["card:<topic> empty", "highlights unparsable", "translate:0 unparsable"].every((item) => seen.includes(item))
      ? "rawSamples include card:<topic> empty, highlights unparsable, and translate:0 unparsable" : seen.join(", ");
  },
  "raw samples|constructed: the same prose responses in a scheduled run": async () => {
    const model = new FakeDecider((kind) => (kind === "summarize" ? "x".repeat(700) : undefined));
    const { result } = await published(model);
    return result.rawSamples === undefined && result.rejections.unparsable! > 0 ? "no rawSamples" : JSON.stringify(result.rawSamples).slice(0, 80);
  },
  "parsing|constructed: every summarize and highlights response wrapped in a ```json fence with a sentence of prose before it": async () => {
    const model = new FakeDecider();
    const original = model.run.bind(model);
    model.run = async (name, prompt, maxTokens) => {
      const text = await original(name, prompt, maxTokens);
      const kind = kindOf(prompt);
      return kind === "summarize" || kind === "highlights" ? `Here is the JSON.\n\`\`\`json\n${text}\n\`\`\`` : text;
    };
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    return en.cards.every((card) => card.status === "generated") && en.proposals.every((row) => row.line !== null) && en.headline !== null && result.rejections.unparsable === undefined
      ? "every card and proposal line generated, headline kept; no unparsable" : JSON.stringify(result.rejections);
  },
  "style|constructed: card sentences \"KAFKA-20224 is open.\" and \"Streams standby tasks get rack-aware assignment (KAFKA-20999, open).\"": async () => {
    let done = false;
    const model = new FakeDecider((kind, _index, prompt) => {
      if (kind !== "summarize") return undefined;
      if (done || !prompt.includes("at most 3 sentences")) return "no";
      done = true;
      const id = /^\[([A-Z]+-[A-Za-z0-9-]+)\]/mu.exec(prompt.slice(prompt.indexOf("\n<")))![1]!;
      return JSON.stringify({ sentences: [{ text: "KAFKA-20224 is open.", cites: [id] }, { text: "Streams standby tasks get rack-aware assignment (KAFKA-20999, open).", cites: [id] }] });
    });
    const { result } = await published(model);
    return `style.contentFree ${result.style.contentFree} of ${result.style.sentences}`;
  },
  // Slice 2e (the Dev schedule, 2026-10-14).
  "cron|Dev config: the tick 47 22 * * * fires": async () => cronTarget("47 22 * * *", (await deployConfig("development")).vars?.DIGEST_CRON),
  "cron|Dev config: the publisher tick 7 22 * * * fires": async () => cronTarget("7 22 * * *", (await deployConfig("development")).vars?.DIGEST_CRON),
  "cron|Prod config: the tick 47 22 * * * fires": async () => cronTarget("47 22 * * *", (await deployConfig("production")).vars?.DIGEST_CRON),
  "deferral|publisher status {running: false, scheduled: true, followUp: {reason: catch-up}}": async () => busy({ running: false, scheduled: true, followUp: { reason: "catch-up", at: "2026-10-14T22:15:00.000Z", catchUps: 1, retries: 0 } }),
  "deferral|publisher status {running: false, scheduled: true, followUp: {reason: retry}}": async () => busy({ running: false, scheduled: true, followUp: { reason: "retry", at: "2026-10-14T22:20:00.000Z", catchUps: 0, retries: 1 } }),
  "deferral|publisher status {running: false, scheduled: true, followUp: null} (its alarm is due)": async () => busy({ running: false, scheduled: true, followUp: null }),
  "deferral|publisher status {running: true, scheduled: false, followUp: null}": async () => busy({ running: true, scheduled: false, followUp: null }),
  "deferral|publisher status {running: false, scheduled: false, followUp: null}": async () => busy({ running: false, scheduled: false, followUp: null }),
  "deferral|publisher status {running: false, scheduled: false, followUp: {reason: retry}} (the alarm was lost)": async () => busy({ running: false, scheduled: false, followUp: { reason: "retry", at: "2026-10-14T22:20:00.000Z", catchUps: 0, retries: 1 } }),
  "deferral|constructed: a catch-up is waiting at the first alarm and gone 15 min later": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    let status: unknown = { running: false, scheduled: true, followUp: { reason: "catch-up", at: "2026-10-07T01:42:00.000Z", catchUps: 1, retries: 0 } };
    const { instance, advance } = runner(bucket, storage, async () => publisherBusy(status));
    await instance.alarm();
    const rearmed = storage.alarm! - NOW.getTime();
    const ranEarly = storage.values.has("lastRun");
    status = { running: false, scheduled: false, followUp: null };
    advance(DEFER_MS);
    await instance.alarm();
    const lastRun = (await instance.health()).lastRun;
    return rearmed === DEFER_MS && !ranEarly && lastRun?.ok === true && lastRun.deferred === 1
      ? "re-armed once; then runs; lastRun.deferred 1" : `${rearmed} ${ranEarly} ${lastRun?.deferred}`;
  },
  "errors|binding throws \"2003: Rate limited\" (Dev dry run 3, 2026-10-08)": async () => {
    const error = toModelCallError(new Error("2003: Rate limited"));
    return `status ${error.status}; ${modelErrorKind(error)}`;
  },
  "rate limit|constructed: the gateway refuses the first card call with 2003: Rate limited": async () => {
    const model = new FakeModel((kind, index) => (kind === "summarize" && index === 0 ? toModelCallError(new Error("2003: Rate limited")) : undefined));
    const { result } = await published(model);
    const after = model.calls.slice(model.calls.indexOf("summarize") + 1);
    return after.length === 0 && result.limited && result.modelErrors.length === 1 && result.modelErrors[0]!.kind === "limit" && result.modelErrors[0]!.message === "2003: Rate limited"
      ? "no retry; remaining calls skipped; limited true; modelErrors kind limit" : `${after.join()} ${JSON.stringify(result.modelErrors)}`;
  },
  "failed run|constructed: a digest is published; the next run cannot read the Feed manifest": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    const { instance } = runner(bucket, storage);
    await instance.alarm();
    const pointer = bucket.objects.get(POINTER);
    const manifest = bucket.objects.get(MANIFEST_KEY)!;
    bucket.objects.delete(MANIFEST_KEY);
    const before = JSON.stringify([...bucket.objects]);
    const writes = bucket.writes.length;
    await instance.alarm();
    const failed = (await instance.health()).lastRun!;
    const unchanged = pointer !== undefined && JSON.stringify([...bucket.objects]) === before && bucket.writes.length === writes;
    // Control: the same runner moves the pointer once a release can be read again.
    bucket.objects.set(MANIFEST_KEY, manifest);
    await publish(bucket, { releaseId: "next-release" });
    await instance.alarm();
    const moved = bucket.objects.get(POINTER) !== pointer && (await instance.health()).lastRun!.ok;
    return !failed.ok && failed.failureKind === "source-read" && unchanged && moved
      ? "lastRun ok false, source-read; pointer and objects unchanged; the next good run moves the pointer" : `${failed.ok} ${failed.failureKind} ${unchanged} ${moved}`;
  },
  "spend|constructed: a text call the price table settles at N neurons": async () => {
    const prompt = "x".repeat(40_000);
    const raw = settledNeurons(LLAMA, prompt, "ok");
    const calls = new ModelCalls({ run: async () => "ok" }, { spent: 0, cap: 1_000_000 }, noDelay);
    await calls.call(LLAMA, prompt, 300);
    return raw > 100 && DIGEST_NEURON_CALIBRATION === 1.28 && calls.spentToday === Math.ceil(raw * 1.28) ? "today's spend grows by ceil(N × 1.28)" : `${raw} ${calls.spentToday}`;
  },
  "spend|constructed: a call that fits the cap at its price-table estimate but not at × 1.28": async () => {
    const prompt = "x".repeat(4_000);
    const raw = callEstimate(LLAMA, prompt, 300);
    const model: DigestModel = { run: async () => "ok" };
    const calls = new ModelCalls(model, { spent: 5_000 - raw, cap: 5_000 }, noDelay);
    const output = await calls.call(LLAMA, prompt, 300);
    // Control: the same call runs when the calibrated estimate fits exactly.
    const fits = new ModelCalls(model, { spent: 5_000 - Math.ceil(raw * 1.28), cap: 5_000 }, noDelay);
    return output === undefined && calls.limited && calls.calls === 0 && await fits.call(LLAMA, prompt, 300) === "ok"
      ? "call skipped; limited true" : `${output} ${calls.limited} ${calls.calls}`;
  },
  "spend|constructed: a Clef request the price table counts as 1 neuron": async () => {
    const calls = new ModelCalls(new FakeDecider(), { spent: 0, cap: 5_000 }, noDelay);
    // An empty batch prices at 0 and is floored to 1 before calibration.
    const answered = await calls.decide("@cf/cloudflare/clef-flash", clefRequest([], KAFKA_DIGEST_PROFILE));
    return answered !== undefined && calls.spentToday === 2 ? "today's spend grows by 2" : `${calls.spentToday}`;
  },
  "spend|constructed: a run with a fake model": async () => {
    const prompts: [string, string][] = [];
    const inner = new FakeModel();
    const model: DigestModel = { run: async (name, prompt, maxTokens) => {
      const text = await inner.run(name, prompt, maxTokens);
      prompts.push([prompt, text]);
      return text;
    } };
    const { bucket, result } = await published(model, { cap: 1_000_000 });
    const { en, zh } = await objects(bucket, result);
    const raw = prompts.reduce((sum, [prompt, text], index) => sum + settledNeurons(inner.modelsUsed[index]!, prompt, text), 0);
    const ledger = prompts.reduce((sum, [prompt, text], index) => sum + Math.ceil(settledNeurons(inner.modelsUsed[index]!, prompt, text) * 1.28), 0);
    return ledger > raw && result.estimatedNeurons === ledger && result.spentToday === ledger && en.coverage.estimatedNeurons === ledger && zh.coverage.estimatedNeurons === ledger
      ? "lastRun.estimatedNeurons, spentToday and coverage.estimatedNeurons are the calibrated sum" : `${raw} ${ledger} ${result.estimatedNeurons} ${en.coverage.estimatedNeurons}`;
  },
  "ledger|constructed: the object dies during the 4th model request of a run; the alarm is retried": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const date = NOW.toISOString().slice(0, 10);
    const room = 2_500;
    const storage = new MemoryStorage();
    storage.values.set(`spend:${date}`, DAILY_CAP.dev - room);
    // What the storage held when the object died: the retried alarm sees exactly this.
    const atDeath = new MemoryStorage();
    let started = 0;
    let spentBeforeDeath = 0;
    let dead = false;
    const inner = new FakeModel();
    const dying: DigestModel = { run: async (name, prompt, maxTokens) => {
      if (dead) throw new ModelCallError("the object is gone", 3036);
      started += 1;
      // Every request that started before the death may have been billed in full.
      spentBeforeDeath += digestLedgerNeurons(callEstimate(name, prompt, maxTokens));
      if (started === 4) {
        dead = true;
        for (const [key, value] of storage.values) atDeath.values.set(key, value);
        throw new ModelCallError("the object is gone", 3036);
      }
      return inner.run(name, prompt, maxTokens);
    } };
    await runner(bucket, storage, async () => false, dying).instance.alarm();
    const stored = atDeath.values.get(`spend:${date}`) as number;
    const retry = runner(bucket, atDeath, async () => false, new FakeModel()).instance;
    await retry.alarm();
    const second = (await retry.health()).lastRun!;
    const total = spentBeforeDeath + second.estimatedNeurons;
    return spentBeforeDeath > 0 && stored >= DAILY_CAP.dev - room + spentBeforeDeath && total <= room && second.spentToday <= DAILY_CAP.dev
      ? "the retry starts from the stored spend; both runs together stay within the cap" : `stored ${stored} before ${spentBeforeDeath} second ${second.estimatedNeurons} room ${room}`;
  },
  "ledger|constructed: a run of N model requests": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    const date = NOW.toISOString().slice(0, 10);
    const writes: number[] = [];
    const put = storage.put.bind(storage);
    storage.put = async (key, value) => {
      if (key === `spend:${date}`) writes.push(value as number);
      await put(key, value);
    };
    const model = new FakeModel();
    const { instance } = runner(bucket, storage, async () => false, model);
    await instance.alarm();
    const lastRun = (await instance.health()).lastRun!;
    const before = writes.slice(0, -1);
    return model.calls.length > 5 && writes.length === model.calls.length + 1 && before.every((value) => value > 0) && writes.at(-1) === lastRun.spentToday && Math.max(...before) >= lastRun.spentToday
      ? "N ledger writes before the requests, then the settled total" : `${writes.length} writes for ${model.calls.length} calls`;
  },
  "spend|constructed: a call that fits the cap once fails with a retryable error": async () => {
    const prompt = "x".repeat(4_000);
    const estimate = digestLedgerNeurons(callEstimate(LLAMA, prompt, 300));
    const calls = new ModelCalls({ run: async () => { throw new Error("down"); } }, { spent: 5_000 - estimate, cap: 5_000 }, noDelay);
    const output = await calls.call(LLAMA, prompt, 300);
    return output === undefined && calls.calls === 1 && calls.limited && calls.spentToday === 5_000
      ? "no retry; limited true; spend equals the cap" : `${calls.calls} ${calls.limited} ${calls.spentToday}`;
  },
  "spend|constructed: 4 calls started together, each fitting the cap alone, 2 fitting together": async () => {
    const prompt = "x".repeat(4_000);
    const estimate = digestLedgerNeurons(callEstimate(LLAMA, prompt, 300));
    let ran = 0;
    const model: DigestModel = { run: async () => { ran += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return "x".repeat(4 * 300); } };
    const calls = new ModelCalls(model, { spent: 5_000 - 2 * estimate - 1, cap: 5_000 }, noDelay);
    const outputs = await Promise.all([0, 1, 2, 3].map(() => calls.call(LLAMA, prompt, 300)));
    const skipped = outputs.filter((output) => output === undefined).length;
    return ran === 2 && skipped === 2 && calls.limited && calls.spentToday <= 5_000
      ? "2 run; 2 skipped; limited true; spend within the cap" : `${ran} ran ${skipped} skipped ${calls.spentToday}`;
  },
  "run control|DIGEST_ENABLED unset (Prod)": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    const disabled = new DigestRunner({
      storage, bucket, profile: KAFKA_DIGEST_PROFILE, environment: "production", enabled: false,
      now: () => NOW, delay: noDelay, publisherBusy: async () => false,
    });
    const response = await disabled.request(false);
    await disabled.alarm();
    const enabled = runner(bucket, new MemoryStorage()).instance;
    return response.status === 403 && (response.body as { disabled: boolean }).disabled && storage.values.get("lastRun") === undefined
      && bucket.writes.length === 0 && (await enabled.request(false)).status === 202
      ? "POST /digest/run 403 disabled; an alarm runs nothing" : `${response.status}`;
  },
  "dry run|constructed: a dry run where the model reports usage and one call fails": async () => {
    let failed = false;
    const model = new FakeDecider((kind) => (kind === "translate" && !failed ? (failed = true, new ModelCallError("AiError: 3040: capacity", 3040)) : undefined));
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    const { instance } = runner(bucket, storage, async () => false, model);
    const body = (await instance.request(true)).body as DigestRunResult;
    const error = body.modelErrors[0];
    return error?.code === 3040 && error.kind === "retry" && body.calibration.callsWithUsage > 0 && typeof body.calibration.ratio === "number"
      ? "result lists the error shape and a calibration ratio of reported to estimated input tokens" : JSON.stringify(body.calibration);
  },
};

/** One-thread Clef answer whose canary word has probability `p`. */
async function canaryClef(p: number): Promise<string> {
  const { clefFeatures } = await import("@oss-knowledge-base/reference-pipeline");
  const thread = { displayId: "KAFKA-PR-1", entryId: "e", title: "t", source: "github" as const, status: "open", url: null, rootExcerpt: "", records: [], score: 1, lastActivityAt: NOW.toISOString() };
  const options = [...KAFKA_DIGEST_PROFILE.taxonomy.topics, "routine"];
  const probabilities = Object.fromEntries(options.map((option) => [option, option === "security" ? 0.9 : 0.01]));
  const parsed = clefFeatures({ answers: { t1: { probabilities }, end: canaryAnswer(1, p) } }, [thread], KAFKA_DIGEST_PROFILE, { model: "m", prompt: "p", generatedAt: "g" });
  const feature = parsed.features.get("KAFKA-PR-1")!;
  return feature.source === "rules" && parsed.fallbacks === 1 && parsed.unseen
    ? "the whole batch is unseen: rules features, counted as a fallback"
    : feature.source === "model" && !parsed.unseen ? "model features" : feature.source;
}

/** One-thread Clef answer with reported prompt tokens against a forced estimate. */
async function clefWithUsage(reported: number, estimated: number): Promise<string> {
  const { clefFeatures } = await import("@oss-knowledge-base/reference-pipeline");
  const thread = { displayId: "KAFKA-PR-1", entryId: "e", title: "t", source: "github" as const, status: "open", url: null, rootExcerpt: "", records: [], score: 1, lastActivityAt: NOW.toISOString() };
  const options = [...KAFKA_DIGEST_PROFILE.taxonomy.topics, "routine"];
  const probabilities = Object.fromEntries(options.map((option) => [option, option === "security" ? 0.9 : 0.01]));
  const parsed = clefFeatures({ answers: { t1: { probabilities }, end: canaryAnswer(1) }, usage: { prompt_tokens: reported } }, [thread], KAFKA_DIGEST_PROFILE,
    { model: "m", prompt: "p", generatedAt: "g" }, estimated);
  const feature = parsed.features.get("KAFKA-PR-1")!;
  return feature.source === "rules" && parsed.fallbacks === 1
    ? "the whole batch is treated as unseen: rules features, counted as a fallback"
    : feature.source === "model" ? "model features (reported is at least 80% of the estimate)" : feature.source;
}

async function oneClef(probabilities: Record<string, number>) {
  const options = [...KAFKA_DIGEST_PROFILE.taxonomy.topics, "routine"];
  const full = Object.fromEntries(options.map((option) => [option, probabilities[option] ?? 0]));
  const { clefFeatures } = await import("@oss-knowledge-base/reference-pipeline");
  const thread = { displayId: "KAFKA-PR-1", entryId: "e", title: "t", source: "github" as const, status: "open", url: null, rootExcerpt: "", records: [], score: 1, lastActivityAt: NOW.toISOString() };
  return clefFeatures({ answers: { t1: { probabilities: full }, end: canaryAnswer(1) } }, [thread], KAFKA_DIGEST_PROFILE, { model: "m", prompt: "p", generatedAt: "g" }).features.get("KAFKA-PR-1")!;
}


describe("Spec 014 slice 2 test plan", () => {
  test.each([...testPlanRows] as CaseRow[])("$id: $rule — $input", async (row) => {
    const run = cases[`${row.rule}|${row.input}`];
    if (run === undefined) throw new Error(`No executable case for ${row.id} ${row.rule}: ${row.input}`);
    expect(await run()).toBe(row.expected);
  }, 30_000);

  test("every executable case has a test-plan row", () => {
    const rows = new Set(testPlanRows.map((row) => `${row.rule}|${row.input}`));
    expect(Object.keys(cases).filter((key) => !rows.has(key))).toEqual([]);
  });
});

describe("Spec 014 slice 2 named tests", () => {
  test("D65: deploy config: crons are the publisher's or DIGEST_CRON; Dev has AI through osskb-digest-dev; Prod has its digest on (D113)", async () => {
    type Config = { triggers?: { crons?: string[] }; vars?: Record<string, string>; ai?: { binding?: string } };
    const read = async (name: string) => JSON.parse((await Bun.file(new URL(`../${name}`, import.meta.url)).text())
      .replace(/^\s*\/\/.*$/gmu, "")) as Config;
    const dev = await read("wrangler.development.jsonc");
    const prod = await read("wrangler.production.jsonc");
    for (const [config, publisherCron] of [[dev, "7 22 * * *"], [prod, "37 22 * * *"]] as const) {
      const crons = config.triggers?.crons ?? [];
      const digestCron = config.vars?.DIGEST_CRON;
      const jobCrons = [config.vars?.IDENTITY_LINKS_CRON, config.vars?.KIP_PAGES_CRON, config.vars?.RETENTION_CRON, config.vars?.IDENTITY_BACKFILL_CRON];
      // Spec 027 A2-3: `SRE_AGENT_CRON` holds the sre-agent job's expressions, `;`-separated.
      const sreCrons = (config.vars?.SRE_AGENT_CRON ?? "").split(";").map((cron) => cron.trim()).filter((cron) => cron !== "");
      // A cron entry without its job's variable would start an extra publication; a variable without its entry never fires.
      for (const cron of crons) expect(cron === publisherCron || cron === digestCron || jobCrons.includes(cron) || sreCrons.includes(cron)).toBe(true);
      for (const cron of [digestCron, ...jobCrons, ...sreCrons]) if (cron !== undefined) expect(crons).toContain(cron);
      expect(cronTarget(publisherCron, digestCron, undefined, config.vars?.IDENTITY_LINKS_CRON, config.vars?.KIP_PAGES_CRON, config.vars?.SRE_AGENT_CRON, config.vars?.RETENTION_CRON, config.vars?.IDENTITY_BACKFILL_CRON)).toBe("publisher");
    }
    expect(dev.ai?.binding).toBe("AI");
    expect(dev.vars).toMatchObject({ DIGEST_ENABLED: "true", DIGEST_MODEL: "workers-ai", DIGEST_GATEWAY_ID: "osskb-digest-dev" });
    // Prod binds `AI` for search (Spec 016 H94) and the digest; its digest settings are D113's,
    // with DIGEST_ENABLED=true since the enable PR.
    expect(prod.ai).toEqual({ binding: "AI" });
    expect(prod.vars?.DIGEST_ENABLED).toBe("true");
  });

  test("D86: Dev has the publisher's cron and the digest's 47 22 * * *, kept apart from the other jobs", async () => {
    const dev = await deployConfig("development");
    expect(dev.triggers?.crons).toEqual(["7 22 * * *", "47 22 * * *", "17 2 * * *", "43 3 * * *", "30 0 * * *", "0 11 * * *", "17 10 * * *", "23 1 * * *"]);
    expect(dev.vars?.DIGEST_CRON).toBe("47 22 * * *");
    const [minute, hour] = dev.vars!.DIGEST_CRON!.split(" ").map(Number) as [number, number];
    // The same UTC day as the publication, 40 minutes after its tick, and at most 4 deferrals from midnight.
    expect(hour * 60 + minute - (22 * 60 + 7)).toBe(40);
    expect(hour * 60 + minute + 4 * (DEFER_MS / 60_000)).toBeLessThan(24 * 60);
    // Not a minute another job uses: the publishers (:07, :37), the embedding job after a day cap (:05), the review queue's proposal (:27, :57).
    expect([5, 7, 27, 37, 57]).not.toContain(minute);
  });

  test("D86: the Dev digest tick starts only the digest, also with GITHUB_REVIEWS set: no publication, no review ingestion, no bucket or GitHub request", async () => {
    const dev = await deployConfig("development");
    const tick = async (cron: string) => {
      const log: string[] = [];
      const stub = (name: string) => ({
        idFromName: (id: string) => id,
        get: () => ({ fetch: async (url: string, init?: RequestInit) => { log.push(`${name} ${init?.method ?? "GET"} ${url}`); return Response.json({ ok: true }, { status: 202 }); } }),
      });
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => { log.push(`outbound ${String(input)}`); return Response.json([]); }) as typeof fetch;
      try {
        const env = {
          ...dev.vars, GITHUB_REVIEWS: "metadata@1", GITHUB_SOURCE_TOKEN: "token-under-test",
          PIPELINE_STATE: stub("publisher"), DIGEST_RUN: stub("digest"),
          OSS_KB_BUCKET: { get: async (key: string) => { log.push(`bucket get ${key}`); return null; }, put: async (key: string) => { log.push(`bucket put ${key}`); return {}; } },
        };
        const pending: Promise<unknown>[] = [];
        await worker.scheduled({ cron, scheduledTime: NOW.getTime() } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
        await Promise.allSettled(pending);
      } finally {
        globalThis.fetch = original;
      }
      return log;
    };
    expect(await tick(dev.vars!.DIGEST_CRON!)).toEqual(["digest POST https://digest.internal/run"]);
    // Control: the publisher's tick schedules the publication (and, with the flag set, the review ingestion), never the digest.
    const publication = await tick("7 22 * * *");
    expect(publication).toContain("publisher POST https://pipeline.internal/run");
    expect(publication.some((line) => line.startsWith("outbound ") || line.startsWith("bucket "))).toBe(true);
    expect(publication.filter((line) => line.startsWith("digest "))).toEqual([]);
  });

  test("D113: Prod digest config: AI binding, osskb-digest-prod, cron 17 23 * * * (40 min after its publisher), DIGEST_ENABLED=true (enable PR)", async () => {
    const prod = await deployConfig("production");
    expect(prod.ai?.binding).toBe("AI");
    expect(prod.vars).toMatchObject({ DIGEST_MODEL: "workers-ai", DIGEST_GATEWAY_ID: "osskb-digest-prod", DIGEST_CRON: "17 23 * * *" });
    expect(prod.vars?.DIGEST_ENABLED).toBe("true");
    expect(prod.triggers?.crons).toEqual(["37 22 * * *", "17 23 * * *"]);
    const [minute, hour] = prod.vars!.DIGEST_CRON!.split(" ").map(Number) as [number, number];
    // D86's rule on Prod: 40 minutes after the Prod publisher's 22:37 tick, outside 21:50–23:05 UTC.
    expect(hour * 60 + minute - (22 * 60 + 37)).toBe(40);
    expect(hour * 60 + minute).toBeGreaterThan(23 * 60 + 5);
    expect([5, 7, 27, 37, 47, 57]).not.toContain(minute);
    expect(cronTarget("17 23 * * *", prod.vars?.DIGEST_CRON)).toBe("digest");
    expect(cronTarget("37 22 * * *", prod.vars?.DIGEST_CRON)).toBe("publisher");
  });

  test("D113: the Prod digest tick starts the digest; with DIGEST_ENABLED not true it does nothing: no Durable Object request, no publication, no throw", async () => {
    const prod = await deployConfig("production");
    const tick = async (vars: Record<string, string>) => {
      const log: string[] = [];
      const stub = (name: string) => ({
        idFromName: (id: string) => id,
        get: () => ({ fetch: async (url: string, init?: RequestInit) => { log.push(`${name} ${init?.method ?? "GET"} ${url}`); return Response.json({ ok: false, disabled: true }, { status: 403 }); } }),
      });
      const env = { ...vars, PIPELINE_STATE: stub("publisher"), DIGEST_RUN: stub("digest") };
      const pending: Promise<unknown>[] = [];
      await worker.scheduled({ cron: "17 23 * * *", scheduledTime: NOW.getTime() } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
      const settled = await Promise.allSettled(pending);
      return { log, rejected: settled.filter((result) => result.status === "rejected").length };
    };
    // The deployed Prod vars (DIGEST_ENABLED=true since the enable PR) start the digest and nothing else.
    expect((await tick(prod.vars!)).log).toEqual(["digest POST https://digest.internal/run"]);
    // Control: unset, "false", or any other value than "true" is off: the same tick does nothing.
    const { DIGEST_ENABLED: _enabled, ...unset } = prod.vars!;
    expect(await tick(unset)).toEqual({ log: [], rejected: 0 });
    expect(await tick({ ...prod.vars!, DIGEST_ENABLED: "false" })).toEqual({ log: [], rejected: 0 });
    expect(await tick({ ...prod.vars!, DIGEST_ENABLED: "TRUE" })).toEqual({ log: [], rejected: 0 });
  });

  test("D91: the daily cap is 5,000 calibrated neurons on Dev and Prod, and the three caps leave 1,500 of the 10,000 included", async () => {
    expect(DAILY_CAP).toEqual({ prod: 5_000, dev: 5_000 });
    const { digest, searchEmbedding, searchQuery, included } = DAILY_NEURON_BUDGET;
    expect([digest, searchEmbedding, searchQuery, included]).toEqual([5_000, 2_500, 1_000, 10_000]);
    expect(digest + searchEmbedding + searchQuery).toBe(8_500);
    expect(included - (digest + searchEmbedding + searchQuery)).toBe(1_500);
    expect(DAILY_NEURON_BUDGET).not.toHaveProperty("digestCalibrated");
    // 2026-10-08: dry runs 1 and 2 were 4,507 − 1,141 price-table neurons in 109 − 26 calls.
    const perRun = digestLedgerNeurons((4_507 - 1_141) / 2);
    expect(perRun).toBe(2_155);
    expect(2 * perRun).toBe(4_310);
    expect(2 * perRun).toBeLessThanOrEqual(DAILY_CAP.dev);
    // What /health reports is the same cap, per environment.
    for (const environment of ["development", "production"] as const) {
      const instance = new DigestRunner({
        storage: new MemoryStorage(), bucket: new MemoryBucket(), profile: KAFKA_DIGEST_PROFILE, environment, enabled: true,
        now: () => NOW, delay: noDelay, publisherBusy: async () => false,
      });
      expect((await instance.health()).today.cap).toBe(5_000);
    }
  });

  test("D31: /health keeps the publisher body and adds digest {running, scheduled, today, lastRun}", async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    const { instance } = runner(bucket, storage);
    await instance.request(false);
    await instance.alarm();
    const digest = await instance.health();
    expect(Object.keys(digest)).toEqual(["enabled", "running", "scheduled", "today", "lastRun"]);
    expect(digest.today).toEqual({ date: "2026-10-07", estimatedNeurons: 0, cap: 5_000 });
    const lastRun = digest.lastRun!;
    for (const field of ["ok", "completedAt", "durationMs", "sourceReleaseId", "objectKeys", "candidates", "cached", "modelCalls", "fallbacks", "limited", "deferred", "estimatedNeurons", "dryRun"]) {
      expect(lastRun).toHaveProperty(field);
    }
    expect(lastRun.ok).toBe(true);
    expect(lastRun.candidates).toBe(234);
    const publisher = { environment: "development", running: false, scheduled: false, phase: null, lastRun: { ok: true }, sources: null };
    expect(mergeHealth(publisher, digest)).toEqual({ ...publisher, digest, reviewQueue: null, searchEmbedding: null, searchQuery: null });
    expect(mergeHealth(publisher, null)).toEqual({ ...publisher, digest: null, reviewQueue: null, searchEmbedding: null, searchQuery: null });
  });

  test("D31: a missing Feed manifest fails the run as source-read without writing", async () => {
    const bucket = new MemoryBucket();
    const result = await runDigest(input(bucket));
    expect(result).toMatchObject({ ok: false, failureKind: "source-read" });
    expect(bucket.writes).toEqual([]);
  });

  test("slice 2 default: production without a model publishes a rules-only digest and makes no model call", async () => {
    // Positive control for the deploy-safe default: no AI binding, no generated text, no translation.
    const { bucket, result } = await published();
    const { en, zh } = await objects(bucket, result);
    expect(result.ok).toBe(true);
    expect(result.modelCalls).toBe(0);
    expect(en.cards.every((card) => card.status === "fallback")).toBe(true);
    expect(zh.coverage.notTranslated).toBe(0);
    expect(Object.values(en.features).every((item) => item.source === "rules")).toBe(true);
    expect(en.revisions.translator).toEqual({ model: "none", prompt: "none" });
    // A second run on the same release reuses the complete pair.
    const again = await runDigest(input(bucket));
    expect(again.reused).toBe("pair");
  });
});

// Spec 014 D95 (gardening G43): the digest's error texts reach the public /health; they are
// redacted like the search paths' (Spec 016 Behavior 24), after the error is classified.
const SECRET_TOKEN = "FAKE0TEST0TOKEN0000000000000000000000";
const ACCOUNT_ID = "00000000000000000000000000000000";
const LEAKY = `3036: spend limit reached for account ${ACCOUNT_ID} (Authorization: Bearer ${SECRET_TOKEN})`;
const leaks = (value: unknown) => {
  const text = JSON.stringify(value);
  return [SECRET_TOKEN, ACCOUNT_ID].filter((secret) => text.includes(secret));
};

describe("Spec 014 D95: digest error texts are redacted", () => {
  test("D95: a model error with a bearer token and an account id is classified as limit, then stored and served redacted", async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    const model = new FakeModel((kind, index) => (kind === "summarize" && index === 0 ? toModelCallError(new Error(LEAKY)) : undefined));
    const { instance } = runner(bucket, storage, async () => false, model);
    await instance.alarm();
    const health = await instance.health();
    const lastRun = health.lastRun!;
    expect(lastRun.limited).toBe(true);
    expect(lastRun.modelErrors.map((error) => error.kind)).toEqual(["limit"]);
    expect(lastRun.modelErrors[0]!.message).toContain("Bearer [redacted]");
    expect(lastRun.modelErrors[0]!.message).toStartWith("3036: spend limit reached for account [redacted]");
    expect(leaks(storage.values.get("lastRun"))).toEqual([]);
    expect(leaks(mergeHealth({ running: false }, health))).toEqual([]);
  });

  test("D95: an ordinary model error stays readable", async () => {
    const model = new FakeModel((kind, index) => (kind === "summarize" && index === 0 ? toModelCallError(new Error("2003: Rate limited")) : undefined));
    const { result } = await published(model);
    expect(result.modelErrors.map((error) => [error.kind, error.message])).toEqual([["limit", "2003: Rate limited"]]);
  });

  test("D95: an internal read error and a write error with secrets are stored and served redacted", async () => {
    const reading = new MemoryBucket();
    await publish(reading);
    reading.onRead = () => { throw new Error(LEAKY); };
    const readStorage = new MemoryStorage();
    const read = runner(reading, readStorage);
    await read.instance.alarm();
    const failedRead = (await read.instance.health()).lastRun!;
    expect([failedRead.ok, failedRead.failureKind]).toEqual([false, "internal"]);
    expect(failedRead.error).toContain("Bearer [redacted]");
    expect(leaks(readStorage.values.get("lastRun"))).toEqual([]);

    const writing = new MemoryBucket();
    await publish(writing);
    writing.putIfAbsent = async () => { throw new Error(`R2 put failed: ${LEAKY}`); };
    const writeStorage = new MemoryStorage();
    const write = runner(writing, writeStorage);
    await write.instance.alarm();
    const failedWrite = (await write.instance.health()).lastRun!;
    expect([failedWrite.ok, failedWrite.failureKind]).toEqual([false, "write"]);
    expect(failedWrite.error).toStartWith("Error: R2 put failed: 3036: spend limit reached for account [redacted]");
    expect(leaks(writeStorage.values.get("lastRun"))).toEqual([]);
    expect(leaks(mergeHealth({ running: false }, await write.instance.health()))).toEqual([]);
  });

  test("D95: a source-read error naming a token-like release id is stored redacted", async () => {
    const bucket = new MemoryBucket();
    await publish(bucket, { releaseId: `release-${ACCOUNT_ID}` });
    const manifest = JSON.parse(bucket.objects.get(MANIFEST_KEY)!) as Record<string, unknown>;
    // The manifest names a release whose objects are missing: DigestSourceError("Feed release <id> is incomplete").
    bucket.objects.set(MANIFEST_KEY, JSON.stringify({ ...manifest, releaseId: ACCOUNT_ID }));
    const storage = new MemoryStorage();
    const { instance } = runner(bucket, storage);
    await instance.alarm();
    const lastRun = (await instance.health()).lastRun!;
    expect(lastRun.failureKind).toBe("source-read");
    expect(lastRun.error).toBe("Feed release [redacted] is incomplete");
    expect(leaks(storage.values.get("lastRun"))).toEqual([]);
  });
});

/** The belt-and-braces source check (D95): an error-like key set from raw text. The runtime boundary is redactRecord. */
// Not a property access (`error.message : …` in a ternary) and not a parameter type (`(error: unknown)`);
// whitespace, including a line break, is consumed before the sanitizer check so it cannot be skipped.
const RAW_ERROR = /(?<![.\w])(error|message|reason)\s*:(?!\s*unknown\b)\s*(?!\s)(?!(?:errorText|sanitizeErrorMessage)\()[^,}\n]*(?:\.message\b|String\(|\$\{)/gu;
function rawErrorFields(source: string): number[] {
  return [...source.matchAll(RAW_ERROR)].map((match) => source.slice(0, match.index).split("\n").length);
}

describe("Spec 014 D95: no run record stores raw error text", () => {
  test("D95: the source check catches the bypasses the verifier found (positive control)", () => {
    const sample = [
      "x = { error: err.message };",
      "x = { error: (error as Error).message };",
      "x = { error: `failed: ${detail}` };",
      "x = { message: String(error) };",
      "x = { reason: e.message };",
      "x = { error:\n    error.message };",
      "x = { error: errorText(error) };",
      "x = { error: sanitizeErrorMessage(`${a}`) };",
      "x = { failureKind: \"write\" };",
      "x = a ? error.message : String(error);",
      ".catch((error: unknown) => console.error(`${error}`));",
    ].join("\n");
    expect(rawErrorFields(sample)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("D95: no error, message or reason field in the Worker's sources is set from raw text", async () => {
    const found: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.ts").scan({ cwd: new URL("..", import.meta.url).pathname })) {
      const source = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
      for (const line of rawErrorFields(source)) found.push(`${path}:${line}`);
    }
    expect(found).toEqual([]);
  });
});


describe("Spec 014 D95: one runtime boundary for every /health and run body", () => {
  test("D95: redactRecord sanitizes string values under error, message and reason at any depth and leaves other keys", async () => {
    const { redactRecord } = await import("../src/redact");
    const body = {
      releaseId: ACCOUNT_ID,
      lastRun: { error: LEAKY, sources: { github: { reason: `Bearer ${SECRET_TOKEN}`, failureKind: "transport" } } },
      modelErrors: [{ message: LEAKY, kind: "limit" }],
      ok: false,
    };
    const redacted = redactRecord(body);
    expect(redacted.releaseId).toBe(ACCOUNT_ID);
    expect(leaks({ ...redacted, releaseId: null })).toEqual([]);
    expect(redacted.lastRun.sources.github).toEqual({ reason: "Bearer [redacted]", failureKind: "transport" });
    expect(redacted.modelErrors[0]!.kind).toBe("limit");
    expect(body.lastRun.error).toBe(LEAKY); // the input is not mutated
  });

  test("D95: /health redacts a raw error that any object put under error, message or reason", () => {
    const health = mergeHealth(
      { ok: true, lastRun: { error: LEAKY, sources: { jira: { error: `Bearer ${SECRET_TOKEN}` } } } },
      { lastRun: { modelErrors: [{ message: LEAKY }] } },
      { failureKind: "internal", error: LEAKY },
      { lastFailure: { reason: LEAKY } },
    );
    expect(leaks(health)).toEqual([]);
  });

  test("D95: every Response.json in the Worker entry goes through the redacting helper", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(source.match(/Response\.json\(/gu)?.length ?? 0).toBe(1); // only inside the helper
  });
});

const HAN = /\p{Script=Han}/u;
const generatedTexts = (digest: DigestV1) => [
  ...digest.cards.filter((card) => card.status === "generated").flatMap((card) => card.sentences.map((sentence) => sentence.text)),
  ...digest.proposals.flatMap((row) => (row.line === null ? [] : [row.line.text])),
];

describe("Spec 014 D96: the English generated cache is seeded only from English objects", () => {
  test("D96: a previous en + zh-Hant pair with equal input hashes reuses the English sentences, and translations come from zh-Hant", async () => {
    const { bucket, result: first } = await published(new FakeModel());
    const previous = await objects(bucket, first);
    // Positive control: the pair shares every input hash, and the zh-Hant sentences are Chinese.
    const enHashes = previous.en.cards.flatMap((card) => (card.provenance === undefined ? [] : [card.provenance.inputHash]));
    expect(enHashes.length).toBeGreaterThan(0);
    expect(previous.zh.cards.flatMap((card) => (card.provenance === undefined ? [] : [card.provenance.inputHash]))).toEqual(enHashes);
    expect(generatedTexts(previous.zh).every((text) => HAN.test(text))).toBe(true);

    await publish(bucket, { releaseId: "next-release" });
    const model = new FakeModel();
    const result = await runDigest(input(bucket, { model }));
    const { en, zh } = await objects(bucket, result);
    expect(model.calls).not.toContain("summarize");
    expect(en.coverage.cached).toBeGreaterThan(0);
    expect(generatedTexts(en)).toEqual(generatedTexts(previous.en));
    expect(generatedTexts(en).some((text) => HAN.test(text))).toBe(false);
    // Translations are keyed by the English text hash and reused from zh-Hant: Chinese is not translated again.
    // Every English text is unchanged, so every translation is a cache hit.
    expect(model.calls).not.toContain("translate");
    expect(generatedTexts(zh)).toEqual(generatedTexts(previous.zh));
    expect(generatedTexts(zh).some((text) => text.includes("譯：譯："))).toBe(false);
  });

  test("D96: a polluted en object (Chinese sentences under English input hashes) is not reused; those cards are generated again", async () => {
    const { bucket, result: first } = await published(new FakeModel());
    const previous = await objects(bucket, first);
    // The object the bug published: en with zh-Hant sentences under the same provenance. The first
    // text is the one seen on Dev; the second has English names and identifiers (Latin-heavy).
    const chinese = ["Kafka 將支援設定 TLS 命名群組（KIP-1376，已提出）。", "Andrew Schofield 提議為 share group 新增 TLS 設定（KIP-1376）。"];
    let n = 0;
    const pollute = <T extends { text: string }>(sentence: T): T => ({ ...sentence, text: chinese[n++ % 2]! });
    const cards = previous.en.cards.map((card) => ({ ...card, sentences: card.sentences.map(pollute) }));
    const proposals = previous.en.proposals.map((row) => (row.line === null ? row : { ...row, line: pollute(row.line) }));
    bucket.objects.set(first.objectKeys!.en, JSON.stringify({ ...previous.en, cards, proposals }));
    await publish(bucket, { releaseId: "next-release" });
    const model = new FakeModel();
    const result = await runDigest(input(bucket, { model }));
    const { en } = await objects(bucket, result);
    expect(n).toBeGreaterThan(1);
    expect(generatedTexts(en).length).toBeGreaterThan(0);
    expect(generatedTexts(en).some((text) => HAN.test(text))).toBe(false);
    expect(model.calls.filter((kind) => kind === "summarize").length).toBe(generatedTexts(previous.en).length);
  });

  test("D96: with a translator whose zh-Hant output has no Han characters, en still reuses only the en sentences", async () => {
    // Without the en-only rule the zh-Hant text would replace the English one; the Han rule cannot catch it.
    const latinTranslator = () => new FakeModel((kind, _index, prompt) => {
      if (kind !== "translate") return undefined;
      const body = prompt.slice(prompt.indexOf("\n<"));
      const items = JSON.parse(body.slice(body.indexOf("["), body.lastIndexOf("]") + 1)) as { id: string; text: string }[];
      return JSON.stringify(items.map((item) => ({ id: item.id, text: `TR ${item.text}` })));
    });
    const { bucket, result: first } = await published(latinTranslator());
    const previous = await objects(bucket, first);
    expect(generatedTexts(previous.zh).every((text) => text.startsWith("TR "))).toBe(true); // positive control
    await publish(bucket, { releaseId: "next-release" });
    const model = latinTranslator();
    const result = await runDigest(input(bucket, { model }));
    const { en } = await objects(bucket, result);
    expect(model.calls).not.toContain("summarize");
    expect(generatedTexts(en)).toEqual(generatedTexts(previous.en));
    expect(generatedTexts(en).some((text) => text.startsWith("TR "))).toBe(false);
  });

  test("D96: a cached English sentence quoting a short CJK name is reused", async () => {
    const { bucket, result: first } = await published(new FakeModel());
    const previous = await objects(bucket, first);
    const index = previous.en.cards.findIndex((card) => card.status === "generated" && card.sentences.length > 0);
    const named = `${previous.en.cards[index]!.sentences[0]!.text.replace(/\.$/u, "")}, reviewed by 王小明.`;
    const cards = previous.en.cards.map((card, n) => (n !== index ? card
      : { ...card, sentences: card.sentences.map((sentence, m) => (m === 0 ? { ...sentence, text: named } : sentence)) }));
    bucket.objects.set(first.objectKeys!.en, JSON.stringify({ ...previous.en, cards }));
    await publish(bucket, { releaseId: "next-release" });
    const model = new FakeModel();
    const result = await runDigest(input(bucket, { model }));
    const { en } = await objects(bucket, result);
    expect(generatedTexts(en)).toContain(named);
    expect(model.calls).not.toContain("summarize");
  });
});
