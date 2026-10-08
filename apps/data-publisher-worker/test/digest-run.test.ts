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
  callEstimate, CLEF_EXCERPT_CHARS, clefStateTokens, type ClefModel, type ClefRequest, type ClefResponse,
} from "@oss-knowledge-base/reference-pipeline";
import { ModelCallError, ModelCalls, RETRY_DELAY_MS, type DigestModel } from "../src/digest/model";
import { DIGEST_ROOT, runDigest, type DigestRunInput, type DigestRunResult } from "../src/digest/run";
import { DEFER_MS, DigestRunner, type DigestStorage } from "../src/digest/runner";
import type { DigestBucket } from "../src/digest/store";
import { cronTarget, digestModel, mergeHealth } from "../src/index";
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
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly fail: (kind: Kind, index: number, prompt: string) => Error | string | undefined = () => undefined) {}

  async run(_model: PricedModel, prompt: string, _maxTokens: number): Promise<string> {
    const kind = kindOf(prompt);
    const index = this.calls.filter((item) => item === kind).length;
    this.calls.push(kind);
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
    const answers = Object.fromEntries(request.state.map((item) => {
      const rules = rulesClassify({ title: item.title }, KAFKA_DIGEST_PROFILE);
      const probabilities = Object.fromEntries(options.map((option) => [option,
        option === "routine" ? (rules.routine ? 0.9 : 0.05) : option === rules.topic ? 0.9 : 0.01]));
      return [item.ref, { choice: rules.topic, probabilities }];
    }));
    return { answers, usage: { prompt_tokens: Math.round(JSON.stringify(request).length / 3) } };
  }
}

const noDelay = async () => {};

