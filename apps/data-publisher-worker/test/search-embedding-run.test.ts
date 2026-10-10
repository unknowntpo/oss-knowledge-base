import { describe, expect, test } from "bun:test";
import { hybridSearch, type SourceRecordChunkV1 } from "@oss-knowledge-base/search";
import {
  chunkVectorRef,
  createInMemoryReleaseView,
  searchEmbeddingProfile,
  VectorizeSemanticRetriever,
} from "@oss-knowledge-base/semantic-vectorize";
import { SEARCH_CURRENT_KEY, SEARCH_RELEASE_SCHEMA_V2, searchReleaseManifestKey } from "@oss-knowledge-base/serving-contract";

import { DEFAULT_EMBEDDING_LIMITS, type EmbeddingLimits, type EmbeddingRunResult } from "../src/search-embedding/run";
import { sanitizeErrorMessage } from "../src/search-embedding/sanitize";
import { EmbeddingState } from "../src/search-embedding/state";
import { testPlanRows } from "./search-embedding.cases";
import { DAY_1, DAY_MS, DIMENSIONS, FIVE, harness, PROFILE, projectA, projectB, publishRelease } from "./support/search-embedding";

type Harness = ReturnType<typeof harness>;

const outcome = (result: EmbeddingRunResult) =>
  `${result.modelCalls} calls, ${result.embedded}/${result.chunks} embedded, ${result.deletedThisRun} deleted, ${result.limited ?? "not limited"}, ${result.ok ? "ok" : result.failureKind}`;

/** The state names exactly the vectors the index holds, each once. */
function expectStateMatchesIndex(h: Harness): void {
  expect(h.storage.vectorIds()).toEqual([...h.index.vectors.keys()].sort());
}

const ids = (chunks: readonly SourceRecordChunkV1[]) => Promise.all(chunks.map(async (chunk) => (await chunkVectorRef(chunk)).id));

/** What goes wrong in a row's first run; each returns how to put it right again. */
const faults: Record<string, (h: Harness, shards: readonly string[]) => () => void> = {
  "—": () => () => undefined,
  "model: call 1 fails": (h) => model(h, (call) => (call === 0 ? new Error("AiError: 3040: Capacity temporarily exceeded") : undefined)),
  "model: calls 1, 2 and 3 fail": (h) => model(h, (call) => (call < 3 ? new Error("AiError: 3040: Capacity temporarily exceeded") : undefined)),
  "model: every call fails": (h) => model(h, () => new Error("AiError: 3040: Capacity temporarily exceeded")),
  "model: calls 2 and 3 fail": (h) => model(h, (call) => (call === 1 || call === 2 ? new Error("AiError: 3040: Capacity temporarily exceeded") : undefined)),
  "model: call 1 is refused with code 3036": (h) => model(h, (call) => (call === 0 ? new Error("AiError: 3036: You have used up your daily free allocation") : undefined)),
  "model: call 2 is refused with a gateway 429": (h) => model(h, (call) => (call === 1 ? new Error("429 Too Many Requests") : undefined)),
  "model: call 3 is refused for the spend limit": (h) => model(h, (call) => (call === 2 ? new Error("AI Gateway spend limit exceeded") : undefined)),
  "model: calls 1 and 2 return one vector too few": (h) => model(h, (call, texts) => (call < 2 ? texts.slice(1).map(() => new Array<number>(DIMENSIONS).fill(1)) : undefined)),
  "model: calls 1 and 2 return 3-dimension vectors": (h) => model(h, (call, texts) => (call < 2 ? texts.map(() => [1, 2, 3]) : undefined)),
  "model: calls 1 and 2 never answer": (h) => model(h, (call) => (call < 2 ? new Promise<never>(() => undefined) : undefined)),
  "index: upsert 1 fails": (h) => indexFault(h, "upsert", [0]),
  "index: upserts 2 and 3 fail": (h) => indexFault(h, "upsert", [1, 2]),
  "index: describe fails": (h) => indexFault(h, "describe", [0]),
  "index: has 768 dimensions": (h) => {
    const describe = h.index.describe.bind(h.index);
    h.index.describe = async () => ({ ...(await describe()), dimensions: 768 });
    return () => { h.index.describe = describe; };
  },
  "index: delete 1 fails": (h) => indexFault(h, "deleteByIds", [0]),
  "index: deletes 1 and 2 fail": (h) => indexFault(h, "deleteByIds", [0, 1]),
  "release: the second shard cannot be read": (h, shards) => {
    h.bucket.fail = (key) => (key === shards[1] ? new Error("R2 internal error 10001") : undefined);
    return () => { h.bucket.fail = () => undefined; };
  },
  "release: the manifest declares 6 chunks": (h) => replaceManifest(h, (manifest) => ({ ...manifest, chunkCount: 6 })),
  "release: a search-release.v2 manifest": (h) => replaceManifest(h, (manifest) => ({ ...manifest, schema: SEARCH_RELEASE_SCHEMA_V2, shardKeys: {} })),
  "release: no current pointer": (h) => {
    const pointer = h.bucket.objects.get(SEARCH_CURRENT_KEY);
    h.bucket.objects.delete(SEARCH_CURRENT_KEY);
    return () => { h.bucket.objects.set(SEARCH_CURRENT_KEY, pointer); };
  },
};

function model(h: Harness, respond: Harness["model"]["respond"]): () => void {
  const first = h.model.calls.length;
  h.model.respond = (call, texts) => respond(call - first, texts);
  return () => { h.model.respond = () => undefined; };
}

function indexFault(h: Harness, operation: "upsert" | "describe" | "deleteByIds", failing: readonly number[]): () => void {
  let seen = 0;
  h.index.fail = (called) => {
    if (called !== operation) return undefined;
    seen += 1;
    return failing.includes(seen - 1) ? new Error(`VECTOR_${operation.toUpperCase()}_ERROR (code = 40011)`) : undefined;
  };
  return () => { h.index.fail = () => undefined; };
}

function replaceManifest(h: Harness, change: (manifest: Record<string, unknown>) => Record<string, unknown>): () => void {
  const key = searchReleaseManifestKey("r1");
  const manifest = h.bucket.objects.get(key) as Record<string, unknown>;
  h.bucket.objects.set(key, change(manifest));
  return () => { h.bucket.objects.set(key, manifest); };
}

