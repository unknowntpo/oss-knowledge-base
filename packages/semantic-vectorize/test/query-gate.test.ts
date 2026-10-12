import { describe, expect, test } from "bun:test";

import {
  DEFAULT_QUERY_GATE_LIMITS,
  normalizeSemanticQuery,
  parseSemanticQueryAnswer,
  queryNeuronCharge,
  searchEmbeddingProfile,
  SemanticQueryGate,
  unboundQueryGateHealth,
  type EmbedTexts,
  type QueryGateConfig,
  type QueryGateLimits,
  type SemanticQueryAnswerV1,
} from "../src";
import { FakeVectorIndex, hashingEmbed, MemoryGateStorage, storeChunkVectors, testChunk } from "../src/testing";

const DIMENSIONS = 64;
const profile = searchEmbeddingProfile("fake@1", { model: "fake-model", modelRevision: "1", dimensions: DIMENSIONS, textAssemblyRevision: "title-text@1" });
const otherProfile = searchEmbeddingProfile("fake@2", { ...profile.revision, modelRevision: "2" });
const embedText = hashingEmbed(DIMENSIONS);
const KAFKA = "apache-kafka";
const DATAFUSION = "apache-datafusion";
const BGE_M3_NEURONS_PER_MILLION = 1_091;

const chunks = [
  testChunk({ recordId: "kafka:1", title: "Transaction timeout", text: "the transaction coordinator times out" }),
  testChunk({ recordId: "kafka:2", title: "Consumer rebalance", text: "rebalance is slow for a consumer group" }),
  testChunk({ recordId: "datafusion:1", projectId: DATAFUSION, title: "Aggregate spill", text: "spill aggregate state to disk" }),
];

