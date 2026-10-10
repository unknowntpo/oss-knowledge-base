import { describe, expect, test } from "bun:test";
import { FakeVectorIndex } from "@oss-knowledge-base/semantic-vectorize/testing";

import worker, { mergeHealth, SearchEmbeddingRun, searchEmbeddingTrigger } from "../src/index";
import type { PipelineRunStatus } from "../src/pipeline";
import { STALE_ALARM_MS } from "../src/run-schedule";
import { DEFAULT_EMBEDDING_LIMITS, type EmbeddingRunResult } from "../src/search-embedding/run";
import { searchEmbeddingConfig, SearchEmbeddingRunner, unboundSearchEmbeddingHealth, type SearchEmbeddingHealth, type SearchEmbeddingRunnerDeps } from "../src/search-embedding/runner";
import { EmbeddingState } from "../src/search-embedding/state";
import { DAY_1, FIVE, MemoryBucket, MemoryStorage, projectA, publishRelease } from "./support/search-embedding";

const DIMENSIONS = 1_024;
const SEMANTIC_REVISION = "@cf/baai/bge-m3@1:1024:title-text@1";

class FakeAi {
  readonly calls: { readonly model: string; readonly inputs: { readonly text: string[] }; readonly options: unknown }[] = [];
  fail: Error | undefined;
  async run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, inputs: inputs as { text: string[] }, options });
    if (this.fail !== undefined) throw this.fail;
    const text = (inputs as { text: string[] }).text;
    return { shape: [text.length, DIMENSIONS], data: text.map((value) => Array.from({ length: DIMENSIONS }, (_, n) => ((value.length + n) % 7) + 1)) };
  }
}

function setup(overrides: Partial<SearchEmbeddingRunnerDeps> = {}) {
  const storage = new MemoryStorage();
  const bucket = new MemoryBucket();
  const ai = new FakeAi();
  const index = new FakeVectorIndex(DIMENSIONS);
  const clock = { now: DAY_1 };
  publishRelease(bucket, "r1", FIVE);
  const runner = new SearchEmbeddingRunner({
    storage, bucket, flag: "bge-m3@1", gatewayId: "osskb-search-dev", digestGatewayId: "osskb-digest-dev", ai, index,
    now: () => new Date(clock.now), delay: async () => undefined, limits: { batchTexts: 2 },
    ...overrides,
  });
  return { storage, bucket, ai, index, clock, runner };
}

const publisher = { environment: "development", running: false, scheduled: false, phase: null, lastRun: { ok: true }, sources: null };

