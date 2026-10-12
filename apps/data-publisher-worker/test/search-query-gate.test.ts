import { describe, expect, test } from "bun:test";
import { DAILY_CAP, DAILY_NEURON_BUDGET, DIGEST_NEURON_CALIBRATION, EMBEDDING_TOKEN_CALIBRATION, embeddingNeurons, estimateTokens, neurons, PRICES, USD_PER_NEURON } from "@oss-knowledge-base/reference-pipeline";
import { DEFAULT_QUERY_GATE_LIMITS, SEARCH_QUERY_GATE_OBJECT_NAME, VECTOR_LIMITS } from "@oss-knowledge-base/semantic-vectorize";
import { FakeVectorIndex, MemoryGateStorage, storeChunkVectors, testChunk } from "@oss-knowledge-base/semantic-vectorize/testing";

import worker, { mergeHealth, SearchQueryGate } from "../src/index";
import * as entry from "../src/index";
import { resolveSearchShardRoots } from "../src/pipeline";
import { DEFAULT_EMBEDDING_LIMITS } from "../src/search-embedding/run";
import { createSearchQueryGate, searchQueryGateConfig, type SearchQueryGateDeps } from "../src/search-query/gate";

const DIMENSIONS = 1_024;
const SEMANTIC_REVISION = "@cf/baai/bge-m3@1:1024:title-text@1";
const vector = (text: string) => Array.from({ length: DIMENSIONS }, (_, n) => ((text.length * 7 + n) % 11) + 1);

class FakeAi {
  readonly calls: { readonly model: string; readonly inputs: Record<string, unknown>; readonly options: unknown }[] = [];
  fail: Error | undefined;
  async run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, inputs, options });
    if (this.fail !== undefined) throw this.fail;
    return { data: (inputs.text as string[]).map(vector) };
  }
}

async function setup(overrides: Partial<SearchQueryGateDeps> = {}) {
  const ai = new FakeAi();
  const index = new FakeVectorIndex(DIMENSIONS);
  await storeChunkVectors(index, [testChunk({ recordId: "kafka:1", title: "Transaction timeout", text: "times out" })], vector, SEMANTIC_REVISION);
  index.calls.length = 0;
  const storage = new MemoryGateStorage();
  const clock = { now: new Date("2026-10-12T10:00:00.000Z") };
  const gate = createSearchQueryGate({
    storage, flag: "bge-m3@1", gatewayId: "osskb-search-dev", digestGatewayId: "osskb-digest-dev", ai, index,
    now: () => clock.now,
    ...overrides,
  });
  return { ai, index, storage, clock, gate };
}