function parseLimits(text: string): { readonly limits: Partial<EmbeddingLimits>; readonly callMs: number } {
  const pairs = text === "—" ? [] : text.split(" ").map((pair) => pair.split("=") as [string, string]);
  const callMs = Number(pairs.find(([name]) => name === "callMs")?.[1] ?? 0);
  const limits = Object.fromEntries(pairs.filter(([name]) => name !== "callMs").map(([name, value]) => {
    if (!Object.hasOwn(DEFAULT_EMBEDDING_LIMITS, name)) throw new Error(`Unknown limit ${name}`);
    return [name, Number(value)];
  }));
  return { limits, callMs };
}

describe("Spec 016 embedding run plan", () => {
  test.each([...testPlanRows])("$id: $case — $fault", async (row) => {
    const { limits, callMs } = parseLimits(row.limits);
    const h = harness({ batchTexts: 2, ...limits });
    const start: string = row.start;
    if (start === "one extra") {
      publishRelease(h.bucket, "r0", [...FIVE, projectA("gone")]);
      expect(outcome(await h.run({ limits: DEFAULT_EMBEDDING_LIMITS }))).toBe("1 calls, 6/6 embedded, 0 deleted, not limited, ok");
    } else if (start !== "empty") throw new Error(`Unknown start ${start}`);
    const shards = publishRelease(h.bucket, "r1", FIVE);
    h.model.onCall = () => { h.clock.now += callMs; };
    const before = new Map(h.index.vectors);
    const apply = faults[row.fault];
    if (apply === undefined) throw new Error(`No fault named ${row.fault}`);
    let restore: (() => void) | undefined = apply(h, shards);

    const outcomes: string[] = [];
    for (const day of row.days.split(" ")) {
      h.clock.now = DAY_1 + (Number(day) - 1) * DAY_MS + outcomes.length * 3_600_000;
      const result = await h.run();
      outcomes.push(outcome(result));
      expectStateMatchesIndex(h);
      if (restore !== undefined) {
        // A failed run leaves every vector stored before it as it was (H23).
        if (!result.ok) for (const [id, vector] of before) expect(h.index.vectors.get(id)).toEqual(vector);
        restore();
        restore = undefined;
      }
    }
    expect(outcomes.join(" → ")).toBe(row.expected);
  });

  test("every fault is used by a row, and every row starts from a known state", () => {
    const used = new Set<string>(testPlanRows.map((row) => row.fault));
    expect(Object.keys(faults).filter((name) => !used.has(name))).toEqual([]);
    expect([...new Set<string>(testPlanRows.map((row) => row.start))].sort()).toEqual(["empty", "one extra"]);
  });
});