describe("Spec 016 embedding object", () => {
  test.each([[undefined], [""], ["  "]])("H45: with SEARCH_EMBEDDING %p a trigger, an alarm, and a dry run call no model and no index", async (flag) => {
    const off = setup({ flag });
    expect(await off.runner.request()).toEqual({ status: 403, body: { ok: false, disabled: true } });
    expect(await off.runner.request({ dryRun: true })).toEqual({ status: 403, body: { ok: false, disabled: true } });
    await off.runner.alarm();
    expect(off.ai.calls).toEqual([]);
    expect(off.index.calls).toEqual([]);
    expect(off.bucket.reads).toEqual([]);
    expect(off.storage.writes).toEqual([]);
    expect(await off.runner.health()).toMatchObject({ enabled: false, model: null, revision: null, semanticRevision: null, lastRun: null });
    expect(await off.runner.health()).not.toHaveProperty("configError");

    // A reset is served while off (it calls nothing) so that a wiped index is not trusted later.
    expect(await off.runner.request({ reset: true })).toEqual({ status: 200, body: { ok: true, scheduled: false, forgotten: 0 } });
    expect(off.storage.alarm).toBeNull();
    expect(off.ai.calls).toEqual([]);
    expect(off.index.calls).toEqual([]);

    // Positive control: the same object with the flag embeds the release.
    const on = setup();
    expect((await on.runner.request()).status).toBe(202);
    await on.runner.alarm();
    expect(on.ai.calls).toHaveLength(3);
    expect(on.index.vectors.size).toBe(5);
  });

  test("H21: the run embeds with @cf/baai/bge-m3 through the search gateway, never the gateway cache, into the bound index", async () => {
    const { ai, index, runner } = setup();
    await runner.alarm();
    expect(ai.calls.map((call) => call.model)).toEqual(["@cf/baai/bge-m3", "@cf/baai/bge-m3", "@cf/baai/bge-m3"]);
    expect(ai.calls[0]!.inputs).toEqual({ text: ["Title of a1\nText of a1", "Title of a2\nText of a2"], truncate_inputs: true } as never);
    for (const call of ai.calls) {
      expect(call.options).toEqual({ gateway: { id: "osskb-search-dev", skipCache: true }, signal: expect.anything() });
      expect((call.options as { signal: unknown }).signal instanceof AbortSignal).toBe(true);
    }
    expect([...index.vectors.values()].map((vector) => `${vector.namespace}:${vector.values.length}:${vector.metadata.r}`))
      .toEqual(Array.from({ length: 5 }, (_, n) => `${n < 3 ? "p-a" : "p-b"}:1024:${SEMANTIC_REVISION}`));
    expect((await runner.health()).lastRun).toMatchObject({ ok: true, model: "@cf/baai/bge-m3", revision: "bge-m3@1", semanticRevision: SEMANTIC_REVISION, embedded: 5, storedDimensions: 5 * 1_024 });
  });

  test.each([
    ["an unsupported value", { flag: "bge-m3@2" }, 'SEARCH_EMBEDDING "bge-m3@2" is not a supported embedding profile (bge-m3@1)'],
    ["the value true", { flag: "true" }, 'SEARCH_EMBEDDING "true" is not a supported embedding profile (bge-m3@1)'],
    ["no gateway id", { gatewayId: undefined }, 'SEARCH_EMBEDDING is "bge-m3@1" but SEARCH_GATEWAY_ID is not set'],
    ["a blank gateway id", { gatewayId: " " }, 'SEARCH_EMBEDDING is "bge-m3@1" but SEARCH_GATEWAY_ID is not set'],
    ["the digest gateway", { gatewayId: "osskb-digest-dev" }, 'SEARCH_EMBEDDING is "bge-m3@1" but SEARCH_GATEWAY_ID "osskb-digest-dev" is the digest gateway'],
    ["no AI binding", { ai: undefined }, 'SEARCH_EMBEDDING is "bge-m3@1" but the AI binding is missing'],
    ["no vector index", { index: undefined }, 'SEARCH_EMBEDDING is "bge-m3@1" but the SEARCH_VECTORS binding is missing'],
  ])("H45: with %s the embedding run fails naming it and calls nothing", async (_name, overrides, error) => {
    const h = setup(overrides as Partial<SearchEmbeddingRunnerDeps>);
    const triggered = await h.runner.request();
    expect(triggered.status).toBe(500);
    expect(triggered.body).toMatchObject({ ok: false, failureKind: "config", error, modelCalls: 0 });
    await h.runner.alarm();
    const health = await h.runner.health();
    expect(health).toMatchObject({ enabled: false, configError: error, lastRun: { ok: false, failureKind: "config", error } });
    expect(h.ai.calls).toEqual([]);
    expect(h.index.calls).toEqual([]);
    expect(h.storage.alarm).toBeNull();
    // A dry run answers the same error and does not replace the recorded result.
    h.storage.writes.length = 0;
    expect(await h.runner.request({ dryRun: true })).toMatchObject({ status: 500, body: { ok: false, dryRun: true, error } });
    expect(h.storage.writes).toEqual([]);
  });

  test("H45: the deployed configurations bind the index, the object and the search gateway on Dev only, and neither sets the flag", async () => {
    const config = async (environment: string) => JSON.parse(await Bun.file(new URL(`../wrangler.${environment}.jsonc`, import.meta.url)).text()) as {
      readonly vars: Readonly<Record<string, string>>;
      readonly vectorize?: readonly { readonly binding: string; readonly index_name: string }[];
      readonly ai?: { readonly binding: string };
      readonly durable_objects: { readonly bindings: readonly { readonly name: string; readonly class_name: string }[] };
      readonly migrations: readonly { readonly tag: string; readonly new_sqlite_classes: readonly string[] }[];
    };
    const development = await config("development");
    const production = await config("production");

    for (const { vars } of [development, production]) {
      expect(Object.hasOwn(vars, "SEARCH_EMBEDDING")).toBe(false);
      expect(searchEmbeddingConfig({ flag: vars.SEARCH_EMBEDDING, gatewayId: vars.SEARCH_GATEWAY_ID, digestGatewayId: vars.DIGEST_GATEWAY_ID, ai: new FakeAi(), index: new FakeVectorIndex(DIMENSIONS) }))
        .toEqual({ state: "off" });
    }
    expect(development.vars.SEARCH_GATEWAY_ID).toBe("osskb-search-dev");
    expect(development.vars.SEARCH_GATEWAY_ID).not.toBe(development.vars.DIGEST_GATEWAY_ID);
    expect(development.vectorize).toEqual([{ binding: "SEARCH_VECTORS", index_name: "osskb-search-dev" }]);
    expect(development.ai).toEqual({ binding: "AI" });
    expect(development.durable_objects.bindings).toContainEqual({ name: "SEARCH_EMBEDDING_RUN", class_name: "SearchEmbeddingRun" });
    expect(development.migrations.at(-1)).toEqual({ tag: "v3", new_sqlite_classes: ["SearchEmbeddingRun"] });
    // Setting the flag on Dev, and nothing else, turns embeddings on.
    expect(searchEmbeddingConfig({ flag: "bge-m3@1", gatewayId: development.vars.SEARCH_GATEWAY_ID, digestGatewayId: development.vars.DIGEST_GATEWAY_ID, ai: new FakeAi(), index: new FakeVectorIndex(DIMENSIONS) }))
      .toMatchObject({ state: "on", profile: { key: "bge-m3@1", semanticRevision: SEMANTIC_REVISION } });

    expect(JSON.stringify(production)).not.toMatch(/SEARCH_|vectorize|SearchEmbedding|"ai"/u);
    expect(production.durable_objects.bindings.map((binding) => binding.name)).toEqual(["PIPELINE_STATE", "DIGEST_RUN"]);
    expect(production.migrations.map((migration) => migration.tag)).toEqual(["v1", "v2"]);
  });

  test("H45: the publisher triggers one embedding run after a successful publication, and has no trigger without the flag or the object", async () => {
    const requests: string[] = [];
    const namespace = (response: () => Response | Promise<Response>) => ({
      idFromName: (name: string) => name,
      get: (id: string) => ({ fetch: async (url: string, init: RequestInit) => { requests.push(`${init.method} ${url} @${id}`); return response(); } }),
    }) as unknown as DurableObjectNamespace;
    const accepted = namespace(() => Response.json({ ok: true, scheduled: true }, { status: 202 }));
    const ok = { ok: true } as PipelineRunStatus;

    for (const flag of [undefined, "", "  "]) expect(searchEmbeddingTrigger({ ...(flag === undefined ? {} : { SEARCH_EMBEDDING: flag }), SEARCH_EMBEDDING_RUN: accepted })).toBeUndefined();
    expect(searchEmbeddingTrigger({ SEARCH_EMBEDDING: "bge-m3@1" })).toBeUndefined();

    const trigger = searchEmbeddingTrigger({ SEARCH_EMBEDDING: "bge-m3@1", SEARCH_EMBEDDING_RUN: accepted })!;
    await trigger(ok);
    expect(requests).toEqual(["POST https://search-embedding.internal/run @search-embedding-v1"]);
    await trigger({ ok: false } as PipelineRunStatus);
    expect(requests).toHaveLength(1);

    // An unsupported value still reaches the object, which records the error (the loud failure).
    await searchEmbeddingTrigger({ SEARCH_EMBEDDING: "nonsense", SEARCH_EMBEDDING_RUN: accepted })!(ok);
    expect(requests).toHaveLength(2);
    // 409 (a run is pending) and 500 are answers, not exceptions; a rejected fetch rejects for the pipeline to swallow.
    for (const status of [409, 500]) await searchEmbeddingTrigger({ SEARCH_EMBEDDING: "bge-m3@1", SEARCH_EMBEDDING_RUN: namespace(() => new Response("no", { status })) })!(ok);
    await expect(searchEmbeddingTrigger({ SEARCH_EMBEDDING: "bge-m3@1", SEARCH_EMBEDDING_RUN: namespace(() => { throw new Error("object unavailable"); }) })!(ok))
      .rejects.toThrow("object unavailable");
  });

  test("H51: a trigger schedules the alarm, a second one is refused while it is pending, and the alarm records the run", async () => {
    const { storage, clock, runner } = setup();
    expect(await runner.request()).toEqual({ status: 202, body: { ok: true, scheduled: true } });
    expect(storage.alarm).toBe(DAY_1);
    expect(await runner.request()).toEqual({ status: 409, body: { ok: false, skipped: "already-running" } });
    expect(await runner.request({ dryRun: true })).toEqual({ status: 409, body: { ok: false, skipped: "already-running" } });
    expect((await runner.health()).scheduled).toBe(true);

    storage.alarm = null; // the runtime clears an alarm when it fires
    await runner.alarm();
    const health = await runner.health();
    expect(health).toEqual({
      enabled: true,
      model: "@cf/baai/bge-m3",
      revision: "bge-m3@1",
      semanticRevision: SEMANTIC_REVISION,
      running: false,
      scheduled: false,
      interrupted: null,
      today: { date: "2026-10-10", estimatedNeurons: 3, cap: 2_500, calls: 3, callCap: 400 },
      lastMutation: { id: "mutation-3", acceptedAt: "2026-10-10T08:00:00.000Z" },
      lastError: null,
      lastRun: {
        ok: true, dryRun: false, completedAt: "2026-10-10T08:00:00.000Z", durationMs: 0, releaseId: "r1",
        model: "@cf/baai/bge-m3", revision: "bge-m3@1", semanticRevision: SEMANTIC_REVISION,
        chunks: 5, embedded: 5, pending: 0, embeddedThisRun: 5, deletedThisRun: 0, deletePending: 0, heldDeletes: 0, absentProjects: [], quarantined: 0, quarantinedIds: [], storedVectors: 5, storedDimensions: 5_120,
        modelCalls: 3, estimatedInputTokens: 30, estimatedNeurons: 3, spentToday: { date: "2026-10-10", estimatedNeurons: 3, calls: 3 },
        limited: null, modelErrors: [], index: { vectorCount: 0, mutationsProcessed: null }, lastMutationId: "mutation-3",
        estimate: { chunks: 0, calls: 0, inputTokens: 0, neurons: 0, usd: 0, runs: 0, days: 0 },
      },
    } satisfies SearchEmbeddingHealth);
    expect(DEFAULT_EMBEDDING_LIMITS).toMatchObject({ dailyNeuronCap: 2_500, maxCallsPerDay: 400, maxChunksPerRun: 3_000, maxCallsPerRun: 80 });

    // The next day's ledger starts at zero; a stale alarm no longer blocks a trigger.
    clock.now = DAY_1 + 86_400_000;
    expect((await runner.health()).today).toEqual({ date: "2026-10-11", estimatedNeurons: 0, cap: 2_500, calls: 0, callCap: 400 });
    storage.alarm = clock.now - STALE_ALARM_MS;
    expect((await runner.request()).status).toBe(202);
  });

  test("H51: POST with dryRun=1 returns the estimate and leaves the model, the index, and the storage untouched", async () => {
    const { storage, ai, index, runner } = setup();
    const answer = await runner.request({ dryRun: true });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      ok: true, dryRun: true, releaseId: "r1", chunks: 5, embedded: 0, pending: 5, modelCalls: 0, index: null,
      estimate: { chunks: 5, calls: 3, inputTokens: 30, neurons: 3, usd: 0.000033, runs: 1, days: 1 },
    });
    expect(ai.calls).toEqual([]);
    expect(index.calls).toEqual([]);
    expect(storage.writes).toEqual([]);
    expect(storage.values.size).toBe(0);
    expect((await runner.health()).lastRun).toBeNull();
    expect(await runner.request({ dryRun: true, reset: true })).toEqual({ status: 400, body: { ok: false, error: "reset cannot be combined with dryRun" } });
  });

  test("H51: before the flag is set, a dry run for a named profile returns the estimate and still calls nothing", async () => {
    const { storage, bucket, ai, index, runner } = setup({ flag: undefined });
    const answer = await runner.request({ dryRun: true, profile: "bge-m3@1" });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      ok: true, dryRun: true, releaseId: "r1", model: "@cf/baai/bge-m3", revision: "bge-m3@1", semanticRevision: SEMANTIC_REVISION,
      chunks: 5, embedded: 0, pending: 5, modelCalls: 0, estimate: { chunks: 5, calls: 3, inputTokens: 30, neurons: 3, usd: 0.000033, runs: 1, days: 1 },
    });
    expect(bucket.reads.length).toBeGreaterThan(0);
    expect(ai.calls).toEqual([]);
    expect(index.calls).toEqual([]);
    expect(storage.writes).toEqual([]);
    expect(await runner.health()).toMatchObject({ enabled: false, lastRun: null });
    // Without a profile it is still disabled; an unknown profile is refused; a real run stays off.
    expect(await runner.request({ dryRun: true })).toEqual({ status: 403, body: { ok: false, disabled: true } });
    expect(await runner.request({ dryRun: true, profile: " " })).toEqual({ status: 403, body: { ok: false, disabled: true } });
    expect(await runner.request({ dryRun: true, profile: "bge-m3@9" })).toEqual({ status: 400, body: { ok: false, error: 'SEARCH_EMBEDDING "bge-m3@9" is not a supported embedding profile (bge-m3@1)' } });
    expect(await runner.request({ profile: "bge-m3@1" })).toEqual({ status: 403, body: { ok: false, disabled: true } });
    expect(storage.alarm).toBeNull();
    // With the flag set, the flag decides the profile and the parameter is not needed.
    expect((await setup().runner.request({ dryRun: true })).body).toMatchObject({ ok: true, revision: "bge-m3@1" });
  });

  test("H51: reset=1 forgets the vector state, keeps the day's ledger, and the next run embeds every chunk again", async () => {
    const { storage, ai, index, runner } = setup();
    await runner.alarm();
    expect(ai.calls).toHaveLength(3);
    expect(await runner.request({ reset: true })).toEqual({ status: 202, body: { ok: true, scheduled: true, forgotten: 5 } });
    expect(storage.vectorIds()).toEqual([]);
    expect(storage.values.get("last-mutation")).toBeUndefined();
    expect(storage.values.get("spend:2026-10-10")).toEqual({ neurons: 3, calls: 3 });
    storage.alarm = null;
    await runner.alarm();
    expect(ai.calls).toHaveLength(6);
    expect(index.vectors.size).toBe(5);
    expect(storage.vectorIds()).toHaveLength(5);
    expect((await runner.health()).today).toMatchObject({ estimatedNeurons: 6, calls: 6 });
    // Without reset a trigger embeds nothing again.
    storage.alarm = null;
    await runner.alarm();
    expect(ai.calls).toHaveLength(6);
  });

  test("H23: a failing model leaves /health with ok false and the error, and the next run recovers", async () => {
    const { ai, index, runner } = setup();
    ai.fail = new Error("AiError: 3036: You have used up your daily free allocation of 10,000 neurons");
    await runner.alarm();
    const failed = (await runner.health()).lastRun!;
    expect(failed).toMatchObject({ ok: false, failureKind: "model-limit", limited: "model-limit", embedded: 0, pending: 5, modelCalls: 1, error: expect.stringContaining("3036") });
    expect(failed.modelErrors).toEqual([expect.objectContaining({ kind: "limit", code: 3036 })]);
    expect(index.vectors.size).toBe(0);
    expect(mergeHealth(publisher, null, null, await runner.health())).toMatchObject({ lastRun: { ok: true }, searchEmbedding: { enabled: true, lastRun: { ok: false, failureKind: "model-limit" } } });

    ai.fail = undefined;
    await runner.alarm();
    expect((await runner.health()).lastRun).toMatchObject({ ok: true, embedded: 5, pending: 0 });
  });

  test("H54: the last model or store error stays in /health until a run embeds again, whatever stops the runs between", async () => {
    const { storage, ai, index, clock, runner } = setup({ limits: { batchTexts: 2, maxCallsPerDay: 4 } });
    const alarm = async () => { storage.alarm = null; await runner.alarm(); return runner.health(); };
    expect((await runner.health()).lastError).toBeNull();
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
    const secret = "Bearer s3cr3t.t0ken-1";
    ai.fail = new Error(`AiError: 5007: upstream said ${secret} key=${"a1B2".repeat(10)} ${"and more ".repeat(60)}`);
    const failed = await alarm();
    expect(failed.lastError).toEqual({ kind: "model", message: expect.stringContaining("AiError: 5007: upstream said Bearer [redacted] [redacted] and more"), at: "2026-10-10T08:00:00.000Z", batchSize: 2 });
    expect(failed.lastError!.message).not.toContain("s3cr3t");
    expect(failed.lastError!.message).not.toContain("a1B2a1B2");
    expect(failed.lastError!.message).toHaveLength(200);
    // The same text in the run result, its model errors, and the HTTP body of a trigger.
    expect(JSON.stringify(failed.lastRun)).not.toMatch(/s3cr3t|a1B2a1B2/u);
    expect(failed.lastRun!.modelErrors[0]!.message).toContain("Bearer [redacted] [redacted] and more");
    // An alarm that throws logs and records a redacted message as well.
    const thrower = setup();
    thrower.storage.fail = (write) => (write === "put run-started" ? new Error(`storage said ${secret} ${"Zm9v+/8=".repeat(6)}`) : undefined);
    await thrower.runner.alarm();
    console.error = realError;
    expect((await thrower.runner.health()).lastRun!.error).toBe("storage said Bearer [redacted] [redacted]");
    expect(logged.join("\n")).toContain("Bearer [redacted]");
    expect(logged.join("\n")).not.toMatch(/s3cr3t|Zm9v\+/u);
    expect(failed.today.calls).toBe(4);

    // The model works again, but the day's calls are used up: the run is ok and limited, and the error stays.
    ai.fail = undefined;
    clock.now += 3_600_000;
    const capped = await alarm();
    expect(capped.lastRun).toMatchObject({ ok: true, limited: "calls-per-day", modelCalls: 0 });
    expect(capped.lastError).toEqual(failed.lastError);

    clock.now += 86_400_000;
    const recovered = await alarm();
    expect(recovered.lastRun).toMatchObject({ ok: true, embedded: 5 });
    expect(recovered.lastError).toBeNull();

    // A store failure is kept the same way, with the size of the batch that was lost.
    const store = setup();
    store.index.fail = (operation) => (operation === "upsert" ? new Error("VECTOR_UPSERT_ERROR (code = 40011)") : undefined);
    store.storage.alarm = null;
    await store.runner.alarm();
    expect((await store.runner.health()).lastError).toEqual({ kind: "vector-store", message: "The vector upsert failed: VECTOR_UPSERT_ERROR (code = 40011)", at: "2026-10-10T08:00:00.000Z", batchSize: 2 });
    expect(index.vectors.size).toBe(5);
    // A dry run neither records nor clears it.
    await store.runner.request({ dryRun: true });
    expect((await store.runner.health()).lastError).not.toBeNull();
  });

  test("H51: a reset forgets more vectors than one storage call may delete", async () => {
    const { storage, runner } = setup({ flag: undefined });
    const state = new EmbeddingState(storage);
    await state.record(Array.from({ length: 250 }, (_, n) => [`id-${n}`, { p: "p-a", h: "h", r: "r" }] as const));
    expect(storage.vectorIds()).toHaveLength(250);
    expect(storage.writes.filter((write) => write.startsWith("putMany"))).toEqual(["putMany 100", "putMany 100", "putMany 50"]);
    expect(await runner.request({ reset: true })).toEqual({ status: 200, body: { ok: true, scheduled: false, forgotten: 250 } });
    expect(storage.vectorIds()).toEqual([]);
    expect(storage.writes.filter((write) => write.startsWith("deleteMany"))).toEqual(["deleteMany 100", "deleteMany 100", "deleteMany 50"]);
  });

  test("H47: an alarm whose storage fails does not throw, so the runtime does not retry it into another spend", async () => {
    const { storage, ai, runner } = setup();
    storage.fail = (write) => (write === "put run-started" ? new Error("storage unavailable") : undefined);
    await expect(runner.alarm()).resolves.toBeUndefined();
    expect(ai.calls).toEqual([]);
    expect((await runner.health()).lastRun).toMatchObject({ ok: false, failureKind: "internal", error: "storage unavailable" });
    // Even when the failure cannot be recorded, the alarm still does not throw.
    storage.fail = () => new Error("storage unavailable");
    await expect(runner.alarm()).resolves.toBeUndefined();

    // A run the platform killed leaves its marker until a later run completes.
    const killed = setup();
    killed.ai.run = () => new Promise(() => undefined);
    void killed.runner.alarm();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterRestart = new SearchEmbeddingRunner({
      storage: killed.storage, bucket: killed.bucket, flag: "bge-m3@1", gatewayId: "osskb-search-dev", ai: new FakeAi(), index: killed.index,
      now: () => new Date(DAY_1 + 60_000), delay: async () => undefined, limits: { batchTexts: 2 },
    });
    expect(await afterRestart.health()).toMatchObject({ running: false, interrupted: { startedAt: "2026-10-10T08:00:00.000Z" }, lastRun: null, today: { calls: 1 } });
    await afterRestart.alarm();
    expect(await afterRestart.health()).toMatchObject({ interrupted: null, lastRun: { ok: true, embedded: 5 }, today: { calls: 4 } });
  });

  test("H51: /health carries searchEmbedding beside the publisher's fields, and says disabled where the object is not bound", () => {
    const health = unboundSearchEmbeddingHealth(undefined, new Date(DAY_1));
    expect(health).toEqual({
      enabled: false, model: null, revision: null, semanticRevision: null, running: false, scheduled: false, interrupted: null,
      today: { date: "2026-10-10", estimatedNeurons: 0, cap: 2_500, calls: 0, callCap: 400 }, lastMutation: null, lastError: null, lastRun: null,
    });
    expect(unboundSearchEmbeddingHealth("bge-m3@1", new Date(DAY_1)).configError).toBe('SEARCH_EMBEDDING is "bge-m3@1" but the SEARCH_EMBEDDING_RUN binding is missing');
    expect(mergeHealth(publisher, { enabled: true }, null, health)).toEqual({ ...publisher, digest: { enabled: true }, reviewQueue: null, searchEmbedding: health });
    // The object did not answer: null, like the digest.
    expect(mergeHealth(publisher, null, null, null)).toEqual({ ...publisher, digest: null, reviewQueue: null, searchEmbedding: null });
    expect(mergeHealth(publisher, null)).toEqual({ ...publisher, digest: null, reviewQueue: null, searchEmbedding: null });
  });
});