describe("Spec 016 query gate of the data Worker", () => {
  test("H30: a query is embedded with @cf/baai/bge-m3 through the search gateway, never its cache, and never the digest's gateway", async () => {
    const { ai, index, gate } = await setup();
    const answer = await gate.query({ query: "  transaction\ttimeout ", projectIds: ["apache-kafka"] });
    expect(answer).toMatchObject({ status: "ok", semanticRevision: SEMANTIC_REVISION, cached: false });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.model).toBe("@cf/baai/bge-m3");
    expect(ai.calls[0]!.inputs).toEqual({ text: ["transaction timeout"], truncate_inputs: true });
    expect(ai.calls[0]!.options).toEqual({ gateway: { id: "osskb-search-dev", skipCache: true }, signal: expect.anything() });
    expect(index.calls).toEqual([`query:apache-kafka:${VECTOR_LIMITS.topKWithMetadata}`]);
    expect((await gate.health()).today).toMatchObject({ neurons: 1, modelCalls: 1, indexQueries: 1, neuronCap: 1_000, indexQueryCap: 1_000, hourModelCallCap: 100 });
  });

  test.each([
    ["no flag", { flag: undefined }, "disabled", undefined],
    ["a blank flag", { flag: "  " }, "disabled", undefined],
    ["an unsupported profile", { flag: "bge-m3@2" }, "failed", 'SEARCH_EMBEDDING "bge-m3@2" is not a supported embedding profile (bge-m3@1)'],
    ["no gateway id", { gatewayId: undefined }, "failed", 'SEARCH_EMBEDDING is "bge-m3@1" but SEARCH_GATEWAY_ID is not set'],
    ["the digest gateway", { gatewayId: "osskb-digest-dev" }, "failed", 'SEARCH_EMBEDDING is "bge-m3@1" but SEARCH_GATEWAY_ID "osskb-digest-dev" is the digest gateway'],
    ["no AI binding", { ai: undefined }, "failed", 'SEARCH_EMBEDDING is "bge-m3@1" but the AI binding is missing'],
    ["no vector index", { index: undefined }, "failed", 'SEARCH_EMBEDDING is "bge-m3@1" but the SEARCH_VECTORS binding is missing'],
  ] as const)("H30: with %s the gate answers %s and calls nothing", async (_, overrides, status, configError) => {
    const { ai, index, storage, gate } = await setup(overrides as Partial<SearchQueryGateDeps>);
    expect(await gate.query({ query: "transaction timeout", projectIds: ["apache-kafka"] })).toEqual({ status } as never);
    expect(ai.calls).toEqual([]);
    expect(index.calls).toEqual([]);
    expect(storage.keys("spend:")).toEqual([]);
    const health = await gate.health();
    expect(health.enabled).toBe(false);
    expect(health.configError).toBe(configError as string);
    expect(searchQueryGateConfig({ flag: "bge-m3@1", gatewayId: "osskb-search-dev", ai: new FakeAi(), index }).state).toBe("on");
  });

  test.each([
    ["Workers AI code 3036", "AiError: 3036: You have used up your daily free allocation", true],
    ["a gateway 429", "429 Too Many Requests", true],
    ["a spend-limit refusal", "AI Gateway spend limit exceeded", true],
    ["any other error", "upstream connect error", false],
  ])("H64: %s from the platform %p pauses model calls", async (_, message, refusal) => {
    const { ai, gate } = await setup();
    ai.fail = new Error(message);
    expect(await gate.query({ query: "one", projectIds: ["apache-kafka"] })).toEqual({ status: "failed" });
    const health = await gate.health();
    expect(health.lastError?.kind).toBe(refusal ? "model-limit" : "model");
    expect(health.pausedUntil).toBe(refusal ? "2026-10-12T10:15:00.000Z" : null);
    ai.fail = undefined;
    expect((await gate.query({ query: "two", projectIds: ["apache-kafka"] })).status).toBe(refusal ? "over-budget" : "ok");
    expect(ai.calls).toHaveLength(refusal ? 1 : 2);
  });

  test("H63: the query ledger is the gate's own: it shares no key and no cap with the embedding job's", async () => {
    const { storage, gate } = await setup();
    await gate.query({ query: "one", projectIds: ["apache-kafka"] });
    expect(storage.values.get("spend:2026-10-12")).toEqual({ neurons: 1, modelCalls: 1, indexQueries: 1, hour: "2026-10-12T10", hourModelCalls: 1 });
    // The object is another Durable Object than the embedding run's, so the same key is another value.
    expect(SEARCH_QUERY_GATE_OBJECT_NAME).toBe("search-query-gate-v1");
    expect(DEFAULT_QUERY_GATE_LIMITS.dailyNeuronCap).toBe(DAILY_NEURON_BUDGET.searchQuery);
    expect(DEFAULT_EMBEDDING_LIMITS.dailyNeuronCap).toBe(DAILY_NEURON_BUDGET.searchEmbedding);
  });

  test("H67: the three daily caps fit the included neurons at their calibrated estimates, and the monthly index queries fit the included dimensions", () => {
    const { digest, digestCalibrated, searchEmbedding, searchQuery, included } = DAILY_NEURON_BUDGET;
    expect([digest, searchEmbedding, searchQuery, included]).toEqual([4_500, 2_500, 1_000, 10_000]);
    expect(digest).toBe(DAILY_CAP.dev);
    // The digest's cap counts its own estimate, which undercounts: 2026-10-08, three dry runs
    // estimated at 4,507 neurons cost $0.06306 on the gateway, 5,733 neurons, a ratio of 1.272.
    expect(Math.round(0.06306 / USD_PER_NEURON)).toBe(5_733);
    expect(Math.round((5_733 / 4_507) * 1_000) / 1_000).toBe(1.272);
    expect(DIGEST_NEURON_CALIBRATION).toBe(1.28);
    expect(digestCalibrated).toBe(5_760);
    expect(digestCalibrated).toBe(Math.ceil(digest * DIGEST_NEURON_CALIBRATION));
    // The embedding cap is already calibrated and the query cap is an upper bound.
    expect(digestCalibrated + searchEmbedding + searchQuery).toBe(9_260);
    expect(included - (digestCalibrated + searchEmbedding + searchQuery)).toBe(740);
    // Uncalibrated, the same caps read 8,000 and hid 1,260 neurons.
    expect(digest + searchEmbedding + searchQuery).toBe(8_000);
    // Vectorize bills (stored vectors + queries) × dimensions; 50 M a month are included.
    const monthly = (chunks: number) => (chunks + 31 * DEFAULT_QUERY_GATE_LIMITS.maxIndexQueriesPerDay) * DIMENSIONS;
    expect(monthly(8_780)).toBe(40_734_720);
    expect(monthly(8_780)).toBeLessThan(50_000_000);
    // Room for the corpus to double: the allowance is passed at 17,829 chunks.
    expect(monthly(17_828)).toBeLessThanOrEqual(50_000_000);
    expect(monthly(17_829)).toBeGreaterThan(50_000_000);
    // The gate's hourly calls and one embedding run fit the gateway's 600 requests an hour.
    expect(DEFAULT_QUERY_GATE_LIMITS.maxModelCallsPerHour + 2 * DEFAULT_EMBEDDING_LIMITS.maxCallsPerRun).toBeLessThan(600);
  });

  test("H67: embedding neurons are the token estimate times the measured 1.8", () => {
    expect(EMBEDDING_TOKEN_CALIBRATION).toBe(1.8);
    // The 2026-10-12 backfill was estimated at 803 neurons ($0.0088): about 735,800 estimated tokens.
    expect(neurons("@cf/baai/bge-m3", 735_837, 0)).toBe(803);
    expect(embeddingNeurons("@cf/baai/bge-m3", 735_837)).toBe(1_445);
    expect(Math.round(1_445 * 0.011) / 1_000).toBe(0.016);
    expect(embeddingNeurons("@cf/baai/bge-m3", 0)).toBe(0);
    expect(PRICES["@cf/baai/bge-m3"].inputPerM).toBe(1_091);
    // The calibration is the embedding model's alone: the digest's token estimate is unchanged.
    expect(estimateTokens("transaction timeout")).toBe(5);
  });
});