describe("Spec 016 embedding run", () => {
  test("H21: each chunk becomes one vector in its project's namespace, embedded as title and text", async () => {
    const h = harness({ batchTexts: 2 });
    publishRelease(h.bucket, "r1", FIVE);
    const result = await h.run();

    expect(result).toMatchObject({
      ok: true, dryRun: false, releaseId: "r1", model: "@cf/baai/bge-m3", revision: "test@1", semanticRevision: PROFILE.semanticRevision,
      chunks: 5, embedded: 5, pending: 0, embeddedThisRun: 5, deletedThisRun: 0, deletePending: 0,
      storedVectors: 5, storedDimensions: 5 * DIMENSIONS, modelCalls: 3, limited: null, modelErrors: [],
    });
    expect(h.model.calls).toEqual([
      ["Title of a1\nText of a1", "Title of a2\nText of a2"],
      ["Title of a3\nText of a3", "Title of b1\nText of b1"],
      ["Title of b2\nText of b2"],
    ]);
    expect(h.index.calls).toEqual(["describe", "upsert:2", "upsert:2", "upsert:1"]);
    const stored = [...h.index.vectors.values()];
    expect(stored.map((vector) => `${vector.namespace} ${vector.metadata.record}`).sort()).toEqual(["p-a a1", "p-a a2", "p-a a3", "p-b b1", "p-b b2"]);
    expect(stored.map((vector) => vector.id).sort()).toEqual((await ids(FIVE)).sort());
    for (const vector of stored) {
      expect(vector.values).toHaveLength(DIMENSIONS);
      expect(vector.metadata).toEqual({ r: PROFILE.semanticRevision, h: expect.stringMatching(/^[0-9a-f]{32}$/u), record: vector.metadata.record, ord: 0, root: vector.metadata.record });
    }
    expectStateMatchesIndex(h);
    expect(h.storage.values.get(`v:${(await ids(FIVE))[3]}`)).toEqual({ p: "p-b", h: stored.find((vector) => vector.metadata.record === "b1")!.metadata.h, r: PROFILE.semanticRevision });
  });

  test("H21: a second run on the same release calls no model, mutates nothing, and writes no vector state", async () => {
    const h = harness();
    publishRelease(h.bucket, "r1", FIVE);
    await h.run();
    const calls = h.model.calls.length;
    h.index.calls.length = 0;
    h.storage.writes.length = 0;
    const again = await h.run();
    expect(again).toMatchObject({ ok: true, chunks: 5, embedded: 5, pending: 0, embeddedThisRun: 0, modelCalls: 0, estimatedNeurons: 0 });
    expect(h.model.calls).toHaveLength(calls);
    expect(h.index.calls).toEqual(["describe"]);
    expect(h.storage.writes).toEqual([]);
  });

  test("H21: a new source version of the same passage is not embedded again; a changed text is embedded alone, under the same id", async () => {
    const h = harness();
    publishRelease(h.bucket, "r1", FIVE);
    await h.run();
    const before = new Map(h.index.vectors);
    const [a1Id] = await ids([FIVE[0]!]);

    // Every record has a new sourceVersion (so a new chunk id); only a1's text changed.
    const next = FIVE.map((chunk) => ({ ...chunk, sourceVersion: "v2", id: `${chunk.id}:v2`, occurredAt: "2026-10-10T07:00:00.000Z" }))
      .map((chunk) => (chunk.recordId === "a1" ? { ...chunk, text: "A rewritten body" } : chunk));
    publishRelease(h.bucket, "r2", next);
    h.model.calls.length = 0;
    h.index.calls.length = 0;
    const result = await h.run();

    expect(result).toMatchObject({ ok: true, releaseId: "r2", chunks: 5, embedded: 5, embeddedThisRun: 1, deletedThisRun: 0, modelCalls: 1, storedVectors: 5 });
    expect(h.model.calls).toEqual([["Title of a1\nA rewritten body"]]);
    expect(h.index.calls).toEqual(["describe", "upsert:1"]);
    expect([...h.index.vectors.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, vector] of h.index.vectors) {
      if (id === a1Id) {
        expect(vector.metadata.h).not.toBe(before.get(id)!.metadata.h);
        expect(vector.values).not.toEqual(before.get(id)!.values);
      } else expect(vector).toEqual(before.get(id)!);
    }
    expectStateMatchesIndex(h);
  });

  test("H21: a retitled or regrouped chunk is embedded again; a removed chunk's vector is deleted and a new chunk added", async () => {
    const h = harness();
    publishRelease(h.bucket, "r1", FIVE);
    await h.run();
    const [, a2Id, a3Id] = await ids(FIVE);
    const next = [
      FIVE[0]!,
      { ...FIVE[1]!, title: "A new title" },
      // a3 is gone; b1 moved under b2's thread; b3 is new.
      { ...FIVE[3]!, groupRootRecordId: "b2" },
      FIVE[4]!,
      projectB("b3"),
    ];
    publishRelease(h.bucket, "r2", next);
    h.model.calls.length = 0;
    h.index.calls.length = 0;
    const result = await h.run();

    expect(result).toMatchObject({ ok: true, chunks: 5, embedded: 5, embeddedThisRun: 3, deletedThisRun: 1, deletePending: 0, storedVectors: 5 });
    expect(h.model.calls.flat().sort()).toEqual(["A new title\nText of a2", "Title of b1\nText of b1", "Title of b3\nText of b3"]);
    expect(h.index.calls).toEqual(["describe", "upsert:3", "deleteByIds:1"]);
    expect(h.index.vectors.has(a3Id!)).toBe(false);
    expect(h.index.vectors.get(a2Id!)!.metadata).toMatchObject({ record: "a2" });
    expect([...h.index.vectors.values()].find((vector) => vector.metadata.record === "b1")!.metadata.root).toBe("b2");
    expect([...h.index.vectors.keys()].sort()).toEqual((await ids(next)).sort());
    expectStateMatchesIndex(h);
  });

  test("H22: a changed model revision, model, dimensions, or text assembly embeds every chunk again in place", async () => {
    for (const change of [{ modelRevision: "2" }, { textAssemblyRevision: "title-text@2" }, { model: "@cf/qwen/qwen3-30b-a3b-fp8" }]) {
      const h = harness();
      publishRelease(h.bucket, "r1", FIVE);
      await h.run();
      const before = [...h.index.vectors.keys()].sort();
      const next = searchEmbeddingProfile("test@2", { ...PROFILE.revision, ...change });
      expect(next.semanticRevision).not.toBe(PROFILE.semanticRevision);
      h.model.calls.length = 0;

      // A bounded first run leaves the index mixed; the state knows which vectors are current.
      const first = await h.run({ profile: next, limits: { maxChunksPerRun: 2 } });
      expect(first).toMatchObject({ ok: true, embedded: 2, pending: 3, embeddedThisRun: 2, limited: "chunks-per-run", storedVectors: 5 });
      expect([...h.index.vectors.values()].map((vector) => vector.metadata.r).sort())
        .toEqual([next.semanticRevision, next.semanticRevision, PROFILE.semanticRevision, PROFILE.semanticRevision, PROFILE.semanticRevision].sort());
      const second = await h.run({ profile: next });
      expect(second).toMatchObject({ ok: true, embedded: 5, pending: 0, embeddedThisRun: 3, deletedThisRun: 0, storedVectors: 5 });
      expect(h.model.calls.flat()).toHaveLength(5);
      expect([...h.index.vectors.keys()].sort()).toEqual(before);
      expect(new Set([...h.index.vectors.values()].map((vector) => vector.metadata.r))).toEqual(new Set([next.semanticRevision]));
      expect((await h.run({ profile: next })).modelCalls).toBe(0);
    }

    // Other dimensions need another index: the run refuses before any model call.
    const h = harness();
    publishRelease(h.bucket, "r1", FIVE);
    const wider = searchEmbeddingProfile("wide@1", { ...PROFILE.revision, dimensions: 16 });
    expect(await h.run({ profile: wider })).toMatchObject({ ok: false, failureKind: "config", error: "The vector index has 8 dimensions; wide@1 needs 16", modelCalls: 0 });
    // A model with no recorded price cannot be budgeted, so it is refused as well.
    const unpriced = searchEmbeddingProfile("free@1", { ...PROFILE.revision, model: "@cf/unknown/model" });
    expect(await h.run({ profile: unpriced })).toMatchObject({ ok: false, failureKind: "config", error: "No Workers AI price is recorded for @cf/unknown/model", modelCalls: 0 });
    expect(h.model.calls).toEqual([]);
  });

  test("H43: a model call carries at most 50 texts and 20,000 estimated tokens, and a delete at most 100 ids", async () => {
    expect(DEFAULT_EMBEDDING_LIMITS).toMatchObject({ batchTexts: 50, batchTokens: 20_000, deleteBatch: 100 });
    const many = Array.from({ length: 120 }, (_, n) => projectA(`many:${String(n).padStart(3, "0")}`));
    const h = harness();
    publishRelease(h.bucket, "r1", many, { shardChunks: 70 });
    const first = await h.run();
    expect(first).toMatchObject({ ok: true, chunks: 120, embedded: 120, modelCalls: 3 });
    expect(h.model.calls.map((texts) => texts.length)).toEqual([50, 50, 20]);
    expect(h.index.calls).toEqual(["describe", "upsert:50", "upsert:50", "upsert:20"]);

    // 4,000 characters are 1,000 estimated tokens, so 20 texts fill a call before 50 do.
    const long = Array.from({ length: 45 }, (_, n) => projectB(`long:${n}`, { text: "x".repeat(3_960) }));
    publishRelease(h.bucket, "r2", [...many.slice(0, 5), ...long]);
    h.model.calls.length = 0;
    h.index.calls.length = 0;
    const second = await h.run();
    expect(h.model.calls.map((texts) => texts.length)).toEqual([20, 20, 5]);
    expect(second).toMatchObject({ ok: true, chunks: 50, embedded: 50, embeddedThisRun: 45, deletedThisRun: 115, storedVectors: 50 });
    expect(second.estimatedInputTokens).toBeLessThanOrEqual(3 * 20_000);
    expect(h.index.calls.filter((call) => call.startsWith("deleteByIds"))).toEqual(["deleteByIds:100", "deleteByIds:15"]);
    expectStateMatchesIndex(h);

    // One text over the token bound is still sent, alone.
    publishRelease(h.bucket, "r3", [projectA("huge", { text: "y".repeat(100_000) }), projectA("small")]);
    h.model.calls.length = 0;
    await h.run();
    expect(h.model.calls.map((texts) => texts.length)).toEqual([1, 1]);
  });

  test("H46: deletes per run are bounded, and the next run deletes the rest", async () => {
    const h = harness({ deleteBatch: 2, maxDeletesPerRun: 3 });
    publishRelease(h.bucket, "r0", [...FIVE, ...Array.from({ length: 5 }, (_, n) => projectB(`old:${n}`))]);
    await h.run();
    publishRelease(h.bucket, "r1", FIVE);
    h.index.calls.length = 0;
    expect(await h.run()).toMatchObject({ ok: true, deletedThisRun: 3, deletePending: 2, storedVectors: 7 });
    expect(h.index.calls).toEqual(["describe", "deleteByIds:2", "deleteByIds:1"]);
    expect(await h.run()).toMatchObject({ ok: true, deletedThisRun: 2, deletePending: 0, storedVectors: 5 });
    expectStateMatchesIndex(h);
  });

  test("H46: the initial backfill of 8,586 chunks finishes in three runs under the default bounds", async () => {
    const corpus = Array.from({ length: 8_586 }, (_, n) => (n % 4 === 0 ? projectB : projectA)(`record:${n}`));
    const h = harness();
    publishRelease(h.bucket, "r1", corpus);
    const dry = await h.run({ dryRun: true });
    expect(dry.estimate).toMatchObject({ chunks: 8_586, calls: 172, runs: 3, days: 1 });
    expect(h.model.calls).toEqual([]);

    const runs: EmbeddingRunResult[] = [];
    for (let hour = 0; hour < 4; hour += 1) {
      h.clock.now = DAY_1 + hour * 3_600_000;
      runs.push(await h.run());
    }
    expect(runs.map((result) => `${result.embeddedThisRun} ${result.modelCalls} ${result.limited ?? "-"}`))
      .toEqual(["3000 60 chunks-per-run", "3000 60 chunks-per-run", "2586 52 -", "0 0 -"]);
    expect(runs.every((result) => result.ok)).toBe(true);
    expect(runs[2]).toMatchObject({ embedded: 8_586, pending: 0, storedVectors: 8_586, storedDimensions: 8_586 * DIMENSIONS });
    expect(runs[2]!.spentToday.calls).toBe(172);
    expect(runs[2]!.spentToday.calls).toBeLessThanOrEqual(DEFAULT_EMBEDDING_LIMITS.maxCallsPerDay);
    expect(h.index.vectors.size).toBe(8_586);
  }, 60_000);

  test.each([
    ["while the model is called", (h: Harness) => { h.model.respond = (call) => (call === 1 ? new Promise<never>(() => undefined) : undefined); }, 2, 2],
    ["after the model answered, while the upsert is sent", (h: Harness) => { const upsert = h.index.upsert.bind(h.index); let n = 0; h.index.upsert = (vectors) => ((n += 1) === 2 ? new Promise<never>(() => undefined) : upsert(vectors)); }, 2, 2],
    ["after the upsert was accepted, before the mutation is noted", (h: Harness) => { let n = 0; h.storage.fail = (write) => (write === "put last-mutation" && (n += 1) === 2 ? new Promise<never>(() => undefined) : undefined); }, 2, 4],
    ["while the vector state is written", (h: Harness) => { let n = 0; h.storage.fail = (write) => (write.startsWith("putMany") && (n += 1) === 2 ? new Promise<never>(() => undefined) : undefined); }, 2, 4],
  ])("H47: a run that dies %s is continued by its retry, which embeds at most that batch again", async (_name, kill, embeddedBefore, vectorsBefore) => {
    const h = harness({ batchTexts: 2, callTimeoutMs: 2 ** 30 });
    publishRelease(h.bucket, "r1", FIVE);
    kill(h);
    // The run never returns: the isolate is gone. Nothing below awaits it.
    void h.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.storage.vectorIds()).toHaveLength(embeddedBefore);
    expect(h.index.vectors.size).toBe(vectorsBefore);
    expect(h.model.calls).toHaveLength(2);
    expect(h.storage.values.get("spend:2026-10-10")).toEqual({ neurons: 2, calls: 2 });

    // A fresh instance over the same storage and index stands in for the retried alarm.
    h.model.respond = () => undefined;
    h.storage.fail = () => undefined;
    const upsert = Object.getPrototypeOf(h.index).upsert as typeof h.index.upsert;
    h.index.upsert = upsert.bind(h.index);
    const retry = await h.run();

    expect(retry).toMatchObject({ ok: true, chunks: 5, embedded: 5, pending: 0, embeddedThisRun: 3, modelCalls: 2 });
    // The second batch is the only one embedded twice.
    expect(h.model.calls.map((texts) => texts.join("|"))).toEqual([
      "Title of a1\nText of a1|Title of a2\nText of a2",
      "Title of a3\nText of a3|Title of b1\nText of b1",
      "Title of a3\nText of a3|Title of b1\nText of b1",
      "Title of b2\nText of b2",
    ]);
    // Both attempts are in the day's ledger.
    expect(retry.spentToday).toEqual({ date: "2026-10-10", estimatedNeurons: 4, calls: 4 });
    expect(h.index.vectors.size).toBe(5);
    expect(new Set([...h.index.vectors.values()].map((vector) => vector.metadata.record)).size).toBe(5);
    expectStateMatchesIndex(h);
    expect((await h.run()).modelCalls).toBe(0);
  });

  test("H47: the ledger is written before each model call, so a killed call cannot be spent again past the daily bound", async () => {
    const h = harness({ batchTexts: 2, maxCallsPerDay: 2, callTimeoutMs: 2 ** 30 });
    publishRelease(h.bucket, "r1", FIVE);
    const order: string[] = [];
    h.model.onCall = () => order.push(`model ${JSON.stringify(h.storage.values.get("spend:2026-10-10"))}`);
    h.model.respond = () => new Promise<never>(() => undefined);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      void h.run();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Four attempts of the same alarm made two calls: the third and fourth found the bound reached.
    expect(order).toEqual(['model {"neurons":1,"calls":1}', 'model {"neurons":2,"calls":2}']);
    h.model.respond = () => undefined;
    expect(await h.run()).toMatchObject({ ok: true, modelCalls: 0, limited: "calls-per-day", embedded: 0, pending: 5 });
  });

  test("H49: an accepted upsert is recorded and never embedded again, whether or not the index has applied it", async () => {
    const h = harness({ batchTexts: 2 });
    publishRelease(h.bucket, "r1", FIVE);
    h.index.deferMutations = true;

    const first = await h.run();
    expect(first).toMatchObject({ ok: true, embedded: 5, pending: 0, modelCalls: 3, lastMutationId: "mutation-3", index: { vectorCount: 0, mutationsProcessed: null } });
    expect(h.index.vectors.size).toBe(0);
    expect(h.storage.vectorIds()).toHaveLength(5);
    expect(h.storage.values.get("last-mutation")).toEqual({ id: "mutation-3", acceptedAt: "2026-10-10T08:00:00.000Z" });

    // An hour later the index still has not applied them: nothing is embedded again.
    const second = await h.run();
    expect(second).toMatchObject({ ok: true, embedded: 5, modelCalls: 0, embeddedThisRun: 0, lastMutationId: "mutation-3", index: { vectorCount: 0, mutationsProcessed: false } });
    expect(h.model.calls).toHaveLength(3);
    const retriever = new VectorizeSemanticRetriever({ index: h.index, embed: h.model.embed, profile: PROFILE, release: createInMemoryReleaseView("r1", FIVE) });
    expect((await retriever.retrieve({ query: "Title of a1", limit: 10 })).candidates).toEqual([]);

    h.index.applyMutations();
    const third = await h.run();
    expect(third).toMatchObject({ ok: true, embedded: 5, modelCalls: 0, index: { vectorCount: 5, mutationsProcessed: true } });
    expect((await retriever.retrieve({ query: "Title of a1", limit: 10 })).candidates[0]).toMatchObject({ recordId: "a1", chunkId: FIVE[0]!.id });
    expectStateMatchesIndex(h);
  });

  test("H23: a failed run leaves the vectors of earlier runs answering queries for the release they match", async () => {
    const h = harness({ batchTexts: 2 });
    publishRelease(h.bucket, "r1", FIVE);
    await h.run();
    const next = FIVE.map((chunk) => (chunk.recordId === "a1" ? { ...chunk, text: "A rewritten body", id: "chunk:a1:new" } : chunk));
    publishRelease(h.bucket, "r2", next);
    h.model.respond = () => new Error("AiError: 5007: No such model");
    const failed = await h.run();

    // The one text, its retry, and the probe that finds the model down.
    expect(failed).toMatchObject({ ok: false, failureKind: "model", error: "AiError: 5007: No such model", limited: "model-down", embedded: 4, pending: 1, embeddedThisRun: 0, storedVectors: 5, modelCalls: 3 });
    expect(failed.modelErrors).toEqual(Array.from({ length: 3 }, () => ({ model: "@cf/baai/bge-m3", kind: "retry", name: "ModelCallError", message: "AiError: 5007: No such model", code: 5007 })));
    expect(h.model.calls.at(-1)).toEqual(["ok"]);
    expect(h.index.vectors.size).toBe(5);

    h.model.respond = () => undefined;
    const serving = (release: readonly SourceRecordChunkV1[]) => new VectorizeSemanticRetriever({ index: h.index, embed: h.model.embed, profile: PROFILE, release: createInMemoryReleaseView("r", release) });
    const found = async (release: readonly SourceRecordChunkV1[]) =>
      (await serving(release).retrieve({ query: "Title of a1 a2 a3 b1 b2 Text", limit: 10 })).candidates.map((candidate) => candidate.recordId).sort();
    // The new release: every unchanged passage; a1's stale vector is not offered.
    expect(await found(next)).toEqual(["a2", "a3", "b1", "b2"]);
    expect(await found(FIVE)).toEqual(["a1", "a2", "a3", "b1", "b2"]);
    const hybrid = await hybridSearch({ query: "Title of a2", lexical: [], semantic: serving(next) });
    expect(hybrid.retrieval).toMatchObject({ semantic: "ok" });
    expect(hybrid.results[0]!.groupRootRecordId).toBe("a2");
  });

  test("H53: an empty release deletes nothing and leaves the state as it is", async () => {
    const h = harness();
    publishRelease(h.bucket, "r1", FIVE);
    await h.run();
    publishRelease(h.bucket, "r2", []);
    h.index.calls.length = 0;
    h.model.calls.length = 0;
    const vectors = h.storage.vectorIds();
    const result = await h.run();
    expect(result).toMatchObject({
      ok: true, releaseId: "r2", chunks: 0, embedded: 0, deletedThisRun: 0, deletePending: 5, heldDeletes: 5, storedVectors: 5, modelCalls: 0,
      absentProjects: [{ projectId: "p-a", vectors: 3, releases: 1 }, { projectId: "p-b", vectors: 2, releases: 1 }],
    });
    expect(h.index.calls).toEqual(["describe"]);
    expect(h.storage.vectorIds()).toEqual(vectors);
    expect(h.index.vectors.size).toBe(5);
    // The release that follows holds the chunks again: nothing is embedded or deleted.
    publishRelease(h.bucket, "r3", FIVE);
    expect(await h.run()).toMatchObject({ ok: true, embedded: 5, modelCalls: 0, deletedThisRun: 0, heldDeletes: 0, absentProjects: [] });
    expect(h.model.calls).toEqual([]);
  });

  test("H53: a project missing from a release keeps its vectors until three releases in a row lack it", async () => {
    const h = harness();
    const onlyA = FIVE.slice(0, 2);
    publishRelease(h.bucket, "r1", FIVE);
    await h.run();
    h.model.calls.length = 0;

    // p-b is gone from r2; a3 is gone too, but its project is still there, so it is deleted as before.
    publishRelease(h.bucket, "r2", onlyA);
    expect(await h.run()).toMatchObject({ ok: true, deletedThisRun: 1, deletePending: 2, heldDeletes: 2, storedVectors: 4, absentProjects: [{ projectId: "p-b", vectors: 2, releases: 1 }] });
    // The same release again is not a second observation.
    expect(await h.run()).toMatchObject({ deletedThisRun: 0, heldDeletes: 2, absentProjects: [{ projectId: "p-b", vectors: 2, releases: 1 }] });
    // A dry run reports the hold and counts nothing.
    publishRelease(h.bucket, "r3", onlyA);
    h.storage.writes.length = 0;
    expect(await h.run({ dryRun: true })).toMatchObject({ deletedThisRun: 0, heldDeletes: 2, absentProjects: [{ projectId: "p-b", vectors: 2, releases: 2 }] });
    expect(h.storage.writes).toEqual([]);
    expect(h.storage.values.get("absent:p-b")).toEqual({ releases: 1, releaseId: "r2" });
    expect(await h.run()).toMatchObject({ deletedThisRun: 0, heldDeletes: 2, absentProjects: [{ projectId: "p-b", vectors: 2, releases: 2 }] });

    // It returns: no delete, no model call, and the count starts over.
    publishRelease(h.bucket, "r4", [...onlyA, ...FIVE.slice(3)]);
    expect(await h.run()).toMatchObject({ ok: true, embedded: 4, modelCalls: 0, deletedThisRun: 0, heldDeletes: 0, absentProjects: [] });
    expect(h.model.calls).toEqual([]);
    expect(h.index.vectors.size).toBe(4);

    const held: number[] = [];
    for (const release of ["r5", "r6", "r7"]) {
      publishRelease(h.bucket, release, onlyA);
      const result = await h.run();
      held.push(result.heldDeletes);
      if (release !== "r7") expect(result.deletedThisRun).toBe(0);
      else expect(result).toMatchObject({ ok: true, deletedThisRun: 2, deletePending: 0, storedVectors: 2, absentProjects: [] });
    }
    expect(held).toEqual([2, 2, 0]);
    expect([...h.index.vectors.values()].map((vector) => vector.namespace)).toEqual(["p-a", "p-a"]);
    expectStateMatchesIndex(h);
    // The count goes with the vectors, in the same run.
    expect([...h.storage.values.keys()].filter((key) => key.startsWith("absent:"))).toEqual([]);
  });

  test("H54: a text that fails alone in three runs in a row is quarantined for a day; its neighbour is embedded at once", async () => {
    const h = harness({ batchTexts: 2 });
    publishRelease(h.bucket, "r1", FIVE);
    h.model.respond = (_call, texts) => (texts.some((text) => text.includes("a3")) ? new Error("AiError: 3010: Invalid input") : undefined);
    const [, , a3] = await ids(FIVE);

    const runs: string[] = [];
    for (let hour = 0; hour < 5; hour += 1) {
      h.clock.now = DAY_1 + hour * 3_600_000;
      const result = await h.run();
      runs.push(`${result.modelCalls} calls, ${result.embedded}/5, quarantined ${result.quarantined}, ${result.ok ? "ok" : result.failureKind}`);
      if (hour === 3) expect(result.quarantinedIds).toEqual([a3!]);
    }
    // The first run isolates a3 (batch, a3, b1); the next two try it alone, twice each; then it costs nothing.
    expect(runs).toEqual([
      "5 calls, 4/5, quarantined 0, model",
      "2 calls, 4/5, quarantined 0, model",
      "2 calls, 4/5, quarantined 0, model",
      "0 calls, 4/5, quarantined 1, ok",
      "0 calls, 4/5, quarantined 1, ok",
    ]);
    expect(h.model.calls.slice(0, 5).map((texts) => texts.map((text) => text.slice(-2)).join(" "))).toEqual(["a1 a2", "a3 b1", "a3", "b1", "b2"]);
    expect([...h.storage.values].filter(([key]) => key.startsWith("f:"))).toEqual([[`f:${a3}`, { h: expect.any(String), r: PROFILE.semanticRevision, n: 3, at: "2026-10-10T10:00:00.000Z" }]]);
    expect(await h.run({ dryRun: true })).toMatchObject({ quarantined: 1, pending: 1, estimate: { chunks: 0, calls: 0 } });

    // A day after the last failure it is tried once more; a success ends the quarantine.
    h.clock.now = DAY_1 + 2 * 3_600_000 + DAY_MS - 1;
    expect(await h.run()).toMatchObject({ modelCalls: 0, quarantined: 1 });
    h.clock.now += 1;
    expect(await h.run()).toMatchObject({ ok: false, modelCalls: 2, quarantined: 0, embedded: 4 });
    h.clock.now += 3_600_000;
    expect(await h.run()).toMatchObject({ ok: true, modelCalls: 0, quarantined: 1 });
    h.model.respond = () => undefined;
    h.clock.now += DAY_MS;
    expect(await h.run()).toMatchObject({ ok: true, modelCalls: 1, quarantined: 0, embedded: 5, pending: 0 });
    expect([...h.storage.values.keys()].filter((key) => key.startsWith("f:"))).toEqual([]);
  });

  const failing = (h: Harness) => [...h.storage.values].filter(([key]) => key.startsWith("f:")).map(([key, value]) => `${key.slice(2)}:${(value as { n: number }).n}`).sort();
  const fifty = Array.from({ length: 50 }, (_, n) => projectA(`fifty:${String(n).padStart(2, "0")}`));
  const poisoned = (...records: string[]) => (_call: number, texts: readonly string[]) =>
    (texts.some((text) => records.some((record) => text.endsWith(record))) ? new Error("AiError: 3010: Invalid input") : undefined);

  test("H55: one failing text in a batch of 50 is isolated in at most 13 calls, and the other 49 are embedded in that run", async () => {
    const h = harness();
    publishRelease(h.bucket, "r1", fifty);
    h.model.respond = poisoned("fifty:37");
    const [poison] = await ids([fifty[37]!]);
    const result = await h.run();
    expect(result).toMatchObject({ ok: false, failureKind: "model", limited: null, chunks: 50, embedded: 49, pending: 1, embeddedThisRun: 49, storedVectors: 49 });
    // 1 for the batch, then 2 per level: 25, 13, 7, 4, 2, 1 texts.
    expect(result.modelCalls).toBe(13);
    expect(h.model.calls.map((texts) => texts.length)).toEqual([50, 25, 25, 12, 13, 6, 7, 3, 4, 2, 2, 1, 1]);
    expect(failing(h)).toEqual([`${poison}:1`]);
    expect(h.index.vectors.has(poison!)).toBe(false);
    expectStateMatchesIndex(h);
    expect(result.spentToday.calls).toBe(13);
    // The next run tries the one text alone, twice, and touches nothing else.
    h.model.calls.length = 0;
    expect(await h.run()).toMatchObject({ modelCalls: 2, embedded: 49, embeddedThisRun: 0 });
    expect(h.model.calls.map((texts) => texts.length)).toEqual([1, 1]);
    expect(failing(h)).toEqual([`${poison}:2`]);
  });

  test("H55: two failing texts in one batch are both isolated, with a probe when nothing has succeeded yet", async () => {
    const h = harness();
    publishRelease(h.bucket, "r1", fifty);
    h.model.respond = poisoned("fifty:03", "fifty:44");
    const culprits = (await ids([fifty[3]!, fifty[44]!])).map((id) => `${id}:1`).sort();
    const result = await h.run();
    expect(result).toMatchObject({ ok: false, failureKind: "model", limited: null, embedded: 48, pending: 2 });
    expect(failing(h)).toEqual(culprits);
    // The batch, both halves, the probe that shows the model is up, then each half's own search.
    expect(h.model.calls.slice(0, 4).map((texts) => texts.length)).toEqual([50, 25, 25, 1]);
    expect(h.model.calls[3]).toEqual(["ok"]);
    expect(result.modelCalls).toBeLessThanOrEqual(1 + 24 + 1);
    expectStateMatchesIndex(h);
  });

  test("H55: a bound reached while a batch is being split leaves what was stored, strikes nothing unproven, and the next runs finish", async () => {
    const h = harness({ maxCallsPerRun: 5 });
    publishRelease(h.bucket, "r1", fifty);
    h.model.respond = poisoned("fifty:37");
    const [poison] = await ids([fifty[37]!]);
    const first = await h.run();
    // 50 fails, 25 stored, 25 fails, 12 stored, 13 fails: then the bound.
    expect(first).toMatchObject({ ok: true, limited: "calls-per-run", modelCalls: 5, embedded: 37, pending: 13 });
    expect(failing(h)).toEqual([]);
    expectStateMatchesIndex(h);
    const second = await h.run();
    expect(second).toMatchObject({ limited: "calls-per-run", modelCalls: 5 });
    expectStateMatchesIndex(h);
    let last = second;
    for (let run = 0; run < 3 && last.pending > 1; run += 1) last = await h.run();
    expect(last).toMatchObject({ embedded: 49, pending: 1 });
    expect(failing(h).map((entry) => entry.split(":")[0])).toEqual([poison!]);
    expect(h.storage.values.get("spend:2026-10-10")).toMatchObject({ calls: h.model.calls.length });
  });

  test("H55: when the model is down a run costs four calls, strikes nothing, and embeds everything once it is back", async () => {
    const h = harness();
    const corpus = [...fifty, ...Array.from({ length: 70 }, (_, n) => projectB(`more:${n}`))];
    publishRelease(h.bucket, "r1", corpus);
    h.model.respond = () => new Error("AiError: 3040: Capacity temporarily exceeded");
    for (let hour = 0; hour < 4; hour += 1) {
      h.clock.now = DAY_1 + hour * 3_600_000;
      const result = await h.run();
      expect(result).toMatchObject({ ok: false, failureKind: "model", limited: "model-down", modelCalls: 4, embedded: 0, pending: 120, quarantined: 0 });
    }
    expect(h.model.calls.slice(0, 4).map((texts) => texts.length)).toEqual([50, 25, 25, 1]);
    expect(h.model.calls).toHaveLength(16);
    expect(failing(h)).toEqual([]);
    expect(h.storage.values.get("spend:2026-10-10")).toMatchObject({ calls: 16 });
    h.model.respond = () => undefined;
    expect(await h.run()).toMatchObject({ ok: true, embedded: 120, pending: 0, modelCalls: 3, quarantined: 0 });

    // One text alone: the text, its retry, the probe. A refusal or a store failure never splits a batch.
    const single = harness();
    publishRelease(single.bucket, "r1", [projectA("only")]);
    single.model.respond = () => new Error("AiError: 3040: Capacity temporarily exceeded");
    expect(await single.run()).toMatchObject({ limited: "model-down", modelCalls: 3 });
    expect(failing(single)).toEqual([]);
    for (const refusal of ["429 Too Many Requests", "AiError: 3036: daily allocation", "AI Gateway spend limit exceeded"]) {
      const refused = harness();
      publishRelease(refused.bucket, "r1", fifty);
      refused.model.respond = () => new Error(refusal);
      expect(await refused.run()).toMatchObject({ limited: "model-limit", modelCalls: 1, embedded: 0 });
    }
    const store = harness();
    publishRelease(store.bucket, "r1", fifty);
    store.index.fail = (operation) => (operation === "upsert" ? new Error("VECTOR_UPSERT_ERROR") : undefined);
    expect(await store.run()).toMatchObject({ limited: "vector-store", modelCalls: 1, embedded: 0 });
    expect(failing(store)).toEqual([]);
  });

  test("H47: a run that dies while a batch is being split is continued without embedding the stored halves again", async () => {
    const h = harness({ batchTexts: 4, callTimeoutMs: 2 ** 30 });
    publishRelease(h.bucket, "r1", FIVE);
    // a2 fails; the run dies on its fourth call ([a2] alone), after [a3 b1]... were not reached.
    h.model.respond = (call, texts) => (call === 3 ? new Promise<never>(() => undefined) : poisoned("a2")(call, texts));
    void h.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.model.calls.map((texts) => texts.map((text) => text.slice(-2)).join(" "))).toEqual(["a1 a2 a3 b1", "a1 a2", "a3 b1", "a2"]);
    expect(h.storage.vectorIds()).toHaveLength(2);
    expect(h.storage.values.get("spend:2026-10-10")).toEqual({ neurons: 4, calls: 4 });

    h.model.respond = poisoned("a2");
    const before = h.model.calls.length;
    const retry = await h.run();
    expect(retry).toMatchObject({ ok: false, failureKind: "model", embedded: 4, pending: 1 });
    const again = h.model.calls.slice(before).map((texts) => texts.map((text) => text.slice(-2)).join(" "));
    // a3 and b1 are stored and are not sent again.
    expect(again.join("|")).not.toMatch(/a3|b1/u);
    expect(retry.spentToday.calls).toBe(h.model.calls.length);
    expect(failing(h)).toHaveLength(1);
    expectStateMatchesIndex(h);
  });

  test("H54: a refusal, a store failure, or a changed chunk does not count toward quarantine; a new revision and a reset clear it", async () => {
    const strikes = (h: Harness) => [...h.storage.values].filter(([key]) => key.startsWith("f:")).map(([, value]) => (value as { n: number }).n);
    const refused = harness({ batchTexts: 2 });
    publishRelease(refused.bucket, "r1", FIVE);
    for (const error of ["429 Too Many Requests", "AiError: 3036: daily allocation", "AI Gateway spend limit exceeded", "AiError: 3040: model down"]) {
      refused.model.respond = () => new Error(error);
      await refused.run();
    }
    refused.model.respond = () => undefined;
    refused.index.fail = (operation) => (operation === "upsert" ? new Error("VECTOR_UPSERT_ERROR") : undefined);
    await refused.run();
    expect(strikes(refused)).toEqual([]);

    const quarantine = async () => {
      const h = harness({ batchTexts: 2 });
      publishRelease(h.bucket, "r1", FIVE);
      h.model.respond = (_call, texts) => (texts.some((text) => text.includes("a3")) ? new Error("AiError: 3010: Invalid input") : undefined);
      for (let run = 0; run < 3; run += 1) await h.run();
      expect(await h.run()).toMatchObject({ modelCalls: 0, quarantined: 1, embedded: 4 });
      expect(strikes(h)).toEqual([3]);
      return h;
    };
    // The text of a3 changes: it is a new passage and is tried at once.
    const changed = await quarantine();
    changed.model.respond = () => undefined;
    publishRelease(changed.bucket, "r2", FIVE.map((chunk) => (chunk.recordId === "a3" ? { ...chunk, text: "Rewritten a3" } : chunk)));
    expect(await changed.run()).toMatchObject({ ok: true, modelCalls: 1, quarantined: 0, embedded: 5 });
    // Another revision embeds everything again.
    const revised = await quarantine();
    revised.model.respond = () => undefined;
    expect(await revised.run({ profile: searchEmbeddingProfile("test@2", { ...PROFILE.revision, modelRevision: "2" }) })).toMatchObject({ ok: true, embedded: 5, quarantined: 0 });
    // A reset forgets the strikes with the vectors.
    const reset = await quarantine();
    await new EmbeddingState(reset.storage).clear();
    expect(strikes(reset)).toEqual([]);
    reset.model.respond = () => undefined;
    expect(await reset.run()).toMatchObject({ ok: true, embedded: 5, quarantined: 0, modelCalls: 1 });
  });

  test("H54: no error text leaves the run with a bearer token or a token-like string in it", async () => {
    const bearer = `Bearer ${"t0k".repeat(14)}`;
    const base64 = `${"QUJD+/9h".repeat(5)}==`;
    const leaked = (text: string) => text.includes("t0kt0k") || text.includes("QUJD+/9h");
    expect(sanitizeErrorMessage(`401 ${bearer} and ${base64}; id ${"ab12".repeat(10)} end`)).toBe("401 Bearer [redacted] and [redacted]; id [redacted] end");
    expect(sanitizeErrorMessage(`short Bearer abc.def-1 ${"word ".repeat(80)}`)).toBe(`short Bearer [redacted] ${"word ".repeat(80)}`.slice(0, 200));
    // Redaction comes before the cut: a token that straddles the 200th character does not survive in part.
    expect(leaked(sanitizeErrorMessage(`${"x ".repeat(90)}${bearer}`))).toBe(false);
    expect(sanitizeErrorMessage("AiError: 3040: Capacity temporarily exceeded")).toBe("AiError: 3040: Capacity temporarily exceeded");

    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
    try {
      // A model error.
      const model = harness({ batchTexts: 2 });
      publishRelease(model.bucket, "r1", FIVE);
      model.model.respond = () => new Error(`AiError: 5007: upstream ${bearer} ${base64}`);
      const failed = await model.run();
      expect(failed.ok).toBe(false);
      expect(failed.error).toBe("AiError: 5007: upstream Bearer [redacted] [redacted]");
      expect(failed.modelErrors.length).toBeGreaterThan(0);
      // A store error, an index that does not answer, and an unreadable release (dry run included).
      const store = harness();
      publishRelease(store.bucket, "r1", FIVE);
      store.index.fail = (operation) => (operation === "upsert" ? new Error(`VECTOR_UPSERT_ERROR ${bearer}`) : undefined);
      const index = harness();
      publishRelease(index.bucket, "r1", FIVE);
      index.index.fail = () => new Error(`unauthorized ${base64}`);
      const release = harness();
      const [shard] = publishRelease(release.bucket, "r1", FIVE);
      release.bucket.fail = (key) => (key === shard ? new Error(`R2 said ${bearer}`) : undefined);
      const results = [failed, await store.run(), await index.run(), await release.run(), await release.run({ dryRun: true })];
      expect(results.map((result) => result.ok)).toEqual([false, false, false, false, false]);
      // The object key is ours and stays readable.
      expect(results[3]!.error).toBe(`Reading ${shard} failed: R2 said Bearer [redacted]`);
      for (const result of results) expect(leaked(JSON.stringify(result))).toBe(false);
      for (const h of [model, store, index, release]) expect(leaked(JSON.stringify([...h.storage.values]))).toBe(false);
      expect(JSON.stringify(results)).toContain("[redacted]");
    } finally {
      console.error = realError;
    }
    expect(logged.some(leaked)).toBe(false);
  });

  test("H51: a dry run reports what a run would do and cost, calling no model, mutating no vector, and writing no state", async () => {
    const h = harness({ batchTexts: 2, maxChunksPerRun: 3 });
    publishRelease(h.bucket, "r0", [...FIVE.slice(0, 2), projectA("gone")]);
    await h.run({ limits: DEFAULT_EMBEDDING_LIMITS });
    publishRelease(h.bucket, "r1", FIVE);
    h.model.calls.length = 0;
    h.index.calls.length = 0;
    h.storage.writes.length = 0;
    const stored = new Map(h.storage.values);

    const dry = await h.run({ dryRun: true });
    expect(dry).toMatchObject({
      ok: true, dryRun: true, releaseId: "r1", chunks: 5, embedded: 2, pending: 3, embeddedThisRun: 0, deletedThisRun: 0, deletePending: 1,
      storedVectors: 3, modelCalls: 0, estimatedNeurons: 0, limited: null, index: null,
      estimate: { chunks: 3, calls: 2, inputTokens: 18, neurons: 2, usd: 0.000022, runs: 1, days: 1 },
    });
    expect(h.model.calls).toEqual([]);
    expect(h.index.calls).toEqual([]);
    expect(h.storage.writes).toEqual([]);
    expect(h.storage.values).toEqual(stored);

    // The run it describes: three chunks in two calls, one delete.
    const real = await h.run();
    expect(real).toMatchObject({ embeddedThisRun: 3, modelCalls: 2, estimatedInputTokens: 18, estimatedNeurons: 2, deletedThisRun: 1, estimate: { chunks: 0, calls: 0, inputTokens: 0, neurons: 0, usd: 0, runs: 0, days: 0 } });
  });
});