describe("Spec 016 embedding endpoints of the Worker", () => {
  const stub = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => ({
    idFromName: (name: string) => name,
    get: () => ({ fetch: async (url: string, init?: RequestInit) => handler(url, init) }),
  });
  const baseEnv = (extra: Record<string, unknown> = {}) => ({
    PUBLICATION_ENVIRONMENT: "development",
    MANUAL_TRIGGER_TOKEN: "placeholder-token",
    OSS_KB_BUCKET: { get: async () => null },
    PIPELINE_STATE: stub(() => Response.json(publisher)),
    DIGEST_RUN: stub(() => Response.json({ enabled: false })),
    ...extra,
  }) as never;
  const post = (path: string, token?: string) => new Request(`https://publisher.example${path}`, { method: "POST", ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }) });

  test("H51: POST /search-embedding/run needs the bearer token and forwards dryRun and reset to the object", async () => {
    const forwarded: string[] = [];
    const env = baseEnv({ SEARCH_EMBEDDING_RUN: stub((url, init) => { forwarded.push(`${init?.method} ${url}`); return Response.json({ ok: true, scheduled: true }, { status: 202 }); }) });
    expect((await worker.fetch(post("/search-embedding/run"), env)).status).toBe(401);
    expect((await worker.fetch(post("/search-embedding/run", "wrong"), env)).status).toBe(401);
    expect(forwarded).toEqual([]);
    expect((await worker.fetch(post("/search-embedding/run", "placeholder-token"), env)).status).toBe(202);
    await worker.fetch(post("/search-embedding/run?dryRun=1", "placeholder-token"), env);
    await worker.fetch(post("/search-embedding/run?reset=1", "placeholder-token"), env);
    await worker.fetch(post("/search-embedding/run?dryRun=true&reset=0", "placeholder-token"), env);
    await worker.fetch(post("/search-embedding/run?dryRun=1&profile=bge-m3@1", "placeholder-token"), env);
    expect(forwarded).toEqual([
      "POST https://search-embedding.internal/run",
      "POST https://search-embedding.internal/run?dryRun=1",
      "POST https://search-embedding.internal/run?reset=1",
      "POST https://search-embedding.internal/run",
      "POST https://search-embedding.internal/run?dryRun=1&profile=bge-m3%401",
    ]);
    // Without the object (Prod) the endpoint says disabled, after checking the token.
    expect((await worker.fetch(post("/search-embedding/run"), baseEnv())).status).toBe(401);
    const disabled = await worker.fetch(post("/search-embedding/run", "placeholder-token"), baseEnv());
    expect([disabled.status, await disabled.json()]).toEqual([403, { ok: false, disabled: true }]);
    expect((await worker.fetch(new Request("https://publisher.example/search-embedding/run"), env)).status).toBe(404);
  });

  test("H51: GET /health adds searchEmbedding from the object, null when it does not answer, disabled when it is not bound", async () => {
    const health = async (extra: Record<string, unknown>) =>
      (await (await worker.fetch(new Request("https://publisher.example/health"), baseEnv(extra))).json()) as Record<string, unknown>;
    const bound = await health({ SEARCH_EMBEDDING_RUN: stub((url) => (url.endsWith("/status") ? Response.json({ enabled: true, lastRun: { ok: true, pending: 0 } }) : new Response("no", { status: 404 }))) });
    expect(bound).toEqual({ ...publisher, digest: { enabled: false }, reviewQueue: null, searchEmbedding: { enabled: true, lastRun: { ok: true, pending: 0 } } });
    expect((await health({ SEARCH_EMBEDDING_RUN: stub(() => new Response("boom", { status: 500 })) })).searchEmbedding).toBeNull();
    expect((await health({ SEARCH_EMBEDDING_RUN: stub(() => { throw new Error("gone"); }) })).searchEmbedding).toBeNull();
    expect((await health({})).searchEmbedding).toMatchObject({ enabled: false, lastRun: null });
    expect((await health({})).searchEmbedding).not.toHaveProperty("configError");
    expect((await health({ SEARCH_EMBEDDING: "bge-m3@1" })).searchEmbedding).toMatchObject({ enabled: false, configError: expect.stringContaining("SEARCH_EMBEDDING_RUN binding is missing") });
  });

  test("H51: the SearchEmbeddingRun object answers /status and /run from its own storage, and is off without the flag", async () => {
    const values = new Map<string, unknown>();
    let alarm: number | null = null;
    const ctx = {
      storage: {
        get: async (key: string) => values.get(key),
        put: async (key: string | Record<string, unknown>, value?: unknown) => {
          if (typeof key === "string") values.set(key, value);
          else for (const [name, entry] of Object.entries(key)) values.set(name, entry);
        },
        delete: async (key: string | string[]) => (Array.isArray(key) ? key.map((name) => values.delete(name)).length : values.delete(key)),
        list: async ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
        getAlarm: async () => alarm,
        setAlarm: async (time: number) => { alarm = time; },
      },
    } as unknown as DurableObjectState;
    const bucket = new MemoryBucket();
    publishRelease(bucket, "r1", [projectA("a1"), projectA("a2")]);
    const r2 = { get: async (key: string) => (bucket.objects.has(key) ? { json: async () => bucket.objects.get(key) } : null) };
    const ai = new FakeAi();
    const index = new FakeVectorIndex(DIMENSIONS);
    const object = (vars: Record<string, unknown>) => new SearchEmbeddingRun(ctx, { PUBLICATION_ENVIRONMENT: "development", OSS_KB_BUCKET: r2, AI: ai, SEARCH_VECTORS: index, DIGEST_GATEWAY_ID: "osskb-digest-dev", ...vars } as never);
    const call = async (instance: SearchEmbeddingRun, method: string, path: string) => {
      const response = await instance.fetch(new Request(`https://search-embedding.internal${path}`, { method }));
      return [response.status, await response.json().catch(() => null)] as const;
    };

    const off = object({ SEARCH_GATEWAY_ID: "osskb-search-dev" });
    expect(await call(off, "POST", "/run")).toEqual([403, { ok: false, disabled: true }]);
    expect((await call(off, "POST", "/run?dryRun=1&profile=bge-m3%401"))[1]).toMatchObject({ ok: true, dryRun: true, revision: "bge-m3@1", pending: 2 });
    expect((await call(off, "GET", "/status"))[1]).toMatchObject({ enabled: false });
    await off.alarm();
    expect(ai.calls).toEqual([]);

    const on = object({ SEARCH_GATEWAY_ID: "osskb-search-dev", SEARCH_EMBEDDING: "bge-m3@1" });
    expect((await call(on, "POST", "/run?dryRun=1"))[1]).toMatchObject({ ok: true, dryRun: true, pending: 2, estimate: { chunks: 2, calls: 1 } });
    expect(ai.calls).toEqual([]);
    expect(await call(on, "POST", "/run")).toEqual([202, { ok: true, scheduled: true }]);
    alarm = null;
    await on.alarm();
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.options).toMatchObject({ gateway: { id: "osskb-search-dev", skipCache: true } });
    expect(index.vectors.size).toBe(2);
    expect([...values.keys()].filter((key) => key.startsWith("v:"))).toHaveLength(2);
    const status = (await call(on, "GET", "/status"))[1] as SearchEmbeddingHealth;
    expect(status).toMatchObject({ enabled: true, revision: "bge-m3@1", lastRun: { ok: true, releaseId: "r1", embedded: 2, pending: 0, storedDimensions: 2_048 } });
    expect((status.lastRun as EmbeddingRunResult).index).toEqual({ vectorCount: 0, mutationsProcessed: null });
    expect((await call(on, "GET", "/nothing"))[0]).toBe(404);

    // The digest gateway is refused even when it is what the variable names.
    const wrong = object({ SEARCH_GATEWAY_ID: "osskb-digest-dev", SEARCH_EMBEDDING: "bge-m3@1" });
    expect(await call(wrong, "POST", "/run")).toMatchObject([500, { ok: false, failureKind: "config", error: expect.stringContaining("is the digest gateway") }]);
  });
});