async function setup(options: { readonly limits?: Partial<QueryGateLimits>; readonly start?: string } = {}) {
  const index = new FakeVectorIndex(DIMENSIONS);
  await storeChunkVectors(index, chunks, embedText, profile.semanticRevision);
  index.calls.length = 0;
  const storage = new MemoryGateStorage();
  const clock = { now: new Date(options.start ?? "2026-10-12T10:00:00.000Z") };
  const model = { calls: [] as string[][], fail: undefined as ((call: number) => Error | undefined) | undefined, answer: undefined as ((texts: readonly string[]) => readonly (readonly number[])[]) | undefined, hang: false, delayMs: 0 };
  const embed: EmbedTexts = async (texts, signal) => {
    model.calls.push([...texts]);
    const error = model.fail?.(model.calls.length);
    if (error !== undefined) throw error;
    if (model.hang) await new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    if (model.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, model.delayMs));
    return model.answer?.(texts) ?? texts.map(embedText);
  };
  const state = { config: { state: "on", profile, embed, index } as QueryGateConfig };
  const gate = new SemanticQueryGate({
    storage,
    config: () => state.config,
    neuronsPerMillionTokens: BGE_M3_NEURONS_PER_MILLION,
    isRefusal: (error) => error instanceof Error && error.message.includes("3036"),
    now: () => clock.now,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const queries = () => index.calls.filter((call) => call.startsWith("query:"));
  return { gate, index, storage, clock, model, state, embed, queries };
}

const ok = (answer: SemanticQueryAnswerV1) => {
  if (answer.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(answer)}`);
  return answer;
};
const both = [KAFKA, DATAFUSION];

describe("Spec 016 query gate: embedding, index queries, and the caches", () => {
  test("H62: a query is embedded once and each project's namespace is asked for 50 matches of the profile's revision", async () => {
    const { gate, index, model, queries } = await setup();
    // A vector of another revision and one with malformed metadata are in the index too.
    await storeChunkVectors(index, [testChunk({ recordId: "kafka:old", text: "transaction timeout" })], embedText, otherProfile.semanticRevision);
    await index.upsert([{ id: "junk", namespace: KAFKA, values: embedText("transaction timeout"), metadata: { r: profile.semanticRevision } }]);
    index.calls.length = 0;

    const answer = ok(await gate.query({ query: "transaction timeout", projectIds: both }));
    expect(model.calls).toEqual([["transaction timeout"]]);
    expect(queries().sort()).toEqual([`query:${DATAFUSION}:50`, `query:${KAFKA}:50`]);
    expect(answer.semanticRevision).toBe(profile.semanticRevision);
    expect(answer.cached).toBe(false);
    expect(answer.matches.map((match) => match.recordId)).toEqual(["kafka:1"]);
    expect(answer.matches[0]).toEqual({
      projectId: KAFKA,
      recordId: "kafka:1",
      ordinal: 0,
      groupRootRecordId: "kafka:1",
      fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/u),
      score: expect.any(Number),
    });
    expect(answer.matches.every((match) => match.score > 0)).toBe(true);
  });

  test("H62: a repeated query makes no model call and no index query, however it is spaced or composed", async () => {
    const { gate, model, queries } = await setup();
    const first = ok(await gate.query({ query: "transaction timeout", projectIds: both }));
    for (const query of ["transaction timeout", "  transaction \t timeout\n", "ｔｒａｎｓａｃｔｉｏｎ　timeout"]) {
      const again = ok(await gate.query({ query, projectIds: both }));
      expect(again.cached).toBe(true);
      expect(again.matches).toEqual(first.matches);
    }
    expect(model.calls).toHaveLength(1);
    expect(queries()).toHaveLength(2);
    expect(normalizeSemanticQuery("  ＫＲａｆｔ \n x ")).toBe("KRaft x");

    // Positive control: case is part of the text the model reads, so it is another query.
    expect(ok(await gate.query({ query: "Transaction Timeout", projectIds: both })).cached).toBe(false);
    expect(model.calls).toEqual([["transaction timeout"], ["Transaction Timeout"]]);
  });

  test("H62: matches are cached per project: another project costs one index query and no model call", async () => {
    const { gate, model, queries } = await setup();
    const kafka = ok(await gate.query({ query: "aggregate spill transaction", projectIds: [KAFKA] }));
    expect(kafka.matches.map((match) => match.projectId)).toEqual([KAFKA]);
    expect(queries()).toEqual([`query:${KAFKA}:50`]);

    const all = ok(await gate.query({ query: "aggregate spill transaction", projectIds: both }));
    expect(all.cached).toBe(true);
    expect(queries()).toEqual([`query:${KAFKA}:50`, `query:${DATAFUSION}:50`]);
    expect(all.matches.map((match) => match.projectId).sort()).toEqual([DATAFUSION, KAFKA]);
    // One project's cached matches are never answered for another.
    const datafusion = ok(await gate.query({ query: "aggregate spill transaction", projectIds: [DATAFUSION] }));
    expect(datafusion.matches.map((match) => match.recordId)).toEqual(["datafusion:1"]);
    expect(model.calls).toHaveLength(1);
    expect(queries()).toHaveLength(2);
  });

  test("H62: a tampered cache entry cannot answer for another project or with malformed matches", async () => {
    const { gate, storage } = await setup();
    ok(await gate.query({ query: "transaction timeout", projectIds: [KAFKA] }));
    const [key] = storage.keys("m:");
    const stored = storage.values.get(key!) as { at: number; matches: unknown[] };
    storage.values.set(key!, { at: stored.at, matches: [...stored.matches, { ...(stored.matches[0] as object), projectId: DATAFUSION }, { recordId: 7 }, null] });
    expect(ok(await gate.query({ query: "transaction timeout", projectIds: [KAFKA] })).matches).toEqual(stored.matches as never);
  });

  test("H62: another semantic revision shares no cache entry", async () => {
    const { gate, state, model, embed, index, queries } = await setup();
    ok(await gate.query({ query: "transaction timeout", projectIds: [KAFKA] }));
    state.config = { state: "on", profile: otherProfile, embed, index };
    const answer = ok(await gate.query({ query: "transaction timeout", projectIds: [KAFKA] }));
    expect(answer.cached).toBe(false);
    expect(answer.semanticRevision).toBe(otherProfile.semanticRevision);
    // The index holds only vectors of the first revision.
    expect(answer.matches).toEqual([]);
    expect(model.calls).toHaveLength(2);
    expect(queries()).toHaveLength(2);
  });

  test("H62: matches are asked again after an hour, with the cached embedding; one millisecond earlier they are not", async () => {
    const { gate, clock, model, queries } = await setup();
    ok(await gate.query({ query: "transaction timeout", projectIds: [KAFKA] }));
    clock.now = new Date(clock.now.getTime() + DEFAULT_QUERY_GATE_LIMITS.matchTtlMs - 1);
    expect(ok(await gate.query({ query: "transaction timeout", projectIds: [KAFKA] })).cached).toBe(true);
    expect(queries()).toHaveLength(1);
    clock.now = new Date(clock.now.getTime() + 1);
    expect(ok(await gate.query({ query: "transaction timeout", projectIds: [KAFKA] })).cached).toBe(true);
    expect(queries()).toHaveLength(2);
    expect(model.calls).toHaveLength(1);
  });

  test("H62: identical queries made at once share one model call and one index query per project", async () => {
    const { gate, model, queries } = await setup();
    // The model takes long enough for every caller to arrive while the first call is in flight.
    model.delayMs = 20;
    const answers = await Promise.all(Array.from({ length: 8 }, () => gate.query({ query: "transaction timeout", projectIds: both })));
    expect(answers.map((answer) => answer.status)).toEqual(Array.from({ length: 8 }, () => "ok"));
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(model.calls).toHaveLength(1);
    expect(queries()).toHaveLength(2);
    expect((await gate.health()).today).toMatchObject({ neurons: 1, modelCalls: 1, indexQueries: 2 });
  });

  test("H62: a cached embedding is dropped after its retention, a few per miss, with its matches", async () => {
    const { gate, clock, storage } = await setup({ limits: { vectorRetentionDays: 2, evictPerMiss: 2 } });
    for (const query of ["one", "two", "three"]) ok(await gate.query({ query, projectIds: both }));
    expect([storage.keys("q:").length, storage.keys("m:").length, storage.keys("e:").length]).toEqual([3, 6, 3]);

    // Two days later nothing is past retention yet (the cutoff day itself is kept).
    clock.now = new Date("2026-10-14T10:00:00.000Z");
    ok(await gate.query({ query: "four", projectIds: both }));
    expect(storage.keys("q:")).toHaveLength(4);
    // On the third day each miss drops two of the three expired entries.
    clock.now = new Date("2026-10-15T10:00:00.000Z");
    ok(await gate.query({ query: "five", projectIds: both }));
    expect([storage.keys("q:").length, storage.keys("m:").length, storage.keys("e:").length]).toEqual([3, 6, 3]);
    ok(await gate.query({ query: "six", projectIds: both }));
    expect([storage.keys("q:").length, storage.keys("m:").length, storage.keys("e:").length]).toEqual([3, 6, 3]);
    expect(storage.keys("e:").map((key) => key.slice(2, 12))).toEqual(["2026-10-14", "2026-10-15", "2026-10-15"]);
  });
});

describe("Spec 016 query gate: budget", () => {
  test("H63: the day's neuron cap is hard: the next distinct query is refused without a call, cached ones still answer, and the next UTC day starts over", async () => {
    const { gate, clock, model, queries } = await setup({ limits: { dailyNeuronCap: 3 }, start: "2026-10-12T22:30:00.000Z" });
    for (const query of ["one", "two", "three"]) ok(await gate.query({ query, projectIds: [KAFKA] }));
    expect((await gate.health()).today).toMatchObject({ date: "2026-10-12", neurons: 3, neuronCap: 3, modelCalls: 3, indexQueries: 3 });

    expect(await gate.query({ query: "four", projectIds: [KAFKA] })).toEqual({ status: "over-budget", retryAfterMs: 90 * 60_000 });
    expect(model.calls).toHaveLength(3);
    expect(queries()).toHaveLength(3);
    expect((await gate.health()).today).toMatchObject({ neurons: 3, modelCalls: 3, indexQueries: 3 });
    expect(ok(await gate.query({ query: "two", projectIds: [KAFKA] })).cached).toBe(true);

    clock.now = new Date("2026-10-12T23:59:59.999Z");
    expect(await gate.query({ query: "four", projectIds: [KAFKA] })).toEqual({ status: "over-budget", retryAfterMs: 1 });
    clock.now = new Date("2026-10-13T00:00:00.000Z");
    expect(ok(await gate.query({ query: "four", projectIds: [KAFKA] })).cached).toBe(false);
    expect((await gate.health()).today).toMatchObject({ date: "2026-10-13", neurons: 1, modelCalls: 1, indexQueries: 1 });
  });

  test("H63: the hourly call cap refuses until the next clock hour", async () => {
    const { gate, clock, model } = await setup({ limits: { maxModelCallsPerHour: 2 }, start: "2026-10-12T10:40:00.000Z" });
    ok(await gate.query({ query: "one", projectIds: [KAFKA] }));
    ok(await gate.query({ query: "two", projectIds: [KAFKA] }));
    expect(await gate.query({ query: "three", projectIds: [KAFKA] })).toEqual({ status: "over-budget", retryAfterMs: 20 * 60_000 });
    expect((await gate.health()).today).toMatchObject({ hour: "2026-10-12T10", hourModelCalls: 2, hourModelCallCap: 2 });
    clock.now = new Date("2026-10-12T11:00:00.000Z");
    ok(await gate.query({ query: "three", projectIds: [KAFKA] }));
    expect(model.calls).toHaveLength(3);
    expect((await gate.health()).today).toMatchObject({ hour: "2026-10-12T11", hourModelCalls: 1, modelCalls: 3 });
  });

  test("H63: the index-query cap is checked before the model is called, so a refused query spends nothing", async () => {
    const { gate, model, queries } = await setup({ limits: { maxIndexQueriesPerDay: 3 } });
    ok(await gate.query({ query: "one", projectIds: both }));
    // Two more index queries would make four.
    expect((await gate.query({ query: "two", projectIds: both })).status).toBe("over-budget");
    expect(model.calls).toHaveLength(1);
    expect(queries()).toHaveLength(2);
    expect((await gate.health()).today).toMatchObject({ neurons: 1, modelCalls: 1, indexQueries: 2, indexQueryCap: 3 });
    // One still fits.
    ok(await gate.query({ query: "two", projectIds: [KAFKA] }));
    expect((await gate.health()).today).toMatchObject({ neurons: 2, indexQueries: 3 });
  });

  test("H63: a burst of distinct queries made at once cannot pass the cap", async () => {
    const { gate, model, queries } = await setup({ limits: { dailyNeuronCap: 10 } });
    const answers = await Promise.all(Array.from({ length: 50 }, (_, index) => gate.query({ query: `distinct query ${index}`, projectIds: [KAFKA] })));
    expect(answers.filter((answer) => answer.status === "ok")).toHaveLength(10);
    expect(answers.filter((answer) => answer.status === "over-budget")).toHaveLength(40);
    expect(model.calls).toHaveLength(10);
    expect(queries()).toHaveLength(10);
    expect((await gate.health()).today).toMatchObject({ neurons: 10, modelCalls: 10, indexQueries: 10 });
    expect((await gate.health()).sinceStart).toEqual({ requests: 50, cached: 0, embedded: 10, overBudget: 40, failed: 0 });
  });

  test("H63: a call is counted before it is made, so one that fails or never answers is still in the ledger", async () => {
    const { gate, model } = await setup({ limits: { callTimeoutMs: 5 } });
    model.fail = (call) => (call === 1 ? new Error("model exploded") : undefined);
    expect(await gate.query({ query: "one", projectIds: [KAFKA] })).toEqual({ status: "failed" });
    model.hang = true;
    expect(await gate.query({ query: "two", projectIds: [KAFKA] })).toEqual({ status: "failed" });
    expect((await gate.health()).today).toMatchObject({ neurons: 2, modelCalls: 2, indexQueries: 2 });
    expect((await gate.health()).lastError).toMatchObject({ kind: "model", message: "The embedding model did not answer within 5 ms" });
  });

  test("H63: the charge is an upper bound on the tokenizer, and every accepted query costs one neuron at the bge-m3 price", () => {
    expect(queryNeuronCharge("txn", BGE_M3_NEURONS_PER_MILLION)).toBe(1);
    // 500 characters cannot be more than 503 tokens: 0.55 neurons.
    expect(queryNeuronCharge("交".repeat(500), BGE_M3_NEURONS_PER_MILLION)).toBe(1);
    expect(queryNeuronCharge("x".repeat(913), BGE_M3_NEURONS_PER_MILLION)).toBe(1);
    expect(queryNeuronCharge("x".repeat(914), BGE_M3_NEURONS_PER_MILLION)).toBe(2);
    expect(queryNeuronCharge("x".repeat(500), 21_818)).toBe(11);
    expect(DEFAULT_QUERY_GATE_LIMITS).toMatchObject({ dailyNeuronCap: 1_000, maxIndexQueriesPerDay: 1_000, maxModelCallsPerHour: 100, topK: 50, matchTtlMs: 3_600_000 });
  });

  test("H63: a text that normalizes to more than 500 characters is not embedded", async () => {
    const { gate, model } = await setup();
    // U+FDFA is one character that NFKC expands to 18.
    expect(await gate.query({ query: "ﷺ".repeat(100), projectIds: [KAFKA] })).toEqual({ status: "failed" });
    expect(model.calls).toEqual([]);
    expect(ok(await gate.query({ query: "x".repeat(500), projectIds: [KAFKA] })).cached).toBe(false);
    expect((await gate.health()).today).toMatchObject({ neurons: 1, modelCalls: 1 });
  });
});

describe("Spec 016 query gate: failures", () => {
  test("H64: a model error is `failed` with the sanitized error in health and nothing cached; the next query works", async () => {
    const { gate, model, storage, queries } = await setup();
    model.fail = (call) => (call === 1 ? new Error("upstream said Bearer abc.def.ghi and key 0123456789abcdef0123456789abcdef0123") : undefined);
    expect(await gate.query({ query: "one", projectIds: [KAFKA] })).toEqual({ status: "failed" });
    const health = await gate.health();
    expect(health.lastError).toEqual({ kind: "model", message: "upstream said Bearer [redacted] and key [redacted]", at: "2026-10-12T10:00:00.000Z" });
    expect(health.pausedUntil).toBeNull();
    expect(queries()).toEqual([]);
    expect(storage.keys("q:")).toEqual([]);
    expect(ok(await gate.query({ query: "one", projectIds: [KAFKA] })).cached).toBe(false);
    expect(health.sinceStart.failed).toBe(1);
  });

  test.each([
    ["a wrong dimension", (texts: readonly string[]) => texts.map(() => [1, 2, 3]), "Embedding has 3 dimensions, expected 64"],
    ["two vectors for one text", (texts: readonly string[]) => [...texts, ...texts].map(embedText), "Query embedding did not return one vector"],
    ["no vector", () => [], "Query embedding did not return one vector"],
  ] as const)("H64: %s is a model failure and is not cached", async (_, answer, message) => {
    const { gate, model, storage, queries } = await setup();
    model.answer = answer;
    expect(await gate.query({ query: "one", projectIds: [KAFKA] })).toEqual({ status: "failed" });
    expect((await gate.health()).lastError).toMatchObject({ kind: "model", message });
    expect(storage.keys("q:")).toEqual([]);
    expect(queries()).toEqual([]);
  });

  test("H64: a refusal pauses model calls for 15 minutes: distinct queries are over budget without a call, cached ones answer", async () => {
    const { gate, model, clock } = await setup();
    ok(await gate.query({ query: "cached", projectIds: [KAFKA] }));
    model.fail = (call) => (call === 2 ? new Error("3036: capacity temporarily exceeded") : undefined);
    expect(await gate.query({ query: "one", projectIds: [KAFKA] })).toEqual({ status: "failed" });
    expect(await gate.health()).toMatchObject({ pausedUntil: "2026-10-12T10:15:00.000Z", lastError: { kind: "model-limit" } });

    expect(await gate.query({ query: "two", projectIds: [KAFKA] })).toEqual({ status: "over-budget", retryAfterMs: 15 * 60_000 });
    expect(model.calls).toHaveLength(2);
    expect(ok(await gate.query({ query: "cached", projectIds: [KAFKA] })).cached).toBe(true);
    clock.now = new Date("2026-10-12T10:15:00.000Z");
    expect(ok(await gate.query({ query: "two", projectIds: [KAFKA] })).cached).toBe(false);
    expect((await gate.health()).pausedUntil).toBeNull();
  });

  test("H64: an index failure is `failed`; the embedding it paid for is kept, so the retry makes no model call", async () => {
    const { gate, index, model } = await setup();
    index.fail = (operation, call) => (operation === "query" && call === 0 ? new Error("index unavailable") : undefined);
    expect(await gate.query({ query: "transaction timeout", projectIds: [KAFKA] })).toEqual({ status: "failed" });
    expect((await gate.health()).lastError).toMatchObject({ kind: "vector-store", message: "index unavailable" });
    const retry = ok(await gate.query({ query: "transaction timeout", projectIds: [KAFKA] }));
    expect(retry.cached).toBe(true);
    expect(retry.matches.map((match) => match.recordId)).toEqual(["kafka:1"]);
    expect(model.calls).toHaveLength(1);
    expect((await gate.health()).today).toMatchObject({ neurons: 1, modelCalls: 1, indexQueries: 2 });
  });

  test("H64: without a profile the gate is disabled, a configuration error is `failed`, and neither calls anything", async () => {
    const { gate, state, model, queries, storage } = await setup();
    state.config = { state: "off" };
    expect(await gate.query({ query: "one", projectIds: [KAFKA] })).toEqual({ status: "disabled" });
    expect(await gate.health()).toMatchObject({ enabled: false, semanticRevision: null });
    state.config = { state: "error", error: "SEARCH_EMBEDDING is \"bge-m3@1\" but the AI binding is missing" };
    expect(await gate.query({ query: "one", projectIds: [KAFKA] })).toEqual({ status: "failed" });
    expect(await gate.health()).toMatchObject({ enabled: false, configError: "SEARCH_EMBEDDING is \"bge-m3@1\" but the AI binding is missing" });
    expect(model.calls).toEqual([]);
    expect(queries()).toEqual([]);
    expect(storage.keys("spend:")).toEqual([]);
  });

  test.each([
    ["an empty query", { query: "   ", projectIds: [KAFKA] }],
    ["a query that is not a string", { query: 7, projectIds: [KAFKA] }],
    ["no project", { query: "one", projectIds: [] }],
    ["projects that are not a list", { query: "one", projectIds: KAFKA }],
    ["more projects than allowed", { query: "one", projectIds: Array.from({ length: 9 }, (_, index) => `project-${index}`) }],
    ["a project id that is no namespace", { query: "one", projectIds: ["x".repeat(65)] }],
    ["a project id that is not a string", { query: "one", projectIds: [7] }],
    ["no body", undefined],
  ])("H64: %s is `failed` and nothing is called or counted", async (_, request) => {
    const { gate, model, queries, storage } = await setup();
    expect(await gate.query(request as never)).toEqual({ status: "failed" });
    expect(model.calls).toEqual([]);
    expect(queries()).toEqual([]);
    expect(storage.keys("spend:")).toEqual([]);
  });

  test("H64: a cache write that fails does not fail the answer", async () => {
    const { gate, storage, model } = await setup();
    storage.failPut = (key) => (key.startsWith("q:") || key.startsWith("m:") ? new Error("storage full") : undefined);
    const answer = ok(await gate.query({ query: "transaction timeout", projectIds: [KAFKA] }));
    expect(answer.matches.map((match) => match.recordId)).toEqual(["kafka:1"]);
    expect((await gate.health()).lastError).toMatchObject({ kind: "internal", message: "storage full" });
    // Nothing was cached, so the same query pays again; the ledger holds both.
    ok(await gate.query({ query: "transaction timeout", projectIds: [KAFKA] }));
    expect(model.calls).toHaveLength(2);
    expect((await gate.health()).today).toMatchObject({ neurons: 2 });
  });

  test("H64: a ledger that cannot be written refuses to spend", async () => {
    const { gate, storage, model, queries } = await setup();
    storage.failPut = (key) => (key.startsWith("spend:") ? new Error("storage unavailable") : undefined);
    expect(await gate.query({ query: "one", projectIds: [KAFKA] })).toEqual({ status: "failed" });
    expect(model.calls).toEqual([]);
    expect(queries()).toEqual([]);
  });

  test("H69: health of a gate that is not bound, and of one that has answered", async () => {
    expect(unboundQueryGateHealth(new Date("2026-10-12T10:30:00.000Z"))).toEqual({
      enabled: false,
      semanticRevision: null,
      today: { date: "2026-10-12", neurons: 0, modelCalls: 0, indexQueries: 0, hour: "2026-10-12T10", hourModelCalls: 0, neuronCap: 1_000, indexQueryCap: 1_000, hourModelCallCap: 100 },
      pausedUntil: null,
      lastError: null,
      sinceStart: { requests: 0, cached: 0, embedded: 0, overBudget: 0, failed: 0 },
    });
    const { gate } = await setup();
    ok(await gate.query({ query: "one", projectIds: both }));
    ok(await gate.query({ query: "one", projectIds: both }));
    expect(await gate.health()).toEqual({
      enabled: true,
      semanticRevision: profile.semanticRevision,
      today: { date: "2026-10-12", neurons: 1, modelCalls: 1, indexQueries: 2, hour: "2026-10-12T10", hourModelCalls: 1, neuronCap: 1_000, indexQueryCap: 1_000, hourModelCallCap: 100 },
      pausedUntil: null,
      lastError: null,
      sinceStart: { requests: 2, cached: 1, embedded: 1, overBudget: 0, failed: 0 },
    });
  });
});

describe("Spec 016 query gate: answers read by the caller", () => {
  const match = { projectId: KAFKA, recordId: "kafka:1", ordinal: 0, groupRootRecordId: "kafka:1", fingerprint: "f".repeat(32), score: 0.5 };

  test("H58: a well-formed answer is read as it is", () => {
    expect(parseSemanticQueryAnswer({ status: "ok", semanticRevision: "r", cached: true, matches: [match] })).toEqual({ status: "ok", semanticRevision: "r", cached: true, matches: [match] });
    expect(parseSemanticQueryAnswer({ status: "over-budget", retryAfterMs: 5 })).toEqual({ status: "over-budget", retryAfterMs: 5 });
    expect(parseSemanticQueryAnswer({ status: "disabled" })).toEqual({ status: "disabled" });
  });

  test.each([
    ["no object", null],
    ["an unknown status", { status: "fine" }],
    ["ok without a revision", { status: "ok", matches: [] }],
    ["ok with an empty revision", { status: "ok", semanticRevision: "", matches: [] }],
    ["ok without matches", { status: "ok", semanticRevision: "r" }],
    ["an error text", { status: "failed", error: "Bearer secret" }],
  ])("H58: %s is `failed`, and carries nothing else", (_, value) => {
    expect(parseSemanticQueryAnswer(value)).toEqual({ status: "failed" });
  });

  test("H58: malformed matches are dropped, and a wait that is no positive number is none", () => {
    const answer = parseSemanticQueryAnswer({
      status: "ok",
      semanticRevision: "r",
      cached: "yes",
      matches: [match, { ...match, ordinal: -1 }, { ...match, ordinal: 1.5 }, { ...match, score: 0 }, { ...match, score: "1" }, { ...match, score: Number.NaN },
        { ...match, recordId: "" }, { ...match, projectId: 7 }, { ...match, fingerprint: undefined }, null, "x"],
    });
    expect(answer).toEqual({ status: "ok", semanticRevision: "r", cached: false, matches: [match] });
    for (const retryAfterMs of [-1, "5", Number.POSITIVE_INFINITY, undefined]) {
      expect(parseSemanticQueryAnswer({ status: "over-budget", retryAfterMs })).toEqual({ status: "over-budget", retryAfterMs: 0 });
    }
  });
});