function input(bucket: MemoryBucket, overrides: Partial<DigestRunInput> = {}): DigestRunInput {
  return { bucket, profile: KAFKA_DIGEST_PROFILE, now: () => NOW, delay: noDelay, spentToday: 0, cap: 4_500, dryRun: false, ...overrides };
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

function runner(bucket: MemoryBucket, storage: MemoryStorage, publisherRunning: () => Promise<boolean> = async () => false, model?: DigestModel) {
  let clock = NOW.getTime();
  const instance = new DigestRunner({
    storage, bucket, profile: KAFKA_DIGEST_PROFILE, environment: "development", enabled: true,
    ...(model === undefined ? {} : { model }),
    now: () => new Date(clock), delay: noDelay, publisherRunning,
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
    const batches = Math.ceil(items / 25);
    const firstBatch = sentences.slice(0, 25);
    const laterTranslated = items > 25 && sentences.slice(25).every((sentence) => sentence.notTranslated !== true);
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
  "run control|constructed: digest cron unset; cron 7 * * * * fires": async () => cronTarget("7 * * * *", undefined),
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
  "rate limit|constructed: today's estimated spend already at the Dev cap (4,500)": async () => {
    const model = new FakeModel();
    const { bucket, result } = await published(model, { spentToday: 4_500 });
    const { en } = await objects(bucket, result);
    return model.calls.length === 0 && result.limited && Object.values(en.features).every((item) => item.source === "rules") && en.cards.every((card) => card.status === "fallback")
      ? "no model call; limited true; rules features and fallback cards" : `${model.calls.length}`;
  },
  "recovery|constructed: an en with a model fallback (a card's summary failed) for the same release": async () => {
    const { bucket, result } = await published(new FakeModel((kind, index) => (kind === "summarize" && index < 2 ? new Error("down") : undefined)));
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
  "run control|constructed: DIGEST_CRON 37 1 * * * set; the publisher cron 7 * * * * fires": async () => cronTarget("7 * * * *", "37 1 * * *"),
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
    const estimate = callEstimate("@cf/meta/llama-3.3-70b-instruct-fp8-fast", prompt, 300);
    const model: DigestModel = { run: async () => "ok" };
    const calls = new ModelCalls(model, { spent: 4_500 - estimate, cap: 4_500 }, noDelay);
    const output = await calls.call("@cf/meta/llama-3.3-70b-instruct-fp8-fast", prompt, 300);
    const over = new ModelCalls(model, { spent: 4_501 - estimate, cap: 4_500 }, noDelay);
    const skipped = await over.call("@cf/meta/llama-3.3-70b-instruct-fp8-fast", prompt, 300);
    return output === "ok" && skipped === undefined && over.limited ? "the call runs" : `${output} ${skipped}`;
  },
  "spend|constructed: a call that fails twice": async () => {
    const prompt = "x".repeat(4_000);
    const estimate = callEstimate("@cf/meta/llama-3.3-70b-instruct-fp8-fast", prompt, 300);
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
    return `${batches.length} requests: ${batches.map((batch) => batch.length).join(" + ")} questions`;
  },
  "clef|constructed: answer t1 routine 0.6, other 0.4": async () => {
    const feature = await oneClef({ routine: 0.6, other: 0.4 });
    return placementOf(feature) === "routine" ? `routine section (routineConfidence ${feature.routineConfidence.toFixed(2)})` : "card";
  },
  "clef|captured week, cold run with Clef": async () => {
    const model = new FakeDecider();
    await published(model);
    const states = model.requests.map((request) => clefStateTokens(request));
    const questions = model.requests.map((request) => Object.keys(request.questions).length);
    const excerpts = model.requests.flatMap((request) => request.state.map((item) => item.excerpt.length));
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
    const state = clef.inputs.state as { ref: string; title: string; excerpt: string }[];
    const question = Object.values(clef.inputs.questions as Record<string, { type: string; criteria: Record<string, string> }>)[0]!;
    return clef.inputs.model === "clef-flash" && JSON.stringify(Object.keys(state[0]!)) === JSON.stringify(["ref", "title", "excerpt"])
      && Object.keys(clef.inputs.questions as object).length === state.length && question.type === "choice" && Object.keys(question.criteria).length === 13
      ? "model clef-flash; state [{ref, title, excerpt}]; one choice question per thread with 13 options (12 topics + routine)" : JSON.stringify(clef.inputs).slice(0, 200);
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
    const asked = model.requests.some((request) => request.state.some((item) => item.title === original.title));
    return feature.source === "cache" && !asked ? "Clef features reused from cache; 0 Clef requests for it" : `${feature.source} ${asked}`;
  },
  "clef|constructed: answer for t2 missing, t3 probability 1.4": async () => {
    const model = new FakeDecider(undefined, (request) => {
      const options = [...KAFKA_DIGEST_PROFILE.taxonomy.topics, "routine"];
      const good = Object.fromEntries(options.map((option) => [option, option === "other" ? 0.9 : 0.01]));
      return { answers: Object.fromEntries(request.state.flatMap((item) =>
        item.ref === "t2" ? [] : [[item.ref, { probabilities: item.ref === "t3" ? { ...good, other: 1.4 } : good }]])) };
    });
    const { bucket, result } = await published(model);
    const { en } = await objects(bucket, result);
    const first = model.requests[0]!.state.map((item) => item.title);
    const byTitle = (title: string) => Object.values(en.features).find((item) => en.threads[item.displayId]?.title === title)!;
    const sources = first.map((title) => byTitle(title).source);
    return sources[1] === "rules" && sources[2] === "rules" && sources[0] === "model" && sources.slice(3).every((source) => source === "model") && en.coverage.fallbacks > 0
      ? "t2 and t3 get rules features; the rest model; batch counted as a fallback" : sources.join();
  },
  "clef|constructed: the Clef request fails twice": async () => {
    let failures = 0;
    const model = new FakeDecider(undefined, (request) =>
      (request.state.some((item) => item.title.includes("New committer")) && failures++ < 2 ? new Error("down") : undefined));
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
  "spend|constructed: the 46th model request of one run": async () => {
    const calls = new ModelCalls({ run: async () => "ok" }, { spent: 0, cap: 1_000_000 }, noDelay);
    for (let n = 0; n < MAX_CALLS_PER_RUN; n += 1) await calls.call("@cf/qwen/qwen3-30b-a3b-fp8", "p", 10);
    const before = calls.limited;
    const last = await calls.call("@cf/qwen/qwen3-30b-a3b-fp8", "p", 10);
    return MAX_CALLS_PER_RUN === 45 && !before && last === undefined && calls.limited && calls.calls === 45 ? "skipped; limited true" : `${calls.calls}`;
  },
  "run control|DIGEST_ENABLED unset (Prod)": async () => {
    const bucket = new MemoryBucket();
    await publish(bucket);
    const storage = new MemoryStorage();
    const disabled = new DigestRunner({
      storage, bucket, profile: KAFKA_DIGEST_PROFILE, environment: "production", enabled: false,
      now: () => NOW, delay: noDelay, publisherRunning: async () => false,
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

async function oneClef(probabilities: Record<string, number>) {
  const options = [...KAFKA_DIGEST_PROFILE.taxonomy.topics, "routine"];
  const full = Object.fromEntries(options.map((option) => [option, probabilities[option] ?? 0]));
  const { clefFeatures } = await import("@oss-knowledge-base/reference-pipeline");
  const thread = { displayId: "KAFKA-PR-1", entryId: "e", title: "t", source: "github" as const, status: "open", url: null, rootExcerpt: "", records: [], score: 1, lastActivityAt: NOW.toISOString() };
  return clefFeatures({ answers: { t1: { probabilities: full } } }, [thread], KAFKA_DIGEST_PROFILE, { model: "m", prompt: "p", generatedAt: "g" }).features.get("KAFKA-PR-1")!;
}

function placementOf(feature: { routine: boolean; routineConfidence: number }): "routine" | "card" {
  return feature.routine && feature.routineConfidence >= 0.6 ? "routine" : "card";
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
  test("D65: deploy config: crons are the publisher's or DIGEST_CRON; Dev has AI through osskb-digest-dev; Prod has no digest", async () => {
    type Config = { triggers?: { crons?: string[] }; vars?: Record<string, string>; ai?: { binding?: string } };
    const read = async (name: string) => JSON.parse((await Bun.file(new URL(`../${name}`, import.meta.url)).text())
      .replace(/^\s*\/\/.*$/gmu, "")) as Config;
    const dev = await read("wrangler.development.jsonc");
    const prod = await read("wrangler.production.jsonc");
    for (const [config, publisherCron] of [[dev, "7 * * * *"], [prod, "37 * * * *"]] as const) {
      const crons = config.triggers?.crons ?? [];
      const digestCron = config.vars?.DIGEST_CRON;
      // A cron entry without DIGEST_CRON would start an extra publication; DIGEST_CRON without its entry never fires.
      for (const cron of crons) expect(cron === publisherCron || cron === digestCron).toBe(true);
      if (digestCron !== undefined) expect(crons).toContain(digestCron);
      expect(cronTarget(publisherCron, digestCron)).toBe("publisher");
    }
    // Shipped disabled: no digest cron until a reviewed Dev dry run.
    expect(dev.vars?.DIGEST_CRON).toBeUndefined();
    expect(dev.ai?.binding).toBe("AI");
    expect(dev.vars).toMatchObject({ DIGEST_ENABLED: "true", DIGEST_MODEL: "workers-ai", DIGEST_GATEWAY_ID: "osskb-digest-dev" });
    expect(prod.ai).toBeUndefined();
    expect(prod.vars?.DIGEST_ENABLED).toBeUndefined();
    expect(prod.vars?.DIGEST_MODEL).toBeUndefined();
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
    expect(digest.today).toEqual({ date: "2026-10-07", estimatedNeurons: 0, cap: 4_500 });
    const lastRun = digest.lastRun!;
    for (const field of ["ok", "completedAt", "durationMs", "sourceReleaseId", "objectKeys", "candidates", "cached", "modelCalls", "fallbacks", "limited", "deferred", "estimatedNeurons", "dryRun"]) {
      expect(lastRun).toHaveProperty(field);
    }
    expect(lastRun.ok).toBe(true);
    expect(lastRun.candidates).toBe(234);
    const publisher = { environment: "development", running: false, scheduled: false, phase: null, lastRun: { ok: true }, sources: null };
    expect(mergeHealth(publisher, digest)).toEqual({ ...publisher, digest, reviewQueue: null });
    expect(mergeHealth(publisher, null)).toEqual({ ...publisher, digest: null, reviewQueue: null });
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