describe("Spec 016 query gate object and /health", () => {
  const publisher = { environment: "development", running: false, scheduled: false, phase: null, lastRun: { ok: true }, sources: null };
  const stub = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => ({
    idFromName: (name: string) => name,
    get: (name: string) => ({ fetch: async (url: string, init?: RequestInit) => handler(`${name} ${url}`, init) }),
  });
  const env = (extra: Record<string, unknown> = {}) => ({
    PUBLICATION_ENVIRONMENT: "development",
    OSS_KB_BUCKET: { get: async () => null },
    PIPELINE_STATE: stub(() => Response.json(publisher)),
    DIGEST_RUN: stub(() => Response.json({ enabled: false })),
    ...extra,
  }) as never;
  const health = async (extra: Record<string, unknown>) =>
    (await (await worker.fetch(new Request("https://publisher.example/health"), env(extra))).json()) as { searchQuery: Record<string, unknown> | null };

  test("H69: /health carries searchQuery: the gate's own answer when bound, null when it does not answer, disabled when not bound", async () => {
    const asked: string[] = [];
    const bound = await health({ SEARCH_QUERY_GATE: stub((url) => { asked.push(url); return Response.json({ enabled: true, today: { neurons: 3 } }); }) });
    expect(bound.searchQuery).toEqual({ enabled: true, today: { neurons: 3 } });
    expect(asked).toEqual(["search-query-gate-v1 https://search-query.internal/status"]);
    expect((await health({ SEARCH_QUERY_GATE: stub(() => new Response("boom", { status: 500 })) })).searchQuery).toBeNull();
    expect((await health({ SEARCH_QUERY_GATE: stub(() => { throw new Error("gone"); }) })).searchQuery).toBeNull();
    expect((await health({})).searchQuery).toMatchObject({ enabled: false, semanticRevision: null, today: { neurons: 0, neuronCap: 1_000, indexQueryCap: 1_000, hourModelCallCap: 100 }, lastError: null });
    expect(mergeHealth(publisher, null, null, null, { enabled: true })).toEqual({ ...publisher, digest: null, reviewQueue: null, searchEmbedding: null, searchQuery: { enabled: true } });
  });

  test("H69: the SearchQueryGate object answers POST /query and GET /status from its own storage, and nothing else", async () => {
    const values = new Map<string, unknown>();
    const ctx = {
      storage: {
        get: async (key: string) => values.get(key),
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (keys: string[]) => keys.map((key) => values.delete(key)).length,
        list: async (options: { prefix: string; limit?: number }) => new Map([...values].filter(([key]) => key.startsWith(options.prefix)).sort().slice(0, options.limit)),
      },
    };
    const ai = new FakeAi();
    const index = new FakeVectorIndex(DIMENSIONS);
    await storeChunkVectors(index, [testChunk({ recordId: "kafka:1", title: "Transaction timeout", text: "times out" })], vector, SEMANTIC_REVISION);
    const object = new SearchQueryGate(ctx as never, { SEARCH_EMBEDDING: "bge-m3@1", SEARCH_GATEWAY_ID: "osskb-search-dev", DIGEST_GATEWAY_ID: "osskb-digest-dev", AI: ai, SEARCH_VECTORS: index } as never);
    const post = (body: string) => object.fetch(new Request("https://search-query.internal/query", { method: "POST", body }));

    const answer = await (await post(JSON.stringify({ query: "transaction timeout", projectIds: ["apache-kafka"] }))).json() as { status: string; matches: { recordId: string }[] };
    expect(answer.status).toBe("ok");
    expect(answer.matches.map((match) => match.recordId)).toEqual(["kafka:1"]);
    expect(await (await post("not json")).json<unknown>()).toEqual({ status: "failed" });
    const status = await (await object.fetch(new Request("https://search-query.internal/status"))).json() as { enabled: boolean; today: { neurons: number } };
    expect(status).toMatchObject({ enabled: true, semanticRevision: SEMANTIC_REVISION, today: { neurons: 1, modelCalls: 1, indexQueries: 1 } });
    expect([...values.keys()].filter((key) => key.startsWith("spend:"))).toEqual([`spend:${new Date().toISOString().slice(0, 10)}`]);
    for (const [method, path] of [["GET", "/query"], ["POST", "/status"], ["POST", "/run"], ["GET", "/"]] as const) {
      expect((await object.fetch(new Request(`https://search-query.internal${path}`, { method }))).status).toBe(404);
    }
    // Without the flag the same object is disabled and calls nothing.
    const off = new SearchQueryGate(ctx as never, { AI: new FakeAi(), SEARCH_VECTORS: index } as never);
    expect(await (await off.fetch(new Request("https://search-query.internal/query", { method: "POST", body: JSON.stringify({ query: "one", projectIds: ["apache-kafka"] }) }))).json<unknown>()).toEqual({ status: "disabled" });
    expect(ai.calls).toHaveLength(1);
  });

  test("H69: the Worker's entry module exports only handlers, classes, and functions, as the runtime requires", () => {
    // workerd refuses to start a Worker whose entry module exports anything else (a string
    // constant exported here stopped the local runtime during this slice).
    const exported = Object.entries(entry).map(([name, value]) => `${name}:${name === "default" ? typeof (value as { fetch?: unknown }).fetch : typeof value}`);
    expect(exported.filter((item) => !item.endsWith(":function"))).toEqual([]);
    expect(Object.keys(entry)).toContain("SearchQueryGate");
  });

  test("H69: the Worker has no public route to the gate", async () => {
    let asked = 0;
    const gate = stub(() => { asked += 1; return Response.json({ enabled: true }); });
    for (const [method, path] of [["POST", "/query"], ["POST", "/search-query/query"], ["GET", "/search-query/status"], ["POST", "/search-query"]] as const) {
      const response = await worker.fetch(new Request(`https://publisher.example${path}`, { method, headers: { authorization: "Bearer placeholder-token" } }), env({ MANUAL_TRIGGER_TOKEN: "placeholder-token", SEARCH_QUERY_GATE: gate }));
      expect(response.status).toBe(404);
    }
    expect(asked).toBe(0);
  });

  test("H66: the development publisher sets the shard-root flag, binds the gate, and migrates its class (v4); production has none of them", async () => {
    const read = async (environment: string) => JSON.parse(await Bun.file(new URL(`../wrangler.${environment}.jsonc`, import.meta.url)).text()) as {
      readonly vars: Readonly<Record<string, string>>;
      readonly durable_objects: { readonly bindings: readonly { readonly name: string; readonly class_name: string }[] };
      readonly migrations: readonly { readonly tag: string; readonly new_sqlite_classes: readonly string[] }[];
    };
    const development = await read("development");
    expect(development.vars.SEARCH_SHARD_ROOTS).toBe("true");
    expect(resolveSearchShardRoots(development.vars.SEARCH_SHARD_ROOTS)).toBe(true);
    expect(development.durable_objects.bindings).toContainEqual({ name: "SEARCH_QUERY_GATE", class_name: "SearchQueryGate" });
    expect(development.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["PipelineState"] },
      { tag: "v2", new_sqlite_classes: ["DigestRun"] },
      { tag: "v3", new_sqlite_classes: ["SearchEmbeddingRun"] },
      { tag: "v4", new_sqlite_classes: ["SearchQueryGate"] },
    ]);
    // Every bound class is exported by the entry module and migrated exactly once.
    const migrated = development.migrations.flatMap((migration) => migration.new_sqlite_classes);
    expect([...migrated].sort()).toEqual(development.durable_objects.bindings.map((binding) => binding.class_name).sort());
    for (const name of migrated) expect(typeof (entry as Record<string, unknown>)[name]).toBe("function");
    // The gate is on only with the embedding profile, its gateway, the AI binding, and the index: all Dev's.
    expect(development.vars).toMatchObject({ SEARCH_EMBEDDING: "bge-m3@1", SEARCH_GATEWAY_ID: "osskb-search-dev" });

    const production = await read("production");
    expect(Object.hasOwn(production.vars, "SEARCH_SHARD_ROOTS")).toBe(false);
    expect(resolveSearchShardRoots(production.vars.SEARCH_SHARD_ROOTS)).toBe(false);
    expect(production.durable_objects.bindings.map((binding) => binding.class_name)).toEqual(["PipelineState", "DigestRun"]);
    expect(production.migrations.map((migration) => migration.tag)).toEqual(["v1", "v2"]);
    expect(JSON.stringify(production)).not.toContain("SearchQueryGate");
  });
});
